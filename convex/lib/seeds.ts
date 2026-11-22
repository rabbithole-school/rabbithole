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
import { cleanSeedLabel, seedScholarText } from "./seedLabel";
import { questOnlineProgressForScholar } from "./scholarReads";
import { SEED_CONSIDERATION_CAP, SKY_COLD_START_MIN_STARS } from "../../shared/skyTiers";
import { buildMasteryStars, buildStarterLayer } from "./skyMuseum";
import { selectSkySeedCandidates, type SkySeedCandidate } from "./skySeedSelection";
import { assertProposalIsOpen, assertProposedQuestIsOwn } from "./questStructure";

// ─── The three closed enums (DEC 3 / F3 — were unconstrained v.string()) ───

/** Who proposed the seed. */
export const seedOriginValidator = v.union(
  v.literal("ai"), // the live observer
  v.literal("ai-constellation"), // the Interpretive sky generator
  v.literal("dev-sky"), // dev-only demo constellation
  v.literal("teacher"), // a teacher/aide hand-planted it (incl. unit offers)
  v.literal("badge_follow"), // a "follow this trail" fork off a peer's badge
  v.literal("story"), // a scholar-minted world-connection story souvenir (Moments)
  v.literal("parked"), // "Make it a Quest" from an idea the tutor saved for later (TRA-519 B2)
  // The scholar's own question, typed into the "I wonder…" box (TRA-669). It
  // reaches scholar clients ONLY through convex/wonders.ts: every older seed
  // read leaves it out (isWonderSeed), because installed BunnyPad builds have
  // never seen the value.
  v.literal("wonder"),
  // A question about the world the scholar asked while building, saved by
  // the builder or the tutor to ask later (TRA-682): a starter in "Things to
  // wonder about", "Saved while building <Quest>". A build idea stays in the
  // session's parking lot instead; a `parked` seed is one the scholar made a
  // Quest from.
  v.literal("saved_question"),
  // One next question or thing to try the tutor saved from the scholar's own
  // Quest (TRA-682): a starter, "From your <Quest> Quest". It replaces the
  // tutor planning more lessons and activities inside the Quest.
  v.literal("follow_up"),
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

/** The `dismissedReason` a scholar's own dismiss from Scholar's Prep leaves
 *  (seeds.dismissForSelf), so a teacher reading the seed can tell it from a
 *  teacher's hide (which also stamps `teacherId`). */
export const SCHOLAR_DISMISSED_REASON = "Dismissed by the scholar";

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
  | "story"
  | "parked"
  | "wonder"
  | "saved_question"
  | "follow_up";
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

/**
 * Where a wonder was asked (TRA-669), for its row's meta line ("Asked on
 * Quests", "Asked on Scholar's Prep", "Asked while building …"). Only on
 * origin "wonder" seeds, so only wonders.ts ever returns it. `build` carries
 * the unit the scholar was building in (questions asked mid-build arrive with
 * the Quests rebuild's next starters PR).
 */
export const wonderAskedOnValidator = v.union(
  v.object({ surface: v.literal("quests") }),
  v.object({ surface: v.literal("prep") }),
  v.object({ surface: v.literal("build"), unitId: v.id("units") }),
);
export type WonderAskedOn =
  | { surface: "quests" }
  | { surface: "prep" }
  | { surface: "build"; unitId: Id<"units"> };

export const OBSERVER_SEED_CAP = 24;
const OBSERVER_DEDUP_LOOKBACK = 60;
export const SEED_READ_LIMIT = 60;

/**
 * A WIDER read bound, used only for `active` seeds in `liveSeedsForScholar`
 * (the sky, the seed list, and the agent reads). `active` is the anchored
 * status — teacher pins and scholar-kept keepsakes live there, and a
 * story-moment souvenir mints one per curated story edge. A newest-N read on
 * that status would silently drop the OLDEST anchors (the earliest teacher
 * pins) out of every seed view entirely. Bounded above by the curated story registry's size
 * plus curation headroom, so it stays a cheap, finite read. Since TRA-679 it
 * bounds the anchors only: the observer's live ideas are `active` too, and
 * read in their own LIVE_IDEA_READ_LIMIT budget (activeSeedsForScholar), so
 * they can never push an anchor out of this window.
 */
export const ACTIVE_SEED_READ_LIMIT = 120;

/** The observer's live ideas a live-seed read takes (activeSeedsForScholar):
 *  its prunable ideas stay at OBSERVER_SEED_CAP, so this is that cap plus the
 *  ones a kid has visited, with headroom. */
export const LIVE_IDEA_READ_LIMIT = SEED_READ_LIMIT;

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
export const SKY_FULL_LIVE_POOL =
  ACTIVE_SEED_READ_LIMIT + LIVE_IDEA_READ_LIMIT + SEED_READ_LIMIT;

type SeedDuplicateCandidate = Pick<
  Doc<"seeds">,
  "_id" | "_creationTime" | "domain" | "origin" | "status" | "topic" | "teacherId"
>;

/**
 * The observer's own pool (TRA-679): the ideas it wrote that no teacher has
 * pinned. Since TRA-679 the observer writes them live (`active`), with no
 * teacher on them; ideas written before that stay `pending`. A teacher's pin
 * (seeds.setStatus "active") stamps `teacherId` and takes an idea out of the
 * pool, as it always did. The pool is what the observer's dedupe, its
 * OBSERVER_SEED_CAP and its pruning act on, and nothing else: never a
 * teacher's, a Story's, a badge trail's, a parked idea's or a wonder's seed.
 * Pure.
 */
export function isObserverPoolSeed(
  seed: Pick<Doc<"seeds">, "origin" | "status" | "teacherId">,
): boolean {
  if (seed.origin !== "ai") return false;
  if (seed.status === "pending") return true;
  return seed.status === "active" && !seed.teacherId;
}

/**
 * Is this seed pinned on the map and the Sky? Pinned means anchored: a
 * teacher's pin or plant, or a keepsake the scholar kept (a Story, a badge
 * trail), all `active`. An observer idea is `active` because it is live, not
 * because anyone pinned it (isObserverPoolSeed), so it is not pinned. Before
 * TRA-679 this was `status === "active"`, and for every other seed it still
 * is. Pure.
 */
export function isPinnedSeed(
  seed: Pick<Doc<"seeds">, "origin" | "status" | "teacherId">,
): boolean {
  return seed.status === "active" && !isObserverPoolSeed(seed);
}

/**
 * Exact-topic duplicate in the observer's pool (isObserverPoolSeed): a pure
 * identity check. SEMANTIC dedup ("same thread, different wording") is the
 * observer's own job via `refreshesSeedId`: it sees its pool in its context
 * and declares the star it's refreshing. A word-overlap similarity heuristic used
 * to live here as well; it was removed when the observer-declared path landed
 * (the model reading the transcript beats a token-set intersection).
 */
export function selectDuplicateObserverSeed<T extends SeedDuplicateCandidate>(
  candidates: readonly T[],
  next: { topic: string },
  opts?: { visitedSeedIds?: Set<string> },
): T | null {
  return (
    candidates.find(
      (seed) =>
        isObserverPoolSeed(seed) &&
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

/** How many of each live status (`pending`, `active`) the observer's pool
 *  read takes, newest first, for pruning. The prunable part of the pool stays
 *  at OBSERVER_SEED_CAP (pruneObserverSeeds), so this only bounds how many
 *  protected ideas (visited, teacher-touched) ride along. */
const OBSERVER_POOL_READ_LIMIT = 200;

/**
 * The observer's pool (isObserverPoolSeed), newest first, read through the
 * live statuses only (`by_scholar_origin_status`: `ai` × `pending` and `ai` ×
 * `active`), never the kid's completed or dismissed history, each bounded by
 * `perStatusLimit`.
 */
async function observerPoolNewestFirst(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  perStatusLimit: number,
): Promise<Doc<"seeds">[]> {
  const byStatus = await Promise.all(
    (["pending", "active"] as const).map((status) =>
      ctx.db
        .query("seeds")
        .withIndex("by_scholar_origin_status", (q) =>
          q.eq("scholarId", scholarId).eq("origin", "ai").eq("status", status),
        )
        .order("desc")
        .take(perStatusLimit),
    ),
  );
  return byStatus
    .flat()
    .filter(isObserverPoolSeed)
    .sort((a, b) => b._creationTime - a._creationTime);
}

/**
 * Can the observer's rules still act on this idea? In its pool
 * (isObserverPoolSeed), not visited (no session stamped with it), and not
 * touched by a teacher. Visited and teacher-touched ideas are protected: they
 * are never pruned, never deduped or refreshed into, and never count toward
 * the cap.
 */
export function isPrunableObserverSeed(
  seed: Pick<Doc<"seeds">, "_id" | "origin" | "status" | "teacherId">,
  visitedSeedIds: ReadonlySet<string>,
): boolean {
  return (
    isObserverPoolSeed(seed) &&
    !seed.teacherId &&
    !visitedSeedIds.has(String(seed._id))
  );
}

/** The newest prunable ideas in the observer's pool (isPrunableObserverSeed),
 *  at most OBSERVER_SEED_CAP: its dedupe targets, which it also reads as
 *  context. Protected ideas are left out before the slice, so they can't
 *  crowd a real target out of it. */
export async function recentObserverSeedCandidates(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  visitedSeedIds?: ReadonlySet<string>,
) {
  const visited =
    visitedSeedIds ?? (await visitedSeedIdsForScholar(ctx, scholarId));
  return (await observerPoolNewestFirst(ctx, scholarId, OBSERVER_DEDUP_LOOKBACK))
    .filter((seed) => isPrunableObserverSeed(seed, visited))
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
  // The cap counts the observer's prunable ideas only
  // (isPrunableObserverSeed): its live ideas and any still pending from
  // before TRA-679, newest first, with visited and teacher-touched ones set
  // aside BEFORE the cap, so a protected idea never takes a slot an unvisited
  // one needs. Completed and dismissed seeds are never read here.
  const pool = await observerPoolNewestFirst(
    ctx,
    scholarId,
    OBSERVER_POOL_READ_LIMIT,
  );
  const visitedSeedIds =
    opts?.visitedSeedIds ?? (await visitedSeedIdsForScholar(ctx, scholarId));
  const prunable = pool.filter((seed) =>
    isPrunableObserverSeed(seed, visitedSeedIds),
  );
  const preserved = pool.length - prunable.length;
  if (prunable.length <= cap) {
    return { candidates: 0, deleted: 0, preserved };
  }

  let candidates = 0;
  let deleted = 0;
  for (const seed of prunable.slice(cap)) {
    candidates++;
    if (!opts?.dryRun) {
      await ctx.db.delete(seed._id);
      deleted++;
    }
  }
  return { candidates, deleted, preserved };
}

/**
 * A question the scholar typed into the "I wonder…" box (TRA-669). A wonder is
 * the scholar's own chat, not a suggestion made to them, so no seed read that
 * predates it may return one: not the Sky, the seed list, the question queue,
 * the done-screen cards, the tutor's or observer's seed sections, or the aide,
 * MCP and parent reads. Installed BunnyPad builds have never seen the value,
 * and a kid's own words must never come back to them as a suggestion. Wonders
 * reach clients only through convex/wonders.ts. Data-lifecycle code (cascade
 * delete, purge, clone) keeps them.
 */
export function isWonderSeed(seed: Pick<Doc<"seeds">, "origin">): boolean {
  return seed.origin === "wonder";
}

/** `rows` without the scholar's wonders (isWonderSeed), for reads that collect. */
export function withoutWonders<T extends Pick<Doc<"seeds">, "origin">>(
  rows: readonly T[],
): T[] {
  return rows.filter((seed) => !isWonderSeed(seed));
}

/**
 * Is this seed the wonder behind one of this scholar's chats: it exists, it
 * is theirs, and its origin is "wonder" (isWonderSeed)? Pure.
 */
export function isScholarsWonderSeed(
  seed: Pick<Doc<"seeds">, "origin" | "scholarId"> | null,
  scholarId: Id<"users">,
): boolean {
  return !!seed && seed.scholarId === scholarId && isWonderSeed(seed);
}

/**
 * Which of these sessions' seeds are the scholar's wonders, for telling a
 * wonder's chat from other sessions (`isWonderChat`). Starts from the
 * sessions a read is about to list, never from the scholar's whole wonder
 * history: each distinct `seedId` among them is read once. No cap, so an old
 * wonder's chat can never reappear as a Quest.
 */
export async function wonderSeedIdsAmong(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
  sessions: readonly Pick<Doc<"sessions">, "seedId">[],
): Promise<ReadonlySet<string>> {
  const seedIds = new Map<string, Id<"seeds">>();
  for (const session of sessions) {
    if (session.seedId) seedIds.set(String(session.seedId), session.seedId);
  }
  const wonderIds = new Set<string>();
  await Promise.all(
    [...seedIds].map(async ([key, seedId]) => {
      if (isScholarsWonderSeed(await ctx.db.get(seedId), scholarId)) {
        wonderIds.add(key);
      }
    }),
  );
  return wonderIds;
}

/**
 * Is this session a wonder's chat: one a wonder seed opened (TRA-678)? A
 * wonder is a chat and never a Quest, so the reads that list Quests (Home's
 * plate and its Archived list) leave these out. Pure.
 */
export function isWonderChat(
  session: Pick<Doc<"sessions">, "seedId">,
  wonderSeedIds: ReadonlySet<string>,
): boolean {
  return !!session.seedId && wonderSeedIds.has(String(session.seedId));
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
        // Before the bound, so a scholar's wonders (isWonderSeed) can never
        // crowd real seeds out of the newest-N window.
        .filter((q) => q.neq(q.field("origin"), "wonder"))
        .take(perStatusLimit),
    ),
  );
  return groups.flat().sort((a, b) => b._creationTime - a._creationTime);
}

/**
 * A scholar's `active` seeds, newest first, in two budgets so the observer's
 * live ideas can never push a pin out (TRA-679):
 *   - the anchors (every active seed but a live observer idea, isPinnedSeed):
 *     the newest ACTIVE_SEED_READ_LIMIT, wonders left out before the bound;
 *   - the observer's live ideas (`ai`, `active`, no teacher): the newest
 *     LIVE_IDEA_READ_LIMIT, through `by_scholar_origin_status`.
 * Every reader of a scholar's active seeds that shows or ranks them uses this:
 * liveSeedsForScholar (the Sky, the seed list, the parent and MCP reads) and
 * the question queue.
 */
export async function activeSeedsForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
) {
  const [anchors, liveIdeas] = await Promise.all([
    ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) =>
        q.eq("scholarId", scholarId).eq("status", "active"),
      )
      .order("desc")
      // Before the bound: a wonder (isWonderSeed) or a live observer idea
      // (isObserverPoolSeed: `ai` with no teacher) never takes an anchor's
      // place in the newest-N window.
      .filter((q) =>
        q.and(
          q.neq(q.field("origin"), "wonder"),
          q.or(
            q.neq(q.field("origin"), "ai"),
            q.neq(q.field("teacherId"), undefined),
          ),
        ),
      )
      .take(ACTIVE_SEED_READ_LIMIT),
    ctx.db
      .query("seeds")
      .withIndex("by_scholar_origin_status", (q) =>
        q.eq("scholarId", scholarId).eq("origin", "ai").eq("status", "active"),
      )
      .order("desc")
      .filter((q) => q.eq(q.field("teacherId"), undefined))
      .take(LIVE_IDEA_READ_LIMIT),
  ]);
  return [...anchors, ...liveIdeas].sort(
    (a, b) => b._creationTime - a._creationTime,
  );
}

