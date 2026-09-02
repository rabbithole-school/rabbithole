"use client";

/**
 * Money — tap a piece in the BANK to add it to the TRAY, tap a piece in the
 * tray to take it back, and watch the running total. Two zones, not a stepper
 * grid: a scholar counting money picks up one coin at a time and re-counts the
 * pile, and the tray IS that pile.
 *
 * The pieces are drawn from the shared `lib/manipulative/currency` table via
 * `CurrencyArt`, so a dime renders SMALLER than a nickel while being worth
 * twice as much — the size-versus-value clash that makes coin counting hard,
 * kept rather than flattened into equal tokens.
 *
 * The tray shows the pieces themselves, sorted high-to-low, because "start from
 * the biggest and count on" is the strategy the goal shapes reward.
 */
import { useCallback, useRef, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { MoneySpec } from "@/lib/manipulative/types";
import { C, wash } from "../colors";
import { CurrencyArt } from "../CurrencyArt";
import { MONEY_PIECES, formatMoney, moneyPieceCents } from "@/lib/manipulative/currency";
import {
  initialMoney,
  liveReadoutPolicy,
  moneyMaxPerDenomination,
  moneyPieceTotal,
  moneySolved,
  moneyTotalCents,
} from "@/lib/manipulative/logic";

/** Size of a QUARTER in px; every other piece scales off its real diameter. */
const BANK_BASE = 62;
const TRAY_BASE = 52;

export function MoneyManipulative({ spec, onSolvedChange, onStateChange }: KindProps<MoneySpec>) {
  const [counts, setCounts] = useState<number[]>(() => initialMoney(spec).counts);
  const max = moneyMaxPerDenomination(spec);
  /**
   * The tray mirrored into a ref, and `add`/`remove` read it rather than the
   * `counts` closure. Two taps landing in the same React batch both close over
   * the SAME rendered `counts`, so `counts[i] + 1` twice is still +1 and the
   * second tap is silently lost — easy to hit with a fast double-tap on the
   * iPad. Reading (and writing) the ref makes every tap accumulate. A
   * functional updater would fix the counting too, but the parent's
   * onSolvedChange/onStateChange must not be called from inside one: React can
   * re-run an updater during render, which sets state on `Manipulative`
   * mid-render.
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
  // Every money goal names the cents, so the running total is withheld under a
  // challenge — a scholar would otherwise add pennies watching the number climb
  // to 47¢ rather than counting the coins. The piece COUNT is named only by
  // `amountEqualsWithCount`; under `fewestPieces` it is the thing being
  // minimised, so showing it is the point. See `liveReadoutPolicy`.
  const readout = liveReadoutPolicy(spec);

  // The tray, expanded into one entry per physical piece and sorted by value
  // descending — the order a scholar counts a real pile in.
  const trayPieces = spec.available
    .map((denomination, i) => ({ denomination, i, n: counts[i] ?? 0 }))
    .filter((p) => p.n > 0)
    .sort((a, b) => moneyPieceCents(b.denomination) - moneyPieceCents(a.denomination))
    .flatMap((p) => Array.from({ length: p.n }, (_, k) => ({ ...p, k })));

  return (
    <Box>
      {/* ── the bank ─────────────────────────────────────────────────────── */}
      <Text fontSize="11px" fontWeight="700" letterSpacing="0.08em" textTransform="uppercase" color="fg.muted" mb={2}>
        Bank — tap to add
      </Text>
      <Flex wrap="wrap" gap={2} justify="center" align="flex-end" mb={4}>
        {spec.available.map((denomination, i) => {
          const facts = MONEY_PIECES[denomination];
          const atCap = (counts[i] ?? 0) >= max;
          return (
            <Flex
              key={denomination}
              as="button"
              direction="column"
              align="center"
              gap={1}
              onClick={() => add(i)}
              aria-label={`Add a ${facts?.label ?? denomination}`}
              aria-disabled={atCap}
              px="6px"
              py="6px"
              borderRadius="14px"
              borderWidth="1px"
              borderColor="border.default"
              bg="white"
              opacity={atCap ? 0.45 : 1}
              _hover={atCap ? {} : { bg: "bg.muted" }}
              css={{ cursor: atCap ? "not-allowed" : "pointer" }}
            >
              <CurrencyArt denomination={denomination} base={BANK_BASE} />
              <Text fontSize="11px" fontWeight="700" color="fg.muted" lineHeight="1.1" textAlign="center">
                {facts?.label ?? denomination}
              </Text>
            </Flex>
          );
        })}
      </Flex>

      {/* ── the tray ─────────────────────────────────────────────────────── */}
      <Text fontSize="11px" fontWeight="700" letterSpacing="0.08em" textTransform="uppercase" color="fg.muted" mb={2}>
        Tray — tap a coin to put it back
      </Text>
      <Flex
        wrap="wrap"
        gap={2}
        justify="center"
        align="center"
        minH="86px"
        p={3}
        borderRadius="16px"
        borderWidth="1px"
        borderColor="border.default"
        style={{ background: wash(C.yellow, 0.22) }}
      >
        {trayPieces.length === 0 ? (
          <Text fontSize="13px" color="fg.subtle">
            Empty — tap a coin above to start.
          </Text>
        ) : (
          trayPieces.map((p) => (
            <Box
              as="button"
              key={`${p.denomination}-${p.k}`}
              onClick={() => remove(p.i)}
              aria-label={`Put back a ${MONEY_PIECES[p.denomination]?.label ?? p.denomination}`}
              borderRadius="999px"
              css={{ cursor: "pointer", lineHeight: 0 }}
            >
              <CurrencyArt denomination={p.denomination} base={TRAY_BASE} />
            </Box>
          ))
        )}
      </Flex>

      <Flex justify="center" align="baseline" gap={2} mt={3} minH="34px">
        {readout.showValue && (
          <Text fontSize="26px" fontWeight="800" color="brand.primary">
            {formatMoney(totalCents)}
          </Text>
        )}
        {readout.showCount && (
          <Text fontSize={readout.showValue ? "14px" : "20px"} fontWeight={readout.showValue ? "600" : "800"} color={readout.showValue ? "fg.muted" : "brand.primary"}>
            {pieces} {pieces === 1 ? "piece" : "pieces"} in the tray
          </Text>
        )}
      </Flex>
    </Box>
  );
}
