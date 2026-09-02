/**
 * AppUnlockingOverlay — the blocking modal shown while a managed iPad is being
 * asked to lift its MDM restriction on an installed app (Google Sheets, LEGO
 * SPIKE) so the scholar's tile tap can actually open it.
 *
 * Design intent:
 *  • It shows the APP, not a generic spinner: the same squircle icon treatment
 *    the launcher tile uses, so the scholar sees the thing they tapped.
 *  • The bar sets a wait expectation without pretending to read MDM progress:
 *    it fills over the normal 16-second window, while readiness remains gated
 *    on the backend plus this iPad's own canOpenURL result.
 *  • Cancel stays available while the unlock gate is safe to abandon. It
 *    disappears only for the short final handoff after ASAM release begins.
 *  • On failure it turns into a plain retry/cancel dialog. It never claims the
 *    app opened.
 *
 * Only rendered by NativeAppLaunchProvider, which owns the single in-flight
 * launch — there is never more than one of these on screen.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import {
  UNLOCK_PROGRESS_ESTIMATE_MS,
  unlockEstimatedProgress,
  unlockAccessibilityLabel,
  unlockHeadline,
  unlockProgressCopy,
  type UnlockPhase,
} from "@/lib/asam/appUnlockPolicy";
import { AppTileMark } from "@/components/AppTileMark";
import { fonts, palette, useColors } from "@/theme";

/** The canonical identity of the app being unlocked, straight from its tile. */
export type UnlockingApp = {
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
};

export type UnlockFailure = { title: string; message: string };

const ICON_SIZE = 88;
const ICON_RADIUS = ICON_SIZE * 0.22; // squircle — matches the launcher tile

