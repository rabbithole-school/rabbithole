/**
 * A kid's own Sky (TRA-699, review/quests-rebuilt-proposal.html "The Sky: a
 * kid's own wonders"): one star for each wonder they asked and each Quest
 * they made, placed by meaning so related ones sit together. Nothing on it is
 * a suggestion, and no number appears on it.
 *
 *   - `forSelf` is the read both clients draw (web and BunnyPad). It never
 *     reads a vector.
 *   - `refreshForScholar` brings one kid's stars up to date: rows for new
 *     sources, embeddings, positions. The triggers in lib/skyRefresh.ts
 *     schedule it; the one-time backfill of existing kids' first skies (8b)
 *     calls it per kid. Nothing here runs for every kid.
 *
 * The older `seeds.skyForSelf` read (suggestions, mastery and starter stars)
 * is untouched: installed BunnyPad builds still call it.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { authedQuery } from "./lib/customFunctions";
import { ROLES } from "./lib/roles";
import { embedTexts, requireEmbeddingKey } from "./lib/embeddings";
import { tidySkyLabel } from "./lib/skyLabel";
import {
  firstLayout,
  nearbySkyStars,
  placeNewStars,
  type SkyPoint,
} from "./lib/skyLayout";
import {
  collectStarSources,
  questStarSource,
  seedStarText,
  SKY_STAR_MAX,
  skySchoolId,
  wonderStarSource,
  MessageReadBudgetSpent,
  type MessageReadBudget,
  type QuestStarSource,
  type WonderStarSource,
} from "./lib/skySources";
import {
  isLiveScholar,
  isWaitingStar,
  planStarAdditions,
  skyStarRows,
  starSourceIsTheirs,
} from "./lib/skyRefresh";
import { firstReplyExcerptFor } from "./wonders";

// ─── The read ────────────────────────────────────────────────────────

export type SkyStar = {
  id: Id<"skyStars">;
  kind: "wonder" | "quest";
  label: string;
  /** Position in em (lib/skyLayout.ts): the dot, with the label under it. */
  x: number;
  y: number;
  /** A shown Quest: the one bright kind of star. */
  bright: boolean;
  /** A bright star's trail: the wonder it grew from, when that is a star. */
  trailFromStarId: Id<"skyStars"> | null;
  /** Up to three stars near this one on screen, nearest first. */
  nearby: Id<"skyStars">[];
  /** What a tap opens: the wonder's chat, or the Quest's page. */
  sessionId: Id<"sessions"> | null;
  unitId: Id<"units"> | null;
  /** The drawer for a wonder. */
  wonder: {
    askedAt: number;
    /** Where the box was, when that was recorded. */
    askedOn: "quests" | "prep" | "build" | null;
    /** The opening of Rabbithole's first answer, once there is one. */
    replyExcerpt: string | null;
  } | null;
  /** The drawer for a Quest. */
  quest: {
    kind: "app" | "slides" | "python" | null;
    mission: string | null;
    emoji: string | null;
    advisorName: string | null;
    shownAt: number | null;
    /** The badge it was shown with: its emoji, and its art once made. */
    badge: { icon: string | null; imageUrl: string | null } | null;
  } | null;
};

/** How many of the kid's earliest sessions are read to find their first
 *  real one (the same bound wonders.ts uses). */
const EARLIEST_SESSIONS_READ = 25;

/** The kid's first-ever real session: its first reply opens with the tutor's
 *  self-introduction, which an answer's opening skips (wonders.ts). */
