import * as Haptics from "expo-haptics";
import { useCallback, useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgUri } from "react-native-svg";

import type { DeviceLockState } from "@/hooks/useAsamController";
import { selectAsamLockStatus } from "@/lib/asam/asamDecision";
import { readManagedSerial } from "@/lib/managedClaim";
import { fonts, type Colors, useColors } from "@/theme";

const REQUIRED_POINTERS = 4;
const HOLD_MS = 3_000;
/**
 * Movement tolerance for the hold, in points. Deliberately generous: holding
 * four fingers still for three full seconds always drifts a little (and the
 * fingers rarely land at once), so a tight bound reads to a teacher as "the
 * gesture doesn't work". Four simultaneous pointers held for 3s is already a
 * deliberate motion no scholar produces by accident, so distance is not what
 * keeps this gate closed.
 */
const MAX_DISTANCE = 80;

type AsamParentGateProps = {
  children: React.ReactNode;
  lockState: DeviceLockState | null;
  qrCodeUrl: string | null;
  deviceSettingsUrl: string | null;
  busy: boolean;
  isAsamActive: boolean;
  isOfflineBypass: boolean;
  error: string | null;
  onUserActivity: () => void;
  /**
   * Controlled by the caller (AsamHybridHost) rather than owned locally, so
   * a visible entry point elsewhere in the tree (the account menu's
   * "Teacher unlock" row) can open this SAME modal — never a second one.
   */
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
};

