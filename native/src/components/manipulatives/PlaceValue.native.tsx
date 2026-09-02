/**
 * placeValue (native) — the RN port of the web PlaceValue. Decompose a number
 * into its base-ten place parts, in three presentational modes (see
 * `PlaceValueSpec` in vendor/manipulative/types.ts):
 *
 *   • buildNumber   — a Stepper per column sets how many bundles sit in each
 *                     place (like the Distributor's per-plate deal).
 *   • expandedForm  — the same build, with the running 4×100 + 3×10 + 7×1
 *                     expansion shown prominently.
 *   • placeShift    — ×10 / ÷10 buttons slide every digit across the columns.
 *
 * All the math is reused verbatim from the shared logic layer
 * (`placeValueSolved`, `initialPlaceValue`, `placeValueTotal`,
 * `placeValueShift`, `placeValueMaxPerPlace`); this file owns only pixels.
 */

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  initialPlaceValue,
  placeValueMaxPerPlace,
  placeValueShift,
  placeValueSolved,
  placeValueTotal,
} from "../../../vendor/manipulative/logic";
import type { PlaceValueState } from "../../../vendor/manipulative/logic";
import type { PlaceValueSpec } from "../../../vendor/manipulative/types";
import type { KindProps } from "./kit";
import { Stepper } from "./Stepper";
import { fonts, palette } from "@/theme";

const PLACE_NAMES = ["Ones", "Tens", "Hundreds", "Thousands", "Ten-thousands", "Hundred-thousands", "Millions"];

function placeName(place: number): string {
  const exp = Math.round(Math.log10(place));
  return PLACE_NAMES[exp] ?? `x${place}`;
}

/** A stack of base-ten bundle glyphs for one column (dots/rods/flats by place). */
function BundleStack({ place, count }: { place: number; count: number }) {
  const exp = Math.round(Math.log10(place));
  return (
    <View style={styles.stack}>
      {Array.from({ length: count }, (_, i) => {
        if (exp === 0) return <View key={i} style={styles.unit} />;
        if (exp === 1) return <View key={i} style={styles.rod} />;
        const s = Math.min(20 + (exp - 2) * 6, 34);
        return <View key={i} style={[styles.flat, { width: s, height: s }]} />;
      })}
    </View>
  );
}

export function PlaceValueNative({
  spec,
  onSolvedChange,
  onStateChange,
}: KindProps<PlaceValueSpec, PlaceValueState>) {
  const [counts, setCounts] = useState<number[]>(() => initialPlaceValue(spec).counts);
  const max = placeValueMaxPerPlace(spec);
  const total = placeValueTotal(spec, counts);
  const isShift = spec.mode === "placeShift";

  const commit = (next: number[]) => {
    setCounts(next);
    onSolvedChange(placeValueSolved(spec, { counts: next }));
    onStateChange?.({ counts: next });
  };
  const setColumn = (i: number, v: number) => commit(counts.map((c, j) => (j === i ? v : c)));
  const shift = (dir: "up" | "down") => {
    const next = placeValueShift(spec, counts, dir);
    if (next) commit(next);
  };

  const canUp = !isShift || placeValueShift(spec, counts, "up") != null;
  const canDown = !isShift || placeValueShift(spec, counts, "down") != null;

  const expansion = spec.places.map((place, i) => `${counts[i] ?? 0}x${place}`).join(" + ");

  // The place columns NEVER wrap (web parity — see the same note in
  // components/manipulative/kinds/PlaceValueManipulative.tsx). Left-to-right
  // order across the columns IS the base-ten idea, so dropping the ones column
  // onto a second row breaks the thing being taught. Columns therefore share
  // the container width and the stepper goes `compact`; previously a column was
  // 204pt wide intrinsically, so three places needed 640pt of a 480pt practice
  // column and every multi-place spec wrapped on the iPad.
  const columnCount = spec.places.length;
  const narrow = columnCount > 3;

  return (
    <View style={styles.wrap}>
      <View style={[styles.columns, { gap: narrow ? 8 : 14 }]}>
        {spec.places.map((place, i) => (
          <View key={i} style={styles.col}>
            <Text style={styles.placeLabel}>{placeName(place)}</Text>
            <View style={styles.bin}>
              <BundleStack place={place} count={counts[i] ?? 0} />
            </View>
            <Text style={styles.digit}>{counts[i] ?? 0}</Text>
            {!isShift && (
              <Stepper
                compact
                value={counts[i] ?? 0}
                min={0}
                max={max}
                label={placeName(place).toLowerCase()}
                onChange={(v) => setColumn(i, v)}
              />
            )}
          </View>
        ))}
      </View>

      {isShift && (
        <View style={styles.shiftRow}>
          <ShiftButton label="÷ 10" disabled={!canDown} onPress={() => shift("down")} />
          <ShiftButton label="× 10" disabled={!canUp} onPress={() => shift("up")} />
        </View>
      )}

      {spec.mode === "expandedForm" && <Text style={styles.expansion}>{expansion}</Text>}

      <Text style={styles.total}>{total.toLocaleString()}</Text>
    </View>
  );
}