/**
 * THE definition of a scholar's live seeds (`active` + `pending`), newest
 * first. Every reader that shows or hands "this scholar's current seeds" to
 * anyone — the staff/scholar seed list, the AI readers (`readScholarSeeds`),
 * and the sky — goes through here, so a person can never see fewer live seeds
 * than an agent does over the same rows (the Coherence rule
 * `seed_agent_visible_human_truncated` exists because two readers once bounded
 * them differently). `active` gets the wider window for the reason on
 * ACTIVE_SEED_READ_LIMIT, with the observer's live ideas in a budget of their
 * own (activeSeedsForScholar).
 */
export async function liveSeedsForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
) {
  const [activeRows, pendingRows] = await Promise.all([
    activeSeedsForScholar(ctx, scholarId),
    recentSeedsForScholarByStatus(ctx, scholarId, ["pending"], SEED_READ_LIMIT),
  ]);
  return [...activeRows, ...pendingRows].sort(
    (a, b) => b._creationTime - a._creationTime,
  );
}

/**
 * The seed list people read (`seeds.listByScholar`): every live seed, plus the
 * newest `SEED_READ_LIMIT` finished ones (`completed` / `dismissed`) as
 * history. History never competes with live seeds for room.
 */
export async function seedListForScholar(
  ctx: QueryCtx | MutationCtx,
  scholarId: Id<"users">,
) {
  const [liveRows, finishedRows] = await Promise.all([
    liveSeedsForScholar(ctx, scholarId),
    recentSeedsForScholarByStatus(ctx, scholarId, ["dismissed", "completed"]),
  ]);
  return [...liveRows, ...finishedRows.slice(0, SEED_READ_LIMIT)].sort(
    (a, b) => b._creationTime - a._creationTime,
  );
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
  askedOn?: WonderAskedOn;
};

