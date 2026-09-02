import { useRef, useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { useRouter } from "expo-router";
import {
  ActivityIndicator,
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

const COLUMN_MAX_WIDTH = 720;

type ArchivedRow = {
  id: string;
  title: string;
  unitTitle: string | null;
  unitEmoji: string | null;
  messageCount: number;
  lastMessageAt?: number;
  updatedAt: number;
  // "archived": the scholar explicitly archived it (swipe-to-restore applies).
  // "completed": finished class-focus work the plate has dropped — it was never
  // archived, so there's nothing to restore, only "keep working on this".
  finishedKind: "archived" | "completed";
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
 * Finished sessions list — the "Finished" view of Home (reached via the title
 * pull-down). Two kinds of finished work live here, both re-openable by tap:
 *   - ARCHIVED sessions (the scholar tucked them away): muted cards, swipe-left
 *     → Restore (the iOS Mail/Reminders gesture; api.sessions.unarchive).
 *   - COMPLETED class-focus work the plate has dropped (a finished writing doc,
 *     a completed card-sort): completion lives outside the session, so once the
 *     unit has no next activity the plate drops the row and it would otherwise
 *     be unreachable. These were never archived — no Restore swipe.
 *
 * Tap any card → "Keep working on this": api.sessions.reopen re-opens the
 * finished session (un-archives if needed, stamps reopenedAt) and drops the
 * scholar back in, editable — WITHOUT regressing completion (the badge/unit
 * stay complete; the artifact comes along). Parity with the web Finished
 * treatment (sessions.finishedForScholar).
 */
export function ArchivedSessions({
  rows,
  refreshing,
  onRefresh,
}: {
  rows: ArchivedRow[];
  refreshing: boolean;
  onRefresh: () => void;
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
        <RefreshControl
          accessibilityLabel="Refresh Home"
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.violet}
        />
      }
      ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <SymbolView name="archivebox" size={42} tintColor={colors.gray300} />
          <Text style={styles.emptyText}>
            Nothing finished yet. Work you finish or archive shows up here — tap
            one to keep working on it.
          </Text>
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

  const restore = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    ref.current?.close();
    unarchive({ id: row.id as Id<"sessions"> });
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
    }
  };

  const renderRightActions = (
    _prog: SharedValue<number>,
    drag: SharedValue<number>,
  ) => <RestoreAction drag={drag} onPress={restore} />;

  const when = row.lastMessageAt ?? row.updatedAt;
  const statusLabel = row.finishedKind === "archived" ? "archived" : "finished";

  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={40}
      overshootRight={false}
      // Only archived sessions can be "restored" — completed class-focus work
      // was never archived, so there's nothing to restore (just keep working).
      renderRightActions={
        row.finishedKind === "archived" ? renderRightActions : undefined
      }
    >
      <Pressable
        onPress={keepWorking}
        disabled={reopening}
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
            {(row.unitTitle ? row.unitTitle + " · " : "") + statusLabel + " · " + timeAgo(when)}
          </Text>
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
              {reopening ? "Opening…" : "Review"}
            </Text>
          </View>
        </View>
        <SymbolView name="chevron.right" size={15} tintColor={colors.gray300} />
      </Pressable>
    </ReanimatedSwipeable>
  );
}

const ACTION_W = 96;

function RestoreAction({
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
        <Text style={styles.actionText}>Restore</Text>
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
