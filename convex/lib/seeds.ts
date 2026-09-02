// Shared "exploration seed" primitive — ONE place that owns the seed write
// shape + dedupe rules, so every entry point that plants a star on a
// scholar's sky (the AI observer, a teacher "Add Seed", a Quest offer, a
// "follow this trail" fork, the staff aide) produces identical, normalized
// rows. See review/pr-258 audit DEC 1 ("one plantSeed primitive").
//
// A `seeds` row is a single primitive with a typed `origin` (who proposed it),
// a `status` (teacher overlay for pending/active/dismissed, plus terminal
// completed lifecycle), and a `suggestionType` (the pedagogical flavour).
// The validators here are the single source of truth for those three closed
// sets — imported into `schema.ts` AND reused as Convex arg validators.

import { v } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { cleanSeedLabel } from "./seedLabel";
import { questOnlineProgressForScholar } from "./scholarReads";
import { SEED_CONSIDERATION_CAP, SKY_COLD_START_MIN_STARS } from "../../shared/skyTiers";
import { buildMasteryStars, buildStarterLayer } from "./skyMuseum";
import { selectSkySeedCandidates, type SkySeedCandidate } from "./skySeedSelection";

// ─── The three closed enums (DEC 3 / F3 — were unconstrained v.string()) ───

/** Who proposed the seed. */
export const seedOriginValidator = v.union(
  v.literal("ai"), // the live observer
  v.literal("ai-constellation"), // the Interpretive sky generator
  v.literal("dev-sky"), // dev-only demo constellation
  v.literal("teacher"), // a teacher/aide hand-planted it (incl. unit offers)
  v.literal("badge_follow"), // a "follow this trail" fork off a peer's badge
  v.literal("story"), // a scholar-minted world-connection story souvenir (Moments)
);

/**
 * A seed's state. `pending` / `active` / `dismissed` are the teacher overlay
 * (suggested, pinned, hidden). `completed` is the terminal lifecycle state for
 * a thread the scholar explored and finished; visited is still derived from
 * linked sessions (`sessions.seedId`) for the "flown to" badge.
 */
export const seedStatusValidator = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("dismissed"),
  v.literal("completed"),
);

/** Pedagogical flavour of the suggestion. */
export const seedSuggestionTypeValidator = v.union(
  v.literal("frontier"),
  v.literal("depth_probe"),
  v.literal("extension"),
  v.literal("leap"),
  v.literal("cross_domain"),
  v.literal("teacher_suggestion"),
);

export type SeedOrigin =
  | "ai"
  | "ai-constellation"
  | "dev-sky"
  | "teacher"
  | "badge_follow"
  | "story";
export type SeedStatus = "pending" | "active" | "dismissed" | "completed";
export type SeedSuggestionType =
  | "frontier"
  | "depth_probe"
  | "extension"
  | "leap"
  | "cross_domain"
  | "teacher_suggestion";

const SUGGESTION_TYPES: SeedSuggestionType[] = [
  "frontier",
  "depth_probe",
  "extension",
  "leap",
  "cross_domain",
  "teacher_suggestion",
];

export const OBSERVER_SEED_CAP = 24;
const OBSERVER_DEDUP_LOOKBACK = 60;
export const SEED_READ_LIMIT = 60;

/**
 * A WIDER read bound, used only for `active` seeds when building the sky (see
 * `buildScholarSky`). `active` is the anchored status — teacher pins and
 * scholar-kept keepsakes live there, and a story-moment souvenir mints one per
 * curated story edge. A newest-N read on that status would silently drop the
 * OLDEST anchors (the earliest teacher pins) out of the sky entirely, with no
 * zoom-reveal to catch them. Bounded above by the curated story registry's size
 * plus curation headroom, so it stays a cheap, finite read.
 */
export const ACTIVE_SEED_READ_LIMIT = 120;

/**
 * The whole bounded live pool a single `buildScholarSky` read can produce
 * (`active` + `pending`). Pass this as `liveCap` when the caller wants EVERY
 * live seed rather than the at-rest consideration set — the sky map does, since
 * it applies its own tier-0 cap (`SKY_FIELD_SEED_CAP`) and reveals the rest on
 * zoom rather than dropping it.
 *
 * It exists so the map's "full live pool" intent can't silently drift from the
 * read limits again: the map used to pass `SEED_READ_LIMIT`, which meant "all of
 * it" only while anchored stars bypassed the cap entirely. Now that the cap is a
 * hard budget, a `liveCap` smaller than the pool would truncate the map — and
 * would have thrown away exactly the oldest anchors `ACTIVE_SEED_READ_LIMIT` was
 * widened to preserve.
 */
