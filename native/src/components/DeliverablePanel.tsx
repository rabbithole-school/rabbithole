/**
 * DeliverablePanel — full-height right-side panel for the landscape iPad layout.
 *
 * Contains (top to bottom):
 *   1. Title + kind badge
 *   2. Instructions / prompt text
 *   3. Earned flair emoji (if any), with names revealed on tap.
 *   4. Artifact text editor (large — primary surface) with 600ms debounced auto-save
 *   5. "Check my work" footer action
 *
 * Scholar surfaces show earned flair only — never a rubric goal checklist or a
 * "N of M stars" denominator (those are deficit displays).
 *
 * Used only in landscape mode. Portrait continues to use DeliverableCard inline.
 *
 * A session WITHOUT a deliverable activity (open exploration, unit-level
 * planning, a deliverable-less activity) still gets this panel once it holds a
 * text/code artifact — the tutor can create documents in any session — showing
 * just the document switcher + editor, with none of the deliverable-only parts
 * (1–3, 5). See `workSurfaceFor` (TRA-463).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated from "react-native-reanimated";

import { useImageAttachment } from "@/hooks/useImageAttachment";
import { useStreamingDictation } from "@/hooks/useStreamingDictation";
import { isTextArtifact } from "../../vendor/shared/textArtifacts";
import { createDraftSaveDrain } from "../../vendor/shared/draftSaveDrain";
import {
  clearAllArtifactDrafts,
  createArtifactDraftController,
  hasArtifactDraftConflict,
  hasIncomingArtifactConflict,
} from "../../vendor/shared/artifactDraftStore";
import { useKeyboardInset } from "@/hooks/useKeyboardInset";
import { api, type Doc, type Id } from "@/lib/convex";
import { appStatusBus } from "@/lib/appStatusBus";
import { getNativeTTS } from "@/lib/nativeTTS";
import { fonts, useColors } from "@/theme";
import {
  CodeArtifactWebView,
  type CodeArtifactWebViewHandle,
} from "@/components/CodeArtifactWebView";
import type { AppTutorRequest } from "../../vendor/shared/appTutorRequest";
import { SlidesDeliverable } from "./slides/SlidesDeliverable";
import { FlairChips } from "./FlairChips";
import { AppTextInput } from "@/components/AppTextInput";
import { RecordingBar } from "@/components/RecordingBar";
import { ArtifactChipStrip } from "./ArtifactChipStrip";
import {
  artifactIdForDeliverableLookup,
  dedicatedDeliverableArtifact,
  nextAutoSelect,
  pickDefaultArtifact,
  workSurfaceFor,
} from "@/lib/deliverableArtifactSelection";

// ─── Types ──────────────────────────────────────────────────────────────────

type Criterion = { id: string; label: string; description?: string };
type DeliverableKind =
  | "photo"
  | "artifact"
  | "slides"
  | "text"
  | "audio"
  | "map";
type DeliverableMode = "manual" | "auto" | "none";

export type DeliverablePanelProps = {
  sessionId: Id<"sessions">;
  /** Absent for a session with no activity — the panel then shows documents only. */
  activityId?: Id<"activities">;
  /** Submits the active artifact, then optionally runs a silent rubric stream. */
  onAskCheck?: (
    artifact: Doc<"artifacts">,
    shouldCheck: boolean,
  ) => void | Promise<void>;
  /** Whether the chat is currently streaming (disables the check button). */
  checkDisabled?: boolean;
  codeArtifactRef?: Ref<CodeArtifactWebViewHandle>;
  onAskTutor?: (request: AppTutorRequest) => void | Promise<void>;
  /** A character exchange or judgment finished in the app (→ tutor queue). */
  onAppAiTurn?: () => void;
  /** False for a non-owner viewer: the app's character/judges answer
   *  `unavailable` without a server call. */
  appAiEnabled?: boolean;
  /**
   * The session's map card, when the tutor has opened one. In the landscape
   * layout the map lives here, beside the chat, instead of in the chat list,
   * where it pinned itself above the composer and crowded out the tutor's text.
   */
  map?: ReactNode;
};

// ─── Constants ───────────────────────────────────────────────────────────────

const SAVE_DEBOUNCE_MS = 600;
const pendingArtifactSaves = new Map<string, () => Promise<void>>();

/** Flushes active text-artifact editors before the tutor reads session context. */
export async function flushPendingArtifactSaves(): Promise<void> {
  await Promise.all(Array.from(pendingArtifactSaves.values(), (flush) => flush()));
}

export function clearPendingArtifactSaves(): void {
  pendingArtifactSaves.clear();
  clearAllArtifactDrafts();
}

type ArtifactSaveResult =
  | { ok: true; revision: number }
  | {
      ok: false;
      conflict: true;
      artifact: { _id: string; title: string; content: string; revision?: number; lastEditedBy: string };
    };

// ─── Main component ──────────────────────────────────────────────────────────

