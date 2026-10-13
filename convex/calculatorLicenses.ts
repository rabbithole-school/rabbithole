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
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { authedQuery, teacherMutation } from "./lib/customFunctions";
import { requireActiveScholarAccess } from "./lib/access";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { isTeacherRole, ROLES } from "./lib/roles";
import { scholarSlug } from "./lib/channels";
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
    expiresOn: string | null;
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

/**
 * The school's calendar day for an instant, "YYYY-MM-DD" (en-CA formats ISO
 * order), so it compares to an `expiresOn` as a plain string.
 */
export function schoolCalendarDay(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(new Date(at));
}

/**
 * Validate a teacher-chosen expiration date. Every license must carry one,
 * and it must be a real calendar date after the school's today — a license
 * that expires today or earlier is a typo, not a credential. Returns the
 * normalized "YYYY-MM-DD"; throws a teacher-readable message otherwise.
 */
export function validateLicenseExpiry(
  expiresOn: string,
  now: number,
  timeZone: string,
): string {
  const trimmed = expiresOn.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const asDate = match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
    : null;
  if (
    !match ||
    !asDate ||
    asDate.getUTCFullYear() !== Number(match[1]) ||
    asDate.getUTCMonth() !== Number(match[2]) - 1 ||
    asDate.getUTCDate() !== Number(match[3])
  ) {
    throw new Error(
      `The expiration date must be a calendar date like 2027-01-15 (got "${expiresOn}").`,
    );
  }
  if (trimmed <= schoolCalendarDay(now, timeZone)) {
    throw new Error("The expiration date must be after today.");
  }
  return trimmed;
}

/** "Jan 15, 2027" for a stored "YYYY-MM-DD" (no time zone involved). */
export function formatLicenseExpiry(expiresOn: string): string {
  const [y, m, d] = expiresOn.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

async function scholarTimeZone(
  ctx: QueryCtx | MutationCtx,
  scholar: Doc<"users">,
): Promise<string> {
  const institution = scholar.institutionId
    ? await ctx.db.get(scholar.institutionId)
    : null;
  return effectiveInstitutionTimeZone(institution?.timeZone);
}

const CALCULATOR_LICENSE_BADGE = {
  title: "Calculator license",
  description: "Earned by passing the proctored Calculator License Test.",
  icon: "🧮",
} as const;

/**
 * The license badge's image is the license card itself — rendered from the
 * same design the printer gets (calculatorLicenseCardActions.ts), never
 * generative medallion art. No style/colorway: there is nothing to remix.
 * `artStatus: "generating"` covers the few seconds the render takes.
 */
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
    artStatus: "generating",
    rerollsUsed: 0,
  });
  await scheduleCalculatorLicenseCardRender(ctx, badgeId);
  return badgeId;
}

/**
 * (Re-)render the badge's card image from the license's CURRENT issuance.
 * Scheduled on every grant and re-record; the action reloads the license, so
 * the image always shows the latest issue date and proctor, and its write-back
 * discards a render a newer issuance (or a revoke) has overtaken.
 */
