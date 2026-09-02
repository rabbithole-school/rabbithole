"use client";

/**
 * placeValue — decompose a number into its base-ten place parts. ONE kind with
 * three presentational modes (see `PlaceValueSpec` in types.ts):
 *
 *   • buildNumber   — set how many bundles sit in each place column (a Stepper
 *                     per column, like the Distributor's per-plate deal) until
 *                     the base-ten bundles assemble the target number.
 *   • expandedForm  — the same per-column build, but the running expansion
 *                     (4×100 + 3×10 + 7×1) is shown prominently: compose /
 *                     decompose 400 + 30 + 7 ↔ 437.
 *   • placeShift    — no steppers; ×10 / ÷10 buttons slide every digit across
 *                     the columns (the grade-4/5 "10× the place to the right").
 *
 * All the math is the shared logic layer (`placeValueSolved`, `initialPlaceValue`,
 * `placeValueTotal`, `placeValueShift`, `placeValueMaxPerPlace`); this file owns
 * only pixels + input. The state it reports up (`{counts}`) is exactly what the
 * server re-grades — Done can only fire once a real count/shift has been made.
 */
import { useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { PlaceValueSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import {
  initialPlaceValue,
  placeValueMaxPerPlace,
  placeValueShift,
  placeValueSolved,
  placeValueTotal,
} from "@/lib/manipulative/logic";
import { Stepper } from "../Stepper";

const PLACE_NAMES = ["Ones", "Tens", "Hundreds", "Thousands", "Ten-thousands", "Hundred-thousands", "Millions"];

/** Kid-facing column name for a place value (1 → "Ones", 100 → "Hundreds"). */
function placeName(place: number): string {
  const exp = Math.round(Math.log10(place));
  return PLACE_NAMES[exp] ?? `×${place}`;
}

/** A stack of base-ten bundle glyphs for one column: flats (100), rods (10),
 *  units (1). Kept purely decorative — the count is the source of truth. */
function BundleStack({ place, count }: { place: number; count: number }) {
  const exp = Math.round(Math.log10(place));
  // ones → dot, tens → tall rod, hundreds+ → square flat (progressively bigger).
  const glyph = (i: number) => {
    if (exp === 0) return <Box key={i} w="14px" h="14px" borderRadius="full" bg={C.cyan} />;
    if (exp === 1) return <Box key={i} w="10px" h="34px" borderRadius="3px" bg={C.violet} />;
    const s = Math.min(20 + (exp - 2) * 6, 38);
    return (
      <Box
        key={i}
        w={`${s}px`}
        h={`${s}px`}
        borderRadius="4px"
        bg={C.orange}
        border={`1px solid ${C.line}`}
        css={{
          backgroundImage:
            "repeating-linear-gradient(0deg, rgba(255,255,255,.55) 0 2px, transparent 2px 6px), repeating-linear-gradient(90deg, rgba(255,255,255,.55) 0 2px, transparent 2px 6px)",
        }}
      />
    );
  };
  return (
    <Flex wrap="wrap" gap="4px" justify="center" align="flex-end" minH="40px" w="100%">
      {Array.from({ length: count }, (_, i) => glyph(i))}
    </Flex>
  );
}

export function PlaceValueManipulative({ spec, onSolvedChange, onStateChange }: KindProps<PlaceValueSpec>) {
  const [counts, setCounts] = useState<number[]>(() => initialPlaceValue(spec).counts);
  const max = placeValueMaxPerPlace(spec);
  const total = placeValueTotal(spec, counts);
  const isShift = spec.mode === "placeShift";

  // Report state up only AFTER a real interaction (matching the native
  // renderer), never on mount — an unmodified mount must NOT enable Done, or a
  // scholar could commit an immediate, recordable miss without touching the
  // material. `commit` is the single seam that lifts a new configuration.
  const commit = (next: number[]) => {
    setCounts(next);
    onSolvedChange(placeValueSolved(spec, { counts: next }));
    onStateChange?.({ counts: next });
  };
  const setColumn = (i: number, v: number) => {
    commit(counts.map((c, j) => (j === i ? v : c)));
  };
  const shift = (dir: "up" | "down") => {
    const next = placeValueShift(spec, counts, dir);
    if (next) commit(next);
  };

  const canUp = !isShift || placeValueShift(spec, counts, "up") != null;
  const canDown = !isShift || placeValueShift(spec, counts, "down") != null;

  const expansion = spec.places
    .map((place, i) => `${counts[i] ?? 0}×${place}`)
    .join(" + ");

  // The place columns NEVER wrap. Left-to-right order across the columns IS the
  // base-ten idea, so a hundreds/tens row with the ones column dropped underneath
  // is not a cosmetic squeeze — it destroys the thing being taught. The columns
  // therefore share the container's width (`flex: 1 1 0` + `minW: 0`), capped so
  // a two-place chart doesn't stretch into a banner, and the stepper goes
  // `compact` so its 92px readout can't set a floor the container can't meet.
  // (Before this, one column was 180px wide intrinsically: three places needed
  // 580px of stage, which is more than the frame's own 620px max card ever
  // offers — so EVERY multi-place spec wrapped, in the real practice run and in
  // Rehearse alike.)
  const columnCount = spec.places.length;
  const gap = columnCount > 3 ? "8px" : "16px";
  const labelSize = "12px";

  return (
    <Box>
      <Flex wrap="nowrap" gap={gap} justify="center" align="stretch" w="100%" mt={2} mb={4}>
        {spec.places.map((place, i) => (
          <Flex key={i} direction="column" align="center" gap={2} flex="1 1 0" minW={0} maxW="120px">
            <Text
              fontSize={{ base: columnCount > 3 ? "10px" : "11px", md: labelSize }}
              fontWeight="700"
              color="fg.muted"
              textTransform="uppercase"
              letterSpacing="0.04em"
              textAlign="center"
              lineHeight="1.2"
              // Reserve the same label height in every column so the bins keep a
              // common top edge no matter how many lines a place name takes
              // ("Ten-thousands" is two, and three at phone widths).
              minH={{ base: columnCount > 3 ? "3.6em" : "2.4em", md: "2.4em" }}
              w="100%"
              overflowWrap="anywhere"
            >
              {placeName(place)}
            </Text>
            <Box
              w="100%"
              minH="88px"
              flex="1 1 auto"
              p="8px"
              borderWidth="1px"
              borderColor={C.line}
              borderRadius="14px"
              bg="white"
              display="flex"
              alignItems="flex-end"
              justifyContent="center"
            >
              <BundleStack place={place} count={counts[i] ?? 0} />
            </Box>
            <Text fontSize="22px" fontWeight="800" color="brand.primary" lineHeight="1">
              {counts[i] ?? 0}
            </Text>
            {!isShift && (
              <Stepper
                compact
                value={counts[i] ?? 0}
                min={0}
                max={max}
                onChange={(v) => setColumn(i, v)}
                label={placeName(place).toLowerCase()}
              />
            )}
          </Flex>
        ))}
      </Flex>

      {isShift && (
        <Flex justify="center" gap={3} mb={3}>
          <ShiftButton label="÷ 10" disabled={!canDown} onClick={() => shift("down")} />
          <ShiftButton label="× 10" disabled={!canUp} onClick={() => shift("up")} />
        </Flex>
      )}

      {spec.mode === "expandedForm" && (
        <Text textAlign="center" fontSize="14px" fontWeight="700" color="fg.muted" mb={1}>
          {expansion}
        </Text>
      )}

      <Text textAlign="center" fontSize="17px" fontWeight="800" color="brand.primary">
        {total.toLocaleString()}
      </Text>
    </Box>
  );
}

function ShiftButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <Box
      as="button"
      onClick={() => !disabled && onClick()}
      aria-label={label}
      aria-disabled={disabled}
      px="18px"
      h="44px"
      borderRadius="12px"
      borderWidth="1px"
      borderColor="border.default"
      fontSize="18px"
      fontWeight="800"
      color={disabled ? "fg.subtle" : "brand.primary"}
      bg="white"
      _hover={disabled ? {} : { bg: "bg.muted" }}
      css={{ cursor: disabled ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      {label}
    </Box>
  );
}
