import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { authedQuery, authedMutation, teacherMutation } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { isPublicProductionDeployment } from "./lib/deploymentSafety";
import {
  plantTeacherSeed,
  plantBadgeFollowSeed,
  insertSeed,
  normalizeSuggestionType,
  buildScholarSky,
  buildScholarSkyView,
  markSeedCompleted,
  pruneObserverSeeds,
  recentPendingObserverSeedCandidates,
  recentSeedsForScholarByStatus,
  selectDuplicatePendingObserverSeed,
  visitedSeedIdsForScholar,
  SEED_READ_LIMIT,
  type SeedOrigin,
} from "./lib/seeds";
import { requireActiveScholarAccess } from "./lib/access";
import {
  standingStoryInvitationsForScholar,
  suggestedQuestsForScholar,
  unlockedStoriesForScholar,
} from "./lib/scholarReads";

/** Dev-only guard — never let a demo fixture reshape a real scholar's record. */
function isProdDeployment(): boolean {
  const cloudUrl = process.env.CONVEX_CLOUD_URL;
  if (!cloudUrl) return false;
  return isPublicProductionDeployment("RABBITHOLE_ALLOW_DEV_FIXTURES");
}

/**
 * Record a seed from the AI observer (status: "pending", default-on).
 * Dedup is two-layer: the observer itself declares a semantic duplicate via
 * refreshesSeedId (it sees the pending list in its context), and an
 * exact-topic identity check backstops it (completed seeds are terminal and
 * never re-matched). Then prunes the unvisited observer firehose back to the
 * bounded live sky cache.
 */
export const record = internalMutation({
  args: {
    scholarId: v.id("users"),
    sessionId: v.id("sessions"),
    topic: v.string(),
    domain: v.optional(v.string()),
    suggestionType: v.string(),
    rationale: v.string(),
    scholarInvitation: v.optional(v.string()),
    approachHint: v.optional(v.string()),
    connectionTo: v.optional(v.string()),
    currentBloomsLevel: v.optional(v.number()),
    targetBloomsLevel: v.optional(v.number()),
    refreshesSeedId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const visitedSeedIds = await visitedSeedIdsForScholar(ctx, args.scholarId);
    const candidates = await recentPendingObserverSeedCandidates(
      ctx,
      args.scholarId,
    );

    // Observer-declared refresh target (the LLM's own dedup judgment — the
    // supersession pattern applied to seeds). Validated hard: the id must
    // normalize, belong to this scholar, be an ai-origin pending seed, and not
    // already visited. Anything else falls through to the exact-topic backstop.
    let declared: Doc<"seeds"> | null = null;
    if (args.refreshesSeedId) {
      const id = ctx.db.normalizeId("seeds", args.refreshesSeedId);
      const doc = id ? await ctx.db.get(id) : null;
      if (
        doc &&
        doc.scholarId === args.scholarId &&
        doc.origin === "ai" &&
        doc.status === "pending" &&
        !visitedSeedIds.has(String(doc._id))
      ) {
        declared = doc;
      }
    }
    const existing =
      declared ??
      selectDuplicatePendingObserverSeed(
        candidates,
        { topic: args.topic },
        { visitedSeedIds },
      );

    if (existing) {
      await ctx.db.patch(existing._id, {
        // Safe unconditionally: a declared refresh re-frames the topic on
        // purpose; a backstop match means the topic string is identical.
        topic: args.topic,
        ...(args.domain !== undefined ? { domain: args.domain } : {}),
        rationale: args.rationale,
        scholarInvitation: args.scholarInvitation,
        sessionId: args.sessionId,
        approachHint: args.approachHint,
        connectionTo: args.connectionTo,
        currentBloomsLevel: args.currentBloomsLevel,
        targetBloomsLevel: args.targetBloomsLevel,
      });
      await pruneObserverSeeds(ctx, args.scholarId, {
        visitedSeedIds,
      });
      return existing._id;
    }

    const seedId = await insertSeed(ctx, {
      scholarId: args.scholarId,
      origin: "ai",
      status: "pending",
      topic: args.topic,
      domain: args.domain,
      suggestionType: normalizeSuggestionType(args.suggestionType),
      rationale: args.rationale,
      scholarInvitation: args.scholarInvitation,
      approachHint: args.approachHint,
      connectionTo: args.connectionTo,
      sessionId: args.sessionId,
      currentBloomsLevel: args.currentBloomsLevel,
      targetBloomsLevel: args.targetBloomsLevel,
    });
    await pruneObserverSeeds(ctx, args.scholarId, {
      visitedSeedIds,
    });
    return seedId;
  },
});

