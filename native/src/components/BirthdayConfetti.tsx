// A brief, wordless confetti burst on the scholar's OWN birthday, the first
// time they land on the home screen that day. Anti-parasocial by construction:
// no text, no tutor voice, non-blocking (pointerEvents="none" — touches pass
// through to the plate), self-clearing after ~3s, self-only, un-nudged.
//
// Pure-JS library (react-native-confetti-cannon uses RN Animated) — no native
// module, so no dev-client rebuild. Fire-once is gated by a local secure-store
// flag keyed on the institution day-key (birthdayCelebration.ts); it never
// reads or writes any server record.

import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Dimensions, View } from "react-native";
import ConfettiCannon from "react-native-confetti-cannon";
import * as Haptics from "expo-haptics";

import { palette } from "@/theme";
import { hasSeenBirthday, markBirthdaySeen } from "@/lib/birthdayCelebration";

// House navy/violet + the badge GOLD accent and a little white — an on-brand
// burst, not a primary-color party popper.
const CONFETTI_COLORS = [
  palette.violet[400],
  palette.violet[600],
  palette.navy[500],
  "#f4c44c",
  "#ffffff",
];

export function BirthdayConfetti({
  active,
  dayKey,
}: {
  /** True only when it's the signed-in scholar's own birthday (institution day). */
  active: boolean;
  /** The institution day-key ("YYYY-MM-DD") — the fire-once gate. */
  dayKey: string;
}) {
  const [play, setPlay] = useState(false);
  // Guards against re-deciding on every render for the same day.
  const decidedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (!active || !dayKey) return;
    if (decidedForRef.current === dayKey) return;
    decidedForRef.current = dayKey;

    let cancelled = false;
    void (async () => {
      // Never fight an accessibility setting — skip the burst entirely.
      const reduceMotion = await AccessibilityInfo.isReduceMotionEnabled().catch(
        () => false,
      );
      if (cancelled || reduceMotion) return;

      // First arrival only: if we've already celebrated today, do nothing.
      const seen = await hasSeenBirthday(dayKey);
      if (cancelled || seen) return;
      await markBirthdaySeen(dayKey);
      if (cancelled) return;

      setPlay(true);
      void Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success,
      ).catch(() => {});
    })();

    return () => {
      cancelled = true;
    };
  }, [active, dayKey]);

  if (!play) return null;

  const { width } = Dimensions.get("window");
  return (
    <View pointerEvents="none" style={StyleSheetAbsoluteFill}>
      <ConfettiCannon
        count={120}
        origin={{ x: width / 2, y: -12 }}
        colors={CONFETTI_COLORS}
        fadeOut
        autoStart
        explosionSpeed={350}
        fallSpeed={2600}
        onAnimationEnd={() => setPlay(false)}
      />
    </View>
  );
}

const StyleSheetAbsoluteFill = {
  position: "absolute" as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
