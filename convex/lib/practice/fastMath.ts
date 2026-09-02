/**
 * FAST MATH — the whole-ledger ROLL-UP of the Quick-facts automaticity
 * substrate, and a practice-readiness SIGNAL for the teacher-proctored
 * Calculator License Test.
 *
 * This adds NO new signal: every rung it counts is the existing per-fact
 * verdict from `classifyFactState` (convex/lib/practice/factFluency.ts), the
 * same one the teacher heatmap paints. What it adds is a DENOMINATOR — the
 * canonical fact space a scholar is being measured against — so "how much of
 * Fast Math is automatic" becomes a fraction instead of a pile of touched
 * facts.
 *
 * ── THE CANONICAL DENOMINATOR (load-bearing; documented, not tuned) ─────────
 * `fastMathFactKeys()` is every fact the Quick-facts GENERATOR SPACE can serve:
 * for each canonical operand pair in 0…{@link FAST_MATH_MAX_OPERAND}, the fact
 * is in the space iff `factBelongsToFamily` says SOME `FACT_FAMILY_SKILLS`
 * member can generate it (`shared/factKey.ts` — the same predicate the sprint
 * selector uses). Consequences, all deliberate:
 *
 *   • It is derived, never hand-listed, so it cannot drift from the templates
 *     in `convex/lib/practice/templates.ts` that actually serve the items.
 *   • Every operand bound in those templates is ≤ 20, so the enumeration bound
 *     is the generator space's own bound, not a chosen cap.
 *   • UNSEEN FACTS COUNT AGAINST THE PERCENT. The denominator is the whole
 *     space, never "facts this scholar has touched" — so a scholar cannot
 *     reach 100% by drilling one fact, and a scholar who has never practiced
 *     reads 0%, not "no data".
 *   • The percent is an AUTOMATICITY reading (per-fact `fluent`/`automatic`,
 *     i.e. reliably correct AND fast for THIS scholar), never raw accuracy and
 *     never a cross-scholar clock — the substrate's self-relative doctrine
 *     survives the roll-up unchanged.
 *
 * ── PASS/NOT-YET IS TEACHER DISCRETION, NOT A NUMBER ─────────────────────────
 * The Calculator License Test itself is paper, proctored in the room, and
 * graded by the teacher's own judgment — there is no numeric score or
 * threshold anywhere in this app. `ready` below (100% of the canonical space
 * automatic) is a PRACTICE SIGNAL only, never a code gate: a teacher may grant
 * the license before it, and reaching it grants nothing automatically.
 * Readiness (this file's percent) and the license RECORD are kept separate:
 * readiness is derived and can decay, while a granted license is a durable
 * adult-issued credential (`calculatorLicenses` in convex/schema.ts).
 *
 * ── DECLINED: rolling up `practiceMastery` across FACT_FAMILY_SKILLS ─────────
 * The obvious cheaper denominator is "fluent-or-better families / 11". It was
 * considered and rejected, for four reasons that are each independently fatal:
 *
 *   1. It measures the wrong thing, and the schema says so. `practiceMastery`
 *      lives at the grain of a fact FAMILY; the `factFluency` header states the
 *      distinction outright — "a scholar can be instant on 7×2 and still
 *      counting on 7×8". The Fast Math reading IS an automaticity claim, so the
 *      family grain cannot express it.
 *   2. It fails the "unseen facts count" rule by an order of magnitude.
 *      A family reads fluent at `FLUENT_REPS = 3`, so ~33 correct answers
 *      touching ~33 of these 418 facts would read as 100% — precisely the
 *      "reach 100% by drilling a handful" failure this denominator exists to
 *      prevent.
 *   3. Family fluency admits INFERRED credit — placement and the acceleration
 *      valve write trust-upward rows the scholar never drilled (which is why
 *      `practiceMastery.becameFluentAt` exists to mark the demonstrated ones).
 *      The derived automaticity claim must not be satisfiable by inference.
 *   4. Those 11 family-MASTERY rows already have a canonical rendering in the
 *      whole-number domain. The dedicated Fast math view therefore never reads
 *      or restates that signal: it groups the finer per-FACT automaticity
 *      verdicts for cohort comparison. Family sets overlap, so each percentage
 *      is an independent slice and the UI explicitly warns against summing rows.
 *      The operation slices are the only disjoint partition of the total.
 *
 * ── DOCTRINE SCOPE ──────────────────────────────────────────────────────────
 * The teacher's heatmap remains the only home for raw tallies and latency.
 * `calculatorLicenses.myLicenseStatus` additionally returns one scholar's own
 * compact per-fact state map plus whole-ledger reading (calibration state,
 * count, denominator, percent, readiness) for the unified scholar card. It
 * carries no raw accuracy, millisecond, peer comparison, or teacher diagnostic
 * data, and it never grants, revokes, or grades a license.
 */