/** The single seed insert — every plant-a-star path funnels through here. */
export async function insertSeed(
  ctx: MutationCtx,
  fields: InsertSeedFields,
): Promise<Id<"seeds">> {
  // No star, offer or badge trail points at a Quest proposal still waiting
  // for its yes (or declined): it has no activity to open (TRA-685).
  // And a proposed Quest is its proposer's: no star for anyone else points at
  // it (a badge trail, a teacher's offer). 5d turns following into the
  // follower's own proposal.
  if (fields.unitId) {
    const unit = await ctx.db.get(fields.unitId);
    assertProposalIsOpen(unit);
    assertProposedQuestIsOwn(unit, fields.scholarId);
  }
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
  ).find(
    (seed) =>
      !["dismissed", "completed"].includes(seed.status) && !isWonderSeed(seed),
  );
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
    // The trail copy ("Inspired by the … badge …") is written for the
    // scholar, so it is also their invitation.
    scholarInvitation: args.rationale,
    domain: args.domain,
    connectionTo: args.inspiredByName,
    unitId: args.unitId,
    teacherId: args.teacherId,
  });
  return { id, alreadyFollowing: false };
}

/**
 * "Make it a Quest" (TRA-519 B2) — plant a `parked` star from an idea the tutor
 * saved for later during an activity. The scholar's own act: `scholarId` is the
 * caller (no cross-scholar input). Idempotent per (scholar, topic): a second
 * call for the same idea returns the existing live star, so the done-screen
 * button re-opens it instead of cluttering the sky. `connectionTo` carries the
 * activity title (the bake reads it as "What sparked it").
 */
