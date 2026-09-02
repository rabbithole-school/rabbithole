/**
 * Single source of truth for the pure Workbench display/scoring helpers
 * shared by web + native. These turn spec + run data into neutral labels and
 * the personal-delta framing the plan requires (§7.3, §4) — NO diagnosis
 * lives here; the system reports, it never explains why.
 *
 * `components/workbench/helpers.ts` (web) and
 * `native/src/components/workbench/helpers.ts` (native, via the vendored
 * `native/vendor/simulator/helpers.ts` copy) both re-export from this module
 * instead of hand-copying it — see `native/scripts/sync-vendor.js`.
 */

import {
  MAX_ECOSYSTEM_SPECIES_SLOTS,
  type MetricValue,
  type SimulatorSense,
  type SimulatorSpec,
} from "./contract";

/**
 * The living-sprite cadence shared by the Workbench's web and native renderers.
 * It is deliberately additive decoration: projection continues to own each
 * automaton's recorded position.
 */
export const AMBIENT_BOB_PX = 1.6;
export const AMBIENT_BOB_HALF_CYCLE_MS = 1300;
export const AMBIENT_BOB_CYCLE_MS = AMBIENT_BOB_HALF_CYCLE_MS * 2;

/** Canonical species palette for both deck cards and rendered ecosystem entities. */
export const SPECIES_COLORS = [
  "#0072B2",
  "#D55E00",
  "#009E73",
  "#CC79A7",
  "#6A3D9A",
  "#A65628",
  "#56B4E9",
  "#B58900",
  "#1A1A1A",
  "#7F7F00",
  "#B2182B",
  "#1B3A8A",
] as const;

export function colorForSlotIndex(index: number): string {
  return SPECIES_COLORS[index % SPECIES_COLORS.length];
}

/** Human labels for the ecosystem metric keys. Neutral nouns, never verdicts. */
const METRIC_LABELS: Record<string, string> = {
  longevity: "days survived",
  livingAutomata: "living automata",
  scoringSlotSurvivors: "living members of your species",
  livingSpecies: "living species",
  resourceBiomass: "algae",
  totalEnergy: "energy",
  births: "births",
  deaths: "deaths",
  invalidActions: "invalid actions",
};

export function metricLabel(key: string, value?: number): string {
  if (key === "scoringSlotSurvivors") {
    return value === 1 ? "living member of your species" : "living members of your species";
  }
  return METRIC_LABELS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

export function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return Math.abs(value) >= 100 || Number.isInteger(value)
    ? Math.round(value).toLocaleString()
    : value.toFixed(1);
}

/** The one-line criterion the whole bench is judged against. */
export function criterionSentence(spec: SimulatorSpec): string {
  if (spec.criterion.kind === "gallery") {
    return spec.criterion.curatorNote ?? `Compose the "${spec.criterion.frameKey}" frame`;
  }
  if (spec.criterion.kind === "adversarial") {
    const editableSlots = spec.speciesSlots.filter((slot) => !slot.locked);
    const lockedSlots = spec.speciesSlots.filter((slot) => slot.locked);
    if (
      editableSlots.length === 1 &&
      lockedSlots.length === 0 &&
      editableSlots[0].defaultCount === 2
    ) {
      return "See what happens when your strategy meets a copy of itself";
    }
    if (editableSlots.length === 1 && lockedSlots.length === 1) {
      return "Adapt your strategy to one fixed, readable partner";
    }
    return "Test the strategies against each other, round by round";
  }
  if (
    spec.criterion.metricKey === "scoringSlotSurvivors" &&
    spec.criterion.direction === "maximize"
  ) {
    return "Keep your species alive through the last day";
  }
  const metric = metricLabel(spec.criterion.metricKey);
  switch (spec.criterion.direction) {
    case "maximize":
      return `Grow ${metric} as high as it will go`;
    case "minimize":
      return `Hold ${metric} as low as you can`;
    case "target":
      return `Bring ${metric} to ${formatMetric(spec.criterion.target ?? 0)}`;
  }
}

