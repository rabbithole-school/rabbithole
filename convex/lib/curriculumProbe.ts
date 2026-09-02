/**
 * The curriculum-sim OUTCOME PROBE — pure item/grading core (adoptable #1,
 * review/sim-realism-lessons.html §5).
 *
 * A sim session ends with a small held-out probe: 2–3 verified practice items
 * for the activity's target skills. We administer an ISOMORPHIC pre-probe
 * (before the session, cold) and post-probe (after, with the transcript in
 * context) so we can report a sim pre→post delta — "could the kid then answer
 * held-out items?" rather than "did the transcript sound like understanding?".
 *
 * Grading is DETERMINISTIC and reuses the EXACT real-practice submit seam
 * (gradeTemplateItem → parseAnswer + answersEqual): NO judge, NO LLM. The kid
 * answering the item is the only model call, and that lives in the "use node"
 * orchestrator (convex/curriculumSim.ts) — this module stays pure (no Convex,
 * no SDK, no I/O) so it's importable there AND unit-testable on its own. Item
 * generation + grading come from the deterministic template engine, so an
 * isomorphic pair is just the same skillKey at two different seeds.
 *
 * Read the delta as a DELTA BETWEEN VARIANTS over the same cast, never as an
 * absolute (a sim kid carries the paper's "too capable" bias). This module only
 * measures; nothing here gates promotion.
 */

import { type AnswerType } from "./practice/answers";
import { generateItem, hasTemplate } from "./practice/templates";
import { gradeTemplateItem, makeItemId } from "./practice/session";
import { expressionAnswerSignals } from "./practice/answerShape";

/** Default number of items in EACH of the pre / post probes (the doc's "2–3"). */
export const PROBE_ITEM_COUNT = 3;

/** One concrete probe item — stem shown to the kid, itemId used to grade. */
export type ProbeItem = {
  skillKey: string;
  /** `skillKey#seed[#form]` — re-derives the item (and its answer) at grade time. */
  itemId: string;
  stem: string;
  answerType: AnswerType;
  /** For a multipleChoice item: the option labels in `choiceIndex` order. */
  choices?: string[];
  /** "twoD" when this fraction/expression uses the canonical box editor. */
  answerShape?: "twoD";
};

/** An isomorphic pre/post pair for one skill (same template, different numbers). */
export type ProbePair = { skillKey: string; pre: ProbeItem; post: ProbeItem };

/** Per-item pre→post correctness in a finished probe. */
export type ProbeItemResult = {
  skillKey: string;
  /** POST stem (what the kid answered after the session). */
  stem: string;
  /** PRE stem (isomorphic to `stem` — same template, different numbers). */
  preStem: string;
  preCorrect: boolean;
  postCorrect: boolean;
};

/** The stored/aggregated probe result for one session. */
export type ProbeSummary = {
  skills: string[];
  itemsPerProbe: number;
  /** Fraction correct on the PRE probe (0..1). */
  preScore: number;
  /** Fraction correct on the POST probe (0..1). */
  postScore: number;
  /** postScore - preScore. */
  delta: number;
  items: ProbeItemResult[];
};

/**
 * Resolve which candidate target skills a probe can actually cover: only skills
 * with a DETERMINISTIC template (so grading needs no judge), deduped, order
 * preserved. Everything downstream keys off this — an empty result means "skip
 * the probe" (recorded as a reason, never a crash).
 */