export const markCompleted = internalMutation({
  args: { seedId: v.id("seeds") },
  handler: async (ctx, args) => {
    return await markSeedCompleted(ctx, args.seedId);
  },
});

/**
 * Get active seeds for a scholar (used by observer for context).
 */
export const activeByScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", args.scholarId).eq("status", "active")
      )
      .collect();
  },
});

/** Pending observer seeds (dedup targets) — fed into the observer's context. */
export const pendingObserverByScholar = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) =>
    await recentPendingObserverSeedCandidates(ctx, args.scholarId),
});

/**
 * Teacher reviews a pending AI seed: accept or dismiss.
 */
export const review = teacherMutation({
  args: {
    id: v.id("seeds"),
    action: v.union(v.literal("accept"), v.literal("dismiss")),
    dismissedReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.db.get(args.id);
    if (!seed) throw new Error("Seed not found");
    await requireActiveScholarAccess(ctx, ctx.user, seed.scholarId);
    if (seed?.status === "completed") {
      throw new Error("Completed seeds are terminal");
    }
    if (args.action === "accept") {
      await ctx.db.patch(args.id, {
        status: "active",
        teacherId: ctx.user._id,
      });
    } else {
      await ctx.db.patch(args.id, {
        status: "dismissed",
        dismissedReason: args.dismissedReason,
        teacherId: ctx.user._id,
      });
    }
  },
});

/**
 * Teacher overlay on a star, straight from the map drawer (the curation twin
 * of `review`, but as a single status target so the map can promote / unpin /
 * remove without an action vocabulary):
 *   - "active"    = PROMOTE to a teacher-suggested star (pins it → 📌). Origin
 *                   is preserved (so "AI-suggested, teacher-pinned" stays
 *                   honest); the pin IS the teacher endorsement.
 *   - "pending"   = UNPIN / demote back to a plain AI suggestion (still shown
 *                   to the scholar, just no longer teacher-endorsed).
 *   - "dismissed" = REMOVE the destination from the scholar's sky.
 * Stamps the acting teacher either way.
 */
export const setStatus = teacherMutation({
  args: {
    id: v.id("seeds"),
    status: v.union(
      v.literal("active"),
      v.literal("pending"),
      v.literal("dismissed"),
    ),
    dismissedReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.db.get(args.id);
    if (!seed) throw new Error("Seed not found");
    await requireActiveScholarAccess(ctx, ctx.user, seed.scholarId);
    if (seed?.status === "completed") {
      throw new Error("Completed seeds are terminal");
    }
    await ctx.db.patch(args.id, {
      status: args.status,
      teacherId: ctx.user._id,
      dismissedReason:
        args.status === "dismissed" ? args.dismissedReason : undefined,
    });
  },
});

/**
 * Teacher edits a star's copy in place — fix the AI's wording, or author the
 * scholar-facing invitation (the 2nd-person hook the kid reads) separately from
 * the teacher diagnostic `rationale`. Only the provided fields change.
 */
export const update = teacherMutation({
  args: {
    id: v.id("seeds"),
    topic: v.optional(v.string()),
    domain: v.optional(v.string()),
    rationale: v.optional(v.string()),
    scholarInvitation: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const seed = await ctx.db.get(args.id);
    if (!seed) throw new Error("Seed not found");
    await requireActiveScholarAccess(ctx, ctx.user, seed.scholarId);
    const patch: Record<string, string | undefined> = {};
    if (args.topic !== undefined) patch.topic = args.topic.trim();
    if (args.domain !== undefined) patch.domain = args.domain.trim() || undefined;
    if (args.rationale !== undefined) patch.rationale = args.rationale.trim();
    if (args.scholarInvitation !== undefined)
      patch.scholarInvitation = args.scholarInvitation.trim() || undefined;
    await ctx.db.patch(args.id, patch);
  },
});

/**
 * Teacher creates a seed directly (goes straight to "active").
 */
