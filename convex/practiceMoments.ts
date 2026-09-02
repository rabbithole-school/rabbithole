/**
 * Scholar-facing Moment Router — offers one verified skill→world story after a
 * durable demonstrated-fluency transition, then records the card lifecycle.
 *
 * The story star is KEPT AUTOMATICALLY. `recordMomentOffered` mints the
 * souvenir seed (`lib/seeds.ts`'s `plantStorySeed`) at the instant the card is
 * offered, so a story survives whatever the scholar does next. It used to
 * survive only an explicit "Add to my Sky ★" tap, which made the default path
 * DESTRUCTIVE: "Not now" — and the completion arbiter's silent settle when a
 * scholar just starts a bonus run — both record the terminal `dismissed`
 * outcome, and `isStoryEdgeReserved` never re-offers a terminal edge. A kid who
 * tapped past a handful of cards permanently lost those stories out of a
 * registry of only ~53. Now dismissal only ends the MOMENT; the story itself
 * lives on in the sky and in the scholar-home "Unlocked by your new skills"
 * section (`seeds.unlockedStoriesForSelf`).
 *
 * The `momentEvents` outcome ledger still tracks engagement honestly — minting
 * on offer deliberately does NOT advance the outcome to "saved", so the funnel
 * keeps meaning "what the scholar actually did with the card".
 *
 * Redaction boundary: the read returns only graph keys, the skill label, and
 * the edge's scholar-safe story copy. It never exposes story sources,
 * provenance, node rationale, mastery internals, error events, or teacher-only
 * learning-record fields.
 */

import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { plantStorySeed } from "./lib/seeds";
import {
  isEligibleStoryTransition,
  isStoryEdgeReserved,
  shouldAdvanceStoryMomentOutcome,
  storyOfferCooldownCutoff,
  storyReofferReserveCutoff,
} from "./lib/moments/storyMomentPolicy";
import { eligibleStoryApplication } from "./lib/practice/applicationEligibility";
import {
  STORY_KIND_LABELS,
  STANDING_STORY_INVITATION_CAP,
  standingStoryInvitationsForScholar,
  storyArtUrlForNode,
} from "./lib/scholarReads";

async function edgeIsReserved(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  fromKey: string,
  toKey: string,
  cutoff: number,
): Promise<boolean> {
  const events = ctx.db
    .query("momentEvents")
    .withIndex("by_scholar_edge", (q) =>
      q
        .eq("scholarId", scholarId)
        .eq("fromKey", fromKey)
        .eq("toKey", toKey),
    );

  for await (const event of events) {
    if (isStoryEdgeReserved(event, cutoff)) return true;
  }
  return false;
}

/**
 * The story seed already planted for this edge, if any. `plantStorySeed` is
 * idempotent per (scholar, fromKey, toKey) on `by_scholar_story_edge`, so the
 * souvenir star minted at offer time is the seed a quest CTA launches. The
 * idempotent early-exit of `recordMomentOffered` uses this to hand the already-
 * offered card its seedId (the star was minted on the FIRST offer, not this
 * retry). Returns null when no star exists yet (a legacy offer that predates
 * auto-keep) — the card then degrades to a disabled CTA rather than crashing.
 */
async function storySeedIdForEdge(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  fromKey: string,
  toKey: string,
): Promise<Id<"seeds"> | null> {
  const seed = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_story_edge", (q) =>
      q
        .eq("scholarId", scholarId)
        .eq("storyFromKey", fromKey)
        .eq("storyToKey", toKey),
    )
    .first();
  return seed?._id ?? null;
}

async function hasRecentOffer(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  cutoff: number,
): Promise<boolean> {
  return (
    (await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) =>
        q.eq("scholarId", scholarId).gte("offeredAt", cutoff),
      )
      .first()) !== null
  );
}

/**
 * Re-derive a story edge's mintable content by graph IDENTITY only
 * (fromKey/toKey) — never from client-supplied text, the same trust boundary
 * `edgeStories.storyOpenContext` enforces for `/story-open`. Used by
 * `recordMomentOffered` (the auto-keep mint) and `addStoryToSky` so a scholar
 * can't smuggle arbitrary text into their own sky through the mutation's args.
 * Returns `null` when the pair carries no story (nothing to mint).
 */
async function storyEdgeContext(
  ctx: MutationCtx,
  fromKey: string,
  toKey: string,
): Promise<{
  hook: string;
  fromLabel: string;
  toLabel: string;
  toDomain: string;
} | null> {
  const outgoing = ctx.db
    .query("knowledgeNodeEdges")
    .withIndex("by_from", (q) => q.eq("fromKey", fromKey));
  let story: NonNullable<Doc<"knowledgeNodeEdges">["story"]> | null = null;
  let edgeDomain = "sky";
  for await (const edge of outgoing) {
    if (edge.toKey === toKey && edge.story !== undefined) {
      story = edge.story;
      edgeDomain = edge.domain;
      break;
    }
  }
  if (!story) return null;

  const [fromNode, toNode] = await Promise.all([
    ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", fromKey))
      .first(),
    ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", toKey))
      .first(),
  ]);
  return {
    hook: story.hook,
    fromLabel: fromNode?.label ?? fromKey,
    toLabel: toNode?.label ?? toKey,
    toDomain: toNode?.domain ?? edgeDomain,
  };
}

