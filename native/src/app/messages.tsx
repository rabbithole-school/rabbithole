import { useMemo } from "react";
import { useQuery } from "convex/react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { usePreventRemove } from "expo-router/react-navigation";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";

import { ThreadList } from "@/components/messages/ThreadList";
import { ThreadView } from "@/components/messages/ThreadView";
import { api, type Id } from "@/lib/convex";
import { kindFilterFrom, type KindFilter } from "@/lib/scholarMessages";
import { fonts, useColors, type Colors } from "@/theme";

// Two panes (list | thread) once there's room for both — the iPad in
// landscape. Below it (portrait split-screen, a narrow window) the list and
// the thread are separate stack screens, so the system back chevron works.
const TWO_PANE_MIN_WIDTH = 900;

/**
 * Messages (S2/S3 in the scholar ↔ staff messaging proposal): the scholar's
 * mentor threads, then their Workshop threads, and the open conversation.
 * Reached from the account menu's Messages item and from a Workshop card.
 *
 *   native:///messages              — the list (landscape: empty right pane)
 *   native:///messages?thread=<id>  — that conversation open
 *   …&kind=workshop|mentor          — the list filtered (the Workshop's way
 *                                     in; the toggle shows only when both
 *                                     kinds exist)
 *
 * A scholar never starts a thread here: an adult opens every mentor thread and
 * ideas are filed from the Workshop, so there is deliberately no "New message".
 */
export default function MessagesScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const twoPane = width >= TWO_PANE_MIN_WIDTH;
  const { thread, kind } = useLocalSearchParams<{ thread?: string; kind?: string }>();
  const kindFilter = kindFilterFrom(kind);
  const selectedId = thread ? (thread as Id<"parentThreads">) : null;
  const list = useQuery(api.scholarMessages.listThreads, {});

  // Selecting a thread is a param change on THIS screen in both layouts
  // (never a pushed screen), so the layout can change under it on rotation.
  const select = (threadId: Id<"parentThreads">) =>
    router.setParams({ thread: threadId });
  // Back navigation in the narrow layout: from a conversation, back returns
  // to the list (clears ?thread) instead of leaving Messages; from the list,
  // back leaves Messages as usual. usePreventRemove intercepts both the
  // header chevron and the edge-swipe on the native stack (preventNativeDismiss).
  // In two panes the list is already on screen, so back leaves normally.
  usePreventRemove(!twoPane && selectedId !== null, () =>
    router.setParams({ thread: undefined }),
  );
  const setKindFilter = (next: KindFilter) =>
    router.setParams({ kind: next === "all" ? undefined : next });

  const listPane =
    list === undefined ? (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.violet} />
      </View>
    ) : list.threads.length === 0 ? (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>No messages yet.</Text>
      </View>
    ) : (
      <ThreadList
        threads={list.threads}
        selectedId={selectedId}
        onSelect={select}
        kindFilter={kindFilter}
        onKindFilterChange={setKindFilter}
      />
    );

  // ONE stable tree for both layouts: the list column and the thread column
  // are always mounted in the same places, and the layout only restyles them
  // (display: none for the pane a narrow window can't fit). Rotating across
  // the breakpoint therefore never remounts ThreadView, so a half-typed reply
  // and staged photos survive it. ThreadView owns its keyboard inset
  // (useKeyboardInset), identically in both layouts.
  const showList = twoPane || !selectedId;
  const showThread = twoPane || !!selectedId;
  return (
    <>
      <Stack.Screen options={{ title: "Messages" }} />
      <View style={twoPane ? styles.split : styles.flex}>
        <View
          style={
            !showList ? styles.hidden : twoPane ? styles.listColumn : styles.flex
          }
        >
          {listPane}
        </View>
        <View style={showThread ? styles.threadColumn : styles.hidden}>
          {selectedId ? (
            <ThreadView key={selectedId} threadId={selectedId} />
          ) : (
            <View style={styles.centered}>
              <Text style={styles.emptyText}>Pick a conversation to read it.</Text>
            </View>
          )}
        </View>
      </View>
    </>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1, backgroundColor: c.bgSubtle },
    split: { flex: 1, flexDirection: "row", backgroundColor: c.bgSubtle },
    listColumn: {
      width: 360,
      borderRightWidth: 1,
      borderRightColor: c.border,
    },
    threadColumn: { flex: 1 },
    hidden: { display: "none" },
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      backgroundColor: c.bgSubtle,
    },
    emptyText: {
      fontSize: 15,
      lineHeight: 22,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      textAlign: "center",
    },
  });
}
