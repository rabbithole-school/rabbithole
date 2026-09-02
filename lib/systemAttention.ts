/**
 * System attention — what the coherence sweep found about a scholar, in words a
 * teacher can act on.
 *
 * The sweep reports controlled metadata only (a rule id, a severity, a
 * representation gap, a disposition). This module is the one place that turns
 * that vocabulary into fixed human copy. Nothing here interpolates a finding's
 * id, source reference, or any learner text — those never reach the UI, so a
 * finding can only ever say "here is a shape of thing to look at", never quote
 * the child.
 *
 * These are notes about the SYSTEM's own blind spots, not about the scholar.
 * The copy is worded that way on purpose: a gap is a not-yet-built
 * understanding on our side, never a deficit pointed at a kid.
 */

/** The rule ids the sweep can raise against a scholar, without their version suffix. */
export type SystemAttentionRule =
  | "frustration_without_disposition"
  | "seed_agent_visible_human_truncated";

export type SystemAttentionCopy = {
  rule: SystemAttentionRule;
  /** The one-line headline. Sentence case, plain speech. */
  label: string;
  /** What a teacher would do about it, in one line. */
  help: string;
  colorPalette: "amber" | "violet";
};

const COPY: Record<SystemAttentionRule, SystemAttentionCopy> = {
  frustration_without_disposition: {
    rule: "frustration_without_disposition",
    label: "A rough patch nobody has answered yet",
    help: "Frustration was recorded and no one has said what to do about it. Worth a note in Rounds.",
    colorPalette: "amber",
  },
  seed_agent_visible_human_truncated: {
    rule: "seed_agent_visible_human_truncated",
    label: "The staff aide can see more exploration seeds than this list shows",
    help: "Some seeds available to the aide are not surfacing for staff. Review which seed view should be canonical.",
    colorPalette: "violet",
  },
};

/**
 * Findings arrive as `"<ruleId>:v<n>"`. The version is a sweep implementation
 * detail — a teacher never needs to read it, and an unknown rule must produce
 * nothing rather than leak its raw id into the UI.
 */
export function systemAttentionCopy(
  rule: string | null | undefined,
): SystemAttentionCopy | null {
  if (!rule) return null;
  const base = rule.split(":")[0];
  return COPY[base as SystemAttentionRule] ?? null;
}

/** True when the finding is still waiting on a human call. */
export function systemAttentionNeedsDecision(
  disposition: string | null | undefined,
): boolean {
  return disposition === "needs_decision" || disposition === "repair_proposed";
}

/**
 * "2 things to look at" — the group header.
 *
 * Deliberately counts distinct rule shapes, not scholars or events: this strip
 * is one compact group, never a second feed.
 */
export function systemAttentionHeadline(count: number): string {
  return count === 1 ? "1 thing the system wants a human on" : `${count} things the system wants a human on`;
}