/**
 * Return the newest eligible story opened by a demonstrated fluency transition.
 * The event ledger, not the client, owns both the global rarity governor and
 * the per-edge reserve/terminal rules.
 */
export const storyMomentForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }

    const now = Date.now();
    if (
      await hasRecentOffer(
        ctx,
        args.scholarId,
        storyOfferCooldownCutoff(now),
      )
    ) {
      return null;
    }

    const masteryRows = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const transitions = masteryRows
      .filter(
        (row) => isEligibleStoryTransition(row.becameFluentAt, now),
      )
      .sort((a, b) => b.becameFluentAt! - a.becameFluentAt!);

    for (const transition of transitions) {
      const outgoing = ctx.db
        .query("knowledgeNodeEdges")
        .withIndex("by_from", (q) =>
          q.eq("fromKey", transition.skillKey),
        );

      for await (const edge of outgoing) {
        if (edge.story === undefined) continue;
        if (
          await edgeIsReserved(
            ctx,
            args.scholarId,
            edge.fromKey,
            edge.toKey,
            storyReofferReserveCutoff(now),
          )
        ) {
          continue;
        }

        const skill = await ctx.db
          .query("knowledgeNodes")
          .withIndex("by_nodeKey", (q) =>
            q.eq("nodeKey", transition.skillKey),
          )
          .first();
        if (!skill) continue;

        const application = await eligibleStoryApplication(
          ctx,
          args.scholarId,
          edge.fromKey,
          edge.toKey,
        );
        const artUrl = await storyArtUrlForNode(ctx, edge.toKey);

        return {
          fromKey: edge.fromKey,
          toKey: edge.toKey,
          skillLabel: skill.label,
          hook: edge.story.hook,
          narrative: edge.story.narrative,
          ...(edge.story.teaser === undefined
            ? {}
            : { teaser: edge.story.teaser }),
          ...(edge.story.visualEmoji === undefined
            ? {}
            : { visualEmoji: edge.story.visualEmoji }),
          ...(artUrl === undefined ? {} : { artUrl }),
          ...(edge.story.probe === undefined
            ? {}
            : { probe: edge.story.probe }),
          kindLabel: STORY_KIND_LABELS[edge.story.kind],
          hasApplication: application !== null,
        };
      }
    }

    return null;
  },
});

/**
 * Record that the client actually rendered a story card, and KEEP the story:
 * the souvenir star is minted here, at offer time, not behind a tap. A
 * reconnect/retry with the same client event id returns the first row rather
 * than duplicating it (and `plantStorySeed` is itself idempotent per
 * (scholar, edge), so the star can't double-mint either).
 *
 * Returns BOTH ids — `{ eventId, seedId }`. The card is now a "quest unlocked"
 * card whose CTA starts a real session from the very seed this mint plants, so
 * the seedId is threaded back to the client (the idempotent early-exit re-reads
 * it, since the star was minted on the FIRST offer, not this retry). `seedId`
 * is null only for a legacy offer that predates auto-keep; the card then leaves
 * its Start-quest CTA disabled rather than launching nothing.
 */