export async function plantParkedIdeaSeed(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    idea: string;
    activityTitle: string;
    sessionId: Id<"sessions">;
  },
): Promise<{ id: Id<"seeds">; existed: boolean }> {
  const existing = (
    await ctx.db
      .query("seeds")
      .withIndex("by_scholar_status", (q) => q.eq("scholarId", args.scholarId))
      .filter((q) => q.eq(q.field("topic"), args.idea))
      .collect()
  ).find(
    (seed) =>
      !["dismissed", "completed"].includes(seed.status) && !isWonderSeed(seed),
  );
  if (existing) return { id: existing._id, existed: true };
  const id = await insertSeed(ctx, {
    scholarId: args.scholarId,
    origin: "parked",
    status: "active",
    suggestionType: "extension",
    topic: args.idea,
    scholarInvitation: args.idea,
    rationale: `Saved for later during '${args.activityTitle}'; the scholar chose to make it a Quest.`,
    connectionTo: args.activityTitle,
    sessionId: args.sessionId,
  });
  return { id, existed: false };
}

/** The longest question a saved question or follow-up keeps (TRA-682). */
export const SAVED_STARTER_MAX_CHARS = 200;

/**
 * Save a starter for the scholar from a tutor or builder tool call (TRA-682):
 * a `saved_question` (a question about the world asked mid-build) or a
 * `follow_up` (a next question or thing to try from their own Quest). It is
 * live (`active`), with no teacher's review, since a starter is only a chat
 * (review/quests-rebuilt-proposal.html, "Starters"). The kid reads `text`
 * (`scholarInvitation`, through seedScholarText); `questTitle` is what its
 * meta line names ("Saved while building …", "From your … Quest"), kept in
 * `connectionTo`. Idempotent per (scholar, origin, text) among live seeds, so
 * a model that saves the same question twice saves it once. Returns null when
 * the text is empty.
 */