export const create = teacherMutation({
  args: {
    scholarId: v.id("users"),
    topic: v.string(),
    domain: v.optional(v.string()),
    rationale: v.string(),
    scholarInvitation: v.optional(v.string()),
    approachHint: v.optional(v.string()),
    targetBloomsLevel: v.optional(v.number()),
    intent: v.optional(v.union(v.literal("seed"), v.literal("destination"))),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const { id } = await plantTeacherSeed(ctx, {
      scholarId: args.scholarId,
      topic: args.topic,
      rationale: args.rationale,
      scholarInvitation: args.scholarInvitation,
      domain: args.domain,
      approachHint: args.approachHint,
      targetBloomsLevel: args.targetBloomsLevel,
      intent: args.intent,
      teacherId: ctx.user._id,
    });
    return id;
  },
});

/**
 * "Follow the trail" — plant a star on a follower scholar's map, inspired by a
 * badge another scholar earned. This is how an interest spreads virally through
 * the classroom ("that badge is sick, I want it too"): the fork is simply its
 * OWN new star on the follower's sky — we never mutate or surface anything on
 * the original badge, and there is no fork-on-fork (badges come from units, not
 * from these follow-seeds). Reuses the existing seed primitive.
 *
 * Idempotent per (follower, topic): re-following just returns the existing star
 * instead of cluttering the sky with duplicates.
 */
export const followBadge = teacherMutation({
  args: {
    followerScholarId: v.id("users"),
    topic: v.string(),
    domain: v.optional(v.string()),
    inspiredByName: v.string(),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.followerScholarId);
    return await plantBadgeFollowSeed(ctx, {
      scholarId: args.followerScholarId,
      topic: args.topic,
      domain: args.domain,
      inspiredByName: args.inspiredByName,
      teacherId: ctx.user._id,
      rationale: `Inspired by the “${args.topic}” badge ${args.inspiredByName} earned — chase the same trail and make it your own.`,
    });
  },
});

/**
 * Scholar-driven "follow the trail" — the social-proof opt-in. A scholar
 * plants a star on their OWN map after seeing a pod-mate's earned badge
 * (trophyCase.trailsForScholar). Same fork semantics as the teacher-driven
 * followBadge — its own new proto-activity star, a fresh ad-libbed path, not
 * a copy of the original unit — but initiated by the scholar themselves.
 * Idempotent per (scholar, topic).
 */
export const followBadgeSelf = authedMutation({
  args: {
    topic: v.string(),
    domain: v.optional(v.string()),
    inspiredByName: v.string(),
    // When the trail is a structured unit, join the SAME unit (a guided-path
    // star) so opting in starts the real lesson and the same badge is in
    // reach — not a vague topic-only fork.
    unitId: v.optional(v.id("units")),
  },
  handler: async (ctx, args) => {
    return await plantBadgeFollowSeed(ctx, {
      scholarId: ctx.user._id,
      topic: args.topic,
      domain: args.domain,
      inspiredByName: args.inspiredByName,
      unitId: args.unitId,
      rationale: `Inspired by the “${args.topic}” trail ${args.inspiredByName} blazed — join the quest and make it your own.`,
    });
  },
});

/**
 * The scholar's SKY — every suggested exploration as a "star", DEFAULT-ON.
 *
 * Governance correction (default-on, not a gate): the kid's exploration sky is
 * on by default — both AI-suggested ("pending") and teacher-pinned ("active")
 * seeds show, EXCEPT ones the teacher explicitly dismissed. The teacher shapes
 * the sky as an overlay (pin = "active", hide = "dismissed"); they are not an
 * item-by-item gate. This subsumes the old flat "Next adventures" list.
 *
 * Returns `{ seeds, mastery, starter }` (see `buildScholarSkyView`): `seeds`
 * is this array of invitations; `mastery` is the scholar's own demonstrated-
 * fluent practice skills, lit as a constellation; `starter` is a warm cold-
 * start layer blended in only while `seeds` is still nearly empty.
 */
export const skyForSelf = authedQuery({
  args: {},
  handler: async (ctx) => buildScholarSkyView(ctx, ctx.user._id),
});

/**
 * Lightweight launch info for the "choose your path" menu: is this seed a
 * TOPIC seed (no unit yet → it will be baked, so the scholar picks a shape),
 * or already structured (a teacher offer / prior bake → start its unit
 * directly, no menu)? Returns the topic for the menu header. Scholar's own
 * seeds only.
 */
