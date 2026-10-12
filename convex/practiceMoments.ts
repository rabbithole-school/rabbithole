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
import { seedCardCopy } from "./lib/practice/crossDomainSeeds";
import { storyCardQuestion } from "./lib/practice/storyCardQuestions";
import { seedCardQuestion } from "./lib/practice/seedCardQuestions";
import {
  isCorrectChoice,
  isValidCardQuestion,
} from "../shared/questionCard";
import {
  isEligibleCrossDomainSeedMoment,
  isEligibleStoryTransition,
  isStoryEdgeReserved,
  isTerminalStoryMomentOutcome,
  shouldAdvanceStoryMomentOutcome,
  storyOfferCooldownCutoff,
  storyReofferReserveCutoff,
} from "./lib/moments/storyMomentPolicy";
import { eligibleStoryApplication } from "./lib/practice/applicationEligibility";
import {
  STORY_KIND_LABELS,
  storyArtUrlForNode,
} from "./lib/scholarReads";

// Upper bound on active seeds scanned for a cross-domain seed moment. Seed
// cards have no age window, so the cap is what stops the creation-desc read
// from scaling with lifetime seed volume (newest-first, so fresh seeds win).
const RECENT_ACTIVE_SEED_SCAN_CAP = 100;

/**
 * Every SEED ledger event for a scholar, at any age. Seed events carry no
 * edge, so they are exactly the `by_scholar_edge` rows with both keys unset —
 * bounded by how many seed cards the scholar was ever shown (≤1 per 20h).
 * Needed because seed cards have no age window: a seed settled before the
 * 45-day reserve read must still be seen as settled.
 */
async function seedLedgerForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<Doc<"momentEvents">[]> {
  return await ctx.db
    .query("momentEvents")
    .withIndex("by_scholar_edge", (q) =>
      q.eq("scholarId", scholarId).eq("fromKey", undefined).eq("toKey", undefined),
    )
    .collect();
}

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
  // A question answered from the Quests list (trigger "quests_list") is the
  // scholar working their backlog, not a done-screen moment — it never spends
  // the done-screen's one-a-day rarity budget.
  const recent = ctx.db
    .query("momentEvents")
    .withIndex("by_scholar", (q) =>
      q.eq("scholarId", scholarId).gte("offeredAt", cutoff),
    );
  for await (const event of recent) {
    if (event.trigger !== "quests_list") return true;
  }
  return false;
}

/**
 * The Quests-list / Scholar's Prep branch of `recordMomentOffered`: the
 * scholar is answering an open question (`questionQueue.forSelf`) that has no
 * ledger row yet. Same ledger, same ownership + question checks, but none of
 * the done-screen's rarity rules — the scholar picked this item off their own
 * backlog. Idempotent per item: a non-terminal row for the same seed/edge is
 * returned rather than duplicated; a settled (terminal) item is refused.
 */
