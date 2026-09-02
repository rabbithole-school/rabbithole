/**
 * The landscape Workbench controls, floating over the one canonical world view.
 *
 * This replaces the former persistent right rail: transport and run stay in the
 * bottom-left glass box, while prompt-deck, history, and tutor entry points stay
 * in the bottom-right one. Their detailed surfaces remain the existing sheets.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { GlassBar } from "@/components/Glass";
import { fonts, useColors } from "@/theme";
import { type Id } from "@/lib/convex";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";
import type { PopulationTraitEvidence } from "../../../vendor/simulator/scene";
import type {
  WorkbenchRunId,
  SimulatorRun,
  SimulatorRunListItem,
} from "./useWorkbenchData";
import { RunTray } from "./RunTray";
import { TickScrubber } from "./TickScrubber";
import { MetricStrip } from "./MetricStrip";
import { workbenchDeckNoun, workbenchActorNoun } from "./workbenchTerminology";

export function WorkbenchPanel({
  sessionId,
  spec,
  activityDescription,
  deckDirty,
  hasCompletedRun,
  hasRuns,
  activeRun,
  onLaunched,
  deckVersion,
  onOpenDeck,
  onOpenHistory,
  onToggleTutor,
  tutorOpen,
  selectedRun,
  tick,
  maxTick,
  moreComing,
  playing,
  onScrub,
  onTogglePlay,
  populationTraitEvidence,
}: {
  sessionId: Id<"sessions">;
  spec: SimulatorSpec;
  activityDescription?: string;
  deckDirty: boolean;
  hasCompletedRun: boolean;
  hasRuns: boolean;
  activeRun: SimulatorRunListItem | null;
  onLaunched: (runId: WorkbenchRunId) => void;
  deckVersion: number;
  onOpenDeck: () => void;
  onOpenHistory: () => void;
  onToggleTutor: () => void;
  tutorOpen: boolean;
  selectedRun: SimulatorRun | null;
  tick: number;
  maxTick: number;
  moreComing: boolean;
  playing: boolean;
  onScrub: (tick: number) => void;
  onTogglePlay: () => void;
  populationTraitEvidence?: PopulationTraitEvidence;
}) {
  const colors = useColors();
  const deckNoun = workbenchDeckNoun(spec);
  const actorNoun = workbenchActorNoun(spec);

  return (
    <View pointerEvents="box-none" style={styles.overlay}>
      <GlassBar edge="none" style={[styles.playback, { borderColor: colors.border }]}>
        {activityDescription ? (
          <View style={[styles.challenge, { borderBottomColor: colors.border }]}>
            <Text style={[styles.challengeLabel, { color: colors.fgMuted }]}>Your challenge</Text>
            <Text style={[styles.challengeText, { color: colors.fg }]} numberOfLines={2}>
              {activityDescription}
            </Text>
          </View>
        ) : null}
        {selectedRun ? (
          <>
            {spec.templateId === "ecosystemGrid" ? (
              <MetricStrip
                run={selectedRun}
                spec={spec}
                selectedTick={tick}
                populationTraitEvidence={populationTraitEvidence}
              />
            ) : null}
            <TickScrubber
              tick={tick}
              maxTick={maxTick}
              moreComing={moreComing}
              playing={playing}
              onScrub={onScrub}
              onTogglePlay={onTogglePlay}
              status={selectedRun.status}
              haltReason={selectedRun.haltReason}
              targetTicks={selectedRun.targetTicks}
              runKind={selectedRun.runKind}
              spec={spec}
            />
          </>
        ) : null}
        {hasRuns ? (
          <View style={[styles.launcher, { borderTopColor: colors.border }]}>
            <RunTray
              sessionId={sessionId}
              spec={spec}
              deckDirty={deckDirty}
              deckVersion={deckVersion}
              hasCompletedRun={hasCompletedRun}
              activeRun={activeRun}
              onLaunched={onLaunched}
            />
          </View>
        ) : null}
      </GlassBar>

      <View pointerEvents="box-none" style={styles.deck}>
        <GlassBar edge="none" isInteractive style={styles.deckButton}>
          <Pressable
            onPress={onOpenDeck}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${deckNoun}, version ${deckVersion}`}
            accessibilityHint={`Opens the ${deckNoun} editor and tournament matches`}
            style={({ pressed }) => [styles.deckPressable, pressed && styles.pressed]}
          >
            <View style={styles.deckCopy}>
              <Text style={[styles.deckTitle, { color: colors.fg }]}>{deckNoun === "prompt deck" ? "Prompt deck" : "Strategy rules"}</Text>
              <Text style={[styles.deckMeta, { color: colors.fgMuted }]}>v{deckVersion} · {actorNoun}s and matches</Text>
            </View>
            <SymbolView name="pencil" tintColor={colors.violet} size={18} />
          </Pressable>
        </GlassBar>

        <View style={styles.actions}>
          <GlassBar edge="none" isInteractive style={styles.action}>
            <Pressable
              onPress={onOpenHistory}
              accessibilityRole="button"
              accessibilityLabel="Open history"
              accessibilityHint="Opens runs and notebook entries"
              style={({ pressed }) => [styles.actionPressable, pressed && styles.pressed]}
            >
              <SymbolView name="clock.arrow.circlepath" tintColor={colors.violet} size={17} />
              <Text style={[styles.actionLabel, { color: colors.fg }]}>History</Text>
            </Pressable>
          </GlassBar>
          <GlassBar edge="none" isInteractive style={styles.action}>
            <Pressable
              onPress={onToggleTutor}
              accessibilityRole="button"
              accessibilityLabel={tutorOpen ? "Close tutor" : "Open tutor"}
              style={({ pressed }) => [styles.actionPressable, pressed && styles.pressed]}
            >
              <SymbolView name="bubble.left.fill" tintColor={colors.violet} size={17} />
              <Text style={[styles.actionLabel, { color: colors.fg }]}>Tutor</Text>
            </Pressable>
          </GlassBar>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, pointerEvents: "box-none" },
  playback: {
    position: "absolute",
    left: 16,
    bottom: 16,
    width: 320,
    maxHeight: "70%",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    overflow: "hidden",
  },
  challenge: {
    gap: 3,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  challengeLabel: { fontFamily: fonts.semibold, fontSize: 11 },
  challengeText: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18 },
  launcher: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingBottom: 10,
  },
  deck: {
    position: "absolute",
    right: 16,
    bottom: 16,
    width: 240,
    gap: 8,
  },
  deckButton: {
    minHeight: 56,
    borderRadius: 14,
    overflow: "hidden",
  },
  deckPressable: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  deckCopy: { flex: 1, gap: 1 },
  deckTitle: { fontFamily: fonts.bold, fontSize: 15 },
  deckMeta: { fontFamily: fonts.regular, fontSize: 11 },
  actions: { flexDirection: "row", gap: 8 },
  action: {
    minWidth: 0,
    minHeight: 44,
    flex: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  actionPressable: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 8,
  },
  actionLabel: { fontFamily: fonts.semibold, fontSize: 13 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.98 }] },
});