async function firstRealSessionId(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Id<"sessions"> | null> {
  const earliest = await ctx.db
    .query("sessions")
    .withIndex("by_user", (q) => q.eq("userId", scholarId))
    .order("asc")
    .take(EARLIEST_SESSIONS_READ);
  return earliest.find((s) => !s.isTestDrive && !s.isOffline)?._id ?? null;
}

/** Only a scholar has a Sky of their own; anyone else's draws no stars. */
function hasOwnSky(user: Doc<"users">): boolean {
  return user.role === ROLES.SCHOLAR;
}

type DrawnSource =
  | { kind: "wonder"; source: WonderStarSource }
  | { kind: "quest"; source: QuestStarSource };

/** A row the Sky could draw at all: unhidden and placed. Needs no read. */
function isShownAndPlaced(row: Doc<"skyStars">): boolean {
  return row.hidden !== true && row.x !== undefined && row.y !== undefined;
}

/**
 * Which of a kid's rows their Sky draws: an unhidden, placed row whose source
 * still earns them a star (lib/skySources.ts). Returns that source, or null
 * when the Sky leaves the row out (the row itself stays). The one rule
 * `skyForScholar` draws by and `skyHasStar` (the Sky's unlock, mapGates.ts)
 * reads. A `budget` caps the messages the source checks read; a row that
 * fails before any message is read (hidden, unplaced, another school's chat,
 * or a wonder, which needs none) spends none of it.
 */
async function drawnSource(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  schoolId: Id<"institutions"> | undefined,
  row: Doc<"skyStars">,
  budget?: MessageReadBudget,
): Promise<DrawnSource | null> {
  if (!isShownAndPlaced(row)) return null;
  if (row.seedId) {
    const seed = await ctx.db.get(row.seedId);
    const source = seed && (await wonderStarSource(ctx, scholarId, schoolId, seed, budget));
    return source ? { kind: "wonder", source } : null;
  }
  if (row.unitId) {
    const unit = await ctx.db.get(row.unitId);
    const source = unit && (await questStarSource(ctx, scholarId, schoolId, unit, budget));
    return source ? { kind: "quest", source } : null;
  }
  return null;
}

/**
 * One kid's Sky: their placed, unhidden stars whose source still qualifies
 * (`drawnSource`), each with its drawer, its trail and its nearby stars.
 * Reads the star rows and their sources, never `skyStarEmbeddings`.
 * Exported for tests.
 */
export async function skyForScholar(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<SkyStar[]> {
  const scholarId = scholar._id;
  const schoolId = await skySchoolId(ctx, scholarId);
  const rows = (await skyStarRows(ctx, scholarId)).slice(0, SKY_STAR_MAX);
  // Read once, and only when some chat has a reply to quote.
  let firstReal: Promise<Id<"sessions"> | null> | null = null;
  const isFirstEver = (chatId: Id<"sessions">) => async () => {
    firstReal ??= firstRealSessionId(ctx, scholarId);
    return (await firstReal) === chatId;
  };

  const stars: (Omit<SkyStar, "trailFromStarId" | "nearby"> & {
    trailSeedId: Id<"seeds"> | null;
  })[] = [];
  const starBySeed = new Map<Id<"seeds">, Id<"skyStars">>();

  for (const row of rows) {
    const drawn = await drawnSource(ctx, scholarId, schoolId, row);
    if (!drawn) continue;
    const base = { id: row._id, x: row.x!, y: row.y! };
    if (drawn.kind === "wonder") {
      const source = drawn.source;
      const seed = source.seed;
      starBySeed.set(seed._id, row._id);
      stars.push({
        ...base,
        kind: "wonder",
        label: row.label ?? tidySkyLabel(seedStarText(seed)).label,
        bright: false,
        trailSeedId: null,
        sessionId: source.chat._id,
        unitId: null,
        wonder: {
          askedAt: source.askedAt,
          askedOn: seed.origin === "wonder" ? (seed.askedOn?.surface ?? null) : null,
          replyExcerpt: await firstReplyExcerptFor(ctx, source.chat, isFirstEver(source.chat._id)),
        },
        quest: null,
      });
    } else {
      const source = drawn.source;
      const unit = source.unit;
      const approval = unit.questApproval;
      const advisor = approval?.advisorId ? await ctx.db.get(approval.advisorId) : null;
      const bright = source.shownAt !== null;
      // The wonder it grew from: the chat it was proposed from, else the seed
      // an older Quest was baked from.
      let trailSeedId: Id<"seeds"> | null = null;
      if (bright) {
        const fromChat = approval?.fromSessionId ? await ctx.db.get(approval.fromSessionId) : null;
        trailSeedId =
          (fromChat?.userId === scholarId ? fromChat.seedId : undefined) ??
          unit.bakedFromSeedId ??
          null;
      }
      const badge = source.badge;
      stars.push({
        ...base,
        kind: "quest",
        label: row.label ?? tidySkyLabel(unit.title).label,
        bright,
        trailSeedId,
        sessionId: null,
        unitId: unit._id,
        wonder: null,
        quest: {
          kind: approval?.kind ?? null,
          mission: unit.mission?.text?.trim() || null,
          emoji: unit.emoji ?? null,
          advisorName: advisor?.name?.trim() || null,
          shownAt: source.shownAt,
          badge: badge
            ? {
                icon: badge.badgeSnapshot.icon ?? null,
                imageUrl: badge.imageStorageId
                  ? await ctx.storage.getUrl(badge.imageStorageId)
                  : null,
              }
            : null,
        },
      });
    }
  }

  const near = nearbySkyStars(stars.map((s): SkyPoint => ({ x: s.x, y: s.y })));
  return stars.map(({ trailSeedId, ...star }, i) => ({
    ...star,
    trailFromStarId: trailSeedId ? (starBySeed.get(trailSeedId) ?? null) : null,
    nearby: near[i].map((j) => stars[j].id),
  }));
}

/**
 * The signed-in kid's own Sky (see `skyForScholar`). Takes no scholar id;
 * anyone but a scholar gets no stars. Reads no clock (T11).
 */
export const forSelf = authedQuery({
  args: {},
  handler: async (ctx): Promise<SkyStar[]> => {
    if (!hasOwnSky(ctx.user)) return [];
    return await skyForScholar(ctx, ctx.user);
  },
});

/**
 * What one Sky unlock check (`skyHasStar`) may read. Home asks on every
 * load, and ruling out a row whose older seed or Quest stopped qualifying can
 * take ten chats of up to 500 user turns each (lib/skySources.ts), so the
 * check stops at these limits and stays inside Convex's per-transaction
 * limits (32,000 documents, 4,096 index ranges and gets, 16 MiB read):
 *
 *   - The kid's rows: one range, at most SKY_STAR_MAX (400) documents.
 *     Hidden and unplaced rows stop there and cost nothing more.
 *   - Per placed, shown row, at most 13 ranges and 12 documents besides
 *     messages: its seed or unit (1 get), a Quest's badge (1), its chats
 *     (1 range, up to 10 documents) and each chat's turns (1 range each, up
 *     to 10). Only 100 such rows are checked: at most 1,300 ranges and
 *     about 1,300 sources, sessions and badges, bounded by count alone.
 *   - Messages, bounded by count and by bytes: at most 4,000 documents, and
 *     at most 6 MiB by `messageBytes` (lib/skySources.ts) plus the one
 *     message that crosses the line (a Convex document is at most 1 MiB).
 *
 * With the school and Tree/reveal reads of mapGates.mine, that is about
 * 5,610 documents and 1,310 ranges at worst. Messages take at most 7 MiB of
 * the 16; the other documents are not measured, and stay under the rest
 * unless they average over about 5 KB each. TRA-711 (stamp a kid's first
 * turn on the chat) removes the message scan, and with it this budget.
 */
const UNLOCK_ROWS_CHECKED = 100;
const UNLOCK_MESSAGES_READ = 4_000;
const UNLOCK_MESSAGE_BYTES = 6 * 1024 * 1024;

/** What is left of one unlock check's reads: placed, shown rows sent
 *  through `drawnSource`, and messages read (count and bytes). */
type UnlockBudget = { rows: number; messages: MessageReadBudget };

/**
 * Does this user's own Sky draw at least one star? The same rule as
 * `forSelf` (a scholar's Sky only, and a row only when `drawnSource` draws
 * it), so the Sky's unlock (mapGates.ts) can't disagree with what the Sky
 * shows. Reads the kid's rows by index and stops at the first one drawn.
 * Both writers cap a kid's rows at SKY_STAR_MAX (lib/skyRefresh.ts), so
 * these are the rows `forSelf` reads.
 *
 * Reads stop at `budget` (the limits above unless a test passes its own).
 * Out of budget before the answer is known, the check calls the Sky
 * unlocked: if that is wrong, the "Your Map" door opens on a calm, empty Sky
 * that says how a first star arrives, where reading on would fail Home at
 * Convex's limits. Only a kid with more than 100 placed, shown rows none of
 * the first 100 of which is drawn, or whose placed rows all point at older
 * seeds or Quests that stopped qualifying behind long chats, gets there.
 */
export async function skyHasStar(
  ctx: QueryCtx,
  user: Doc<"users">,
  budget: UnlockBudget = {
    rows: UNLOCK_ROWS_CHECKED,
    messages: { left: UNLOCK_MESSAGES_READ, bytes: UNLOCK_MESSAGE_BYTES },
  },
): Promise<boolean> {
  if (!hasOwnSky(user)) return false;
  // Read only once the kid has a row worth checking.
  let schoolId: Promise<Id<"institutions"> | undefined> | null = null;
  try {
    for await (const row of ctx.db
      .query("skyStars")
      .withIndex("by_scholar_seed", (q) => q.eq("scholarId", user._id))) {
      // Hidden and unplaced rows are never drawn and cost no source read, so
      // they spend nothing.
      if (!isShownAndPlaced(row)) continue;
      if (budget.rows <= 0) return true; // more rows than one check reads
      budget.rows--;
      schoolId ??= skySchoolId(ctx, user._id);
      if (await drawnSource(ctx, user._id, await schoolId, row, budget.messages)) return true;
    }
  } catch (error) {
    if (error instanceof MessageReadBudgetSpent) return true;
    throw error;
  }
  return false;
}

// ─── The per-kid refresh ─────────────────────────────────────────────

/** Embeddings stored per mutation. */
const EMBEDDINGS_PER_WRITE = 32;
/** A run that fails or finds new rows waiting tries again this many times. */
const MAX_REFRESH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;

/** The kid's star sources today, as the refresh adds them. Null for anyone
 *  but a scholar. */
export const sourcesForRefresh = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return null;
    return await collectStarSources(ctx, scholarId);
  },
});

