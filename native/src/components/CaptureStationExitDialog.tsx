import { useMemo } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SvgUri } from "react-native-svg";

import { fonts, type Colors, useColors } from "@/theme";

/**
 * "Exit capture mode" — the same teacher QR + serial operation as the ASAM
 * parent gate (see AsamParentGate). Capture mode is teacher-managed, so a
 * scholar can't leave it directly; a staff member scans the code (or finds the
 * iPad by serial in the Devices page) and stops capture mode. Opened by the
 * header Exit button AND a four-finger long-press.
 */
export function CaptureStationExitDialog({
  visible,
  onClose,
  serialNumber,
  deviceSettingsUrl,
  qrCodeUrl,
}: {
  visible: boolean;
  onClose: () => void;
  serialNumber: string | null;
  deviceSettingsUrl: string | null;
  qrCodeUrl: string | null;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      supportedOrientations={["landscape"]}
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <View
          style={[
            styles.card,
            { marginTop: insets.top + 24, marginBottom: insets.bottom + 24 },
          ]}
        >
          <View style={styles.copyColumn}>
            <Text style={styles.eyebrow}>Capture station</Text>
            <Text style={styles.title}>Exit capture mode</Text>
            <Text style={styles.detail}>
              This iPad is in a teacher-managed capture mode. A staff member
              switches it back from the teacher dashboard — scan the code, or
              open Devices and find this iPad by its serial number, then stop
              capture mode.
            </Text>
            {serialNumber ? (
              <View style={styles.deviceIdentity}>
                <Text style={styles.deviceIdentityLabel}>Serial number</Text>
                <Text style={styles.deviceIdentityValue}>{serialNumber}</Text>
              </View>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
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
                  Open this iPad&apos;s settings to stop capture mode.
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
                <Text style={styles.scanTitle}>Ask a teacher</Text>
                <Text style={styles.scanDetail}>
                  A staff member can stop capture mode from the Devices page.
                </Text>
              </View>
            )}
          </View>
        </View>
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
    copyColumn: { flex: 1, alignItems: "flex-start", paddingVertical: 8 },
    qrColumn: { width: 280, alignItems: "center", justifyContent: "center" },
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
    detail: {
      marginTop: 20,
      color: colors.fgMuted,
      fontFamily: fonts.regular,
      fontSize: 16,
      lineHeight: 24,
    },
    deviceIdentity: { marginTop: 20, gap: 3 },
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
