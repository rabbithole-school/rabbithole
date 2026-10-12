import type { Doc } from "../../_generated/dataModel";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const STORY_TRANSITION_WINDOW_MS = DAY_MS;
export const STORY_OFFER_COOLDOWN_MS = 20 * HOUR_MS;
export const STORY_REOFFER_RESERVE_MS = 45 * DAY_MS;
// Cross-domain seed cards have NO age window. A topic mints once per scholar
// ever, so any window strands every seed that ages out before a card slot comes
// round — the measured prod funnel (79 fired : 6 carded : 1 followed,
// 2026-09-18) was mostly that, and the 7-day window that replaced the old 24h
// one still stranded the September backlog. An ACTIVE seed that was never
// settled or reserved stays eligible; newest-first selection keeps fresh seeds
// ahead, and the 20h cooldown keeps it to one card a day at most.

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

/**
 * Whether a cross-domain seed may take the done-screen card now. `events` must
 * hold every ledger event inside the 45-day reserve window (the cooldown and
 * reserve reads) AND every SEED event at any age: with no age window, a seed
 * settled long ago is only kept off the card by seeing its terminal event.
 */
export function isEligibleCrossDomainSeedMoment(
  seed: Pick<Doc<"seeds">, "_id" | "status" | "suggestionType">,
  events: ReadonlyArray<
    Pick<
      Doc<"momentEvents">,
      "kind" | "seedId" | "offeredAt" | "outcome"
    > & { trigger?: Doc<"momentEvents">["trigger"] }
  >,
  now: number,
): boolean {
  if (
    seed.status !== "active" ||
    seed.suggestionType !== "cross_domain"
  ) {
    return false;
  }

  if (
    events.some(
      // Quests-list answers never spend the done-screen rarity budget.
      (event) =>
        event.trigger !== "quests_list" &&
        event.offeredAt >= storyOfferCooldownCutoff(now),
    )
  ) {
    return false;
  }

  const reserveCutoff = storyReofferReserveCutoff(now);
  return !events.some(
    (event) =>
      event.kind === "seed" &&
      event.seedId === seed._id &&
      isStoryEdgeReserved(event, reserveCutoff),
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
