/**
 * Pure thread model for the Content lens (thread-bar round). Three content
 * types are one top-level THREAD — Questions · Instruction · Stories — that
 * governs the whole surface (rail + pane). Answer FORMAT (written vs. hands-on)
 * is no longer a top-level thread: it is a facet INSIDE the Questions thread
 * (see {@link AnswerFormat}), so a teacher sees "everything this skill has" in
 * one pane and narrows by format. This module owns the thread identity, the
 * bar's display order, the facet identity, the legacy `?view=`/`?format=`
 * migration, and hydrating both from the URL. Kept pure so it is unit-tested
 * away from the page's query wiring and DOM.
 */

/** A content type = a top-level thread. (Was a right-pane tab; a chip before
 *  that.) The `ContentSection` name is retained since it round-trips as `view=`
 *  and threads the query wiring. Manipulatives is GONE as a thread — it folded
 *  into the Questions thread's Hands-on facet. */
export type ContentSection =
  | "questions"
  | "stories"
  | "instruction";

/** Canonical order (questions first, instruction last) — the legacy migration
 *  default and the stable identity list. The thread BAR renders in
 *  {@link THREAD_ORDER} (Andy's order), which differs. */
export const SECTION_ORDER: readonly ContentSection[] = [
  "questions",
  "stories",
  "instruction",
] as const;

/** The single thread bar's left-to-right order — Andy's chosen order for the
 *  one top-level switch (Instruction sits second, next to Questions). */
export const THREAD_ORDER: readonly ContentSection[] = [
  "questions",
  "instruction",
  "stories",
] as const;

/**
 * The answer-format facet that lives INSIDE the Questions thread (immediately
 * right of the thread bar, always visible). `all` shows the whole pool (written
 * + hands-on), `written` narrows to typed/template questions, `hands-on`
 * narrows to manipulatives — the three values {@link NodeItemPool}'s existing
 * `mode` already accepts (all / questions / manipulatives). Only meaningful when
 * the Questions thread is active. Default is `all`.
 */
export type AnswerFormat = "all" | "written" | "hands-on";

/** The facet's left-to-right order (All · Written · Hands-on). */
export const FACET_ORDER: readonly AnswerFormat[] = [
  "all",
  "written",
  "hands-on",
] as const;

/**
 * Migrate a `?view=` param to a tab. `view=` is an HONEST tab param again (it
 * persists the active tab). The removed top-level Manipulatives thread — and
 * its older `coverage` alias — now fold into the Questions thread (the Hands-on
 * facet, seeded by {@link formatFromParams}, reproduces the old view), so both
 * migrate here to `questions`. Anything unrecognised/absent → Questions too,
 * matching the historical default.
 */
export function migrateViewParam(viewParam: string | null): ContentSection {
  if (viewParam === "stories") return "stories";
  if (viewParam === "instruction") return "instruction";
  // Legacy fold: `manipulatives` (and its older `coverage` alias) → Questions;
  // the Hands-on facet is what actually reproduces the old view.
  return "questions";
}

/** The URL params that seed the active answer-format facet. `format=` carries
 *  it directly; `view=` is read only to honour the legacy manipulatives/coverage
 *  fold when no explicit `format=` is present. */
export type FacetUrlParams = {
  view: string | null;
  format: string | null;
};

/**
 * The answer-format facet a Content-lens URL hydrates. `format=` wins when
 * present; otherwise a legacy `view=manipulatives` (or the older `coverage`)
 * seeds the Hands-on facet, so an old bookmark lands on precisely the old view
 * (Questions thread + Hands-on). Everything else → `all` (the default).
 */
export function formatFromParams(p: FacetUrlParams): AnswerFormat {
  if (p.format === "written") return "written";
  if (p.format === "hands-on") return "hands-on";
  if (p.format === "all") return "all";
  if (p.view === "manipulatives" || p.view === "coverage") return "hands-on";
  return "all";
}

/** Round-trips as `?format=written|hands-on`; `all` is the default, so it drops
 *  the param entirely (like the `gaps=` toggle). */
export function serializeFormat(format: AnswerFormat): string | null {
  return format === "all" ? null : format;
}

/** The URL params that determine the active tab. `node`/`strand`/`view` only. */
export type ContentUrlParams = {
  node: string | null;
  strand: string | null;
  view: string | null;
};

/**
 * The active tab a Content-lens URL hydrates. `view=` carries the tab directly;
 * the one special case is a canonical Instruction URL — no `node=`, a `strand=`
 * (the selected instructional segment) — which opens the Instruction tab even
 * without a `view=`.
 */
export function tabFromParams(p: ContentUrlParams): ContentSection {
  if (!p.node && p.strand) return "instruction";
  return migrateViewParam(p.view);
}
