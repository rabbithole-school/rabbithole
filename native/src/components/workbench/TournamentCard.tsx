/**
 * Native twin of the web `TournamentCard`
 * (`components/workbench/TournamentCard.tsx`): shows the scholar's tournament
 * matches (Prisoner's-Dilemma-style worlds) inline under the Species deck —
 * one row per opponent with a Replay affordance, and once any match has
 * completed, a closing "what strategies thrived" lesson-stats line. Reads the
 * SAME `api.tournaments.forScholar` query as web; no native-only backend
 * logic. Web scholars already saw this — native scholars saw nothing, which
 * is the scholar-facing parity gap this component closes.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "convex/react";
import Svg, { Polyline } from "react-native-svg";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { REPLICATOR_GENERATION_COUNT } from "../../../vendor/simulator/replicator";
import type { WorkbenchRunId } from "./useWorkbenchData";

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function share(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function PopulationSparkline({ shares, color }: { shares: number[]; color: string }) {
  const width = 72;
  const height = 18;
  const padding = 2;
  const points = shares
    .map((value, index) => {
      const x =
        shares.length <= 1
          ? width / 2
          : padding + (index / (shares.length - 1)) * (width - padding * 2);
      const y = padding + (1 - Math.max(0, Math.min(1, value))) * (height - padding * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <Svg
      width={width}
      height={height}
      accessibilityRole="image"
      accessibilityLabel={`Population share over ${REPLICATOR_GENERATION_COUNT} generations`}
    >
      <Polyline points={points} fill="none" stroke={color} strokeWidth={1.25} />
    </Svg>
  );
}

export function TournamentCard({
  sessionId,
  onSelectRun,
}: {
  sessionId: Id<"sessions">;
  onSelectRun: (runId: WorkbenchRunId) => void;
}) {
  const colors = useColors();
  const tournament = useQuery(api.tournaments.forScholar, { sessionId });
  if (!tournament) return null;

  const anyCompleted = tournament.matches.some((match) => match.status === "completed");

  return (
    <View style={[styles.card, { borderTopColor: colors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.title, { color: colors.fg }]} numberOfLines={1}>
          Tournament · {tournament.ownDeckLabel}
        </Text>
        <Text style={[styles.status, { color: colors.fgMuted }]}>{tournament.status}</Text>
      </View>

      <View style={styles.matches}>
        {tournament.matches.map((match) => (
          <View key={match.pairingKey} style={[styles.matchRow, { borderColor: colors.border }]}>
            <View style={styles.matchMain}>
              <Text style={[styles.matchTitle, { color: colors.fg }]} numberOfLines={1}>
                vs {match.opponentDeckLabel}
              </Text>
              <Text style={[styles.matchMeta, { color: colors.fgMuted }]} numberOfLines={1}>
                {match.ownScore === null
                  ? match.status
                  : `${match.ownScore}–${match.opponentScore} · ${percent(match.cooperationRate ?? 0)} cooperate`}
              </Text>
            </View>
            {match.runId ? (
              <Pressable
                onPress={() => onSelectRun(match.runId!)}
                hitSlop={6}
                accessibilityRole="button"
                accessibilityLabel={`Replay ${tournament.ownDeckLabel} against ${match.opponentDeckLabel}`}
              >
                <Text style={[styles.replay, { color: colors.violet }]}>▶ Replay</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </View>

      {tournament.populationShare ? (
        <View style={[styles.population, { backgroundColor: colors.bgSubtle }]}>
          <View style={styles.populationHeader}>
            <Text style={[styles.lessonTitle, { color: colors.fg }]}>Population share</Text>
            <View style={styles.populationValue}>
              <PopulationSparkline shares={tournament.populationShare.history} color={colors.fgMuted} />
              <Text style={[styles.matchMeta, { color: colors.fg }]}>
                {share(tournament.populationShare.finalShare)}
              </Text>
            </View>
          </View>
          <Text style={[styles.lessonBody, { color: colors.fgMuted }]}>
            {REPLICATOR_GENERATION_COUNT} ecology generations show how this deck fares as the
            field changes. Standings are shares of the population, not scores, so the top
            scorer may not win: a deck that exploits its partners spreads at first, then
            starves as the decks it preyed on die out.
          </Text>
        </View>
      ) : null}

      {anyCompleted ? (
        <View style={[styles.lesson, { backgroundColor: colors.bgSubtle }]}>
          <Text style={[styles.lessonTitle, { color: colors.fg }]}>What strategies thrived</Text>
          <Text style={[styles.lessonBody, { color: colors.fgMuted }]}>
            The field cooperated {percent(tournament.lessonStats.cooperationRate)} of rounds and
            recorded {tournament.lessonStats.forgivenessEvents} forgiveness events.
            {tournament.lessonStats.forgivingDeckAverageScore !== null &&
            tournament.lessonStats.otherDeckAverageScore !== null
              ? ` Decks that forgave averaged ${tournament.lessonStats.forgivingDeckAverageScore.toFixed(1)} points per match; other decks averaged ${tournament.lessonStats.otherDeckAverageScore.toFixed(1)}.`
              : ""}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 10, marginTop: 10 },
  header: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 8,
  },
  title: { fontFamily: fonts.bold, fontSize: 11 },
  status: { fontFamily: fonts.regular, fontSize: 10, textTransform: "capitalize" },
  matches: { gap: 6 },
  matchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  matchMain: { flex: 1, minWidth: 0, gap: 1 },
  matchTitle: { fontFamily: fonts.semibold, fontSize: 11 },
  matchMeta: { fontFamily: fonts.regular, fontSize: 10 },
  replay: { fontFamily: fonts.semibold, fontSize: 11 },
  population: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 8, marginTop: 8, gap: 2 },
  populationHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  populationValue: { flexDirection: "row", alignItems: "center", gap: 8 },
  lesson: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 8, marginTop: 8, gap: 2 },
  lessonTitle: { fontFamily: fonts.bold, fontSize: 10 },
  lessonBody: { fontFamily: fonts.regular, fontSize: 10, lineHeight: 15 },
});