import {
  FACT_FAMILY_SKILLS,
  factBelongsToFamily,
  factKeyLabel,
  factKeyFromOperands,
  factOpGlyph,
  parseFactKey,
  type FactKey,
  type FactOp,
} from "../../../shared/factKey";
import type { AutomaticityState } from "../../../shared/masteryLexicon";
import { classifyFactState, type FactFluencyStats } from "./factFluency";

/** Enumeration bound for the canonical fact space. Every fact-family template
 *  in `templates.ts` draws operands at or below this, so the bound is the
 *  generator space's own ceiling rather than a product decision. */
export const FAST_MATH_MAX_OPERAND = 20;

const FACT_OPS: readonly FactOp[] = ["add", "sub", "mul"];

let cachedFactKeys: readonly FactKey[] | null = null;

/**
 * Every fact in the canonical Quick-facts space, in a stable order
 * (add → sub → mul, then by operands). Memoized: the enumeration is ~1.3k
 * cheap predicate calls and the answer is a module constant in practice.
 */
export function fastMathFactKeys(): readonly FactKey[] {
  if (cachedFactKeys) return cachedFactKeys;
  const keys: FactKey[] = [];
  const seen = new Set<string>();
  for (const op of FACT_OPS) {
    const glyph = factOpGlyph(op);
    for (let a = 0; a <= FAST_MATH_MAX_OPERAND; a++) {
      for (let b = 0; b <= FAST_MATH_MAX_OPERAND; b++) {
        const factKey = factKeyFromOperands(a, glyph, b);
        if (factKey === null || seen.has(factKey)) continue;
        let servable = false;
        for (const skillKey of FACT_FAMILY_SKILLS) {
          if (factBelongsToFamily(factKey, skillKey)) {
            servable = true;
            break;
          }
        }
        if (!servable) continue;
        seen.add(factKey);
        keys.push(factKey);
      }
    }
  }
  cachedFactKeys = keys;
  return cachedFactKeys;
}

/** How many facts a 100% reading requires — the size of the canonical space. */
export function fastMathDenominator(): number {
  return fastMathFactKeys().length;
}

/**
 * Whether a per-fact rung counts toward the Fast Math percent. The bar is the
 * AUTOMATICITY claim itself — `fluent` (reliably correct and fast for this
 * scholar) or `automatic` (near-perfect and instant). `practicing` is
 * deliberately excluded: it is the rung that means "correct, automaticity NOT
 * yet proven", which is exactly what this reading is asking about.
 *
 * Requiring `automatic` for every fact would be unreachable by construction —
 * the scholar's baseline is the MEDIAN of their own per-skill medians, so
 * roughly half their facts sit above it no matter how fast they get.
 */
export function isFastMathAutomatic(state: AutomaticityState): boolean {
  return state === "fluent" || state === "automatic";
}

export type FastMathProgress = {
  /** Facts at `fluent`/`automatic` — never counts an unseen or effortful fact. */
  automaticCount: number;
  /** The canonical space size (see the file header). */
  denominator: number;
  /** 0–100, integer. Capped at 99 unless the ledger is genuinely complete, so
   *  a rounded 99.6% can never read as complete. */
  percent: number;
  /** Practice-readiness signal: EVERY canonical fact is automatic. Exact,
   *  never rounded; a teacher may still record stronger proctored evidence. */
  ready: boolean;
  /** Disjoint operation slices. Their denominators sum to the canonical total. */
  byOperation: Record<FactOp, FastMathSliceProgress>;
  /** Independent fact-family slices. Families intentionally overlap. */
  byFamily: Record<string, FastMathSliceProgress>;
  /** Every canonical fact, including unseen facts, classified by the same
   *  self-relative verdict that drives this roll-up. */
  facts: FastMathFactReading[];
};

