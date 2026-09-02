"use client";

/**
 * CheckpointBandGrid — the Math plan editor's checkpoint picker, in the
 * matrix's own vocabulary. One domain at a time: rows are "Any strand" then the
 * domain's strands in the order the server sent them, columns are the grades
 * that domain carries, and every intersection that the practice graph actually
 * holds is a `CheckpointBandChip`.
 *
 * It replaces two coupled native `<select>`s (strand, then grade), which had to
 * re-derive each other on every change and had to inject the held target as a
 * disabled "— out of scope" option purely because a native select silently
 * shows its first option otherwise. A grid needs neither: one click states the
 * strand AND the grade at once, and an out-of-scope band is drawn in place,
 * slashed, next to the scope editor that would admit it.
 *
 * Semantics: a `radiogroup` of `radio` chips with ONE roving tab stop. An
 * intersection the graph does not hold is an inert em dash, not a disabled
 * radio — there is nothing there to choose. Out-of-scope chips ARE radios, so
 * they are announced and skipped rather than hidden: the scope tree directly
 * above is how you admit them.
 *
 * The chosen chip is marked by the canonical corner flag only. No second
 * selected ring — one mark per signal.
 */

import { useRef, useState } from "react";
import { Box, chakra, Text } from "@chakra-ui/react";

import { CheckpointBandChip } from "@/components/practice/MathPlanMarks";
import {
  scopeAllowsCheckpoint,
  type CheckpointCatalogDomain,
  type CheckpointCornerState,
  type PracticeScope,
} from "@/components/practice/mathPlanProjection";

/** One band inside a domain: an optional strand, and the grade it names. */
export type BandChoice = { strand?: string; grade: string };

type Row = {
  key: string;
  label: string;
  strand?: string;
  grades: string[];
};

/**
 * Rows are "Any strand" then the domain's own strands — plus, when the HELD
 * band names a strand the catalogue no longer lists, that strand too. This is
 * the visual form of the workaround the retired `<select>`s needed: a stored
 * target must stay visible (slashed and unselectable if out of scope), never
 * silently vanish from the picker that is supposed to repair it.
 */
function rowsFor(domain: CheckpointCatalogDomain, held: BandChoice | null): Row[] {
  const rows: Row[] = [
    { key: "__any", label: "Any strand", grades: domain.grades },
    ...domain.strands.map((strand) => ({
      key: strand.strand,
      label: strand.label,
      strand: strand.strand,
      grades: strand.grades,
    })),
  ];
  if (held?.strand !== undefined && !rows.some((row) => row.strand === held.strand)) {
    rows.push({
      key: held.strand,
      label: held.strand,
      strand: held.strand,
      grades: [held.grade],
    });
  }
  return rows;
}

/** Columns are the grades the domain carries, plus the held band's own grade
 *  when the catalogue has lost it — same reason as the extra row. */
function gradesFor(domain: CheckpointCatalogDomain, held: BandChoice | null) {
  return held && !domain.grades.includes(held.grade)
    ? [...domain.grades, held.grade]
    : domain.grades;
}

/**
 * The band a freshly chosen domain should land on: the first in-scope
 * intersection the grid would offer, scanned in the order it renders. Used by
 * the editor's domain select, so switching domains never seeds a band the grid
 * itself would refuse.
 */
export function firstSelectableBand(
  domain: CheckpointCatalogDomain,
  scope: PracticeScope,
): BandChoice | null {
  for (const row of rowsFor(domain, null)) {
    if (!scopeAllowsCheckpoint(scope, { domain: domain.domain, ...(row.strand === undefined ? {} : { strand: row.strand }) })) {
      continue;
    }
    const grade = row.grades[0];
    if (grade === undefined) continue;
    return { grade, ...(row.strand === undefined ? {} : { strand: row.strand }) };
  }
  return null;
}

function sameBand(a: BandChoice | null, b: BandChoice) {
  return !!a && a.grade === b.grade && a.strand === b.strand;
}

