/**
 * The subheader — now led by the SPECIES ROSTER (plan §7.1: the deck is the
 * headline). A horizontally-scrollable strip of species chips (color + charm +
 * label + count) sits front-and-centre; tapping one opens the deck focused on
 * that species, and a "+" appends a species when the World's roster is open. The
 * criterion sentence is demoted to a quiet second line — still visible, no
 * longer the lead. Right edge: personal best · the Tutor and History toggles.
 * "best" is a PERSONAL ceiling ("best so far"), never a class rank (plan §4).
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { GlassBar } from "@/components/Glass";
import { fonts, useColors } from "@/theme";
import type { DeckCard, SimulatorSpec } from "../../../vendor/simulator/contract";
import { ECOSYSTEM_LANDSCAPE_DISCLOSURE } from "../../../vendor/simulator/ecosystemLandscape";
import { colorForSlotIndex, criterionFeedbackSentence, formatMetric, metricLabel } from "./helpers";
import { SpeciesIconImage } from "./SpeciesIcon";
import { isRoundBasedWorkbench, workbenchActorNoun } from "./workbenchTerminology";

export function CriterionBar({
  spec,
  deck,
  speciesIcons,
  bestScore,
  extinct,
  canAddSpecies,
  onFocusSpecies,
  onAddSpecies,
  historyOpen,
  onToggleHistory,
  tutorOpen,
  onToggleTutor,
  showUtilityActions = true,
}: {
  spec: SimulatorSpec;
  deck: readonly DeckCard[];
  speciesIcons: Record<string, string | undefined>;
  bestScore: number | null;
  extinct: boolean;
  canAddSpecies: boolean;
  onFocusSpecies: (slotId: string) => void;
  onAddSpecies: () => void;
  historyOpen: boolean;
  onToggleHistory: () => void;
  tutorOpen: boolean;
  onToggleTutor: () => void;
  /** The immersive landscape overlay owns these actions near the prompt deck. */
  showUtilityActions?: boolean;
}) {
  const colors = useColors();
  const roundBased = isRoundBasedWorkbench(spec);
  const actorNoun = workbenchActorNoun(spec);
  const metric =
    spec.criterion.kind === "measured" && bestScore !== null
      ? metricLabel(spec.criterion.metricKey, bestScore)
      : null;
  const countBySlot = new Map(deck.map((card) => [card.slotId, card.count]));

  return (
    <GlassBar edge="bottom" style={styles.bar}>
      <View style={styles.topRow}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.roster}
          contentContainerStyle={styles.rosterContent}
        >
          {spec.speciesSlots.map((slot, index) => {
            const count = countBySlot.get(slot.slotId) ?? slot.defaultCount;
            const color = colorForSlotIndex(index);
            return (
              <Pressable
                key={slot.slotId}
                onPress={() => onFocusSpecies(slot.slotId)}
                accessibilityRole="button"
                accessibilityLabel={
                  roundBased
                    ? `Edit strategy for ${slot.label}, player (${count})`
                    : `Edit ${slot.label} (${count})`
                }
                style={[styles.chip, { backgroundColor: colors.violetSubtle, borderColor: colors.violetMuted }]}
              >
                <SpeciesIconImage icon={speciesIcons[slot.label]} color={color} size={18} />
                <Text style={[styles.chipLabel, { color: colors.fg }]} numberOfLines={1}>
                  {slot.label}
                </Text>
                <Text style={[styles.chipCount, { color: colors.fgMuted }]}>×{count}</Text>
              </Pressable>
            );
          })}

          {canAddSpecies ? (
            <Pressable
              onPress={onAddSpecies}
              accessibilityRole="button"
              accessibilityLabel={`Add a ${actorNoun}`}
              style={[styles.addChip, { borderColor: colors.violetMuted }]}
            >
              <SymbolView name="plus" tintColor={colors.violet} size={14} />
            </Pressable>
          ) : null}
        </ScrollView>

        <View style={styles.right}>
          <View style={styles.stat}>
            <Text style={[styles.statLabel, { color: colors.fgMuted }]}>best so far</Text>
            <Text style={[styles.statValue, { color: colors.fg }]}>
              {bestScore === null ? "—" : `${formatMetric(bestScore)}${metric ? ` ${metric}` : ""}`}
            </Text>
          </View>
          {showUtilityActions ? (
            <>
              <Pressable
                onPress={onToggleTutor}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Toggle tutor"
                style={[
                  styles.pill,
                  {
                    backgroundColor: tutorOpen ? colors.violetSolid : colors.violetSubtle,
                    borderColor: colors.violetMuted,
                  },
                ]}
              >
                <SymbolView name="bubble.left.fill" tintColor={tutorOpen ? colors.white : colors.violet} size={15} />
              </Pressable>
              <Pressable
                onPress={onToggleHistory}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Toggle history"
                style={[
                  styles.pill,
                  {
                    backgroundColor: historyOpen ? colors.violetSolid : colors.violetSubtle,
                    borderColor: colors.violetMuted,
                  },
                ]}
              >
                <SymbolView
                  name="clock.arrow.circlepath"
                  tintColor={historyOpen ? colors.white : colors.violet}
                  size={15}
                />
                <Text style={[styles.pillText, { color: historyOpen ? colors.white : colors.violet }]}>History</Text>
              </Pressable>
            </>
          ) : null}
        </View>
      </View>

      <Text
        style={[styles.criterion, { color: colors.fgMuted }]}
        numberOfLines={
          spec.templateId === "ecosystemGrid" && spec.config.landscape ? 2 : 1
        }
      >
        {criterionFeedbackSentence(spec, extinct)}
        {spec.templateId === "ecosystemGrid" && spec.config.landscape
          ? `\n${ECOSYSTEM_LANDSCAPE_DISCLOSURE}`
          : ""}
      </Text>
    </GlassBar>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "column",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 58,
  },
  topRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  roster: { flex: 1 },
  rosterContent: { alignItems: "center", gap: 6, paddingRight: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingLeft: 5,
    paddingRight: 9,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: 150,
  },
  chipLabel: { fontFamily: fonts.semibold, fontSize: 12, flexShrink: 1 },
  chipCount: { fontFamily: fonts.bold, fontSize: 12 },
  addChip: {
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: "dashed",
    alignItems: "center",
    justifyContent: "center",
  },
  right: { flexDirection: "row", alignItems: "center", gap: 10 },
  stat: { alignItems: "flex-end" },
  statLabel: { fontFamily: fonts.regular, fontSize: 10 },
  statValue: { fontFamily: fonts.bold, fontSize: 14 },
  criterion: { fontFamily: fonts.regular, fontSize: 12 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillText: { fontFamily: fonts.semibold, fontSize: 12 },
});