export async function plantSavedStarterSeed(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    origin: "saved_question" | "follow_up";
    text: string;
    questTitle: string;
    sessionId: Id<"sessions">;
  },
): Promise<{ id: Id<"seeds">; existed: boolean } | null> {
  const text = Array.from(args.text.replace(/\s+/g, " ").trim())
    .slice(0, SAVED_STARTER_MAX_CHARS)
    .join("")
    .trim();
  if (!text) return null;
  const existing = await ctx.db
    .query("seeds")
    .withIndex("by_scholar_origin", (q) =>
      q.eq("scholarId", args.scholarId).eq("origin", args.origin),
    )
    .filter((q) =>
      q.and(
        q.eq(q.field("topic"), text),
        q.neq(q.field("status"), "dismissed"),
        q.neq(q.field("status"), "completed"),
      ),
    )
    .first();
  if (existing) return { id: existing._id, existed: true };
  const questTitle = args.questTitle.replace(/\s+/g, " ").trim();
  const id = await insertSeed(ctx, {
    scholarId: args.scholarId,
    origin: args.origin,
    status: "active",
    suggestionType: args.origin === "follow_up" ? "extension" : "frontier",
    topic: text,
    scholarInvitation: text,
    rationale:
      args.origin === "follow_up"
        ? `A next step the tutor saved from the scholar's own Quest '${questTitle}'.`
        : `A question the scholar asked while building '${questTitle}', saved to ask later.`,
    ...(questTitle ? { connectionTo: questTitle } : {}),
    sessionId: args.sessionId,
  });
  return { id, existed: false };
}

