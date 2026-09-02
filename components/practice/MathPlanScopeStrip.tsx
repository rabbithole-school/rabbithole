"use client";

/**
 * MathPlanScopeStrip — the one line that says a scholar-scoped detail body is
 * showing work their Math plan does not serve.
 *
 * The matrix already draws this as the out-of-scope SLASH, and it teaches that
 * mark by hover alone; a teacher who lands in the detail panel never saw the
 * tooltip, so here the same glyph is paired with its state WORD and one plain
 * sentence — the identical "teach the mark" move `DomainMapStatusStrip` makes,
 * in the identical `DetailNoteStrip` shell.
 *
 * It REPLACES the mapping strip when it fires. Mapping guidance ("no check-in
 * has measured this domain yet") is a next action, and there is no next action
 * while the plan excludes the work: nothing here is served, so running a
 * check-in would change nothing. One note, the one that is true.
 *
 * Neutral gray, never red — an authored boundary is policy, not an error. The
 * suspended-CHECKPOINT case is a genuine misconfiguration and keeps its own red
 * alert inside `MathPlanRailSection`; this strip does not restate it.
 */

import { Box } from "@chakra-ui/react";

import { DetailNoteStrip } from "@/components/practice/DetailNoteStrip";
import { OutOfScopeSlash } from "@/components/practice/MathPlanMarks";
import {
  scopeAllowsDomain,
  scopeAllowsStrand,
  type MathPlanRow,
} from "@/components/practice/mathPlanProjection";

/**
 * What this scholar's plan excludes at the altitude in view, or null when the
 * work IS served. A whole excluded domain outranks its strands: naming the
 * domain is the more useful and more accurate sentence, and every strand in it
 * is out anyway.
 *
 * Also read by the detail bodies, which suppress the mapping strip when this
 * returns non-null.
 */
export function planScopeExclusion(
  plan: MathPlanRow | undefined,
  domain: string | null,
  strand?: string | null,
): "domain" | "strand" | null {
  if (!plan || !domain) return null;
  if (!scopeAllowsDomain(plan.practiceScope, domain)) return "domain";
  if (strand != null && !scopeAllowsStrand(plan.practiceScope, domain, strand)) {
    return "strand";
  }
  return null;
}

/** The 44px matrix cell, at strip scale, with the canonical hairline across it. */
function ScopeGlyph() {
  return (
    <Box
      as="span"
      position="relative"
      display="inline-flex"
      w="15px"
      h="15px"
      borderRadius="4px"
      borderWidth="1px"
      borderColor="gray.300"
      bg="white"
      flex="0 0 auto"
      title="Out of practice scope — this scholar's Math plan does not include this."
    >
      <OutOfScopeSlash />
    </Box>
  );
}

export function MathPlanScopeStrip({
  plan,
  domain,
  domainLabel,
  strand,
  strandLabel,
  firstName,
}: {
  /** This scholar's row from `api.mathPlans.forScholars`. */
  plan: MathPlanRow | undefined;
  /** The domain in view. */
  domain: string | null;
  domainLabel: string;
  /** The selected skill's strand, where the body is showing one skill. */
  strand?: string | null;
  strandLabel?: string;
  firstName: string;
}) {
  const excluded = planScopeExclusion(plan, domain, strand);
  if (!excluded) return null;

  const subject =
    excluded === "domain"
      ? domainLabel
      : `the ${strandLabel ?? strand} strand`;

  return (
    <DetailNoteStrip
      testId="math-plan-scope-strip"
      glyph={<ScopeGlyph />}
      word="Not served"
      sentence={`${subject} is outside ${firstName}\u2019s Math plan, so nothing in it is served while the plan is active.`}
    />
  );
}
