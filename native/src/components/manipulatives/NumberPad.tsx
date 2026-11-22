/**
 * NumberPad (native) — the on-screen number pad a manipulative types a number
 * with. It is the practice pad's layout and key vocabulary (`padGridKeys` +
 * the shared `applyKey` semantics), so a scholar enters a number inside a
 * manipulative exactly as they enter every other practice answer: 1, /, 2 for a
 * fraction, and the wide `± (negative)` key for a negative number.
 *
 * The pad only emits keys; the caller owns the text and folds each key in with
 * `applyKey`. It has no submit key: each caller commits its own way (the item
 * frame's Done for the Function Machine, Commit for the Dice prediction).
 *
 * Callers: the Dice prediction and the Function Machine's input and prediction
 * boxes.
 */

import { useMemo } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { padGridKeys, type PadAnswerType } from "@/lib/practicePad";
import { fonts, useColors } from "@/theme";

export interface NumberPadProps {
  padType: PadAnswerType;
  onKey: (key: string) => void;
  /** Adds the practice pad's wide `± (negative)` key under the grid. */
  allowNegative?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Spoken name for a pad key (`""` is a hidden placeholder cell). */
function padKeyLabel(key: string): string | undefined {
  if (key === "") return undefined;
  if (key === "⌫") return "key backspace";
  if (key === "/") return "key fraction bar";
  if (key === ".") return "key decimal point";
  if (key === "±") return "key toggle negative sign";
  return `key ${key}`;
}

export function NumberPad({ padType, onKey, allowNegative = false, style }: NumberPadProps) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const keys = padGridKeys(padType);
  return (
    <View style={[styles.grid, style]}>
      {keys.map((k, i) => (
        <Pressable
          key={i}
          disabled={k === ""}
          onPress={() => k && onKey(k)}
          accessibilityRole="button"
          accessibilityLabel={padKeyLabel(k)}
          accessibilityElementsHidden={k === ""}
          importantForAccessibility={k === "" ? "no-hide-descendants" : "auto"}
          style={({ pressed }) => [
            styles.key,
            k === "" && styles.keyHidden,
            pressed && k !== "" && styles.keyPressed,
          ]}
        >
          <Text style={styles.keyText}>{k}</Text>
        </Pressable>
      ))}
      {allowNegative ? (
        <Pressable
          onPress={() => onKey("±")}
          accessibilityRole="button"
          accessibilityLabel={padKeyLabel("±")}
          style={({ pressed }) => [styles.key, styles.keyWide, pressed && styles.keyPressed]}
        >
          <Text style={styles.keyText}>± (negative)</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    grid: {
      width: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
      justifyContent: "space-between",
      rowGap: 8,
    },
    key: {
      width: "31.5%",
      height: 54,
      borderRadius: 12,
      backgroundColor: c.gray50,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: "center",
      justifyContent: "center",
    },
    keyWide: { width: "100%" },
    keyHidden: { opacity: 0, borderWidth: 0, backgroundColor: "transparent" },
    keyPressed: { backgroundColor: c.gray200, transform: [{ scale: 0.96 }] },
    keyText: { fontFamily: fonts.semibold, fontSize: 22, color: c.fg },
  });
}