export function AsamParentGate({
  children,
  lockState,
  qrCodeUrl,
  deviceSettingsUrl,
  busy,
  isAsamActive,
  isOfflineBypass,
  error,
  onUserActivity,
  visible,
  onVisibleChange,
}: AsamParentGateProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const serialNumber = readManagedSerial();

  const openSettings = useCallback(() => {
    void Haptics.notificationAsync(
      Haptics.NotificationFeedbackType.Success,
    ).catch(() => {});
    onVisibleChange(true);
  }, [onVisibleChange]);

  const gesture = useMemo(
    () =>
      Gesture.LongPress()
        .numberOfPointers(REQUIRED_POINTERS)
        .minDuration(HOLD_MS)
        .maxDistance(MAX_DISTANCE)
        .onStart(() => {
          runOnJS(openSettings)();
        }),
    [openSettings],
  );

  const status = selectAsamLockStatus(
    lockState,
    isAsamActive,
    isOfflineBypass,
  );
  const statusColor =
    status.tone === "success"
      ? colors.statusGreen
      : status.tone === "warning"
        ? colors.statusYellow
        : colors.charcoalMuted;

  return (
    <GestureDetector gesture={gesture}>
      <View style={styles.fill} onTouchStart={() => onUserActivity()}>
        {children}
        <Pressable
          onPress={() => onVisibleChange(true)}
          accessibilityLabel="Open Device settings"
          accessibilityRole="button"
          style={styles.axTarget}
        />
        <Modal
          visible={visible}
          transparent
          animationType="fade"
          supportedOrientations={["landscape"]}
          onRequestClose={() => onVisibleChange(false)}
        >
          <View style={styles.backdrop}>
            <View
              style={[
                styles.card,
                {
                  marginTop: insets.top + 24,
                  marginBottom: insets.bottom + 24,
                },
              ]}
            >
              <View style={styles.copyColumn}>
                <Text style={styles.eyebrow}>Device settings</Text>
                <Text style={styles.title}>Rabbithole Lock</Text>
                <View style={styles.status}>
                  <View
                    style={[styles.statusDot, { backgroundColor: statusColor }]}
                  />
                  <Text style={styles.statusLabel}>{status.label}</Text>
                </View>
                <Text style={styles.detail}>{status.detail}</Text>
                {serialNumber ? (
                  <View style={styles.deviceIdentity}>
                    <Text style={styles.deviceIdentityLabel}>Serial number</Text>
                    <Text style={styles.deviceIdentityValue}>{serialNumber}</Text>
                  </View>
                ) : null}
                {error ? <Text style={styles.error}>{error}</Text> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close Device settings"
                  onPress={() => onVisibleChange(false)}
                  style={({ pressed }) => [
                    styles.doneButton,
                    pressed && styles.buttonPressed,
                  ]}
                >
                  <Text style={styles.doneButtonText}>Done</Text>
                </Pressable>
              </View>

              <View style={styles.qrColumn}>
                {qrCodeUrl ? (
                  <>
                    <View style={styles.qrFrame}>
                      <SvgUri width={224} height={224} uri={qrCodeUrl} />
                    </View>
                    <Text style={styles.scanTitle}>
                      Scan with a staff member&apos;s phone
                    </Text>
                    <Text style={styles.scanDetail}>
                      Sign in to arm or disarm this iPad.
                    </Text>
                    {deviceSettingsUrl ? (
                      <Text style={styles.url} numberOfLines={1}>
                        {deviceSettingsUrl}
                      </Text>
                    ) : null}
                  </>
                ) : (
                  <View style={styles.unavailable}>
                    <Text style={styles.unavailableIcon}>iPad</Text>
                    <Text style={styles.scanTitle}>QR code unavailable</Text>
                    <Text style={styles.scanDetail}>
                      {busy
                        ? "Checking this iPad..."
                        : "Pair this iPad to a scholar first."}
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </GestureDetector>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    fill: { flex: 1 },
    axTarget: {
      position: "absolute",
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      opacity: 0,
    },
    backdrop: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: "rgba(15, 23, 42, 0.62)",
      padding: 32,
    },
    card: {
      width: "92%",
      maxWidth: 820,
      minHeight: 410,
      flexDirection: "row",
      gap: 40,
      borderRadius: 24,
      backgroundColor: colors.bg,
      padding: 32,
      shadowColor: "#000000",
      shadowOpacity: 0.2,
      shadowRadius: 24,
      shadowOffset: { width: 0, height: 12 },
      elevation: 12,
    },
    copyColumn: {
      flex: 1,
      alignItems: "flex-start",
      paddingVertical: 8,
    },
    qrColumn: {
      width: 280,
      alignItems: "center",
      justifyContent: "center",
    },
    eyebrow: {
      color: colors.fgMuted,
      fontFamily: fonts.semibold,
      fontSize: 13,
      textTransform: "uppercase",
      letterSpacing: 1.2,
    },
    title: {
      marginTop: 4,
      color: colors.fg,
      fontFamily: fonts.bold,
      fontSize: 34,
      letterSpacing: -0.5,
    },
    status: {
      marginTop: 24,
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bgSubtle,
      paddingHorizontal: 16,
      paddingVertical: 9,
    },
    statusDot: { width: 9, height: 9, borderRadius: 999 },
    statusLabel: {
      color: colors.fg,
      fontFamily: fonts.semibold,
      fontSize: 16,
    },
    detail: {
      marginTop: 16,
      color: colors.fgMuted,
      fontFamily: fonts.regular,
      fontSize: 16,
      lineHeight: 24,
    },
    deviceIdentity: {
      marginTop: 20,
      gap: 3,
    },
    deviceIdentityLabel: {
      color: colors.fgMuted,
      fontFamily: fonts.medium,
      fontSize: 13,
    },
    deviceIdentityValue: {
      color: colors.fg,
      fontFamily: fonts.mono,
      fontSize: 16,
      letterSpacing: 0.4,
    },
    error: {
      marginTop: 12,
      color: colors.statusRed,
      fontFamily: fonts.medium,
      fontSize: 13,
    },
    doneButton: {
      marginTop: "auto",
      borderRadius: 12,
      backgroundColor: colors.violetSolid,
      paddingHorizontal: 24,
      paddingVertical: 12,
    },
    buttonPressed: { opacity: 0.82 },
    doneButtonText: {
      color: colors.white,
      fontFamily: fonts.semibold,
      fontSize: 16,
    },
    qrFrame: {
      alignItems: "center",
      justifyContent: "center",
      width: 240,
      height: 240,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 18,
      backgroundColor: "#FFFFFF",
      padding: 8,
    },
    scanTitle: {
      marginTop: 16,
      color: colors.fg,
      fontFamily: fonts.semibold,
      fontSize: 16,
      textAlign: "center",
    },
    scanDetail: {
      marginTop: 4,
      color: colors.fgMuted,
      fontFamily: fonts.regular,
      fontSize: 13,
      textAlign: "center",
    },
    url: {
      width: 260,
      marginTop: 12,
      color: colors.charcoalSubtle,
      fontFamily: fonts.mono,
      fontSize: 10,
      textAlign: "center",
    },
    unavailable: {
      minHeight: 280,
      alignItems: "center",
      justifyContent: "center",
      borderRadius: 18,
      backgroundColor: colors.bgSubtle,
      padding: 24,
    },
    unavailableIcon: {
      overflow: "hidden",
      borderRadius: 8,
      backgroundColor: colors.navy,
      color: colors.white,
      paddingHorizontal: 16,
      paddingVertical: 20,
      fontFamily: fonts.bold,
      fontSize: 13,
    },
  });
}
