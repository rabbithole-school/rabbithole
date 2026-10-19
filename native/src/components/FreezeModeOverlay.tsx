/**
 * FreezeModeOverlay — the screen a frozen iPad shows over Rabbithole.
 *
 * Staff freeze an iPad from the devices page or an agent tool
 * (`convex/deviceLock.ts`, Freeze Mode). The server also arms Rabbithole Lock,
 * so the scholar can't leave the app; this overlay covers the app itself and
 * swallows every touch until the freeze ends.
 *
 * Mounted twice over: INSIDE AsamParentGate's GestureDetector (see
 * AsamHybridHost), and inside every `<Modal>` through `FreezableModal`,
 * because iOS draws a modal in its own window above the app tree. In the
 * app tree
 * the teacher's four-finger hold still opens Device settings through it —
 * that sheet's QR code is how a teacher reaches the Unfreeze button on their
 * own phone. The app underneath stays mounted, so a scholar's unsent work
 * survives the freeze.
 *
 * A fixed end time, not a ticking countdown: the scholar needs to know when,
 * not to watch a clock.
 */
import { SnowflakeIcon } from "phosphor-react-native";
import { useEffect, useMemo, useState } from "react";
import { Keyboard, StyleSheet, Text, View } from "react-native";

import { formatThawTime, isFrozenAt, msUntilThaw } from "@/lib/asam/freezeMode";
import { fonts, type Colors, useColors } from "@/theme";

/**
 * Re-renders at the thaw instant so the overlay lifts on time even when the
 * server's thaw write can't reach an offline iPad. setTimeout caps at ~24.8
 * days; a freeze is at most 8 hours.
 */
function useFrozen(frozenUntil: number | null | undefined): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // Refresh once now (a boundary that arrived already past must not show
    // as frozen off a stale clock) and again just after the thaw.
    const remaining = msUntilThaw(frozenUntil, Date.now());
    const refresh = setTimeout(() => setNow(Date.now()), 0);
    const thaw =
      remaining === null
        ? null
        : setTimeout(() => setNow(Date.now()), remaining + 50);
    return () => {
      clearTimeout(refresh);
      if (thaw) clearTimeout(thaw);
    };
  }, [frozenUntil]);
  return isFrozenAt(frozenUntil, now);
}

export function FreezeModeOverlay({
  frozenUntil,
  teacherHint = "gesture",
}: {
  frozenUntil: number | null | undefined;
  /**
   * "gesture" in the app's own tree, where the four-finger hold reaches
   * Device settings. "devices" inside a `<Modal>` window, which that gesture
   * can't reach — point at the devices page instead.
   */
  teacherHint?: "gesture" | "devices";
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const frozen = useFrozen(frozenUntil);
  // A focused field underneath would keep its keyboard up over the overlay
  // (and keep typing into the app).
  useEffect(() => {
    if (frozen) Keyboard.dismiss();
  }, [frozen]);
  if (!frozen || typeof frozenUntil !== "number") return null;

  const until = formatThawTime(frozenUntil);
  return (
    <View
      style={styles.overlay}
      // Claim every touch so nothing underneath can be used while frozen.
      onStartShouldSetResponder={() => true}
      accessibilityViewIsModal
      accessible
      accessibilityLabel={`This iPad is frozen until ${until}. Ask a teacher to unfreeze it.`}
    >
      <View style={styles.card}>
        <SnowflakeIcon size={56} color={colors.navy} weight="duotone" />
        <Text style={styles.title}>This iPad is frozen until {until}</Text>
        <Text style={styles.body}>Ask a teacher to unfreeze it.</Text>
      </View>
      <Text style={styles.staffHint}>
        {teacherHint === "gesture"
          ? "Teachers: hold four fingers on the screen for three seconds to open Device settings."
          : "Teachers: unfreeze it from Devices in Rabbithole."}
      </Text>
    </View>
  );
}

function makeStyles(colors: Colors) {
  return StyleSheet.create({
    overlay: {
      ...StyleSheet.absoluteFill,
      zIndex: 1000,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.bgSubtle,
      padding: 32,
    },
    card: {
      alignItems: "center",
      maxWidth: 640,
      gap: 16,
      borderRadius: 24,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.bg,
      paddingHorizontal: 48,
      paddingVertical: 40,
    },
    title: {
      color: colors.fg,
      fontFamily: fonts.bold,
      fontSize: 32,
      letterSpacing: -0.5,
      textAlign: "center",
    },
    body: {
      color: colors.fgMuted,
      fontFamily: fonts.regular,
      fontSize: 20,
      lineHeight: 28,
      textAlign: "center",
    },
    staffHint: {
      position: "absolute",
      bottom: 32,
      left: 32,
      right: 32,
      color: colors.fgMuted,
      fontFamily: fonts.regular,
      fontSize: 14,
      textAlign: "center",
    },
  });
}
