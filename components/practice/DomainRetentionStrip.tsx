"use client";

/**
 * DomainRetentionStrip — the Tier 2 freshness read (spec §10.2): whether this
 * scholar's green (fluent/overlearned) skills in this domain are due for a
 * tune-up. Reads the SAME `DomainRetentionSummary` aggregate the matrix's
 * Tier 1 hover reads (`cohortPractice.masteryForScholars`'s `retention`
 * field) through the SAME copy module (`domainRetentionCopy.ts`) — one
 * vocabulary, never a second freshness signal, and never anything drawn on
 * the cell itself (founder ruling, review/math-skills-matrix-visual-
 * language.html §9).
 *
 * Renders only when there is something to act on: no green skills yet, or
 * green skills that are all fresh, both say nothing (T3 — a strip that always
 * fires is standing chrome, not a signal), mirroring `DomainMapStatusStrip`'s
 * "silent when uninformative" convention.
 *
 * Uses the SAME `DetailNoteStrip` shell as `DomainMapStatusStrip` / the Math
 * plan scope note, so this sits at identical hierarchy, never louder.
 */

import { ArrowClockwise } from "@phosphor-icons/react";
import { Box } from "@chakra-ui/react";
import { DetailNoteStrip } from "@/components/practice/DetailNoteStrip";
import { retentionStripSentence } from "@/components/practice/domainRetentionCopy";
import type { DomainRetentionSummary } from "@/convex/lib/practice/domainRetention";

export function DomainRetentionStrip({
  retention,
  now,
}: {
  /** This scholar × domain's freshness aggregate, or undefined while loading. */
  retention: DomainRetentionSummary | undefined;
  /** The render pass's "now" snapshot (e.g. from `useNow()`). Required —
   * defaulting to a bare `Date.now()` here would call an impure function
   * during render; the caller owns the clock. */
  now: number;
}) {
  const sentence = retentionStripSentence(retention, now);
  if (!sentence) return null;

  return (
    <DetailNoteStrip
      testId="domain-retention-strip"
      glyph={
        <Box
          as="span"
          display="inline-flex"
          alignItems="center"
          justifyContent="center"
          w="15px"
          h="15px"
          flex="0 0 auto"
          title="Fluent skills due for review."
        >
          <ArrowClockwise size={14} weight="bold" color="var(--chakra-colors-orange-500)" />
        </Box>
      }
      word="Due for a tune-up"
      sentence={sentence}
    />
  );
}
