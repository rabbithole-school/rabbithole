/**
 * The downsampled criterion series (plan §7.2 MetricStrip). SVG polylines over
 * the run's summary series + the current values as neutral chips. It reports the
 * numbers; it never explains why a number moved (§4.3).
 */

import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, G, Line, Polyline } from "react-native-svg";

import { fonts, useColors } from "@/theme";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";
import { ecosystemBiome } from "../../../vendor/simulator/ecosystemTerrainTiles";
import type { PopulationTraitEvidence } from "../../../vendor/simulator/scene";
import { ECOSYSTEM_TRAIT_DOMAIN } from "../../../vendor/simulator/templates/ecosystemGrid";
import type { SimulatorRun } from "./useWorkbenchData";
import { chartMetricKeys, chartTimeSpan, criterionMetricKey, formatMetric, metricLabel } from "./helpers";
import { workbenchTimeNoun } from "./workbenchTerminology";

const SERIES_COLORS = ["#7C3AED", "#0E7490", "#C2410C", "#15803D"];
const WIDTH = 300;
const HEIGHT = 52;

function PopulationTraitBand({
  evidence,
  targetTicks,
  selectedTick,
}: {
  evidence: PopulationTraitEvidence;
  targetTicks: number;
  selectedTick?: number;
}) {
  const colors = useColors();
  const chartTickSpan = chartTimeSpan(evidence.samples, targetTicks);
  const domain = evidence.metricKey === "traitMean"
    ? ECOSYSTEM_TRAIT_DOMAIN.metabolic
    : ECOSYSTEM_TRAIT_DOMAIN.perception;
  const span = domain.max - domain.min;
  return (
    <View style={styles.band}>
      <Text style={[styles.label, { color: colors.fgMuted }]}>
        {evidence.label} · each mark is one living animal
      </Text>
      <Svg width={WIDTH} height={HEIGHT}>
        {evidence.samples.flatMap((sample) =>
          sample.values.map((value, index) => (
            <Circle
              key={`${sample.tick}:${index}`}
              cx={(sample.tick / chartTickSpan) * WIDTH}
              cy={HEIGHT - ((value - domain.min) / span) * (HEIGHT - 8) - 4}
              r={2.4}
              fill={colors.violet}
              fillOpacity={0.78}
            />
          )),
        )}
        {selectedTick !== undefined ? (
          <Line
            x1={(selectedTick / chartTickSpan) * WIDTH}
            x2={(selectedTick / chartTickSpan) * WIDTH}
            y1={0}
            y2={HEIGHT}
            stroke={colors.fg}
            strokeWidth={1.5}
          />
        ) : null}
      </Svg>
    </View>
  );
}

