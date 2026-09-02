/**
 * The ▶ Run control + the hypothesis light-gate. A first run is baseline
 * exploration; after a completed scholar run, later launches capture a prediction
 * — better / worse / about the same / exploring — with an optional line. The
 * prediction is frozen with the run and is never a modal to reflex past.
 *
 * This is a pure LAUNCHER — the run manifest lives in History and the media
 * transport drives playback. The same control is centered for the first run,
 * then relocates to the bench dock; it is never mounted in both places.
 */

import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { GlassBar } from "@/components/Glass";
import { fonts, useColors } from "@/theme";
import type { SimulatorSpec } from "../../../vendor/simulator/contract";
import * as runLauncher from "../../../vendor/shared/simulatorRunLauncher";
import type { SimulatorRunListItem, WorkbenchRunId } from "./useWorkbenchData";
import { hypothesisLabel, predictionGateDecision, workbenchTimeNoun } from "./helpers";
import { AppTextInput } from "@/components/AppTextInput";

type Prediction = "better" | "worse" | "about_the_same" | "exploratory";
const PREDICTIONS: Prediction[] = ["better", "worse", "about_the_same", "exploratory"];

export function RunTray({
  sessionId,
  spec,
  onLaunched,
  deckDirty,
  deckVersion,
  hasCompletedRun,
  activeRun,
  placement = "dock",
}: {
  sessionId: Id<"sessions">;
  spec: SimulatorSpec;
  onLaunched: (runId: WorkbenchRunId) => void;
  deckDirty: boolean;
  deckVersion: number;
  hasCompletedRun: boolean;
  activeRun: SimulatorRunListItem | null;
  placement?: "dock" | "empty";
}) {
  const colors = useColors();
  const launchRun = useMutation(api.simulatorRuns.launchRun);
  const stopRun = useMutation(api.simulatorRuns.stopRun);
  const [gateOpen, setGateOpen] = useState(false);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [note, setNote] = useState("");
  const [launching, setLaunching] = useState(false);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (gateOpen && hasCompletedRun) {
      AccessibilityInfo.announceForAccessibility(
        "Prediction required. Choose what you expect this deck to do before running it.",
      );
    }
  }, [gateOpen, hasCompletedRun]);

  const doLaunch = async (hypothesis?: { prediction: Prediction; note?: string }) => {
    setLaunching(true);
    try {
      const result = await launchRun({
        sessionId,
        ...(hypothesis
          ? { hypothesis: { prediction: hypothesis.prediction, note: hypothesis.note || undefined } }
          : {}),
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      onLaunched(result.runId);
      setGateOpen(false);
      setPrediction(null);
      setNote("");
    } catch (error) {
      Alert.alert("Couldn't start", error instanceof Error ? error.message : "Could not start the run");
    } finally {
      setLaunching(false);
    }
  };

  const onRunPress = () => {
    if (deckDirty) return;
    const decision = predictionGateDecision({ hasCompletedRun, gateOpen, prediction });
    if (decision === "launch") {
      void doLaunch(prediction ? { prediction, note } : undefined);
      return;
    }
    if (decision === "open-gate") {
      setGateOpen(true);
    }
  };

  const timeNoun = workbenchTimeNoun(spec);
  const launchDisabled = launching || deckDirty;

  const onStopPress = async () => {
    if (!activeRun) return;
    setStopping(true);
    try {
      await stopRun({ runId: activeRun._id });
    } catch (error) {
      Alert.alert("Couldn't stop", error instanceof Error ? error.message : "Could not stop the run");
    } finally {
      setStopping(false);
    }
  };

  return (
    <View
      style={[
        styles.tray,
        placement === "dock"
          ? { minHeight: 52, justifyContent: "center" }
          : null,
      ]}
    >
      {placement === "empty" && !activeRun ? (
        <Text style={[styles.emptyHint, { color: colors.fg }]}>
          {runLauncher.firstRunHint(deckVersion)}
        </Text>
      ) : null}

      {activeRun ? (
        <View
          style={[styles.busyRow, { borderColor: colors.border, backgroundColor: colors.bg }]}
          accessibilityRole="summary"
          accessibilityLiveRegion="polite"
        >
          <Text style={[styles.busyText, { color: colors.fg }]}>
            {stopping
              ? "Stopping…"
              : timeNoun === "day"
                ? runLauncher.activeSimulatorRunLabel(activeRun)
                : activeRun.status === "queued"
                  ? "Queued"
                  : `Running · round ${activeRun.latestCommittedTick} of ${activeRun.targetTicks}`}
          </Text>
          <Pressable
            disabled={stopping}
            onPress={() => void onStopPress()}
            accessibilityRole="button"
            accessibilityLabel="Stop run"
            style={({ pressed }) => [
              styles.stopButton,
              { borderColor: colors.statusRed },
              pressed && !stopping ? styles.btnPressed : null,
            ]}
          >
            <Text style={[styles.stopText, { color: colors.statusRed }]}>Stop</Text>
          </Pressable>
        </View>
      ) : (
        <>
          {deckDirty ? (
            <Text style={[styles.warn, { color: colors.orange }]}>
              {runLauncher.DECK_DIRTY_HINT}
            </Text>
          ) : null}

          {gateOpen && hasCompletedRun ? (
            <GlassBar
              edge="none"
              isInteractive
              style={[styles.gate, { borderColor: colors.border }]}
            >
              <View style={styles.gateContent}>
                <Text accessibilityRole="header" style={[styles.gateTitle, { color: colors.fg }]}>
                  Before you run — what do you expect this deck to do?
                </Text>
                <View style={styles.chips}>
                  {PREDICTIONS.map((option) => (
                    <Pressable
                      key={option}
                      onPress={() => setPrediction(option)}
                      accessibilityRole="button"
                      accessibilityLabel={hypothesisLabel(option)}
                      accessibilityState={{ selected: prediction === option }}
                      style={[
                        styles.chip,
                        {
                          backgroundColor:
                            prediction === option
                              ? colors.violetSolid
                              : "rgba(255,255,255,0.52)",
                          borderColor: colors.violetMuted,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.chipText,
                          { color: prediction === option ? colors.white : colors.violet },
                        ]}
                      >
                        {hypothesisLabel(option)}
                      </Text>
                    </Pressable>
                  ))}
                </View>
                <AppTextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="why? (optional)"
                  placeholderTextColor={colors.fgMuted}
                  accessibilityLabel="Why do you expect that? Optional"
                  style={[styles.noteInput, { color: colors.fg, borderColor: colors.border }]}
                  multiline
                />
                <View style={styles.gateActions}>
                  <Pressable
                    disabled={!prediction || launchDisabled}
                    onPress={onRunPress}
                    accessibilityRole="button"
                    accessibilityLabel={runLauncher.START_SIMULATION_LABEL}
                    accessibilityState={{ disabled: !prediction || launchDisabled }}
                    style={({ pressed }) => [
                      styles.runBtn,
                      {
                        backgroundColor:
                          !prediction || launchDisabled
                            ? colors.gray200
                            : colors.violetSolid,
                      },
                      pressed && prediction && !launchDisabled ? styles.btnPressed : null,
                    ]}
                  >
                    {launching ? (
                      <ActivityIndicator size="small" color={colors.white} />
                    ) : (
                      <Text style={[styles.runBtnText, { color: colors.white }]}>
                        {runLauncher.START_SIMULATION_LABEL}
                      </Text>
                    )}
                  </Pressable>
                  <Pressable
                    onPress={() => setGateOpen(false)}
                    accessibilityRole="button"
                    accessibilityLabel="Cancel prediction"
                    style={styles.cancelBtn}
                  >
                    <Text style={[styles.cancelText, { color: colors.fgMuted }]}>Cancel</Text>
                  </Pressable>
                </View>
              </View>
            </GlassBar>
          ) : (
            <View style={styles.launchRow}>
              <Pressable
                disabled={launchDisabled}
                onPress={onRunPress}
                accessibilityRole="button"
                accessibilityLabel={runLauncher.START_SIMULATION_LABEL}
                accessibilityHint="Runs your current deck through the simulation"
                style={({ pressed }) => [
                  styles.launchButton,
                  {
                    backgroundColor: launchDisabled
                      ? colors.gray200
                      : colors.violetSolid,
                  },
                  pressed && !launchDisabled ? styles.btnPressed : null,
                ]}
              >
                {launching ? (
                  <ActivityIndicator size="small" color={colors.white} />
                ) : (
                  <Text style={[styles.launchButtonText, { color: colors.white }]}>
                    {runLauncher.START_SIMULATION_LABEL}
                  </Text>
                )}
              </Pressable>
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tray: { gap: 10 },
  emptyHint: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 24, textAlign: "center" },
  warn: { fontFamily: fonts.medium, fontSize: 12, textAlign: "center" },
  busyRow: {
    minHeight: 52,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  busyText: { flex: 1, fontFamily: fonts.semibold, fontSize: 14 },
  stopButton: {
    minHeight: 44,
    minWidth: 68,
    paddingHorizontal: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
  },
  stopText: { fontFamily: fonts.semibold, fontSize: 14 },
  gate: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: "hidden" },
  gateContent: { padding: 12, gap: 10 },
  gateTitle: { fontFamily: fonts.semibold, fontSize: 13 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  chipText: { fontFamily: fonts.medium, fontSize: 12 },
  noteInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: fonts.regular,
    fontSize: 13,
    minHeight: 44,
  },
  gateActions: { flexDirection: "row", alignItems: "center", gap: 10 },
  launchRow: { width: "100%", alignItems: "stretch", gap: 10 },
  launchButton: {
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  launchButtonText: { fontFamily: fonts.bold, fontSize: 15 },
  runBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 10,
  },
  btnPressed: { transform: [{ scale: 0.97 }], opacity: 0.85 },
  runBtnText: { fontFamily: fonts.semibold, fontSize: 14 },
  cancelBtn: { paddingHorizontal: 8, paddingVertical: 8 },
  cancelText: { fontFamily: fonts.medium, fontSize: 13 },
});
