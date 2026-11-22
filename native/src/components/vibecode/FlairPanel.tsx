// The Flair tab: the session's earned flair (the same deliverable.flairEarned
// + criteria + art FlairChips renders), with room for each award's note, plus
// the builder's one open question to figure out (sessions.provocation).
import { useQuery } from "convex/react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { FlairMark, flairInitial, type FlairEarned } from "../FlairChips";
import { withSpottedFlair } from "../../../vendor/shared/spottedFlair";
import { YOUR_MISSION_LABEL } from "../../../vendor/shared/missionFlair";

export type FlairPanelProps = {
  /** The permanent flair awarded on this deliverable (same as FlairChips). */
  flairEarned?: FlairEarned[];
  /** The active deliverable's criteria (same as FlairChips). */
  criteria: Array<{ id: string; label: string; description?: string }>;
  /** Scopes the generated art lookup to this deliverable (same as FlairChips). */
  deliverableId?: Id<"deliverables"> | null;
  /** The session whose spotted flair joins the list (same as FlairChips). */
  sessionId: Id<"sessions">;
  /** A mission app's MUST BE TRUE lines as the scholar reads them
   *  (shared/missionFlair missionLines); empty for any other app. */
  missionLines?: readonly string[];
  /** One open question to figure out. */
  provocation?: string | null;
  /** Ask about the question in chat (the builder lays it out and invites an
   *  experiment the scholar designs). */
  onSayMore?: () => void;
  /** The app holds an experiment (its EXPERIMENT START marker). */
  experimentRunning?: boolean;
  /** Ask the builder to remove the experiment. */
  onEndExperiment?: () => void;
  /** Check my work, for an app graded by a teacher's checklist (no mission
   *  lines): its flair is earned only by a check. Absent = no check offered
   *  (a mission app earns flair while it builds). */
  check?: {
    onCheck: () => void;
    /** The checklist could not be prepared: the button retries it. */
    onRetry: () => void;
    busy: boolean;
    preparing: boolean;
    failed: boolean;
    disabled: boolean;
  } | null;
};

