/**
 * The scholar's PARKING LOT in the Workshop (sessions.parkingLot): ideas the
 * App designer parked for the Free play version instead of building them now
 * (convex/lib/designerTools.ts park_idea). Hidden when empty. Once the
 * assignment version is done (`freePlayEligible`, convex/lib/freePlay.ts), a
 * "Start free play" button beside the label opens the scholar's own version
 * (TRA-489).
 * Web twin: components/vibecode/ParkingLot.tsx — same label and anatomy.
 */
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { fonts, useColors } from "@/theme";

export type ParkedIdea = { text: string; parkedAt: number; reason?: string };

export function ParkingLot({
  ideas,
  onStartFreePlay,
  startingFreePlay = false,
}: {
  ideas: readonly ParkedIdea[] | undefined;
  /** Present only when sessions.startFreePlay would succeed. */
  onStartFreePlay?: () => void;
  startingFreePlay?: boolean;
}) {
  const colors = useColors();
  if (!ideas || ideas.length === 0) return null;
  return (
    <View
      style={[styles.root, { borderTopColor: colors.border }]}
      accessibilityLabel="Parking lot for Free play"
    >
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: colors.fgMuted }]}>
          Parking lot · Free play
        </Text>
        {onStartFreePlay ? (
          <Pressable
            onPress={onStartFreePlay}
            disabled={startingFreePlay}
            accessibilityRole="button"
            accessibilityLabel="Start free play"
            hitSlop={8}
            style={[styles.startButton, { backgroundColor: colors.violet }]}
          >
            {startingFreePlay ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.startButtonText}>Start free play</Text>
            )}
          </Pressable>
        ) : null}
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.chips}>
        {ideas.map((idea) => (
          <View
            key={`${idea.parkedAt}-${idea.text}`}
            style={[
              styles.chip,
              { borderColor: colors.border, backgroundColor: colors.bg },
            ]}
          >
            <Text style={[styles.chipText, { color: colors.fg }]}>
              {idea.text}
            </Text>
            {idea.reason ? (
              <Text style={[styles.caption, { color: colors.fgMuted }]}>
                {idea.reason}
              </Text>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 6,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 6,
  },
  label: { fontFamily: fonts.semibold, fontSize: 12 },
  startButton: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    minHeight: 28,
    justifyContent: "center",
  },
  startButtonText: { fontFamily: fonts.semibold, fontSize: 13, color: "#fff" },
  scroll: { maxHeight: 120 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: "100%",
  },
  chipText: { fontFamily: fonts.semibold, fontSize: 14 },
  caption: { fontFamily: fonts.regular, fontSize: 12 },
});
