"use client";

/**
 * SlidesArtifactView — the bridge between a stored `type: "slides"` artifact and
 * the scholar's deck. It mirrors {@link ../geomap/MapArtifactView}: a tolerant
 * parse of the artifact `content` (bad JSON → a small error card), then the
 * deck itself.
 *
 * The chat-side panel is VIEW-ONLY: it renders {@link SlideList}, and full
 * editing happens in {@link SlidesEditor} inside a cover dialog — the same
 * split the iPad app ships (a read-only viewer beside chat, the editor
 * full-screen) and the same cover-dialog the curriculum designer already opens
 * a deck in (`components/nodeEditor/SlidesFields.tsx`). The panel is a splitter
 * pane at 25–30% of the window, which is too narrow to edit in.
 *
 * Persistence mirrors MapArtifactView too: a direct Convex mutation
 * (`scholarApplySlideOps`), never the generic content save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAction, useConvex, useMutation, useQuery } from "convex/react";
import { Center, Dialog, Portal, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { SLIDES_COPY, validateDeckLenient, type Deck, type SlideOp, type WebImageSearchResult } from "@/shared/slidesScene";
import {
  EMPTY_IMAGE_SEARCH_SNAPSHOT,
  type ImageSearchSnapshot,
} from "./FindImageDialog";
import { SlideList } from "./SlideList";
import { SlidesEditor } from "./SlidesEditor";
import { SlidesEditorDialogFrame } from "./SlidesEditorDialogFrame";
import { useSlideImageUpload } from "./useSlideImageUpload";

/** Tolerant parse: JSON.parse then validate/normalize. Bad input → null. */
function parseDeck(content: string): Deck | null {
  try {
    // Lenient on READ: a mostly-good deck on screen beats an error page for a
    // kid. Writes go through the strict `validateDeck`, which refuses to
    // persist a deck it had to truncate.
    return validateDeckLenient(JSON.parse(content));
  } catch {
    return null;
  }
}

interface SlidesArtifactViewProps {
  artifactId: Id<"artifacts">;
  content: string;
  readOnly?: boolean;
}

