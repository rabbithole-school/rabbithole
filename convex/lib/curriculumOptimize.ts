/**
 * Pure hill-climb control flow for the Phase-3 loop — the product-side twin of
 * evals/curriculum-sim/lib/optimizer.ts. Each generation proposes K candidates
 * from the current champion, evaluates each across the cast, and promotes the
 * best candidate that clears the protected-dim gate AND beats the champion's
 * fitness past the noise floor (curriculumScore.isBetter). Stops on
 * generations / plateau / budget.
 *
 * DEPENDENCY-INJECTED (evaluate + propose + decide) so the control flow is
 * unit-testable with deterministic fakes — no model calls, no Convex. The node
 * action (curriculumSim.ts) wires `evaluate` to the cast simulation+judge,
 * `propose` to the Improver (both persist to the DB), and — for adoptable #3 —
 * `decide` to the PAIRWISE promote gate (candidate vs champion transcripts
 * judged head-to-head). When `decide` is omitted, promotion falls back to the
 * absolute `isBetter` on the aggregates (the pre-pairwise behavior).
 *
 * "Champion advances automatically" here is EXPLORATION within one experiment.
 * Promotion to the LIVE activity is a separate teacher-gated step
 * (curriculumExperiments.promoteVariant) — except on dev units flagged
 * experimental (review/self-improving-curricula-plan.md, autonomy decision),
 * which is enforced at that mutation, not here.
 */
import {
  DEFAULT_BETTER,
  isBetter,
  type Aggregate,
  type BetterOptions,
  type PromotionDecision,
} from "./curriculumScore";

/**
 * A minimal variant handle the loop carries: the Convex id, the mutable prompt,
 * and the lineage depth (a candidate's generation = its parent's + 1, so all
 * candidates proposed from the same champion share a generation).
 */
export interface OptVariant {
  id: string;
  systemPrompt: string | null;
  generation: number;
}

export interface OptimizerDeps<V extends OptVariant> {
  /** Run a variant across the cast, persist, return its aggregate. 1 evaluation. */
  evaluate: (variant: V) => Promise<Aggregate>;
  /** Propose + persist a child variant of `parent`. Returns null when the
   *  Improver produced no usable edit — that candidate slot is then skipped
   *  (not a failure). */
  propose: (parent: V, parentAgg: Aggregate) => Promise<V | null>;
  /**
   * How to decide whether a candidate beats the current champion (adoptable #3).
   * Injected so promotion can be driven by PAIRWISE preference (candidate vs
   * champion transcripts, judged head-to-head) instead of absolute fitness,
   * while still keeping the protected-dim veto. When omitted, promotion falls
   * back to the absolute `isBetter` on the aggregates (the pre-pairwise
   * behavior + what the deterministic optimizer tests rely on). Either way the
   * returned `PromotionDecision.better` gates advancement and `.reason` is
   * logged; `.gate` carries the retained veto.
   */
  decide?: (args: {
    candidate: V;
    candidateAgg: Aggregate;
    champion: V;
    championAgg: Aggregate;
  }) => Promise<PromotionDecision>;
  /** Should we stop early (e.g. the teacher cancelled)? Checked each gen. */
  shouldStop?: () => Promise<boolean>;
  onProgress?: (msg: string, generation: number) => Promise<void> | void;
  /** Injectable clock (ms) for the wall-clock budget; defaults to Date.now.
   *  Injected in tests so the time guard is deterministic. */
  now?: () => number;
}

export interface OptimizerOptions {
  generations: number; // max generations
  variantsPerGen: number; // K candidates proposed per generation
  patience?: number; // stop after this many non-improving generations (default 1)
  maxEvaluations?: number; // budget: cap on cast-runs (default unlimited)
  // Wall-clock ceiling: stop gracefully (keeping the best so far) before a
  // single "use node" action exceeds its runtime limit. Checked before each
  // generation AND before each candidate, so worst-case overrun is one
  // in-flight candidate eval. Default unlimited (the harness has no limit).
  maxDurationMs?: number;
  better?: BetterOptions;
}

export interface CandidateRecord<V extends OptVariant> {
  variant: V;
  agg: Aggregate;
  decision: PromotionDecision; // vs the champion at proposal time
}