/** The selected run's neutral criterion feedback, including terminal outcomes. */
export function criterionFeedbackSentence(spec: SimulatorSpec, extinct: boolean): string {
  return extinct ? "No automata survived." : criterionSentence(spec);
}

/** The metric key the criterion scores on, or null for gallery simulator. */
export function criterionMetricKey(spec: SimulatorSpec): string | null {
  return spec.criterion.kind === "measured" ? spec.criterion.metricKey : null;
}

/**
 * Choose the compact evidence chart's canonical metrics. A one-species ecosystem
 * has only one liveness signal, so `livingSpecies` would merely repeat
 * `livingAutomata`; total energy carries distinct evidence in that freed slot.
 */
export function chartMetricKeys(
  spec: SimulatorSpec,
  samples: readonly { values: readonly MetricValue[] }[],
  limit = 4,
): string[] {
  const available = new Set(samples.flatMap((sample) => sample.values.map((value) => value.key)));
  const criterion = criterionMetricKey(spec);
  const singleSpeciesEcosystem = spec.templateId === "ecosystemGrid" && spec.speciesSlots.length === 1;
  const preferred = singleSpeciesEcosystem
    ? [criterion, "totalEnergy", "resourceBiomass", "livingAutomata"]
    : [
        criterion,
        "totalEnergy",
        "livingAutomata",
        "livingSpecies",
        "resourceBiomass",
        "longevity",
        "births",
        "deaths",
        "invalidActions",
      ];
  const keys: string[] = [];
  for (const key of [...preferred, ...available]) {
    if (!key || !available.has(key) || keys.includes(key)) continue;
    keys.push(key);
    if (keys.length === limit) break;
  }
  return keys;
}

/** The visible time domain must include the run budget so an early terminal
 * marker appears at its recorded day rather than collapsing onto the plot edge. */
export function chartTimeSpan(
  samples: readonly { tick: number }[],
  targetTicks: number,
): number {
  return Math.max(1, samples.at(-1)?.tick ?? 0, targetTicks);
}

function criterionDirection(spec: SimulatorSpec): "maximize" | "minimize" | "target" {
  return spec.criterion.kind === "measured" ? spec.criterion.direction : "maximize";
}

/** Pull the criterion score off a run's criterionScores (null if not scored). */
export function runCriterionScore(
  spec: SimulatorSpec,
  scores: readonly MetricValue[],
): number | null {
  const key = criterionMetricKey(spec);
  if (!key) return null;
  const hit = scores.find((score) => score.key === key);
  return hit ? hit.value : null;
}

/**
 * The Compare plot can show an extinct run's final measured value without
 * treating it as a score. Extinction deliberately clears criterionScores so it
 * cannot become a best run; currentMetrics is display evidence only here.
 */
export function runCompareDisplayValue(
  spec: SimulatorSpec,
  scores: readonly MetricValue[],
  currentMetrics: readonly MetricValue[],
  extinct: boolean,
): { value: number; terminal: boolean } | null {
  const key = criterionMetricKey(spec);
  if (!key) return null;
  if (extinct) {
    const metric = currentMetrics.find((candidate) => candidate.key === key);
    return metric ? { value: metric.value, terminal: true } : null;
  }
  const score = runCriterionScore(spec, scores);
  return score === null ? null : { value: score, terminal: false };
}

/**
 * Low-level min/target/max comparison: is `candidate` a better value than
 * `best` under `direction` (and `target`, when direction is "target")?
 */
export function isBetterBy(
  candidate: number,
  best: number,
  direction: "maximize" | "minimize" | "target",
  target: number | undefined,
): boolean {
  if (direction === "minimize") return candidate < best;
  if (direction === "target") {
    const goal = target ?? 0;
    return Math.abs(candidate - goal) < Math.abs(best - goal);
  }
  return candidate > best;
}