const sourceRefValidator = v.union(
  v.object({ seedId: v.id("seeds"), text: v.string() }),
  v.object({ unitId: v.id("units"), text: v.string() }),
);

/** Add a row for each source with none (label = the tidied text). Returns
 *  how many were added. The sources were read before this ran, so each is
 *  checked again here: nothing is written for a scholar who is gone (or no
 *  longer a scholar), or for a source deleted or no longer theirs. The run
 *  calling this places the rows it adds, so they are queued now. */
export const addStars = internalMutation({
  args: { scholarId: v.id("users"), sources: v.array(sourceRefValidator) },
  handler: async (ctx, { scholarId, sources }) => {
    if (!(await isLiveScholar(ctx, scholarId))) return 0;
    const rows = await skyStarRows(ctx, scholarId);
    // Recheck the sources with no row first, then apply the cap, so only
    // sources still valid compete for the sky's last slots.
    const valid = [];
    for (const source of planStarAdditions(rows, sources, Infinity).add) {
      if (await starSourceIsTheirs(ctx, scholarId, source)) valid.push(source);
    }
    const now = Date.now();
    let added = 0;
    for (const source of planStarAdditions(rows, valid).add) {
      const { label, hidden } = tidySkyLabel(source.text);
      await ctx.db.insert("skyStars", {
        scholarId,
        ...("seedId" in source ? { seedId: source.seedId } : { unitId: source.unitId }),
        label,
        ...(hidden ? { hidden: true } : { queuedAt: now }),
      });
      added++;
    }
    return added;
  },
});

