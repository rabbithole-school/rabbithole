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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { fonts, useColors } from "@/theme";
import { CodeArtifactWebView } from "@/components/CodeArtifactWebView";
import { SlidesDeliverable } from "./slides/SlidesDeliverable";
import { FlairChips } from "./FlairChips";
import { AppTextInput } from "@/components/AppTextInput";

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
  activityId: Id<"activities">;
  /** Submits the active artifact, then optionally runs a silent rubric stream. */
  onAskCheck?: (
    artifact: Doc<"artifacts">,
    shouldCheck: boolean,
  ) => void | Promise<void>;
  /** Whether the chat is currently streaming (disables the check button). */
  checkDisabled?: boolean;
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

  const activity = useQuery(api.activities.getPublic, { id: activityId });
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
  const activeArtifact =
    artifacts.find((a) => a._id === selectedArtifactId) ??
    artifacts[artifacts.length - 1] ??
    null;
  const textCheckDisabled = checkDisabled || !activeArtifact?.content.trim();

  const deliverable = useQuery(
    api.deliverables.getForSessionActivity,
    activeArtifact
      ? { sessionId, activityId, artifactId: activeArtifact._id }
      : { sessionId, activityId },
  );
  const fileUrl = useQuery(
    api.files.getUrl,
    deliverable?.fileStorageId ? { storageId: deliverable.fileStorageId } : "skip",
  );

  // Don't render if this session has no deliverable activity.
  if (activity === null || (activity && !activity.deliverable)) return null;

  if (
    activity === undefined ||
    snapshot === undefined ||
    artifactsResult === undefined ||
    deliverable === undefined
  ) {
    return <PanelSkeleton />;
  }

  const spec = activity.deliverable as {
    kind: DeliverableKind;
    prompt: string;
    mode: DeliverableMode;
    criteria: Criterion[];
  };
  const isMap = spec.kind === "map";

  const criteria = criteriaFor(spec, snapshot);
  const criteriaPending =
    spec.mode === "auto" &&
    snapshot?.status !== "ready" &&
    snapshot?.status !== "error" &&
    !setupRepairFailed;
  const criteriaFailed =
    spec.mode === "auto" &&
    (snapshot?.status === "error" || setupRepairFailed);
  const isPhoto = spec.kind === "photo";
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
  const isSlides = spec.kind === "slides";
  const isPendingKind = spec.kind === "audio";

  const handleCreateArtifact = async () => {
    if (busy) return;
    void Haptics.selectionAsync();
    setBusy(true);
    try {
      const artifactId = await createArtifact({
        sessionId,
        title: defaultArtifactTitle(spec.kind),
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
    if (busy || uploading) return;
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
        contentContainerStyle={styles.scrollContent}
        onLayout={(event) => handleScrollLayout(event.nativeEvent.layout.height)}
        onScroll={(event) => {
          scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* ── Deliverable kind ── */}
        <View style={styles.kindPill}>
          <SymbolView name={kindIcon(spec.kind)} size={14} tintColor={colors.violetSolid} />
          <Text style={styles.kindText}>{kindLabel(spec.kind)}</Text>
        </View>

        <Text style={styles.title}>{activity.title}</Text>

        {/* ── Instructions / prompt ── */}
        <Text style={styles.prompt}>{spec.prompt}</Text>

        {/* ── Editor / photo surface ── */}
        {!isMap && (
          <View
            style={styles.editorSection}
            onLayout={(event) => handleEditorLayout(event.nativeEvent.layout.y)}
          >
          <Text style={styles.sectionLabel}>Your work</Text>
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
              />
            ) : (
              <ArtifactEditor
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

      {/* ── Footer: Check my work ── */}
      {!isMap && (isPhoto
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
}: {
  artifact: Doc<"artifacts">;
  onSave: (content: string, baseRevision: number) => Promise<ArtifactSaveResult>;
  onFocus: () => void;
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
              key={artifact._id}
              artifactId={artifact._id}
              content={artifact.content ?? ""}
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

function ArtifactEditor({
  artifact,
  onSave,
  onFocus,
}: {
  artifact: Doc<"artifacts">;
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

  return (
    <View style={styles.editorWrap}>
      <View style={styles.editorToolbar}>
        <Text style={styles.editorTitle} numberOfLines={1}>
          {artifact.title}
        </Text>
        {saveState !== "idle" && (
          <Text style={styles.saveIndicator}>
            {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Saved" : "Couldn’t save"}
          </Text>
        )}
      </View>
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
