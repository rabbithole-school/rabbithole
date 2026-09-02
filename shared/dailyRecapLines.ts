/**
 * Framework-free line builder for the scholar-home map-movement receipt. The
 * web (`components/DailyRecapCard.tsx`) and native
 * (the daily state of `native/src/components/MapHomeCard.tsx`) BOTH call
 * `buildRecapLines` so the labels and ordering can never drift between the two
 * surfaces (SCHOLAR-facing parity is a standing rule). Imports nothing, so
 * native can vendor a read-only copy.
 *
 * Portrait, not report card: these are plain labels only — no scores, no
 * correct/wrong counts, no streaks (see review/anti-parasocial-design.md).
 */

export interface RecapLine {
  key: string;
  label: string;
  text: string;
  /** Which Knowledge Tree dot to render beside this event. "revealed" has no
   *  dot state of its own — the cards render it as the map's quiet
   *  locked/not-started dot, one step dimmer than the frontier amber. */
  mastery: "fluent" | "frontier" | "revealed";
}

/**
 * Which Knowledge Tree dot each recap state renders as — the mapping every
 * surface that draws these lines needs, so it lives beside `RecapLine` rather
 * than in three components. Kept as bare literals (this module imports nothing,
 * so native can vendor it); the values ARE `MasteryState` members and each call
 * site widens them at the dial.
 *
 * `revealed` has no dot state of its own: it renders as the map's quiet
 * locked/not-started dot, deliberately the dimmest of the three. On a dark card
 * that "dimmest" has to be re-stated rather than reused — see
 * `shared/masteryDialPalette.ts`.
 */
export const RECAP_DIAL_STATE = {
  fluent: "fluent",
  frontier: "frontier",
  revealed: "locked",
} as const satisfies Record<RecapLine["mastery"], string>;

export interface RecapLinesInput {
  practiced: string[];
  practicedCount: number;
  yoursNow: string[];
  newOnMap: string[];
  revealed: string[];
  finished: string[];
}

/**
 * Turn a recap's durable map buckets into one display line per knowledge node:
 * every green Fluent node first, then yellow frontier nodes not already shown as
 * Fluent, then quiet "Added to your Math Skills Tree" reveals not already shown as
 * either. The backend dedupes by node key; this final exact-label guard also
 * keeps mixed-version clients from rendering an obvious duplicate. The weaker
 * compatibility buckets remain deliberately ignored.
 */
export function buildRecapLines(recap: RecapLinesInput): RecapLine[] {
  const shown = new Set<string>();

  const fluent = dedupeLabels(recap.yoursNow);
  for (const label of fluent) shown.add(label);

  const frontier = dedupeLabels(recap.newOnMap).filter(
    (label) => !shown.has(label),
  );
  for (const label of frontier) shown.add(label);

  // `?? []` — a mid-rollout backend that predates the reveal feature omits the
  // field; the legacy buckets must keep rendering rather than crash the card.
  const revealed = dedupeLabels(recap.revealed ?? []).filter(
    (label) => !shown.has(label),
  );

  return [
    ...fluent.map((text) => ({
      key: `yoursNow:${text}`,
      label: "Fluent",
      text,
      mastery: "fluent",
    }) satisfies RecapLine),
    ...frontier.map((text) => ({
      key: `newOnMap:${text}`,
      label: "Your frontier moved",
      text,
      mastery: "frontier",
    }) satisfies RecapLine),
    ...revealed.map((text) => ({
      key: `revealed:${text}`,
      label: "Added to your Math Skills Tree",
      text,
      mastery: "revealed",
    }) satisfies RecapLine),
  ];
}

function dedupeLabels(labels: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const label of labels) {
    if (seen.has(label)) continue;
    seen.add(label);
    unique.push(label);
  }
  return unique;
}