export function AppUnlockingOverlay({
  app,
  phase,
  startedAt,
  failure,
  canCancel,
  onCancel,
  onRetry,
}: {
  /** Null when nothing is unlocking — the modal is not rendered. */
  app: UnlockingApp | null;
  phase: UnlockPhase;
  /** Epoch ms the wait began; the modal ticks its own elapsed copy from this. */
  startedAt: number;
  /** Non-null switches the modal into its retry/cancel failure state. */
  failure: UnlockFailure | null;
  /** False only after ASAM release begins, when cancellation is no longer safe. */
  canCancel: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const elapsedMs = useElapsed(startedAt, app !== null && failure === null);
  const progress = useEstimatedProgress(startedAt, app !== null && failure === null);

  if (!app) return null;

  const busy = failure === null;
  const opening = busy && (phase === "preparing" || phase === "opening");

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={canCancel ? onCancel : () => {}}
    >
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal>
          <View
            accessible
            accessibilityRole={busy ? "progressbar" : "alert"}
            accessibilityLabel={
              busy
                ? unlockAccessibilityLabel(app.name, phase, elapsedMs)
                : `${failure.title}. ${failure.message}`
            }
            accessibilityValue={
              busy && !opening
                ? {
                    min: 0,
                    max: 100,
                    now: Math.round(unlockEstimatedProgress(elapsedMs) * 100),
                    text: `${Math.min(
                      Math.floor(elapsedMs / 1_000),
                      UNLOCK_PROGRESS_ESTIMATE_MS / 1_000,
                    )} of about ${UNLOCK_PROGRESS_ESTIMATE_MS / 1_000} seconds`,
                  }
                : undefined
            }
            style={styles.status}
          >
            {/* Same mark the launcher tile drew, so the scholar sees the thing
                they tapped — including its emoji/initial fallback. The status
                group around it already names the app it is unlocking, so the
                mark adds no second announcement of its own. */}
            <AppTileMark
              key={app.name}
              name={app.name}
              iconUrl={app.iconUrl}
              iconEmoji={app.iconEmoji}
              color={app.color}
              markFontSize={34}
              decorative
              style={[styles.icon, busy ? null : styles.iconDimmed]}
            />

            {opening ? (
              <ActivityIndicator
                size="large"
                color={colors.violet}
                importantForAccessibility="no-hide-descendants"
              />
            ) : null}

            <Text style={styles.headline}>
              {busy ? unlockHeadline(app.name, phase) : failure.title}
            </Text>
            <Text style={styles.body}>
              {busy ? unlockProgressCopy(phase, elapsedMs) : failure.message}
            </Text>
            {busy && !opening ? (
              <View
                style={styles.progressBlock}
                importantForAccessibility="no-hide-descendants"
              >
                <View style={styles.progressTrack}>
                  <Animated.View
                    style={[
                      styles.progressFill,
                      {
                        width: progress.interpolate({
                          inputRange: [0, 1],
                          outputRange: ["0%", "100%"],
                        }),
                      },
                    ]}
                  />
                </View>
                <Text style={styles.progressEstimate}>
                  Usually about {UNLOCK_PROGRESS_ESTIMATE_MS / 1_000} seconds
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.actions}>
            {busy ? null : (
              <Pressable
                onPress={onRetry}
                accessibilityRole="button"
                accessibilityLabel={`Try opening ${app.name} again`}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.primaryLabel}>Try again</Text>
              </Pressable>
            )}
            {busy && !canCancel ? null : (
              <Pressable
                onPress={onCancel}
                accessibilityRole="button"
                accessibilityLabel={
                  busy ? `Stop opening ${app.name}` : "Close and stay in Rabbithole"
                }
                style={({ pressed }) => [
                  styles.secondaryButton,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.secondaryLabel}>Cancel</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * Seconds-resolution elapsed clock, local to the modal so the provider does not
 * re-render once a second for the whole app's lifetime. Stops while idle or in
 * the failure state, where the copy no longer depends on time.
 */
function useElapsed(startedAt: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running, startedAt]);
  return Math.max(0, now - startedAt);
}

function useEstimatedProgress(startedAt: number, running: boolean): Animated.Value {
  const [progress] = useState(() => new Animated.Value(0));
  useEffect(() => {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const initial = unlockEstimatedProgress(elapsedMs);
    progress.stopAnimation();
    progress.setValue(initial);
    if (!running || initial >= 1) return;

    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: UNLOCK_PROGRESS_ESTIMATE_MS - elapsedMs,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, running, startedAt]);
  return progress;
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(12,14,36,0.55)",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 32,
    },
    card: {
      width: "100%",
      maxWidth: 460,
      backgroundColor: c.bg,
      borderRadius: 24,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      paddingVertical: 34,
      paddingHorizontal: 32,
      gap: 24,
      alignItems: "center",
      shadowColor: palette.navy[900],
      shadowOpacity: 0.3,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 10 },
      elevation: 12,
    },
    status: {
      alignItems: "center",
      gap: 14,
      alignSelf: "stretch",
    },
    icon: {
      width: ICON_SIZE,
      height: ICON_SIZE,
      borderRadius: ICON_RADIUS,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: "rgba(20,24,55,0.08)",
    },
    iconDimmed: {
      opacity: 0.45,
    },
    headline: {
      fontFamily: fonts.bold,
      fontSize: 26,
      color: c.fg,
      textAlign: "center",
    },
    body: {
      fontFamily: fonts.regular,
      fontSize: 17,
      lineHeight: 24,
      color: c.fgMuted,
      textAlign: "center",
    },
    progressBlock: {
      alignSelf: "stretch",
      gap: 8,
      marginTop: 2,
    },
    progressTrack: {
      height: 8,
      borderRadius: 999,
      overflow: "hidden",
      backgroundColor: c.gray200,
    },
    progressFill: {
      height: "100%",
      borderRadius: 999,
      backgroundColor: c.violet,
    },
    progressEstimate: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.fgMuted,
      textAlign: "center",
    },
    actions: {
      alignSelf: "stretch",
      gap: 10,
    },
    primaryButton: {
      backgroundColor: c.violetSolid,
      borderRadius: 14,
      paddingVertical: 15,
      alignItems: "center",
    },
    primaryLabel: {
      fontFamily: fonts.semibold,
      fontSize: 17,
      color: c.white,
    },
    secondaryButton: {
      borderRadius: 14,
      paddingVertical: 15,
      alignItems: "center",
    },
    secondaryLabel: {
      fontFamily: fonts.semibold,
      fontSize: 17,
      color: c.fgMuted,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