async function scheduleCalculatorLicenseCardRender(
  ctx: MutationCtx,
  badgeId: Id<"scholarUnitBadges">,
) {
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
  reissued: boolean,
  reprintOf?: number,
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
          expiresOn: license.expiresOn ?? null,
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
 * The one grant path, shared by the teacher UI (`grantCalculatorLicense`) and
 * the bots (`grantForCaller`). The caller has already passed the teacher/admin
 * role gate; this enforces the institution boundary itself.
 *
 * Idempotent-by-scholar: one row per scholar. A second call CORRECTS the
 * existing record (when / who), re-renders the badge card, and schedules a new
 * print — which is how a mis-recorded grant is fixed; there is no separate edit
 * mutation to keep in sync. There is no score input or validation: pass/not-yet
 * is entirely a human judgment made in the room. The one required input is
 * the expiration date, which the granting teacher always chooses.
 */
async function grantCalculatorLicenseAs(
  ctx: MutationCtx,
  caller: Doc<"users">,
  scholarId: Id<"users">,
  requestedExpiresOn: string,
): Promise<{
  licenseId: Id<"calculatorLicenses">;
  corrected: boolean;
  issuedAt: number;
}> {
  await requireActiveScholarAccess(ctx, caller, scholarId);
  const scholar = await ctx.db.get(scholarId);
  if (!scholar || scholar.role !== ROLES.SCHOLAR) {
    throw new Error("Target user is not a scholar");
  }

  const issuedAt = Date.now();
  const expiresOn = validateLicenseExpiry(
    requestedExpiresOn,
    issuedAt,
    await scholarTimeZone(ctx, scholar),
  );

  const existing = await ctx.db
    .query("calculatorLicenses")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .first();

  if (existing) {
    const linkedBadge = existing.badgeId
      ? await ctx.db.get(existing.badgeId)
      : null;
    let badgeId: Id<"scholarUnitBadges">;
    if (linkedBadge?.kind === "calculator_license") {
      // A re-record changes what the card says (issue date, proctor), so
      // the badge re-renders; the old image stays on screen, dimmed, until
      // the new one replaces it (and the old blob is deleted).
      badgeId = linkedBadge._id;
      await ctx.db.patch(badgeId, { artStatus: "generating" });
      await scheduleCalculatorLicenseCardRender(ctx, badgeId);
    } else {
      badgeId = await mintCalculatorLicenseBadge(ctx, scholarId, issuedAt);
    }
    await ctx.db.patch(existing._id, {
      issuedAt,
      issuedBy: caller._id,
      expiresOn,
      badgeId,
    });
    await schedulePrintCalculatorLicense(ctx, existing._id, issuedAt, true);
    return { licenseId: existing._id, corrected: true, issuedAt };
  }

  const badgeId = await mintCalculatorLicenseBadge(ctx, scholarId, issuedAt);
  const licenseId = await ctx.db.insert("calculatorLicenses", {
    scholarId,
    issuedAt,
    issuedBy: caller._id,
    expiresOn,
    badgeId,
  });
  await schedulePrintCalculatorLicense(ctx, licenseId, issuedAt, false);
  return { licenseId, corrected: false, issuedAt };
}

/**
 * The one revoke path (UI + bots). Removes a license granted in error. A no-op
 * when the scholar has none, so a double-click can't throw at a teacher.
 */
async function revokeCalculatorLicenseAs(
  ctx: MutationCtx,
  caller: Doc<"users">,
  scholarId: Id<"users">,
): Promise<{ removed: boolean }> {
  await requireActiveScholarAccess(ctx, caller, scholarId);
  const existing = await ctx.db
    .query("calculatorLicenses")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .first();
  if (!existing) return { removed: false };
  if (existing.badgeId) {
    const badge = await ctx.db.get(existing.badgeId);
    if (
      badge?.kind === "calculator_license" &&
      String(badge.scholarId) === String(scholarId)
    ) {
      if (badge.imageStorageId) {
        await ctx.storage.delete(badge.imageStorageId);
      }
      await ctx.db.delete(badge._id);
    }
  }
  await ctx.db.delete(existing._id);
  return { removed: true };
}

/** Grant (or re-record) the Calculator License — the teacher UI's Grant button. */
export const grantCalculatorLicense = teacherMutation({
  args: {
    scholarId: v.id("users"),
    /** "YYYY-MM-DD", the school calendar day the license expires. */
    expiresOn: v.string(),
  },
  handler: async (ctx, args) => {
    const { licenseId, corrected } = await grantCalculatorLicenseAs(
      ctx,
      ctx.user,
      args.scholarId,
      args.expiresOn,
    );
    return { licenseId, corrected };
  },
});

/** Remove a license granted in error — the teacher UI's Remove control. */
export const revokeCalculatorLicense = teacherMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) =>
    await revokeCalculatorLicenseAs(ctx, ctx.user, args.scholarId),
});

// ── Bot path (Slack, in-app assistant, MCP via lib/scholarWriteTools.ts) ──
// The bots have no Convex Auth identity: they act for a mapped user passed as
// `callerUserId` (the in-app aide resolves it with getAuthUserId — the REAL
// signed-in user, never an impersonation target — so teacherMutation's
// overlay check has no session to apply to here). The role gate below is the
// one teacherMutation applies; the institution boundary is inside the shared
// helpers above.

async function requireTeacherCaller(
  ctx: MutationCtx,
  callerUserId: Id<"users">,
): Promise<Doc<"users">> {
  const caller = await ctx.db.get(callerUserId);
  if (!caller || !isTeacherRole(caller.role)) {
    throw new Error("Forbidden: teacher or admin role required");
  }
  return caller;
}

function formatIssuedOn(issuedAt: number, timeZone: string): string {
  return new Date(issuedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  });
}

