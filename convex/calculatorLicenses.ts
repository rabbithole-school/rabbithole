/**
 * CALCULATOR LICENSE — the durable, adult-issued credential a scholar earns by
 * passing the school's teacher-proctored Calculator License Test.
 *
 * The exam is PAPER and happens in the room: nothing here administers, times,
 * or scores it. This module records the outcome an adult observed. Pass /
 * not-yet is ENTIRELY AT TEACHER DISCRETION — there is no numeric score,
 * threshold, or validation anywhere in this module or the schema; the teacher
 * simply grants (or later corrects / removes) the credential for a scholar.
 * Fast Math automaticity remains a separate, derived diagnostic; a teacher may
 * grant the license at any time regardless of it.
 *
 * Auth mirrors the rest of the cohort practice surface: `teacherMutation`
 * (teacher/admin role, and never while impersonating) + `requireActiveScholarAccess`
 * for the institution boundary. The teacher-facing READ lives with the other
 * cohort reads (`cohortPractice.fastMathForScholars`) so the matrix and this
 * gate share one derivation.
 */

import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { authedQuery, teacherMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { ROLES } from "./lib/roles";
import { loadFastMathProgress } from "./lib/practice/fastMathRead";
import type { FastMathFactReading } from "./lib/practice/fastMath";

type ScholarFastMathFact = Omit<
  FastMathFactReading,
  "seenCount" | "correctCount"
>;

type MyLicenseStatus = {
  state: "licensed" | "ready" | "building";
  license: {
    issuedAt: number;
    issuedByName: string | null;
    badge: {
      imageUrl: string | null;
      artStatus: string;
      icon: string;
    } | null;
  } | null;
  fastMath: {
    calibration: "known" | "uncalibrated";
    baselineKnown: boolean;
    automaticCount: number;
    denominator: number;
    percent: number;
    ready: boolean;
    facts: ScholarFastMathFact[];
  };
} | null;

const CALCULATOR_LICENSE_BADGE = {
  title: "Calculator license",
  description: "Earned by passing the proctored Calculator License Test.",
  icon: "🧮",
} as const;

async function mintCalculatorLicenseBadge(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  earnedAt: number,
) {
  const badgeId = await ctx.db.insert("scholarUnitBadges", {
    scholarId,
    kind: "calculator_license",
    earnedAt,
    badgeSnapshot: CALCULATOR_LICENSE_BADGE,
    style: "medallion",
    colorway: "gold",
    artStatus: "generating",
    rerollsUsed: 0,
  });
  await ctx.scheduler.runAfter(0, internal.badgeArtActions.generateBadgeArt, {
    badgeId,
  });
  return badgeId;
}

/**
 * Schedule the physical print for one issuance. Scheduled unconditionally
 * from a fresh grant and from a correction/re-record alike (mirrors how
 * badge art is always scheduled) — the primary-institution gate and the
 * "is this issuance still current" staleness check both live downstream in
 * printCalculatorLicense/printContext, not here, per the print pipeline's
 * design: a non-primary-institution grant still creates the credential, it
 * just never enqueues a print job.
 */
async function schedulePrintCalculatorLicense(
  ctx: MutationCtx,
  licenseId: Id<"calculatorLicenses">,
  issuedAt: number,
) {
}

/**
 * Scholar-safe status for the Math home card.
 *
 * This is an OWN-scholar read only. The Fast Math reading exposes no latency,
 * peer comparison, or teacher diagnostics; it is solely the scholar's own
 * canonical automaticity fraction, calibration state, and per-fact verdicts.
 * It omits raw tallies and latency, and is never a score for, or a gate on, the
 * teacher-proctored Calculator License Test.
 */
export const myLicenseStatus = authedQuery({
  args: {},
  handler: async (ctx): Promise<MyLicenseStatus> => {
    if (ctx.user.role !== ROLES.SCHOLAR) return null;

    const [license, progress] = await Promise.all([
      ctx.db
        .query("calculatorLicenses")
        .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
        .first(),
      loadFastMathProgress(ctx, ctx.user._id),
    ]);
    const fastMath = {
      calibration: progress.baselineKnown
        ? ("known" as const)
        : ("uncalibrated" as const),
      baselineKnown: progress.baselineKnown,
      automaticCount: progress.automaticCount,
      denominator: progress.denominator,
      percent: progress.percent,
      ready: progress.ready,
      facts: progress.facts.map(
        ({ seenCount: _seenCount, correctCount: _correctCount, ...fact }) => fact,
      ),
    };
    if (license) {
      const [issuer, badge] = await Promise.all([
        ctx.db.get(license.issuedBy),
        license.badgeId ? ctx.db.get(license.badgeId) : null,
      ]);
      const imageUrl = badge?.imageStorageId
        ? await ctx.storage.getUrl(badge.imageStorageId)
        : null;
      return {
        state: "licensed" as const,
        license: {
          issuedAt: license.issuedAt,
          issuedByName: issuer?.name ?? null,
          badge: badge
            ? {
                imageUrl,
                artStatus: badge.artStatus ?? (imageUrl ? "ready" : "generating"),
                icon: badge.badgeSnapshot.icon ?? CALCULATOR_LICENSE_BADGE.icon,
              }
            : null,
        },
        fastMath,
      };
    }

    return {
      state: progress.ready ? ("ready" as const) : ("building" as const),
      license: null,
      fastMath,
    };
  },
});

/**
 * Grant (or re-record) the Calculator License at the teacher's discretion.
 *
 * Idempotent-by-scholar: one row per scholar. A second call CORRECTS the
 * existing record (when / who), which is how a mis-recorded grant is
 * fixed — there is no separate edit mutation to keep in sync. There is no
 * score input or validation: pass/not-yet is entirely a human judgment made
 * in the room.
 */
export const grantCalculatorLicense = teacherMutation({
  args: {
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Target user is not a scholar");
    }

    const existing = await ctx.db
      .query("calculatorLicenses")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();

    const issuedAt = Date.now();
    if (existing) {
      const linkedBadge = existing.badgeId
        ? await ctx.db.get(existing.badgeId)
        : null;
      const badgeId =
        linkedBadge?.kind === "calculator_license"
          ? linkedBadge._id
          : await mintCalculatorLicenseBadge(ctx, args.scholarId, issuedAt);
      await ctx.db.patch(existing._id, {
        issuedAt,
        issuedBy: ctx.user._id,
        badgeId,
      });
      await schedulePrintCalculatorLicense(ctx, existing._id, issuedAt);
      return { licenseId: existing._id, corrected: true };
    }

    const badgeId = await mintCalculatorLicenseBadge(
      ctx,
      args.scholarId,
      issuedAt,
    );
    const licenseId = await ctx.db.insert("calculatorLicenses", {
      scholarId: args.scholarId,
      issuedAt,
      issuedBy: ctx.user._id,
      badgeId,
    });
    await schedulePrintCalculatorLicense(ctx, licenseId, issuedAt);
    return { licenseId, corrected: false };
  },
});

