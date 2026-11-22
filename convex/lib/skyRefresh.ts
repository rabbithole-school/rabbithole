// Keeping one kid's Sky up to date (TRA-699), event by event. The mutations
// that already write a star's source call in here: asking a wonder
// (wonders.ask), the kid's turns in a seed chat or in their own Quest
// (sessions.sendMessage), a Quest approved or an offer started
// (questProposals.ts), and a Quest shown (questShowing.ts, and an older
// Quest's badge in badgeAward.ts / badges.ts). Never the tutor's streaming
// path, and never a sweep: one kid at a time. Every call site runs its hook
// through `runSkyHook`, so nothing here can fail the write it rides on.
//
// A trigger adds the star's row when its source qualifies (lib/skySources.ts)
// and schedules the per-kid refresh (skyStars.refreshForScholar), which embeds
// and places it. One run per kid at a time, without a lock table. `queuedAt`
// on a waiting row is set only when a run was actually scheduled for it (by a
// trigger, by the refresh rescheduling itself in skyStars.storePositions) or
// is placing it (rows the refresh adds itself, skyStars.addStars). A run is
// pending while some waiting row was queued within SKY_REFRESH_STALE_MS; a
// trigger schedules only when none was (none waiting, or the run died), and
// stamps the row it schedules for. A row added while a run is pending, or one
// whose scheduling failed, stays unqueued: it never postpones recovery.
//
// Per-turn cost (sendMessage): a plain chat and a teacher's unit read
// nothing; a seed chat or the kid's own Quest reads its one star by index and
// stops there once the star exists. Only a source with no star yet is
// checked further, once.

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { ROLES } from "./roles";
import { tidySkyLabel } from "./skyLabel";
import {
  isScholarWrittenText,
  questQualifiesWritingIn,
  questStarSource,
  seedQualifiesWritingIn,
  seedStarText,
  SKY_STAR_MAX,
  skySchoolId,
  wonderStarSource,
  type SkyStarSourceRef,
} from "./skySources";

/** How long after a trigger the refresh runs: long enough for the rest of a
 *  burst (a wonder, then its first turn) to land in the same run. */
export const SKY_REFRESH_DELAY_MS = 5_000;
/** A waiting row queued this long ago means its run died. */
export const SKY_REFRESH_STALE_MS = 10 * 60_000;

type SkySource = { seedId: Id<"seeds"> } | { unitId: Id<"units"> };
type WaitingFields = Pick<Doc<"skyStars">, "hidden" | "x" | "queuedAt">;

/** A row the refresh still has to place. */
export function isWaitingStar(row: Pick<Doc<"skyStars">, "hidden" | "x">): boolean {
  return row.hidden !== true && row.x === undefined;
}

/** A waiting row a run was scheduled for within the stale window. */
function hasRunPending(row: WaitingFields, now: number): boolean {
  return (
    isWaitingStar(row) &&
    row.queuedAt !== undefined &&
    now - row.queuedAt <= SKY_REFRESH_STALE_MS
  );
}

/** Should a trigger schedule a run, given the kid's rows? Yes unless some
 *  waiting row had a run scheduled within the stale window. Rows nobody
 *  scheduled a run for (no `queuedAt`) never count as a pending run. Pure:
 *  exported for tests. */
export function refreshIsDue(rows: readonly WaitingFields[], now: number): boolean {
  return !rows.some((row) => hasRunPending(row, now));
}

/**
 * Which of these sources the refresh adds a row for, in order, and how many it
 * can't because the kid's sky already holds SKY_STAR_MAX rows (hidden ones
 * count). A source that has a row is neither. The one cap rule: the refresh's
 * `skyStars.addStars` and the backfill's dry run (skyBackfill.ts) both use it.
 * Pure.
 */
export function planStarAdditions<S extends SkyStarSourceRef>(
  rows: readonly Pick<Doc<"skyStars">, "seedId" | "unitId">[],
  sources: readonly S[],
  cap: number = SKY_STAR_MAX,
): { add: S[]; capped: number } {
  const seeds = new Set(rows.map((row) => row.seedId).filter(Boolean));
  const units = new Set(rows.map((row) => row.unitId).filter(Boolean));
  const add: S[] = [];
  let capped = 0;
  let count = rows.length;
  for (const source of sources) {
    if ("seedId" in source ? seeds.has(source.seedId) : units.has(source.unitId)) continue;
    if (count >= cap) {
      capped++;
      continue;
    }
    add.push(source);
    count++;
  }
  return { add, capped };
}

/** One kid's rows, oldest first. Small documents: never the vectors. */
export async function skyStarRows(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
): Promise<Doc<"skyStars">[]> {
  const rows = await ctx.db
    .query("skyStars")
    .withIndex("by_scholar_seed", (q) => q.eq("scholarId", scholarId))
    .take(SKY_STAR_MAX + 1);
  // The index orders by source; a sky is placed and read oldest first.
  return rows.sort((a, b) => a._creationTime - b._creationTime);
}

/** This source's star, by index: one read. */
async function starFor(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
  source: SkySource,
): Promise<Doc<"skyStars"> | null> {
  return "seedId" in source
    ? await ctx.db
        .query("skyStars")
        .withIndex("by_scholar_seed", (q) =>
          q.eq("scholarId", scholarId).eq("seedId", source.seedId),
        )
        .first()
    : await ctx.db
        .query("skyStars")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", source.unitId),
        )
        .first();
}

export async function scheduleSkyRefresh(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  delayMs = SKY_REFRESH_DELAY_MS,
): Promise<void> {
  await ctx.scheduler.runAfter(delayMs, internal.skyStars.refreshForScholar, { scholarId });
}