function ShiftButton({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      hitSlop={6}
      style={({ pressed }) => [
        styles.shiftBtn,
        pressed && !disabled && { backgroundColor: palette.gray[50] },
      ]}
    >
      <Text style={[styles.shiftText, disabled && { color: palette.charcoal[300] }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 14, alignItems: "center" },
  columns: {
    flexDirection: "row",
    flexWrap: "nowrap",
    justifyContent: "center",
    alignItems: "stretch",
    width: "100%",
  },
  col: { alignItems: "center", gap: 6, flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0, maxWidth: 120 },
  // Full 12pt even in a five-place chart — the columns are ~83pt on the 480pt
  // practice column, which fits "THOUSANDS" outright and wraps "TEN-THOUSANDS"
  // to the two lines `minHeight` reserves. Shrinking kid-facing concept labels
  // to buy layout room is the wrong trade (`visual-design.md`, no tiny text);
  // reserving a uniform label height keeps every bin on one top edge instead.
  placeLabel: {
    fontFamily: fonts.bold,
    fontSize: 12,
    lineHeight: 15,
    minHeight: 30,
    textAlign: "center",
    color: palette.charcoal[400],
    textTransform: "uppercase",
  },
  bin: {
    width: "100%",
    flexGrow: 1,
    minHeight: 88,
    padding: 8,
    borderWidth: 1,
    borderColor: palette.gray[200],
    borderRadius: 14,
    backgroundColor: palette.white,
    justifyContent: "flex-end",
    alignItems: "center",
  },
  stack: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "flex-end",
    gap: 4,
  },
  unit: { width: 14, height: 14, borderRadius: 7, backgroundColor: palette.cyan[500] },
  rod: { width: 10, height: 34, borderRadius: 3, backgroundColor: palette.violet[500] },
  flat: {
    borderRadius: 4,
    backgroundColor: palette.orange[500],
    borderWidth: 1,
    borderColor: palette.gray[200],
  },
  digit: { fontFamily: fonts.bold, fontSize: 22, color: palette.navy[500] },
  shiftRow: { flexDirection: "row", gap: 12, justifyContent: "center" },
  shiftBtn: {
    paddingHorizontal: 18,
    height: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: palette.gray[200],
    backgroundColor: palette.white,
    alignItems: "center",
    justifyContent: "center",
  },
  shiftText: { fontFamily: fonts.bold, fontSize: 18, color: palette.navy[500] },
  expansion: {
    fontFamily: fonts.bold,
    fontSize: 14,
    color: palette.charcoal[400],
    textAlign: "center",
  },
  total: { fontFamily: fonts.bold, fontSize: 17, color: palette.navy[500], textAlign: "center" },
});
