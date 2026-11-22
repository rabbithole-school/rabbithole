/** Framework-neutral scholar Math-plan projection, shared by web and native. */
export type PracticeScope =
  | { kind: "open" }
  | { kind: "limited"; domains: { domain: string; strands?: string[] }[] };

export type ScholarMathPlan = {
  practiceScope: PracticeScope;
  checkpoint: { domain: string; strand?: string; grade: string } | null;
};

export function scopeAllowsDomain(scope: PracticeScope, domain: string): boolean {
  return scope.kind === "open" || scope.domains.some((entry) => entry.domain === domain);
}

export function scopeAllowsStrand(
  scope: PracticeScope,
  domain: string,
  strand: string | null | undefined,
): boolean {
  if (scope.kind === "open") return true;
  const entry = scope.domains.find((item) => item.domain === domain);
  if (!entry) return false;
  return entry.strands === undefined || (strand != null && entry.strands.includes(strand));
}

export function scopeAllowsChoice(
  scope: PracticeScope,
  choice: { domain: string; strand?: string | null },
): boolean {
  return scopeAllowsStrand(scope, choice.domain, choice.strand);
}

/**
 * The ONE domain the Home playlist card previews for a Limited plan.
 * The plan stores its domains sorted by slug, so the first entry is whichever
 * sorts first (`algebra-1` for any plan that includes it), not one the scholar
 * works in. An unstarted first domain previews an empty set, which hides the
 * native card and reads "all caught up" on web while the blend that Start
 * serves has plenty. Prefer the first plan domain the scholar has started.
 */
export function previewPlanDomain(
  planDomains: readonly string[],
  startedDomains: readonly string[],
): string | undefined {
  return planDomains.find((domain) => startedDomains.includes(domain)) ?? planDomains[0];
}

function naturalList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** A single scholar-facing line; open plans deliberately have no extra copy. */
export function practiceScopeSentence(
  scope: PracticeScope,
  labels: {
    domainLabel: (domain: string) => string;
    strandLabel: (strand: string, domain: string) => string;
  },
): string | null {
  if (scope.kind === "open") return null;
  const entries = scope.domains
    .filter((entry) => entry.strands === undefined || entry.strands.length > 0)
    .flatMap((entry) => {
      const domain = labels.domainLabel(entry.domain);
      return entry.strands?.length
        ? entry.strands.map((strand) => `${domain} · ${labels.strandLabel(strand, entry.domain)}`)
        : [domain];
    });
  return entries.length ? `Your practice today stays within ${naturalList(entries)}.` : null;
}

/**
 * The scholar-facing line for a plan that currently leaves NOTHING servable —
 * the server's `blocked` flag, never a guess from the scope's shape.
 *
 * It is a boundary with a horizon, never a verdict about the scholar: it names
 * who drew the line (their teacher), says the line moves, and never implies the
 * scholar ran out of ability or finished their day. Anything that reads as
 * "you're all caught up 🎉" here is a false statement — the work exists, the
 * plan just doesn't reach it yet.
 */
export const PRACTICE_SCOPE_BLOCKED_HEADLINE =
  "No practice is available in your current Math plan.";

/** The second line, carrying the time horizon. Pairs with the headline above. */
export const PRACTICE_SCOPE_BLOCKED_DETAIL =
  "Your teacher chooses which areas are open right now. Check back later — practice returns as soon as your plan opens up.";
