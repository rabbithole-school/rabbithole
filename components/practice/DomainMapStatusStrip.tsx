"use client";

/**
 * DomainMapStatusStrip — one calm line that makes a domain's CHECK-IN (mapping)
 * state legible in the scholar × domain detail drawer and the full report,
 * speaking the same survey-plot language the all-domains matrix cells do.
 *
 * The matrix teaches the mark by hover alone; a teacher who lands in the drawer
 * never saw that tooltip, so here the strip pairs the `MappingMark` glyph with
 * its state WORD and one plain-language sentence (review/math-skills-matrix-
 * visual-language.html §6; review/math-skills-mapping-mark-spike.html — "teach
 * the mark"). It renders only when informative: a converged domain WITH readings
 * speaks through its numbers (T3), so no strip; a converged domain with nothing
 * measured yet gets the one "just getting started" word its pale-green cell needs.
 *
 * Violet stays the mapping hue; the receding not-ready plot is grey; never red.
 * The finer distinctions (shadow-placed vs. available, the exact prereq) ride in
 * the glyph's tooltip rather than adding standing chrome (§6, item 4).
 *
 * The strip SHELL is `DetailNoteStrip`, shared with the Math plan's scope note
 * so the two notes sit at identical hierarchy. This file owns only the mapping
 * vocabulary.
 */

import { Box } from "@chakra-ui/react";
import type { ReactNode } from "react";
import { DetailNoteStrip } from "@/components/practice/DetailNoteStrip";
import { MappingMark } from "@/components/practice/MappingMark";

export type DomainMapStatus =
  | "converged"
  | "in_flight"
  | "shadow_placed"
  | "queued"
  | "available"
  | "ineligible";

// The matrix's STATE4_FLOOR_TINT — a converged domain with nothing measured yet
// renders as this pale-green cell; the strip shows the same swatch so the word
// and the cell teach each other.
const JUST_STARTED_TINT = "#edf6f0";

type StripContent = {
  glyph: ReactNode;
  word: string;
  sentence: string;
};

function stripContent({
  status,
  blockedBy,
  domainLabelFor,
  firstName,
}: {
  status: Exclude<DomainMapStatus, "converged"> | "convergedFresh";
  blockedBy: string[];
  domainLabelFor: (key: string) => string;
  firstName: string;
}): StripContent {
  switch (status) {
    case "available":
      return {
        glyph: (
          <MappingMark
            state="needsMapping"
            title="No placement check-in has been run for this domain yet."
          />
        ),
        word: "Needs mapping",
        sentence: "no check-in has measured this domain yet.",
      };
    case "shadow_placed":
      return {
        glyph: (
          <MappingMark
            state="needsMapping"
            title="Practiced before, but no check-in has ever converged — finish the check-in."
          />
        ),
        word: "Needs mapping",
        sentence: "no check-in has measured this domain yet.",
      };
    case "in_flight":
      return {
        glyph: (
          <MappingMark
            state="inProgress"
            title="A placement check-in is partway through."
          />
        ),
        word: "Mapping in progress",
        sentence: "a check-in is underway.",
      };
    case "queued": {
      const names = blockedBy
        .map(domainLabelFor)
        .filter(Boolean)
        .join(", ");
      return {
        glyph: (
          <MappingMark
            state="notReady"
            title="Blocked by a prerequisite domain that hasn't been mapped yet."
          />
        ),
        word: "Not ready yet",
        sentence: names
          ? `waiting on ${names} to be mapped first.`
          : "waiting on an earlier domain to be mapped first.",
      };
    }
    case "ineligible":
      return {
        glyph: (
          <MappingMark
            state="notReady"
            title="Outside the affect-safe grade range — deliberately not pointed here, not a gap."
          />
        ),
        word: "Not ready yet",
        sentence: `outside ${firstName}'s current grade range.`,
      };
    case "convergedFresh":
    default:
      return {
        glyph: (
          <Box
            as="span"
            display="inline-flex"
            w="15px"
            h="15px"
            borderRadius="4px"
            bg={JUST_STARTED_TINT}
            borderWidth="1px"
            borderColor="green.200"
            flex="0 0 auto"
            title="Measured — no practice recorded yet."
          />
        ),
        word: "Mapped",
        sentence: "just getting started.",
      };
  }
}

export function DomainMapStatusStrip({
  status,
  blockedBy,
  domainLabelFor,
  firstName,
  hasGreenReadings,
}: {
  /** The scholar × domain check-in state, or undefined while the query loads. */
  status: DomainMapStatus | undefined;
  /** Prerequisite domain keys still to be mapped (for `queued`). */
  blockedBy: string[];
  /** Domain key → display label, for the `queued` blocked-by clause. */
  domainLabelFor: (key: string) => string;
  /** The scholar's first name, for the (deliberate-exclusion) ineligible line. */
  firstName: string;
  /** Whether the scholar has any GREEN (placed/fluent/overlearned) reading in
   *  this domain. This must mirror the CELL's state-4 condition (converged with
   *  a null level = no green), not mere reading-existence: a scholar with only
   *  practicing rows still renders the pale "just getting started" cell, and
   *  the drawer that cell opens must say so — suppressing the strip on a
   *  non-green practicing row left exactly that cell unexplained (founder
   *  report, 2026-08-19). */
  hasGreenReadings: boolean;
}) {
  // Unknown (loading) → say nothing rather than flash a wrong state.
  if (status === undefined) return null;
  // Converged with a computable level: the numbers speak; no strip.
  if (status === "converged" && hasGreenReadings) return null;

  const resolved = status === "converged" ? "convergedFresh" : status;
  const { glyph, word, sentence } = stripContent({
    status: resolved,
    blockedBy,
    domainLabelFor,
    firstName,
  });

  return (
    <DetailNoteStrip
      testId="domain-map-status-strip"
      glyph={glyph}
      word={word}
      sentence={sentence}
    />
  );
}