export const SKY_FULL_LIVE_POOL = ACTIVE_SEED_READ_LIMIT + SEED_READ_LIMIT;

type SeedDuplicateCandidate = Pick<
  Doc<"seeds">,
  "_id" | "_creationTime" | "domain" | "origin" | "status" | "topic"
>;

/**
 * Exact-topic duplicate among the live pending observer pool \u2014 a pure identity
 * check. SEMANTIC dedup ("same thread, different wording") is the observer's
 * own job via `refreshesSeedId`: it sees the pending list in its context and
 * declares the star it's refreshing. A word-overlap similarity heuristic used
 * to live here as well; it was removed when the observer-declared path landed
 * (the model reading the transcript beats a token-set intersection).
 */
export function selectDuplicatePendingObserverSeed<T extends SeedDuplicateCandidate>(
  candidates: readonly T[],
  next: { topic: string },
  opts?: { visitedSeedIds?: Set<string> },
): T | null {
  return (
    candidates.find(
      (seed) =>
        seed.origin === "ai" &&
        seed.status === "pending" &&
        !opts?.visitedSeedIds?.has(String(seed._id)) &&
        seed.topic === next.topic,
    ) ?? null
  );
}

export async function visitedSeedIdsForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
): Promise<Set<string>> {
  const scholarSessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  return new Set(
    scholarSessions.filter((s) => s.seedId).map((s) => String(s.seedId)),
  );
}

export async function recentPendingObserverSeedCandidates(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
) {
  const recentObserverSeeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_origin", (q) =>
      q.eq("scholarId", scholarId).eq("origin", "ai"),
    )
    .order("desc")
    .take(OBSERVER_DEDUP_LOOKBACK);
  return recentObserverSeeds
    .filter((seed) => seed.status === "pending")
    .slice(0, OBSERVER_SEED_CAP);
}

export async function pruneObserverSeeds(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  opts?: {
    cap?: number;
    visitedSeedIds?: Set<string>;
    dryRun?: boolean;
  },
): Promise<{ candidates: number; deleted: number; preserved: number }> {
  const cap = opts?.cap ?? OBSERVER_SEED_CAP;
  const pendingSeeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) =>
      q.eq("scholarId", scholarId).eq("status", "pending"),
    )
    .order("desc")
    .collect();
  // The cap is the live pending observer pool only. Completed seeds are a
  // terminal "you've been here" layer: never counted here, never pruned here.
  const pendingObserverSeeds = pendingSeeds.filter((seed) => seed.origin === "ai");
  if (pendingObserverSeeds.length <= cap) {
    return { candidates: 0, deleted: 0, preserved: 0 };
  }

  const visitedSeedIds =
    opts?.visitedSeedIds ?? (await visitedSeedIdsForScholar(ctx, scholarId));
  let candidates = 0;
  let deleted = 0;
  let preserved = 0;
  for (let i = cap; i < pendingObserverSeeds.length; i++) {
    const seed = pendingObserverSeeds[i];
    const visited = visitedSeedIds.has(String(seed._id));
    if (visited || seed.teacherId) {
      preserved++;
      continue;
    }

    candidates++;
    if (!opts?.dryRun) {
      await ctx.db.delete(seed._id);
      deleted++;
    }
  }
  return { candidates, deleted, preserved };
}

export async function recentSeedsForScholarByStatus(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  statuses: readonly SeedStatus[],
  perStatusLimit = SEED_READ_LIMIT,
) {
  const groups = await Promise.all(
    statuses.map((status) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) =>
          q.eq("scholarId", scholarId).eq("status", status),
        )
        .order("desc")
        .take(perStatusLimit),
    ),
  );
  return groups.flat().sort((a, b) => b._creationTime - a._creationTime);
}

/**
 * Clamp a free-text suggestionType (e.g. straight off an LLM) to the closed
 * set, so the AI write paths can't poison the now-narrowed schema. Unknown
 * values fall back to "frontier" (a neutral "next-step" flavour).
 */
