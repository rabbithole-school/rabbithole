import { useEffect, useMemo, useState } from "react";
import { useConvex, useMutation } from "convex/react";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  kindLabel,
  type UnitProgressActivity,
  type UnitProgressActivityItem,
  useUnitProgress,
} from "@/hooks/useUnitProgress";
import { api, type Id } from "@/lib/convex";
import { openWebActivity } from "@/lib/externalAppHost";
import { openGameActivity } from "@/lib/gameHost";
import { webEmbedUrlError } from "@/lib/webEmbedConfig";
import { fonts, palette, useColors } from "@/theme";

export type WhereAmIPanelProps = {
  visible: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  unitId?: Id<"units"> | null;
  activityId?: Id<"activities"> | null;
  assignmentId?: Id<"assignments"> | null;
  activityCompleted?: boolean;
  title?: string | null;
};

type ConfirmMode = "complete" | "undo" | null;

type RowMeta = {
  icon: SymbolViewProps["name"];
  label: string;
  tint: string;
  background: string;
  border: string;
};

function rowMeta(c: ReturnType<typeof useColors>): Record<"done" | "current" | "not-started", RowMeta> {
  return {
    done: {
      icon: "checkmark.circle.fill",
      label: "Done",
      tint: c.green,
      background: palette.green[50],
      border: palette.green[200],
    },
    current: {
      icon: "arrow.right.circle.fill",
      label: "Current",
      tint: c.violet,
      background: c.violetSubtle,
      border: palette.violet[200],
    },
    "not-started": {
      icon: "circle",
      label: "Not started",
      tint: c.gray300,
      background: c.bg,
      border: c.border,
    },
  };
}