/** Is `candidate` a better criterion result than `best` under the spec's direction? */
export function isBetter(
  spec: SimulatorSpec,
  candidate: number,
  best: number,
): boolean {
  const dir = criterionDirection(spec);
  const target = spec.criterion.kind === "measured" ? spec.criterion.target : undefined;
  return isBetterBy(candidate, best, dir, target);
}

/**
 * Personal-delta headline for the viewport (never a class ranking). Only
 * meaningful once there's more than one run to compare — on the first/only
 * scored run "your best deck yet" is nonsense (nothing to be best of). Native
 * (`WorkbenchScreen.tsx`) already applies this `runCount > 1` guard; this is
 * the shared home so web matches it exactly instead of re-deriving the rule.
 *
 * For "target" criteria, the raw `runScore - bestScore` sign is meaningless —
 * a run can be numerically higher than the best yet objectively FURTHER from
 * the goal (e.g. target 50, best 48, run 53: +5 reads as an improvement but
 * run is 3 away from goal vs. best's 2). The non-superlative copy for target
 * criteria is expressed in distance-to-target terms instead (review Finding 2).
 */
export function personalDeltaHeadline(
  spec: SimulatorSpec,
  runScore: number | null,
  bestScore: number | null,
  runCount: number,
  extinct = false,
): string | null {
  if (extinct || runCount <= 1 || runScore === null || bestScore === null) return null;
  if (isBetter(spec, runScore, bestScore) || runScore === bestScore) {
    return "your best deck yet";
  }
  if (criterionDirection(spec) === "target") {
    const goal = spec.criterion.kind === "measured" ? (spec.criterion.target ?? 0) : 0;
    const distanceRun = Math.abs(runScore - goal);
    const distanceBest = Math.abs(bestScore - goal);
    const magnitude = formatMetric(Math.abs(distanceBest - distanceRun));
    return distanceRun < distanceBest
      ? `${magnitude} closer to target vs your best`
      : `${magnitude} further from target vs your best`;
  }
  return `${formatMetric(runScore - bestScore)} vs your best`;
}

/**
 * A first run is baseline exploration. Once a personal completed run exists,
 * later launches must capture a prediction before they start.
 */
export type PredictionGateDecision = "launch" | "open-gate" | "await-prediction";

export function predictionGateDecision(input: {
  hasCompletedRun: boolean;
  gateOpen: boolean;
  prediction: string | null;
}): PredictionGateDecision {
  if (!input.hasCompletedRun) return "launch";
  if (!input.gateOpen) return "open-gate";
  if (!input.prediction) return "await-prediction";
  return "launch";
}

/**
 * Can the SESSION OWNER append a new Species slot to this bench's spec? Only the
 * ecosystemGrid template has an open roster (up to MAX_ECOSYSTEM_SPECIES_SLOTS). Templates
 * with a FIXED roster (e.g. prisonersDilemma is exactly two matched strategies)
 * never grow, and no FIXED-roster template exceeds MAX_SPECIES_SLOTS. The criterion is always
 * left locked — adding a species is a roster edit, never a goal change.
 */
export function canAddSpeciesSlot(spec: SimulatorSpec): boolean {
  return (
    spec.templateId === "ecosystemGrid" &&
    spec.speciesSlots.length < MAX_ECOSYSTEM_SPECIES_SLOTS
  );
}

/** "sight 4 · smell · touch" — the world-given Senses line for a Species. */
export function sensesLine(senses: readonly SimulatorSense[]): string {
  if (senses.length === 0) return "no senses";
  return senses
    .map((sense) => (sense.range && sense.range > 0 ? `${sense.senseId} ${sense.range}` : sense.senseId))
    .join(" · ");
}

/**
 * The prompt actually shown for a Species card. A LOCKED slot's deck is
 * teacher-authored and VISIBLE but not editable — it always displays the
 * authored `starterHint` verbatim, regardless of whatever an unreconciled
 * deck card might still hold (see `reconcileDeckForSpec` in
 * convex/simulatorBenches.ts, which pins the persisted card the same way). Single
 * home for web (`PromptDeckPanel`) and native (`PromptDeckSheet`) so a locked
 * card can never show stale/edited text on either surface.
 */