export function normalizeSuggestionType(value: string): SeedSuggestionType {
  return (SUGGESTION_TYPES as string[]).includes(value)
    ? (value as SeedSuggestionType)
    : "frontier";
}

// ─── The canonical write ────────────────────────────────────────────────

type InsertSeedFields = {
  scholarId: Id<"users">;
  origin: SeedOrigin;
  status: SeedStatus;
  topic: string;
  suggestionType: SeedSuggestionType;
  rationale: string;
  scholarInvitation?: string;
  domain?: string;
  approachHint?: string;
  connectionTo?: string;
  sessionId?: Id<"sessions">;
  teacherId?: Id<"users">;
  currentBloomsLevel?: number;
  targetBloomsLevel?: number;
  sourceLens?: string;
  reach?: number;
  unitId?: Id<"units">;
  intent?: "seed" | "destination";
  storyFromKey?: string;
  storyToKey?: string;
};

/** The single seed insert — every plant-a-star path funnels through here. */
export async function insertSeed(
  ctx: MutationCtx,
  fields: InsertSeedFields,
): Promise<Id<"seeds">> {
  return await ctx.db.insert("seeds", fields);
}

export async function markSeedCompleted(
  ctx: MutationCtx,
  seedId: Id<"seeds">,
): Promise<{ completed: boolean; completedAt: number | null }> {
  const seed = await ctx.db.get(seedId);
  if (!seed) return { completed: false, completedAt: null };
  const completedAt = seed.completedAt ?? Date.now();
  if (seed.status === "completed" && seed.completedAt) {
    return { completed: false, completedAt };
  }
  await ctx.db.patch(seedId, {
    status: "completed",
    completedAt,
    dismissedReason: undefined,
  });
  return { completed: true, completedAt };
}

async function isQuestCompleteForScholar(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
): Promise<boolean> {
  // A seed offer describes a quest, whose lifecycle deliberately spans every
  // assignment. This mirrors the quest card and badge's assignment-blind
  // completion ledger, rather than the plate/nav's assignment-scoped progress.
  const progress = await questOnlineProgressForScholar(ctx, scholarId, unitId);
  return (
    progress.totalOnline > 0 &&
    progress.completedOnline >= progress.totalOnline
  );
}

async function seedIdsForCompletedUnit(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  unitId: Id<"units">,
  sessionSeedId?: Id<"seeds">,
): Promise<Set<Id<"seeds">>> {
  const seedIds = new Set<Id<"seeds">>();
  if (sessionSeedId) seedIds.add(sessionSeedId);

  const unit = await ctx.db.get(unitId);
  if (unit?.bakedFromSeedId) {
    const bakedSeed = await ctx.db.get(unit.bakedFromSeedId);
    if (bakedSeed?.scholarId === scholarId) seedIds.add(unit.bakedFromSeedId);
  }

  const scholarSeeds = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_status", (q) => q.eq("scholarId", scholarId))
    .collect();
  for (const seed of scholarSeeds) {
    if (seed.unitId === unitId && seed.status !== "completed") {
      seedIds.add(seed._id);
    }
  }
  return seedIds;
}

export async function maybeMarkCompletedSeedsForSession(
  ctx: MutationCtx,
  sessionId: Id<"sessions">,
) {
  const session = await ctx.db.get(sessionId);
  if (!session) return { completed: 0 };

  if (!session.unitId) {
    if (!session.seedId) return { completed: 0 };
    const result = await markSeedCompleted(ctx, session.seedId);
    return { completed: result.completed ? 1 : 0 };
  }

  const unitDone = await isQuestCompleteForScholar(
    ctx,
    session.userId,
    session.unitId,
  );
  if (!unitDone) return { completed: 0 };

  const seedIds = await seedIdsForCompletedUnit(
    ctx,
    session.userId,
    session.unitId,
    session.seedId,
  );
  let completed = 0;
  for (const seedId of seedIds) {
    const result = await markSeedCompleted(ctx, seedId);
    if (result.completed) completed++;
  }
  return { completed };
}