/**
 * Remove a license granted in error. A no-op when the scholar has none, so a
 * double-click can't throw at a teacher.
 */
export const revokeCalculatorLicense = teacherMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const existing = await ctx.db
      .query("calculatorLicenses")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();
    if (!existing) return { removed: false };
    if (existing.badgeId) {
      const badge = await ctx.db.get(existing.badgeId);
      if (
        badge?.kind === "calculator_license" &&
        String(badge.scholarId) === String(args.scholarId)
      ) {
        if (badge.imageStorageId) {
          await ctx.storage.delete(badge.imageStorageId);
        }
        await ctx.db.delete(badge._id);
      }
    }
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});

/**
 * Print eligibility + content for one scheduled issuance. Called only from
 * cloudPrintingActions.printCalculatorLicense, never client-facing.
 *
 * Returns null (skip without a job) when:
 *   - the license no longer exists (revoked before this ran), or
 *   - a newer grant/correction has since replaced it (issuedAt no longer
 *     matches — a stale schedule never reprints a superseded issuance; the
 *     newer schedule owns it), or
 *   - the scholar's institution isn't the primary one — this is the
 *     enforcement point for "non-primary institution grants must still
 *     create credentials but never enqueue printing," independent of
 *     whatever the UI does.
 */
export const printContext = internalQuery({
  args: {
    licenseId: v.id("calculatorLicenses"),
    issuedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const license = await ctx.db.get(args.licenseId);
    if (!license || license.issuedAt !== args.issuedAt) return null;

    const scholar = await ctx.db.get(license.scholarId);
    if (!scholar || !scholar.institutionId) return null;
    const institution = await ctx.db.get(scholar.institutionId);
    if (!institution || institution.isPrimary !== true) return null;

    const issuer = await ctx.db.get(license.issuedBy);
    return {
      institutionId: institution._id,
      scholarName: scholar.name ?? "Scholar",
      issuedAt: license.issuedAt,
      issuedByName: issuer?.name ?? null,
    };
  },
});