export interface GenerationRecord<V extends OptVariant> {
  generation: number;
  candidates: CandidateRecord<V>[];
  promotedVariantId: string | null;
}

export type OptStopReason =
  | "generations"
  | "plateau"
  | "budget"
  | "timeBudget"
  | "cancelled";

export interface OptimizerResult<V extends OptVariant> {
  baseline: { variant: V; agg: Aggregate };
  best: { variant: V; agg: Aggregate };
  generations: GenerationRecord<V>[];
  evaluations: number;
  stoppedReason: OptStopReason;
}

export async function optimize<V extends OptVariant>(
  baselineVariant: V,
  baselineAgg: Aggregate,
  deps: OptimizerDeps<V>,
  opts: OptimizerOptions,
): Promise<OptimizerResult<V>> {
  const better = opts.better ?? DEFAULT_BETTER;
  const patience = opts.patience ?? 1;
  const budget = opts.maxEvaluations ?? Infinity;
  const clock = deps.now ?? Date.now;
  const maxDurationMs = opts.maxDurationMs ?? Infinity;
  const startAt = clock();
  const log = async (msg: string, g: number) => {
    await deps.onProgress?.(msg, g);
  };

  // The baseline has already been evaluated by the caller (it's gen 0). We count
  // that as the first evaluation so the budget is honest end-to-end.
  let evaluations = 1;
  let champion = baselineVariant;
  let championAgg = baselineAgg;
  const baseline = { variant: baselineVariant, agg: baselineAgg };

  const generations: GenerationRecord<V>[] = [];
  let noImprove = 0;
  let stoppedReason: OptStopReason = "generations";

  for (let g = 1; g <= opts.generations; g++) {
    if (deps.shouldStop && (await deps.shouldStop())) {
      stoppedReason = "cancelled";
      break;
    }
    if (clock() - startAt > maxDurationMs) {
      stoppedReason = "timeBudget";
      break;
    }

    const candidates: CandidateRecord<V>[] = [];
    let bestThisGen: CandidateRecord<V> | null = null;
    let budgetHit = false;
    let timeHit = false;

    for (let k = 0; k < opts.variantsPerGen; k++) {
      if (evaluations >= budget) {
        budgetHit = true;
        break;
      }
      if (clock() - startAt > maxDurationMs) {
        timeHit = true;
        break;
      }
      const cand = await deps.propose(champion, championAgg);
      if (!cand) {
        await log(
          `gen ${g} candidate: Improver returned no usable edit — skipped`,
          g,
        );
        continue;
      }
      const agg = await deps.evaluate(cand);
      evaluations++;
      const decision = deps.decide
        ? await deps.decide({
            candidate: cand,
            candidateAgg: agg,
            champion,
            championAgg,
          })
        : isBetter(agg, championAgg, better);
      candidates.push({ variant: cand, agg, decision });
      if (
        decision.better &&
        (!bestThisGen || agg.fitness > bestThisGen.agg.fitness)
      ) {
        bestThisGen = { variant: cand, agg, decision };
      }
      await log(
        `gen ${g} candidate: fitness ${agg.fitness.toFixed(2)} — ${decision.better ? "kept" : "rejected"} (${decision.reason})`,
        g,
      );
    }

    let promotedVariantId: string | null = null;
    if (bestThisGen) {
      champion = bestThisGen.variant;
      championAgg = bestThisGen.agg;
      promotedVariantId = champion.id;
      noImprove = 0;
      await log(
        `gen ${g}: new champion (fitness ${championAgg.fitness.toFixed(2)})`,
        g,
      );
    } else {
      noImprove++;
      await log(`gen ${g}: no improvement (${noImprove}/${patience})`, g);
    }
    generations.push({ generation: g, candidates, promotedVariantId });

    if (timeHit) {
      stoppedReason = "timeBudget";
      break;
    }
    if (budgetHit) {
      stoppedReason = "budget";
      break;
    }
    if (noImprove >= patience) {
      stoppedReason = "plateau";
      break;
    }
  }

  return {
    baseline,
    best: { variant: champion, agg: championAgg },
    generations,
    evaluations,
    stoppedReason,
  };
}