export async function maybeMarkCompletedSeedsForActivity(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  sessionId?: Id<"sessions">,
) {
  const activity = await ctx.db.get(activityId);
  if (!activity?.lessonId) {
    return sessionId
      ? await maybeMarkCompletedSeedsForSession(ctx, sessionId)
      : { completed: 0 };
  }
  const lesson = await ctx.db.get(activity.lessonId);
  if (!lesson) return { completed: 0 };

  const unitDone = await isQuestCompleteForScholar(
    ctx,
    scholarId,
    lesson.unitId,
  );
  if (!unitDone) return { completed: 0 };

  let sessionSeedId: Id<"seeds"> | undefined;
  if (sessionId) {
    const session = await ctx.db.get(sessionId);
    if (session?.userId === scholarId) sessionSeedId = session.seedId;
  }
  const seedIds = await seedIdsForCompletedUnit(
    ctx,
    scholarId,
    lesson.unitId,
    sessionSeedId,
  );
  let completed = 0;
  for (const seedId of seedIds) {
    const result = await markSeedCompleted(ctx, seedId);
    if (result.completed) completed++;
  }
  return { completed };
}

// ─── Higher-level plant helpers (the dedupe rules live here, once) ────────

/**
 * Teacher / aide hand-plants a seed (origin "teacher", status "active"). When
 * it points at a real unit (a Quest offer) we dedupe by (scholar, unit) so the
 * same destination isn't offered twice; topic-only seeds are never deduped
 * (a teacher may intentionally add the same topic twice with different framing).
 * Returns the existing star's id when a live unit-offer already exists.
 */
export async function plantTeacherSeed(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    topic: string;
    rationale: string;
    teacherId: Id<"users">;
    domain?: string;
    scholarInvitation?: string;
    approachHint?: string;
    targetBloomsLevel?: number;
    unitId?: Id<"units">;
    intent?: "seed" | "destination";
  },
): Promise<{ id: Id<"seeds">; existed: boolean }> {
  if (args.unitId) {
    const existing = (
      await ctx.db
        .query("seeds")
        .withIndex("by_scholar_status", (q) =>
          q.eq("scholarId", args.scholarId),
        )
        .filter((q) => q.eq(q.field("unitId"), args.unitId))
        .collect()
    ).find((seed) => !["dismissed", "completed"].includes(seed.status));
    if (existing) {
      return { id: existing._id, existed: true };
    }
  }
  const id = await insertSeed(ctx, {
    scholarId: args.scholarId,
    origin: "teacher",
    status: "active",
    suggestionType: "teacher_suggestion",
    topic: args.topic,
    rationale: args.rationale,
    scholarInvitation: args.scholarInvitation,
    domain: args.domain,
    approachHint: args.approachHint,
    targetBloomsLevel: args.targetBloomsLevel,
    teacherId: args.teacherId,
    unitId: args.unitId,
    // a structured (unit-backed) offer is inherently a destination
    intent: args.intent ?? (args.unitId ? "destination" : undefined),
  });
  return { id, existed: false };
}

/**
 * "Follow this trail" — plant a `badge_follow` fork star on a scholar's map,
 * inspired by a peer's earned badge. The shared core behind both the
 * teacher-driven (`seeds.followBadge`) and scholar-driven
 * (`seeds.followBadgeSelf`) paths (B1). Idempotent per (scholar, topic):
 * re-following returns the existing star instead of cluttering the sky.
 */
export async function plantBadgeFollowSeed(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    topic: string;
    inspiredByName: string;
    rationale: string;
    domain?: string;
    unitId?: Id<"units">;
    teacherId?: Id<"users">;
  },
): Promise<{ id: Id<"seeds">; alreadyFollowing: boolean }> {
  const existing = (
    await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", args.scholarId),
      )
      .filter((q) => q.eq(q.field("topic"), args.topic))
      .collect()
  ).find((seed) => !["dismissed", "completed"].includes(seed.status));
  if (existing) {
    return { id: existing._id, alreadyFollowing: true };
  }
  const id = await insertSeed(ctx, {
    scholarId: args.scholarId,
    origin: "badge_follow",
    status: "active",
    suggestionType: "extension",
    topic: args.topic,
    rationale: args.rationale,
    domain: args.domain,
    connectionTo: args.inspiredByName,
    unitId: args.unitId,
    teacherId: args.teacherId,
  });
  return { id, alreadyFollowing: false };
}

