/**
 * FACT SPRINT — the "Fast math" beat builder (FastMath analog). Given the fact
 * families a run is ALREADY exercising and the scholar's per-fact ledger
 * (`factFluency`), pick their weakest facts and generate a short contiguous
 * block of bare single-digit items targeting exactly those facts.
 *
 * Pure + deterministic in `seed` so a run is reproducible and gradeable without
 * storing answers — each item is a normal `(skillKey, seed)` template draw
 * (found by a bounded seed search for the target fact), just flagged
 * `isFactSprint` so the composer groups the block into its own beat. Because the
 * items carry a real fact-family `skillKey`, they grade + bucket into
 * `factFluency` through the ordinary path with no special-casing.
 *
 * DOCTRINE: selection is silent (no clock, no number shown), self-relative
 * (weakness is judged against the scholar's OWN baseline), and NON-GATING — the
 * sprint is dormant until the substrate has real weak-fact signal, so it can
 * never block or reshape a run that has nothing to drill.
 */

import {
  type FactKey,
  factBelongsToFamily,
  factKeyFromOperands,
  factKeyOp,
} from "../../../shared/factKey";
import {
  type FactFluencyStats,
  type FactFluencyState,
  classifyFactState,
  factSpeedRead,
} from "./factFluency";
import { generateItem } from "./templates";
import { expressionAnswerSignals } from "./answerShape";
import { formatUnit } from "./answers";
import { makeItemId, type ServedItem } from "./session";
import { fastMathFactKeys } from "./fastMath";

/** Fewest facts a sprint will serve — below this the beat is dropped (a lone
 *  "Fast math" card isn't worth its own beat header). */
export const MIN_FACT_SPRINT_ITEMS = 2;
/** Most facts a sprint will serve — a short block, never a slog. */
export const MAX_FACT_SPRINT_ITEMS = 5;
/** A fact needs at least this many recorded attempts before it's sprint-eligible
 *  — one stray tap shouldn't conjure a targeted drill. */
export const MIN_SEEN_FOR_SPRINT = 2;
/** Bounded seed searches per target fact — the fact spaces are tiny (a handful
 *  of operands), so a match is found in a few draws or the target is skipped. */
const SEED_SEARCH_TRIES = 256;

/** A fact family present in the current run — the sprint only ever draws from a
 *  family the scholar is already working, never a cold one. */
export type SprintFamily = { skillKey: string; label: string; domain: string };

/** One of the scholar's per-fact ledger rows, assigned to the active family
 * whose generator should reproduce it. */
export type SprintFactRow = {
  factKey: FactKey;
  skillKey: string;
  stats: FactFluencyStats;
};

type Candidate = SprintFactRow & { state: FactFluencyState; accuracy: number };

/**
 * Build the "Fast math" sprint items, or `[]` when there's no weak-fact signal
 * yet (the common, dormant case). Targets the weakest eligible facts —
 * effortful before practicing, then least accurate, then slowest — across the
 * active families, deduped against facts already in the run.
 */
export function buildFactSprint(params: {
  families: readonly SprintFamily[];
  factRows: readonly SprintFactRow[];
  baseline: number | undefined;
  alreadyServedFactKeys: ReadonlySet<string>;
  seed: number;
  maxItems?: number;
}): ServedItem[] {
  const { families, factRows, baseline, alreadyServedFactKeys, seed } = params;
  const cap = Math.min(params.maxItems ?? MAX_FACT_SPRINT_ITEMS, MAX_FACT_SPRINT_ITEMS);
  if (cap < MIN_FACT_SPRINT_ITEMS || families.length === 0) return [];

  const famByKey = new Map(families.map((f) => [f.skillKey, f]));

  const candidates: Candidate[] = [];
  for (const row of factRows) {
    if (!famByKey.has(row.skillKey)) continue;
    if (alreadyServedFactKeys.has(row.factKey)) continue;
    if (row.stats.seenCount < MIN_SEEN_FOR_SPRINT) continue;
    const state = classifyFactState(row.stats, baseline);
    const eligible =
      state === "effortful" ||
      (state === "practicing" && factSpeedRead(row.stats, baseline) !== null);
    if (!eligible) continue;
    candidates.push({
      ...row,
      state,
      accuracy: row.stats.correctCount / Math.max(1, row.stats.seenCount),
    });
  }
  if (candidates.length < MIN_FACT_SPRINT_ITEMS) return [];

  candidates.sort(byWeakestFirst);

  const out: ServedItem[] = [];
  let seedStream = (seed >>> 0) || 1;
  for (const target of candidates) {
    if (out.length >= cap) break;
    const fam = famByKey.get(target.skillKey)!;
    const item = generateFactItemForKey(target.factKey, fam, seedStream);
    seedStream = advanceSeed(seedStream);
    if (item) out.push(item);
  }
  // Never emit a stub beat: if generation couldn't find enough real targets
  // (rare — a fact space too small to hit), drop the sprint entirely.
  return out.length >= MIN_FACT_SPRINT_ITEMS ? out : [];
}

