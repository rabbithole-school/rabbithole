/**
 * The scholar's parked ideas (sessions.parkingLot) as a list of chips — ONE
 * rendering shared by every surface that shows the lot (T1/T12):
 *   • the Workshop strip (components/vibecode/ParkingLot.tsx),
 *   • the "Saved for later" block on the done screen (session/[id].tsx).
 * The caller owns the heading and any buttons; this only draws the ideas.
 * `renderActions`, when given, puts per-idea buttons inside each chip.
 * Web twin: components/ParkedIdeaList.tsx — same labels (shared/missionCopy).
 */
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

export type ParkedIdea = {
  text: string;
  parkedAt: number;
  reason?: string;
  /** Set once "Make it a Quest" planted a seed for this idea. */
  questSeedId?: string;
};

export function ParkedIdeaList({
  ideas,
  renderActions,
}: {
  ideas: readonly ParkedIdea[];
  renderActions?: (idea: ParkedIdea) => ReactNode;
}) {
  const colors = useColors();
  return (
    <View style={renderActions ? styles.column : styles.chips}>
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
          {renderActions ? (
            <View style={styles.actions}>{renderActions(idea)}</View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  column: { gap: 8 },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
    maxWidth: "100%",
  },
  chipText: { fontFamily: fonts.semibold, fontSize: 14 },
  caption: { fontFamily: fonts.regular, fontSize: 12 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
});