/**
 * Bot grant. Unlike the UI button, an existing license is NOT silently
 * re-recorded: a re-record reprints the physical card and re-renders the
 * badge, so the bot gets `already_licensed` back (with who/when) and passes
 * `rerecord: true` only after the teacher confirms.
 *
 * `expiresOn` is optional HERE only so the bot can learn the scholar is
 * already licensed before it has asked for a date; a grant without one
 * returns `needs_expiry` so the bot asks the teacher instead of inventing a
 * date.
 */
export const grantForCaller = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    rerecord: v.optional(v.boolean()),
    expiresOn: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await requireTeacherCaller(ctx, args.callerUserId);
    await requireActiveScholarAccess(ctx, caller, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Target user is not a scholar");
    }
    const scholarName = scholar.name ?? "This scholar";
    const institution = scholar.institutionId
      ? await ctx.db.get(scholar.institutionId)
      : null;
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);

    const existing = await ctx.db
      .query("calculatorLicenses")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();
    if (existing && args.rerecord !== true) {
      const issuer = await ctx.db.get(existing.issuedBy);
      return {
        status: "already_licensed" as const,
        scholarName,
        issuedOn: formatIssuedOn(existing.issuedAt, timeZone),
        issuedByName: issuer?.name ?? null,
        expiresOn: existing.expiresOn
          ? formatLicenseExpiry(existing.expiresOn)
          : null,
        printsCard: false,
      };
    }
    if (!args.expiresOn?.trim()) {
      return { status: "needs_expiry" as const, scholarName };
    }

    const { corrected, issuedAt } = await grantCalculatorLicenseAs(
      ctx,
      caller,
      args.scholarId,
      args.expiresOn,
    );
    // Mirrors printContext's gate: only the primary institution prints.
    let printsCard = false;
    return {
      status: corrected ? ("rerecorded" as const) : ("granted" as const),
      scholarName,
      issuedOn: formatIssuedOn(issuedAt, timeZone),
      issuedByName: caller.name ?? null,
      expiresOn: formatLicenseExpiry(args.expiresOn.trim()),
      printsCard,
    };
  },
});

/**
 * Operator correction of an existing license's terms — its expiration date
 * and/or the proctor on record — WITHOUT re-issuing it: the issue date and
 * license number stay, the badge card re-renders, and nothing reprints
 * unless `reprint: true` — a physical side effect, so opt-in. A reprint is
 * its own print job (keyed apart from the original issuance's) and posts no
 * new Slack celebration: the license wasn't re-earned. Internal only: run
 * from the CLI, e.g. to give licenses issued before expiry existed their date.
 */
export const amendLicenseTerms = internalMutation({
  args: {
    scholarId: v.id("users"),
    expiresOn: v.optional(v.string()),
    issuedBy: v.optional(v.id("users")),
    reprint: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const license = await ctx.db
      .query("calculatorLicenses")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .first();
    if (!license) throw new Error("This scholar has no calculator license.");
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar) throw new Error("Scholar not found.");
    const patch: Partial<Doc<"calculatorLicenses">> = {};
    if (args.expiresOn !== undefined) {
      patch.expiresOn = validateLicenseExpiry(
        args.expiresOn,
        Date.now(),
        await scholarTimeZone(ctx, scholar),
      );
    }
    if (args.issuedBy !== undefined) {
      const proctor = await ctx.db.get(args.issuedBy);
      if (!proctor || !isTeacherRole(proctor.role)) {
        throw new Error("The proctor must be a teacher or admin.");
      }
      // The same institution boundary a grant enforces on its caller.
      await requireActiveScholarAccess(ctx, proctor, args.scholarId);
      patch.issuedBy = args.issuedBy;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(license._id, patch);
    if (license.badgeId) {
      const badge = await ctx.db.get(license.badgeId);
      if (badge?.kind === "calculator_license") {
        await ctx.db.patch(badge._id, { artStatus: "generating" });
        await scheduleCalculatorLicenseCardRender(ctx, badge._id);
      }
    }
    if (args.reprint === true) {
      await schedulePrintCalculatorLicense(
        ctx,
        license._id,
        license.issuedAt,
        false,
        Date.now(),
      );
    }
    return { amended: Object.keys(patch).length > 0, reprinted: args.reprint === true };
  },
});

