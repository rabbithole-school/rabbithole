/**
 * KioskWifiHelpOverlay — the offline wifi-recovery overlay.
 *
 * The school iPads run in postures where the OS Settings app IS reachable while
 * offline — the ASAM "best of both" hybrid (which steps out of Single App Mode
 * the moment it goes offline) and the multi-app kiosk (MDM allowlist permits
 * Rabbithole PLUS Settings). So recovery is always "open Settings → Wi-Fi and
 * pick any network": when offline, this overlay guides the user there, ideally
 * in one tap (openWifiSettings), and auto-dismisses the moment real internet
 * returns.
 *
 * (The former HARD Single App Mode path — Settings blocked, needing a
 * MDM-preprovisioned Carrot-hotspot rescue — was discarded along with its
 * HotspotRecoveryOverlay; see git history if it ever needs resurrecting.)
 *
 * NATIVE-ONLY BY DESIGN. The web app never runs in kiosk/Single App Mode, so it
 * can always be closed and reopened on whatever network is available — it has no
 * need for this recovery flow. There is deliberately no web counterpart.
 *
 * Shares the SAME offline detection as the hotspot overlay (useOfflineRecovery →
 * networkProbe → offlineDecision), reused unchanged.
 */
import { useMemo } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SymbolView } from "expo-symbols";

import { fonts, useColors } from "@/theme";
import { useOfflineRecovery } from "@/hooks/useOfflineRecovery";
import { openWifiSettings } from "@/lib/wifiRecovery/openWifiSettings";

export function KioskWifiHelpOverlay() {
  const { isOffline, isChecking, retryNow } = useOfflineRecovery();

  // Auto-dismiss when back online — driven entirely off `isOffline`, same as the
  // hotspot overlay. No manual dismiss, no "Not now": this mode's fix is quick.
  if (!isOffline) return null;

  return (
    <FullOverlay
      isChecking={isChecking}
      onOpenWifiSettings={() => void openWifiSettings()}
      onCheckAgain={retryNow}
    />
  );
}

// ── Full-screen overlay ──────────────────────────────────────────────────────

function FullOverlay({
  isChecking,
  onOpenWifiSettings,
  onCheckAgain,
}: {
  isChecking: boolean;
  onOpenWifiSettings: () => void;
  onCheckAgain: () => void;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  return (
    <Modal presentationStyle="fullScreen" animationType="fade">
      <SafeAreaView style={styles.safe}>
        {/* One vertically-centered column: icon, copy, card, and the actions all
            sit together in the middle of the screen. `flexGrow: 1` +
            `justifyContent: center` centers the whole group; the ScrollView is a
            safety net if it ever overflows on a short screen. */}
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.iconWrap}>
            <SymbolView name="wifi.slash" size={30} tintColor={colors.violet} />
          </View>

          <Text style={styles.title}>You’re offline</Text>
          <Text style={styles.body}>
            This iPad connects to the internet through the Settings app. Open
            wifi settings and pick a network to get back online. Not sure which
            network to pick? Ask a trusted adult.
          </Text>

          <Pressable
            onPress={onOpenWifiSettings}
            accessibilityRole="button"
            accessibilityLabel="Open Wifi Settings"
            style={({ pressed }) => [
              styles.primaryBtn,
              pressed && styles.primaryBtnPressed,
            ]}
          >
            <Text style={styles.primaryBtnText}>Open Wifi Settings</Text>
          </Pressable>

          <Pressable
            onPress={onCheckAgain}
            disabled={isChecking}
            accessibilityRole="button"
            accessibilityLabel="Check again"
            style={({ pressed }) => [
              styles.secondaryBtn,
              pressed && styles.secondaryBtnPressed,
              isChecking && styles.secondaryBtnDisabled,
            ]}
          >
            {isChecking ? (
              <ActivityIndicator color={colors.violet} />
            ) : (
              <Text style={styles.secondaryBtnText}>Check again</Text>
            )}
          </Pressable>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bgSubtle },
    scroll: { flex: 1, width: "100%" },
    content: {
      // flexGrow + center = the whole group (icon → buttons) sits in the
      // vertical middle of the screen; the ScrollView only scrolls if it
      // overflows a short viewport.
      flexGrow: 1,
      justifyContent: "center",
      width: "100%",
      maxWidth: 640,
      alignSelf: "center",
      padding: 24,
    },
    iconWrap: {
      width: 56,
      height: 56,
      borderRadius: 16,
      backgroundColor: c.violetSubtle,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 16,
    },
    title: {
      fontSize: 28,
      lineHeight: 34,
      fontFamily: fonts.bold,
      color: c.navy,
      marginBottom: 10,
    },
    body: {
      fontSize: 16,
      lineHeight: 24,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      marginBottom: 20,
    },
    primaryBtn: {
      backgroundColor: c.violetSolid,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 54,
      // Space it off the paragraph now that the buttons live in the centered
      // group rather than a bottom footer.
      marginTop: 24,
    },
    primaryBtnPressed: { opacity: 0.85 },
    primaryBtnText: {
      fontSize: 17,
      fontFamily: fonts.bold,
      color: c.white,
    },
    secondaryBtn: {
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      paddingVertical: 14,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 50,
      marginTop: 12,
    },
    secondaryBtnPressed: { opacity: 0.7 },
    secondaryBtnDisabled: { opacity: 0.6 },
    secondaryBtnText: {
      fontSize: 16,
      fontFamily: fonts.semibold,
      color: c.navy,
    },
  });
}
