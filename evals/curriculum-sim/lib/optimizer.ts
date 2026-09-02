/**
 * Phase 3 — the loop. Hill-climb over activity variants: each generation
 * proposes K candidates from the current champion, evaluates each across the
 * cast, and promotes the best candidate that clears the protected-dim gate AND
 * beats the champion's fitness past the noise floor (score.isBetter). Stops on
 * generations / plateau / budget.
 *
 * The loop is DEPENDENCY-INJECTED (evaluate + propose) so the control flow is
 * unit-testable with deterministic fakes (no model calls) — see
 * __tests__/optimizer.test.ts. The real runner (improve.ts) wires `evaluate` to
 * the orchestrator and `propose` to the Improver.
 *
 * Note on "auto-promote": in the harness the champion advances automatically —
 * that's exploration. Promotion to a LIVE activity is a separate human step
 * (teacher approves the diff), except on dev units flagged experimental
 * (review/self-improving-curricula-plan.md, autonomy decision).
 */
import { DEFAULT_BETTER, isBetter, type Aggregate, type BetterOptions, type BetterResult } from "./score";
import type { ActivityVariant } from "./variant";

export interface OptimizerDeps {
  /** Run a variant across the cast and return its aggregate. Counts as 1 evaluation. */
  evaluate: (variant: ActivityVariant) => Promise<Aggregate>;
  /** Propose a child variant of `parent`. null = no usable edit → skip slot. */
  propose: (
    parent: ActivityVariant,
    parentAgg: Aggregate,
  ) => Promise<ActivityVariant | null>;
}

export interface OptimizerOptions {
  generations: number; // max generations
  variantsPerGen: number; // K candidates proposed per generation
  patience?: number; // stop after this many non-improving generations (default 1)
  maxEvaluations?: number; // budget: cap on cast-runs (default unlimited)
  maxDurationMs?: number; // wall-clock ceiling; stop gracefully (default unlimited)
  now?: () => number; // injectable clock for tests; defaults to Date.now
  better?: BetterOptions;
  onProgress?: (msg: string) => void;
}

export interface CandidateRecord {
  variant: ActivityVariant;
  agg: Aggregate;
  decision: BetterResult; // vs the champion at proposal time
}

export interface GenerationRecord {
  generation: number;
  candidates: CandidateRecord[];
  promotedVariantId: string | null;
}

export type StopReason =
  | "generations"
  | "plateau"
  | "budget"
  | "timeBudget";

export interface OptimizerResult {
  baseline: { variant: ActivityVariant; agg: Aggregate };
  best: { variant: ActivityVariant; agg: Aggregate };
  generations: GenerationRecord[];
  evaluations: number;
  stoppedReason: StopReason;
}

export async function optimize(
  baselineVariant: ActivityVariant,
  deps: OptimizerDeps,
  opts: OptimizerOptions,
): Promise<OptimizerResult> {
  const better = opts.better ?? DEFAULT_BETTER;
  const patience = opts.patience ?? 1;
  const log = opts.onProgress ?? (() => {});
  const budget = opts.maxEvaluations ?? Infinity;
  const clock = opts.now ?? Date.now;
  const maxDurationMs = opts.maxDurationMs ?? Infinity;
  const startAt = clock();

  let evaluations = 0;
  let champion = baselineVariant;
  let championAgg = await deps.evaluate(champion);
  evaluations++;
  const baseline = { variant: baselineVariant, agg: championAgg };
  log(`gen 0 (baseline): fitness ${championAgg.fitness.toFixed(2)}`);

  const generations: GenerationRecord[] = [];
  let noImprove = 0;
  let stoppedReason: StopReason = "generations";

  for (let g = 1; g <= opts.generations; g++) {
    if (clock() - startAt > maxDurationMs) {
      stoppedReason = "timeBudget";
      break;
    }

    const candidates: CandidateRecord[] = [];
    let bestThisGen: CandidateRecord | null = null;
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
        log(`gen ${g}: Improver returned no usable edit — skipped`);
        continue;
      }
      const agg = await deps.evaluate(cand);
      evaluations++;
      const decision = isBetter(agg, championAgg, better);
      candidates.push({ variant: cand, agg, decision });
      if (decision.better && (!bestThisGen || agg.fitness > bestThisGen.agg.fitness)) {
        bestThisGen = { variant: cand, agg, decision };
      }
      log(`gen ${g} cand ${cand.id}: fitness ${agg.fitness.toFixed(2)} — ${decision.better ? "✅" : "✗"} ${decision.reason}`);
    }

    let promotedVariantId: string | null = null;
    if (bestThisGen) {
      champion = bestThisGen.variant;
      championAgg = bestThisGen.agg;
      promotedVariantId = champion.id;
      noImprove = 0;
      log(`gen ${g}: promoted ${champion.id} (fitness ${championAgg.fitness.toFixed(2)})`);
    } else {
      noImprove++;
      log(`gen ${g}: no improvement (${noImprove}/${patience})`);
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
