import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";
import type {
  WorkbenchCommonsRoundEvidence,
  WorkbenchMatchRoundEvidence,
} from "../../../vendor/simulator/scene";
import type { SceneFrame, SceneResult } from "./useWorkbenchScene";
import { formatMetric } from "./helpers";
import { disambiguatedActorLabels } from "./workbenchTerminology";
import { commonsPotModel } from "../../../vendor/simulator/workbenchVisuals";
import { MatchVisualRecord } from "./MatchVisualRecord";

type ContentInsets = { top: number; right: number; bottom: number; left: number };

function RoundStrip({
  rounds,
  selectedRound,
  onSelect,
}: {
  rounds: readonly { round: number }[];
  selectedRound: number | undefined;
  onSelect: (round: number) => void;
}) {
  const colors = useColors();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.roundStrip}>
      {rounds.map((round) => {
        const selected = round.round === selectedRound;
        return (
          <Pressable
            key={round.round}
            onPress={() => onSelect(round.round)}
            accessibilityRole="button"
            accessibilityLabel={`Round ${round.round}`}
            accessibilityState={{ selected }}
            style={[
              styles.roundButton,
              {
                backgroundColor: selected ? colors.violetSolid : colors.white,
                borderColor: selected ? colors.violetSolid : colors.border,
              },
            ]}
          >
            <Text style={[styles.roundText, { color: selected ? colors.white : colors.fg }]}>
              Round {round.round}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

function CommonsRecord({
  spec,
  evidence,
  selectedRoundNumber,
  onSelectRound,
  onSelectActor,
}: {
  spec: Extract<SimulatorSpec, { templateId: "publicGoods" }>;
  evidence: readonly WorkbenchCommonsRoundEvidence[];
  selectedRoundNumber: number | undefined;
  onSelectRound: (round: number) => void;
  onSelectActor: (id: string) => void;
}) {
  const colors = useColors();
  const round =
    evidence.find((item) => item.round === selectedRoundNumber) ?? evidence.at(-1);
  if (!round) return <Text style={[styles.empty, { color: colors.fgMuted }]}>Rounds will appear as this commons begins.</Text>;
  const endowment = spec.config.endowmentPerRound;
  const labels = disambiguatedActorLabels(round.actors);
  const pot = commonsPotModel({
    round,
    endowment,
    multiplier: spec.config.multiplier,
    labels,
  });
  return (
    <>
      <View style={[styles.potRule, { borderColor: colors.border }]}>
        <Text style={[styles.tableTitle, { color: colors.fg }]}>Pot rule</Text>
        <Text style={[styles.detail, { color: colors.fgMuted }]}>
          Each contribution adds {formatMetric(endowment)}. The pool is multiplied by {formatMetric(spec.config.multiplier)} and shared equally.
        </Text>
      </View>
      <Text style={[styles.sectionTitle, { color: colors.fg }]}>
        Round {pot.round} · {pot.contributors}/{pot.players} put something in
      </Text>
      <View style={styles.flow}>
        <View style={styles.flowActors}>
          {pot.actors.map((actor) => (
            <Pressable
              key={actor.id}
              onPress={() => onSelectActor(actor.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${actor.label}, player`}
              style={[
                styles.flowActor,
                {
                  borderColor: actor.contributed > 0 ? colors.green : colors.border,
                  backgroundColor: colors.white,
                },
              ]}
            >
              <Text style={[styles.flowActorName, { color: colors.fg }]}>{actor.label}</Text>
              <Text style={[styles.detail, { color: actor.contributed > 0 ? colors.green : colors.fgMuted }]}>
                {actor.contributed > 0
                  ? `+${formatMetric(actor.contributed)}`
                  : `kept ${formatMetric(actor.kept)}`}
              </Text>
            </Pressable>
          ))}
        </View>
        <View style={[styles.pot, { backgroundColor: colors.violetSubtle, borderColor: colors.violet }]}>
          <Text style={[styles.potKicker, { color: colors.violet }]}>COMMON POT</Text>
          <Text style={[styles.potEquation, { color: colors.fg }]}>
            {formatMetric(pot.inputPool)} × {formatMetric(pot.multiplier)} = {formatMetric(pot.grownPool)}
          </Text>
        </View>
        <View style={styles.flowActors}>
          {pot.actors.map((actor) => (
            <Pressable
              key={actor.id}
              onPress={() => onSelectActor(actor.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${actor.label}, player`}
              style={[styles.flowActor, { borderColor: colors.violet, backgroundColor: colors.white }]}
            >
              <Text style={[styles.flowActorName, { color: colors.fg }]}>{actor.label}</Text>
              <Text style={[styles.detail, { color: colors.violet }]}>
                gets {formatMetric(actor.share)} → {formatMetric(actor.payoff)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={[styles.perceptionStrip, { borderTopColor: colors.border }]}>
        <Text style={[styles.perceptionTitle, { color: colors.fgMuted }]}>What each player read after this round</Text>
        <View style={styles.perceptionItems}>
          {pot.actors.map((actor) => (
            <Pressable
              key={actor.id}
              onPress={() => onSelectActor(actor.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${actor.label}, player`}
            >
              <Text style={[styles.detail, { color: actor.misperceived ? colors.orange : colors.fgMuted }]}>
                {actor.label}: saw {actor.perceivedContributorCount}, actually {actor.actualContributorCount}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <Text style={[styles.perceptionTitle, { color: colors.fgMuted }]}>Completed rounds</Text>
      <RoundStrip
        rounds={evidence}
        selectedRound={round.round}
        onSelect={onSelectRound}
      />
    </>
  );
}

export function WorkbenchProofRenderer({
  spec,
  frame,
  scene,
  onScrub,
  onSelectActor,
  contentInsets,
  targetTicks,
}: {
  spec: Exclude<SimulatorSpec, Extract<SimulatorSpec, { templateId: "ecosystemGrid" }>>;
  frame: SceneFrame | null;
  scene: SceneResult;
  onScrub: (tick: number) => void;
  onSelectActor: (id: string) => void;
  contentInsets?: ContentInsets;
  maxTick: number;
  targetTicks: number;
}) {
  const colors = useColors();
  const evidence = frame?.workbenchRoundEvidence ?? [];
  const selectedRound = scene.status === "ready" ? scene.tick : evidence.at(-1)?.round;
  const selectRound = (round: number) => onScrub(round);
  const record =
    spec.templateId === "publicGoods"
      ? (
          <CommonsRecord
            spec={spec}
            evidence={evidence.filter(
              (item): item is WorkbenchCommonsRoundEvidence => item.kind === "commons",
            )}
            selectedRoundNumber={selectedRound}
            onSelectRound={selectRound}
            onSelectActor={onSelectActor}
          />
        )
      : (
          <MatchVisualRecord
            spec={spec}
            evidence={evidence.filter(
              (item): item is WorkbenchMatchRoundEvidence => item.kind === "match",
            )}
            selectedRoundNumber={selectedRound}
            totalRounds={targetTicks}
            onSelectRound={selectRound}
            onSelectActor={onSelectActor}
          />
        );
  const evidenceState =
    scene.status === "error" ? (
      <Text style={[styles.error, { color: colors.orange }]}>
        Round evidence is unavailable for round {scene.tick}.
      </Text>
    ) : scene.status === "loading" && evidence.length === 0 ? (
      <Text style={[styles.loading, { color: colors.fgMuted }]}>Loading round evidence…</Text>
    ) : (
      record
    );

  return (
    <View style={[styles.root, { backgroundColor: colors.white }]}>
      <ScrollView
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: Math.max(16, contentInsets?.top ?? 16),
            paddingRight: Math.max(16, contentInsets?.right ?? 16),
            paddingBottom: Math.max(16, contentInsets?.bottom ?? 16),
            paddingLeft: Math.max(16, contentInsets?.left ?? 16),
          },
        ]}
      >
        <Text style={[styles.title, { color: colors.fg }]}>
          {spec.templateId === "publicGoods" ? "Commons record" : "Match world"}
        </Text>
        {scene.status === "loading" && evidence.length > 0 ? (
          <Text style={[styles.loading, { color: colors.fgMuted }]}>Loading round evidence…</Text>
        ) : null}
        {evidenceState}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, minHeight: 0 },
  content: { gap: 12 },
  title: { fontFamily: fonts.bold, fontSize: 20 },
  loading: { fontFamily: fonts.regular, fontSize: 13 },
  error: { fontFamily: fonts.medium, fontSize: 14, paddingVertical: 18 },
  empty: { fontFamily: fonts.regular, fontSize: 14, paddingVertical: 18 },
  roundStrip: { gap: 8, paddingVertical: 2 },
  roundButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  roundText: { fontFamily: fonts.semibold, fontSize: 13 },
  table: { borderWidth: StyleSheet.hairlineWidth },
  tableTitle: { fontFamily: fonts.bold, fontSize: 14, paddingHorizontal: 12, paddingTop: 10 },
  tableNote: { fontFamily: fonts.regular, fontSize: 11, paddingHorizontal: 12, paddingBottom: 8 },
  tableRow: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  tableHead: { flex: 1, fontFamily: fonts.semibold, fontSize: 11, padding: 8 },
  tableCell: { flex: 1, fontFamily: fonts.regular, fontSize: 12, padding: 8 },
  selectedTableCell: { borderWidth: StyleSheet.hairlineWidth, borderColor: "#94A3B8" },
  ledger: { borderWidth: StyleSheet.hairlineWidth },
  ledgerRow: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  ledgerRound: { width: 28, fontFamily: fonts.bold, fontSize: 12 },
  ledgerActor: { flex: 1, minWidth: 0 },
  ledgerActorName: { fontFamily: fonts.semibold, fontSize: 12 },
  ledgerDetail: { fontFamily: fonts.regular, fontSize: 11 },
  ledgerCommons: { flex: 1, fontFamily: fonts.regular, fontSize: 12 },
  potRule: { borderWidth: StyleSheet.hairlineWidth, paddingBottom: 10 },
  commonsSummary: { flexDirection: "row", flexWrap: "wrap", gap: 12, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  summaryValue: { fontFamily: fonts.semibold, fontSize: 13 },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 15, marginTop: 2 },
  actorRow: { minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10, gap: 3 },
  actorHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline", gap: 10 },
  actorName: { fontFamily: fonts.semibold, fontSize: 15, flex: 1 },
  actorAction: { fontFamily: fonts.semibold, fontSize: 13 },
  detail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  flow: { gap: 10 },
  flowActors: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  flowActor: {
    minWidth: 96,
    flexGrow: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  flowActorName: { fontFamily: fonts.semibold, fontSize: 13 },
  pot: {
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  potKicker: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.8 },
  potEquation: { fontFamily: fonts.bold, fontSize: 18, marginTop: 2 },
  perceptionStrip: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, gap: 5 },
  perceptionTitle: { fontFamily: fonts.semibold, fontSize: 11 },
  perceptionItems: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
});
