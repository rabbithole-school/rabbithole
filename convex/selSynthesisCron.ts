/**
 * SEL synthesis generation — the scheduled batch behind the Thursday surface.
 *
 * Once a week, a few hours before each institution's SEL Rounds meeting, this
 * writes every enrolled scholar's synthesis so the write-ups are fresh the day
 * the room reads them (PR 4 of `rounds-two-cadence-plan.html`). The mechanics
 * mirror the Slack Rounds cue (`improvementLoopNotifications.ts`): one hourly
 * cron dispatcher that resolves institution-local meeting mornings and dedupes
 * with a durable per-(institution, week) marker.
 *
 * TWO deliberate differences from that cue:
 *   1. It is MULTI-TENANT. The SEL cadence is per-institution data, so every
 *      institution with an EXPLICITLY configured SEL cadence gets its batch —
 *      there is no primary-institution gate (unlike the Slack cue, which posts
 *      to one primary-school-owned channel). The batch generator and its AI-usage
 *      attribution (`recordAnthropicUsage`, per `institutionId`) are already
 *      per-institution.
 *   2. It computes an evidence WINDOW, not just a dedupe key: the model reads
 *      the week the meeting is reviewing.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import {
  dayKeyForTimezone,
  minuteOfDayForTimezone,
  weekdayForDayKey,
} from "../shared/institutionDay";
import {
  explicitRoundsCadencesFor,
  roundsWeekKey,
  roundsWeekWindow,
} from "../lib/roundsCadence";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";

/** The institution-local morning window a synthesis batch may run in — the same
 *  6am–12pm shape the Slack Rounds cue uses, so both fire the meeting-day
 *  morning ahead of an afternoon anchor. */
const SEL_SYNTHESIS_START_MINUTE = 6 * 60;
const SEL_SYNTHESIS_END_MINUTE = 12 * 60;

/**
 * How long a claim holds before the dispatcher may retry an unfinished run.
 *
 * Sized against the batch's worst case: `generateSelSynthesesForWeek` walks the
 * institution roster SEQUENTIALLY, one model call per scholar (~10s each), so
 * even a 60-scholar roster finishes in ~10 minutes — comfortably inside two
 * hours. The lease is the crash-recovery window, not the expected runtime; two
 * hours keeps a slow-but-live batch from being reclaimed and run a second time
 * (duplicate model spend + a racing second generation) while still recovering a
 * genuinely dead run by the next morning tick.
 */
const SEL_SYNTHESIS_CLAIM_LEASE_MS = 2 * 60 * 60 * 1000;

/**
 * Give up retrying a partially-failing institution after this many attempts.
 * At the cap the run is marked complete WITH its failure counts recorded, so
 * the hourly cron stops burning model calls on a persistently-failing roster;
 * the teacher-facing "Not written yet" + manual generate button is then the
 * recovery path for the stragglers.
 */
const SEL_SYNTHESIS_MAX_ATTEMPTS = 3;

type CandidateInstitution = Pick<
  Doc<"institutions">,
  | "_id"
  | "kind"
  | "disabledAt"
  | "timeZone"
  | "roundsAnchorWeekday"
  | "roundsAnchorMinutes"
  | "roundsCadences"
>;

export type SelSynthesisCandidate = {
  institutionId: Id<"institutions">;
  weekKey: string;
  window: { startMs: number; endMs: number };
};

/**
 * Every institution whose SEL Rounds meeting is LATER TODAY and whose local
 * clock is in the morning batch window.
 *
 * `weekKey`/`window` come from `roundsWeekKey(now)` under the SEL anchor: in the
 * meeting-day morning (before the afternoon anchor) that names the week that is
 * CLOSING at today's meeting, so the window is the evidence-rich week the room
 * is about to review — and it is exactly the key the board shows when opened
 * ahead of the anchor.
 */
export function selSynthesisCandidatesAt(
  institutions: CandidateInstitution[],
  now: number,
): SelSynthesisCandidate[] {
  const due: SelSynthesisCandidate[] = [];
  for (const institution of institutions) {
    // A suspended tenant runs nothing. Guest institutions have no SEL cadence
    // of their own (Extended Education is a separate context).
    if (institution.kind !== "school" || institution.disabledAt !== undefined) {
      continue;
    }
    const sel = explicitRoundsCadencesFor(institution).find(
      (cadence) => cadence.kind === "sel",
    );
    if (!sel) continue;

    const timeZone = effectiveInstitutionTimeZone(institution.timeZone);
    const dayKey = dayKeyForTimezone(now, timeZone);
    if (weekdayForDayKey(dayKey) !== sel.weekday) continue;
    const minute = minuteOfDayForTimezone(now, timeZone);
    if (minute < SEL_SYNTHESIS_START_MINUTE || minute >= SEL_SYNTHESIS_END_MINUTE) {
      continue;
    }

    const anchor = { weekday: sel.weekday, minutes: sel.minutes };
    const weekKey = roundsWeekKey(now, timeZone, anchor);
    due.push({
      institutionId: institution._id,
      weekKey,
      window: roundsWeekWindow(weekKey, timeZone, anchor),
    });
  }
  return due;
}