export function WhereAmIPanel({
  visible,
  onClose,
  sessionId,
  unitId,
  activityId,
  assignmentId,
  activityCompleted = false,
  title,
}: WhereAmIPanelProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const convex = useConvex();
  const insets = useSafeAreaInsets();
  const markComplete = useMutation(api.activityCompletions.markComplete);
  const unmarkComplete = useMutation(api.activityCompletions.unmarkComplete);
  const progress = useUnitProgress({
    unitId,
    activityId,
    assignmentId,
    enabled: visible,
  });

  const [confirmMode, setConfirmMode] = useState<ConfirmMode>(null);
  const [saving, setSaving] = useState(false);
  const [modalMounted, setModalMounted] = useState(visible);

  // Animation shared values — backdrop fades, sheet slides independently.
  const backdropOpacity = useSharedValue(visible ? 1 : 0);
  const sheetTranslateY = useSharedValue(visible ? 0 : 700);

  const animatedBackdropStyle = useAnimatedStyle(() => ({
    opacity: backdropOpacity.get(),
  }));

  const animatedSheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: sheetTranslateY.get() }],
  }));

  const screenTitle = progress.unit?.title ?? title ?? "Unit progress";
  const currentItem = progress.currentActivity;
  const currentActivityCompleted =
    !!activityId && (progress.currentActivityCompleted || activityCompleted);
  const hasUnitMap = !!unitId;
  const canMarkActivity = !!activityId;

  useEffect(() => {
    if (visible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- The modal must mount in the same transition that begins its opening animations.
      setModalMounted(true);
      backdropOpacity.set(withTiming(1, { duration: 280 }));
      sheetTranslateY.set(withSpring(0, {
        damping: 22,
        stiffness: 200,
        overshootClamping: true,
      }));
    } else {
      setConfirmMode(null);
      setSaving(false);
      backdropOpacity.set(withTiming(0, { duration: 220 }));
      sheetTranslateY.set(withTiming(
        700,
        { duration: 260, easing: Easing.in(Easing.cubic) },
        (finished) => {
          if (finished) runOnJS(setModalMounted)(false);
        },
      ));
    }
  }, [visible, backdropOpacity, sheetTranslateY]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A new activity or completion state invalidates the previous confirmation before it can be acted on.
    setConfirmMode(null);
  }, [activityId, currentActivityCompleted]);

  const currentPositionLabel = useMemo(() => {
    if (!currentItem || progress.activityTotal === 0) return null;
    return `Activity ${currentItem.position} of ${progress.activityTotal}`;
  }, [currentItem, progress.activityTotal]);

  const openGameActivityRow = (activity: UnitProgressActivity) => {
    Haptics.selectionAsync();
    onClose();
    openGameActivity({
      activityId: activity._id,
      ...(assignmentId ? { assignmentId } : {}),
      activityTitle: activity.title,
    });
  };

  const openWebActivityRow = async (activity: UnitProgressActivity) => {
    Haptics.selectionAsync();
    try {
      const detail = await convex.query(api.activities.getPublic, {
        id: activity._id,
      });
      const webUrl = detail?.webUrl;
      if (!webUrl) {
        Alert.alert(
          "No website yet",
          "Ask your teacher to add the website URL for this activity.",
        );
        return;
      }
      const urlError = webEmbedUrlError(webUrl);
      if (urlError) {
        Alert.alert("Couldn’t open this activity", urlError);
        return;
      }
      onClose();
      openWebActivity({
        activityId: activity._id,
        ...(assignmentId ? { assignmentId } : {}),
        title: detail?.title ?? activity.title,
        url: webUrl,
        allowedHosts: detail?.webAllowedHosts ?? null,
        externalAppId: detail?.externalAppId ?? null,
        gestureMode: "page",
      });
    } catch (e) {
      console.warn("[web-activity] launch failed", e);
      Alert.alert(
        "Couldn’t open this activity",
        "Check your connection and try again.",
      );
    }
  };

  const requestStatusChange = (mode: Exclude<ConfirmMode, null>) => {
    Haptics.selectionAsync();
    setConfirmMode(mode);
  };

  const cancelStatusChange = () => {
    Haptics.selectionAsync();
    setConfirmMode(null);
  };

  const commitStatusChange = async () => {
    if (!activityId || !confirmMode || saving) return;
    setSaving(true);
    try {
      if (confirmMode === "undo") {
        await unmarkComplete({ activityId, sessionId });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } else {
        await markComplete({ activityId, sessionId });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setConfirmMode(null);
    } catch (error) {
      console.warn("[where-am-i] completion change failed", error);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible={modalMounted}
      transparent
      animationType="none"
      supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        {/* Dark scrim: fades in/out, no touch events */}
        <Animated.View
          style={[styles.backdropFill, animatedBackdropStyle]}
          pointerEvents="none"
        />
        {/* Transparent tap-target for dismiss-on-backdrop-tap */}
        <Pressable style={styles.backdropTap} onPress={onClose} />
        {/* Sheet: slides up independently from the backdrop fade */}
        <Animated.View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, 16) },
            animatedSheetStyle,
          ]}
        >
          <View style={styles.grabber} />
          <View style={styles.header}>
            <View style={styles.emojiBadge}>
              <Text style={styles.emoji}>{progress.unit?.emoji ?? "🧭"}</Text>
            </View>
            <View style={styles.headerText}>
              <Text style={styles.eyebrow}>WHERE YOU ARE</Text>
              <Text style={styles.title} numberOfLines={2}>
                {screenTitle}
              </Text>
            </View>
            <Pressable onPress={onClose} hitSlop={10} style={styles.closeButton}>
              <SymbolView name="xmark" size={17} tintColor={colors.charcoalMuted} />
            </Pressable>
          </View>

          {!hasUnitMap ? (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <EmptyState
                emoji="🧭"
                title="This session is not in a unit yet"
                body="There is no unit map to show here. You can keep exploring with Rabbithole."
              />
              <CompletionCard
                canMarkActivity={canMarkActivity}
                completed={currentActivityCompleted}
                confirmMode={confirmMode}
                saving={saving}
                onRequestStatusChange={requestStatusChange}
                onCancel={cancelStatusChange}
                onCommit={commitStatusChange}
              />
            </ScrollView>
          ) : progress.loading ? (
            <View style={styles.loading}>
              <ActivityIndicator size="large" color={colors.violet} />
            </View>
          ) : progress.unit === null ? (
            <EmptyState
              emoji="🧭"
              title="Unit not found"
              body="This unit may have moved. Go back to Home and open the unit again."
            />
          ) : (
            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.progressCard}>
                <View style={styles.progressTop}>
                  <Text style={styles.progressLabel}>{progress.progressLabel}</Text>
                  {progress.activityTotal > 0 && (
                    <Text style={styles.progressPercent}>
                      {progress.progressPct}%
                    </Text>
                  )}
                </View>
                <View style={styles.progressTrack}>
                  <View
                    style={[
                      styles.progressFill,
                      { width: `${progress.progressPct}%` as `${number}%` },
                    ]}
                  />
                </View>
              </View>

              <View style={styles.currentCard}>
                <View style={styles.currentIcon}>
                  <SymbolView
                    name={
                      currentActivityCompleted
                        ? "checkmark.circle.fill"
                        : "location.circle.fill"
                    }
                    size={30}
                    tintColor={
                      currentActivityCompleted ? colors.green : colors.violet
                    }
                  />
                </View>
                <View style={styles.currentText}>
                  <Text style={styles.currentKicker}>
                    {[
                      progress.currentLesson?.title,
                      currentPositionLabel,
                    ].filter(Boolean).join(" · ") || "Current activity"}
                  </Text>
                  <Text style={styles.currentTitle} numberOfLines={2}>
                    {currentItem?.activity.title ?? "No activity selected"}
                  </Text>
                  {currentItem?.activity.description && (
                    <Text style={styles.currentBody} numberOfLines={2}>
                      {currentItem.activity.description}
                    </Text>
                  )}
                </View>
                <View
                  style={[
                    styles.statusPill,
                    currentActivityCompleted && styles.statusPillDone,
                  ]}
                >
                  <Text
                    style={[
                      styles.statusPillText,
                      currentActivityCompleted && styles.statusPillTextDone,
                    ]}
                  >
                    {currentActivityCompleted ? "Done" : "In progress"}
                  </Text>
                </View>
              </View>

              <CompletionCard
                canMarkActivity={canMarkActivity}
                completed={currentActivityCompleted}
                confirmMode={confirmMode}
                saving={saving}
                onRequestStatusChange={requestStatusChange}
                onCancel={cancelStatusChange}
                onCommit={commitStatusChange}
              />

              {progress.outline.length === 0 ? (
                <EmptyState
                  emoji="🚧"
                  title="No activities yet"
                  body="Your teacher has not added the activity ladder for this unit yet."
                />
              ) : (
                <View style={styles.outlineCard}>
                  {progress.outline.map((section, sectionIndex) => {
                    const lessonCompleted = section.activities.filter(
                      (item) => item.isCompleted,
                    ).length;
                    return (
                      <View
                        key={String(section.lesson._id)}
                        style={[
                          styles.lessonBlock,
                          sectionIndex > 0 && styles.lessonDivider,
                        ]}
                      >
                        <View style={styles.lessonHeader}>
                          <Text style={styles.lessonTitle} numberOfLines={1}>
                            {section.lesson.title}
                          </Text>
                          <View style={styles.lessonBadge}>
                            <Text style={styles.lessonBadgeText}>
                              {lessonCompleted}/{section.activities.length}
                            </Text>
                          </View>
                        </View>
                        {section.activities.map((item) => (
                          <ActivityProgressRow
                            key={String(item.activity._id)}
                            item={item}
                            onOpenWeb={openWebActivityRow}
                            onOpenGame={openGameActivityRow}
                          />
                        ))}
                      </View>
                    );
                  })}
                </View>
              )}
            </ScrollView>
          )}
        </Animated.View>
      </View>
    </Modal>
  );
}