/**
 * Build an explicit Quick-facts-only run. Unlike the opportunistic sprint that
 * is appended to an ordinary scheduler run, this begins with the whole
 * canonical generator space: it neither needs an active fact-family queue nor
 * waits for weak-fact evidence, and an adult-issued calculator license has no
 * bearing on it.
 *
 * Existing weak facts are preferred when available, then untouched facts, but
 * every canonical fact remains eligible. This keeps a first run useful while
 * preserving the sprint's ordinary generated-item and grading contract.
 */
export function buildQuickFactsPractice(params: {
  families: readonly SprintFamily[];
  factRows: readonly SprintFactRow[];
  baseline: number | undefined;
  seed: number;
  maxItems?: number;
}): ServedItem[] {
  const cap = Math.max(
    MIN_FACT_SPRINT_ITEMS,
    Math.min(
      Math.floor(params.maxItems ?? MAX_FACT_SPRINT_ITEMS),
      MAX_FACT_SPRINT_ITEMS,
    ),
  );
  if (params.families.length === 0) return [];

  const statsByFactKey = new Map<string, FactFluencyStats>();
  for (const row of params.factRows) statsByFactKey.set(row.factKey, row.stats);

  const candidates = fastMathFactKeys()
    .map((factKey) => {
      const family = params.families.find((candidate) =>
        factBelongsToFamily(factKey, candidate.skillKey),
      );
      if (!family) return null;
      const stats = statsByFactKey.get(factKey);
      return {
        factKey,
        family,
        stats,
        priority: quickFactsPriority(stats, params.baseline),
      };
    })
    .filter(
      (
        candidate,
      ): candidate is {
        factKey: FactKey;
        family: SprintFamily;
        stats: FactFluencyStats | undefined;
        priority: number;
      } => candidate !== null,
    )
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        seededFactOrder(a.factKey, params.seed) - seededFactOrder(b.factKey, params.seed),
    );

  const out: ServedItem[] = [];
  let seedStream = (params.seed >>> 0) || 1;
  for (const target of candidates) {
    if (out.length >= cap) break;
    const item = generateFactItemForKey(
      target.factKey,
      target.family,
      seedStream,
    );
    seedStream = advanceSeed(seedStream);
    if (item) out.push(item);
  }
  // A direct round needs a real short set, not a lone orphaned prompt. Empty
  // therefore means the canonical generator could not form a useful round.
  return out.length >= MIN_FACT_SPRINT_ITEMS ? out : [];
}

function quickFactsPriority(
  stats: FactFluencyStats | undefined,
  baseline: number | undefined,
): number {
  if (!stats) return 1; // First-run facts are a valid, useful starting point.
  const state = classifyFactState(stats, baseline);
  if (
    stats.seenCount >= MIN_SEEN_FOR_SPRINT &&
    (state === "effortful" ||
      (state === "practicing" && factSpeedRead(stats, baseline) !== null))
  ) {
    return 0;
  }
  return 2;
}

/** Stable seed-sensitive tiebreaker without changing the canonical candidate set. */
function seededFactOrder(factKey: FactKey, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < factKey.length; index++) {
    hash = Math.imul(hash ^ factKey.charCodeAt(index), 16777619) >>> 0;
  }
  return hash;
}

/** effortful → practicing, then least-accurate, then slowest (undefined median
 *  = untimed = treated as slowest), then stable by factKey. */
function byWeakestFirst(a: Candidate, b: Candidate): number {
  const rank = (c: Candidate) => (c.state === "effortful" ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (a.accuracy !== b.accuracy) return a.accuracy - b.accuracy;
  const am = a.stats.latencyMedianMs ?? Number.POSITIVE_INFINITY;
  const bm = b.stats.latencyMedianMs ?? Number.POSITIVE_INFINITY;
  if (am !== bm) return bm - am;
  return a.factKey.localeCompare(b.factKey);
}

/**
 * Find a deterministic `(skillKey, seed)` template draw whose rendered fact is
 * exactly `factKey`, and shape it into a sprint `ServedItem`. Returns `null` if
 * a bounded search can't land the target (then the caller just skips it).
 */
function generateFactItemForKey(
  factKey: FactKey,
  fam: SprintFamily,
  seedStart: number,
): ServedItem | null {
  const op = factKeyOp(factKey);
  if (op === null) return null;
  for (let i = 0; i < SEED_SEARCH_TRIES; i++) {
    const gseed = ((seedStart ^ Math.imul(i + 1, 2654435761)) >>> 0) || 1;
    const item = generateItem(fam.skillKey, gseed);
    if (!item) return null; // no template → give up on this family
    if (item.form) continue; // never target the missing-operand inverse form
    if (!item.variant) continue;
    if (factKeyFromOperands(item.variant.a, item.variant.op, item.variant.b) !== factKey) continue;
    return {
      itemId: makeItemId(fam.skillKey, gseed, item.form),
      skillKey: fam.skillKey,
      skillLabel: fam.label,
      domain: fam.domain,
      stem: item.stem,
      answerType: item.answerType,
      ...(item.answerUnit ? { answerUnit: formatUnit(item.answerUnit) } : {}),
      choices: item.choices,
      promptVisual: item.promptVisual,
      ...expressionAnswerSignals(item.answerType, item.answer),
      lane: "new",
      isFactSprint: true,
      factKey,
    };
  }
  return null;
}

function advanceSeed(s: number): number {
  return ((Math.imul(s, 1664525) + 1013904223) >>> 0) || 1;
}