export function SlidesArtifactView({
  artifactId,
  content,
  readOnly = false,
}: SlidesArtifactViewProps) {
  const applyOps = useMutation(api.artifacts.scholarApplySlideOps);
  const uploadImage = useSlideImageUpload();
  const generateSlideImage = useAction(api.artifacts.scholarGenerateSlideImage);
  const searchWebImages = useAction(api.slidesImageSearch.searchWebImages);
  const pickWebImage = useAction(api.slidesImageSearch.pickWebImage);
  const exportDeck = useAction(api.slidesExport.exportDeck);
  const [exportError, setExportError] = useState<string | null>(null);
  // The slide the editor opens on. `null` = the editor is closed; keeping the
  // index here (rather than a bare `open` flag) is what makes clicking slide 4
  // in the list land on slide 4, the way the iPad app carries `slideIndex`
  // between its compact viewer and its full-screen editor.
  const [editingSlideIndex, setEditingSlideIndex] = useState<number | null>(null);
  // The last "Find an image" search, held HERE (above the editor + its picker) so
  // it survives the editor cover dialog and the picker unmounting — reopening the
  // picker restores the previous query + grid + shape. Mirrors native's
  // `imageSearchSnapshot` on SlidesDeliverable.
  const [imageSearchSnapshot, setImageSearchSnapshot] = useState<ImageSearchSnapshot>(
    EMPTY_IMAGE_SEARCH_SNAPSHOT,
  );
  const getFileUrl = useConvex();
  const deck = parseDeck(content);

  // Derived, never stored: a viewer who loses edit rights mid-view (the teacher
  // remote view flips `readOnly`) must not have a stale index reopen the editor.
  const openSlideIndex =
    readOnly || editingSlideIndex === null
      ? null
      : editingSlideIndex;

  /**
   * Every media id the deck references, resolved in ONE query — React hooks
   * cannot be called in a loop, so a per-image `files.getUrl` is not
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

  // Deleting (or adding) an image changes `assetIds`, changing this query's
  // args — and Convex useQuery returns undefined while the new args load, which
  // momentarily blanks the URL for EVERY surviving image so they all reload and
  // flicker. A Convex storage URL for an id is stable, so cache resolved URLs
  // and fall back to the cache during a refetch. Mirrors the native fix in
  // SlidesDeliverable.
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
   * Generate an illustration from the scholar's prompt. The action stores the
   * bytes, registers a slide asset for this user, and returns that storage id —
   * the SAME `assetId` shape {@link uploadImage} yields — so a generated image is
   * inserted through the exact same path as an uploaded photo. It resolves with
   * a kid-readable `error` instead of throwing on failure.
   */
  const onGeneratePicture = useCallback(
    (prompt: string) => generateSlideImage({ artifactId, prompt }),
    [artifactId, generateSlideImage],
  );

  /**
   * "Find an image" — the two Convex actions behind the picker. `searchWebImages`
   * returns the Brave-proxied grid; `pickWebImage` re-hosts the tapped result in
   * Convex storage and returns the SAME `assetId` shape a generated image
   * yields, so a found image inserts through the exact same path as an uploaded
   * or generated one.
   */
  const onSearchImages = useCallback(
    (query: string) => searchWebImages({ artifactId, query }),
    [artifactId, searchWebImages],
  );

  const onPickImage = useCallback(
    (query: string, image: WebImageSearchResult) =>
      pickWebImage({ artifactId, query, image }),
    [artifactId, pickWebImage],
  );

  const openEditor = useCallback((slideIndex: number) => {
    setEditingSlideIndex(slideIndex);
  }, []);

  /**
   * Export the deck and hand the file to the browser.
   *
   * The action renders bytes SERVER-side and returns a storage id, so a .pptx is
   * identical whichever client asked for it. We then resolve that id to a URL and
   * open it — rather than streaming bytes through the action's return value,
   * which would put a whole deck in a function response.
   */
  const onExport = useCallback(
    async (format: "pptx" | "pdf") => {
      try {
        const storageId = await exportDeck({ artifactId, format });
        const url = await getFileUrl.query(api.files.getUrl, { storageId });
        if (!url) throw new Error("The exported file could not be opened.");
        window.open(url, "_blank", "noopener");
      } catch (e) {
        setExportError(e instanceof Error ? e.message : String(e));
      }
    },
    [exportDeck, getFileUrl, artifactId],
  );

  const onOps = useCallback(
    (ops: SlideOp[]) => {
      if (!deck) return;
      // NO baseRevision. A scholar's ops are ABSOLUTE and id-addressed — "put
      // element X at this frame" — describing a gesture they just made with
      // their hand, so they are never semantically stale and must not be
      // refused because the tutor touched a DIFFERENT element mid-drag.
      // `baseRevision` exists for the MODEL, which reasons about a scene it read
      // seconds earlier. Sending it here silently discarded the kid's drag: the
      // mutation RETURNS { conflict: true } rather than throwing, so nothing
      // caught it and the subscription simply snapped the element back.
      // An op naming an element the tutor deleted still fails loudly.
      void applyOps({ artifactId, ops: JSON.stringify(ops) }).then(
        (res) => {
          if (res?.conflict) setExportError("That change didn't save — try again.");
        },
        (e: unknown) => setExportError(e instanceof Error ? e.message : String(e)),
      );
    },
    [applyOps, artifactId, deck],
  );

  if (!deck) {
    return (
      <Center h="100%" w="100%" bg="white" p={6}>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400" textAlign="center">
          {SLIDES_COPY.corruptDeck}
        </Text>
      </Center>
    );
  }

  return (
    <>
      {exportError && (
        <Text
          fontFamily="body"
          fontSize="xs"
          color="red.600"
          px={3}
          py={2}
          role="alert"
        >
          {exportError}
        </Text>
      )}
      {/* The panel itself never edits — no toolbar, no notes editor, no
          add/delete slide. Clicking a slide opens the editor below. */}
      <SlideList
        deck={deck}
        resolveAsset={resolveAsset}
        onEditSlide={readOnly ? undefined : openEditor}
      />
      {!readOnly && (
        <Dialog.Root
          open={openSlideIndex !== null}
          onOpenChange={(d) => {
            if (!d.open) {
              setEditingSlideIndex(null);
            }
          }}
          size="full"
          placement="center"
        >
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner>
              <SlidesEditorDialogFrame title={deck.title}>
                {openSlideIndex !== null && (
                  <SlidesEditor
                    deck={deck}
                    initialSlideIndex={openSlideIndex}
                    onOps={onOps}
                    resolveAsset={resolveAsset}
                    onUploadImage={uploadImage}
                    onGeneratePicture={onGeneratePicture}
                    onSearchImages={onSearchImages}
                    onPickImage={onPickImage}
                    imageSearchSnapshot={imageSearchSnapshot}
                    onImageSearchSnapshot={setImageSearchSnapshot}
                    onExport={onExport}
                  />
                )}
              </SlidesEditorDialogFrame>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
    </>
  );
}

/**
 * A slides deliverable with no artifact yet. Creates the real deck, then gets
 * out of the way — the panel re-renders with the artifact-backed editor as soon
 * as the reactive query sees it.
 */
export function EmptyDeckSlidesEditor({
  sessionId,
  readOnly = false,
}: {
  sessionId: Id<"sessions">;
  readOnly?: boolean;
}) {
  const ensureDeck = useMutation(api.artifacts.scholarEnsureSlidesDeck);
  const [failed, setFailed] = useState<string | null>(null);
  const ensuring = useRef(false);

  useEffect(() => {
    // A teacher viewing a scholar's empty deliverable must not mint their deck.
    if (readOnly || ensuring.current) return;
    ensuring.current = true;
    ensureDeck({ sessionId }).catch((e: unknown) => {
      setFailed(e instanceof Error ? e.message : String(e));
      ensuring.current = false;
    });
  }, [ensureDeck, sessionId, readOnly]);

  return (
    <Center h="100%" w="100%" bg="white" p={6}>
      <Text fontFamily="body" fontSize="sm" color="charcoal.400" textAlign="center">
        {failed ?? (readOnly ? "No slides yet." : "Starting your slides…")}
      </Text>
    </Center>
  );
}