/**
 * Run a Sky hook inside another write (a turn, a wonder, an approval) so that
 * nothing it does can fail that write: an error is logged once, by where it
 * happened and the error's name only (never the kid's words), and the write
 * goes on. A star missed this way is added by the kid's next refresh.
 */
export async function runSkyHook(where: string, hook: () => Promise<void>): Promise<void> {
  try {
    await hook();
  } catch (error) {
    console.error(
      `Sky star hook failed in ${where}; the write it rode on was kept.`,
      error instanceof Error ? error.name : typeof error,
    );
  }
}

/**
 * A source of this kid's may have just earned a star. When its star exists,
 * stop (rescheduling only a run that died). Otherwise add the row if the
 * source qualifies, and schedule the kid's refresh when one is due.
 * `writingIn` is the chat the kid is writing in right now, when that is the
 * trigger: the turn itself is their writing, so no message is read.
 */
export async function noteSkyStar(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  source: SkySource,
  writingIn?: { chat: Doc<"sessions">; unit?: Doc<"units"> | null },
): Promise<void> {
  const now = Date.now();
  const star = await starFor(ctx, scholarId, source);
  if (star) {
    // Placed, or waiting on a run scheduled for it: nothing to do.
    if (!isWaitingStar(star) || hasRunPending(star, now)) return;
    // Waiting with no live run of its own (its run died, or none was
    // scheduled for it): schedule one unless another row's run is pending,
    // and mark this row only once that run is scheduled.
    if (refreshIsDue(await skyStarRows(ctx, scholarId), now)) {
      await scheduleSkyRefresh(ctx, scholarId);
      await ctx.db.patch(star._id, { queuedAt: now });
    }
    return;
  }

  let text: string | null = null;
  if ("seedId" in source) {
    const seed = await ctx.db.get(source.seedId);
    if (!seed || seed.scholarId !== scholarId) return;
    const schoolId = await skySchoolId(ctx, scholarId);
    const qualifies = writingIn
      ? seedQualifiesWritingIn(seed, writingIn.chat, scholarId, schoolId)
      : (await wonderStarSource(ctx, scholarId, schoolId, seed)) !== null;
    if (qualifies) text = seedStarText(seed);
  } else {
    const unit = writingIn?.unit ?? (await ctx.db.get(source.unitId));
    if (!unit || unit._id !== source.unitId || unit.authorScholarId !== scholarId) return;
    const schoolId = await skySchoolId(ctx, scholarId);
    const qualifies = writingIn
      ? questQualifiesWritingIn(unit, writingIn.chat, scholarId, schoolId)
      : (await questStarSource(ctx, scholarId, schoolId, unit)) !== null;
    if (qualifies) text = unit.title;
  }
  if (text === null) return;

  const rows = await skyStarRows(ctx, scholarId);
  if (rows.length >= SKY_STAR_MAX) return;
  const { label, hidden } = tidySkyLabel(text);
  const starId = await ctx.db.insert("skyStars", {
    scholarId,
    ...("seedId" in source ? { seedId: source.seedId } : { unitId: source.unitId }),
    label,
    ...(hidden ? { hidden: true } : {}),
  });
  // Queued only once a run is really scheduled for it: a row added while
  // another run is pending, or one whose scheduling threw (runSkyHook keeps
  // the row), stays unqueued and never holds back the next trigger.
  if (!hidden && refreshIsDue(rows, now)) {
    await scheduleSkyRefresh(ctx, scholarId);
    await ctx.db.patch(starId, { queuedAt: now });
  }
}

/** Is this user still there, and still a scholar? A refresh rechecks it
 *  before every write, so a deletion mid-run is never undone. */
export async function isLiveScholar(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
): Promise<boolean> {
  const user = await ctx.db.get(scholarId);
  return user !== null && user.role === ROLES.SCHOLAR;
}

/** Does this star's source still exist and still belong to the kid? */
export async function starSourceIsTheirs(
  ctx: Pick<QueryCtx, "db">,
  scholarId: Id<"users">,
  source: { seedId?: Id<"seeds">; unitId?: Id<"units"> },
): Promise<boolean> {
  if (source.seedId) return (await ctx.db.get(source.seedId))?.scholarId === scholarId;
  if (source.unitId) return (await ctx.db.get(source.unitId))?.authorScholarId === scholarId;
  return false;
}

/**
 * A user turn just saved in `session`, with its words: when the kid sent it
 * themselves in a seed chat or one of their own Quests, that source may have
 * earned a star. `unit` is the session's unit as the turn's save read it.
 * A plain chat or a teacher's unit reads nothing here.
 */
export async function noteSkyTurn(
  ctx: MutationCtx,
  args: {
    session: Doc<"sessions">;
    sender: Doc<"users">;
    unit: Doc<"units"> | null;
    turn: { content: string; inputModality?: string | null };
  },
): Promise<void> {
  const { session, sender, unit, turn } = args;
  if (sender._id !== session.userId || sender.role !== ROLES.SCHOLAR) return;
  if (session.isTestDrive || session.isOffline || !isScholarWrittenText(turn)) return;
  const writingIn = { chat: session, unit };
  if (session.seedId) {
    await noteSkyStar(ctx, session.userId, { seedId: session.seedId }, writingIn);
  }
  if (unit && unit._id === session.unitId && unit.authorScholarId === session.userId) {
    await noteSkyStar(ctx, session.userId, { unitId: unit._id }, writingIn);
  }
}