/**
 * Mint a durable story-star souvenir for a Moments story reveal (M2 — see
 * review/practice/completion-messaging-plan.html's sibling Moments plan).
 * Called automatically the moment the card is OFFERED
 * (practiceMoments.recordMomentOffered), so a verified world-connection story
 * survives whatever the scholar does next — a card walked past no longer loses
 * the story, only the moment.
 *
 * Unlike the other plant* helpers, the caller supplies only the story's ALREADY
 * server-resolved content (the mutations in practiceMoments.ts re-derive it from
 * the edge + nodes by graph identity, never from client-supplied text — the same
 * trust boundary /story-open enforces), so this stays a plain, unit-testable
 * write.
 *
 * Idempotent per (scholar, fromKey, toKey), keyed on the
 * `by_scholar_story_edge` index: unlike badge-follow (which lets a dismissed
 * trail be re-followed), a story-star is a quiet keepsake of a moment that
 * already happened — one per edge, ever, even if later dismissed from the sky.
 */
export async function plantStorySeed(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    fromKey: string;
    toKey: string;
    fromLabel: string;
    toLabel: string;
    toDomain: string;
    hook: string;
  },
): Promise<{ id: Id<"seeds">; existed: boolean }> {
  const existing = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_story_edge", (q) =>
      q
        .eq("scholarId", args.scholarId)
        .eq("storyFromKey", args.fromKey)
        .eq("storyToKey", args.toKey),
    )
    .first();
  if (existing) return { id: existing._id, existed: true };

  const id = await insertSeed(ctx, {
    scholarId: args.scholarId,
    origin: "story",
    status: "active",
    // "leap" is the closed set's own name for a transdisciplinary bridge from
    // the Interpretive constellation — precisely what a verified skill→world
    // story is (see the schema comment on `suggestionType`).
    suggestionType: "leap",
    topic: args.toLabel || args.hook,
    rationale: `A verified world-connection story the scholar starred after getting fluent in "${args.fromLabel}": ${args.hook}`,
    scholarInvitation: args.hook,
    connectionTo: args.fromLabel,
    domain: args.toDomain,
    storyFromKey: args.fromKey,
    storyToKey: args.toKey,
  });
  return { id, existed: false };
}

// ─── The scholar's SKY (read) ─────────────────────────────────────────────

/**
 * Project live seed rows onto the shared sky ranker's candidate shape
 * (lib/skySeedSelection). Input MUST already be newest-first: `recencyRank` is
 * the row's index within its own partition.
 */
function toSkySeedCandidates(
  rows: readonly Doc<"seeds">[],
): (SkySeedCandidate & { seed: Doc<"seeds"> })[] {
  return rows.map((seed, recencyRank) => ({
    // The ranker dedupes by `targetId`, so this must be the seed row's OWN
    // identity. Anything coarser (e.g. the placed-concept id the atlas path
    // uses) would silently drop live invitations from the consideration set.
    targetId: String(seed._id),
    domain: seed.domain ?? "general",
    connectionTo: seed.connectionTo,
    suggestionType: seed.suggestionType,
    reach: seed.reach,
    curated: !!seed.teacherId,
    pinned: seed.status === "active",
    structured: !!seed.unitId,
    // "Does this star's anchor point at a concept the scholar has already lit?"
    // is graph-thread information that only exists in the atlas path (it needs
    // the placed-node index). It is genuinely unavailable here, so no star in
    // this list earns the threaded bonus.
    threaded: false,
    recencyRank,
    seed,
  }));
}

/**
 * Build a scholar's exploration SKY. Live active/pending seeds are capped at the
 * shared `SEED_CONSIDERATION_CAP` (the at-rest consideration set — a handful of
 * invitations, one source of truth for web ⟷ native). That cap is a HARD bound:
 * the live set never exceeds it, whatever the mix of anchored and fresh stars.
 * Completed seeds are an
 * uncapped terminal "you've been here" layer that stays visible but no longer
 * competes with the live suggestion pool. A derived "visited" layer (a session
 * stamped with the seed's id proves the scholar flew there — DEC 3) still rides
 * alongside the lifecycle state. Shared by the scholar-facing `skyForSelf` and
 * the teacher-facing `skyForScholar` so both render the identical constellation
 * (DEC 2 — "one sky, two viewers").
 *
 * `liveCap` overrides how many live seeds come back: the direct seed-list
 * consumers (skyForSelf/skyForScholar → native "me" tab) take
 * the default consideration cap, while `concepts.skyFieldForScholar` passes a
 * larger cap so it can see every live seed — it builds seedMeta for the whole
 * consideration set AND free-floats the overflow into the deep field (never
 * dropping an invitation), applying the tier-0 cap itself.
 *
 * REDACTION BOUNDARY: the teacher `rationale` is diagnostic (it may name the
 * kid, the gap, the misconception) and must NOT reach the scholar's client.
 * So every star carries a scholar-safe `blurb` (the 2nd-person invitation, or
 * the rationale as a fallback for older seeds), and the raw `rationale` /
 * `scholarInvitation` / `origin` are only populated when `forTeacher` — the
 * scholar's payload gets them as `null`. The shape stays identical either way
 * so both queries share one type.
 */