export function deckDisplayPrompt(
  slot: Pick<SimulatorSpec["speciesSlots"][number], "locked" | "starterHint">,
  card: { prompt: string },
): string {
  return slot.locked ? (slot.starterHint ?? "") : card.prompt;
}

/**
 * Per-template SETTING PHRASE for species-icon generation — a short, concrete
 * visual scene that anchors the generator when a species label's own word-
 * prior is strong enough to beat the world's title alone. The live referent
 * audit after the title-only fix (plan §7.4) still showed 4/24 species
 * misgenerating where a common-word reading wins over the title's steer:
 * "grazers" → sheep, "cleaners" → human workers, "open niche" → an
 * architectural doorway, and (prisonersDilemma) "trader ben" → a bear (the
 * generator latching onto "ben" bear-adjacent associations). Phrases are
 * deliberately concrete visual nouns, not abstractions — a generation prompt
 * responds to "coral reef ecosystem", not to "an ecological simulation".
 */
const SPECIES_ICON_SETTING_PHRASE: Record<string, string> = {
  ecosystemGrid: "coral reef ecosystem",
  prisonersDilemma: "two trading partners",
  matrixGame: "two players in a strategy game",
  publicGoods: "village of neighbors",
};

/**
 * Mirrors `convex/lib/themeIconArt.ts`'s `MAX_THEME_LABEL_LEN` (currently 60)
 * — the hard cap `manipulativeThemeIcons.ensure` enforces on a cache-key
 * label. A label over that cap is REJECTED SILENTLY: `ensure` returns before
 * creating a cache row, so the icon never generates and the caller falls
 * back to the plain colored dot FOREVER — no error, no "failed" status, just
 * a quiet permanent no-op. Seven of #2159's title-bearing composed keys
 * (long titles like "when trust is the whole game" + template + species) ran
 * 61-64 chars and hit exactly this silent rejection.
 *
 * This helper is framework-free and vendored VERBATIM into
 * `native/vendor/simulator/helpers.ts` (native never imports `convex/lib/*`
 * directly — see the vendoring convention in `native/scripts/sync-vendor.js`),
 * so the number is duplicated here rather than imported. A dedicated vitest
 * assertion in `components/workbench/__tests__/helpers.test.ts` imports the
 * REAL `MAX_THEME_LABEL_LEN` from `convex/lib/themeIconArt.ts` and keeps the
 * two in lockstep.
 */
const SPECIES_ICON_LABEL_MAX_LEN = 60;

/**
 * Compose the theme-icon generation label for a Species (plan §7.4), giving
 * the generator the world's setting so it draws a referent that actually
 * fits (The Reef's "Grazers" → a reef fish, not a cow or a sheep). The
 * world's TITLE was folded in by #2159, but the live referent audit proved
 * the authored SETTING PHRASE alone does the steering work — the title was
 * redundant weight, and worse, some titles pushed composed keys over
 * `SPECIES_ICON_LABEL_MAX_LEN` (see above). So the label is now
 * `world:<setting phrase>:<species>` — no title. The setting phrase is
 * authored per template (a constant, never user text) so it stays a stable
 * cache key — same template+species always composes the same key, and every
 * prior shape's cache rows (the original un-namespaced keys, #2159's titled
 * keys) simply go cold. That's the third such cooling in three days; the
 * feature is brand new, so it's cheap.
 *
 * Single home for web (`components/workbench/useSimulatorSpeciesIcon.ts`) and native
 * (`native/src/components/workbench/useSimulatorSpeciesIcon.ts`, via the vendored
 * `native/vendor/simulator/helpers.ts` copy of this file) — identical
 * normalization (lowercase · collapse whitespace · trim) keeps both surfaces
 * resolving to the SAME `manipulativeThemeIcons` cache row.
 */