async function offerFromQuestsList(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    kind?: "story" | "seed";
    fromKey?: string;
    toKey?: string;
    seedId?: Id<"seeds">;
  },
  clientEventId: string,
  now: number,
): Promise<{ eventId: Id<"momentEvents">; seedId: Id<"seeds"> | null }> {
  const newest = (events: Doc<"momentEvents">[]) =>
    events.sort(
      (a, b) => b.offeredAt - a.offeredAt || b._creationTime - a._creationTime,
    )[0];

  if ((args.kind ?? "story") === "seed") {
    if (
      args.seedId === undefined ||
      args.fromKey !== undefined ||
      args.toKey !== undefined
    ) {
      throw new Error("Seed moments require only seedId");
    }
    const seed = await ctx.db.get(args.seedId);
    if (
      !seed ||
      seed.scholarId !== args.scholarId ||
      seed.status !== "active" ||
      seed.suggestionType !== "cross_domain" ||
      !isValidCardQuestion(seedCardQuestion(seed.topic))
    ) {
      throw new Error("This seed has no open question");
    }
    const latest = newest(
      (await seedLedgerForScholar(ctx, args.scholarId)).filter(
        (event) => event.seedId === seed._id,
      ),
    );
    if (latest) {
      if (isTerminalStoryMomentOutcome(latest.outcome)) {
        throw new Error("This question is already settled");
      }
      return { eventId: latest._id, seedId: seed._id };
    }
    const eventId = await ctx.db.insert("momentEvents", {
      scholarId: args.scholarId,
      kind: "seed",
      seedId: seed._id,
      trigger: "quests_list",
      offeredAt: now,
      outcome: "offered",
      clientEventId,
    });
    return { eventId, seedId: seed._id };
  }

  const { fromKey, toKey } = args;
  if (args.seedId !== undefined || fromKey === undefined || toKey === undefined) {
    throw new Error("Story moments require fromKey and toKey");
  }
  // The Quests list only ever lists a story the scholar ALREADY holds as an
  // active story seed (`questionQueueForScholar`), so this path never plants
  // one: an edge the scholar never unlocked has no row to mint.
  const storySeed = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_story_edge", (q) =>
      q.eq("scholarId", args.scholarId).eq("storyFromKey", fromKey).eq("storyToKey", toKey),
    )
    .first();
  if (
    !storySeed ||
    storySeed.origin !== "story" ||
    storySeed.status !== "active" ||
    !isValidCardQuestion(storyCardQuestion(fromKey, toKey))
  ) {
    throw new Error("This story has no open question");
  }
  const latest = newest(
    await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar_edge", (q) =>
        q.eq("scholarId", args.scholarId).eq("fromKey", fromKey).eq("toKey", toKey),
      )
      .collect(),
  );
  if (latest && isTerminalStoryMomentOutcome(latest.outcome)) {
    throw new Error("This question is already settled");
  }
  const seedId = storySeed._id;
  if (latest) return { eventId: latest._id, seedId };
  const eventId = await ctx.db.insert("momentEvents", {
    scholarId: args.scholarId,
    kind: "story",
    fromKey,
    toKey,
    trigger: "quests_list",
    offeredAt: now,
    outcome: "offered",
    clientEventId,
  });
  return { eventId, seedId };
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
        // The card is a question: a story edge with no authored question is
        // never offered (keep looking), so the card never renders questionless.
        const question = storyCardQuestion(edge.fromKey, edge.toKey);
        if (!isValidCardQuestion(question)) continue;
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
          kind: "story" as const,
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
          question,
        };
      }
    }

    const events = await ctx.db
      .query("momentEvents")
      .withIndex("by_scholar", (q) =>
        q
          .eq("scholarId", args.scholarId)
          .gte("offeredAt", storyReofferReserveCutoff(now)),
      )
      .collect();
    // Cross-domain seeds stay card-eligible at any age until settled or
    // reserved (isEligibleCrossDomainSeedMoment). Scan active seeds
    // newest-first so the newest eligible preview wins, while the cap
    // prevents lifetime-volume reads.
    const seedEvents = [
      ...events,
      ...(await seedLedgerForScholar(ctx, args.scholarId)),
    ];
    const seed = (
      await ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) =>
          q.eq("scholarId", args.scholarId).eq("status", "active"),
        )
        .order("desc")
        .take(RECENT_ACTIVE_SEED_SCAN_CAP)
    ).find(
      (candidate) =>
        isValidCardQuestion(seedCardQuestion(candidate.topic)) &&
        isEligibleCrossDomainSeedMoment(candidate, seedEvents, now),
    );
    if (seed) {
      // Card copy resolves from the registry by topic at READ time, so seeds
      // minted before a copy rewrite still show the current card.
      const card = seedCardCopy(seed);
      return {
        kind: "seed" as const,
        seedId: seed._id,
        hook: card.title,
        teaser: card.teaser,
        ...(card.visualEmoji === undefined
          ? {}
          : { visualEmoji: card.visualEmoji }),
        hasApplication: false,
        question: seedCardQuestion(seed.topic)!,
      };
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
    kind: v.optional(v.union(v.literal("story"), v.literal("seed"))),
    fromKey: v.optional(v.string()),
    toKey: v.optional(v.string()),
    seedId: v.optional(v.id("seeds")),
    clientEventId: v.string(),
    // "quests": the scholar is answering an open question from the Quests
    // list / Scholar's Prep (see offerFromQuestsList). Omitted = done screen.
    surface: v.optional(v.literal("quests")),
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
        seedId:
          existing.kind === "seed"
            ? (existing.seedId ?? null)
            : existing.fromKey && existing.toKey
              ? await storySeedIdForEdge(
                  ctx,
                  args.scholarId,
                  existing.fromKey,
                  existing.toKey,
                )
              : null,
      };

    const now = Date.now();

    if (args.surface === "quests") {
      return await offerFromQuestsList(ctx, args, clientEventId, now);
    }

    // No eviction: the old two-card "New quests" section capped standing
    // invitations by marking the oldest `dismissed` on every new offer. That
    // section is retired — every open moment now lives in the Quests list
    // (questionQueue), which has no cap — so evicting would silently close a
    // question the scholar never let go of.

    const kind = args.kind ?? "story";
    if (kind === "seed") {
      if (
        args.seedId === undefined ||
        args.fromKey !== undefined ||
        args.toKey !== undefined
      ) {
        throw new Error("Seed moments require only seedId");
      }
      const seed = await ctx.db.get(args.seedId);
      if (!seed || seed.scholarId !== args.scholarId) {
        throw new Error("Seed not found");
      }
      const events = await ctx.db
        .query("momentEvents")
        .withIndex("by_scholar", (q) =>
          q
            .eq("scholarId", args.scholarId)
            .gte("offeredAt", storyReofferReserveCutoff(now)),
        )
        .collect();
      events.push(...(await seedLedgerForScholar(ctx, args.scholarId)));
      if (
        !isValidCardQuestion(seedCardQuestion(seed.topic)) ||
        !isEligibleCrossDomainSeedMoment(seed, events, now)
      ) {
        throw new Error("This seed moment is not eligible to be offered");
      }
      const eventId = await ctx.db.insert("momentEvents", {
        scholarId: args.scholarId,
        kind: "seed",
        seedId: seed._id,
        trigger: "fluency_transition",
        offeredAt: now,
        outcome: "offered",
        clientEventId,
      });
      return { eventId, seedId: seed._id };
    }

    if (
      args.seedId !== undefined ||
      args.fromKey === undefined ||
      args.toKey === undefined
    ) {
      throw new Error("Story moments require fromKey and toKey");
    }
    const context = await storyEdgeContext(ctx, args.fromKey, args.toKey);
    if (!context) throw new Error("Story edge not found");
    if (!isValidCardQuestion(storyCardQuestion(args.fromKey, args.toKey))) {
      throw new Error("This story moment is not eligible to be offered");
    }

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
 * Record the scholar's answer to the card's question. FEEDBACK-ONLY: it never
 * touches mastery or spaced repetition. Correctness is computed here from the
 * same lookup the selector used (never trusted from the client). First answer
 * wins: a repeat call returns the stored result unchanged. Advances the
 * outcome to "probed" through the shared precedence rules (a later or terminal
 * outcome is never regressed).
 */
