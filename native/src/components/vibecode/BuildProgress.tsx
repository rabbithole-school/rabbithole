/**
 * Honest build progress for the App designer (TRA-319) — the native twin of
 * web's `components/vibecode/BuildProgress.tsx`.
 *
 * A first app build takes 1–3.5 minutes and, until now, the native preview said
 * nothing legible while it ran: it sat on the "Describe the app you want to
 * build" empty state even though the kickoff had already fired. This card names
 * the stage the build is actually in — derived from the tutor stream (see
 * `shared/buildStage.ts`) — with a running clock and a Stop control.
 *
 * One canonical rendering per signal (T1): the preview `variant="card"` and the
 * chat `variant="line"` both read the SAME derived stage, so the surfaces never
 * disagree. The stage labels/subtitle match web verbatim.
 */

import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";

import { fonts, useColors } from "@/theme";
import {
  BUILD_STAGE_ORDER,
  buildStageIndex,
  type BuildStage,
} from "../../../vendor/shared/buildStage";
import { formatElapsed } from "./buildProgressFormat";

const STAGE_META: Record<BuildStage, { label: string; subtitle?: string }> = {
  planning: { label: "Planning the app", subtitle: "usually a minute or two" },
  writing: { label: "Writing the app" },
  looking: { label: "Looking at what it built" },
  fixing: { label: "Fixing what it saw" },
};

/** The one canonical label for a stage — reused by the overlay pill so the
 *  preview, the chat line, and the "editing an existing app" pill share one
 *  vocabulary (T1). */
export function buildStageLabel(stage: BuildStage): string {
  return STAGE_META[stage].label;
}

/** m:ss elapsed since `startedAt`, ticking once a second. */
function useElapsedLabel(startedAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return formatElapsed(now - startedAt);
}

export function BuildProgress({
  variant,
  stage,
  startedAt,
  onStop,
}: {
  variant: "card" | "line";
  stage: BuildStage;
  startedAt: number;
  onStop?: () => void;
}) {
  const colors = useColors();
  const elapsed = useElapsedLabel(startedAt);
  const activeIndex = buildStageIndex(stage);
  const meta = STAGE_META[stage];

  if (variant === "line") {
    return (
      <View
        style={styles.line}
        accessibilityRole="text"
        accessibilityLabel={`Building the app — ${meta.label}`}
      >
        <ActivityIndicator size="small" color={colors.violet} />
        <Text style={[styles.lineLabel, { color: colors.fg }]}>{meta.label}</Text>
        <Text style={[styles.lineElapsed, { color: colors.fgMuted }]}>
          {elapsed}
        </Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.bg, borderColor: colors.border },
      ]}
    >
      {/* The status is one summary element for VoiceOver; the container itself
          is NOT labelled, or it would swallow the Stop button below. */}
      <View
        accessible
        accessibilityRole="summary"
        accessibilityLabel={`Building the app — ${meta.label}`}
        style={styles.stageList}
      >
      {BUILD_STAGE_ORDER.map((s, index) => {
        const isComplete = index < activeIndex;
        const isActive = index === activeIndex;
        const stageMeta = STAGE_META[s];
        return (
          <View key={s} style={styles.stageRow}>
            <View style={styles.stageIcon}>
              {isComplete ? (
                <SymbolView name="checkmark" size={14} tintColor={colors.violet} />
              ) : isActive ? (
                <ActivityIndicator size="small" color={colors.violet} />
              ) : (
                <View style={[styles.dot, { borderColor: colors.gray300 }]} />
              )}
            </View>
            <View style={styles.stageTextBlock}>
              <Text
                style={[
                  styles.stageLabel,
                  {
                    fontFamily: isActive ? fonts.bold : fonts.medium,
                    color: isActive
                      ? colors.fg
                      : isComplete
                        ? colors.fgMuted
                        : colors.charcoalSubtle,
                  },
                ]}
              >
                {stageMeta.label}
              </Text>
              {isActive && stageMeta.subtitle ? (
                <Text style={[styles.stageSubtitle, { color: colors.fgMuted }]}>
                  {stageMeta.subtitle}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
      </View>

      <View style={[styles.footer, { borderTopColor: colors.gray100 }]}>
        <Text style={[styles.elapsed, { color: colors.fgMuted }]}>{elapsed}</Text>
        {onStop ? (
          <Pressable
            onPress={onStop}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Stop generating"
          >
            <Text style={[styles.stopText, { color: colors.fgMuted }]}>Stop</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The settled recovery card shown when a build stream ends with NO app — a
 * Stop, a rejected fetch, an SSE error, or `done` with no code artifact. It
 * replaces the ticking progress card so the surface stops advancing and offers
 * an honest way forward. Copy matches web verbatim.
 */
export function BuildStopped({ onRetry }: { onRetry?: () => void }) {
  const colors = useColors();
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.bg, borderColor: colors.border },
      ]}
    >
      <Text
        accessibilityRole="header"
        style={[styles.stoppedTitle, { color: colors.fg }]}
      >
        The build stopped before an app appeared
      </Text>
      <Text style={[styles.stoppedBody, { color: colors.fgMuted }]}>
        Try again, or describe what to build.
      </Text>
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Try again"
          style={[styles.retryButton, { backgroundColor: colors.violetSolid }]}
        >
          <Text style={[styles.retryText, { color: colors.white }]}>
            Try again
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: "row", alignItems: "center", gap: 8 },
  lineLabel: { fontFamily: fonts.semibold, fontSize: 14 },
  lineElapsed: { fontFamily: fonts.semibold, fontSize: 12 },

  card: {
    width: "100%",
    maxWidth: 360,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 20,
    gap: 12,
  },
  stageList: { gap: 12 },
  stageRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  stageIcon: {
    width: 20,
    height: 20,
    marginTop: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 8, height: 8, borderRadius: 4, borderWidth: 1.5 },
  stageTextBlock: { flex: 1, gap: 2 },
  stageLabel: { fontSize: 14 },
  stageSubtitle: { fontFamily: fonts.regular, fontSize: 12 },

  footer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 12,
    marginTop: 4,
  },
  elapsed: { fontFamily: fonts.semibold, fontSize: 12 },
  stopText: { fontFamily: fonts.semibold, fontSize: 13 },

  stoppedTitle: { fontFamily: fonts.bold, fontSize: 14 },
  stoppedBody: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18 },
  retryButton: {
    alignSelf: "flex-start",
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  retryText: { fontFamily: fonts.semibold, fontSize: 13 },
});