function CompletionCard({
  canMarkActivity,
  completed,
  confirmMode,
  saving,
  onRequestStatusChange,
  onCancel,
  onCommit,
}: {
  canMarkActivity: boolean;
  completed: boolean;
  confirmMode: ConfirmMode;
  saving: boolean;
  onRequestStatusChange: (mode: Exclude<ConfirmMode, null>) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  if (!canMarkActivity) {
    return (
      <View style={styles.completionCard}>
        <Text style={styles.completionTitle}>No activity status here</Text>
        <Text style={styles.completionBody}>
          This session is not attached to a lesson activity, so there is nothing
          to mark done.
        </Text>
      </View>
    );
  }

  if (confirmMode) {
    const isUndo = confirmMode === "undo";
    return (
      <View style={[styles.completionCard, styles.confirmCard]}>
        <Text style={styles.completionTitle}>
          {isUndo ? "Mark this activity not done?" : "Mark this activity done?"}
        </Text>
        <Text style={styles.completionBody}>
          {isUndo
            ? "This will remove the done check from your unit progress."
            : "This will add a done check to your unit progress."}
        </Text>
        <View style={styles.confirmActions}>
          <Pressable
            onPress={onCancel}
            disabled={saving}
            style={({ pressed }) => [
              styles.secondaryButton,
              pressed && styles.buttonPressed,
            ]}
          >
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={onCommit}
            disabled={saving}
            style={({ pressed }) => [
              styles.primaryButton,
              isUndo && styles.undoButton,
              (pressed || saving) && styles.buttonPressed,
            ]}
          >
            {saving ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <Text style={styles.primaryButtonText}>
                {isUndo ? "Yes, undo done" : "Yes, mark done"}
              </Text>
            )}
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.completionCard}>
      <Text style={styles.completionTitle}>
        {completed ? "This activity is marked done" : "Ready to finish this activity?"}
      </Text>
      <Text style={styles.completionBody}>
        {completed
          ? "If that was a mistake, you can change it back below."
          : "Use this when you have actually finished the activity."}
      </Text>
      <Pressable
        onPress={() => onRequestStatusChange(completed ? "undo" : "complete")}
        style={({ pressed }) => [
          styles.primaryButton,
          completed && styles.secondaryStatusButton,
          pressed && styles.buttonPressed,
        ]}
      >
        <Text
          style={[
            styles.primaryButtonText,
            completed && styles.secondaryStatusButtonText,
          ]}
        >
          {completed ? "Change to not done" : "Mark activity done"}
        </Text>
      </Pressable>
    </View>
  );
}