export function MetricStrip({
  run,
  spec,
  selectedTick,
  populationTraitEvidence,
}: {
  run: SimulatorRun;
  spec: SimulatorSpec;
  selectedTick?: number;
  populationTraitEvidence?: PopulationTraitEvidence;
}) {
  const colors = useColors();
  const series = run.summarySeries;
  const criterionKey = criterionMetricKey(spec);
  const keys = useMemo(() => {
    if (spec.templateId !== "ecosystemGrid") return chartMetricKeys(spec, series);
    const available = new Set(
      series.flatMap((sample) => sample.values.map((value) => value.key)),
    );
    const usesDistributionBand =
      populationTraitEvidence !== undefined &&
      populationTraitEvidence.samples.length >= 2 &&
      (criterionKey === "traitMean" || criterionKey === "perceptionMean");
    const ecosystemKeys = usesDistributionBand || !criterionKey
      ? ["livingAutomata", "resourceBiomass"]
      : ["livingAutomata", "resourceBiomass", criterionKey];
    return [...new Set(ecosystemKeys)].filter(
      (key) => available.has(key),
    );
  }, [criterionKey, populationTraitEvidence, spec, series]);
  const timeNoun = workbenchTimeNoun(spec);

  if (series.length < 2 && !populationTraitEvidence) {
    return (
      <Text style={[styles.hint, { color: colors.fgMuted }]}>metrics appear as the run ticks</Text>
    );
  }

  const chartTickSpan = series.length >= 2 ? chartTimeSpan(series, run.targetTicks) : 1;
  const terminalTick =
    run.haltReason === "terminal_physics" &&
    (timeNoun === "day" || run.latestCommittedTick < run.targetTicks)
      ? run.latestCommittedTick
      : null;
  const bounds = keys.map((metricKey) => {
    const values = series.flatMap((sample) =>
      sample.values.filter((value) => value.key === metricKey).map((value) => value.value),
    );
    return { min: Math.min(0, ...values), max: Math.max(1, ...values) };
  });

  return (
    <View style={styles.root}>
      <Text style={[styles.label, { color: colors.fgMuted }]}>
        {spec.templateId === "ecosystemGrid"
          ? `Population + ${ecosystemBiome(spec.config.biome).resource.label.toLowerCase()}`
          : "Run trace"}{" "}
        · sampled
      </Text>
      <View style={styles.row}>
      {series.length >= 2 ? (
        <Svg width={WIDTH} height={HEIGHT}>
          {keys.map((metricKey, ki) => {
          const { min, max } = bounds[ki];
          const span = max - min || 1;
          const points = series.flatMap((sample) => {
              const value = sample.values.find((candidate) => candidate.key === metricKey);
              if (!value) return [];
              return [{
                x: (sample.tick / chartTickSpan) * WIDTH,
                y: HEIGHT - ((value.value - min) / span) * (HEIGHT - 4) - 2,
              }];
            });
          return (
            <G key={metricKey}>
              <Polyline
                points={points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
                fill="none"
                stroke={SERIES_COLORS[ki % SERIES_COLORS.length]}
                strokeWidth={metricKey === criterionKey ? 2 : 1.5}
                strokeOpacity={metricKey === criterionKey ? 1 : 0.72}
              />
              {points.map((point, index) => (
                <Circle
                  key={index}
                  cx={point.x}
                  cy={point.y}
                  r={1.8}
                  fill={SERIES_COLORS[ki % SERIES_COLORS.length]}
                />
              ))}
            </G>
          );
          })}
          {selectedTick !== undefined ? (
            <Line
              x1={(selectedTick / chartTickSpan) * WIDTH}
              x2={(selectedTick / chartTickSpan) * WIDTH}
              y1={0}
              y2={HEIGHT}
              stroke={colors.fg}
              strokeWidth={1.5}
            />
          ) : null}
          {terminalTick !== null ? (
            <Polyline
              points={`${((terminalTick / chartTickSpan) * WIDTH).toFixed(1)},0 ${((terminalTick / chartTickSpan) * WIDTH).toFixed(1)},${HEIGHT}`}
              fill="none"
              stroke="#78716C"
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          ) : null}
        </Svg>
      ) : null}
      <View style={styles.legend}>
        {keys.map((metricKey, ki) => {
          const current = run.currentMetrics.find((metric) => metric.key === metricKey);
          return (
            <View key={metricKey} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: SERIES_COLORS[ki % SERIES_COLORS.length] }]} />
              <Text style={[styles.legendText, { color: colors.fgMuted }]}>
                {current
                  ? `${formatMetric(current.value)} ${metricLabel(metricKey, current.value)}`
                  : `— ${metricLabel(metricKey)}`}
              </Text>
            </View>
          );
        })}
        {terminalTick !== null ? (
          <Text style={[styles.terminal, { color: colors.fgMuted }]}>run stopped at {timeNoun} {terminalTick}</Text>
        ) : null}
      </View>
      </View>
      {populationTraitEvidence && populationTraitEvidence.samples.length >= 2 ? (
        <PopulationTraitBand
          evidence={populationTraitEvidence}
          targetTicks={run.targetTicks}
          selectedTick={selectedTick}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 4, paddingHorizontal: 16, paddingVertical: 7 },
  label: { fontFamily: fonts.bold, fontSize: 10, letterSpacing: 0.5 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  hint: { fontFamily: fonts.regular, fontSize: 12, paddingHorizontal: 16, paddingVertical: 6 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { fontFamily: fonts.regular, fontSize: 11 },
  terminal: { fontFamily: fonts.regular, fontSize: 11 },
  band: { gap: 2 },
});