export type FastMathSliceProgress = {
  automaticCount: number;
  denominator: number;
  percent: number;
};

export type FastMathFactReading = {
  factKey: string;
  op: FactOp;
  /** Operands in canonical order (add/mul folded LO≤HI; sub as-written). */
  a: number;
  b: number;
  label: string;
  state: AutomaticityState;
  seenCount: number;
  correctCount: number;
};

function percentForSlice(
  automaticCount: number,
  denominator: number,
): number {
  if (denominator > 0 && automaticCount >= denominator) return 100;
  return Math.min(
    99,
    Math.floor((automaticCount / Math.max(1, denominator)) * 100),
  );
}

/**
 * Roll one scholar's fact ledger up against the canonical space.
 *
 * `statsByFactKey` is their `factFluency` rows keyed by `factKey`; a fact with
 * no row classifies as `unseen` and counts against the percent. `baseline` is
 * their self-relative latency baseline (`scholarLatencyBaseline`) — while it is
 * `undefined` the classifier caps every fact at `practicing`, so an
 * un-calibrated scholar honestly reads 0% rather than a speed claim we cannot
 * yet make.
 */
export function fastMathProgress(params: {
  statsByFactKey: ReadonlyMap<string, FactFluencyStats>;
  baseline: number | undefined;
}): FastMathProgress {
  const factKeys = fastMathFactKeys();
  const facts: FastMathFactReading[] = [];
  let automaticCount = 0;
  const operationCounts: Record<
    FactOp,
    { automaticCount: number; denominator: number }
  > = {
    add: { automaticCount: 0, denominator: 0 },
    sub: { automaticCount: 0, denominator: 0 },
    mul: { automaticCount: 0, denominator: 0 },
  };
  const familyCounts: Record<
    string,
    { automaticCount: number; denominator: number }
  > = {};
  for (const skillKey of FACT_FAMILY_SKILLS) {
    familyCounts[skillKey] = { automaticCount: 0, denominator: 0 };
  }

  for (const factKey of factKeys) {
    const stats = params.statsByFactKey.get(factKey);
    const parsed = parseFactKey(factKey);
    if (!parsed) continue;
    const state = classifyFactState(stats, params.baseline);
    const automatic = isFastMathAutomatic(state);
    const op = parsed.op;
    facts.push({
      factKey,
      op,
      a: parsed.a,
      b: parsed.b,
      label: factKeyLabel(factKey),
      state,
      seenCount: stats?.seenCount ?? 0,
      correctCount: stats?.correctCount ?? 0,
    });
    operationCounts[op].denominator += 1;
    if (automatic) operationCounts[op].automaticCount += 1;
    for (const skillKey of FACT_FAMILY_SKILLS) {
      if (!factBelongsToFamily(factKey, skillKey)) continue;
      familyCounts[skillKey].denominator += 1;
      if (automatic) familyCounts[skillKey].automaticCount += 1;
    }
    if (automatic) {
      automaticCount += 1;
    }
  }
  const denominator = factKeys.length;
  const ready = denominator > 0 && automaticCount >= denominator;
  const percent = percentForSlice(automaticCount, denominator);
  const byOperation = {
    add: {
      ...operationCounts.add,
      percent: percentForSlice(
        operationCounts.add.automaticCount,
        operationCounts.add.denominator,
      ),
    },
    sub: {
      ...operationCounts.sub,
      percent: percentForSlice(
        operationCounts.sub.automaticCount,
        operationCounts.sub.denominator,
      ),
    },
    mul: {
      ...operationCounts.mul,
      percent: percentForSlice(
        operationCounts.mul.automaticCount,
        operationCounts.mul.denominator,
      ),
    },
  };
  const byFamily: Record<string, FastMathSliceProgress> = {};
  for (const [skillKey, counts] of Object.entries(familyCounts)) {
    byFamily[skillKey] = {
      ...counts,
      percent: percentForSlice(counts.automaticCount, counts.denominator),
    };
  }
  return {
    automaticCount,
    denominator,
    percent,
    ready,
    byOperation,
    byFamily,
    facts,
  };
}