/** The kid's unhidden stars with no embedding yet. */
export const starsToEmbed = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    const rows = await skyStarRows(ctx, scholarId);
    const todo: { starId: Id<"skyStars">; text: string }[] = [];
    for (const row of rows) {
      if (row.hidden || !row.label) continue;
      const embedded = await ctx.db
        .query("skyStarEmbeddings")
        .withIndex("by_star", (q) => q.eq("starId", row._id))
        .first();
      // A row whose source is gone gets no vector (storeEmbeddings): don't
      // send it to be embedded either.
      if (!embedded && (await starSourceIsTheirs(ctx, scholarId, row))) {
        todo.push({ starId: row._id, text: row.label });
      }
    }
    return todo;
  },
});

/** Store embeddings, one per star; a star that has one keeps it. */
export const storeEmbeddings = internalMutation({
  args: {
    rows: v.array(v.object({ starId: v.id("skyStars"), vector: v.array(v.float64()) })),
  },
  handler: async (ctx, { rows }) => {
    const live = new Map<Id<"users">, boolean>();
    for (const { starId, vector } of rows) {
      // Checked again at the write: the star, its kid and its source may have
      // been deleted since the run read them.
      const star = await ctx.db.get(starId);
      if (!star) continue;
      if (!live.has(star.scholarId)) {
        live.set(star.scholarId, await isLiveScholar(ctx, star.scholarId));
      }
      if (!live.get(star.scholarId)) continue;
      if (!(await starSourceIsTheirs(ctx, star.scholarId, star))) continue;
      const existing = await ctx.db
        .query("skyStarEmbeddings")
        .withIndex("by_star", (q) => q.eq("starId", starId))
        .first();
      if (!existing) {
        await ctx.db.insert("skyStarEmbeddings", { starId, scholarId: star.scholarId, vector });
      }
    }
  },
});

