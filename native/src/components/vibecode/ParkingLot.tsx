/**
 * The scholar's PARKING LOT in the Workshop (sessions.parkingLot): ideas the
 * App designer parked for the Free play version instead of building them now
 * (convex/lib/designerTools.ts park_idea). Hidden when empty. Once the
 * activity is done, the builder passes `renderActions` (the done screen's
 * Build it now + Make it a Quest per idea, TRA-519 B2 —
 * useSavedForLaterActions) and each idea carries its own buttons; until then
 * the chips are read-only. `onStartFreePlay` remains for a caller with no
 * per-idea actions (TRA-489). This strip owns its heading; the chips are the
 * shared ParkedIdeaList (one rendering of the lot, TRA-519 B1).
 * Web twin: components/vibecode/ParkingLot.tsx — same label and anatomy.
 */
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ParkedIdeaList, type ParkedIdea } from "@/components/ParkedIdeaList";
import { fonts, useColors } from "@/theme";

export type { ParkedIdea };

export function ParkingLot({
  ideas,
  onStartFreePlay,
  startingFreePlay = false,
  renderActions,
}: {
  ideas: readonly ParkedIdea[] | undefined;
  /** Present only when sessions.startFreePlay would succeed. Ignored when
   *  `renderActions` is given (each idea then has its own Build it now). */
  onStartFreePlay?: () => void;
  startingFreePlay?: boolean;
  /** The done state's per-idea actions (useSavedForLaterActions). */
  renderActions?: (idea: ParkedIdea) => ReactNode;
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
        {onStartFreePlay && !renderActions ? (
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
      <ScrollView style={renderActions ? styles.scrollWithActions : styles.scroll}>
        <ParkedIdeaList ideas={ideas} renderActions={renderActions} />
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
  scrollWithActions: { maxHeight: 220 },
});