export const recordMomentAnswer = authedMutation({
  args: { eventId: v.id("momentEvents"), choiceIndex: v.number() },
  handler: async (ctx, args) => {
    const event = await ctx.db.get("momentEvents", args.eventId);
    if (!event) throw new Error("Moment event not found");
    // Self-only: the scholar who owns the row.
    if (event.scholarId !== ctx.user._id) {
      throw new Error("Not your moment");
    }

    if (event.answerIndex !== undefined && event.answerCorrect !== undefined) {
      return { correct: event.answerCorrect, answerIndex: event.answerIndex };
    }

    let question;
    if (event.kind === "seed") {
      const seed = event.seedId ? await ctx.db.get(event.seedId) : null;
      question = seed ? seedCardQuestion(seed.topic) : undefined;
    } else if (event.fromKey && event.toKey) {
      question = storyCardQuestion(event.fromKey, event.toKey);
    }
    if (!isValidCardQuestion(question)) {
      throw new Error("This moment has no question");
    }
    if (
      !Number.isInteger(args.choiceIndex) ||
      args.choiceIndex < 0 ||
      args.choiceIndex >= question.choices.length
    ) {
      throw new Error("Choice out of range");
    }

    const correct = isCorrectChoice(question, args.choiceIndex);
    await ctx.db.patch(event._id, {
      answerIndex: args.choiceIndex,
      answerCorrect: correct,
      answeredAt: Date.now(),
    });
    await applyMomentOutcome(ctx, event, "probed");
    return { correct, answerIndex: args.choiceIndex };
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