export function DeliverablePanel({
  sessionId,
  activityId,
  onAskCheck,
  checkDisabled = false,
  codeArtifactRef,
  onAskTutor,
  onAppAiTurn,
  appAiEnabled,
  map,
}: DeliverablePanelProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [selectedArtifactId, setSelectedArtifactId] = useState<Id<"artifacts"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupRepairFailed, setSetupRepairFailed] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const scrollOffsetRef = useRef(0);
  const scrollHeightRef = useRef<number | undefined>(undefined);
  const editorYRef = useRef<number | undefined>(undefined);
  const pendingRevealRef = useRef((Keyboard.metrics()?.height ?? 0) > 0);
  const revealFrameRef = useRef<number | undefined>(undefined);

  // Keyboard tracking — the same hook the chat pane uses. When the iOS keyboard
  // slides up, paddingBottom on this panel's Animated.View shrinks the ScrollView
  // (flex:1) so the editor + footer stay above the keyboard.
  const { style: keyboardInsetStyle } = useKeyboardInset();

  const revealEditor = useCallback((animated: boolean) => {
    const editorY = editorYRef.current;
    const scrollHeight = scrollHeightRef.current;
    if (editorY === undefined || scrollHeight === undefined) return false;

    const viewportBottom = scrollOffsetRef.current + scrollHeight;
    if (editorY < viewportBottom) return true;

    scrollRef.current?.scrollTo({ y: Math.max(0, editorY - 12), animated });
    return true;
  }, []);

  // A chat composer can open the keyboard before this sibling panel is touched.
  // After iOS reports that it has settled, reveal the editor only when it falls
  // below the shrunken viewport. This leaves intentional reading and scrolling
  // alone after that one keyboard transition.
  useEffect(() => {
    const cancelPendingReveal = () => {
      if (revealFrameRef.current !== undefined) {
        cancelAnimationFrame(revealFrameRef.current);
        revealFrameRef.current = undefined;
      }
    };
    const revealAfterKeyboardDidShow = () => {
      pendingRevealRef.current = true;
      cancelPendingReveal();
      revealFrameRef.current = requestAnimationFrame(() => {
        revealFrameRef.current = undefined;
        if (pendingRevealRef.current && revealEditor(true)) {
          pendingRevealRef.current = false;
        }
      });
    };
    const clearKeyboardReveal = () => {
      cancelPendingReveal();
      pendingRevealRef.current = false;
    };
    const didShow = Keyboard.addListener("keyboardDidShow", revealAfterKeyboardDidShow);
    const didHide = Keyboard.addListener("keyboardDidHide", clearKeyboardReveal);
    return () => {
      cancelPendingReveal();
      pendingRevealRef.current = false;
      didShow.remove();
      didHide.remove();
    };
  }, [revealEditor]);

  const handleScrollLayout = useCallback(
    (height: number) => {
      scrollHeightRef.current = height;
      if (
        pendingRevealRef.current &&
        revealEditor(true)
      ) {
        pendingRevealRef.current = false;
      }
    },
    [revealEditor],
  );

  const handleEditorLayout = useCallback(
    (y: number) => {
      editorYRef.current = y;
      if (
        pendingRevealRef.current &&
        revealEditor(true)
      ) {
        pendingRevealRef.current = false;
      }
    },
    [revealEditor],
  );

  const handleEditorFocus = useCallback(() => {
    revealEditor(true);
  }, [revealEditor]);

  const activity = useQuery(
    api.activities.getPublic,
    activityId ? { id: activityId } : "skip",
  );
  const snapshot = useQuery(api.sessions.getDeliverableSnapshot, { sessionId });
  const artifactsResult = useQuery(api.artifacts.getBySession, { sessionId });
  const createArtifact = useMutation(api.artifacts.scholarCreate);
  const updateArtifact = useMutation(api.artifacts.scholarUpdate);
  const submitDeliverable = useMutation(api.deliverables.submit);
  const retrySetup = useMutation(api.sessions.ensureActivitySetup);
  const assessPhoto = useAction(api.deliverableAssess.assessSubmittedDeliverable);
  const { attach, uploading } = useImageAttachment();

  useEffect(() => {
    if (
      activity?.deliverable?.mode !== "auto" ||
      snapshot?.status !== null
    ) {
      return;
    }
    void retrySetup({ sessionId }).catch((error) => {
      console.warn("[deliverable-setup] repair failed", error);
      setSetupRepairFailed(true);
    });
  }, [activity?.deliverable?.mode, retrySetup, sessionId, snapshot?.status]);

  const artifacts = useMemo(
    () =>
      [...(artifactsResult ?? [])]
        .filter(isTextArtifact)
        .sort((a, b) => a._creationTime - b._creationTime),
    [artifactsResult],
  );

  // Auto-select an artifact that APPEARS after the panel's first loaded render
  // — a tutor-made code app, a second doc the scholar asked for — so it opens
  // once, mirroring the web ArtifactPanel's "new artifact ids → select the
  // last" effect. The transition rule lives in the pure `nextAutoSelect` state
  // machine; here we just hold its state across renders and reset it when the
  // session changes (seen ids are monotonic only WITHIN a session).
  const autoSelectRef = useRef<{
    seenIds: string[];
    baselineEstablished: boolean;
  }>({ seenIds: [], baselineEstablished: false });
  const autoSelectSessionRef = useRef<Id<"sessions">>(sessionId);
  useEffect(() => {
    if (autoSelectSessionRef.current !== sessionId) {
      autoSelectSessionRef.current = sessionId;
      autoSelectRef.current = { seenIds: [], baselineEstablished: false };
    }
    // A still-loading artifacts query (undefined) must not advance the machine —
    // only real snapshots establish the baseline or reveal a new id.
    if (artifactsResult === undefined) return;
    const result = nextAutoSelect({
      seenIds: autoSelectRef.current.seenIds,
      ids: artifacts.map((a) => String(a._id)),
      baselineEstablished: autoSelectRef.current.baselineEstablished,
    });
    autoSelectRef.current = {
      seenIds: result.seenIds,
      baselineEstablished: result.baselineEstablished,
    };
    if (result.select !== undefined) {
      setSelectedArtifactId(result.select as Id<"artifacts">);
    }
  }, [artifacts, artifactsResult, sessionId]);

  // A slides/map deliverable's work is its deck/map, which `artifacts` (text
  // documents only) never contains — resolve it from the unfiltered list so the
  // footer's flair and check scope to the deck, not a side document (TRA-339).
  const dedicatedArtifact = dedicatedDeliverableArtifact(
    artifactsResult ?? [],
    activity?.deliverable?.kind,
  );
  const activeArtifact =
    dedicatedArtifact !== undefined
      ? dedicatedArtifact
      : (artifacts.find((a) => a._id === selectedArtifactId) ??
        pickDefaultArtifact(artifacts, activity?.deliverable?.kind ?? null));
  const textCheckDisabled = checkDisabled || !activeArtifact?.content.trim();
  const deliverableArtifactId = artifactIdForDeliverableLookup(
    activeArtifact?._id,
    activity?.deliverable?.kind,
  );

  const surface = workSurfaceFor({
    hasActivity: !!activityId,
    activity,
    textArtifactCount: artifactsResult === undefined ? undefined : artifacts.length,
  });
  const deliverable = useQuery(
    api.deliverables.getForSessionActivity,
    !activityId || surface === "documents" || surface === "none"
      ? "skip"
      : deliverableArtifactId
        ? { sessionId, activityId, artifactId: deliverableArtifactId }
        : { sessionId, activityId },
  );
  // The deliverable query re-subscribes on every chip switch (its args carry the
  // active artifact id), so it returns undefined again each time. Remember the
  // session for which it has resolved at least once so the initial mount can
  // skeleton, but a later switch keeps the strip + editor mounted and only marks
  // this artifact's deliverable-derived controls (flair) as pending. This is the
  // sanctioned "adjust state during render" pattern (guarded, so it can't loop);
  // tracking it per session resets the skeleton on a session change.
  // Latch only once the ACTIVITY has loaded. Before that the kind is unknown,
  // so the lookup is provisionally scoped to whatever document is open; on a
  // photo activity that resolves to null, and latching on it would let the
  // panel skip the skeleton and paint "No photo yet" over a photo that is
  // sitting right there — the very thing this panel was reporting as deleted.
  const [resolvedDeliverableSession, setResolvedDeliverableSession] =
    useState<Id<"sessions"> | null>(null);
  if (
    activity !== undefined &&
    deliverable !== undefined &&
    resolvedDeliverableSession !== sessionId
  ) {
    setResolvedDeliverableSession(sessionId);
  }
  const deliverableEverResolved = resolvedDeliverableSession === sessionId;
  // Served beside the row by getForSessionActivity.
  const fileUrl = deliverable?.fileUrl ?? null;

  // Nothing to show: no deliverable and no documents — never an empty panel.
  if (surface === "none") {
    if (!map) return null;
    return (
      <View style={styles.panel}>
        <View style={[styles.scrollContent, styles.mapFill]}>{map}</View>
      </View>
    );
  }

  // Skeleton only until the panel's core (activity, snapshot, artifacts) loads
  // and the deliverable has resolved at least ONCE. After that a chip switch
  // never drops back to the skeleton — the strip and the selected artifact's
  // editor stay mounted while just that artifact's deliverable row reloads.
  if (
    surface === "loading" ||
    (surface === "deliverable" &&
      (snapshot === undefined ||
        artifactsResult === undefined ||
        (deliverable === undefined && !deliverableEverResolved)))
  ) {
    return <PanelSkeleton />;
  }

  // `null` in documents mode: no prompt, rubric, check, or hand-in.
  const spec =
    surface === "deliverable"
      ? (activity?.deliverable as {
          kind: DeliverableKind;
          prompt: string;
          mode: DeliverableMode;
          criteria: Criterion[];
        })
      : null;
  const isMap = spec?.kind === "map";
  // The map IS the work: it takes whatever height the prompt leaves, and the
  // panel doesn't scroll. Beside another kind of work it gets a fixed band so
  // the photo/editor below stays reachable.
  const mapFillsPanel = !!map && isMap;

  const criteria = spec ? criteriaFor(spec, snapshot ?? null) : [];
  const criteriaPending =
    spec?.mode === "auto" &&
    snapshot?.status !== "ready" &&
    snapshot?.status !== "error" &&
    !setupRepairFailed;
  const criteriaFailed =
    spec?.mode === "auto" &&
    (snapshot?.status === "error" || setupRepairFailed);
  const isPhoto = spec?.kind === "photo";
  // The footer button swaps its navy fill for a light gray one whenever it is
  // unavailable — busy included. Derive that state ONCE per footer so the
  // spinner, the symbol, and the label always share a foreground that reads on
  // whichever fill is actually painted (a white spinner on the gray fill was
  // effectively invisible).
  const photoCheckMuted =
    !criteriaFailed && (checkDisabled || busy || criteriaPending);
  const textCheckMuted =
    !criteriaFailed && (textCheckDisabled || busy || criteriaPending);
  // Slides now have a real in-app editor (SlidesDeliverable). Audio still has
  // no capture path, so it keeps the honest empty state.
  const isSlides = spec?.kind === "slides";
  const isPendingKind = spec?.kind === "audio";

  const handleSelectArtifact = (artifactId: Id<"artifacts">) => {
    setSelectedArtifactId(artifactId);
  };

  const handleCreateArtifact = async () => {
    if (busy) return;
    void Haptics.selectionAsync();
    setBusy(true);
    try {
      const artifactId = await createArtifact({
        sessionId,
        title: defaultArtifactTitle(spec?.kind ?? "text"),
      });
      setSelectedArtifactId(artifactId);
    } finally {
      setBusy(false);
    }
  };

  const handleAskCheck = async () => {
    if (!activeArtifact || !onAskCheck || textCheckDisabled || busy) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setBusy(true);
    try {
      await onAskCheck(activeArtifact, criteria.length > 0);
    } finally {
      setBusy(false);
    }
  };

  const handleRetrySetup = async () => {
    if (busy || !criteriaFailed) return;
    setBusy(true);
    try {
      await retrySetup({ sessionId, retryErroredCriteria: true });
      setSetupRepairFailed(false);
    } catch (error) {
      Alert.alert(
        "Couldn't prepare the check",
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  // Photo deliverable: capture (camera/library) → upload → submit a real
  // deliverables row with fileStorageId (same backend as web/portrait). No
  // artifact document is involved.
  const handleCapturePhoto = async (source: "camera" | "library") => {
    if (busy || uploading || !activityId) return;
    void Haptics.selectionAsync();
    setBusy(true);
    try {
      const storageId = await attach(source);
      if (storageId) {
        await submitDeliverable({ activityId, sessionId, fileStorageId: storageId });
      }
    } catch (e) {
      Alert.alert("Couldn't submit that photo", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  // Photo deliverable: check the submitted photo against the rubric (multimodal
  // assessment of the stored file — the photo twin of "Check my work").
  const handleCheckPhoto = async () => {
    if (!deliverable || busy || checkDisabled) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setBusy(true);
    try {
      await assessPhoto({ deliverableId: deliverable._id });
    } catch (e) {
      Alert.alert("Check failed", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    // Animated.View with paddingBottom = keyboard.height drives the panel shrink
    // on the UI thread, keeping the editor and footer visible above the keyboard.
    // (KeyboardAvoidingView's frame-based heuristic breaks in a two-pane layout.)
    <Animated.View style={[styles.panel, keyboardInsetStyle]}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        onLayout={(event) => handleScrollLayout(event.nativeEvent.layout.height)}
        onScroll={(event) => {
          scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        scrollEnabled={!mapFillsPanel}
        contentContainerStyle={[
          styles.scrollContent,
          mapFillsPanel && styles.scrollContentFill,
        ]}
      >
        {spec && activity ? (
          <>
            {/* ── Deliverable kind ── */}
            <View style={styles.kindPill}>
              <SymbolView name={kindIcon(spec.kind)} size={14} tintColor={colors.violetSolid} />
              <Text style={styles.kindText}>{kindLabel(spec.kind)}</Text>
            </View>

            <Text style={styles.title}>{activity.title}</Text>

            {/* ── Instructions / prompt ── */}
            <Text style={styles.prompt}>{spec.prompt}</Text>
          </>
        ) : null}

        {map ? (
          <View style={mapFillsPanel ? styles.mapFill : styles.mapBand}>{map}</View>
        ) : null}

        {/* ── Editor / photo surface ── */}
        {!isMap && (
          <View
            style={styles.editorSection}
            onLayout={(event) => handleEditorLayout(event.nativeEvent.layout.y)}
          >
          <Text style={styles.sectionLabel}>Your work</Text>
          {!isSlides && !isPendingKind && !isPhoto && artifacts.length >= 2 && (
            <ArtifactChipStrip
              artifacts={artifacts}
              activeArtifactId={activeArtifact?._id ?? null}
              onSelect={handleSelectArtifact}
            />
          )}
          {isSlides ? (
            <SlidesDeliverable sessionId={sessionId} />
          ) : isPendingKind ? (
            <View style={styles.emptyWork}>
              <SymbolView
                name="waveform"
                size={28}
                tintColor={colors.violet}
              />
              <Text style={styles.emptyTitle}>Audio deliverable</Text>
              <Text style={styles.emptyHint}>
                Record your audio outside Rabbithole, then share it with your teacher — in-app
                recording is coming soon.
              </Text>
            </View>
          ) : isPhoto ? (
            fileUrl ? (
              <View style={styles.photoWrap}>
                <Image source={{ uri: fileUrl }} style={styles.photo} contentFit="contain" alt="Photo deliverable" />
                <View style={styles.photoActions}>
                  <Pressable
                    onPress={busy || uploading ? undefined : () => handleCapturePhoto("camera")}
                    style={({ pressed }) => [styles.photoBtn, pressed && styles.startBtnPressed]}
                  >
                    {busy || uploading ? (
                      <ActivityIndicator color={colors.violetSolid} />
                    ) : (
                      <SymbolView name="camera.fill" size={16} tintColor={colors.violetSolid} />
                    )}
                    <Text style={styles.photoBtnText}>Retake</Text>
                  </Pressable>
                  <Pressable
                    onPress={busy || uploading ? undefined : () => handleCapturePhoto("library")}
                    style={({ pressed }) => [styles.photoBtn, pressed && styles.startBtnPressed]}
                  >
                    <SymbolView name="photo.on.rectangle" size={16} tintColor={colors.violetSolid} />
                    <Text style={styles.photoBtnText}>Replace</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <View style={styles.emptyWork}>
                <SymbolView name="camera.fill" size={28} tintColor={colors.violet} />
                <Text style={styles.emptyTitle}>No photo yet</Text>
                <Text style={styles.emptyHint}>
                  Take a photo of your work, then ask Rabbithole to check it against the goal.
                </Text>
                <View style={styles.photoActions}>
                  <Pressable
                    onPress={busy || uploading ? undefined : () => handleCapturePhoto("camera")}
                    style={({ pressed }) => [styles.startBtn, pressed && styles.startBtnPressed]}
                  >
                    {busy || uploading ? (
                      <ActivityIndicator color={colors.white} />
                    ) : (
                      <SymbolView name="camera.fill" size={16} tintColor={colors.white} />
                    )}
                    <Text style={styles.startBtnText}>
                      {busy || uploading ? "Adding…" : "Take Photo"}
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={busy || uploading ? undefined : () => handleCapturePhoto("library")}
                    style={({ pressed }) => [styles.photoBtn, pressed && styles.startBtnPressed]}
                  >
                    <SymbolView name="photo.on.rectangle" size={16} tintColor={colors.violetSolid} />
                    <Text style={styles.photoBtnText}>Choose Photo</Text>
                  </Pressable>
                </View>
              </View>
            )
          ) : activeArtifact ? (
            activeArtifact.type === "code" ? (
              <CodeArtifactDeliverable
                key={activeArtifact._id}
                artifact={activeArtifact}
                onSave={(content, baseRevision) =>
                  updateArtifact({
                    artifactId: activeArtifact._id,
                    content,
                    baseRevision,
                  })
                }
                onFocus={handleEditorFocus}
                codeArtifactRef={codeArtifactRef}
                onAskTutor={onAskTutor}
                onAppAiTurn={onAppAiTurn}
                appAiEnabled={appAiEnabled}
              />
            ) : (
              <ArtifactEditor
                key={activeArtifact._id}
                artifact={activeArtifact}
                sessionId={sessionId}
                onSave={(content, baseRevision) =>
                  updateArtifact({
                    artifactId: activeArtifact._id,
                    content,
                    baseRevision,
                  })
                }
                onFocus={handleEditorFocus}
              />
            )
          ) : (
            <View style={styles.emptyWork}>
              <SymbolView name="doc.badge.plus" size={28} tintColor={colors.violet} />
              <Text style={styles.emptyTitle}>Nothing written yet</Text>
              <Text style={styles.emptyHint}>
                Start a document, then ask Rabbithole to check it against the goal.
              </Text>
              <Pressable
                onPress={busy ? undefined : handleCreateArtifact}
                style={({ pressed }) => [styles.startBtn, pressed && styles.startBtnPressed]}
              >
                {busy ? (
                  <ActivityIndicator color={colors.white} />
                ) : (
                  <SymbolView name="plus.circle.fill" size={16} tintColor={colors.white} />
                )}
                <Text style={styles.startBtnText}>{busy ? "Starting…" : "Start writing"}</Text>
              </Pressable>
            </View>
          )}
          </View>
        )}
      </ScrollView>

      {/* ── Footer: Check my work (deliverables only) ── */}
      {spec && !isMap && (isPhoto
        ? fileUrl &&
          (criteria.length > 0 || criteriaPending || criteriaFailed) && (
            <View style={styles.footer}>
              <FlairChips
                // Keyed by the work this panel is showing, so switching
                // documents can never treat the other one's flair as arriving.
                key={activeArtifact?._id ?? activityId}
                flairEarned={deliverable?.flairEarned}
                criteria={criteria}
                deliverableId={deliverable?._id}
                resolved={deliverable !== undefined}
              />
              <Pressable
                onPress={
                  criteriaFailed
                    ? handleRetrySetup
                    : checkDisabled || busy || criteriaPending
                      ? undefined
                      : handleCheckPhoto
                }
                style={({ pressed }) => [
                  styles.checkBtn,
                  photoCheckMuted && styles.checkBtnDisabled,
                  pressed &&
                    !checkDisabled &&
                    !busy &&
                    !criteriaPending &&
                    styles.checkBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  criteriaFailed
                    ? "Try preparing the photo check again"
                    : "Check my work"
                }
                accessibilityState={{
                  disabled:
                    !criteriaFailed && (checkDisabled || busy || criteriaPending),
                }}
              >
                {busy || criteriaPending ? (
                  <ActivityIndicator
                    color={
                      photoCheckMuted ? colors.charcoalMuted : colors.white
                    }
                  />
                ) : criteriaFailed ? (
                  <SymbolView
                    name="exclamationmark.triangle.fill"
                    size={17}
                    tintColor={
                      photoCheckMuted ? colors.charcoalMuted : colors.white
                    }
                  />
                ) : null}
                <Text
                  style={[
                    styles.checkBtnText,
                    photoCheckMuted && styles.checkBtnTextDisabled,
                  ]}
                >
                  {criteriaFailed
                    ? "Try preparing check again"
                    : criteriaPending
                      ? "Preparing check…"
                      : "Check my work"}
                </Text>
              </Pressable>
            </View>
          )
        : activeArtifact && (
            <View style={styles.footer}>
              <FlairChips
                // Keyed by the work this panel is showing, so switching
                // documents can never treat the other one's flair as arriving.
                key={activeArtifact?._id ?? activityId}
                flairEarned={deliverable?.flairEarned}
                criteria={criteria}
                deliverableId={deliverable?._id}
                resolved={deliverable !== undefined}
              />
              <Pressable
                onPress={
                  criteriaFailed
                    ? handleRetrySetup
                    : textCheckDisabled || criteriaPending || busy
                      ? undefined
                      : handleAskCheck
                }
                style={({ pressed }) => [
                  styles.checkBtn,
                  textCheckMuted && styles.checkBtnDisabled,
                  pressed &&
                    !textCheckDisabled &&
                    !criteriaPending &&
                    !busy &&
                    styles.checkBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  criteriaFailed
                    ? "Try preparing the rubric check again"
                    : spec.mode === "none"
                      ? "Send this work"
                      : "Check my work"
                }
                accessibilityState={{
                  disabled:
                    !criteriaFailed &&
                    (textCheckDisabled || criteriaPending || busy),
                }}
              >
                {busy || criteriaPending ? (
                  <ActivityIndicator
                    color={textCheckMuted ? colors.charcoalMuted : colors.white}
                  />
                ) : criteriaFailed || spec.mode === "none" ? (
                  <SymbolView
                    name={
                      criteriaFailed
                        ? "exclamationmark.triangle.fill"
                        : "paperplane.fill"
                    }
                    size={17}
                    tintColor={
                      textCheckMuted ? colors.charcoalMuted : colors.white
                    }
                  />
                ) : null}
                <Text
                  style={[
                    styles.checkBtnText,
                    textCheckMuted && styles.checkBtnTextDisabled,
                  ]}
                >
                  {criteriaFailed
                    ? "Try preparing check again"
                    : criteriaPending
                      ? "Preparing check…"
                      : spec.mode === "none"
                        ? "Send it"
                        : "Check my work"}
                </Text>
              </Pressable>
            </View>
          ))}
    </Animated.View>
  );
}

// ─── Code artifact: live preview + source toggle ─────────────────────────────
// Native twin of the web CodeArtifactViewer (Preview / Code). Preview runs the
// artifact in the canonical native HTML host (CodeArtifactWebView) so a code
// artifact behaves the same for a scholar on iPad as on web; Code drops to the
// shared ArtifactEditor for hand-editing the source. Defaults to Preview.
function CodeArtifactDeliverable({
  artifact,
  onSave,
  onFocus,
  codeArtifactRef,
  onAskTutor,
  onAppAiTurn,
  appAiEnabled,
}: {
  artifact: Doc<"artifacts">;
  onSave: (content: string, baseRevision: number) => Promise<ArtifactSaveResult>;
  onFocus: () => void;
  codeArtifactRef?: Ref<CodeArtifactWebViewHandle>;
  onAskTutor?: (request: AppTutorRequest) => void | Promise<void>;
  onAppAiTurn?: () => void;
  appAiEnabled?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [view, setView] = useState<"preview" | "code">("preview");
  const isEmpty = (artifact.content ?? "").trim() === "";

  return (
    <View style={styles.codeDeliverableWrap}>
      <View style={styles.codeToggle}>
        <Pressable
          onPress={() => setView("preview")}
          style={[styles.codeToggleBtn, view === "preview" && styles.codeToggleBtnActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: view === "preview" }}
        >
          <SymbolView
            name="eye"
            size={13}
            tintColor={view === "preview" ? colors.white : colors.charcoalSubtle}
          />
          <Text style={[styles.codeToggleText, view === "preview" && styles.codeToggleTextActive]}>
            Preview
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setView("code")}
          style={[styles.codeToggleBtn, view === "code" && styles.codeToggleBtnActive]}
          accessibilityRole="button"
          accessibilityState={{ selected: view === "code" }}
        >
          <SymbolView
            name="chevron.left.forwardslash.chevron.right"
            size={13}
            tintColor={view === "code" ? colors.white : colors.charcoalSubtle}
          />
          <Text style={[styles.codeToggleText, view === "code" && styles.codeToggleTextActive]}>
            Code
          </Text>
        </Pressable>
      </View>

      {view === "preview" ? (
        isEmpty ? (
          <View style={styles.codeEmpty}>
            <SymbolView
              name="chevron.left.forwardslash.chevron.right"
              size={28}
              tintColor={colors.violet}
            />
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.emptyHint}>
              Build your app with your tutor — it will show up here.
            </Text>
          </View>
        ) : (
          <View style={styles.codePreviewFrame}>
            <CodeArtifactWebView
              ref={codeArtifactRef}
              key={artifact._id}
              scope={{ kind: "session", artifactId: artifact._id }}
              content={artifact.content ?? ""}
              onAskTutor={onAskTutor}
              onAppAiTurn={onAppAiTurn}
              appAiEnabled={appAiEnabled}
            />
          </View>
        )
      ) : (
        <ArtifactEditor
          key={`${artifact._id}:code`}
          artifact={artifact}
          onSave={onSave}
          onFocus={onFocus}
        />
      )}
    </View>
  );
}

// ─── Artifact editor with debounced save ─────────────────────────────────────

/**
 * Splices dictated text into `content` at the scholar's caret (or the end when
 * nothing is focused), adding a single space on either side so speech never
 * fuses onto an adjacent word. Returns the new content and the caret position
 * just past the insertion so a following dictation chains cleanly.
 */
export function spliceDictation(
  content: string,
  selection: { start: number; end: number },
  spoken: string,
): { next: string; caret: number } {
  const text = spoken.trim();
  if (!text) return { next: content, caret: selection.end };
  const lo = Math.max(0, Math.min(selection.start, selection.end, content.length));
  const hi = Math.max(0, Math.min(Math.max(selection.start, selection.end), content.length));
  const before = content.slice(0, lo);
  const after = content.slice(hi);
  const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
  const trail = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const insertion = `${lead}${text}${trail}`;
  return { next: before + insertion + after, caret: before.length + insertion.length };
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * The one canonical editor toolbar row: document title + a transient save
 * indicator, with an optional trailing slot for the dictation mic. Shared by
 * the text editor (mic in the slot) and the code editor (no slot) so both wear
 * the same chrome.
 */
function EditorToolbarRow({
  title,
  saveState,
  children,
}: {
  title: string;
  saveState: SaveState;
  children?: ReactNode;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={styles.editorToolbar}>
      <Text style={styles.editorTitle} numberOfLines={1}>
        {title}
      </Text>
      {saveState !== "idle" && (
        <Text style={styles.saveIndicator}>
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Couldn’t save"}
        </Text>
      )}
      {children}
    </View>
  );
}

/**
 * The text editor's toolbar, which owns the dictation stack. Split out from
 * ArtifactEditor so `useStreamingDictation` — and the Expo AudioRecorder + its
 * 80ms metering poll it constructs — is mounted ONLY for the scholar's writing
 * box, never the code-source editor. Reuses the chat composer's dictation stack
 * unchanged (`useStreamingDictation` + `RecordingBar`); the only difference is
 * the transcript is spliced into the editor at the caret and flows through the
 * same debounced scholarUpdate save path as typing, instead of sending a chat
 * turn.
 */
function WritingToolbar({
  title,
  saveState,
  sessionId,
  localContentRef,
  selectionRef,
  onInsert,
}: {
  title: string;
  saveState: SaveState;
  sessionId: Id<"sessions">;
  localContentRef: { current: string };
  selectionRef: { current: { start: number; end: number } };
  onInsert: (text: string) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const insertDictated = useCallback(
    (spoken: string) => {
      const { next, caret } = spliceDictation(
        localContentRef.current,
        selectionRef.current,
        spoken,
      );
      if (next === localContentRef.current) return;
      selectionRef.current = { start: caret, end: caret };
      onInsert(next);
    },
    [localContentRef, selectionRef, onInsert],
  );
  const dictation = useStreamingDictation(insertDictated, sessionId);
  // Only one recorder may run at a time; `appStatusBus` is the shared mic-owner
  // registry the composer's dictation already publishes to.
  const micOwnedElsewhere = useSyncExternalStore(
    (fn) => appStatusBus.subscribe(fn),
    () => appStatusBus.isMicOwned(),
  );
  const onDictateStart = useCallback(async () => {
    if (appStatusBus.isMicOwned()) return; // composer (or anything) holds the mic
    getNativeTTS().stop(); // don't record over the tutor's voice
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await dictation.start();
  }, [dictation]);
  const onDictateStop = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    dictation.stop();
  }, [dictation]);
  const onDictateCancel = useCallback(() => {
    Haptics.selectionAsync();
    dictation.cancel();
  }, [dictation]);

  if (dictation.isRecording || dictation.isTranscribing) {
    return (
      <View style={styles.editorDictationBar}>
        <RecordingBar
          level={dictation.level}
          durationMs={dictation.durationMs}
          isTranscribing={dictation.isTranscribing}
          onCancel={onDictateCancel}
          onStop={onDictateStop}
        />
      </View>
    );
  }

  return (
    <EditorToolbarRow title={title} saveState={saveState}>
      <Pressable
        onPress={onDictateStart}
        disabled={micOwnedElsewhere}
        hitSlop={8}
        style={styles.editorMicBtn}
        accessibilityRole="button"
        accessibilityLabel="Dictate into your writing"
      >
        <SymbolView
          name="mic.circle.fill"
          size={26}
          tintColor={micOwnedElsewhere ? colors.gray300 : colors.violet}
        />
      </Pressable>
    </EditorToolbarRow>
  );
}

function ArtifactEditor({
  artifact,
  sessionId,
  onSave,
  onFocus,
}: {
  artifact: Doc<"artifacts">;
  sessionId?: Id<"sessions">;
  onSave: (content: string, baseRevision: number) => Promise<ArtifactSaveResult>;
  onFocus: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [draftController] = useState(() =>
    createArtifactDraftController(String(artifact._id)),
  );
  const restoredDraft = draftController.initialDraft;
  const restoredConflict = hasArtifactDraftConflict(restoredDraft, artifact);
  const [localContent, setLocalContent] = useState(
    restoredDraft?.content ?? artifact.content ?? "",
  );
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [showUpdateBanner, setShowUpdateBanner] = useState(restoredConflict);

  // Stable refs so the debounce closure always fires with the latest values.
  const localContentRef = useRef(localContent);
  const onSaveRef = useRef(onSave);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastSavedRef = useRef(artifact.content ?? "");
  const revisionRef = useRef(artifact.revision ?? 0);
  const conflictRef = useRef(restoredConflict);
  // The scholar's caret, tracked for voice dictation so a transcript splices
  // where they're typing. Lives here (above the incoming-content effect) so an
  // adopted server update can reset it and never overwrite the wrong range.
  const selectionRef = useRef({ start: localContent.length, end: localContent.length });

  useEffect(() => {
    localContentRef.current = localContent;
  }, [localContent]);
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const persistDraft = useCallback(() => {
    const snapshot = {
      content: localContentRef.current,
      serverContent: lastSavedRef.current,
      revision: revisionRef.current,
      conflict: conflictRef.current,
    };
    const dirty = localContentRef.current !== lastSavedRef.current;
    if (!dirty && !conflictRef.current) {
      draftController.clear();
      return;
    }
    draftController.write(snapshot);
  }, [draftController]);

  useEffect(() => {
    draftController.claim();
  }, [draftController]);

  // If the server pushes a new content value (e.g. AI draft) and the scholar
  // hasn't made local edits yet, accept the update silently.
  useEffect(() => {
    if (artifact.content !== lastSavedRef.current) {
      const hasConflict = hasIncomingArtifactConflict(
        localContentRef.current,
        lastSavedRef.current,
        artifact.content ?? "",
      );
      lastSavedRef.current = artifact.content ?? "";
      revisionRef.current = artifact.revision ?? 0;
      if (hasConflict) {
        clearTimeout(saveTimerRef.current);
        conflictRef.current = true;
        setShowUpdateBanner(true);
        persistDraft();
      } else {
        localContentRef.current = artifact.content ?? "";
        setLocalContent(artifact.content ?? "");
        // The adopted content is a different string, so any caret offsets the
        // scholar had (e.g. while mid-dictation) now point into the wrong text.
        // Reset to the end so a pending transcript appends instead of replacing.
        selectionRef.current = {
          start: (artifact.content ?? "").length,
          end: (artifact.content ?? "").length,
        };
        conflictRef.current = false;
        setShowUpdateBanner(false);
        persistDraft();
      }
    } else if ((artifact.revision ?? 0) > revisionRef.current) {
      revisionRef.current = artifact.revision ?? 0;
    }
  }, [artifact.content, artifact.revision, persistDraft]);

  const save = useCallback(async (content: string) => {
    if (conflictRef.current) {
      throw new Error("This document changed in Rabbithole.");
    }
    const result = await onSaveRef.current(content, revisionRef.current);
    if (!result.ok) {
      clearTimeout(saveTimerRef.current);
      lastSavedRef.current = result.artifact.content;
      revisionRef.current = result.artifact.revision ?? 0;
      conflictRef.current = true;
      setShowUpdateBanner(true);
      setSaveState("idle");
      persistDraft();
      throw new Error("This document changed in Rabbithole.");
    }
    lastSavedRef.current = content;
    revisionRef.current = result.revision;
    setSaveState("saved");
    persistDraft();
    setTimeout(() => setSaveState("idle"), 1500);
  }, [persistDraft]);

  const drainSavesRef = useRef<() => Promise<void>>(async () => undefined);
  const drainSaves = useCallback(() => drainSavesRef.current(), []);
  useEffect(() => {
    drainSavesRef.current = createDraftSaveDrain({
      hasPending: () => localContentRef.current !== lastSavedRef.current,
      readDraft: () => localContentRef.current,
      save,
    });
  }, [save]);

  useEffect(() => {
    const flush = async () => {
      clearTimeout(saveTimerRef.current);
      await drainSaves();
    };
    pendingArtifactSaves.set(String(artifact._id), flush);
    return () => {
      const pending = flush();
      persistDraft();
      const awaitPending = () => pending;
      pendingArtifactSaves.set(String(artifact._id), awaitPending);
      void pending.then(() => {
        if (pendingArtifactSaves.get(String(artifact._id)) === awaitPending) {
          pendingArtifactSaves.delete(String(artifact._id));
        }
      }).catch(() => undefined);
    };
  }, [artifact._id, drainSaves, persistDraft]);

  // Clear pending timer on unmount (prevent a save to a stale artifact).
  useEffect(() => {
    return () => {
      clearTimeout(saveTimerRef.current);
    };
  }, []);

  const handleChange = useCallback(
    (text: string) => {
      localContentRef.current = text;
      setLocalContent(text);
      setSaveState("saving");
      if (!conflictRef.current) setShowUpdateBanner(false);
      persistDraft();

      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        try {
          await drainSaves();
        } catch {
          setSaveState("error");
        }
      }, SAVE_DEBOUNCE_MS);
    },
    [drainSaves, persistDraft],
  );

  const useRabbitholesVersion = () => {
    clearTimeout(saveTimerRef.current);
    localContentRef.current = lastSavedRef.current;
    setLocalContent(lastSavedRef.current);
    conflictRef.current = false;
    setShowUpdateBanner(false);
    setSaveState("idle");
    draftController.clear();
  };
  const keepDraft = async () => {
    clearTimeout(saveTimerRef.current);
    setSaveState("saving");
    try {
      conflictRef.current = false;
      await drainSaves();
      setShowUpdateBanner(false);
      draftController.clear();
    } catch {
      setSaveState("error");
    }
  };

  // Voice dictation lives in the WritingToolbar child so its Expo recorder is
  // constructed ONLY for the scholar's text editor. `sessionId` is what gates
  // it: the code-source editor never passes one, so it never mounts a recorder.
  const dictationEnabled = sessionId !== undefined;

  return (
    <View style={styles.editorWrap}>
      {sessionId !== undefined ? (
        <WritingToolbar
          title={artifact.title}
          saveState={saveState}
          sessionId={sessionId}
          localContentRef={localContentRef}
          selectionRef={selectionRef}
          onInsert={handleChange}
        />
      ) : (
        <EditorToolbarRow title={artifact.title} saveState={saveState} />
      )}
      {showUpdateBanner && (
        <View style={styles.conflictBanner}>
          <Text style={styles.conflictText}>This document changed somewhere else</Text>
          <View style={styles.conflictActions}>
            <Pressable onPress={useRabbitholesVersion} style={styles.conflictSecondary} accessibilityRole="button">
              <Text style={styles.conflictSecondaryText}>Use Rabbithole’s version</Text>
            </Pressable>
            <Pressable onPress={() => void keepDraft()} style={styles.conflictPrimary} accessibilityRole="button">
              <Text style={styles.conflictPrimaryText}>Keep my draft</Text>
            </Pressable>
          </View>
        </View>
      )}
      <AppTextInput
        style={styles.editorInput}
        value={localContent}
        onChangeText={handleChange}
        onSelectionChange={
          dictationEnabled
            ? (event) => {
                selectionRef.current = event.nativeEvent.selection;
              }
            : undefined
        }
        placeholder="Write your work here…"
        placeholderTextColor={colors.charcoalSubtle}
        multiline
        textAlignVertical="top"
        autoCorrect
        spellCheck
        onFocus={onFocus}
        // No `contextMenuHidden` here, unlike the chat composer: this is a prose
        // editor a scholar may well want to paste into, and it is rarely empty
        // enough for the AutoFill callout to be the problem it is in the composer.
        scrollEnabled={false}
        accessibilityLabel={`Editor for ${artifact.title}`}
      />
    </View>
  );
}

// ─── Skeleton ────────────────────────────────────────────────────────────────

function PanelSkeleton() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.panel, styles.skeletonPanel]}>
      <ActivityIndicator color={colors.violet} />
      <Text style={styles.skeletonText}>Loading deliverable…</Text>
    </View>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function criteriaFor(
  spec: { mode: DeliverableMode; criteria: Criterion[] },
  snapshot: { status: string | null; criteria: Criterion[] | null } | null,
): Criterion[] {
  if (spec.mode === "none") return [];
  if (spec.mode === "auto") {
    return snapshot?.status === "ready" && snapshot.criteria ? snapshot.criteria : [];
  }
  return spec.criteria;
}

function kindLabel(kind: DeliverableKind) {
  switch (kind) {
    case "photo":
      return "Photo";
    case "slides":
      return "Slides";
    case "audio":
      return "Audio";
    case "text":
      return "Writing";
    case "map":
      return "Map";
    default:
      return "Artifact";
  }
}

function kindIcon(kind: DeliverableKind): SymbolViewProps["name"] {
  switch (kind) {
    case "photo":
      return "photo.on.rectangle";
    case "slides":
      return "rectangle.on.rectangle";
    case "audio":
      return "waveform";
    case "text":
      return "text.page";
    case "map":
      return "map.fill";
    default:
      return "shippingbox.fill";
  }
}

function defaultArtifactTitle(kind: DeliverableKind) {
  return kind === "text"
    ? "My writing"
    : kind === "slides"
      ? "My slides"
      : kind === "map"
        ? "My map"
        : "My work";
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  panel: {
    width: 410,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: c.border,
    backgroundColor: c.bg,
    flexDirection: "column",
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: 20,
    gap: 16,
    paddingBottom: 12,
  },
  scrollContentFill: { flexGrow: 1 },
  mapFill: { flex: 1, minHeight: 240 },
  mapBand: { height: 400 },

  kindPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: c.violetSubtle,
  },
  kindText: {
    fontFamily: fonts.semibold,
    fontSize: 12.5,
    color: c.violetSolid,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 20,
    lineHeight: 25,
    color: c.navy,
    marginTop: 2,
  },
  prompt: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 21,
    color: c.charcoalMuted,
  },

  // ── Editor section ──
  sectionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: c.charcoalSubtle,
    marginBottom: 2,
  },

  // ── Editor section ──
  editorSection: {
    gap: 10,
    paddingTop: 4,
  },
  codeDeliverableWrap: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    backgroundColor: c.bgSubtle,
    overflow: "hidden",
  },
  codeToggle: {
    flexDirection: "row",
    gap: 6,
    padding: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
    backgroundColor: c.white,
  },
  codeToggleBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  codeToggleBtnActive: {
    backgroundColor: c.violetSolid,
  },
  codeToggleText: {
    fontFamily: fonts.semibold,
    fontSize: 12.5,
    color: c.charcoalSubtle,
  },
  codeToggleTextActive: {
    color: c.white,
  },
  codePreviewFrame: {
    height: 460,
    backgroundColor: c.white,
  },
  codeEmpty: {
    alignItems: "center",
    paddingVertical: 40,
    paddingHorizontal: 16,
    gap: 8,
    backgroundColor: c.white,
  },
  editorWrap: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    backgroundColor: c.bgSubtle,
    overflow: "hidden",
  },
  editorToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
    backgroundColor: c.white,
  },
  editorMicBtn: {
    marginLeft: 10,
    marginVertical: -4,
  },
  editorDictationBar: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
    backgroundColor: c.white,
  },
  editorTitle: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    color: c.navy,
  },
  saveIndicator: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: c.charcoalSubtle,
    marginLeft: 8,
  },
  conflictBanner: {
    padding: 12,
    gap: 8,
    backgroundColor: c.violetSubtle,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.border,
  },
  conflictText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: c.violetSolid,
  },
  conflictActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  conflictSecondary: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: c.violetSolid,
  },
  conflictPrimary: {
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: c.violetSolid,
  },
  conflictSecondaryText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: c.violetSolid,
  },
  conflictPrimaryText: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: c.white,
  },
  editorInput: {
    fontFamily: fonts.regular,
    fontSize: 15.5,
    lineHeight: 23,
    color: c.charcoal,
    padding: 14,
    minHeight: 300,
  },

  // ── Empty / start state ──
  emptyWork: {
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 14,
    borderStyle: "dashed",
    backgroundColor: c.bgSubtle,
  },
  emptyTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.navy,
    marginTop: 4,
  },
  emptyHint: {
    fontFamily: fonts.regular,
    fontSize: 14,
    lineHeight: 19,
    color: c.charcoalMuted,
    textAlign: "center",
    marginBottom: 4,
  },
  startBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: c.violet,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    marginTop: 4,
  },
  startBtnPressed: {
    opacity: 0.82,
  },
  startBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14.5,
    color: c.white,
  },
  photoWrap: {
    gap: 12,
  },
  photo: {
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.bgSubtle,
  },
  photoActions: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
    justifyContent: "center",
    marginTop: 4,
  },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    backgroundColor: c.violetSubtle,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
  },
  photoBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 14.5,
    color: c.violetSolid,
  },

  // ── Footer / check action ──
  footer: {
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.border,
    backgroundColor: c.white,
  },
  checkBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: c.navy,
    paddingVertical: 12,
    borderRadius: 14,
  },
  checkBtnDisabled: {
    backgroundColor: c.gray100,
  },
  checkBtnPressed: {
    opacity: 0.82,
  },
  checkBtnText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: c.white,
  },
  checkBtnTextDisabled: {
    // Reads on the gray `checkBtnDisabled` fill in BOTH themes; the old
    // charcoalSubtle was ~2.3:1 on the light fill.
    color: c.charcoalMuted,
  },

  // ── Skeleton ──
  skeletonPanel: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  skeletonText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: c.charcoalMuted,
  },
});
}
