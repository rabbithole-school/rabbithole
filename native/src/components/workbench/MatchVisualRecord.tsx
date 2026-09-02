import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Svg, { Line, Polyline } from "react-native-svg";

import { fonts, useColors } from "@/theme";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";
import type {
  WorkbenchMatchRoundActorEvidence,
  WorkbenchMatchRoundEvidence,
} from "../../../vendor/simulator/scene";
import { matchVisualModel } from "../../../vendor/simulator/workbenchVisuals";
import { formatMetric } from "./helpers";
import {
  disambiguatedActorLabels,
  formatDecisionSource,
  isSelectedMatchPayoffCell,
} from "./workbenchTerminology";

const ACTOR_COLORS = ["#172033", "#DB2777"] as const;
const ACTION_COLORS = ["#16815E", "#D96D38", "#2879BD", "#8F4AA3"] as const;
const CHART_WIDTH = 720;
const CHART_HEIGHT = 145;
const CHART_PADDING = 12;

function actionColor(actionId: string, actionIds: readonly string[]): string {
  const index = Math.max(0, actionIds.indexOf(actionId));
  return ACTION_COLORS[index % ACTION_COLORS.length];
}

function matchPayoffValues(
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>,
): readonly number[] {
  if (spec.templateId === "prisonersDilemma") {
    const matrix = spec.config.payoffMatrix;
    return [
      matrix.mutualCooperation,
      matrix.mutualDefection,
      matrix.temptation,
      matrix.sucker,
    ];
  }
  return Object.values(spec.config.payoffs).flatMap((row) =>
    Object.values(row).flatMap((cell) => [cell.a, cell.b]),
  );
}