export const recordMomentOffered = authedMutation({
  args: {
    scholarId: v.id("users"),
    fromKey: v.string(),
    toKey: v.string(),
    clientEventId: v.string(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }

    const clientEventId = args.clientEventId.trim();
    if (!clientEventId) throw new Error("clientEventId is required");

    const existing = await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar_client_event", (q) =>
        q
          .eq("scholarId", args.scholarId)
          .eq("clientEventId", clientEventId),
      )
      .unique();
    if (existing)
      return {
        eventId: existing._id,
        seedId: await storySeedIdForEdge(
          ctx,
          args.scholarId,
          existing.fromKey,
          existing.toKey,
        ),
      };

    const context = await storyEdgeContext(ctx, args.fromKey, args.toKey);
    if (!context) throw new Error("Story edge not found");

    const now = Date.now();
    if (
      await hasRecentOffer(
        ctx,
        args.scholarId,
        storyOfferCooldownCutoff(now),
      )
    ) {
      throw new Error("A story moment was already offered recently");
    }
    if (
      await edgeIsReserved(
        ctx,
        args.scholarId,
        args.fromKey,
        args.toKey,
        storyReofferReserveCutoff(now),
      )
    ) {
      throw new Error("This story moment is not eligible to be offered");
    }

    const standingInvitations = await standingStoryInvitationsForScholar(
      ctx,
      args.scholarId,
      Number.POSITIVE_INFINITY,
    );
    if (standingInvitations.length >= STANDING_STORY_INVITATION_CAP) {
      const oldest = standingInvitations.at(-1)!;
      await ctx.db.patch(oldest.eventId, {
        outcome: "dismissed",
        outcomeAt: now,
      });
    }

    // Auto-keep. Deliberately does NOT advance the outcome past "offered" —
    // the ledger measures what the scholar DID with the card, and the star
    // existing is not an act of engagement. The seedId is threaded back so the
    // card's "Start quest" CTA can launch a real session from this very seed.
    const { id: seedId } = await plantStorySeed(ctx, {
      scholarId: args.scholarId,
      fromKey: args.fromKey,
      toKey: args.toKey,
      fromLabel: context.fromLabel,
      toLabel: context.toLabel,
      toDomain: context.toDomain,
      hook: context.hook,
    });

    const eventId = await ctx.db.insert("momentEvents", {
      scholarId: args.scholarId,
      kind: "story",
      fromKey: args.fromKey,
      toKey: args.toKey,
      trigger: "fluency_transition",
      offeredAt: now,
      outcome: "offered",
      clientEventId,
    });
    return { eventId, seedId };
  },
});

/**
 * Advance the interaction state monotonically, sharing `momentPolicy`'s
 * precedence/terminal rules. Used by BOTH the public `recordMomentOutcome`
 * mutation and `addStoryToSky` (which advances the ledger to "saved" itself
 * once the star is minted, rather than requiring a second client round-trip).
 */
async function applyMomentOutcome(
  ctx: MutationCtx,
  event: Doc<"momentEvents">,
  outcome: "opened" | "probed" | "tried" | "saved" | "dismissed",
): Promise<void> {
  if (!shouldAdvanceStoryMomentOutcome(event.outcome, outcome)) return;
  await ctx.db.patch(event._id, { outcome, outcomeAt: Date.now() });
}

/**
 * Advance the interaction state monotonically. `tried`, `saved`, and
 * `dismissed` are terminal; among non-terminal states, probed > opened >
 * offered. `tried` means the card's linked Go-deeper round actually started.
 * Like every outcome here, a teacher viewing a scholar CAN advance it
 * (requireTeacherOrSelf) — pre-existing posture, unchanged by `tried`; the
 * offer-minting side already guards teacher previews (see practiceSession's
 * isSelf handling).
 */
export const recordMomentOutcome = authedMutation({
  args: {
    eventId: v.id("momentEvents"),
    outcome: v.union(
      v.literal("opened"),
      v.literal("probed"),
      v.literal("tried"),
      v.literal("saved"),
      v.literal("dismissed"),
    ),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get("momentEvents", args.eventId);
    if (!event) throw new Error("Moment event not found");

    const isTeacher = requireTeacherOrSelf(ctx.user, event.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, event.scholarId);
    }

    await applyMomentOutcome(ctx, event, args.outcome);
    return event._id;
  },
});

/**
 * Mint a story star on demand. Since `recordMomentOffered` now keeps every
 * offered story automatically, the current clients no longer call this — it
 * stays as a public entry point so ALREADY-INSTALLED native builds (which still
 * render an "Add to my Sky ★" button) keep working against the new server, and
 * because it is the one idempotent, explicitly-invocable mint.
 *
 * Mints from the edge's OWN content, re-derived server-side by graph identity
 * (never trusting client-supplied hook/label text — the same boundary
 * `/story-open` enforces), then advances the matching `momentEvents` row to
 * "saved" — best-effort: a missing/foreign moment event (e.g. a teacher
 * rehearsing the surface with no offered card) never blocks the actual souvenir
 * mint, since the seed itself is the durable artifact the scholar is after.
 */
export const addStoryToSky = authedMutation({
  args: {
    scholarId: v.id("users"),
    fromKey: v.string(),
    toKey: v.string(),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) {
      await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    }

    const context = await storyEdgeContext(ctx, args.fromKey, args.toKey);
    if (!context) throw new Error("Story edge not found");

    const { id, existed } = await plantStorySeed(ctx, {
      scholarId: args.scholarId,
      fromKey: args.fromKey,
      toKey: args.toKey,
      fromLabel: context.fromLabel,
      toLabel: context.toLabel,
      toDomain: context.toDomain,
      hook: context.hook,
    });

    const event = await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar_edge", (q) =>
        q
          .eq("scholarId", args.scholarId)
          .eq("fromKey", args.fromKey)
          .eq("toKey", args.toKey),
      )
      .order("desc")
      .first();
    if (event) await applyMomentOutcome(ctx, event, "saved");

    return { seedId: id, existed };
  },
});
