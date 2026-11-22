import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type StyleProp, type ViewStyle } from "react-native";

import {
  padGridKeys,
  padShowFraction,
  padShowRemainder,
  padShowSign,
  unitKeyFamily,
  type PadAnswerType,
} from "../model/flatPad";
import { useMathKeypadTheme, type MathKeypadThemeOverride } from "../theme";
import { GlyphFraction, GlyphIndexedRoot, GlyphPower, GlyphSquareRoot } from "./Glyphs";
import { makeKeyStyles, type KeyStyles } from "./keyStyles";
import { PadKey } from "./PadKey";

/** The digit grid the 2-D builder shows: `x` (the one variable the grammar
 *  allows) takes the bottom-left cell that a flat pad gives to `/` or `.`. */
export const BUILDER_GRID = ["7", "8", "9", "4", "5", "6", "1", "2", "3", "x", "0", "⌫"];

function useKeyStyles(theme?: MathKeypadThemeOverride): KeyStyles {
  const resolved = useMathKeypadTheme(theme);
  return useMemo(() => makeKeyStyles(resolved), [resolved]);
}

function WideKey({
  label,
  accessibilityLabel,
  enabled,
  styles,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  enabled: boolean;
  styles: KeyStyles;
  onPress: () => void;
}) {
  return (
    <Pressable
      disabled={!enabled}
      onPress={onPress}
      style={({ pressed }) => [styles.padWide, pressed && styles.padKeyPressed]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Text style={styles.padKeyText}>{label}</Text>
    </Pressable>
  );
}

export type NumberPadProps = {
  /** Picks the bottom-left key (`/`, `.`, or blank) and the default accessory keys. */
  answerType: PadAnswerType;
  /** Receives the `applyKey` vocabulary: a digit, `/`, `.`, `⌫`, `R`, `±`. */
  onKey: (key: string) => void;
  enabled?: boolean;
  /** Springy keys for timed fact practice. Honors Reduce Motion. */
  tactile?: boolean;
  /** Hide the 3×4 grid (a hardware keyboard supplies digits) but keep the
   *  accessory and unit keys. Default true. */
  showGrid?: boolean;
  /** Override the default wide keys. Defaults: `/ (fraction)` on decimal,
   *  `R (remainder)` on expression, `± (negative)` on every type but expression. */
  showFractionKey?: boolean;
  showRemainderKey?: boolean;
  showSignKey?: boolean;
  /** A unit-bearing answer's display unit ("cm³"): adds its dimension family. */
  unit?: string;
  onUnitKey?: (unit: string) => void;
  theme?: MathKeypadThemeOverride;
  style?: StyleProp<ViewStyle>;
};

/**
 * The flat answer pad: a calculator-order 3×4 grid (7-8-9 on top),
 * backspace bottom-right, and the one operator the answer type needs
 * bottom-left. A key the type doesn't need is not drawn; its cell stays as a
 * hidden placeholder, so the digits are in the same place on every item.
 *
 * Wide accessory keys sit under the grid and name themselves in words
 * ("± (negative)", "R (remainder)", "/ (fraction)").
 */
export function NumberPad({
  answerType,
  onKey,
  enabled = true,
  tactile = false,
  showGrid = true,
  showFractionKey = padShowFraction(answerType),
  showRemainderKey = padShowRemainder(answerType),
  showSignKey = padShowSign(answerType),
  unit,
  onUnitKey,
  theme,
  style,
}: NumberPadProps) {
  const styles = useKeyStyles(theme);
  return (
    <View style={[styles.padWrap, style]}>
      {showGrid ? (
        <View style={styles.padGrid}>
          {padGridKeys(answerType).map((key, index) => (
            <PadKey
              key={index}
              label={key}
              disabled={!enabled}
              hidden={key === ""}
              springy={tactile}
              styles={styles}
              onPress={() => key && onKey(key)}
            />
          ))}
        </View>
      ) : null}
      {showGrid && showFractionKey ? (
        <WideKey
          label="/ (fraction)"
          accessibilityLabel="key fraction bar"
          enabled={enabled}
          styles={styles}
          onPress={() => onKey("/")}
        />
      ) : null}
      {showGrid && showRemainderKey ? (
        <WideKey
          label="R (remainder)"
          accessibilityLabel="key remainder"
          enabled={enabled}
          styles={styles}
          onPress={() => onKey("R")}
        />
      ) : null}
      {showGrid && showSignKey ? (
        <WideKey
          label="± (negative)"
          accessibilityLabel="key toggle negative sign"
          enabled={enabled}
          styles={styles}
          onPress={() => onKey("±")}
        />
      ) : null}
      {unit && onUnitKey ? (
        <UnitKeys unit={unit} onUnitKey={onUnitKey} enabled={enabled} theme={theme} />
      ) : null}
    </View>
  );
}

/**
 * The unit keys for a unit-bearing answer: the whole dimension family
 * (cm / cm² / cm³), never just the expected unit, because choosing length vs.
 * area vs. volume IS the task. Pair with `applyUnitKey`, which REPLACES any
 * trailing unit so cm² → cm³ is one tap. Stays visible with a hardware
 * keyboard: a superscript is awkward to type (typing "cm3" or "cm^3" should
 * still be accepted by your checker).
 */
export function UnitKeys({
  unit,
  onUnitKey,
  enabled = true,
  theme,
}: {
  unit: string;
  onUnitKey: (unit: string) => void;
  enabled?: boolean;
  theme?: MathKeypadThemeOverride;
}) {
  const styles = useKeyStyles(theme);
  const family = unitKeyFamily(unit);
  if (family.length === 0) return null;
  return (
    <View style={styles.padGrid}>
      {family.map((u) => (
        <PadKey
          key={u}
          label={u}
          accessibilityLabel={`key unit ${u}`}
          disabled={!enabled}
          styles={styles}
          onPress={() => onUnitKey(u)}
        />
      ))}
    </View>
  );
}

export { GlyphFraction, GlyphIndexedRoot, GlyphPower, GlyphSquareRoot };

export type StructureKeysProps = {
  /** Inserts an EMPTY ▢/▢ (no grab) — the only way to build a mixed number. */
  onInsertFraction: () => void;
  /** Grabs the operand left of the caret as the base, like a typed `^`. */
  onInsertPower: () => void;
  onInsertSquareRoot?: () => void;
  onInsertRoot?: () => void;
  /** Show √▢ and ⁿ√▢. Off for answers that can't contain a radical. */
  showRoots?: boolean;
  enabled?: boolean;
  theme?: MathKeypadThemeOverride;
  style?: StyleProp<ViewStyle>;
};

/**
 * The 2-D builder's structure keys, drawn as the shape they insert. They stay
 * on screen even with a hardware keyboard attached: digits are easy to type,
 * but nobody should have to know that `^` means "exponent box".
 */
export function StructureKeys({
  onInsertFraction,
  onInsertPower,
  onInsertSquareRoot,
  onInsertRoot,
  showRoots = false,
  enabled = true,
  theme,
  style,
}: StructureKeysProps) {
  const resolved = useMathKeypadTheme(theme);
  const styles = useKeyStyles(theme);
  const ink = resolved.colors.ink;
  const glyphKey = (label: string, onPress: (() => void) | undefined, face: ReactNode) =>
    onPress ? (
      <PadKey
        label=""
        accessibilityLabel={label}
        disabled={!enabled}
        styles={styles}
        style={styles.glyphKey}
        onPress={onPress}
      >
        {face}
      </PadKey>
    ) : null;
  return (
    <View style={[styles.glyphGrid, style]}>
      {glyphKey("insert fraction", onInsertFraction, <GlyphFraction color={ink} />)}
      {glyphKey("insert exponent", onInsertPower, <GlyphPower color={ink} />)}
      {showRoots ? glyphKey("insert a square root", onInsertSquareRoot, <GlyphSquareRoot color={ink} />) : null}
      {showRoots ? glyphKey("insert a root with an index", onInsertRoot, <GlyphIndexedRoot color={ink} />) : null}
    </View>
  );
}