function MatchPayoffTable({
  spec,
  selectedRound,
}: {
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>;
  selectedRound: WorkbenchMatchRoundEvidence;
}) {
  const colors = useColors();
  const labels = disambiguatedActorLabels(selectedRound.actors);
  const actions =
    spec.templateId === "matrixGame"
      ? spec.config.actions.map((action) => ({
          id: action.actionId,
          label: action.label,
        }))
      : [
          { id: "cooperate", label: "Cooperate" },
          { id: "defect", label: "Defect" },
        ];
  const payoff = (row: string, column: string) => {
    if (spec.templateId === "matrixGame") {
      const cell =
        spec.config.payoffs[row as "optionA" | "optionB"][
          column as "optionA" | "optionB"
        ];
      return `${formatMetric(cell.a)} / ${formatMetric(cell.b)}`;
    }
    const matrix = spec.config.payoffMatrix;
    if (row === "cooperate" && column === "cooperate") {
      return `${formatMetric(matrix.mutualCooperation)} / ${formatMetric(matrix.mutualCooperation)}`;
    }
    if (row === "defect" && column === "defect") {
      return `${formatMetric(matrix.mutualDefection)} / ${formatMetric(matrix.mutualDefection)}`;
    }
    if (row === "defect") {
      return `${formatMetric(matrix.temptation)} / ${formatMetric(matrix.sucker)}`;
    }
    return `${formatMetric(matrix.sucker)} / ${formatMetric(matrix.temptation)}`;
  };
  return (
    <View style={[styles.table, { borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.fg }]}>Payoff table</Text>
      <Text style={[styles.note, { color: colors.fgMuted }]}>
        Each cell lists {labels[0] ?? "the first strategy"} / {labels[1] ?? "the second strategy"}.
      </Text>
      <View style={[styles.tableRow, { borderTopColor: colors.border }]}>
        <Text style={[styles.tableHead, { color: colors.fgMuted }]}>Row / column</Text>
        {actions.map((action) => (
          <Text key={action.id} style={[styles.tableHead, { color: colors.fgMuted }]} numberOfLines={1}>
            {action.label}
          </Text>
        ))}
      </View>
      {actions.map((row) => (
        <View key={row.id} style={[styles.tableRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.tableCell, { color: colors.fg }]} numberOfLines={1}>{row.label}</Text>
          {actions.map((column) => {
            const selected = isSelectedMatchPayoffCell(selectedRound, row.id, column.id);
            return (
              <Text
                key={column.id}
                style={[
                  styles.tableCell,
                  selected ? [styles.selectedTableCell, { backgroundColor: colors.violetSubtle }] : null,
                  { color: colors.fg },
                ]}
              >
                {payoff(row.id, column.id)}
              </Text>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function ActionRibbon({
  evidence,
  totalRounds,
  selectedRound,
  onSelectRound,
  onSelectActor,
}: {
  evidence: readonly WorkbenchMatchRoundEvidence[];
  totalRounds: number;
  selectedRound: number;
  onSelectRound: (round: number) => void;
  onSelectActor: (id: string) => void;
}) {
  const colors = useColors();
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const actionIds = model.actions.map((action) => action.id);
  const labels = disambiguatedActorLabels(model.actors);
  const hasFractures = model.actors.some((actor) =>
    actor.actions.some((action) => action.misperceived),
  );
  return (
    <View style={styles.ribbonSection}>
      <View style={styles.legend}>
        {model.actions.map((action) => (
          <View key={action.id} style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: actionColor(action.id, actionIds) }]} />
            <Text style={[styles.legendText, { color: colors.fgMuted }]}>{action.label}</Text>
          </View>
        ))}
        {hasFractures ? (
          <View style={styles.legendItem}>
            <View style={styles.fractureLegend} />
            <Text style={[styles.legendText, { color: colors.fgMuted }]}>Read differed</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.ribbonRows}>
        <View style={styles.ribbonLabels}>
          {model.actors.map((actor, index) => (
            <Pressable
              key={actor.id}
              onPress={() => onSelectActor(actor.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${labels[index]}, player`}
              style={styles.ribbonLabelButton}
            >
              <Text style={[styles.ribbonLabel, { color: colors.fg }]} numberOfLines={1}>
                {labels[index]}
              </Text>
            </Pressable>
          ))}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.ribbonScroll}>
          <View style={[styles.ribbonTracks, { minWidth: Math.max(0, totalRounds * 28) }]}>
            {model.actors.map((actor, actorIndex) => (
              <View key={actor.id} style={styles.ribbonTrack}>
                {actor.actions.map((action) => {
                  const selected = action.round === selectedRound;
                  return (
                    <Pressable
                      key={action.round}
                      onPress={() => onSelectRound(action.round)}
                      accessibilityRole="button"
                      accessibilityLabel={`Round ${action.round}: ${labels[actorIndex]} chose ${action.actionLabel}${action.misperceived ? "; read differed from reality" : ""}`}
                      accessibilityState={{ selected }}
                      style={[
                        styles.actionCell,
                        { backgroundColor: actionColor(action.actionId, actionIds) },
                        selected ? styles.selectedActionCell : null,
                      ]}
                    >
                      {action.misperceived ? <View style={styles.fracture} /> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    </View>
  );
}

function ScoreTrajectory({
  spec,
  evidence,
  selectedRound,
  totalRounds,
}: {
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>;
  evidence: readonly WorkbenchMatchRoundEvidence[];
  selectedRound: number;
  totalRounds: number;
}) {
  const colors = useColors();
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const roundCount = Math.max(1, totalRounds);
  const payoffValues = matchPayoffValues(spec);
  const min = Math.min(0, ...payoffValues) * roundCount;
  const max = Math.max(1 / roundCount, ...payoffValues) * roundCount;
  const span = max - min || 1;
  const x = (round: number) =>
    CHART_PADDING +
    ((round - 1) / Math.max(1, roundCount - 1)) *
      (CHART_WIDTH - CHART_PADDING * 2);
  const y = (value: number) =>
    CHART_HEIGHT -
    CHART_PADDING -
    ((value - min) / span) * (CHART_HEIGHT - CHART_PADDING * 2);
  return (
    <View>
      <Text style={[styles.eyebrow, { color: colors.fgMuted }]}>CUMULATIVE PAYOFF</Text>
      <Svg width="100%" height={CHART_HEIGHT} viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}>
        {[0.25, 0.5, 0.75].map((portion) => (
          <Line
            key={portion}
            x1={CHART_PADDING}
            x2={CHART_WIDTH - CHART_PADDING}
            y1={CHART_PADDING + portion * (CHART_HEIGHT - CHART_PADDING * 2)}
            y2={CHART_PADDING + portion * (CHART_HEIGHT - CHART_PADDING * 2)}
            stroke={colors.border}
            strokeWidth={1}
          />
        ))}
        {model.actors.map((actor, actorIndex) => {
          const tied =
            actorIndex > 0 &&
            model.actors.every((candidate) =>
              candidate.actions.every(
                (action, index) =>
                  action.cumulativeTotal === actor.actions[index]?.cumulativeTotal,
              ),
            );
          return (
            <Polyline
              key={actor.id}
              points={actor.actions
                .map((action) => `${x(action.round)},${y(action.cumulativeTotal)}`)
                .join(" ")}
              fill="none"
              stroke={ACTOR_COLORS[actorIndex % ACTOR_COLORS.length]}
              strokeWidth={3}
              strokeDasharray={tied ? "8 5" : undefined}
            />
          );
        })}
        <Line
          x1={x(selectedRound)}
          x2={x(selectedRound)}
          y1={4}
          y2={CHART_HEIGHT - 4}
          stroke={colors.fg}
          strokeWidth={2}
        />
      </Svg>
      <View style={styles.legend}>
        {disambiguatedActorLabels(model.actors).map((label, index) => (
          <View key={model.actors[index]?.id ?? label} style={styles.legendItem}>
            <View style={[styles.actorLine, { backgroundColor: ACTOR_COLORS[index % ACTOR_COLORS.length] }]} />
            <Text style={[styles.legendText, { color: colors.fgMuted }]}>{label}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

function ActorRoundCard({
  actor,
  label,
  round,
  onSelect,
}: {
  actor: WorkbenchMatchRoundActorEvidence;
  label: string;
  round: number;
  onSelect: () => void;
}) {
  return (
    <Pressable
      onPress={onSelect}
      accessibilityRole="button"
      accessibilityLabel={`Open ${label}, player`}
      style={styles.lensCard}
    >
      <View style={styles.actorHead}>
        <Text style={styles.lensActor}>{label}</Text>
        <Text style={styles.lensAction}>{actor.actionLabel}</Text>
      </View>
      <Text style={styles.lensDetail}>
        +{formatMetric(actor.roundPayoff)} this round · {formatMetric(actor.cumulativeTotal)} total
      </Text>
      <Text style={styles.lensDetail}>
        Read after this round: {actor.perception.sawOpponentActionLabel}
        {actor.perception.misperceived ? ` · actual ${actor.perception.actualOpponentActionLabel}` : ""}
      </Text>
      {actor.perception.misperceived ? (
        <Text style={styles.fractureCopy}>
          This read can inform round {round + 1}, not the action already taken.
        </Text>
      ) : null}
      <Text style={styles.lensMuted}>
        {actor.detailsRedacted
          ? "Opponent strategy details are private."
          : `${formatDecisionSource(actor.decisionSource)}${actor.policyRuleId ? ` · ${actor.policyRuleId}` : ""}${actor.policyTrace ? ` — ${actor.policyTrace}` : ""}`}
      </Text>
    </Pressable>
  );
}

function SelectedRoundLens({
  round,
  totalRounds,
  onSelectActor,
}: {
  round: WorkbenchMatchRoundEvidence;
  totalRounds: number;
  onSelectActor: (id: string) => void;
}) {
  const labels = disambiguatedActorLabels(round.actors);
  return (
    <View style={styles.lens}>
      <Text style={styles.lensEyebrow}>ROUND {round.round} OF {totalRounds}</Text>
      {round.actors.map((actor, index) => (
        <ActorRoundCard
          key={actor.id}
          actor={actor}
          label={labels[index]}
          round={round.round}
          onSelect={() => onSelectActor(actor.id)}
        />
      ))}
    </View>
  );
}

function ResponseMatrix({
  actorId,
  evidence,
}: {
  actorId: string;
  evidence: readonly WorkbenchMatchRoundEvidence[];
}) {
  const colors = useColors();
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const actor = model.actors.find((candidate) => candidate.id === actorId);
  if (!actor || model.actions.length === 0) return null;
  const maxCount = Math.max(1, ...actor.responseCounts.map((entry) => entry.count));
  return (
    <View style={[styles.matrix, { borderColor: colors.border }]}>
      <View style={styles.matrixRow}>
        <View style={styles.matrixLabelCell} />
        {model.actions.map((action) => (
          <View key={action.id} style={[styles.matrixCell, { borderColor: colors.border, backgroundColor: colors.gray50 }]}>
            <Text style={[styles.matrixText, { color: colors.fgMuted }]}>Saw {action.label.toLowerCase()}</Text>
          </View>
        ))}
      </View>
      {model.actions.map((nextAction) => (
        <View key={nextAction.id} style={styles.matrixRow}>
          <View style={styles.matrixLabelCell}>
            <Text style={[styles.matrixText, { color: colors.fgMuted }]}>Then {nextAction.label.toLowerCase()}</Text>
          </View>
          {model.actions.map((sawAction) => {
            const count =
              actor.responseCounts.find(
                (entry) =>
                  entry.sawActionId === sawAction.id &&
                  entry.nextActionId === nextAction.id,
              )?.count ?? 0;
            const diameter = count === 0 ? 0 : 16 + Math.sqrt(count / maxCount) * 36;
            return (
              <View key={sawAction.id} style={[styles.matrixCell, { borderColor: colors.border }]}>
                {count > 0 ? (
                  <View style={[styles.bubble, { width: diameter, height: diameter, borderRadius: diameter / 2, backgroundColor: colors.violetMuted }]}>
                    <Text style={[styles.bubbleText, { color: colors.violetSolid }]}>{count}</Text>
                  </View>
                ) : (
                  <Text style={[styles.matrixText, { color: colors.fgMuted }]}>0</Text>
                )}
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

function RuleBands({
  actorId,
  evidence,
  selectedRound,
  totalRounds,
}: {
  actorId: string;
  evidence: readonly WorkbenchMatchRoundEvidence[];
  selectedRound: number;
  totalRounds: number;
}) {
  const colors = useColors();
  const actor = useMemo(
    () => matchVisualModel(evidence).actors.find((candidate) => candidate.id === actorId),
    [actorId, evidence],
  );
  if (actor?.detailsRedacted) {
    return (
      <Text style={[styles.note, { color: colors.fgMuted }]}>
        Opponent strategy details are private.
      </Text>
    );
  }
  if (!actor || actor.ruleBands.length === 0) {
    return <Text style={[styles.note, { color: colors.fgMuted }]}>No visible compiled-rule trace for this strategy.</Text>;
  }
  return (
    <View style={styles.ruleBands}>
      {actor.ruleBands.map((band) => {
        const active = new Set(band.rounds);
        return (
          <View key={band.id} style={styles.ruleRow}>
            <Text style={[styles.ruleLabel, { color: colors.fgMuted }]} numberOfLines={2}>{band.label}</Text>
            <View style={styles.ruleTrack}>
              {Array.from({ length: totalRounds }, (_, index) => index + 1).map((round) => (
                <View
                  key={round}
                  accessibilityLabel={`Round ${round}${active.has(round) ? ": active" : ": inactive"}`}
                  style={[
                    styles.ruleCell,
                    {
                      backgroundColor: active.has(round)
                        ? band.kind === "fallback"
                          ? colors.gray300
                          : colors.violet
                        : colors.gray100,
                      borderColor: round === selectedRound ? colors.fg : "transparent",
                    },
                  ]}
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function MatchVisualRecord({
  spec,
  evidence,
  selectedRoundNumber,
  totalRounds,
  onSelectRound,
  onSelectActor,
}: {
  spec: Extract<SimulatorSpec, { templateId: "prisonersDilemma" | "matrixGame" }>;
  evidence: readonly WorkbenchMatchRoundEvidence[];
  selectedRoundNumber: number | undefined;
  totalRounds: number;
  onSelectRound: (round: number) => void;
  onSelectActor: (id: string) => void;
}) {
  const colors = useColors();
  const selectedRound =
    evidence.find((item) => item.round === selectedRoundNumber) ?? evidence.at(-1);
  const model = useMemo(() => matchVisualModel(evidence), [evidence]);
  const [shapeActorId, setShapeActorId] = useState<string | null>(null);
  if (!selectedRound) {
    return <Text style={[styles.empty, { color: colors.fgMuted }]}>Rounds will appear as this match begins.</Text>;
  }
  const activeShapeActorId =
    model.actors.some((actor) => actor.id === shapeActorId)
      ? shapeActorId!
      : model.actors.find((actor) => actor.ruleBands.length > 0)?.id ??
        model.actors[0]?.id ??
        "";
  const actorLabels = disambiguatedActorLabels(model.actors);
  return (
    <View style={styles.root}>
      <Text style={[styles.title, { color: colors.fg }]}>The match line</Text>
      <Text style={[styles.note, { color: colors.fgMuted }]}>Tap any mark to inspect that exact round.</Text>
      <ActionRibbon
        evidence={evidence}
        totalRounds={totalRounds}
        selectedRound={selectedRound.round}
        onSelectRound={onSelectRound}
        onSelectActor={onSelectActor}
      />
      <ScoreTrajectory
        spec={spec}
        evidence={evidence}
        selectedRound={selectedRound.round}
        totalRounds={totalRounds}
      />
      <SelectedRoundLens
        round={selectedRound}
        totalRounds={totalRounds}
        onSelectActor={onSelectActor}
      />
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <Text style={[styles.sectionTitle, { color: colors.fg }]}>Strategy shape</Text>
      <Text style={[styles.note, { color: colors.fgMuted }]}>The pattern is shown; what it means is still yours to explain.</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actorTabs}>
        {model.actors.map((actor, index) => {
          const selected = actor.id === activeShapeActorId;
          return (
            <Pressable
              key={actor.id}
              onPress={() => setShapeActorId(actor.id)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.actorTab,
                {
                  backgroundColor: selected ? colors.violetSolid : colors.white,
                  borderColor: selected ? colors.violetSolid : colors.border,
                },
              ]}
            >
              <Text style={[styles.actorTabText, { color: selected ? colors.white : colors.fg }]}>
                {actorLabels[index]}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Text style={[styles.eyebrow, { color: colors.fgMuted }]}>WHAT I DID NEXT, AFTER WHAT I SAW</Text>
      <ResponseMatrix actorId={activeShapeActorId} evidence={evidence} />
      <Text style={[styles.eyebrow, { color: colors.fgMuted }]}>WHICH RULE FIRED</Text>
      <RuleBands
        actorId={activeShapeActorId}
        evidence={evidence}
        selectedRound={selectedRound.round}
        totalRounds={totalRounds}
      />
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <MatchPayoffTable spec={spec} selectedRound={selectedRound} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 12 },
  title: { fontFamily: fonts.bold, fontSize: 20 },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 15 },
  eyebrow: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.8, marginTop: 4 },
  note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17 },
  empty: { fontFamily: fonts.regular, fontSize: 14, paddingVertical: 18 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  ribbonSection: { gap: 9 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendSwatch: { width: 10, height: 10, borderRadius: 2 },
  fractureLegend: { width: 9, height: 9, backgroundColor: "#D92D20", borderRadius: 1, transform: [{ rotate: "45deg" }] },
  legendText: { fontFamily: fonts.regular, fontSize: 10 },
  ribbonRows: { flexDirection: "row", gap: 8 },
  ribbonLabels: { width: 104, gap: 6 },
  ribbonLabelButton: { height: 30, justifyContent: "center" },
  ribbonLabel: { fontFamily: fonts.semibold, fontSize: 12 },
  ribbonScroll: { flex: 1 },
  ribbonTracks: { gap: 6 },
  ribbonTrack: { flexDirection: "row", gap: 2 },
  actionCell: { width: 26, height: 30, borderRadius: 3 },
  selectedActionCell: { borderWidth: 2, borderColor: "#172033" },
  fracture: { position: "absolute", top: -3, right: -3, width: 8, height: 8, backgroundColor: "#D92D20", borderColor: "white", borderWidth: 1, borderRadius: 1, transform: [{ rotate: "45deg" }] },
  actorLine: { width: 18, height: 3 },
  lens: { backgroundColor: "#172A4D", borderRadius: 16, padding: 14, gap: 10 },
  lensEyebrow: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.8, color: "#8DE2E4" },
  lensCard: { backgroundColor: "rgba(255,255,255,0.09)", borderRadius: 12, padding: 12, gap: 4 },
  actorHead: { flexDirection: "row", justifyContent: "space-between", gap: 10 },
  lensActor: { flex: 1, fontFamily: fonts.bold, fontSize: 14, color: "white" },
  lensAction: { fontFamily: fonts.semibold, fontSize: 12, color: "white" },
  lensDetail: { fontFamily: fonts.regular, fontSize: 11, lineHeight: 16, color: "rgba(255,255,255,0.82)" },
  lensMuted: { fontFamily: fonts.regular, fontSize: 10, lineHeight: 15, color: "rgba(255,255,255,0.65)", marginTop: 3 },
  fractureCopy: { fontFamily: fonts.semibold, fontSize: 10, lineHeight: 15, color: "#FFCE8A" },
  matrix: { borderWidth: StyleSheet.hairlineWidth },
  matrixRow: { flexDirection: "row" },
  matrixLabelCell: { flex: 0.8, minHeight: 72, padding: 7, justifyContent: "center" },
  matrixCell: { flex: 1, minHeight: 72, borderLeftWidth: StyleSheet.hairlineWidth, borderTopWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center", padding: 6 },
  matrixText: { fontFamily: fonts.regular, fontSize: 10, textAlign: "center" },
  bubble: { alignItems: "center", justifyContent: "center" },
  bubbleText: { fontFamily: fonts.bold, fontSize: 13 },
  ruleBands: { gap: 8 },
  ruleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  ruleLabel: { width: 116, fontFamily: fonts.regular, fontSize: 10 },
  ruleTrack: { flex: 1, height: 18, flexDirection: "row", gap: 1 },
  ruleCell: { flex: 1, minWidth: 1, borderWidth: 1, borderRadius: 1 },
  actorTabs: { gap: 8 },
  actorTab: { minHeight: 36, justifyContent: "center", paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8 },
  actorTabText: { fontFamily: fonts.semibold, fontSize: 12 },
  table: { borderWidth: StyleSheet.hairlineWidth },
  tableRow: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth },
  tableHead: { flex: 1, fontFamily: fonts.semibold, fontSize: 10, padding: 8 },
  tableCell: { flex: 1, fontFamily: fonts.regular, fontSize: 11, padding: 8 },
  selectedTableCell: { borderWidth: 1, borderColor: "#7C3AED" },
});