export function CheckpointBandGrid({
  domain,
  scope,
  value,
  corner,
  onSelect,
}: {
  domain: CheckpointCatalogDomain;
  /** The DRAFT scope — an out-of-scope band is drawn slashed, never hidden. */
  scope: PracticeScope;
  /** The chosen band, when the draft's checkpoint is inside this domain. */
  value: BandChoice | null;
  /**
   * The corner state the chosen chip wears. The grid never DERIVES one: the
   * caller passes the plan's own reading for the stored target, and the neutral
   * "working toward" default for a band the server has not resolved yet (the
   * editor says so in words directly below the grid).
   */
  corner: CheckpointCornerState;
  onSelect: (band: BandChoice) => void;
}) {
  const rows = rowsFor(domain, value);
  const grades = gradesFor(domain, value);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const cellKey = (rowIndex: number, colIndex: number) =>
    `${rowIndex}:${colIndex}`;

  const bandAt = (rowIndex: number, colIndex: number): BandChoice | null => {
    const row = rows[rowIndex];
    const grade = grades[colIndex];
    if (!row || grade === undefined) return null;
    const band: BandChoice = {
      grade,
      ...(row.strand === undefined ? {} : { strand: row.strand }),
    };
    // The graph holds this intersection — or it is the held band, which stays
    // on the board even after the catalogue stopped listing it.
    if (!row.grades.includes(grade) && !sameBand(value, band)) return null;
    return band;
  };

  const enabledAt = (rowIndex: number, colIndex: number) => {
    const band = bandAt(rowIndex, colIndex);
    if (!band) return false;
    const row = rows[rowIndex]!;
    return scopeAllowsCheckpoint(scope, {
      domain: domain.domain,
      ...(row.strand === undefined ? {} : { strand: row.strand }),
    });
  };

  // One tab stop: the chosen chip when it is selectable, else the first chip a
  // teacher could actually choose.
  let firstEnabled: string | null = null;
  let chosenEnabled: string | null = null;
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < grades.length; c += 1) {
      if (!enabledAt(r, c)) continue;
      if (firstEnabled === null) firstEnabled = cellKey(r, c);
      const band = bandAt(r, c);
      if (band && sameBand(value, band)) chosenEnabled = cellKey(r, c);
    }
  }
  // A stale focus (the domain changed under it) must not swallow the tab stop.
  const focusStillValid = (() => {
    if (focusKey === null) return false;
    const [r, c] = focusKey.split(":").map(Number);
    return r !== undefined && c !== undefined && enabledAt(r, c);
  })();
  const tabStop =
    (focusStillValid ? focusKey : null) ?? chosenEnabled ?? firstEnabled;

  const focusCell = (rowIndex: number, colIndex: number) => {
    const key = cellKey(rowIndex, colIndex);
    setFocusKey(key);
    chipRefs.current.get(key)?.focus();
  };

  /** Step until an enabled chip is found; disabled and inert cells are skipped. */
  const step = (
    rowIndex: number,
    colIndex: number,
    dRow: number,
    dCol: number,
  ) => {
    let r = rowIndex + dRow;
    let c = colIndex + dCol;
    while (r >= 0 && r < rows.length && c >= 0 && c < grades.length) {
      if (enabledAt(r, c)) return focusCell(r, c);
      r += dRow;
      c += dCol;
    }
  };

  const edge = (rowIndex: number, toEnd: boolean) => {
    const order = toEnd
      ? [...grades.keys()].reverse()
      : [...grades.keys()];
    for (const c of order) {
      if (enabledAt(rowIndex, c)) return focusCell(rowIndex, c);
    }
  };

  const onKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    rowIndex: number,
    colIndex: number,
    band: BandChoice,
  ) => {
    switch (event.key) {
      case "ArrowRight":
        event.preventDefault();
        return step(rowIndex, colIndex, 0, 1);
      case "ArrowLeft":
        event.preventDefault();
        return step(rowIndex, colIndex, 0, -1);
      case "ArrowDown":
        event.preventDefault();
        return step(rowIndex, colIndex, 1, 0);
      case "ArrowUp":
        event.preventDefault();
        return step(rowIndex, colIndex, -1, 0);
      case "Home":
        event.preventDefault();
        return edge(rowIndex, false);
      case "End":
        event.preventDefault();
        return edge(rowIndex, true);
      case "Enter":
      case " ":
      case "Spacebar":
        event.preventDefault();
        return onSelect(band);
      default:
        return undefined;
    }
  };

  if (grades.length === 0) {
    // A domain whose skills carry no grade at all has no band to name. Say so
    // rather than rendering an empty grid (or an invalid zero-column track).
    return (
      <Text fontSize="xs" color="charcoal.400" data-testid="checkpoint-band-grid-empty">
        No graded skills in {domain.label} yet, so it cannot hold a checkpoint.
      </Text>
    );
  }

  return (
    <Box
      role="radiogroup"
      aria-label={`Checkpoint band in ${domain.label}`}
      overflowX="auto"
      data-testid="checkpoint-band-grid"
    >
      <Box
        display="grid"
        gridTemplateColumns={`minmax(120px, max-content) repeat(${grades.length}, 52px)`}
        alignItems="center"
        columnGap={1}
        rowGap={1}
        w="max-content"
        minW="100%"
      >
        <Box position="sticky" left={0} bg="white" zIndex={1} />
        {grades.map((grade) => (
          <Text
            key={`head-${grade}`}
            fontSize="2xs"
            fontWeight="700"
            color="charcoal.400"
            textAlign="center"
          >
            G{grade}
          </Text>
        ))}

        {rows.map((row, rowIndex) => (
          <Box key={row.key} display="contents">
            <Text
              position="sticky"
              left={0}
              bg="white"
              zIndex={1}
              pr={2}
              fontSize="xs"
              color="charcoal.600"
              lineClamp={1}
              title={row.label}
            >
              {row.label}
            </Text>
            {grades.map((grade, colIndex) => {
              const band = bandAt(rowIndex, colIndex);
              if (!band) {
                return (
                  <Text
                    key={`${row.key}-${grade}`}
                    aria-hidden
                    fontSize="xs"
                    color="gray.300"
                    textAlign="center"
                    data-testid="checkpoint-band-empty"
                  >
                    —
                  </Text>
                );
              }
              const disabled = !enabledAt(rowIndex, colIndex);
              const chosen = sameBand(value, band);
              const key = cellKey(rowIndex, colIndex);
              const name = `${row.label}, grade ${grade}${
                disabled ? " — out of practice scope" : ""
              }`;
              return (
                <chakra.button
                  type="button"
                  key={`${row.key}-${grade}`}
                  ref={(element: HTMLButtonElement | null) => {
                    if (element) chipRefs.current.set(key, element);
                    else chipRefs.current.delete(key);
                  }}
                  role="radio"
                  aria-checked={chosen}
                  aria-label={name}
                  title={disabled ? "Out of practice scope" : name}
                  disabled={disabled}
                  tabIndex={tabStop === key ? 0 : -1}
                  cursor={disabled ? "not-allowed" : "pointer"}
                  display="flex"
                  justifyContent="center"
                  borderRadius="md"
                  opacity={disabled ? 0.7 : 1}
                  _focusVisible={{
                    outline: "2px solid",
                    outlineColor: "violet.500",
                    outlineOffset: "1px",
                  }}
                  onClick={() => {
                    if (disabled) return;
                    setFocusKey(key);
                    onSelect(band);
                  }}
                  onKeyDown={(event) => onKeyDown(event, rowIndex, colIndex, band)}
                  data-testid={`checkpoint-band-chip-${row.key}-${grade}`}
                >
                  <CheckpointBandChip
                    size="grid"
                    label={`G${grade}`}
                    outOfScope={disabled}
                    corner={chosen ? corner : null}
                  />
                </chakra.button>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