export const dueCandidates = internalQuery({
  args: { now: v.optional(v.number()) },
  handler: async (ctx, args): Promise<SelSynthesisCandidate[]> =>
    selSynthesisCandidatesAt(
      await ctx.db.query("institutions").collect(),
      args.now ?? Date.now(),
    ),
});

/** Take the (institution, week) batch, refusing when it is already running or
 *  done. Returns false to skip; true to proceed. Each successful claim counts
 *  as one attempt, which `settleRun` reads to bound partial-failure retries. */
export const claimRun = internalMutation({
  args: { institutionId: v.id("institutions"), weekKey: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("selSynthesisRuns")
      .withIndex("by_institution_week", (q) =>
        q.eq("institutionId", args.institutionId).eq("weekKey", args.weekKey),
      )
      .unique();
    if (existing?.completedAt !== undefined) return false;
    const now = Date.now();
    if (existing && existing.claimedAt > now - SEL_SYNTHESIS_CLAIM_LEASE_MS) {
      return false;
    }
    if (existing) {
      await ctx.db.patch(existing._id, {
        claimedAt: now,
        attemptCount: (existing.attemptCount ?? 0) + 1,
      });
    } else {
      await ctx.db.insert("selSynthesisRuns", {
        institutionId: args.institutionId,
        weekKey: args.weekKey,
        claimedAt: now,
        attemptCount: 1,
      });
    }
    return true;
  },
});

/**
 * Record a batch's outcome.
 *
 * A clean run (`failedCount === 0`) completes: `claimRun` refuses it forever
 * after. A PARTIAL failure records the tally and, unless it has already used up
 * `SEL_SYNTHESIS_MAX_ATTEMPTS`, rewinds the claim so the very next hourly tick
 * re-claims and regenerates. A retry regenerates the WHOLE institution, not just
 * the failed scholars — the generator upserts each (scholar, week) artifact, so
 * a re-run simply replaces every row with a fresh generation; that is acceptable
 * because the roster is small, sequential, and idempotent, and the alternative
 * (tracking and re-dispatching only the failed ids) is more state for no benefit
 * a teacher would notice. At the attempt cap the run is completed with its
 * failure counts recorded, so the cron stops and the manual generate button is
 * the recovery path.
 */
export const settleRun = internalMutation({
  args: {
    institutionId: v.id("institutions"),
    weekKey: v.string(),
    failedCount: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("selSynthesisRuns")
      .withIndex("by_institution_week", (q) =>
        q.eq("institutionId", args.institutionId).eq("weekKey", args.weekKey),
      )
      .unique();
    if (!existing) throw new Error("SEL synthesis run was not claimed");
    if (existing.completedAt !== undefined) return { retrying: false };

    if (args.failedCount === 0) {
      await ctx.db.patch(existing._id, {
        completedAt: Date.now(),
        lastFailedCount: 0,
      });
      return { retrying: false };
    }

    const attempts = existing.attemptCount ?? 1;
    if (attempts >= SEL_SYNTHESIS_MAX_ATTEMPTS) {
      // Out of retries — complete WITH the failure counts recorded so the cron
      // stops; the teacher-facing "Not written yet" + manual generate remains.
      await ctx.db.patch(existing._id, {
        completedAt: Date.now(),
        lastFailedCount: args.failedCount,
      });
      return { retrying: false };
    }

    // Leave it incomplete and rewind the claim past the lease so the next
    // hourly tick re-claims and regenerates the whole institution.
    await ctx.db.patch(existing._id, {
      claimedAt: 0,
      lastFailedCount: args.failedCount,
    });
    return { retrying: true };
  },
});

/** Hourly dispatcher; institution-local morning filtering and durable per-week
 *  markers make it effectively weekly-per-institution. */
export const dispatchSelSyntheses = internalAction({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    candidates: number;
    claimed: number;
    completed: number;
    retrying: number;
  }> => {
    const candidates: SelSynthesisCandidate[] = await ctx.runQuery(
      internal.selSynthesisCron.dueCandidates,
      {},
    );
    let claimed = 0;
    let completed = 0;
    let retrying = 0;
    for (const candidate of candidates) {
      const proceed = await ctx.runMutation(internal.selSynthesisCron.claimRun, {
        institutionId: candidate.institutionId,
        weekKey: candidate.weekKey,
      });
      if (!proceed) continue;
      claimed += 1;
      const result = await ctx.runAction(
        internal.selSynthesisActions.generateSelSynthesesForWeek,
        {
          institutionId: candidate.institutionId,
          weekKey: candidate.weekKey,
          window: candidate.window,
        },
      );
      // Complete only on a clean run; a partial failure is left claimable so the
      // next tick retries (bounded by SEL_SYNTHESIS_MAX_ATTEMPTS).
      const settled = await ctx.runMutation(internal.selSynthesisCron.settleRun, {
        institutionId: candidate.institutionId,
        weekKey: candidate.weekKey,
        failedCount: result.failedCount,
      });
      if (settled.retrying) retrying += 1;
      else completed += 1;
    }
    return { candidates: candidates.length, claimed, completed, retrying };
  },
});
