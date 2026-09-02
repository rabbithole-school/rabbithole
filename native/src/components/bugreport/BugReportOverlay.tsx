import { useMemo } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SymbolView } from "expo-symbols";

import { fonts, type Colors, useColors } from "@/theme";

export type BugReportPhase =
  | "idle"
  | "held"
  | "recording"
  | "cancel-window"
  | "sending"
  | "saved"
  | "failed";

type BugReportOverlayProps = {
  phase: BugReportPhase;
  reporterName: string;
  audioUnavailable: boolean;
  level: number;
  durationMs: number;
  isCapped: boolean;
  isOffline: boolean;
  error: string | null;
  reportSaved: boolean;
  onCancelSend: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onTestRelease: () => void;
  onTestRetryPending: () => void;
};

const BARS = 13;

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function BugReportOverlay({
  phase,
  reporterName,
  audioUnavailable,
  level,
  durationMs,
  isCapped,
  isOffline,
  error,
  reportSaved,
  onCancelSend,
  onRetry,
  onDismiss,
  onTestRelease,
  onTestRetryPending,
}: BugReportOverlayProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const visible = phase !== "idle" && phase !== "held";

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      supportedOrientations={["landscape-left", "landscape-right"]}
    >
      <View style={styles.backdrop}>
        {__DEV__ && phase === "recording" && (
          <Pressable
            accessible
            accessibilityLabel="Release bug report test capture"
            accessibilityRole="button"
            onPress={onTestRelease}
            style={styles.axRelease}
          />
        )}
        {__DEV__ && phase === "cancel-window" && (
          <Pressable
            accessible
            accessibilityLabel="Retry pending bug report test"
            accessibilityRole="button"
            onPress={onTestRetryPending}
            style={styles.axRelease}
          />
        )}
        {phase === "recording" && (
          <View
            style={styles.card}
            accessible
            accessibilityLabel="Recording bug report"
          >
            <View style={styles.iconCircle}>
              <SymbolView
                name={audioUnavailable ? "mic.slash.fill" : "waveform"}
                size={30}
                tintColor={colors.white}
              />
            </View>
            <Text style={styles.title}>
              {audioUnavailable
                ? "Audio unavailable"
                : "Recording bug report"}
            </Text>
            <Text style={styles.body}>
              {audioUnavailable
                ? "Release to send the screenshot."
                : isCapped
                  ? "Audio reached 1:00. Release to send."
                  : "Say what went wrong, release to send."}
            </Text>
            {!audioUnavailable && (
              <View style={styles.meter}>
                <View style={styles.wave}>
                  {Array.from({ length: BARS }, (_, index) => {
                    const centerWeight =
                      0.4 +
                      0.6 * Math.sin((index / (BARS - 1)) * Math.PI);
                    const wobble =
                      0.6 +
                      0.4 *
                        Math.abs(
                          Math.sin(durationMs / 220 + index * 0.75),
                        );
                    return (
                      <View
                        key={index}
                        style={[
                          styles.waveBar,
                          {
                            height:
                              5 +
                              Math.max(0.08, level) *
                                34 *
                                centerWeight *
                                wobble,
                          },
                        ]}
                      />
                    );
                  })}
                </View>
                <Text style={styles.timer}>{formatDuration(durationMs)}</Text>
              </View>
            )}
            <Text style={styles.context}>
              Captured while signed in as {reporterName}.
            </Text>
          </View>
        )}

        {phase === "cancel-window" && (
          <Pressable
            style={[styles.card, styles.cancelCard]}
            onPress={onCancelSend}
            accessibilityRole="button"
            accessibilityLabel="Sending bug report — tap to cancel"
          >
            <ActivityIndicator color={colors.violet} size="large" />
            <Text style={styles.title}>
              Sending bug report — tap to cancel
            </Text>
            <Text style={styles.body}>
              The report is saved on this iPad until it sends.
            </Text>
          </Pressable>
        )}

        {phase === "sending" && (
          <View style={styles.card} accessible accessibilityLabel="Sending bug report">
            <ActivityIndicator color={colors.violet} size="large" />
            <Text style={styles.title}>Sending bug report</Text>
          </View>
        )}

        {phase === "saved" && (
          <View
            style={styles.card}
            accessible
            accessibilityLabel="Saved — we'll take it from here"
          >
            <View style={[styles.iconCircle, styles.savedIcon]}>
              <SymbolView
                name="checkmark"
                size={30}
                tintColor={colors.white}
              />
            </View>
            <Text style={styles.title}>
              Saved — we&apos;ll take it from here
            </Text>
          </View>
        )}

        {phase === "failed" && (
          <View style={styles.card} accessible accessibilityLabel="Bug report failed">
            <View style={[styles.iconCircle, styles.failedIcon]}>
              <SymbolView
                name="exclamationmark"
                size={28}
                tintColor={colors.white}
              />
            </View>
            <Text style={styles.title}>
              {!reportSaved
                ? "Couldn't save your report"
                : isOffline
                  ? "Saved on this iPad"
                  : "Couldn't send yet"}
            </Text>
            <Text style={styles.body}>
              {!reportSaved
                ? "Something went wrong before it was stored. Try the three-finger hold again."
                : isOffline
                  ? "We'll send the report when this iPad is back online."
                  : "Your report is still saved. Try sending it again."}
            </Text>
            {!!error && (!reportSaved || !isOffline) && (
              <Text style={styles.errorText}>{error}</Text>
            )}
            <View style={styles.actions}>
              <Pressable
                style={styles.secondaryButton}
                onPress={onDismiss}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryButtonText}>Dismiss</Text>
              </Pressable>
              {reportSaved && (
                <Pressable
                  style={styles.primaryButton}
                  onPress={onRetry}
                  accessibilityRole="button"
                >
                  <Text style={styles.primaryButtonText}>Retry</Text>
                </Pressable>
              )}
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(15, 18, 38, 0.58)",
      padding: 32,
    },
    card: {
      width: "100%",
      maxWidth: 560,
      minHeight: 300,
      alignItems: "center",
      justifyContent: "center",
      gap: 16,
      paddingHorizontal: 48,
      paddingVertical: 40,
      borderRadius: 30,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
    },
    cancelCard: {
      borderColor: colors.violet,
    },
    iconCircle: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.violet,
    },
    savedIcon: {
      backgroundColor: colors.statusGreen,
    },
    failedIcon: {
      backgroundColor: colors.statusRed,
    },
    title: {
      fontFamily: fonts.bold,
      fontSize: 28,
      lineHeight: 34,
      color: colors.navy,
      textAlign: "center",
    },
    body: {
      fontFamily: fonts.regular,
      fontSize: 19,
      lineHeight: 27,
      color: colors.fgMuted,
      textAlign: "center",
    },
    context: {
      fontFamily: fonts.medium,
      fontSize: 14,
      color: colors.charcoalMuted,
      textAlign: "center",
    },
    meter: {
      width: "100%",
      flexDirection: "row",
      alignItems: "center",
      gap: 16,
    },
    wave: {
      flex: 1,
      height: 46,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
    },
    waveBar: {
      width: 5,
      borderRadius: 3,
      backgroundColor: colors.violet,
    },
    timer: {
      minWidth: 48,
      fontFamily: fonts.semibold,
      fontSize: 17,
      color: colors.charcoalMuted,
      fontVariant: ["tabular-nums"],
      textAlign: "right",
    },
    errorText: {
      fontFamily: fonts.regular,
      fontSize: 13,
      color: colors.statusRed,
      textAlign: "center",
    },
    actions: {
      flexDirection: "row",
      gap: 12,
      marginTop: 4,
    },
    primaryButton: {
      minWidth: 130,
      alignItems: "center",
      borderRadius: 24,
      backgroundColor: colors.violetSolid,
      paddingHorizontal: 24,
      paddingVertical: 13,
    },
    primaryButtonText: {
      fontFamily: fonts.semibold,
      fontSize: 17,
      color: colors.white,
    },
    secondaryButton: {
      minWidth: 130,
      alignItems: "center",
      borderRadius: 24,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 24,
      paddingVertical: 13,
    },
    secondaryButtonText: {
      fontFamily: fonts.semibold,
      fontSize: 17,
      color: colors.fg,
    },
    axRelease: {
      position: "absolute",
      left: 1,
      bottom: 1,
      width: 2,
      height: 2,
    },
  });
}