function ActivityProgressRow({
  item,
  onOpenWeb,
  onOpenGame,
}: {
  item: UnitProgressActivityItem;
  onOpenWeb: (activity: UnitProgressActivity) => void;
  onOpenGame: (activity: UnitProgressActivity) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const ROW_META = useMemo(() => rowMeta(colors), [colors]);
  const meta = item.isCompleted && !item.isCurrent ? ROW_META.done : ROW_META[item.state];
  const label = item.isCurrent
    ? item.isCompleted
      ? "Current · Done"
      : "Current"
    : meta.label;
  const detail = [
    kindLabel(item.activity.kind),
    item.activity.durationMinutes ? `${item.activity.durationMinutes} min` : null,
  ].filter(Boolean) as string[];

  const isWeb = item.activity.kind === "web";
  const isGame = item.activity.kind === "game";
  const openable = isWeb || isGame;

  return (
    <Pressable
      onPress={
        isWeb
          ? () => onOpenWeb(item.activity)
          : isGame
            ? () => onOpenGame(item.activity)
            : undefined
      }
      disabled={!openable}
      accessibilityRole={openable ? "button" : undefined}
      accessibilityLabel={openable ? `Open ${item.activity.title}` : undefined}
      style={({ pressed }) => [
        styles.activityRow,
        { backgroundColor: meta.background, borderColor: meta.border },
        item.isCurrent && styles.currentRow,
        pressed && openable && styles.buttonPressed,
      ]}
    >
      <View style={styles.stateIconWrap}>
        <SymbolView
          name={item.isCompleted && !item.isCurrent ? "checkmark.circle.fill" : meta.icon}
          size={21}
          tintColor={item.isCompleted && !item.isCurrent ? colors.green : meta.tint}
        />
      </View>
      <View style={styles.activityText}>
        <View style={styles.activityTitleRow}>
          <Text
            style={[
              styles.activityTitle,
              item.isCompleted && !item.isCurrent && styles.doneTitle,
            ]}
            numberOfLines={2}
          >
            {item.activity.title}
          </Text>
          <Text
            style={[
              styles.activityStateLabel,
              { color: item.isCompleted && item.isCurrent ? colors.green : meta.tint },
            ]}
          >
            {label}
          </Text>
        </View>
        {detail.length > 0 && (
          <Text style={styles.activityMeta}>{detail.join(" · ")}</Text>
        )}
      </View>
      {isWeb ? <Text style={styles.webOpen}>Open ›</Text> : null}
    </Pressable>
  );
}

function EmptyState({
  emoji,
  title,
  body,
}: {
  emoji: string;
  title: string;
  body: string;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <View style={styles.emptyCard}>
      <Text style={styles.emptyEmoji}>{emoji}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "transparent",
  },
  backdropFill: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "rgba(0,0,0,0.42)",
  },
  backdropTap: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
  sheet: {
    alignSelf: "center",
    width: "100%",
    maxWidth: 820,
    maxHeight: "88%",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: c.bgSubtle,
    paddingTop: 10,
    paddingHorizontal: 18,
    shadowColor: "#000",
    shadowOpacity: 0.24,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: -10 },
  },
  grabber: {
    alignSelf: "center",
    width: 44,
    height: 5,
    borderRadius: 999,
    backgroundColor: c.gray300,
    marginBottom: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 6,
    paddingBottom: 12,
  },
  emojiBadge: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: c.violetSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  emoji: { fontSize: 24 },
  headerText: { flex: 1, minWidth: 0 },
  eyebrow: {
    fontSize: 12,
    letterSpacing: 1.1,
    fontFamily: fonts.bold,
    color: c.violet,
    marginBottom: 3,
  },
  title: {
    fontSize: 24,
    lineHeight: 30,
    fontFamily: fonts.bold,
    color: c.navy,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.gray100,
  },
  loading: {
    minHeight: 280,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { flexShrink: 1 },
  scrollContent: {
    paddingTop: 4,
    paddingBottom: 10,
    gap: 14,
  },
  progressCard: {
    backgroundColor: c.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
  },
  progressTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 8,
  },
  progressLabel: {
    fontSize: 15,
    fontFamily: fonts.semibold,
    color: c.charcoal,
  },
  progressPercent: {
    fontSize: 13,
    fontFamily: fonts.semibold,
    color: c.fgMuted,
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    overflow: "hidden",
    backgroundColor: c.gray200,
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: c.violet,
  },
  currentCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 13,
    backgroundColor: c.white,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: palette.violet[200],
    padding: 16,
  },
  currentIcon: {
    width: 38,
    alignItems: "center",
    paddingTop: 2,
  },
  currentText: { flex: 1, minWidth: 0, gap: 4 },
  currentKicker: {
    fontSize: 12.5,
    fontFamily: fonts.bold,
    color: c.violet,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  currentTitle: {
    fontSize: 19,
    lineHeight: 24,
    fontFamily: fonts.bold,
    color: c.navy,
  },
  currentBody: {
    fontSize: 14,
    lineHeight: 19,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
  },
  statusPill: {
    borderRadius: 999,
    backgroundColor: c.violetSubtle,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusPillDone: {
    backgroundColor: palette.green[50],
  },
  statusPillText: {
    fontSize: 12,
    fontFamily: fonts.bold,
    color: c.violet,
  },
  statusPillTextDone: {
    color: c.green,
  },
  completionCard: {
    gap: 10,
    backgroundColor: c.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    padding: 16,
  },
  confirmCard: {
    borderColor: palette.orange[200],
    backgroundColor: palette.orange[50],
  },
  completionTitle: {
    fontSize: 17,
    fontFamily: fonts.bold,
    color: c.navy,
  },
  completionBody: {
    fontSize: 14,
    lineHeight: 19,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
  },
  confirmActions: {
    flexDirection: "row",
    gap: 10,
  },
  primaryButton: {
    minHeight: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.violet,
    paddingHorizontal: 16,
    alignSelf: "flex-start",
  },
  undoButton: {
    backgroundColor: c.orange,
  },
  primaryButtonText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    color: c.white,
  },
  secondaryButton: {
    minHeight: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.white,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: 16,
  },
  secondaryButtonText: {
    fontSize: 15,
    fontFamily: fonts.bold,
    color: c.charcoal,
  },
  secondaryStatusButton: {
    backgroundColor: c.white,
    borderWidth: 1,
    borderColor: c.border,
  },
  secondaryStatusButtonText: {
    color: c.charcoal,
  },
  buttonPressed: {
    opacity: 0.72,
  },
  webOpen: {
    marginLeft: 11,
    alignSelf: "center",
    fontSize: 14,
    fontFamily: fonts.semibold,
    color: c.violet,
  },
  outlineCard: {
    backgroundColor: c.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
  },
  lessonBlock: {
    padding: 13,
    gap: 8,
  },
  lessonDivider: {
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  lessonHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingHorizontal: 3,
  },
  lessonTitle: {
    flex: 1,
    fontSize: 15,
    fontFamily: fonts.bold,
    color: c.navy,
  },
  lessonBadge: {
    borderRadius: 999,
    backgroundColor: c.gray100,
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  lessonBadgeText: {
    fontSize: 12,
    fontFamily: fonts.semibold,
    color: c.charcoalMuted,
  },
  activityRow: {
    flexDirection: "row",
    gap: 11,
    borderRadius: 15,
    borderWidth: 1,
    paddingVertical: 11,
    paddingHorizontal: 11,
  },
  currentRow: {
    shadowColor: c.violet,
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  stateIconWrap: {
    width: 24,
    alignItems: "center",
    paddingTop: 1,
  },
  activityText: { flex: 1, minWidth: 0, gap: 3 },
  activityTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  activityTitle: {
    flex: 1,
    fontSize: 15.5,
    lineHeight: 20,
    fontFamily: fonts.semibold,
    color: c.charcoal,
  },
  doneTitle: {
    color: c.charcoalMuted,
  },
  activityStateLabel: {
    fontSize: 11.5,
    fontFamily: fonts.bold,
    textTransform: "uppercase",
    letterSpacing: 0.55,
    marginTop: 2,
  },
  activityMeta: {
    fontSize: 12.5,
    fontFamily: fonts.medium,
    color: c.charcoalMuted,
  },
  emptyCard: {
    alignItems: "center",
    backgroundColor: c.white,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 28,
    paddingHorizontal: 20,
    gap: 8,
  },
  emptyEmoji: { fontSize: 30 },
  emptyTitle: {
    fontSize: 18,
    fontFamily: fonts.bold,
    color: c.navy,
    textAlign: "center",
  },
  emptyBody: {
    maxWidth: 420,
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
    textAlign: "center",
  },
});
}

export default WhereAmIPanel;