export const getBakeLaunchInfo = authedQuery({
  args: { seedId: v.id("seeds") },
  handler: async (ctx, args) => {
    const seed = await ctx.db.get(args.seedId);
    if (!seed || seed.scholarId !== ctx.user._id) return null;
    if (seed.status === "completed") return null;
    return {
      isTopicSeed: !seed.unitId,
      topic: seed.topic,
      domain: seed.domain ?? null,
      // Scholar-facing only — prefer the invitation, never the teacher rationale.
      rationale: seed.scholarInvitation ?? seed.rationale ?? null,
      readingLevel: ctx.user.readingLevel ?? null,
    };
  },
});

/**
 * Teacher-facing twin of `skyForSelf`: the SAME constellation a scholar sees,
 * for a teacher curating it from the Guidance tab (DEC 2 — "one sky, two
 * viewers"). Gated by requireTeacherOrSelf (teacher of any scholar, or the
 * scholar themselves).
 */
export const skyForScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    // The return value is true only for a real teacher/admin viewer (not the
    // self-scholar) — exactly who may see the diagnostic `rationale`/`origin`.
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    return buildScholarSky(ctx, args.scholarId, { forTeacher: isTeacher });
  },
});

/**
 * Scholar-facing: the teacher's STRUCTURED pushes — "Suggested by your teacher".
 *
 * A "suggested quest" is the stronger sibling of a plain seed: the teacher
 * pushed a SPECIFIC built unit at this scholar (origin "teacher" + a unitId),
 * not just a topic spark. We promote those out of the star map into their own
 * home section, above the peer trails (see review/pr-258 SUGGESTED-QUEST). Only
 * the not-yet-started ones (a started quest spawns a session stamped with the
 * seed's id, and then lives in the in-progress plate instead). Newest first.
 */
export const suggestedQuestsForSelf = authedQuery({
  args: {},
  handler: async (ctx) => {
    // The scholar-parameterized core lives in lib/scholarReads so the teacher
    // Home mirror (scholarPlate.homeForScholar) renders the identical set. Map
    // to this query's existing public shape (the teacher-only `isAuthored` flag
    // the scholar client never uses is omitted).
    const quests = await suggestedQuestsForScholar(ctx, ctx.user._id);
    return quests.map((q) => ({
      seedId: q.seedId,
      unitId: q.unitId,
      title: q.title,
      emoji: q.emoji,
      activityCount: q.activityCount,
      rationale: q.rationale,
      description: q.description,
      teacherName: q.teacherName,
      teacherImage: q.teacherImage,
    }));
  },
});

/**
 * Scholar-facing: "Unlocked by your new skills" — the world-connection stories
 * this scholar earned by turning skills fluent, each cited back to the skill
 * that unlocked it.
 *
 * The sibling of `suggestedQuestsForSelf` above, and the reason story moments
 * stopped being a one-shot: a story is offered exactly once, on the practice
 * done screen, and any non-action there is terminal. So
 * `practiceMoments.recordMomentOffered` keeps every offered story as a seed
 * automatically, and this read gives those souvenirs a home on Home. Core in
 * lib/scholarReads so a teacher-facing mirror can reuse it without drifting.
 */
export const unlockedStoriesForSelf = authedQuery({
  args: {},
  handler: async (ctx) => unlockedStoriesForScholar(ctx, ctx.user._id),
});

/**
 * Scholar-facing story invitations that are still waiting to be followed or
 * dismissed. Offered stories remain durable Sky seeds after this card retires.
 */
export const standingStoryInvitationsForSelf = authedQuery({
  args: {},
  handler: async (ctx) =>
    standingStoryInvitationsForScholar(ctx, ctx.user._id),
});

/**
 * Teacher-facing: all seeds for a scholar. A teacher/admin gets the full rows
 * (incl. the diagnostic `rationale` / `approachHint` / dismiss reasons). A
 * scholar viewing their OWN seeds is redacted — those teacher-only fields must
 * not reach the kid's client (the same redaction boundary `buildScholarSky`
 * enforces). `rationale` is replaced with the scholar invitation (falling back
 * to the rationale only for legacy seeds that have no invitation yet, matching
 * the sky's `blurb`); the teacher-directed `approachHint` / `dismissedReason`
 * are dropped.
 */
