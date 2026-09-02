/**
 * SlidesDeliverable — the host that connects the native slide editor to Convex.
 *
 * Kept separate from `DeliverablePanel` so the panel's slides branch stays a
 * one-liner, and separate from `SlidesEditorNative` so the editor itself stays
 * a pure controlled component (deck in, ops out) that a test or a teacher
 * read-only view can mount without any backend.
 *
 * The deck is the session's `type: "slides"` artifact. Convex is authoritative:
 * the editor emits id-addressed ops, we send them, and the updated deck arrives
 * back through the same reactive `artifacts.getBySession` subscription the rest
 * of the panel already uses. We deliberately do NOT apply ops locally — the
 * server mints element ids, so a local apply would fork ids.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";

import * as ImagePicker from "expo-image-picker";
import * as Device from "expo-device";
import * as WebBrowser from "expo-web-browser";
import { SymbolView } from "expo-symbols";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, type Id } from "@/lib/convex";
import { uploadImageUri } from "@/lib/uploadImage";
import { scratchpadBus } from "@/lib/scratchpadBus";
import { useScratchpadInset } from "@/lib/scratchpadLayout";
import { GlobalScratchpad } from "@/components/GlobalScratchpad";
import {
  SLIDES_COPY,
  validateDeckLenient,
  type Deck,
  type SlideOp,
} from "../../../vendor/shared/slidesScene";
import { uploadAndRegisterSlideAsset } from "../../../vendor/shared/slidesMediaUpload";
import { fonts, useColors } from "@/theme";
import {
  MAKE_PICTURE_COPY,
  resolveGenerateResult,
  placeholderFrameForSlot,
  resolvedImageFrame,
} from "./makePicture";
import {
  FIND_IMAGE_COPY,
  deriveFoundImageAlt,
  type WebImageSearchResponse,
  type WebImageSearchResult,
} from "./findImage";
import { MakePictureDialog } from "./MakePictureDialog";
import {
  FindImageSheet,
  EMPTY_IMAGE_SEARCH_SNAPSHOT,
  type ImageSearchSnapshot,
} from "./FindImageSheet";
import {
  SlidesEditorNative,
  type SlidesEditorNativeHandle,
} from "./SlidesEditorNative";
import { SlidesPresentationNative } from "./SlidesPresentationNative";
import {
  SlidesViewToggleNative,
  type SlidesViewMode,
} from "./SlidesViewToggleNative";

export function SlidesDeliverable({
  sessionId,
  readOnly = false,
}: {
  sessionId: Id<"sessions">;
  readOnly?: boolean;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const scratchpadInset = useScratchpadInset();
  const artifacts = useQuery(api.artifacts.getBySession, { sessionId });
  // The deck's artifact id, readable from async work that outlives a render —
  // a picture that finishes after the editor closed still needs somewhere to go.
  const artifactRef = useRef<Id<"artifacts"> | null>(null);
  const ensureDeck = useMutation(api.artifacts.scholarEnsureSlidesDeck);
  const applyOps = useMutation(api.artifacts.scholarApplySlideOps);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const registerAsset = useMutation(api.artifacts.registerSlideAsset);
  const generateSlideImage = useAction(api.artifacts.scholarGenerateSlideImage);
  const searchWebImages = useAction(api.slidesImageSearch.searchWebImages);
  const pickWebImage = useAction(api.slidesImageSearch.pickWebImage);
  const exportDeck = useAction(api.slidesExport.exportDeck);
  const convex = useConvex();
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [slideIndex, setSlideIndex] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [editorView, setEditorView] = useState<SlidesViewMode>("slide");
  const ensuring = useRef(false);
  const exportInFlight = useRef(false);
  const editorRef = useRef<SlidesEditorNativeHandle>(null);

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  const setEditorVisible = useCallback((visible: boolean) => {
    setEditorOpen(visible);
  }, []);

  // Bridge for the "Make a picture" flow: the Media ActionSheet opens the prompt
  // dialog; submitting drops a spinner placeholder on the canvas and runs the
  // (slow) generation in the background, so the scholar is never blocked.
  const [makePictureOpen, setMakePictureOpen] = useState(false);
  const [makePictureDialogKey, setMakePictureDialogKey] = useState(0);
  // Bridge for the "Find an image" flow: the Media ActionSheet opens the search
  // sheet; tapping a result drops a spinner placeholder on the canvas and
  // re-hosts the picked image in the background — the SAME optimistic cascade
  // "Make an image" uses, so both sources converge on one insert path.
  const [findImageOpen, setFindImageOpen] = useState(false);
  // Persist the last search across open/close — a scholar commonly reopens to
  // change their mind about which picture to use, and re-typing + re-searching
  // (and re-spending a Brave query) to see the same grid is a poor experience.
  const [imageSearchSnapshot, setImageSearchSnapshot] =
    useState<ImageSearchSnapshot>(EMPTY_IMAGE_SEARCH_SNAPSHOT);

  const uploadSlideImageUri = useCallback(
    (uri: string, mime: string) =>
      uploadAndRegisterSlideAsset({
        generateUploadUrl,
        upload: (uploadUrl) => uploadImageUri(uploadUrl, uri, mime),
        registerAsset: (storageId) => registerAsset({ storageId }),
      }),
    [generateUploadUrl, registerAsset],
  );

  const onAddSketch = useCallback(
    () =>
      new Promise<{
        type: "image";
        assetId: string;
        alt: string;
      } | null>((resolve) => {
        const target = {
          primaryLabel: "Insert sketch",
          onCapture: async (uri: string, mime: string) => {
            try {
              const assetId = await uploadSlideImageUri(uri, mime);
              resolve({ type: "image", assetId, alt: "Sketch" });
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
              // Keep this target live so Retry still inserts; closing the pad
              // invokes onCancel and settles the pending action with null.
              throw error;
            }
          },
          onCancel: () => resolve(null),
        };
        scratchpadBus.setTarget(target);
        scratchpadBus.clearSheet();
        scratchpadBus.open();
      }),
    [uploadSlideImageUri],
  );

  const onMakePictureSubmit = useCallback(
    (prompt: string) => {
      setMakePictureOpen(false);
      const editor = editorRef.current;
      if (!editor) {
        setError(MAKE_PICTURE_COPY.errorFallback);
        return;
      }
      // Optimistic + concurrent: the placeholder appears now and owns its own
      // target frame; several generations can be in flight at once.
      // Captured NOW: if the editor unmounts mid-generation we still know which
      // slide the picture was meant for.
      const targetSlideId = editor.currentSlideId?.() ?? null;
      const targetArtifactId = artifactRef.current;
      if (!targetArtifactId) {
        setError(MAKE_PICTURE_COPY.errorFallback);
        return;
      }
      const placeholderId = editor.startImagePlaceholder(prompt);
      // Capture the slot too: if the editor unmounts, the fallback below must
      // land this picture where its placeholder was, not stack every pending
      // one at slot 0.
      const targetSlot = editor.slotForPlaceholder?.(placeholderId) ?? 0;
      void (async () => {
        try {
          const outcome = resolveGenerateResult(
            await generateSlideImage({ artifactId: targetArtifactId, prompt }),
            prompt,
          );
          // Read the handle fresh — generation is slow and the editor may have
          // re-rendered (a newer deck revision) while it ran.
          if (outcome.status === "success") {
            const editorNow = editorRef.current;
            if (editorNow) {
              editorNow.resolveImagePlaceholder(placeholderId, {
                assetId: outcome.assetId,
                alt: outcome.alt,
                width: outcome.width,
                height: outcome.height,
              });
            } else if (artifactRef.current && targetSlideId) {
              // The kid closed the editor while this was generating. The image
              // is already paid for, stored and registered, so write it to the
              // deck from here rather than stranding it — the host outlives the
              // editor modal. Placement falls back to the preset box because
              // the placeholder's slot died with the editor.
              void applyOps({
                artifactId: artifactRef.current,
                ops: JSON.stringify([
                  {
                    op: "addElement",
                    slideId: targetSlideId,
                    element: {
                      type: "image",
                      assetId: outcome.assetId,
                      alt: outcome.alt,
                      frame: resolvedImageFrame(
                        placeholderFrameForSlot(targetSlot),
                        outcome.width,
                        outcome.height,
                      ),
                    },
                  },
                ]),
              }).catch(() => setError(MAKE_PICTURE_COPY.errorFallback));
            }
          } else {
            editorRef.current?.failImagePlaceholder(placeholderId);
            setError(outcome.message);
          }
        } catch (e) {
          editorRef.current?.failImagePlaceholder(placeholderId);
          setError(
            e instanceof Error
              ? e.message
              : MAKE_PICTURE_COPY.errorFallback,
          );
        }
      })();
    },
    // `applyOps` is the fallback write when the editor unmounted mid-generation.
    [generateSlideImage, applyOps],
  );

  // Search runs from the sheet but the deck's artifact id is owned here (and
  // readable from async work that outlives a render), so the host wraps the
  // action and the sheet stays free of any backend.
  const onFindImageSearch = useCallback(
    async (query: string): Promise<WebImageSearchResponse> => {
      const targetArtifactId = artifactRef.current;
      if (!targetArtifactId) return { status: "unavailable" };
      try {
        return await searchWebImages({ artifactId: targetArtifactId, query });
      } catch (e) {
        return {
          status: "error",
          error: e instanceof Error ? e.message : FIND_IMAGE_COPY.errorFallback,
        };
      }
    },
    [searchWebImages],
  );

  // Tapping a result converges on the EXACT path a generated image takes: an
  // optimistic placeholder now, the (slow) server-side re-host in the
  // background, then the real image element on the placeholder's own frame with
  // query-derived alt. Concurrent picks cascade, not stack.
  const onFindImagePick = useCallback(
    (image: WebImageSearchResult, query: string) => {
      setFindImageOpen(false);
      const editor = editorRef.current;
      if (!editor) {
        setError(FIND_IMAGE_COPY.insertErrorFallback);
        return;
      }
      const targetSlideId = editor.currentSlideId?.() ?? null;
      const targetArtifactId = artifactRef.current;
      if (!targetArtifactId) {
        setError(FIND_IMAGE_COPY.insertErrorFallback);
        return;
      }
      // Alt is the scholar's query, not the source page title — the same honesty
      // rule generation uses. Captured now, before any await.
      const alt = deriveFoundImageAlt(query);
      const placeholderId = editor.startImagePlaceholder(query, "find");
      const targetSlot = editor.slotForPlaceholder?.(placeholderId) ?? 0;
      void (async () => {
        try {
          const result = await pickWebImage({
            artifactId: targetArtifactId,
            query,
            image,
          });
          if (result.status === "inserted") {
            const editorNow = editorRef.current;
            if (editorNow) {
              editorNow.resolveImagePlaceholder(placeholderId, {
                assetId: result.storageId,
                alt,
                width: result.width,
                height: result.height,
              });
            } else if (artifactRef.current && targetSlideId) {
              // The kid closed the editor while the re-host ran. The asset is
              // stored and registered, so write it from here rather than
              // stranding it — the host outlives the editor modal. Placement
              // falls back to the preset box because the placeholder's slot died
              // with the editor.
              void applyOps({
                artifactId: artifactRef.current,
                ops: JSON.stringify([
                  {
                    op: "addElement",
                    slideId: targetSlideId,
                    element: {
                      type: "image",
                      assetId: result.storageId,
                      alt,
                      frame: resolvedImageFrame(
                        placeholderFrameForSlot(targetSlot),
                        result.width,
                        result.height,
                      ),
                    },
                  },
                ]),
              }).catch(() => setError(FIND_IMAGE_COPY.insertErrorFallback));
            }
          } else {
            editorRef.current?.failImagePlaceholder(placeholderId);
            setError(result.error.trim() || FIND_IMAGE_COPY.insertErrorFallback);
          }
        } catch (e) {
          editorRef.current?.failImagePlaceholder(placeholderId);
          setError(
            e instanceof Error ? e.message : FIND_IMAGE_COPY.insertErrorFallback,
          );
        }
      })();
    },
    [pickWebImage, applyOps],
  );

  const artifact = useMemo(
    () => artifacts?.find((a) => a.type === "slides") ?? null,
    [artifacts],
  );

  /**
   * A slides deliverable with no deck yet must land the kid IN an editor, not
   * on an empty state — that stub is exactly what this feature replaces. Guard
   * with a ref so a re-render mid-flight cannot create two decks.
   */
  useEffect(() => {
    if (readOnly || artifacts === undefined || artifact || ensuring.current) return;
    ensuring.current = true;
    ensureDeck({ sessionId })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        ensuring.current = false;
      });
  }, [artifacts, artifact, ensureDeck, sessionId, readOnly]);

  const deck: Deck | null = useMemo(() => {
    if (!artifact) return null;
    try {
      // Lenient on READ (same rule as web): a mostly-good deck beats an error
      // page for a kid. Writes use the strict validator server-side.
      return validateDeckLenient(JSON.parse(artifact.content));
    } catch {
      return null;
    }
  }, [artifact]);

  useEffect(() => {
    artifactRef.current = artifact?._id ?? null;
  }, [artifact]);

  /**
   * Every media id the deck references, so the URLs resolve in ONE query.
   * React hooks cannot be called in a loop, so a per-image `files.getUrl` is not
   * expressible in the renderer.
   */
  const assetIds = useMemo(() => {
    if (!deck) return [];
    const ids = new Set<string>();
    for (const slide of deck.slides) {
      for (const eid of slide.elementIds) {
        const el = slide.elements[eid];
        if (el?.type === "image" || el?.type === "video") ids.add(el.assetId);
      }
    }
    return Array.from(ids) as Id<"_storage">[];
  }, [deck]);

  const assetUrls = useQuery(
    api.files.getUrls,
    assetIds.length > 0 ? { storageIds: assetIds } : "skip",
  );

  // Deleting (or adding) an image changes `assetIds`, which changes this query's
  // args — and Convex useQuery returns `undefined` while the new args load. Left
  // raw, that momentarily blanks the URL for EVERY surviving image, so they all
  // drop to the fallback and reload with a transition: the "delete one image →
  // all the others flicker" bug. A Convex storage URL for a given id is stable,
  // so cache resolved URLs and fall back to the cache during a refetch; a
  // surviving image keeps its URL and never flickers.
  const assetUrlCache = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!assetUrls) return;
    for (const a of assetUrls) {
      if (a.url) assetUrlCache.current.set(a.storageId, a.url);
    }
  }, [assetUrls]);

  const resolveAsset = useCallback(
    (assetId: string) =>
      assetUrls?.find((a) => a.storageId === assetId)?.url ??
      assetUrlCache.current.get(assetId) ??
      null,
    [assetUrls],
  );

  /**
   * Capture or pick media and upload it, resolving to a storage id the caller
   * turns into a scene element. Bytes go up through `uploadImageUri` —
   * the `fetch(uri).blob()` path silently produces an empty body for `file://`
   * URIs in React Native (see its header).
   */
  const onAddMedia = useCallback(async (): Promise<{
    type: "image" | "video";
    assetId: string;
    alt?: string;
  } | null> => {
    const source = await new Promise<
      "photo" | "video" | "library" | "generate" | "find" | null
    >((resolve) => {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: "Add media",
          options: [
            "Take photo",
            "Record video",
            "Choose from library",
            MAKE_PICTURE_COPY.action,
            FIND_IMAGE_COPY.action,
            "Cancel",
          ],
          cancelButtonIndex: 5,
        },
        (buttonIndex) => {
          resolve(
            buttonIndex === 0
              ? "photo"
              : buttonIndex === 1
                ? "video"
                : buttonIndex === 2
                  ? "library"
                  : buttonIndex === 3
                    ? "generate"
                    : buttonIndex === 4
                      ? "find"
                      : null,
          );
        },
      );
    });
    if (!source) return null;

    // Generate an illustration: no camera/library permission, no upload — the
    // backend stores the bytes and hands back the same storage-id shape a picked
    // photo does, so this lands on the EXACT same element path.
    if (source === "generate") {
      // Open the prompt dialog; submitting hands off to the optimistic
      // placeholder flow (onMakePictureSubmit). Nothing is inserted through this
      // media path, so it resolves to null immediately and never blocks.
      setMakePictureDialogKey((current) => current + 1);
      setMakePictureOpen(true);
      return null;
    }

    // Find an image on the web: same non-blocking hand-off. The sheet owns the
    // search half; tapping a result runs the pick through onFindImagePick, which
    // reuses the generation flow's placeholder cascade. Reopening restores the
    // last query + grid from imageSearchSnapshot.
    if (source === "find") {
      setFindImageOpen(true);
      return null;
    }

    // The iOS Simulator has no camera, so UIImagePickerController's camera
    // source is unavailable and `launchCameraAsync` throws a native NSException
    // (SIGABRT) that no JS try/catch can catch — it hard-crashes the app. Guard
    // it here: `Device.isDevice` is false only on the simulator, so a real iPad
    // (always has a camera) is unaffected while dev/QA gets a graceful message
    // pointing at the paths that DO work on a sim.
    if ((source === "photo" || source === "video") && !Device.isDevice) {
      setError(
        "The camera isn't available on the simulator — try Choose from library, or Make an image.",
      );
      return null;
    }

    const perm =
      source === "library"
        ? await ImagePicker.requestMediaLibraryPermissionsAsync()
        : await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setError(
        source === "library"
          ? "Rabbithole needs permission to open your photos and videos."
          : "Rabbithole needs camera permission to capture media.",
      );
      return null;
    }

    const picked =
      source === "library"
        ? await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images", "videos"],
            quality: 0.9,
            videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
          })
        : await ImagePicker.launchCameraAsync({
            mediaTypes: [source === "video" ? "videos" : "images"],
            quality: 0.9,
            videoMaxDuration: 60,
            videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
          });
    if (picked.canceled || !picked.assets?.[0]) return null;
    const asset = picked.assets[0];
    const type =
      asset.type === "video" || asset.mimeType?.startsWith("video/")
        ? "video"
        : "image";
    try {
      const storageId = await uploadSlideImageUri(
        asset.uri,
        asset.mimeType ?? (type === "video" ? "video/quicktime" : "image/jpeg"),
      );
      return { type, assetId: storageId };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [uploadSlideImageUri]);

  /**
   * Export and hand the file to iOS. `openBrowserAsync` gives the system share
   * sheet and Open-in behaviour for a .pptx/.pdf, which is what "hand this to my
   * teacher" means on an iPad — `window.open` has no native equivalent.
   */
  const exportAfterPendingEdits = useCallback(
    async (format: "pptx" | "pdf") => {
      if (!artifact || exportInFlight.current) return;
      // State alone cannot guard two taps in the same render. Claim before
      // persisting edits, so only one export can cross that barrier.
      exportInFlight.current = true;
      setExporting(true);
      try {
        const saved = (await editorRef.current?.commitPendingEdit()) ?? true;
        if (saved) {
          const storageId = await exportDeck({ artifactId: artifact._id, format });
          const url = await convex.query(api.files.getUrl, { storageId });
          if (!url) throw new Error("The exported file could not be opened.");
          await WebBrowser.openBrowserAsync(url);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      exportInFlight.current = false;
      setExporting(false);
    },
    [exportDeck, convex, artifact],
  );

  const showShareMenu = useCallback(() => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: "Share slides",
        options: ["PowerPoint", "PDF", "Cancel"],
        cancelButtonIndex: 2,
      },
      (buttonIndex) => {
        if (buttonIndex !== 0 && buttonIndex !== 1) return;
        void exportAfterPendingEdits(buttonIndex === 0 ? "pptx" : "pdf");
      },
    );
  }, [exportAfterPendingEdits]);

  const onOps = useCallback(
    async (ops: SlideOp[]) => {
      if (!artifact || !deck) return false;
      // NO baseRevision — see the web twin for the full reasoning. A scholar's
      // ops are absolute and id-addressed, describing a gesture just performed,
      // so they are never semantically stale. Sending it silently threw away the
      // kid's drag, because the mutation RETURNS { conflict: true } rather than
      // throwing and nothing was reading the result.
      try {
        const res = await applyOps({ artifactId: artifact._id, ops: JSON.stringify(ops) });
        if (res?.conflict) {
          setError("That change didn't save — try again.");
          return false;
        }
        return true;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [applyOps, artifact, deck],
  );

  const closeEditor = useCallback(async () => {
    const saved = (await editorRef.current?.commitPendingEdit()) ?? true;
    if (!saved) return;
    scratchpadBus.close();
    setEditorVisible(false);
  }, [setEditorVisible]);

  const presentDeck = useCallback(() => {
    void (async () => {
      const saved = (await editorRef.current?.commitPendingEdit()) ?? true;
      if (!saved) return;
      scratchpadBus.close();
      setEditorVisible(false);
      setPresenting(true);
    })();
  }, [setEditorVisible]);

  const exitPresentation = useCallback(() => {
    setPresenting(false);
    if (!readOnly) setEditorVisible(true);
  }, [readOnly, setEditorVisible]);

  if (artifacts === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  // NOTE: an error is a DISMISSIBLE banner, never a replacement for the editor.
  // It used to return early, so a denied photo permission or a momentary network
  // blip ejected the kid from their deck with no way back (found by review).

  if (artifact && !deck) {
    // Corrupt content is worth saying out loud rather than rendering a blank
    // canvas that looks like lost work.
    return (
      <View style={styles.center}>
        <Text style={[styles.msg, { fontFamily: fonts.regular, color: colors.fgMuted }]}>
          {SLIDES_COPY.corruptDeck}
        </Text>
      </View>
    );
  }

  if (!deck) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <>
      {error && (
        <Pressable onPress={dismissError} style={styles.errorBanner}>
          <Text style={[styles.msg, { fontFamily: fonts.regular, color: colors.statusRed }]}>
            {error} (tap to dismiss)
          </Text>
        </Pressable>
      )}
      <SlidesEditorNative
        deck={deck}
        onOps={onOps}
        readOnly
        compact
        slideIndex={slideIndex}
        onSlideIndexChange={setSlideIndex}
        onCanvasPress={readOnly ? undefined : () => setEditorVisible(true)}
        resolveAsset={resolveAsset}
      />
      {!readOnly && (
        <Modal
          visible={editorOpen}
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => void closeEditor()}
        >
          <View
            style={[
              styles.editorScreen,
              {
                backgroundColor: colors.bg,
                paddingTop: Math.max(insets.top, 20),
                paddingBottom: insets.bottom,
                paddingLeft: insets.left,
                paddingRight: insets.right,
              },
            ]}
          >
            <Animated.View style={[styles.editorContent, scratchpadInset]}>
              <View style={[styles.editorHeader, { borderBottomColor: colors.border }]}>
              <View style={styles.editorTitleWrap}>
                <SlidesViewToggleNative value={editorView} onChange={setEditorView} />
              </View>
              <View style={styles.headerActions}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Share slides"
                  disabled={exporting}
                  onPress={showShareMenu}
                  style={({ pressed }) => [
                    styles.headerButton,
                    {
                      borderColor: colors.border,
                      opacity: exporting ? 0.4 : pressed ? 0.65 : 1,
                    },
                  ]}
                >
                  {exporting ? (
                    <ActivityIndicator size="small" color={colors.fg} />
                  ) : (
                    <SymbolView name="square.and.arrow.up" size={18} tintColor={colors.fg} />
                  )}
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Present slides"
                  onPress={presentDeck}
                  style={({ pressed }) => [
                    styles.headerButton,
                    { borderColor: colors.border, opacity: pressed ? 0.65 : 1 },
                  ]}
                >
                  <SymbolView name="rectangle.on.rectangle" size={18} tintColor={colors.fg} />
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close slide editor"
                  onPress={() => void closeEditor()}
                  style={({ pressed }) => [
                    styles.headerButton,
                    { borderColor: colors.border, opacity: pressed ? 0.65 : 1 },
                  ]}
                >
                  <SymbolView name="xmark" size={18} tintColor={colors.fg} />
                </Pressable>
              </View>
              </View>
              {error && (
                <Pressable onPress={dismissError} style={styles.errorBanner}>
                  <Text
                    style={[styles.msg, { fontFamily: fonts.regular, color: colors.statusRed }]}
                  >
                    {error} (tap to dismiss)
                  </Text>
                </Pressable>
              )}
              <SlidesEditorNative
                ref={editorRef}
                deck={deck}
                onOps={onOps}
                slideIndex={slideIndex}
                onSlideIndexChange={setSlideIndex}
                gridOpen={editorView === "grid"}
                onGridOpenChange={(open) => setEditorView(open ? "grid" : "slide")}
                resolveAsset={resolveAsset}
                onAddMedia={onAddMedia}
                onAddSketch={onAddSketch}
              />
            </Animated.View>
            {makePictureOpen && (
              <MakePictureDialog
                key={makePictureDialogKey}
                onSubmit={(prompt) => {
                  onMakePictureSubmit(prompt);
                }}
                onCancel={() => {
                  setMakePictureOpen(false);
                }}
              />
            )}
            {findImageOpen && (
              <FindImageSheet
                initial={imageSearchSnapshot}
                onSnapshot={setImageSearchSnapshot}
                onSearch={onFindImageSearch}
                onPick={onFindImagePick}
                onCancel={() => {
                  setFindImageOpen(false);
                }}
              />
            )}
            <GlobalScratchpad title="Slide sketch" />
          </View>
        </Modal>
      )}
      <Modal
        animationType="fade"
        onRequestClose={exitPresentation}
        presentationStyle="fullScreen"
        supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
        visible={presenting}
      >
        <SlidesPresentationNative
          deck={deck}
          slideIndex={slideIndex}
          onSlideIndexChange={setSlideIndex}
          onExit={exitPresentation}
          resolveAsset={resolveAsset}
        />
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  center: { padding: 24, alignItems: "center", justifyContent: "center" },
  msg: { fontSize: 13, textAlign: "center" },
  errorBanner: { paddingHorizontal: 16, paddingVertical: 8 },
  editorScreen: { flex: 1 },
  editorContent: { flex: 1 },
  editorHeader: {
    minHeight: 52,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  editorTitleWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  editorTitle: { fontSize: 17 },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
