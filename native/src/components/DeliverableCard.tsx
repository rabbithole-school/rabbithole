import { useEffect, useMemo, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { Image } from "expo-image";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { FadeIn, LinearTransition } from "react-native-reanimated";

import { Markdown } from "@/components/Markdown";
import { Skeleton } from "@/components/ui/Skeleton";
import { useImageAttachment } from "@/hooks/useImageAttachment";
import { api, type Doc, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { isTextArtifact } from "../../vendor/shared/textArtifacts";
import { CodeArtifactWebView } from "@/components/CodeArtifactWebView";
import { SlidesDeliverable } from "./slides/SlidesDeliverable";
import { FlairChips } from "./FlairChips";
type DeliverableKind =
  | "photo"
  | "artifact"
  | "slides"
  | "text"
  | "audio"
  | "map";
type DeliverableMode = "manual" | "auto" | "none";
type Criterion = { id: string; label: string; description?: string };
type ArtifactDoc = Doc<"artifacts">;

export type DeliverableCardArtifact = ArtifactDoc;

export type DeliverableCardProps = {
  sessionId: Id<"sessions">;
  activityId: Id<"activities">;
  /**
   * Triggers a rubric check for the active artifact ("Check my work"). The
   * parent runs the check as a silent tutor stream —
   * NO fabricated user turn is persisted or rendered — and the tutor calls
   * `update_rubric_score` to refresh the stars.
   */
  onAskCheck?: (
    artifact: DeliverableCardArtifact,
    shouldCheck: boolean,
  ) => void | Promise<void>;
  onOpenArtifact?: (artifact: DeliverableCardArtifact) => void;
  onArtifactCreated?: (artifactId: Id<"artifacts">) => void;
  checkDisabled?: boolean;
  isCheckingRubric?: boolean;
  initiallyExpanded?: boolean;
  style?: ViewStyle;
};

export function DeliverableCard({
  sessionId,
  activityId,
  onAskCheck,
  onOpenArtifact,
  onArtifactCreated,
  checkDisabled = false,
  isCheckingRubric = false,
  initiallyExpanded = false,
  style,
}: DeliverableCardProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [selectedArtifactId, setSelectedArtifactId] = useState<Id<"artifacts"> | null>(null);
  const [busy, setBusy] = useState(false);
  const [setupRepairFailed, setSetupRepairFailed] = useState(false);

  const activity = useQuery(api.activities.getPublic, { id: activityId });
  const snapshot = useQuery(api.sessions.getDeliverableSnapshot, { sessionId });
  const artifactsResult = useQuery(api.artifacts.getBySession, { sessionId });
  const createArtifact = useMutation(api.artifacts.scholarCreate);
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
    () => [...(artifactsResult ?? [])].sort((a, b) => a._creationTime - b._creationTime),
    [artifactsResult],
  );
  // The text-deliverable box + switcher only ever host plain-text/code artifacts
  // (its CAS path). Ad-hoc tutor artifacts — `map`, `slides`, and now
  // `manipulative` — have their own inline cards (GeoMapCard / SlidesDeliverable
  // / ManipulativeCard) and must never leak into this generic text surface as
  // raw JSON. Mirrors DeliverablePanel, which already filters the same way.
  const textArtifacts = useMemo(
    () => artifacts.filter(isTextArtifact),
    [artifacts],
  );
  const activeArtifact =
    activity?.deliverable?.kind === "map"
      ? (artifacts.find((artifact) => artifact.type === "map") ?? null)
      : (textArtifacts.find((artifact) => artifact._id === selectedArtifactId) ??
        textArtifacts[textArtifacts.length - 1] ??
        null);
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

  if (activity === null || (activity && !activity.deliverable)) return null;

  if (
    activity === undefined ||
    snapshot === undefined ||
    artifactsResult === undefined ||
    deliverable === undefined
  ) {
    return <DeliverableCardSkeleton style={style} />;
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
  const isSlides = spec.kind === "slides";
  const isPendingKind = spec.kind === "audio";
  const textContent = (activeArtifact?.content ?? deliverable?.textContent ?? "").trim();
  const hasWork = textContent.length > 0 || !!fileUrl;
  const status = deliverableStatus({
    criteria,
    deliverable,
    hasWork,
    criteriaPending,
    isCheckingRubric,
  });

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
      onArtifactCreated?.(artifactId);
      const created = artifacts.find((artifact) => artifact._id === artifactId);
      if (created) onOpenArtifact?.(created);
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
  // deliverables row with fileStorageId (the same backend path as web). No
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

  // Photo deliverable: check the SUBMITTED photo against the rubric (multimodal
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
    <Animated.View
      style={[styles.card, style]}
      entering={FadeIn.duration(180)}
      layout={LinearTransition.springify().damping(22).stiffness(260)}
    >
      <View style={styles.headerRow}>
        <View style={styles.kindPill}>
          <SymbolView name={kindIcon(spec.kind)} size={16} tintColor={colors.violetSolid} />
          <Text style={styles.kindText}>{kindLabel(spec.kind)} deliverable</Text>
        </View>
        <StatusPill status={status} />
      </View>

      <View style={styles.titleGroup}>
        <Text style={styles.title}>{activity.title}</Text>
        <Text style={styles.prompt} numberOfLines={expanded ? undefined : 2}>
          {spec.prompt}
        </Text>
      </View>

      {!isMap && !isSlides && textArtifacts.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabs}
        >
          {textArtifacts.map((artifact) => {
            const selected = artifact._id === activeArtifact?._id;
            return (
              <Pressable
                key={artifact._id}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setSelectedArtifactId(artifact._id);
                }}
                style={[styles.tab, selected && styles.tabSelected]}
              >
                <Text style={[styles.tabText, selected && styles.tabTextSelected]} numberOfLines={1}>
                  {artifact.title}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      )}

      {isSlides && <SlidesDeliverable sessionId={sessionId} />}

      {isPendingKind && (
        <View style={styles.emptyWork}>
          <SymbolView
            name="waveform"
            size={30}
            tintColor={colors.violet}
          />
          <Text style={styles.emptyTitle}>Audio deliverable</Text>
          <Text style={styles.emptyHint}>
            Record your audio outside Rabbithole, then share it with your teacher — in-app recording is coming soon.
          </Text>
        </View>
      )}

      {!isMap && !isSlides && !isPendingKind && (
      <>
      <Pressable
        onPress={() => {
          if (!hasWork) return;
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
        style={styles.artifactBox}
      >
        {activeArtifact || deliverable?.textContent || fileUrl ? (
          <>
            <View style={styles.artifactHeader}>
              <SymbolView
                name={activeArtifact?.type === "code" ? "chevron.left.forwardslash.chevron.right" : "doc.text.fill"}
                size={20}
                tintColor={colors.navy}
              />
              <View style={styles.artifactTitleWrap}>
                <Text style={styles.artifactTitle} numberOfLines={1}>
                  {activeArtifact?.title ?? "Submitted work"}
                </Text>
                <Text style={styles.artifactMeta}>
                  {activeArtifact?.lastEditedBy === "ai"
                    ? "Drafted with Rabbithole"
                    : deliverable?.submittedAt
                      ? `Submitted ${formatShortDate(deliverable.submittedAt)}`
                      : "Ready when you are"}
                </Text>
              </View>
              {hasWork && (
                <SymbolView
                  name={expanded ? "chevron.up" : "chevron.down"}
                  size={14}
                  tintColor={colors.charcoalSubtle}
                />
              )}
            </View>

            {fileUrl && spec.kind === "photo" ? (
              <Image source={{ uri: fileUrl }} style={styles.photoPreview} contentFit="cover" alt="Photo deliverable" />
            ) : fileUrl ? (
              <Pressable
                onPress={() => Linking.openURL(fileUrl).catch(() => {})}
                style={styles.fileRow}
              >
                <SymbolView name="paperclip" size={16} tintColor={colors.violet} />
                <Text style={styles.fileText}>Open attached file</Text>
              </Pressable>
            ) : expanded ? (
              activeArtifact?.type === "code" ? (
                textContent ? (
                  <View style={styles.codePreviewFrame}>
                    <CodeArtifactWebView
                      key={activeArtifact._id}
                      artifactId={activeArtifact._id}
                      content={activeArtifact.content ?? ""}
                    />
                  </View>
                ) : (
                  <Text style={[styles.previewText, styles.emptyText]}>No writing yet.</Text>
                )
              ) : (
                <View style={styles.fullText}>
                  <Markdown content={textContent || "No writing yet."} color={colors.charcoal} />
                </View>
              )
            ) : activeArtifact?.type === "code" ? (
              <View style={styles.codeAffordance}>
                <SymbolView name="play.circle.fill" size={16} tintColor={colors.violet} />
                <Text style={styles.codeAffordanceText}>Interactive app — tap to run</Text>
              </View>
            ) : (
              <Text
                style={[
                  styles.previewText,
                  !textContent && styles.emptyText,
                ]}
                numberOfLines={4}
              >
                {textContent || "No writing yet."}
              </Text>
            )}
          </>
        ) : (
          <View style={styles.emptyWork}>
            <SymbolView
              name={isPhoto ? "camera.fill" : "doc.badge.plus"}
              size={30}
              tintColor={colors.violet}
            />
            <Text style={styles.emptyTitle}>
              {isPhoto ? "No photo yet" : "No document yet"}
            </Text>
            <Text style={styles.emptyHint}>
              {isPhoto
                ? "Take a photo of your work, then ask Rabbithole to check it against the goal."
                : "Start a document, then ask Rabbithole to check it against the goal."}
            </Text>
          </View>
        )}
      </Pressable>

      {deliverable?.rubricFeedback && expanded && (
        <View style={styles.feedback}>
          <Text style={styles.feedbackLabel}>
            {deliverable.rubricCheckedBy === "teacher"
              ? "Note from your teacher"
              : "Rabbithole note"}
          </Text>
          <Text style={styles.feedbackText}>{deliverable.rubricFeedback}</Text>
        </View>
      )}

      <FlairChips
        // Keyed by the work this card is showing, so switching documents can
        // never treat the other one's flair as arriving.
        key={activeArtifact?._id ?? activityId}
        flairEarned={deliverable?.flairEarned}
        criteria={criteria}
        deliverableId={deliverable?._id}
        resolved={deliverable !== undefined}
      />

      <View style={styles.actions}>
        {isPhoto ? (
          fileUrl ? (
            <>
              <ActionButton
                label="Retake"
                icon="camera.fill"
                tone="secondary"
                busy={busy || uploading}
                disabled={busy || uploading}
                onPress={() => handleCapturePhoto("camera")}
              />
              {criteriaFailed ? (
                <ActionButton
                  label="Try preparing check again"
                  icon="exclamationmark.triangle.fill"
                  disabled={busy}
                  busy={busy}
                  onPress={handleRetrySetup}
                />
              ) : criteriaPending ? (
                <ActionButton
                  label="Preparing check…"
                  icon="arrow.clockwise.circle.fill"
                  disabled
                  onPress={() => undefined}
                />
              ) : criteria.length > 0 ? (
                <ActionButton
                  label="Check my work"
                  disabled={checkDisabled || busy}
                  busy={busy || isCheckingRubric}
                  onPress={handleCheckPhoto}
                />
              ) : null}
            </>
          ) : (
            <>
              <ActionButton
                label={busy || uploading ? "Adding…" : "Take Photo"}
                icon="camera.fill"
                busy={busy || uploading}
                disabled={busy || uploading}
                onPress={() => handleCapturePhoto("camera")}
              />
              <ActionButton
                label="Choose Photo"
                icon="photo.on.rectangle"
                tone="secondary"
                disabled={busy || uploading}
                onPress={() => handleCapturePhoto("library")}
              />
            </>
          )
        ) : activeArtifact ? (
          <>
            {onOpenArtifact && (
              <ActionButton
                label="Open work"
                icon="arrow.up.forward.app"
                tone="secondary"
                onPress={() => onOpenArtifact(activeArtifact)}
              />
            )}
            {criteriaFailed ? (
              <ActionButton
                label="Try preparing check again"
                icon="exclamationmark.triangle.fill"
                disabled={busy}
                busy={busy}
                onPress={handleRetrySetup}
              />
            ) : (
              <ActionButton
                label={
                  criteriaPending
                    ? "Preparing check…"
                    : spec.mode === "none"
                      ? "Send it"
                      : "Check my work"
                }
                icon={
                  spec.mode === "none"
                    ? "paperplane.fill"
                    : undefined
                }
                disabled={
                  !onAskCheck || textCheckDisabled || criteriaPending || busy
                }
                busy={busy || isCheckingRubric}
                onPress={handleAskCheck}
              />
            )}
          </>
        ) : (
          <ActionButton
            label={busy ? "Starting…" : "Start document"}
            icon="plus.circle.fill"
            busy={busy}
            onPress={handleCreateArtifact}
          />
        )}
      </View>
      </>
      )}
    </Animated.View>
  );
}

function DeliverableCardSkeleton({ style }: { style?: ViewStyle }) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[styles.card, styles.skeletonCard, style]}>
      <Skeleton width={28} height={28} radius={14} />
      <Skeleton width={152} height={14} radius={7} />
    </View>
  );
}

