/**
 * The `?quickFacts=1` entry's decision, kept pure so the honest-refusal rule is
 * testable without a render harness.
 *
 * The rule this encodes: the Fast math action on the scholar Math tab's
 * Calculator license card promises a direct Fast math round from
 * `practiceSkills.startQuickFactsPractice`. If that contract can't produce one,
 * the page says so with its ordinary "couldn't start" screen — it never quietly
 * serves an ordinary practice session in its place, which is exactly the
 * dishonesty that kept this deep link from existing before the backend did.
 */

import {
  FAST_MATH_NAME,
  FAST_MATH_NAME_INLINE,
} from "@/shared/fastMathName";

export const QUICK_FACTS_REHEARSE_MESSAGE = `${FAST_MATH_NAME} practice runs against a scholar's own fact record, so there's nothing to rehearse here.`;

export const QUICK_FACTS_UNAVAILABLE_MESSAGE = `There are no ${FAST_MATH_NAME_INLINE} facts to practice right now. Try again after your next practice round.`;

/**
 * The availability probe's seed. Whether a round exists is a property of the
 * scholar's fact ledger, not of the seed — which only shuffles equal-priority
 * facts and their operand rendering — so the probe pins one, keeping the page's
 * render pure and its verdict stable. The served run rolls its own seed.
 */
export const QUICK_FACTS_PROBE_SEED = 1;

export type QuickFactsRun = { available: boolean } | undefined | null;

export type QuickFactsEntryVerdict =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "run" };

export function quickFactsEntryVerdict({
  rehearsing,
  run,
}: {
  /** Staff practicing as themselves — there is no scholar fact record to serve. */
  rehearsing: boolean;
  /** `undefined` while the direct query is in flight. */
  run: QuickFactsRun;
}): QuickFactsEntryVerdict {
  if (rehearsing) {
    return { kind: "error", message: QUICK_FACTS_REHEARSE_MESSAGE };
  }
  if (run === undefined) return { kind: "loading" };
  if (!run || !run.available) {
    return { kind: "error", message: QUICK_FACTS_UNAVAILABLE_MESSAGE };
  }
  return { kind: "run" };
}
