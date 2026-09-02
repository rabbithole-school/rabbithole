/**
 * Read-only view of an "offline session" — a session with isOffline: true that
 * holds a scholar's scanned deliverable(s) for an offline activity (see
 * convex/portfolioMaterialize.ts). There's no tutor chat here; we render the
 * scans + their grade verdict instead of the live chat composer.
 *
 * Data source: api.portfolio.offlineSessionView (same query as the web
 * OfflineSessionView in components/OfflineSessionView.tsx).
 */

import { useQuery } from "convex/react";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { api, type Id } from "@/lib/convex";
import { colors, fonts } from "@/theme";
import {
  offlineHomeworkContext,
  offlineHomeworkDueText,
} from "../../vendor/shared/offlineHomework";
import { ResourceShareCard } from "@/components/ResourceShareCard";

type Item = {
  deliverableId: Id<"deliverables">;
  title: string;
  caption: string | null;
  thumbUrl: string | null;
  fileUrl: string | null;
  magicUrl: string | null;
  overall: string | null;
  rubricPassed: boolean | null;
  checkedAt: number | null;
  teacherFeedback: string | null;
};

/**
 * Scholar-facing "Checked by your teacher" state (Phase 2 — deliverable-kinds
 * §6). This is the kid's iPad, so we deliberately show a warm "your teacher
 * looked at this" cue rather than the comparative Passed/Partial/Not-yet
 * verdict (no scores at kids).
 */
function isChecked(item: Item): boolean {
  return item.checkedAt != null || item.overall != null;
}

function ScanCard({ item }: { item: Item }) {
  const checked = isChecked(item);
  const openFile = () => {
    const url = item.magicUrl ?? item.fileUrl;
    if (url) Linking.openURL(url);
  };

  return (
    <View style={styles.card}>
      {/* Thumbnail / placeholder */}
      <Pressable
        onPress={item.fileUrl || item.magicUrl ? openFile : undefined}
        style={styles.thumb}
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.title}`}
      >
        {item.thumbUrl ? (
          <Image
            source={{ uri: item.thumbUrl }}
            style={styles.thumbImg}
            contentFit="cover"
            alt=""
            aria-hidden
          />
        ) : (
          <View style={styles.thumbPlaceholder}>
            <SymbolView
              name="doc.text.fill"
              size={36}
              tintColor={colors.violet}
            />
          </View>
        )}
        {(item.fileUrl || item.magicUrl) && (
          <View style={styles.openBadge}>
            <SymbolView
              name="arrow.up.right.square"
              size={14}
              tintColor={colors.charcoalMuted}
            />
          </View>
        )}
      </Pressable>

      {/* Metadata */}
      <View style={styles.cardMeta}>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {checked && (
            <View style={styles.checkedChip}>
              <SymbolView
                name="checkmark.seal.fill"
                size={13}
                tintColor={colors.green}
              />
              <Text style={styles.checkedText}>Checked by your teacher</Text>
            </View>
          )}
        </View>
        {item.caption ? (
          <Text style={styles.caption} numberOfLines={3}>
            {item.caption}
          </Text>
        ) : null}
        {item.teacherFeedback ? (
          <Text style={styles.feedback} numberOfLines={4}>
            {item.teacherFeedback}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

export function OfflineSessionView({
  sessionId,
}: {
  sessionId: Id<"sessions">;
}) {
  const data = useQuery(api.portfolio.offlineSessionView, { sessionId });

  if (data === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.violet} />
      </View>
    );
  }

  if (data === null) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>This session is no longer available.</Text>
      </View>
    );
  }

  const context = offlineHomeworkContext(data);
  const dueText = offlineHomeworkDueText(data.dueAt, data.timeZone);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.readingColumn}>
        {context ? <Text style={styles.context}>{context}</Text> : null}
        {data.isHomework ? <Text style={styles.due}>{dueText}</Text> : null}
        {data.description ? (
          <View style={styles.instructions}>
            <Text style={styles.instructionsLabel}>What to do</Text>
            <Text style={styles.instructionsText} selectable>
              {data.description}
            </Text>
          </View>
        ) : null}
        {data.resources.length > 0 ? (
          <View style={styles.materials}>
            <Text style={styles.instructionsLabel}>Materials</Text>
            {data.resources.map((resource) => (
              <ResourceShareCard
                key={String(resource._id)}
                resource={resource}
                compact
              />
            ))}
          </View>
        ) : null}
      </View>

      {data.items.length > 0 ? (
        <View style={styles.bannerRow}>
          <SymbolView name="doc.viewfinder" size={18} tintColor={colors.violet} />
          <Text style={styles.bannerText}>Scanned work</Text>
        </View>
      ) : null}

      {data.items.length === 0 &&
      (data.description || data.resources.length === 0) ? (
        <View style={styles.emptyCue}>
          <SymbolView name="doc.fill" size={22} tintColor={colors.violet} />
          <Text style={styles.emptyCueTitle}>This one&apos;s on paper</Text>
          <Text style={styles.paperCueText}>
            Do this work on paper, then hand it to your teacher — they&apos;ll
            scan it in so it shows up right here.
          </Text>
        </View>
      ) : data.items.length > 0 ? (
        // Two-column grid on iPad landscape, single column otherwise.
        <View style={styles.grid}>
          {data.items.map((item) => (
            <View key={item.deliverableId} style={styles.gridItem}>
              <ScanCard item={item} />
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.white,
  },
  scrollContent: {
    padding: 20,
    paddingBottom: 40,
  },
  readingColumn: {
    width: "100%",
    maxWidth: 720,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
  },
  emptyText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.charcoalMuted,
    textAlign: "center",
  },
  paperCueText: {
    maxWidth: 420,
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.charcoalMuted,
    textAlign: "left",
  },
  context: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.navy,
    lineHeight: 21,
  },
  due: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.charcoalMuted,
    marginTop: 4,
    marginBottom: 16,
  },
  materials: {
    width: "100%",
    gap: 8,
    marginTop: 16,
  },
  instructions: {
    marginBottom: 24,
    gap: 6,
  },
  instructionsLabel: {
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.navy,
  },
  instructionsText: {
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.charcoal,
    lineHeight: 24,
  },
  bannerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 16,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: colors.violetMuted,
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  bannerText: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.violet,
    letterSpacing: 0.2,
  },
  // Simple two-column flex-wrap grid — landscape-friendly.
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 16,
  },
  gridItem: {
    // On narrow screens: full width. On iPad (≥600pt): half width minus gap.
    minWidth: 280,
    flex: 1,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: 14,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    // Subtle shadow
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  thumb: {
    height: 180,
    backgroundColor: colors.gray50,
  },
  thumbImg: {
    width: "100%",
    height: "100%",
  },
  thumbPlaceholder: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  openBadge: {
    position: "absolute",
    top: 8,
    right: 8,
    backgroundColor: "rgba(255,255,255,0.85)",
    borderRadius: 6,
    padding: 4,
  },
  cardMeta: {
    padding: 12,
    gap: 6,
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  cardTitle: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.navy,
  },
  checkedChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: 6,
    paddingVertical: 2,
    paddingHorizontal: 7,
    backgroundColor: colors.green + "18",
  },
  checkedText: {
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.green,
  },
  feedback: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.charcoal,
    lineHeight: 18,
    backgroundColor: colors.green + "12",
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  emptyCue: {
    alignItems: "flex-start",
    gap: 8,
    maxWidth: 420,
    paddingVertical: 12,
  },
  emptyCueTitle: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.navy,
  },
  caption: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.charcoalMuted,
    lineHeight: 18,
  },
});
