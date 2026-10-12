/**
 * Close the one hole in the moment ledger: a `kind: "seed"` row's outcome.
 *
 * Story moments have a writer for every terminal state — `StoryInvitations`
 * records `opened` / `dismissed` on the standing card, and the practice loop
 * records `tried` when the scholar starts the story's own application. A
 * cross-domain SEED moment reaches fewer of them, and several launch paths
 * reach none:
 *
 *  - the done-screen card is gift-only (no CTA, by design), and its `markTried`
 *    settle is explicitly gated on `kind === "story"`;
 *  - the Sky star / Suggested-quest path calls `sessions.createFromSeed`
 *    straight, touching no ledger row.
 *
 * As of TRA-414 `standingStoryInvitations*` DOES surface a qualifying
 * cross-domain seed, and its "Follow the thread" / "Let this one go" record
 * `opened` / `dismissed` — but a scholar who launches the seed from the Sky or
 * a Suggested quest never passes through that card, so the server-side write
 * below stays the backstop. It is idempotent with the invitation's client
 * write (the shared precedence rule leaves an already-`opened` row alone).
 *
 * Before that fix `momentEvents.outcome` was unwritable for seeds — every row read `offered`
 * forever, including the rows whose scholar DID follow the preview into a real
 * session minutes later (prod, 2026-09-18). That made the seed funnel TRA-254
 * was commissioned to judge unmeasurable: "offered vs dismissed per topic" can
 * only ever answer "all offered".
 *
 * The fix records the act where it actually happens — server-side at the launch
 * every surface funnels through — rather than adding a CTA the card
 * deliberately doesn't have. Walking away still records nothing, which keeps
 * the ledger's meaning intact: it measures what the scholar DID, and `offered`
 * now means "shown, not followed" instead of "shown".
 */

import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { shouldAdvanceStoryMomentOutcome } from "./storyMomentPolicy";

/**
 * Record that the scholar followed a card into a session from `seed`: stamp
 * `followedAt` on the newest matching moment (once) and advance its outcome to
 * `opened` when the precedence rule allows. Best-effort and idempotent: no
 * matching row (a Sky star the card never offered, a teacher rehearsing) is the
 * ordinary case and never blocks the launch.
 *
 * Matching: a cross-domain seed's moment carries its `seedId`; a story moment
 * carries the edge (`fromKey`/`toKey`) and its star is an `origin: "story"`
 * seed stamped with the same `storyFromKey`/`storyToKey`.
 *
 * `followedAt` exists because the question card writes `probed` when the
 * scholar answers, and `probed` outranks `opened` — so after an answer the
 * outcome alone can't say whether they followed. The stamp is the funnel's
 * last step, independent of outcome order.
 *
 * Reads the scholar's whole ledger, not the offer side's 45-day reserve
 * window: a seed stays active indefinitely, so a card shown in September and
 * followed in November is still "followed". A scholar earns at most one moment
 * per 20h, so the row count stays small.
 */
export async function markSeedMomentFollowed(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  seed: Pick<Doc<"seeds">, "_id" | "suggestionType" | "origin" | "storyFromKey" | "storyToKey">,
): Promise<void> {
  const isStory =
    seed.origin === "story" && seed.storyFromKey !== undefined && seed.storyToKey !== undefined;
  if (seed.suggestionType !== "cross_domain" && !isStory) return;

  const events = await ctx.db
    .query("momentEvents")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();

  const event = events
    .filter((candidate) =>
      isStory
        ? candidate.kind === "story" &&
          candidate.fromKey === seed.storyFromKey &&
          candidate.toKey === seed.storyToKey
        : candidate.kind === "seed" && candidate.seedId === seed._id,
    )
    .sort((a, b) => b.offeredAt - a.offeredAt || b._creationTime - a._creationTime)
    .at(0);
  if (!event) return;

  const now = Date.now();
  const patch: Partial<Doc<"momentEvents">> = {};
  if (event.followedAt === undefined) patch.followedAt = now;
  if (shouldAdvanceStoryMomentOutcome(event.outcome, "opened")) {
    patch.outcome = "opened";
    patch.outcomeAt = now;
  }
  if (Object.keys(patch).length > 0) await ctx.db.patch(event._id, patch);
}
