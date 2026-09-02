import type { Doc } from "../../_generated/dataModel";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const STORY_TRANSITION_WINDOW_MS = DAY_MS;
export const STORY_OFFER_COOLDOWN_MS = 20 * HOUR_MS;
export const STORY_REOFFER_RESERVE_MS = 45 * DAY_MS;

export type StoryMomentOutcome = Doc<"momentEvents">["outcome"];

const TERMINAL_OUTCOMES: ReadonlySet<StoryMomentOutcome> = new Set([
  "tried",
  "saved",
  "dismissed",
]);

const OUTCOME_PRECEDENCE: Readonly<Record<StoryMomentOutcome, number>> = {
  offered: 0,
  opened: 1,
  probed: 2,
  tried: 3,
  saved: 3,
  dismissed: 3,
};

export function isEligibleStoryTransition(
  becameFluentAt: number | undefined,
  now: number,
): boolean {
  return (
    becameFluentAt !== undefined &&
    becameFluentAt >= now - STORY_TRANSITION_WINDOW_MS &&
    becameFluentAt <= now
  );
}

export function storyOfferCooldownCutoff(now: number): number {
  return now - STORY_OFFER_COOLDOWN_MS;
}

export function storyReofferReserveCutoff(now: number): number {
  return now - STORY_REOFFER_RESERVE_MS;
}

export function isTerminalStoryMomentOutcome(
  outcome: StoryMomentOutcome,
): boolean {
  return TERMINAL_OUTCOMES.has(outcome);
}

/**
 * Never re-offer an edge the scholar has already settled, and hold a recently
 * offered one in reserve. Terminal-means-forever is deliberate and, since
 * `recordMomentOffered` mints the story star on offer, no longer destructive:
 * a settled edge's story is already in the scholar's Sky and in the
 * "Unlocked by your new skills" home section, so declining the card only ends
 * the MOMENT. Re-offering it would just re-reveal a story they already hold.
 */
export function isStoryEdgeReserved(
  event: Pick<Doc<"momentEvents">, "offeredAt" | "outcome">,
  reserveCutoff: number,
): boolean {
  return (
    isTerminalStoryMomentOutcome(event.outcome) ||
    event.offeredAt >= reserveCutoff
  );
}

export function shouldAdvanceStoryMomentOutcome(
  current: StoryMomentOutcome,
  incoming: StoryMomentOutcome,
): boolean {
  if (isTerminalStoryMomentOutcome(current)) return false;
  if (isTerminalStoryMomentOutcome(incoming)) return true;

  return OUTCOME_PRECEDENCE[incoming] > OUTCOME_PRECEDENCE[current];
}
