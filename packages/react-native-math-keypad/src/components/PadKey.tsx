import { useEffect, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  Text,
  useAnimatedValue,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import type { KeyStyles } from "./keyStyles";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Tracks the system Reduce Motion setting. */
export function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduce(value);
      })
      .catch(() => {});
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return reduce;
}

/** Spoken name for a pad key. Every key says what it does, not its glyph:
 *  VoiceOver would read "/" as "slash" and "⌫" as nothing useful. */
export function padKeyLabel(key: string): string | undefined {
  if (key === "") return undefined;
  if (key === "⌫") return "key backspace";
  if (key === "/") return "key fraction bar";
  if (key === ".") return "key decimal point";
  if (key === "±") return "key toggle negative sign";
  if (key === "R") return "key remainder";
  if (key === "x") return "key variable x";
  return `key ${key}`;
}

/**
 * One keypad key. `springy` (Rabbithole's "Quick facts" tactile mode, for
 * timed fact practice) gives it a fast press-in scale-down that springs back
 * on release. Off, or when Reduce Motion is on, it is a plain Pressable with a
 * pressed-state background. Haptics are the caller's job (`onPress`), so a key
 * never fires two.
 *
 * Rabbithole used Reanimated for the spring; this uses React Native's own
 * Animated with the native driver, which is plenty for one transform and
 * drops a peer dependency.
 */
export function PadKey({
  label,
  accessibilityLabel,
  disabled = false,
  hidden = false,
  springy = false,
  styles,
  style,
  children,
  onPress,
}: {
  label: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  hidden?: boolean;
  springy?: boolean;
  styles: KeyStyles;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  onPress: () => void;
}) {
  const scale = useAnimatedValue(1);
  const reduceMotion = useReduceMotion();
  const a11yLabel = hidden ? undefined : (accessibilityLabel ?? padKeyLabel(label));
  const face = children ?? <Text style={styles.padKeyText}>{label}</Text>;

  if (!springy || reduceMotion) {
    return (
      <Pressable
        disabled={disabled || hidden}
        onPress={onPress}
        style={({ pressed }) => [
          styles.padKey,
          style,
          hidden && styles.padKeyHidden,
          pressed && !hidden && styles.padKeyPressed,
        ]}
        accessibilityRole="button"
        accessibilityLabel={a11yLabel}
        accessibilityElementsHidden={hidden}
        importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      >
        {face}
      </Pressable>
    );
  }

  return (
    <AnimatedPressable
      disabled={disabled || hidden}
      onPressIn={() => {
        if (hidden) return;
        Animated.timing(scale, { toValue: 0.88, duration: 55, useNativeDriver: true }).start();
      }}
      onPressOut={() => {
        Animated.spring(scale, {
          toValue: 1,
          damping: 12,
          stiffness: 340,
          mass: 0.5,
          useNativeDriver: true,
        }).start();
      }}
      onPress={onPress}
      style={[styles.padKey, style, hidden && styles.padKeyHidden, { transform: [{ scale }] }]}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
    >
      {face}
    </AnimatedPressable>
  );
}