function ActionButton({
  label,
  icon,
  tone = "primary",
  disabled = false,
  busy = false,
  onPress,
}: {
  label: string;
  icon?: SymbolViewProps["name"];
  tone?: "primary" | "secondary";
  disabled?: boolean;
  busy?: boolean;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Pressable
      onPress={disabled || busy ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy }}
      style={({ pressed }) => [
        styles.action,
        tone === "secondary" && styles.actionSecondary,
        (disabled || busy) && styles.actionDisabled,
        pressed && !disabled && !busy && styles.actionPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={tone === "secondary" ? colors.violet : colors.white} />
      ) : icon ? (
        <SymbolView
          name={icon}
          size={17}
          tintColor={tone === "secondary" ? colors.violetSolid : colors.white}
        />
      ) : null}
      <Text style={[styles.actionText, tone === "secondary" && styles.actionTextSecondary]}>
        {label}
      </Text>
    </Pressable>
  );
}

function StatusPill({
  status,
}: {
  status: ReturnType<typeof deliverableStatus>;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const color =
    status === "passed"
      ? colors.green
      : status === "partial" || status === "submitted"
        ? colors.violetSolid
        : status === "checking"
          ? colors.orange
          : colors.charcoalMuted;
  const icon =
    status === "passed"
      ? "checkmark.seal.fill"
      : status === "checking"
        ? "sparkles"
        : status === "empty"
          ? "doc"
          : "target";
  return (
    <View style={[styles.statusPill, { borderColor: color }]}>
      <SymbolView name={icon} size={13} tintColor={color} />
      <Text style={[styles.statusText, { color }]}>
        {statusLabel(status)}
      </Text>
    </View>
  );
}

function criteriaFor(
  spec: { mode: DeliverableMode; criteria: Criterion[] },
  snapshot: { status: string | null; criteria: Criterion[] | null } | null,
) {
  if (spec.mode === "none") return [];
  if (spec.mode === "auto") {
    return snapshot?.status === "ready" && snapshot.criteria ? snapshot.criteria : [];
  }
  return spec.criteria;
}

function deliverableStatus({
  criteria,
  deliverable,
  hasWork,
  criteriaPending,
  isCheckingRubric,
}: {
  criteria: Criterion[];
  deliverable: Doc<"deliverables"> | null;
  hasWork: boolean;
  criteriaPending: boolean;
  isCheckingRubric: boolean;
}) {
  if (isCheckingRubric) return "checking" as const;
  if (criteriaPending) return "checking" as const;
  if (!hasWork) return "empty" as const;
  if (deliverable?.rubricPassed) return "passed" as const;
  if (deliverable?.rubricCheckedAt) return "partial" as const;
  if (deliverable?.submittedAt) return "submitted" as const;
  if (criteria.length === 0) return "ready" as const;
  return "draft" as const;
}

function statusLabel(status: ReturnType<typeof deliverableStatus>) {
  switch (status) {
    case "passed":
      return "Goal met";
    case "partial":
      return "In progress";
    case "submitted":
      return "Submitted";
    case "checking":
      return "Checking";
    case "empty":
      return "No work yet";
    case "ready":
      return "Ready";
    case "draft":
      return "Draft";
  }
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

function kindIcon(kind: DeliverableKind) {
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

function formatShortDate(ms: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  card: {
    width: "100%",
    borderRadius: 26,
    backgroundColor: c.white,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
    gap: 14,
    shadowColor: c.navy,
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  skeletonCard: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 148,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  kindPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: c.violetSubtle,
  },
  kindText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: c.violetSolid,
  },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
    backgroundColor: c.white,
  },
  statusText: {
    fontFamily: fonts.semibold,
    fontSize: 12.5,
  },
  title: {
    fontFamily: fonts.bold,
    fontSize: 20,
    lineHeight: 25,
    color: c.navy,
  },
  prompt: {
    fontFamily: fonts.regular,
    fontSize: 15.5,
    lineHeight: 21,
    color: c.charcoalMuted,
  },
  tabs: {
    gap: 8,
    paddingRight: 8,
  },
  tab: {
    maxWidth: 180,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: c.gray100,
  },
  tabSelected: {
    backgroundColor: c.navy,
  },
  tabText: {
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    color: c.charcoalMuted,
  },
  tabTextSelected: {
    color: c.white,
  },
  artifactBox: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.white,
    padding: 14,
    gap: 11,
    shadowColor: c.navy,
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  artifactHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  artifactTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  artifactTitle: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: c.navy,
  },
  artifactMeta: {
    marginTop: 2,
    fontFamily: fonts.medium,
    fontSize: 12.5,
    color: c.charcoalSubtle,
  },
  previewText: {
    fontFamily: fonts.regular,
    fontSize: 16,
    lineHeight: 23,
    color: c.charcoal,
  },
  codePreviewFrame: {
    height: 360,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: c.white,
  },
  codeAffordance: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
  },
  codeAffordanceText: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: c.violetSolid,
  },
  emptyText: {
    color: c.charcoalSubtle,
    fontStyle: "italic",
  },
  fullText: {
    maxHeight: 360,
  },
  photoPreview: {
    width: "100%",
    height: 220,
    borderRadius: 16,
    backgroundColor: c.gray100,
  },
  fileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 4,
  },
  fileText: {
    fontFamily: fonts.semibold,
    color: c.violetSolid,
    fontSize: 15,
  },
  emptyWork: {
    alignItems: "center",
    gap: 7,
    paddingVertical: 12,
  },
  emptyTitle: {
    fontFamily: fonts.bold,
    color: c.navy,
    fontSize: 16,
  },
  emptyHint: {
    maxWidth: 320,
    textAlign: "center",
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
    fontSize: 14.5,
    lineHeight: 20,
  },
  feedback: {
    backgroundColor: c.violetSubtle,
    borderRadius: 12,
    padding: 12,
    gap: 4,
  },
  feedbackLabel: {
    fontFamily: fonts.bold,
    color: c.violetSolid,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  feedbackText: {
    fontFamily: fonts.regular,
    color: c.charcoal,
    fontSize: 14.5,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    flexWrap: "wrap",
    gap: 9,
  },
  action: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: c.violet,
    minHeight: 40,
  },
  actionSecondary: {
    backgroundColor: c.violetSubtle,
  },
  actionDisabled: {
    opacity: 0.45,
  },
  actionPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.86,
  },
  actionText: {
    fontFamily: fonts.bold,
    color: c.white,
    fontSize: 14.5,
  },
  actionTextSecondary: {
    color: c.violetSolid,
  },
  titleGroup: {
    gap: 4,
  },
});
}