export const listByScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    // Boundary: a staff caller may only read a scholar in their active
    // context (their institution). Self-reads bypass; a cross-context read
    // throws. See convex/lib/access.ts.
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);

    const rows = await recentSeedsForScholarByStatus(ctx, args.scholarId, [
      "active",
      "pending",
      "dismissed",
      "completed",
    ]);
    const boundedRows = rows.slice(0, SEED_READ_LIMIT);

    if (isTeacher) return boundedRows;

    return boundedRows.map((s) => ({
      ...s,
      rationale: s.scholarInvitation ?? s.rationale,
      approachHint: undefined,
      dismissedReason: undefined,
    }));
  },
});

/** How many knowledge-graph skills the dev sky fixture lights as FLUENT.
 *  Below MASTERY_STAR_CAP (40) so the cap isn't what shapes the fixture, but
 *  dense enough to exercise the mastery layer and the prereq lattice. */
const DEV_SKY_MASTERY_COUNT = 32;

/**
 * DEV-ONLY: seed a rich cross-disciplinary "constellation" of exploration
 * seeds for one scholar (by username), so the star-chart sky has compelling
 * content to demo. Idempotent-ish: clears prior dev-sky seeds first.
 *
 * The constellation is deliberately LOPSIDED — repeated domains, repeated
 * anchors, a few teacher-curated/pinned/structured entries, topic labels of
 * wildly different lengths. Invitations accrue that way in real life, and the
 * Sky's consideration ranker (lib/skySeedSelection) and its at-rest cap only
 * do observable work against a pile like this; a tidy one-seed-per-domain
 * fixture makes any cap look equally good. Pass `liveSeeds: <n>` to truncate.
 *
 * Also lights a slab of FLUENT practice skills (the night-museum / mastery
 * layer) so the dev sky reaches real density — pass `mastery: 0` to skip, or a
 * count to override. Without them the sky is seeds-only and mastery-star /
 * lattice rendering can't be seen at all.
 *
 * Run: npx convex run seeds:devSeedSky '{"username":"test-scholar-001"}'
 */