export async function buildScholarSky(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  opts?: { forTeacher?: boolean; liveCap?: number },
) {
  const forTeacher = opts?.forTeacher ?? false;
  const liveCap = opts?.liveCap ?? SEED_CONSIDERATION_CAP;
  // `active` gets a WIDER read window than `pending` (see
  // ACTIVE_SEED_READ_LIMIT): it's the anchored status, so a newest-N truncation
  // there would drop the oldest teacher pins / kept keepsakes out of the sky
  // entirely rather than merely out of the at-rest set. Merged and re-sorted
  // newest-first so `liveRows` keeps the exact ordering semantics of a single
  // multi-status read.
  const [activeRows, pendingRows] = await Promise.all([
    recentSeedsForScholarByStatus(
      ctx,
      scholarId,
      ["active"],
      ACTIVE_SEED_READ_LIMIT,
    ),
    recentSeedsForScholarByStatus(ctx, scholarId, ["pending"], SEED_READ_LIMIT),
  ]);
  const liveRows = [...activeRows, ...pendingRows].sort(
    (a, b) => b._creationTime - a._creationTime,
  );
  const completedRows = await recentSeedsForScholarByStatus(ctx, scholarId, [
    "completed",
  ]);

  // "Where you've been" signal: a seed the scholar has actually flown to spawns
  // a session stamped with its seedId. Fold this scholar's sessions into a
  // per-seed visit tally (count = returns, lastAt = most recent) without an
  // N+1 per star.
  const sessions = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .collect();
  const visits = new Map<string, { count: number; lastAt: number }>();
  for (const s of sessions) {
    if (!s.seedId) continue;
    const key = String(s.seedId);
    const prev = visits.get(key);
    const at = s._creationTime;
    if (prev) {
      prev.count += 1;
      if (at > prev.lastAt) prev.lastAt = at;
    } else {
      visits.set(key, { count: 1, lastAt: at });
    }
  }

  // Live seeds are capped at SEED_CONSIDERATION_CAP to keep the at-rest sky a
  // readable handful. But a pure newest-first slice silently EVICTS a star the
  // scholar deliberately kept once enough fresh suggestions arrive: a saved
  // story/keepsake or a teacher-pinned star (status "active"), or a star the
  // scholar already flew to (a session stamped with its seedId → `visited`).
  // Those must outrank fresh suggestions for the scarce at-rest slots (pilot9
  // J8c) — but they do NOT outrank the CAP itself. Anchored stars accrue
  // without bound (a story-moment souvenir mints one per curated story edge),
  // so keeping them "in full past the cap" made this function return
  // max(liveCap, anchored) rows: it silently exceeded its own budget and
  // starved every fresh invitation of a slot. Overflow is not dropped — it
  // just isn't lit at rest; the sky map still renders it on zoom.
  const liveNonDismissed = liveRows.filter((s) => s.status !== "dismissed");
  const isAnchoredSeed = (s: (typeof liveNonDismissed)[number]) =>
    s.status === "active" || visits.has(String(s._id));
  const anchoredLive = liveNonDismissed.filter(isAnchoredSeed);
  const freshLive = liveNonDismissed.filter((s) => !isAnchoredSeed(s));
  // Anchored first, then fresh fills whatever the cap has left — both ranked by
  // the SAME shared ranker the sky map uses (lib/skySeedSelection), so one
  // ranker owns "which invitations are lit at rest" on every surface. The two
  // partitions are ranked INDEPENDENTLY, so the fresh partition's domain/anchor
  // diversity counters don't see the anchored domains — an accepted, deliberate
  // simplification that keeps the anchored-beats-fresh precedence exact.
  // When liveCap >= liveNonDismissed.length both selections return everything,
  // so the newest-first re-sort below reproduces the input order exactly — an
  // identity transform for the wide-cap caller (concepts.skyFieldForScholar
  // derives its own recencyRank from this array's INDEX, so order is load-bearing).
  const anchoredRanked = selectSkySeedCandidates(
    toSkySeedCandidates(anchoredLive),
    liveCap,
  );
  const freshRanked = selectSkySeedCandidates(
    toSkySeedCandidates(freshLive),
    Math.max(0, liveCap - anchoredRanked.length),
  );
  const cappedLive = [...anchoredRanked, ...freshRanked]
    .map((candidate) => candidate.seed)
    .sort((a, b) => b._creationTime - a._creationTime);

  const rows = [
    ...cappedLive,
    ...completedRows.filter((s) => s.status === "completed"),
  ];

  return rows
    .filter((s) => s.status !== "dismissed")
    .map((s) => {
      const v = visits.get(String(s._id));
      const visited = !!v;
      const completed = s.status === "completed";
      // What the kid actually reads: the scholar-facing invitation, falling
      // back to the rationale only when no invitation exists yet (older
      // observer seeds, teacher seeds authored before the two-field split).
      const blurb = s.scholarInvitation ?? s.rationale;
      return {
        _id: s._id,
        // A real teacher/AI-suggested invitation — distinguishes this star
        // from the mastery/starter layers blended in by `buildScholarSkyView`
        // below (see convex/lib/skyMuseum.ts), which are display-only.
        kind: "seed" as const,
        topic: cleanSeedLabel(s.topic),
        domain: s.domain ?? "general",
        // Scholar-safe text — present for both viewers.
        blurb,
        // Teacher-only diagnostic fields — null in the scholar's payload so
        // the redaction boundary holds at the wire, not just in the UI.
        rationale: forTeacher ? s.rationale : null,
        scholarInvitation: forTeacher ? (s.scholarInvitation ?? null) : null,
        origin: forTeacher ? s.origin : null,
        connectionTo: s.connectionTo,
        suggestionType: s.suggestionType,
        sourceLens: s.sourceLens,
        reach: s.reach,
        // A cross-domain on-ramp's practice-drill target (e.g.
        // "fraction-arithmetic") — the star's "practice this" invitation routes
        // here, overriding the display-domain allowlist. Scholar-safe (a domain
        // slug, no diagnostic content), so present for both viewers.
        practiceDomain: s.practiceDomain ?? null,
        // teacher-pinned vs AI-suggested — lets the sky badge a pinned star.
        pinned: s.status === "active",
        // Scholar-safe curation signal used by the atlas consideration ranker.
        // Unlike `pinned`, this means a teacher actually touched the seed.
        curated: !!s.teacherId,
        status: s.status,
        completed,
        completedAt: s.completedAt ?? null,
        // A structured destination (the star points at a real unit) — the sky
        // badges it with a "guided path" marker; opting in starts it.
        structured: !!s.unitId,
        // Remembered Sky layer:
        visited,
        visitCount: v?.count ?? (visited ? 1 : 0),
        lastVisitedAt: v?.lastAt ?? null,
      };
    });
}

/**
 * The scholar's FULL sky view: the seed/invitation stars above, PLUS the two
 * night-museum layers (see convex/lib/skyMuseum.ts) — the scholar's own
 * demonstrated-fluent practice skills as a lit constellation, and (only when
 * the real sky is still nearly empty) a warm cold-start layer so a brand-new
 * scholar's first look isn't an empty void. Scholar-facing only (`skyForSelf`)
 * — the teacher's curation twin (`skyForScholar`) stays on the plain seed
 * array: there's nothing to pin/dismiss on a display-only mastery or starter
 * star.
 */
export async function buildScholarSkyView(ctx: QueryCtx, scholarId: Id<"users">) {
  const seeds = await buildScholarSky(ctx, scholarId);
  const mastery = await buildMasteryStars(ctx, scholarId);
  const starter =
    seeds.length < SKY_COLD_START_MIN_STARS
      ? await buildStarterLayer(ctx, scholarId)
      : [];
  return { seeds, mastery, starter };
}