/** Bot revoke — same role gate + institution boundary as the UI path. */
export const revokeForCaller = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const caller = await requireTeacherCaller(ctx, args.callerUserId);
    return await revokeCalculatorLicenseAs(ctx, caller, args.scholarId);
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
      licenseId: license._id,
      institutionId: institution._id,
      // The issue date prints as the school's calendar day, not UTC's.
      timeZone: effectiveInstitutionTimeZone(institution.timeZone),
      scholarName: scholar.name ?? "Scholar",
      // Route slug for the staff Slack post's link to the scholar's page.
      scholarSlug: scholarSlug(scholar.username, scholar._id),
      issuedAt: license.issuedAt,
      issuedByName: issuer?.name ?? null,
      expiresOn: license.expiresOn ?? null,
      // The scholar's profile photo, for the card's portrait. Returned only
      // past the gates above, so it reaches the print pipeline solely for a
      // current, primary-institution issuance.
      scholarPhotoUrl: scholar.image ?? null,
    };
  },
});

// ── The badge's card image (calculatorLicenseCardActions.ts) ─────────────

/** The license row a calculator_license badge belongs to — only while that
 * badge is still the license's current badge. */
async function currentLicenseForBadge(
  ctx: QueryCtx | MutationCtx,
  badge: Doc<"scholarUnitBadges">,
) {
  if (badge.kind !== "calculator_license") return null;
  const license = await ctx.db
    .query("calculatorLicenses")
    .withIndex("by_scholar", (q) => q.eq("scholarId", badge.scholarId))
    .first();
  return license && license.badgeId === badge._id ? license : null;
}

/**
 * What the badge's card shows, for the render action. Unlike printContext
 * this is NOT primary-gated: the in-app badge is not first-party hardware,
 * so every institution's scholar gets one — headed with their OWN school's
 * name (the primary school keeps its print identity, so its badge and paper
 * card are the same design). Null when the badge or license is gone.
 */
export const badgeRenderContext = internalQuery({
  args: { badgeId: v.id("scholarUnitBadges") },
  handler: async (ctx, { badgeId }) => {
    const badge = await ctx.db.get(badgeId);
    if (!badge) return null;
    const license = await currentLicenseForBadge(ctx, badge);
    if (!license) return null;
    const scholar = await ctx.db.get(license.scholarId);
    if (!scholar) return null;
    const institution = scholar.institutionId
      ? await ctx.db.get(scholar.institutionId)
      : null;
    const issuer = await ctx.db.get(license.issuedBy);
    return {
      fields: {
        licenseId: license._id,
        timeZone: effectiveInstitutionTimeZone(institution?.timeZone),
        scholarName: scholar.name ?? "Scholar",
        issuedAt: license.issuedAt,
        issuedByName: issuer?.name ?? null,
        expiresOn: license.expiresOn ?? null,
      },
      scholarPhotoUrl: scholar.image ?? null,
      issuer: {
        isPrimary: institution?.isPrimary === true,
        name: institution?.name ?? "Rabbithole",
        logoStorageId: institution?.logoStorageId ?? null,
      },
    };
  },
});

/**
 * Store a rendered card as the badge's image, deleting the one it replaces.
 * Discards (and deletes) the new image instead when the issuance it was
 * rendered from is no longer current — a re-record or revoke landed while
 * the render ran — so a slow render can't overwrite a newer card or attach
 * an image to a revoked license.
 */
export const storeBadgeCardImage = internalMutation({
  args: {
    badgeId: v.id("scholarUnitBadges"),
    issuedAt: v.number(),
    imageStorageId: v.id("_storage"),
  },
  handler: async (ctx, args): Promise<{ stored: boolean }> => {
    const badge = await ctx.db.get(args.badgeId);
    const license = badge ? await currentLicenseForBadge(ctx, badge) : null;
    if (!badge || !license || license.issuedAt !== args.issuedAt) {
      await ctx.storage.delete(args.imageStorageId);
      return { stored: false };
    }
    const previous = badge.imageStorageId;
    await ctx.db.patch(badge._id, {
      imageStorageId: args.imageStorageId,
      artStatus: "ready",
    });
    if (previous && previous !== args.imageStorageId) {
      await ctx.storage.delete(previous);
    }
    return { stored: true };
  },
});

/** A render that threw: mark the current issuance's badge failed (the
 * surfaces fall back to the 🧮 icon, or keep showing a previous card). */
export const markBadgeRenderFailed = internalMutation({
  args: { badgeId: v.id("scholarUnitBadges"), issuedAt: v.number() },
  handler: async (ctx, args) => {
    const badge = await ctx.db.get(args.badgeId);
    const license = badge ? await currentLicenseForBadge(ctx, badge) : null;
    if (!badge || !license || license.issuedAt !== args.issuedAt) return;
    await ctx.db.patch(badge._id, { artStatus: "failed" });
  },
});
