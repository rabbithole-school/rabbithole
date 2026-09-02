/**
 * Tune-up checkpoint (§4B, "B") — the offer + record backend.
 *
 * A tune-up is an offer-based, untimed, UNSCORED mixed-topic retention check
 * that audits fluent skills (especially INFERRED credit — placement / valve /
 * re-probe — never independently demonstrated). It reuses the ENTIRE existing
 * serve/grade path: the client accepts an offer, then drives the ordinary
 * `practiceSkills.practiceSession({ skillKeys, size, seed })` /
 * `practiceSkills.submitAnswer(..., record: true)` loop. This file only owns the
 * trigger decision (`offerForScholar`) and the durable record (`start` /
 * `complete`) — never a new serve or grade path.
 *
 * The eligibility + sampling algorithm is the pure `lib/practice/tuneup.ts`.
 * Reads are teacher/admin-facing on the record itself; the OFFER is scholar-or-
 * teacher (a scholar sees their own offer, never their history). No score, no
 * streak, no nag ever reaches the scholar.
 */

import { v } from "convex/values";
import { authedQuery, authedMutation } from "./lib/customFunctions";
import { requireTeacherOrSelf } from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { WHOLE_NUMBER_ARITHMETIC_DOMAIN } from "./seed/wholeNumberArithmeticGraph";
import {
  countEligibleForTuneup,
  pickTuneupSample,
  TUNEUP_MIN_POOL,
  TUNEUP_INTERVAL_DAYS,
  type TuneupCandidate,
} from "./lib/practice/tuneup";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";

const DAY = 86_400_000;

/** Mastery rows for one scholar in one domain (the tune-up candidate pool). */
async function loadMasteryForDomain(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  domain: string,
): Promise<Doc<"practiceMastery">[]> {
  const rows = await ctx.db
    .query("practiceMastery")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  return rows.filter((r) => r.domain === domain);
}

/** The most recent tune-up this scholar STARTED in this domain, or null. */
async function latestTuneup(
  ctx: QueryCtx,
  scholarId: Id<"users">,
  domain: string,
): Promise<Doc<"practiceTuneups"> | null> {
  const rows = await ctx.db
    .query("practiceTuneups")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  let latest: Doc<"practiceTuneups"> | null = null;
  for (const r of rows) {
    if (r.domain !== domain) continue;
    if (latest === null || r.startedAt > latest.startedAt) latest = r;
  }
  return latest;
}

/** True while a tune-up started within `TUNEUP_INTERVAL_DAYS` blocks a new one. */
function withinInterval(latest: Doc<"practiceTuneups"> | null, now: number): boolean {
  return latest !== null && now - latest.startedAt < TUNEUP_INTERVAL_DAYS * DAY;
}

const toCandidate = (r: Doc<"practiceMastery">): TuneupCandidate => ({
  skillKey: r.skillKey,
  repetition: r.repetition,
  source: r.source,
  lastPracticedAt: r.lastPracticedAt,
  lastImplicitAt: r.lastImplicitAt,
});

/**
 * Whether to offer a tune-up now, and if so which skills. Returns `null` when
 * the interval hasn't elapsed or the eligible pool is below `TUNEUP_MIN_POOL`;
 * otherwise `{ skillKeys, count }` (the deterministic top-`TUNEUP_SIZE` sample).
 * Every trigger condition is evaluated SERVER-side — the client never decides.
 */
export const offerForScholar = authedQuery({
  args: { scholarId: v.id("users"), domain: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const now = Date.now();

    if (withinInterval(await latestTuneup(ctx, args.scholarId, domain), now)) return null;

    const candidates = (await loadMasteryForDomain(ctx, args.scholarId, domain)).map(toCandidate);
    if (countEligibleForTuneup(candidates, now) < TUNEUP_MIN_POOL) return null;

    const skillKeys = pickTuneupSample(candidates, now);
    return { skillKeys, count: skillKeys.length };
  },
});

/**
 * Record a tune-up the scholar just ACCEPTED (never on offer). Re-validates the
 * interval server-side — the client's offer is never trusted — and inserts the
 * row. Returns `{ tuneupId }` for the completion patch.
 */
export const start = authedMutation({
  args: {
    scholarId: v.id("users"),
    domain: v.optional(v.string()),
    skillKeys: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const isTeacher = requireTeacherOrSelf(ctx.user, args.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const domain = args.domain ?? WHOLE_NUMBER_ARITHMETIC_DOMAIN;
    const now = Date.now();

    if (withinInterval(await latestTuneup(ctx, args.scholarId, domain), now)) {
      throw new Error("A tune-up was already started recently");
    }
    if (args.skillKeys.length === 0) throw new Error("A tune-up needs at least one skill");

    const tuneupId = await ctx.db.insert("practiceTuneups", {
      scholarId: args.scholarId,
      domain,
      skillKeys: args.skillKeys,
      startedAt: now,
      total: args.skillKeys.length,
    });
    return { tuneupId };
  },
});

/**
 * Patch a tune-up's completion. Owner-or-teacher gated and idempotent — a second
 * call (already has `completedAt`) is a no-op, so a double-fire on the client
 * can't overwrite the first result.
 */
export const complete = authedMutation({
  args: { tuneupId: v.id("practiceTuneups"), correctCount: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.tuneupId);
    if (!row) throw new Error("Tune-up not found");
    const isTeacher = requireTeacherOrSelf(ctx.user, row.scholarId);
    if (isTeacher) await requireActiveScholarAccess(ctx, ctx.user, row.scholarId);

    if (row.completedAt !== undefined) return; // idempotent — first completion wins
    // Defend the instrumentation: a scholar can only touch their own record, but
    // clamp anyway so a bad client value can't record a nonsensical score.
    const capped = Math.max(0, Math.min(Math.round(args.correctCount), row.total));
    await ctx.db.patch(args.tuneupId, {
      completedAt: Date.now(),
      correctCount: capped,
    });
  },
});