/** What placing needs: the placed stars (with their vectors, when they have
 *  one) and the unplaced, unhidden stars that have a vector, oldest first. */
export const layoutInputs = internalQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    const rows = await skyStarRows(ctx, scholarId);
    const vectors = new Map<Id<"skyStars">, number[]>();
    const embeddings = await ctx.db
      .query("skyStarEmbeddings")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .take(SKY_STAR_MAX + 1);
    for (const e of embeddings) vectors.set(e.starId, e.vector);
    const placed = [];
    const unplaced = [];
    for (const row of rows) {
      const label = row.label ?? "";
      if (row.x !== undefined && row.y !== undefined) {
        placed.push({ starId: row._id, x: row.x, y: row.y, label, vector: vectors.get(row._id) ?? null });
      } else if (!row.hidden && vectors.has(row._id)) {
        unplaced.push({ starId: row._id, label, vector: vectors.get(row._id)! });
      }
    }
    return { placed, unplaced };
  },
});

/** The kid's rows still to place whose source is still theirs (a row whose
 *  source was deleted waits for nothing). */
async function rowsStillWaiting(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  rows: readonly Doc<"skyStars">[],
): Promise<Doc<"skyStars">[]> {
  const waiting = [];
  for (const row of rows) {
    if (isWaitingStar(row) && (await starSourceIsTheirs(ctx, scholarId, row))) {
      waiting.push(row);
    }
  }
  return waiting;
}

/**
 * Schedule the kid's next run, and in the same mutation mark the rows it is
 * for as queued (lib/skyRefresh.ts): a trigger between now and that run sees
 * it pending and schedules no second one. Every run a run schedules for
 * itself (a retry after a failure, a rerun for rows that arrived) goes
 * through here.
 */
async function scheduleNextRun(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  args: { attempt: number; delayMs: number; waiting: readonly Doc<"skyStars">[] },
): Promise<void> {
  await ctx.scheduler.runAfter(args.delayMs, internal.skyStars.refreshForScholar, {
    scholarId,
    attempt: args.attempt,
  });
  const now = Date.now();
  for (const row of args.waiting) await ctx.db.patch(row._id, { queuedAt: now });
}

/**
 * Write the new stars' positions, if the sky is still the one they were
 * placed on (the same placed stars); otherwise write nothing and run again.
 * A position is written only where none is set, so two runs that ever
 * overlap can't place a star twice or move a placed one. Then, if a row is
 * still waiting (it arrived during the run), schedule the next run.
 */
export const storePositions = internalMutation({
  args: {
    scholarId: v.id("users"),
    placedIds: v.array(v.id("skyStars")),
    positions: v.array(v.object({ starId: v.id("skyStars"), x: v.number(), y: v.number() })),
    attempt: v.number(),
  },
  handler: async (ctx, { scholarId, placedIds, positions, attempt }) => {
    // A kid deleted mid-run (or no longer a scholar): write nothing, and
    // schedule nothing.
    if (!(await isLiveScholar(ctx, scholarId))) return 0;
    const rows = await skyStarRows(ctx, scholarId);
    const placedNow = rows.filter((row) => row.x !== undefined).map((row) => row._id);
    const unchanged =
      placedNow.length === placedIds.length && placedNow.every((id) => placedIds.includes(id));
    const writtenIds = new Set<Id<"skyStars">>();
    if (unchanged) {
      const byId = new Map(rows.map((row) => [row._id, row]));
      for (const { starId, x, y } of positions) {
        const row = byId.get(starId);
        if (!row || row.x !== undefined || row.y !== undefined) continue;
        if (!(await starSourceIsTheirs(ctx, scholarId, row))) continue;
        await ctx.db.patch(starId, { x, y, queuedAt: undefined });
        writtenIds.add(starId);
      }
    }
    const stillWaiting = (await rowsStillWaiting(ctx, scholarId, rows)).filter(
      (row) => !writtenIds.has(row._id),
    );
    if (stillWaiting.length && attempt + 1 < MAX_REFRESH_ATTEMPTS) {
      await scheduleNextRun(ctx, scholarId, {
        attempt: attempt + 1,
        delayMs: 0,
        waiting: stillWaiting,
      });
    }
    return writtenIds.size;
  },
});

