import { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { SymbolView } from "expo-symbols";

import { ScholarAvatar } from "@/components/ScholarAvatar";
import type { Id } from "@/lib/convex";
import {
  type KindFilter,
  MENTORS_EYEBROW,
  WORKSHOP_EYEBROW,
  previewLine,
  splitThreadSections,
  threadHeadline,
  type ScholarThreadSummary,
} from "@/lib/scholarMessages";
import { resolveUserImageUri } from "@/lib/webEmbedConfig";
import { fonts, useColors, type Colors } from "@/theme";

/**
 * The scholar's conversation list (S2): mentor threads first — they're about
 * the kid's own work — then Workshop threads. No "+ New message": an adult
 * opens every mentor thread, and new ideas are still filed from the Workshop.
 * Web twin: the scholar MessageWorkspace list.
 */
export function ThreadList({
  threads,
  selectedId,
  onSelect,
  kindFilter,
  onKindFilterChange,
}: {
  threads: readonly ScholarThreadSummary[];
  selectedId: Id<"parentThreads"> | null;
  onSelect: (threadId: Id<"parentThreads">) => void;
  kindFilter: KindFilter;
  onKindFilterChange: (kind: KindFilter) => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const { mentors, workshop } = splitThreadSections(threads);
  // The filter only earns its place when there are two kinds to tell apart.
  const showFilter = mentors.length > 0 && workshop.length > 0;
  const showMentors = kindFilter !== "workshop" || !showFilter;
  const showWorkshop = kindFilter !== "mentor" || !showFilter;

  const section = (label: string, rows: ScholarThreadSummary[]) =>
    rows.length === 0 ? null : (
      <View style={styles.section}>
        <Text style={styles.eyebrow}>{label}</Text>
        {rows.map((thread) => (
          <ThreadRow
            key={thread._id}
            thread={thread}
            selected={thread._id === selectedId}
            onPress={() => onSelect(thread._id)}
            colors={colors}
            styles={styles}
          />
        ))}
      </View>
    );

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={styles.scroll}
      contentContainerStyle={styles.content}
    >
      {showFilter ? (
        <View style={styles.filter} accessibilityRole="tablist">
          {FILTERS.map(({ value, label }) => {
            const active = kindFilter === value;
            return (
              <Pressable
                key={value}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => onKindFilterChange(value)}
                style={[styles.filterItem, active && styles.filterItemActive]}
              >
                <Text style={[styles.filterText, active && styles.filterTextActive]}>
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {showMentors ? section(MENTORS_EYEBROW, mentors) : null}
      {showWorkshop ? section(WORKSHOP_EYEBROW, workshop) : null}
    </ScrollView>
  );
}

const FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "mentor", label: MENTORS_EYEBROW },
  { value: "workshop", label: WORKSHOP_EYEBROW },
];

function ThreadRow({
  thread,
  selected,
  onPress,
  colors,
  styles,
}: {
  thread: ScholarThreadSummary;
  selected: boolean;
  onPress: () => void;
  colors: Colors;
  styles: ReturnType<typeof makeStyles>;
}) {
  const headline = threadHeadline(thread);
  // Web parity (MessageWorkspace threadPreview).
  const preview =
    previewLine(thread.lastMessageAuthorName, thread.lastMessagePreview) ||
    "No messages yet";
  const mentor = thread.kind === "mentor";
  const avatarPerson = mentor ? thread.staffParticipants[0] : undefined;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${headline}${thread.unread ? ", new message" : ""}`}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        selected && styles.rowSelected,
        pressed && !selected && styles.rowPressed,
      ]}
    >
      {mentor ? (
        <ScholarAvatar
          name={avatarPerson?.name ?? thread.title}
          image={resolveUserImageUri(avatarPerson?.image)}
          size={38}
        />
      ) : (
        <View
          style={styles.workshopTile}
          accessible
          accessibilityLabel="Workshop"
        >
          <SymbolView
            name="wrench.and.screwdriver.fill"
            size={18}
            tintColor={colors.orange}
          />
        </View>
      )}
      <View style={styles.rowText}>
        <Text
          style={[styles.headline, thread.unread && styles.headlineUnread]}
          numberOfLines={1}
        >
          {headline}
        </Text>
        <Text style={styles.preview} numberOfLines={1}>
          {preview}
        </Text>
      </View>
      {thread.unread ? <View style={styles.unreadDot} /> : null}
    </Pressable>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    scroll: { flex: 1, backgroundColor: c.bgSubtle },
    content: { paddingHorizontal: 16, paddingTop: 6, paddingBottom: 24 },
    section: { marginBottom: 8 },
    // All · Mentors · Workshop — a compact segmented pill row.
    filter: {
      flexDirection: "row",
      alignSelf: "flex-start",
      gap: 4,
      padding: 3,
      marginTop: 8,
      marginLeft: 4,
      borderRadius: 999,
      backgroundColor: c.gray100,
    },
    filterItem: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
    filterItemActive: { backgroundColor: c.bg },
    filterText: { fontSize: 13.5, fontFamily: fonts.semibold, color: c.charcoalMuted },
    filterTextActive: { color: c.navy },
    // Same eyebrow treatment as the Workshop board's zones (app/meta.tsx).
    eyebrow: {
      color: c.charcoalSubtle,
      fontSize: 12.5,
      letterSpacing: 1.2,
      fontFamily: fonts.bold,
      textTransform: "uppercase",
      marginTop: 18,
      marginBottom: 8,
      marginLeft: 4,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 12,
      paddingVertical: 11,
      borderRadius: 14,
    },
    rowSelected: { backgroundColor: c.violetSubtle },
    rowPressed: { backgroundColor: c.gray100 },
    rowText: { flex: 1, minWidth: 0 },
    headline: { fontSize: 16, fontFamily: fonts.semibold, color: c.navy },
    headlineUnread: { fontFamily: fonts.bold },
    preview: {
      fontSize: 14,
      lineHeight: 20,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      marginTop: 1,
    },
    // Workshop threads (ideas, bug reports, team-started topics) share the
    // Workshop's own glyph — never an "idea" label on a thread that isn't one.
    workshopTile: {
      width: 38,
      height: 38,
      borderRadius: 10,
      backgroundColor: c.orangeSubtle,
      borderWidth: 1,
      borderColor: c.orangeMuted,
      alignItems: "center",
      justifyContent: "center",
    },
    unreadDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: c.violet,
      flexShrink: 0,
    },
  });
}
