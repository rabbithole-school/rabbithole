import { useRef, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import Reanimated, {
  type SharedValue,
  useAnimatedStyle,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import {
  TEACHER_ARCHIVE_COPY,
  isTeacherArchived,
} from "../../vendor/shared/teacherArchive";
import { serverErrorMessage } from "../../vendor/shared/serverErrorMessage";
import { HOME_ARCHIVE_COPY } from "../../vendor/shared/homeArchive";

const COLUMN_MAX_WIDTH = 720;

type ArchivedRow = {
  id: string;
  title: string;
  unitTitle: string | null;
  unitEmoji: string | null;
  messageCount: number;
  lastMessageAt?: number;
  updatedAt: number;
  // "archived": the scholar explicitly archived it (Unarchive applies).
  // "completed": finished class-focus work the plate has dropped — it was never
  // archived, so there is nothing to unarchive, only "keep working on this".
  finishedKind: "archived" | "completed";
  // The activity is done (always for "completed"). Finished work is
  // re-entered with "Keep working on this", never unarchived: the plate drops
  // a completed session, so Unarchive would make it vanish.
  isComplete: boolean;
  // Archived by a teacher (review/teacher-archive-scholar-apps.html): shown
  // labelled, with no Unarchive and no open — a tap only explains.
  teacherArchivedAt?: number;
};

function timeAgo(ts: number): string {
  const d = Math.max(0, Date.now() - ts);
  const day = 86_400_000;
  if (d < day) return "today";
  if (d < 2 * day) return "yesterday";
  if (d < 7 * day) return `${Math.floor(d / day)} days ago`;
  if (d < 30 * day) return `${Math.floor(d / (7 * day))} weeks ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * One Home tab's Archived list — the Archived value of Home's Active / Archived
 * filter (review/home-finished-filter.html). The caller hands in the rows this
 * tab lists (filterArchivedRowsForTab). Two kinds of work live here, both
 * re-openable by tap:
 *   - ARCHIVED sessions (the scholar archived them): muted cards, swipe-left or
 *     long-press → Unarchive (api.sessions.unarchive), which puts the work back
 *     on Home without opening it.
 *   - COMPLETED class-focus work the plate has dropped (a finished writing doc,
 *     a completed card-sort): completion lives outside the session, so once the
 *     unit has no next activity the plate drops the row and it would otherwise
 *     be unreachable. These were never archived — no Unarchive, labelled
 *     HOME_ARCHIVE_COPY.completedLabel.
 *
 * Tap any card (or the long-press sheet's "Keep working on this") →
 * api.sessions.reopen re-opens the session (un-archives if needed, stamps
 * reopenedAt) and drops the scholar back in, editable — WITHOUT regressing
 * completion (the badge/unit stay complete; the artifact comes along). Parity
 * with web (sessions.finishedForScholar).
 *
 * A session a TEACHER archived is the exception: it stays listed, labelled
 * TEACHER_ARCHIVE_COPY.scholarLabel, with no Unarchive and no long-press menu,
 * and a tap shows scholarExplain instead of opening it — only a teacher can
 * bring it back.
 */
export function ArchivedSessions({
  rows,
  refreshing = false,
  onRefresh,
}: {
  rows: ArchivedRow[];
  refreshing?: boolean;
  /** Omit on a pager page that isn't showing, so only the visible page owns a
   *  pull-to-refresh (the same rule the Active lists follow). */
  onRefresh?: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <FlatList
      data={rows}
      keyExtractor={(r) => r.id}
      contentContainerStyle={[styles.list, rows.length === 0 && styles.emptyList]}
      alwaysBounceVertical
      refreshControl={
        onRefresh ? (
          <RefreshControl
            accessibilityLabel="Refresh Home"
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.violet}
          />
        ) : undefined
      }
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <SymbolView name="archivebox" size={42} tintColor={colors.gray300} />
          <Text style={styles.emptyText}>{HOME_ARCHIVE_COPY.emptyForTab}</Text>
        </View>
      }
      renderItem={({ item }) => <ArchivedCard row={item} />}
    />
  );
}

function ArchivedCard({ row }: { row: ArchivedRow }) {
  const router = useRouter();
  const unarchive = useMutation(api.sessions.unarchive);
  const reopen = useMutation(api.sessions.reopen);
  const [reopening, setReopening] = useState(false);
  const ref = useRef<SwipeableMethods>(null);
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const teacherArchived = isTeacherArchived(row);
  const [explaining, setExplaining] = useState(false);

  // Only unfinished work the scholar archived themselves can be unarchived:
  // finished work is re-entered with Keep working, and a teacher-archived app
  // is the teacher's to lift.
  const complete = !teacherArchived && row.isComplete;
  const canUnarchive =
    row.finishedKind === "archived" && !teacherArchived && !complete;

  const unarchiveNow = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    ref.current?.close();
    // A stale list can still hold a row a teacher has since archived; the
    // server refuses, and the refusal is the message to show.
    unarchive({ id: row.id as Id<"sessions"> }).catch((err: unknown) => {
      Alert.alert(serverErrorMessage(err, HOME_ARCHIVE_COPY.unarchiveFailed));
    });
  };

  // "Keep working on this" — un-archive (reopen) then open the session,
  // editable. Completion state is never touched (sessions.reopen only flips
  // isArchived), so the unit stays complete and the artifact comes along.
  const keepWorking = async () => {
    if (reopening) return;
    setReopening(true);
    try {
      await reopen({ id: row.id as Id<"sessions"> });
      router.push({
        pathname: "/session/[id]",
        params: { id: row.id, title: row.title },
      });
    } catch (err) {
      console.error("Failed to re-open session:", err);
      setReopening(false);
      Alert.alert(serverErrorMessage(err, "Couldn't open that"));
    }
  };

  const onPress = () => {
    if (teacherArchived) {
      Haptics.selectionAsync();
      setExplaining((v) => !v);
      return;
    }
    void keepWorking();
  };

  // Long-press: the same choices as the tap and the swipe, named. A
  // teacher-archived card has nothing to offer, so it gets no menu.
  const showMenu = () => {
    if (teacherArchived) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const options = canUnarchive
      ? ["Cancel", HOME_ARCHIVE_COPY.unarchiveAction, HOME_ARCHIVE_COPY.keepWorkingAction]
      : ["Cancel", HOME_ARCHIVE_COPY.keepWorkingAction];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: row.title, options, cancelButtonIndex: 0 },
      (i) => {
        if (options[i] === HOME_ARCHIVE_COPY.unarchiveAction) unarchiveNow();
        if (options[i] === HOME_ARCHIVE_COPY.keepWorkingAction) void keepWorking();
      },
    );
  };
  const accessibilityActions = teacherArchived
    ? undefined
    : [
        ...(canUnarchive
          ? [{ name: "unarchive", label: HOME_ARCHIVE_COPY.unarchiveAction }]
          : []),
        { name: "keepWorking", label: HOME_ARCHIVE_COPY.keepWorkingAction },
      ];

  const renderRightActions = (
    _prog: SharedValue<number>,
    drag: SharedValue<number>,
  ) => <UnarchiveAction drag={drag} onPress={unarchiveNow} />;

  const when = row.lastMessageAt ?? row.updatedAt;
  // Every card here is archived, so only the exceptions are labelled:
  // completed work, and an app a teacher archived.
  const statusLabel = teacherArchived
    ? TEACHER_ARCHIVE_COPY.scholarLabel
    : complete
      ? HOME_ARCHIVE_COPY.completedLabel
      : null;
  const meta = [row.unitTitle, statusLabel, timeAgo(when)]
    .filter(Boolean)
    .join(" · ");

  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      // Only work the scholar archived can be unarchived — completed class-focus
      // work was never archived (just keep working), and a teacher-archived
      // session has no Unarchive at all: only a teacher can lift it.
      renderRightActions={canUnarchive ? renderRightActions : undefined}
    >
      <Pressable
        onPress={onPress}
        onLongPress={teacherArchived ? undefined : showMenu}
        disabled={reopening}
        accessibilityRole="button"
        accessibilityLabel={row.title}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === "unarchive") unarchiveNow();
          if (e.nativeEvent.actionName === "keepWorking") void keepWorking();
        }}
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      >
        <View style={styles.cardLeft}>
          <View style={styles.titleRow}>
            <Text style={styles.emoji}>{row.unitEmoji ?? "📝"}</Text>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {row.title}
            </Text>
          </View>
          <Text style={styles.cardMeta} numberOfLines={1}>
            {meta}
          </Text>
          {teacherArchived ? (
            explaining ? (
              <Text style={styles.explainText}>
                {TEACHER_ARCHIVE_COPY.scholarExplain}
              </Text>
            ) : null
          ) : (
            <View style={styles.keepRow}>
              {reopening ? (
                <ActivityIndicator size="small" color={colors.violet} />
              ) : (
                <SymbolView
                  name="arrow.clockwise"
                  size={13}
                  tintColor={colors.violet}
                />
              )}
              <Text style={styles.keepText}>
                {/* Web parity: work you archived reads "Keep working on
                    this"; completed work keeps "Review" (it reads as done). */}
                {reopening
                  ? "Opening…"
                  : canUnarchive
                    ? HOME_ARCHIVE_COPY.keepWorkingAction
                    : "Review"}
              </Text>
            </View>
          )}
        </View>
        {teacherArchived ? null : (
          <SymbolView name="chevron.right" size={15} tintColor={colors.gray300} />
        )}
      </Pressable>
    </ReanimatedSwipeable>
  );
}

const ACTION_W = 96;

function UnarchiveAction({
  drag,
  onPress,
}: {
  drag: SharedValue<number>;
  onPress: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: drag.get() + ACTION_W }],
  }));
  return (
    <Reanimated.View style={[styles.actionWrap, style]}>
      <Pressable onPress={onPress} style={styles.action}>
        <SymbolView name="arrow.uturn.backward" size={20} tintColor={colors.white} />
        <Text style={styles.actionText}>{HOME_ARCHIVE_COPY.unarchiveAction}</Text>
      </Pressable>
    </Reanimated.View>
  );
}

export { ArchivedSessions as default };

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  list: {
    width: "100%",
    maxWidth: COLUMN_MAX_WIDTH,
    alignSelf: "center",
    paddingHorizontal: 24,
    paddingVertical: 20,
  },
  emptyList: {
    flexGrow: 1,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingHorizontal: 48,
    paddingBottom: 80,
  },
  emptyText: {
    textAlign: "center",
    color: c.fgMuted,
    fontSize: 16,
    lineHeight: 23,
    fontFamily: fonts.regular,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: c.bg,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: 18,
    paddingHorizontal: 20,
    opacity: 0.7,
  },
  cardPressed: { backgroundColor: c.gray50 },
  cardLeft: { flex: 1, minWidth: 0, gap: 7 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  emoji: { fontSize: 24 },
  cardTitle: { flex: 1, fontSize: 18, fontFamily: fonts.semibold, color: c.navy },
  cardMeta: { fontSize: 13.5, fontFamily: fonts.regular, color: c.charcoalSubtle },
  keepRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 2 },
  keepText: { fontSize: 13.5, fontFamily: fonts.semibold, color: c.violet },
  explainText: {
    fontSize: 14,
    lineHeight: 20,
    fontFamily: fonts.regular,
    color: c.fgMuted,
    marginTop: 2,
  },
  actionWrap: { width: ACTION_W },
  action: {
    flex: 1,
    backgroundColor: c.green,
    borderRadius: 16,
    marginLeft: 10,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  actionText: { color: c.white, fontSize: 13, fontFamily: fonts.semibold },
  });
}
