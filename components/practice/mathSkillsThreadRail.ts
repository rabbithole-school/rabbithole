/**
 * The Content lens's single-thread-bar model (thread-bar round). One top-level
 * thread — Questions · Instruction · Stories — governs the WHOLE surface: the
 * pane shows the focused thread, and the LEFT rail is scoped to that thread's
 * content. Inside the Questions thread an answer-FORMAT facet (All · Written ·
 * Hands-on) narrows further — the hands-on coverage job that used to be the
 * separate Manipulatives thread now lives here as a facet predicate, which is
 * the load-bearing edit (deleting the thread must NOT delete the coverage
 * surface). This module owns the pure pieces of that scoping:
 *   - `nodeHasThreadContent` — does a skill carry the active thread's content?
 *   - `nodeHasFacetContent` — does a skill carry the active Questions-facet's
 *     content? (the hands-on gap predicate the old Manipulatives thread supplied);
 *   - `strandThreadCoverage` — the "3 of 5 skills have stories" strand
 *     annotation (a count, never a percent);
 *   - `strandFacetCoverage` — the Questions-thread strand annotation, e.g.
 *     "6 of 6 skills have questions · 2 have hands-on" / "4 of 12 skills have
 *     hands-on items" — the same shape, keeping the sentence a teacher already
 *     knows verbatim;
 *   - the compact `gaps=` URL round-trip for the single "Show gaps" toggle.
 *
 * Kept pure so the coverage predicates + the URL token are unit-tested away from
 * the page's query wiring and DOM. Replaces the old `mathSkillsRailFilters.ts`
 * (the Show:-strip Skills/Instruction checkboxes + subset ViewToggle) and
 * `contentCoverageFilters.ts` (the Gaps menu) — the thread bar subsumes both.
 */

import type { AnswerFormat, ContentSection } from "./mathSkillsContentSections";

/** The minimal skill-node shape the coverage predicates read. */
export type ThreadNode = {
  hasTemplate: boolean;
  itemCount: number;
  hasManipulative: boolean;
};

/**
 * Does this skill node carry the ACTIVE thread's content? Story coverage is
 * supplied by the caller (`hasStory`) because a node doesn't carry its own
 * story-coverage flag (it's derived from the domain story list). Instruction is
 * strand/segment-scoped (a skill inherits its strand's segment and may add its
 * own node-grain one), so its per-skill "has content" is computed from
 * {@link instructionSegmentCount}, not from node fields — this predicate returns
 * `false` for it and the page never asks it to filter the Instruction thread.
 */
export function nodeHasThreadContent(
  node: ThreadNode,
  thread: ContentSection,
  hasStory: boolean,
): boolean {
  switch (thread) {
    case "questions":
      return node.hasTemplate || node.itemCount > 0;
    case "stories":
      return hasStory;
    case "instruction":
      return false;
  }
}

/**
 * Does this skill node carry the active Questions-thread FACET's content? This
 * is the predicate that used to be the separate Manipulatives thread's coverage
 * job (`hasManipulative`), now scoped per facet so "Show gaps" narrows to the
 * active format:
 *   - `written` — a code template OR at least one stored (non-manipulative) item
 *     (exactly the old Questions coverage);
 *   - `hands-on` — a stored manipulative (exactly the old Manipulatives coverage);
 *   - `all` — either of the above (the whole pool).
 */
export function nodeHasFacetContent(
  node: ThreadNode,
  format: AnswerFormat,
): boolean {
  switch (format) {
    case "written":
      return node.hasTemplate || node.itemCount > 0;
    case "hands-on":
      return node.hasManipulative;
    case "all":
      return node.hasTemplate || node.itemCount > 0 || node.hasManipulative;
  }
}

/** The thread's plural noun for rail copy ("… have stories"). */
export function threadNoun(thread: ContentSection): string {
  switch (thread) {
    case "questions":
      return "questions";
    case "stories":
      return "stories";
    case "instruction":
      return "instruction";
  }
}

/**
 * The strand-header coverage annotation for a NON-Questions thread — "0 of 4
 * skills have stories" / "4 of 21 skills have instruction" (a count, never a
 * percent). The Questions thread reads its own facet-aware annotation via
 * {@link strandFacetCoverage}. For the Instruction thread a skill "has
 * instruction" when at least one segment applies to it (its strand's segment,
 * which every skill in the strand inherits, and/or its own node-grain segment).
 */
export function strandThreadCoverage(
  have: number,
  total: number,
  thread: ContentSection,
): string | null {
  return `${have} of ${total} ${total === 1 ? "skill has" : "skills have"} ${threadNoun(thread)}`;
}

/**
 * The Questions-thread strand-header annotation, facet-aware. The `all` facet
 * keeps the exact sentence a teacher already knows — "N of M skills have
 * questions" — and grows a second clause so the hands-on count survives verbatim
 * ("· 2 have hands-on", singular "has" for one). `written` and `hands-on` narrow
 * to their own count with the SAME "N of M skills have …" shape. The denominator
 * is always `total` (all unfiltered skill nodes in the strand), so the metric
 * doesn't silently change meaning under a facet.
 */
export function strandFacetCoverage(
  writtenHave: number,
  handsOnHave: number,
  total: number,
  format: AnswerFormat,
): string {
  switch (format) {
    case "written":
      return `${writtenHave} of ${total} skills have written items`;
    case "hands-on":
      return `${handsOnHave} of ${total} skills have hands-on items`;
    case "all":
      return `${writtenHave} of ${total} skills have questions · ${handsOnHave} ${
        handsOnHave === 1 ? "has" : "have"
      } hands-on`;
  }
}

/**
 * How many instructional segments apply to ONE skill (Instruction thread's
 * per-row count pill): 1 when it inherits its strand's segment, +1 when it also
 * has its own node-grain segment — so 0, 1, or 2. A 0 is a gap (no segment
 * anywhere), hidden unless "Show gaps" is on.
 */
export function instructionSegmentCount(
  strandHasSegment: boolean,
  nodeHasOwnSegment: boolean,
): number {
  return (strandHasSegment ? 1 : 0) + (nodeHasOwnSegment ? 1 : 0);
}

/** The single "Show gaps" toggle round-trips as a compact `gaps=1` (present
 *  only when ON, so the default drops the param entirely). */
export function parseGaps(value: string | null): boolean {
  return value === "1";
}
export function serializeGaps(showGaps: boolean): string | null {
  return showGaps ? "1" : null;
}
