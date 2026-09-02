/**
 * Stepper (native) — the RN port of the web `Stepper.web.tsx`: a minus / label /
 * plus control for the manipulatives that adjust an integer count (Partition
 * parts, Balance unit weights, Riemann bars, the FunctionMachine guess). The
 * two buttons keep a >= 44pt touch target (HIG minimum) and a subtle
 * `selectionAsync` haptic fires on every accepted tick, matching the kit's
 * snap-crossing feel for drags.
 */

import { Pressable, StyleSheet, Text, View } from "react-native";

import { selectionTick } from "./kit";
import { fonts, useColors } from "@/theme";

export interface StepperProps {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  /** Trailing noun shown next to the value (e.g. "parts", "left"). */
  label: string;
  /**
   * Drops the "{value} {label}" readout and lets the two buttons share the
   * caller's width — for a stepper under a column that already shows the noun
   * (the place header) and the count (the big digit). Its 96pt minimum is what
   * made a place-value column 204pt wide, wider than a fifth of the practice
   * column. The word stays in each button's `accessibilityLabel`.
   */
  compact?: boolean;
}

export function Stepper({ value, min, max, onChange, label, compact = false }: StepperProps) {
  const colors = useColors();

  const step = (delta: number) => {
    const next = value + delta;
    if (next < min || next > max) return;
    selectionTick();
    onChange(next);
  };

  const minusDisabled = value <= min;
  const plusDisabled = value >= max;

  return (
    <View style={[styles.row, compact && styles.rowCompact]}>
      <StepButton
        symbol="−"
        disabled={minusDisabled}
        accessibilityLabel={`fewer ${label}`}
        onPress={() => step(-1)}
        colors={colors}
        compact={compact}
      />
      {!compact && (
        <Text
          style={[styles.label, { color: colors.fgMuted }]}
          numberOfLines={1}
        >
          {value} {label}
        </Text>
      )}
      <StepButton
        symbol="+"
        disabled={plusDisabled}
        accessibilityLabel={`more ${label}`}
        onPress={() => step(1)}
        colors={colors}
        compact={compact}
      />
    </View>
  );
}

function StepButton({
  symbol,
  disabled,
  accessibilityLabel,
  onPress,
  colors,
  compact = false,
}: {
  symbol: string;
  disabled: boolean;
  accessibilityLabel: string;
  onPress: () => void;
  colors: ReturnType<typeof useColors>;
  compact?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.btn,
        compact && styles.btnCompact,
        { borderColor: colors.border, backgroundColor: colors.bg },
        pressed && !disabled && { backgroundColor: colors.gray50 },
      ]}
    >
      <Text
        style={[
          styles.btnText,
          { color: disabled ? colors.charcoalSubtle : colors.violet },
        ]}
      >
        {symbol}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  rowCompact: { width: "100%", gap: 6 },
  btn: {
    width: 44,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  // Shares the column's width instead of claiming a fixed 44pt. The 32pt visual
  // floor plus 6pt hitSlop on each side preserves a 44pt HIG touch target.
  btnCompact: { width: undefined, flexGrow: 1, flexShrink: 1, flexBasis: 0, maxWidth: 44, minWidth: 32 },
  btnText: {
    fontFamily: fonts.bold,
    fontSize: 22,
    lineHeight: 24,
  },
  label: {
    minWidth: 96,
    textAlign: "center",
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
});