export function resolveProbeSkills(candidateSkillKeys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of candidateSkillKeys) {
    if (!key || seen.has(key) || !hasTemplate(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Deterministic 32-bit mix of a base seed + a slot index (distinct per slot). */
function mixSeed(base: number, salt: number): number {
  let h = (base ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Turn a (skillKey, seed) into a served probe item, or null if untemplated. */
function toProbeItem(skillKey: string, seed: number): ProbeItem | null {
  const item = generateItem(skillKey, seed);
  if (!item) return null;
  const answerShape = expressionAnswerSignals(item.answerType, item.answer).answerShape;
  return {
    skillKey,
    itemId: makeItemId(skillKey, seed, item.form),
    stem: item.stem,
    answerType: item.answerType,
    choices: item.choices,
    ...(answerShape ? { answerShape } : {}),
  };
}

/**
 * Build up to `count` ISOMORPHIC pre/post probe pairs, drawn round-robin over
 * the resolved (templated) skills. Deterministic in `seedBase`. The pre and
 * post items of a pair share a skillKey (same template → same structure) but
 * use different seeds (different numbers), and we reject a pair whose two stems
 * happen to collide so pre/post are always distinct. Returns [] when no skill
 * resolves — the caller's graceful-skip signal.
 */
export function buildProbePairs(
  candidateSkillKeys: readonly string[],
  seedBase: number,
  count: number = PROBE_ITEM_COUNT,
): ProbePair[] {
  const resolved = resolveProbeSkills(candidateSkillKeys);
  if (resolved.length === 0) return [];
  const pairs: ProbePair[] = [];
  for (let slot = 0; slot < count; slot++) {
    const skillKey = resolved[slot % resolved.length];
    // Distinct pre/post seeds per slot; retry the post seed a few times if the
    // template happens to reproduce the same stem (rare for small ranges).
    const preSeed = mixSeed(seedBase, slot * 2 + 1);
    const pre = toProbeItem(skillKey, preSeed);
    if (!pre) continue;
    let post: ProbeItem | null = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const postSeed = mixSeed(seedBase, slot * 2 + 2 + attempt * 101);
      const candidate = toProbeItem(skillKey, postSeed);
      if (candidate && candidate.stem !== pre.stem) {
        post = candidate;
        break;
      }
      post = candidate; // keep the last valid one as a fallback
    }
    if (!post) continue;
    pairs.push({ skillKey, pre, post });
  }
  return pairs;
}

/**
 * Grade one probe item DETERMINISTICALLY against its template, re-derived from
 * the itemId — the same seam the real practice submit path uses
 * (gradeTemplateItem → parseAnswer + answersEqual). `rawAnswer` is the sim
 * kid's extracted answer text. No model, no judge.
 */
export function gradeProbeItem(item: ProbeItem, rawAnswer: string): boolean {
  const graded = gradeTemplateItem(item.itemId, rawAnswer);
  return graded?.correct ?? false;
}

/**
 * Grade a probe's collected pre/post answers into a ProbeSummary. `preAnswers`
 * and `postAnswers` are the sim kid's EXTRACTED answer strings, positionally
 * aligned to `pairs`. Missing entries grade as incorrect.
 */
export function summarizeProbe(
  pairs: ProbePair[],
  preAnswers: (string | null | undefined)[],
  postAnswers: (string | null | undefined)[],
): ProbeSummary {
  const items: ProbeItemResult[] = pairs.map((pair, i) => ({
    skillKey: pair.skillKey,
    stem: pair.post.stem,
    preStem: pair.pre.stem,
    preCorrect: gradeProbeItem(pair.pre, preAnswers[i] ?? ""),
    postCorrect: gradeProbeItem(pair.post, postAnswers[i] ?? ""),
  }));
  const n = items.length;
  const preScore = n ? items.filter((it) => it.preCorrect).length / n : 0;
  const postScore = n ? items.filter((it) => it.postCorrect).length / n : 0;
  return {
    skills: [...new Set(pairs.map((p) => p.skillKey))],
    itemsPerProbe: n,
    preScore,
    postScore,
    delta: postScore - preScore,
    items,
  };
}

/**
 * Run a probe end-to-end with INJECTED ask functions — `askPre`/`askPost` take
 * a probe item and return the sim kid's extracted answer string. The
 * orchestrator supplies closures that call the sim model (pre = cold, post =
 * with the session transcript); tests supply mocks. Grading stays deterministic
 * either way. Pre and post items are answered in parallel within each phase.
 */
export async function runProbe(
  pairs: ProbePair[],
  askPre: (item: ProbeItem) => Promise<string>,
  askPost: (item: ProbeItem) => Promise<string>,
): Promise<ProbeSummary> {
  const preAnswers = await Promise.all(pairs.map((p) => askPre(p.pre)));
  const postAnswers = await Promise.all(pairs.map((p) => askPost(p.post)));
  return summarizeProbe(pairs, preAnswers, postAnswers);
}

/** Per-variant aggregate: mean pre/post/delta over the sessions that have a
 *  probe. Returns null when no session on the variant carried a probe. */
export function meanProbe(
  summaries: Pick<ProbeSummary, "preScore" | "postScore" | "delta">[],
): { preScore: number; postScore: number; delta: number; n: number } | null {
  if (summaries.length === 0) return null;
  const n = summaries.length;
  const sum = summaries.reduce(
    (acc, s) => ({
      preScore: acc.preScore + s.preScore,
      postScore: acc.postScore + s.postScore,
      delta: acc.delta + s.delta,
    }),
    { preScore: 0, postScore: 0, delta: 0 },
  );
  return {
    preScore: sum.preScore / n,
    postScore: sum.postScore / n,
    delta: sum.delta / n,
    n,
  };
}