export const devSeedSky = internalMutation({
  args: { username: v.string(), mastery: v.optional(v.number()), liveSeeds: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // `internalMutation` blocks CLIENTS, not the CLI — a deployed internal fn is
    // still `npx convex run`-able against prod. This fixture DELETES matching
    // practiceMastery rows and writes synthetic ones stamped `source:
    // "practice"`, i.e. indistinguishable from a real kid's demonstrated
    // fluency. Same guard the other dev seeds use (convex/seed/devPersonas.ts).
    if (isProdDeployment()) {
      console.log("devSeedSky: skipped (prod).");
      return { skipped: "prod" as const };
    }
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (!scholar) throw new Error(`No user with username ${args.username}`);

    // Clear previous dev-sky seeds (origin "dev-sky") to stay idempotent.
    const prior = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_origin", (q) =>
        q.eq("scholarId", scholar._id).eq("origin", "dev-sky")
      )
      .collect();
    for (const p of prior) await ctx.db.delete(p._id);

    const constellation: Array<{
      topic: string;
      domain: string;
      rationale: string;
      connectionTo: string;
      suggestionType: string;
      reach: number;
      /** A teacher actually touched this one (`curated` in the ranker: +140). */
      curated?: boolean;
      /** Teacher-pinned / scholar-saved → status "active" (`pinned`: +20, and
       *  exempt from the seed-LIST cap in lib/seeds buildScholarSky). */
      pinned?: boolean;
      /** Points at a real unit → `structured` in the ranker (+100). */
      structured?: boolean;
    }> = [
      {
        topic: "Vampire-bat reciprocity",
        domain: "Biology",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness & fair trades",
        rationale:
          "Vampire bats remember who shared blood with them last night — and refuse the cheaters. Fairness, enforced, with no words and no math. A wild bridge from your instinct for fair trades into evolutionary biology.",
      },
      {
        topic: "The medieval \u201cjust price\u201d",
        domain: "History",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness & fair trades",
        rationale:
          "Medieval guilds argued for centuries over what a loaf of bread *should* cost. Who gets to decide what's fair — the baker, the buyer, or the king?",
      },
      {
        topic: "Symmetry & conservation laws",
        domain: "Physics",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness & balance",
        rationale:
          "Physics seems to \u201cwant\u201d balance — symmetry is the universe's own kind of fairness, and it predicts what stays the same when everything else changes.",
      },
      {
        topic: "Aboriginal gift economies",
        domain: "Culture",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness as a social contract",
        rationale:
          "Whole societies run on giving, not trading. Fairness becomes a social contract held in song and obligation rather than money.",
      },
      {
        topic: "The Ultimatum Game across cultures",
        domain: "Anthropology",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness & fair trades",
        rationale:
          "In some cultures people angrily reject \u201cunfair\u201d money even when saying no leaves them with nothing. Why would fairness beat free cash?",
      },
      {
        topic: "Auction & market design",
        domain: "Economics",
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "fair division",
        rationale:
          "Nobel-winning math for splitting things fairly — kidney swaps, radio spectrum, who gets which dorm room.",
      },
      {
        topic: "Splitting the rent fairly",
        domain: "Mathematics",
        curated: true,
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "equivalent fractions",
        rationale:
          "When the rooms aren't equal, how do roommates split rent so nobody envies anyone? The \u201cI-cut-you-choose\u201d algorithm, made rigorous.",
      },
      {
        topic: "Nautical signal flags",
        domain: "Maritime",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "rules everyone agrees to",
        rationale:
          "Sailors built a whole language out of colored flags so ships could agree across silence. A code only works if everyone plays fair — sound familiar?",
      },
      {
        topic: "Game theory & the prisoner's dilemma",
        domain: "Mathematics",
        suggestionType: "frontier",
        reach: 0,
        connectionTo: "game strategy",
        rationale:
          "When is it smart to cooperate and when to defect? The math behind every \u201cfair trade\u201d you keep reaching for.",
      },
      // ── The accrued pile ────────────────────────────────────────────────
      // The nine above are one clean thread, one seed per domain — a profile
      // no real scholar ever has. Invitations ACCRUE: a kid goes deep on two
      // or three interests, the same anchor gets revisited, and by mid-year
      // the live pool is a lopsided pile with long topics and repeated
      // domains. That lopsidedness is exactly what the sky's consideration
      // ranker (lib/skySeedSelection — it penalises repeat domains AND repeat
      // anchors) exists to handle, so a fixture without it can't show whether
      // the at-rest cap is doing its job. Curated/pinned/structured seeds are
      // included because they carry the ranker's heaviest bonuses.
      {
        topic: "Zebra stripes are a math equation",
        domain: "Biology",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "patterns that repeat",
        rationale:
          "Turing worked out that two chemicals chasing each other across skin can produce stripes, spots, or nothing at all — the same equation, different dials.",
      },
      {
        topic: "Slime mold solves mazes",
        domain: "Biology",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "patterns that repeat",
        rationale:
          "A single-celled blob with no brain reliably finds the shortest path through a maze — and rebuilt the Tokyo rail map when researchers gave it oat flakes for cities.",
      },
      {
        topic: "Why do bees build hexagons?",
        domain: "Biology",
        pinned: true,
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "shapes that tile",
        rationale:
          "Of every shape that tiles a plane, the hexagon fences off the most area for the least wax. Bees found the proof before anyone wrote it down.",
      },
      {
        topic: "Octopus camouflage",
        domain: "Biology",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "shapes that tile",
        rationale:
          "An octopus is colorblind and still matches the reef exactly. The current best guess is that its SKIN sees color, one pixel at a time.",
      },
      {
        topic: "Fibonacci in pinecones",
        domain: "Mathematics",
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "patterns that repeat",
        rationale:
          "Count the spirals on a pinecone and you keep landing on the same sequence. Growth has a favorite ratio, and it's not an accident.",
      },
      {
        topic: "Infinity has different sizes",
        domain: "Mathematics",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "counting past the last number",
        rationale:
          "There are more decimals between 0 and 1 than there are whole numbers in all of forever. Cantor proved it in half a page, and it made people furious.",
      },
      {
        topic: "Map coloring & the four-color theorem",
        domain: "Mathematics",
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "shapes that tile",
        rationale:
          "Four colors are always enough for any map, no matter how tangled the borders. The first accepted proof needed a computer — and mathematicians argued for years about whether that counts.",
      },
      {
        topic: "Cryptography & prime numbers",
        domain: "Mathematics",
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "counting past the last number",
        rationale:
          "Every secret you send online is guarded by the fact that multiplying two big primes is easy and un-multiplying them is not.",
      },
      {
        topic: "Longitude & the clock that saved ships",
        domain: "History",
        curated: true,
        suggestionType: "leap",
        reach: 2,
        connectionTo: "rules everyone agrees to",
        rationale:
          "Sailors could find their latitude from the sun but had no way to know how far east they'd gone. A carpenter with no formal training beat the astronomers to it.",
      },
      {
        topic: "The library of Alexandria's lost catalog",
        domain: "History",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "how knowledge is kept",
        rationale:
          "Someone had to invent the idea that scrolls should be findable. The catalog may matter more than the building that burned.",
      },
      {
        topic: "Cathedral builders had no blueprints",
        domain: "History",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "how knowledge is kept",
        rationale:
          "Structures that took 200 years were built by crews who never met the person who started it, using templates and rules of thumb passed hand to hand.",
      },
      {
        topic: "Ships' logs as climate records",
        domain: "History",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "how knowledge is kept",
        rationale:
          "Two hundred years of bored sailors writing down the weather every four hours turns out to be the best record we have of the old ocean.",
      },
      {
        topic: "Noether's theorem",
        domain: "Physics",
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "fairness & balance",
        rationale:
          "Every conservation law in physics is a symmetry wearing a disguise — and one mathematician proved they're the same statement.",
      },
      {
        topic: "Why is the sky's blue the sky's blue?",
        domain: "Physics",
        suggestionType: "frontier",
        reach: 0,
        connectionTo: "light and color",
        rationale:
          "Short wavelengths scatter more. That one sentence explains the blue sky, the red sunset, and why the ocean isn't blue for the same reason.",
      },
      {
        topic: "Sound is a shape you can draw",
        domain: "Physics",
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "patterns that repeat",
        rationale:
          "Sprinkle sand on a metal plate and play a note: the sand runs away from the shaking and settles into the note's own picture.",
      },
      {
        topic: "Tuning systems & why pianos lie",
        domain: "Music",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "patterns that repeat",
        rationale:
          "Pure math says the octave and the fifth can't both be perfect. Every piano is a negotiated compromise, slightly out of tune on purpose.",
      },
      {
        topic: "Polyrhythm in West African drumming",
        domain: "Music",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "patterns that repeat",
        rationale:
          "Three against two, four against three — patterns that only line up every twelve beats. Your ear finds the pulse your hands can't clap.",
      },
      {
        topic: "Why does a $20 bill work?",
        domain: "Economics",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness as a social contract",
        rationale:
          "It's a piece of cotton. It works because everyone believes everyone else believes it works — an agreement with no signatures.",
      },
      {
        topic: "The tragedy of the commons",
        domain: "Economics",
        curated: true,
        pinned: true,
        structured: true,
        suggestionType: "frontier",
        reach: 1,
        connectionTo: "fairness & fair trades",
        rationale:
          "A shared pasture everyone is individually right to overgraze. Ostrom won a Nobel for finding the communities that beat it anyway.",
      },
      {
        topic: "Bridges that sing in the wind",
        domain: "Engineering",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness & balance",
        rationale:
          "Tacoma Narrows tore itself apart in a 40 mph breeze. Every bridge since has been designed against a wind that isn't even strong.",
      },
      {
        topic: "How does a lock actually work?",
        domain: "Engineering",
        suggestionType: "frontier",
        reach: 0,
        connectionTo: "rules everyone agrees to",
        rationale:
          "Five little pins at five different heights. Understanding why that's hard to defeat is the whole of security in miniature.",
      },
      {
        topic: "The marshmallow test didn't replicate",
        domain: "Psychology",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "fairness as a social contract",
        rationale:
          "The famous study said patient kids do better in life. The rerun said: mostly they had reason to trust the adult would come back.",
      },
      {
        topic: "The ship of Theseus",
        domain: "Philosophy",
        suggestionType: "leap",
        reach: 2,
        connectionTo: "how knowledge is kept",
        rationale:
          "Replace every plank one at a time and it's still the same ship — until you rebuild the old planks into a second one. Now which is it?",
      },
    ];

    // A curated/pinned/structured seed carries the consideration ranker's
    // heaviest bonuses, so the fixture needs real ids for them or that whole
    // branch of the ranking goes untested. Both are best-effort: a deployment
    // with no teacher / no units still gets the full constellation, just
    // uniformly un-curated.
    const anyTeacher = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "teacher"))
      .first();
    const anyUnit = await ctx.db.query("units").first();

    // `liveSeeds` truncates the constellation — the knob for looking at the
    // Sky at different live-invitation counts without hand-editing this list.
    const planting =
      args.liveSeeds === undefined
        ? constellation
        : constellation.slice(0, Math.max(0, args.liveSeeds));

    let n = 0;
    for (const c of planting) {
      await ctx.db.insert("seeds", {
        scholarId: scholar._id,
        origin: "dev-sky",
        status: c.pinned ? "active" : "pending",
        topic: c.topic,
        domain: c.domain,
        suggestionType: normalizeSuggestionType(c.suggestionType),
        rationale: c.rationale,
        connectionTo: c.connectionTo,
        sourceLens: "interpretive",
        reach: c.reach,
        ...(c.curated && anyTeacher ? { teacherId: anyTeacher._id } : {}),
        ...(c.structured && anyUnit ? { unitId: anyUnit._id } : {}),
      });
      n++;
    }

    // The night-museum layer. WITHOUT this the dev sky is seeds-only, which
    // hides an entire class of rendering bug: the mastery star treatment and
    // the prereq lattice only misbehave at real density, so a simulator could
    // not reproduce what a scholar with actual practice history sees. (That is
    // exactly how the inverted size hierarchy and the disconnected lattice
    // lines shipped — both were invisible on every dev fixture and only showed
    // up on a physical iPad against a real account. 2026-07-26.)
    //
    // Mastery stars are derived, not planted: buildMasteryStars reads FLUENT
    // `practiceMastery` rows (lib/skyMuseum), so we make real knowledge-graph
    // nodes fluent rather than inventing star rows. That also gives the sky
    // genuine `prereqEdges` to draw a lattice from.
    let fluent = 0;
    {
      const want = args.mastery ?? DEV_SKY_MASTERY_COUNT;
      // Stable selection: sort by nodeKey so re-running picks the SAME skills
      // and the delete-then-insert below is genuinely idempotent (insertion
      // order of knowledgeNodes is not).
      const nodes = (await ctx.db.query("knowledgeNodes").take(600)).sort((a, b) =>
        a.nodeKey.localeCompare(b.nodeKey),
      );
      const chosen = nodes.slice(0, want);
      // Clear the fixture's WHOLE reachable key space, not just the keys this
      // run is about to write. The rows carry no fixture marker (`source` must
      // be "practice" or isFluent rejects them), so the deterministic node
      // prefix IS the manifest — clearing only `want` keys left a bigger
      // previous run's tail behind, and `mastery: 0` cleared nothing at all.
      const clearKeys = new Set(
        nodes.slice(0, Math.max(want, DEV_SKY_MASTERY_COUNT)).map((nd) => nd.nodeKey),
      );
      const prior = await ctx.db
        .query("practiceMastery")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
        .collect();
      for (const p of prior) {
        if (clearKeys.has(p.skillKey)) await ctx.db.delete(p._id);
      }
      const now = Date.now();
      for (const node of chosen) {
        await ctx.db.insert("practiceMastery", {
          scholarId: scholar._id,
          skillKey: node.nodeKey,
          domain: node.domain,
          strand: node.strand,
          // FLUENT_REPS is 3; vary above it so the refCount-driven star sizing
          // (native lib/skyStarMetrics) has something to differentiate. Source
          // MUST be "practice" — it's the only DEMONSTRATED source, and
          // anything else fails isFluent and draws no star at all.
          repetition: 3 + (fluent % 4),
          halfLifeDays: 21,
          lastPracticedAt: now - fluent * 86_400_000,
          becameFluentAt: now - fluent * 86_400_000,
          frontier: false,
          source: "practice",
          updatedAt: now,
        });
        fluent++;
      }
    }

    return { scholar: scholar.name ?? args.username, inserted: n, fluent };
  },
});

/** DEV-ONLY: delete a scholar's seeds of a given origin (by username). */
export const devClearOrigin = internalMutation({
  args: { username: v.string(), origin: v.string() },
  handler: async (ctx, args) => {
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (!scholar) throw new Error(`No user ${args.username}`);
    const rows = await ctx.db
      .query("seeds")
      .withIndex("by_scholar_origin", (q) =>
        q.eq("scholarId", scholar._id).eq("origin", args.origin as SeedOrigin),
      )
      .collect();
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});
