import { useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

import { useColors } from "@/theme";

// Whether real iOS 26 Liquid Glass is available (false on older iOS / sims).
const GLASS =
  Platform.OS === "ios" &&
  (() => {
    try {
      return isLiquidGlassAvailable();
    } catch {
      return false;
    }
  })();

/**
 * A bar with the iOS 26 Liquid Glass material (title bar / composer). Falls back
 * to a translucent material + hairline border where Liquid Glass isn't available
 * (older iOS, the Simulator) so the layout is identical everywhere.
 */
export function GlassBar({
  children,
  style,
  edge = "top",
  glassEffectStyle = "regular",
  isInteractive = false,
}: {
  children: ReactNode;
  style?: ViewStyle | ViewStyle[];
  /** Which hairline edge to draw in the fallback. */
  edge?: "top" | "bottom" | "none";
  /** Clear glass is for discrete controls floating over a richer surface. */
  glassEffectStyle?: "clear" | "regular";
  /** Opt in when the glass itself contains a direct manipulation control. */
  isInteractive?: boolean;
}) {
  const colors = useColors();
  const colorScheme = useColorScheme();
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((enabled) => {
        if (mounted) setReduceTransparency(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  if (GLASS && !reduceTransparency) {
    return (
      <GlassView
        glassEffectStyle={glassEffectStyle}
        colorScheme={colorScheme === "dark" ? "dark" : "light"}
        isInteractive={isInteractive}
        style={style}
      >
        {children}
      </GlassView>
    );
  }
  const fallbackBackground = reduceTransparency
    ? colors.bg
    : colorScheme === "dark"
      ? "rgba(28,28,30,0.78)"
      : "rgba(255,255,255,0.78)";
  const border =
    edge === "top"
      ? { borderTopWidth: StyleSheet.hairlineWidth }
      : edge === "bottom"
        ? { borderBottomWidth: StyleSheet.hairlineWidth }
        : null;
  return (
    <View style={[{ backgroundColor: fallbackBackground, borderColor: colors.border }, border, style]}>
      {children}
    </View>
  );
}

export const liquidGlassAvailable = GLASS;