/**
 * A run failed: schedule its retry after RETRY_DELAY_MS, marking the rows
 * still waiting as queued in this same mutation (`scheduleNextRun`), so a
 * trigger before the retry runs schedules nothing more. Nothing for a kid
 * who is gone, or past the last attempt. Returns whether a retry was
 * scheduled.
 */
export const scheduleRetry = internalMutation({
  args: { scholarId: v.id("users"), attempt: v.number() },
  handler: async (ctx, { scholarId, attempt }) => {
    if (attempt >= MAX_REFRESH_ATTEMPTS) return false;
    if (!(await isLiveScholar(ctx, scholarId))) return false;
    const waiting = await rowsStillWaiting(ctx, scholarId, await skyStarRows(ctx, scholarId));
    await scheduleNextRun(ctx, scholarId, { attempt, delayMs: RETRY_DELAY_MS, waiting });
    return true;
  },
});

/**
 * Bring one kid's Sky up to date: add rows for sources that newly qualify,
 * embed the rows with no vector, and place the unplaced ones (the first
 * layout when the kid has no star placed yet, else each new star beside its
 * closest sibling). Idempotent: a second run with nothing new changes
 * nothing. Bounded by SKY_STAR_MAX. Scheduled by the triggers
 * (lib/skyRefresh.ts) and called per kid by the backfill (8b).
 */
export const refreshForScholar = internalAction({
  args: { scholarId: v.id("users"), attempt: v.optional(v.number()) },
  handler: async (ctx, { scholarId, attempt = 0 }): Promise<SkyRefreshResult> =>
    await refreshScholarSky(ctx, scholarId, attempt),
});

export type SkyRefreshResult = {
  added: number;
  embedded: number;
  placed: number;
  layout: "first" | "new" | "none";
};

/** `refreshForScholar`'s work, callable from another action (the backfill,
 *  skyBackfill.ts) without a nested action call. */
export async function refreshScholarSky(
  ctx: ActionCtx,
  scholarId: Id<"users">,
  attempt = 0,
): Promise<SkyRefreshResult> {
  try {
    const sources = await ctx.runQuery(internal.skyStars.sourcesForRefresh, { scholarId });
    if (sources === null) return { added: 0, embedded: 0, placed: 0, layout: "none" };
    const added: number = await ctx.runMutation(internal.skyStars.addStars, {
      scholarId,
      sources,
    });

    const todo = await ctx.runQuery(internal.skyStars.starsToEmbed, { scholarId });
    if (todo.length) {
      const vectors = await embedTexts(
        todo.map((t) => t.text),
        requireEmbeddingKey(),
      );
      for (let i = 0; i < todo.length; i += EMBEDDINGS_PER_WRITE) {
        await ctx.runMutation(internal.skyStars.storeEmbeddings, {
          rows: todo
            .slice(i, i + EMBEDDINGS_PER_WRITE)
            .map((t, k) => ({ starId: t.starId, vector: vectors[i + k] })),
        });
      }
    }

    const { placed, unplaced } = await ctx.runQuery(internal.skyStars.layoutInputs, {
      scholarId,
    });
    if (unplaced.length === 0) {
      return { added, embedded: todo.length, placed: 0, layout: "none" };
    }
    const layout = placed.length === 0 ? "first" : "new";
    const points =
      layout === "first"
        ? firstLayout(unplaced)
        : placeNewStars(placed, unplaced);
    const written: number = await ctx.runMutation(internal.skyStars.storePositions, {
      scholarId,
      placedIds: placed.map((p) => p.starId),
      positions: unplaced.map((u, i) => ({ starId: u.starId, x: points[i].x, y: points[i].y })),
      attempt,
    });
    return { added, embedded: todo.length, placed: written, layout };
  } catch (error) {
    // The retry and its pending mark are written together (scheduleRetry).
    try {
      await ctx.runMutation(internal.skyStars.scheduleRetry, {
        scholarId,
        attempt: attempt + 1,
      });
    } catch {
      // The run's own error is the one to surface.
    }
    throw error;
  }
}