export function composeSpeciesIconLabel(
  simulatorTemplate: string,
  speciesLabel: string,
): string {
  const settingPhrase = SPECIES_ICON_SETTING_PHRASE[simulatorTemplate] ?? simulatorTemplate;
  const composed = `world:${settingPhrase}:${speciesLabel}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (composed.length <= SPECIES_ICON_LABEL_MAX_LEN) return composed;

  // Defensive clamp so a future long species label (or a future template's
  // longer phrase) can never silently miss the cache: truncate only the
  // species TAIL, never the setting phrase — the phrase is what fixes the
  // referent, so it must survive intact even at the cost of an abbreviated
  // species name.
  const prefix = `world:${settingPhrase}:`.toLowerCase().replace(/\s+/g, " ");
  if (composed.startsWith(prefix)) {
    const budget = Math.max(0, SPECIES_ICON_LABEL_MAX_LEN - prefix.length);
    return `${prefix}${composed.slice(prefix.length, prefix.length + budget)}`;
  }
  // Unreachable in practice (the prefix is always literally present before
  // normalization touches it), but never emit a label over the cap.
  return composed.slice(0, SPECIES_ICON_LABEL_MAX_LEN);
}

const HYPOTHESIS_LABEL: Record<string, string> = {
  better: "better",
  worse: "worse",
  about_the_same: "about the same",
  exploratory: "exploring",
};

export function hypothesisLabel(prediction: string): string {
  return HYPOTHESIS_LABEL[prediction] ?? prediction;
}

/**
 * Word-level diff of two Species prompts for the Compare deck diff (plan §7.3).
 * Returns a token stream tagged added/removed/same. A minimal LCS is plenty at
 * prompt scale and keeps the render honest about exactly what the edit changed.
 */
export type DiffToken = { text: string; kind: "same" | "added" | "removed" };

export function wordDiff(before: string, after: string): DiffToken[] {
  const a = before.split(/(\s+)/).filter((token) => token.length > 0);
  const b = after.split(/(\s+)/).filter((token) => token.length > 0);
  const rows = a.length;
  const cols = b.length;
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const tokens: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      tokens.push({ text: a[i], kind: "same" });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      tokens.push({ text: a[i], kind: "removed" });
      i += 1;
    } else {
      tokens.push({ text: b[j], kind: "added" });
      j += 1;
    }
  }
  while (i < rows) tokens.push({ text: a[i++], kind: "removed" });
  while (j < cols) tokens.push({ text: b[j++], kind: "added" });
  return tokens;
}

// ── Round-token / pool entity conventions (contract.ts's "round aliveness
// conventions") ─────────────────────────────────────────────────────────────
// The repeated-game templates (prisonersDilemma, matrixGame, publicGoods) all
// emit a `token:<actionId>` scene entity per Automaton per round, and
// publicGoods additionally promotes its shared pool to a first-class `"pool"`
// entity. Pure classification lives here so both renderers style them
// identically without either depending on template internals -- a renderer
// keys ONLY off the entity's own `kind` string, per the contract.

const TOKEN_ENTITY_KIND_PREFIX = "token:";

/** True for a repeated-game round's action-choice token entity (contract.ts's
 *  `token:<actionId>` convention), false for anything else -- including the
 *  Automaton and corpse kinds every template shares, and a future template's
 *  own unrecognized kind. */
export function isRoundTokenEntityKind(kind: string): boolean {
  return kind.startsWith(TOKEN_ENTITY_KIND_PREFIX) && kind.length > TOKEN_ENTITY_KIND_PREFIX.length;
}

/** True for publicGoods's shared pool entity (contract.ts: "the pool itself,
 *  promoted to a first-class scene entity"). */
export function isPoolEntityKind(kind: string): boolean {
  return kind === "pool";
}

/**
 * A short, legible glyph for a round-token badge -- the token's own authored
 * action label's first letter, uppercased (contract.ts: `label` is always
 * "the template's author-facing action label ... never just the actionId").
 * Falls back to a plain dot so a token missing a label (never happens today,
 * but the contract doesn't require one) still renders something legible
 * rather than blank.
 */
export function tokenBadgeGlyph(label: string | undefined): string {
  const trimmed = label?.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "•";
}