export function FlairPanel({
  flairEarned,
  criteria,
  deliverableId,
  sessionId,
  missionLines = [],
  provocation,
  onSayMore,
  experimentRunning = false,
  onEndExperiment,
  check,
}: FlairPanelProps) {
  const colors = useColors();
  // Same art lookup as FlairChips.
  const art = useQuery(
    api.flairArt.forDeliverable,
    deliverableId ? { deliverableId } : "skip",
  );

  // Spotted flair (the observer's award for an idea no criterion listed)
  // joins the list the way FlairChips folds it in.
  const spotted = useQuery(api.spottedFlair.forSession, { sessionId });
  const merged = withSpottedFlair(flairEarned, criteria, spotted);
  const criterionById = new Map(merged.criteria.map((c) => [c.id, c]));
  const artByCriterionId = new Map((art ?? []).map((a) => [a.criterionId, a]));

  // Earned only, newest first. Criteria that aren't earned are never shown.
  const rows = [...merged.flairEarned]
    .sort((a, b) => b.earnedAt - a.earnedAt)
    .flatMap((flair) => {
      const criterion = criterionById.get(flair.criterionId);
      if (!criterion) return [];
      const generated = artByCriterionId.get(flair.criterionId);
      return [
        {
          key: flair.criterionId,
          label: criterion.label,
          // Scholar-facing note only, never the grader-facing description
          // (same choice as FlairChips).
          note: flair.note ?? generated?.note,
          initial: generated?.initial ?? flairInitial(criterion.label),
          imageUrl: generated?.imageUrl ?? null,
        },
      ];
    });

  const card = {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: 12,
    padding: 12,
    backgroundColor: colors.white,
  } as const;
  const eyebrow = {
    fontFamily: fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.6,
    color: colors.fgMuted,
    textTransform: "uppercase",
  } as const;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {missionLines.length > 0 ? (
        <View style={styles.section}>
          <Text style={eyebrow}>{YOUR_MISSION_LABEL}</Text>
          <View style={[card, styles.missionCard]}>
            {missionLines.map((line, index) => (
              <Text key={index} style={[styles.missionLine, { color: colors.fg }]}>
                {line}
              </Text>
            ))}
          </View>
        </View>
      ) : null}
      {provocation ? (
        <View style={styles.section}>
          <Text style={eyebrow}>Something to figure out</Text>
          <View style={[card, styles.provocationRow]}>
            <Text style={[styles.provocation, { color: colors.fg }]}>
              {provocation}
            </Text>
            {experimentRunning && onEndExperiment ? (
              <Pressable
                onPress={onEndExperiment}
                accessibilityRole="button"
                accessibilityLabel="End experiment"
                style={[styles.sayMore, { borderColor: colors.border }]}
              >
                <Text style={[styles.sayMoreText, { color: colors.violet }]}>
                  End experiment
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onSayMore}
              accessibilityRole="button"
              accessibilityLabel="Say more"
              style={[styles.sayMore, { borderColor: colors.border }]}
            >
              <Text style={[styles.sayMoreText, { color: colors.violet }]}>
                Say more
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {!provocation && experimentRunning && onEndExperiment ? (
        <View style={styles.section}>
          <Text style={eyebrow}>Experiment</Text>
          <View style={[card, styles.provocationRow]}>
            <Text style={[styles.provocation, { color: colors.fg }]}>
              An experiment is running in your app.
            </Text>
            <Pressable
              onPress={onEndExperiment}
              accessibilityRole="button"
              accessibilityLabel="End experiment"
              style={[styles.sayMore, { borderColor: colors.border }]}
            >
              <Text style={[styles.sayMoreText, { color: colors.violet }]}>
                End experiment
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={eyebrow}>What you’ve figured out</Text>
        {rows.length === 0 ? (
          <Text style={[styles.empty, { color: colors.fgMuted }]}>
            Flair shows up here when you figure something out.
          </Text>
        ) : (
          rows.map((row) => (
            <View key={row.key} style={[card, styles.flairRow]}>
              <FlairMark
                imageUrl={row.imageUrl}
                initial={row.initial}
                label={row.label}
              />
              <View style={styles.flairText}>
                <Text style={[styles.label, { color: colors.fg }]}>
                  {row.label}
                </Text>
                {row.note ? (
                  <Text style={[styles.note, { color: colors.fgMuted }]}>
                    {row.note}
                  </Text>
                ) : null}
              </View>
            </View>
          ))
        )}
        {check ? (
          <Pressable
            onPress={
              check.failed
                ? check.onRetry
                : check.busy || check.preparing || check.disabled
                  ? undefined
                  : check.onCheck
            }
            accessibilityRole="button"
            accessibilityLabel={
              check.failed ? "Try preparing the rubric check again" : "Check my work"
            }
            accessibilityState={{
              disabled: !check.failed && (check.busy || check.preparing || check.disabled),
            }}
            style={[
              styles.checkButton,
              {
                backgroundColor: colors.violetSolid,
                opacity:
                  !check.failed && (check.busy || check.preparing || check.disabled)
                    ? 0.5
                    : 1,
              },
            ]}
          >
            {check.busy || check.preparing ? (
              <ActivityIndicator size="small" color={colors.white} />
            ) : null}
            <Text style={[styles.checkText, { color: colors.white }]}>
              {check.failed
                ? "Try preparing check again"
                : check.preparing
                  ? "Preparing check…"
                  : "Check my work"}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 4, gap: 16 },
  section: { gap: 8 },
  provocationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  provocation: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
  },
  sayMore: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 17,
    height: 34,
    paddingHorizontal: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  sayMoreText: { fontFamily: fonts.semibold, fontSize: 13 },
  missionCard: { gap: 6 },
  missionLine: { fontFamily: fonts.regular, fontSize: 15 },
  checkButton: {
    flexDirection: "row",
    alignSelf: "flex-start",
    alignItems: "center",
    gap: 8,
    height: 38,
    paddingHorizontal: 16,
    borderRadius: 12,
  },
  checkText: { fontFamily: fonts.semibold, fontSize: 14 },
  flairRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  flairText: { flex: 1, gap: 2 },
  label: { fontFamily: fonts.semibold, fontSize: 15 },
  note: { fontFamily: fonts.regular, fontSize: 14 },
  empty: { fontFamily: fonts.regular, fontSize: 14 },
});
