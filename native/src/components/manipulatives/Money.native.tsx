/**
 * Money (native) — the RN port of the web Money. Tap a piece in the BANK to add
 * it to the TRAY, tap a piece in the tray to take it back, and watch the
 * running total. Two zones rather than a stepper grid: a scholar counting money
 * picks up one coin at a time and re-counts the pile, and the tray IS the pile.
 *
 * Pieces come from `CurrencyArt.native`, which draws from the same vendored
 * `currency` table the web faces do — so a dime renders SMALLER than a nickel
 * while being worth twice as much, on both surfaces.
 */

import { useCallback, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { MONEY_PIECES, formatMoney, moneyPieceCents } from "../../../vendor/manipulative/currency";
import {
  initialMoney,
  liveReadoutPolicy,
  moneyMaxPerDenomination,
  moneyPieceTotal,
  moneySolved,
  moneyTotalCents,
} from "../../../vendor/manipulative/logic";
import type { MoneyState } from "../../../vendor/manipulative/logic";
import type { MoneySpec } from "../../../vendor/manipulative/types";
import { CurrencyArt } from "./CurrencyArt.native";
import { usePressPop, type KindProps } from "./kit";
import { fonts, palette } from "@/theme";

/** Size of a QUARTER in px; every other piece scales off its real diameter. */
const BANK_BASE = 62;
const TRAY_BASE = 52;

export function MoneyNative({ spec, onSolvedChange, onStateChange }: KindProps<MoneySpec, MoneyState>) {
  const [counts, setCounts] = useState<number[]>(() => initialMoney(spec).counts);
  const max = moneyMaxPerDenomination(spec);
  /**
   * The tray mirrored into a ref, read by `add`/`remove` instead of the
   * `counts` closure — web parity, and the same reason: two taps in one React
   * batch both see the SAME rendered `counts`, so the second is silently lost.
   * A fast double-tap on a coin is a completely ordinary thing for a kid to do.
   */
  const countsRef = useRef(counts);

  const commit = useCallback(
    (next: number[]) => {
      countsRef.current = next;
      setCounts(next);
      onSolvedChange(moneySolved(spec, { counts: next }));
      onStateChange?.({ counts: next });
    },
    [spec, onSolvedChange, onStateChange],
  );

  const add = (i: number) => {
    const current = countsRef.current;
    if ((current[i] ?? 0) >= max) return;
    commit(current.map((c, j) => (j === i ? c + 1 : c)));
  };
  const remove = (i: number) => {
    const current = countsRef.current;
    if ((current[i] ?? 0) <= 0) return;
    commit(current.map((c, j) => (j === i ? c - 1 : c)));
  };

  const totalCents = moneyTotalCents(spec, counts);
  const pieces = moneyPieceTotal(counts);
  // Every money goal names the cents; the count is named only by
  // `amountEqualsWithCount`. Web parity; see `liveReadoutPolicy`.
  const readout = liveReadoutPolicy(spec);

  // The tray, expanded into one entry per physical piece and sorted by value
  // descending — the order a scholar counts a real pile in.
  const trayPieces = spec.available
    .map((denomination, i) => ({ denomination, i, n: counts[i] ?? 0 }))
    .filter((p) => p.n > 0)
    .sort((a, b) => moneyPieceCents(b.denomination) - moneyPieceCents(a.denomination))
    .flatMap((p) => Array.from({ length: p.n }, (_, k) => ({ ...p, k })));

  return (
    <View style={styles.wrap}>
      <Text style={styles.zoneLabel}>BANK — TAP TO ADD</Text>
      <View style={styles.bank}>
        {spec.available.map((denomination, i) => (
          <BankPiece
            key={denomination}
            denomination={denomination}
            atCap={(counts[i] ?? 0) >= max}
            onPress={() => add(i)}
          />
        ))}
      </View>

      <Text style={styles.zoneLabel}>TRAY — TAP A COIN TO PUT IT BACK</Text>
      <View style={styles.tray}>
        {trayPieces.length === 0 ? (
          <Text style={styles.empty}>Empty — tap a coin above to start.</Text>
        ) : (
          trayPieces.map((p) => (
            <Pressable
              key={`${p.denomination}-${p.k}`}
              onPress={() => remove(p.i)}
              accessibilityRole="button"
              accessibilityLabel={`Put back a ${MONEY_PIECES[p.denomination]?.label ?? p.denomination}`}
              hitSlop={2}
            >
              <CurrencyArt denomination={p.denomination} base={TRAY_BASE} />
            </Pressable>
          ))
        )}
      </View>

      <View style={styles.totalRow}>
        {readout.showValue && <Text style={styles.total}>{formatMoney(totalCents)}</Text>}
        {readout.showCount && (
          <Text style={readout.showValue ? styles.pieces : styles.total}>
            {pieces} {pieces === 1 ? "piece" : "pieces"} in the tray
          </Text>
        )}
      </View>
    </View>
  );
}

function BankPiece({
  denomination,
  atCap,
  onPress,
}: {
  denomination: keyof typeof MONEY_PIECES;
  atCap: boolean;
  onPress: () => void;
}) {
  const facts = MONEY_PIECES[denomination];
  // The shared tap feel — a selection tick + a quick scale pop, the same one
  // every other tappable manipulative piece uses.
  const { pop } = usePressPop();
  return (
    <Pressable
      onPress={
        atCap
          ? undefined
          : () => {
              pop();
              onPress();
            }
      }
      disabled={atCap}
      accessibilityRole="button"
      accessibilityLabel={`Add a ${facts?.label ?? denomination}`}
      accessibilityState={{ disabled: atCap }}
      style={({ pressed }) => [
        styles.bankPiece,
        atCap && styles.bankPieceDisabled,
        pressed && !atCap && { backgroundColor: palette.gray[50] },
      ]}
    >
      <CurrencyArt denomination={denomination} base={BANK_BASE} />
      <Text style={styles.bankLabel}>{facts?.label ?? denomination}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", gap: 8 },
  zoneLabel: {
    fontFamily: fonts.bold,
    fontSize: 11,
    letterSpacing: 0.8,
    color: palette.charcoal[400],
  },
  bank: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center", alignItems: "flex-end" },
  bankPiece: {
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: palette.gray[200],
    backgroundColor: palette.white,
  },
  bankPieceDisabled: { opacity: 0.45 },
  bankLabel: { fontFamily: fonts.bold, fontSize: 11, color: palette.charcoal[400], textAlign: "center" },
  tray: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    justifyContent: "center",
    alignItems: "center",
    minHeight: 86,
    padding: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: palette.gray[200],
    backgroundColor: palette.yellow[100],
  },
  empty: { fontFamily: fonts.medium, fontSize: 13, color: palette.charcoal[300] },
  totalRow: { flexDirection: "row", justifyContent: "center", alignItems: "baseline", gap: 8 },
  total: { fontFamily: fonts.bold, fontSize: 26, color: palette.navy[500] },
  pieces: { fontFamily: fonts.medium, fontSize: 14, color: palette.charcoal[400] },
});