/** The longest wonder the seed row keeps. The whole question still reaches the
 *  chat as its first message. */
export const WONDER_QUESTION_MAX_CHARS = 500;

/**
 * The scholar's own question from the "I wonder…" box (TRA-669), as a seed
 * with origin "wonder". The scholar's own act: `scholarId` is the caller.
 * Never deduped: asking the same thing twice is two chats. It carries no
 * `scholarInvitation` (it is not an invitation) and an empty `rationale`
 * (nobody wrote a note about it), so a reader that slipped past isWonderSeed
 * still has no text to show. `suggestionType` is the neutral "frontier": never
 * "cross_domain" (that holds the tutor Socratic, tutorStanceFor) and never
 * "leap" (that would put it on the Class Galaxy, lib/leapSeeds).
 */
export async function plantWonderSeed(
  ctx: MutationCtx,
  args: {
    scholarId: Id<"users">;
    question: string;
    askedOn?: WonderAskedOn;
  },
): Promise<Id<"seeds">> {
  return await insertSeed(ctx, {
    scholarId: args.scholarId,
    origin: "wonder",
    status: "active",
    suggestionType: "frontier",
    topic: args.question,
    rationale: "",
    ...(args.askedOn ? { askedOn: args.askedOn } : {}),
  });
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
    pinned: isPinnedSeed(seed),
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
 * So every star carries a scholar-safe `blurb` (`seedScholarText`, or an
 * empty string when there is none), and the raw `rationale` /
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
  const liveRows = await liveSeedsForScholar(ctx, scholarId);
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
    isPinnedSeed(s) || visits.has(String(s._id));
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
      // What the kid actually reads (seedScholarText owns the rule): the
      // scholar-facing invitation, and nothing for a seed whose only text is
      // a teacher-private rationale. Empty rather than null so the field
      // keeps its string type for older clients, which render no blurb for "".
      const blurb = seedScholarText(s) ?? "";
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
        // teacher-pinned vs AI-suggested — lets the sky badge a pinned star
        // (isPinnedSeed: a live observer idea is not pinned).
        pinned: isPinnedSeed(s),
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
