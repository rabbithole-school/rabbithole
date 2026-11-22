/**
 * A family's own BunnyPad bedtime (TRA-625). Rabbithole sleeps 8 pm to 6 am
 * for every primary-institution scholar (shared/bedtime.ts); a guardian may
 * make their own child's nightly window stricter (an earlier bedtime, a later
 * wake), from the parent portal's BunnyPad tab or by asking the parent aide.
 *
 * One window per child (`scholarBedtimes`). Any of the child's guardians may
 * change it, and the last write wins. Setting the school's own window removes
 * the row. First-party only, like bedtime itself (lib/bedtime.ts): another
 * school's child has no bedtime to make stricter, so the write is refused.
 *
 * The clients read the window from `users.currentUser`; the window is a
 * boundary, the clock lives on the device (T11).
 */
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import {
  assertNotImpersonating,
  isGuardianOf,
  READ_ONLY_ACCOUNT_ERROR,
  requireGuardianOf,
} from "./lib/auth";
import { requireActiveScholarAccess } from "./lib/access";
import { bedtimeWindowFor, scholarBedtimeTimeZone } from "./lib/bedtime";
import { scholarInstitutionId } from "./lib/scholarEnrollment";
import { writeAuditLog } from "./lib/auditLog";
import { guardianSourceValidator } from "./deviceLock";
import {
  bedtimeWindowText,
  familyBedtimeProblem,
  isSchoolBedtime,
  type BedtimeWindow,
} from "../shared/bedtime";

/** What a reader is told about one child's bedtime. */
export type ScholarBedtime = BedtimeWindow & {
  /** True when a guardian set it; false means the school's 8 pm to 6 am. */
  setByFamily: boolean;
  /** "7:30pm to 6am", for copy. */
  text: string;
};

/** The child's bedtime, or null when bedtime doesn't apply to them. */
export async function scholarBedtimeFor(
  ctx: QueryCtx,
  scholar: Doc<"users">,
): Promise<ScholarBedtime | null> {
  if (!(await scholarBedtimeTimeZone(ctx, scholar))) return null;
  const window = await bedtimeWindowFor(ctx, scholar._id);
  return { ...window, text: bedtimeWindowText(window) };
}

type GuardianBedtimeRequest = {
  guardianUserId: Id<"users">;
  scholarId: Id<"users">;
  startMinutes: number;
  endMinutes: number;
};

type GuardianBedtimeCheck =
  | { ok: true; scholar: Doc<"users">; childName: string; window: BedtimeWindow }
  | { ok: false; message: string };

/** Every refusal a guardian's bedtime write can meet, read-only, so the aide's
 *  staff preview tells the parent exactly what the real write would. */
async function checkGuardianBedtime(
  ctx: QueryCtx,
  args: GuardianBedtimeRequest,
): Promise<GuardianBedtimeCheck> {
  const guardian = await ctx.db.get(args.guardianUserId);
  if (guardian?.readOnly) return { ok: false, message: READ_ONLY_ACCOUNT_ERROR };
  if (!(await isGuardianOf(ctx, args.guardianUserId, args.scholarId))) {
    return { ok: false, message: "You can only set your own child's bedtime." };
  }
  const scholar = await ctx.db.get(args.scholarId);
  if (!scholar) {
    return { ok: false, message: "You can only set your own child's bedtime." };
  }
  const childName = scholar.name ?? "Your child";
  if (!(await scholarBedtimeTimeZone(ctx, scholar))) {
    return {
      ok: false,
      message: `${childName}'s school doesn't put the BunnyPad to sleep at night, so there's no bedtime to set.`,
    };
  }
  const window = { startMinutes: args.startMinutes, endMinutes: args.endMinutes };
  const problem = familyBedtimeProblem(window);
  if (problem) return { ok: false, message: problem };
  return { ok: true, scholar, childName, window };
}

/** Save a checked window (or remove the row for the school's own) and
 *  return the line the parent is told. */
async function applyGuardianBedtime(
  ctx: MutationCtx,
  guardianUserId: Id<"users">,
  check: Extract<GuardianBedtimeCheck, { ok: true }>,
  source: "parent_app" | "parent_sms",
): Promise<string> {
  const { scholar, childName, window } = check;
  const existing = await ctx.db
    .query("scholarBedtimes")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
    .first();
  const now = Date.now();
  if (isSchoolBedtime(window)) {
    if (existing) await ctx.db.delete(existing._id);
  } else if (existing) {
    await ctx.db.patch(existing._id, {
      ...window,
      updatedBy: guardianUserId,
      updatedAt: now,
    });
  } else {
    await ctx.db.insert("scholarBedtimes", {
      scholarId: scholar._id,
      ...window,
      updatedBy: guardianUserId,
      updatedAt: now,
    });
  }
  const text = bedtimeWindowText(window);
  await writeAuditLog(ctx, {
    institutionId: (await scholarInstitutionId(ctx, scholar._id)) ?? null,
    actorUserId: guardianUserId,
    action: "scholar.bedtime.set",
    targetUserId: scholar._id,
    at: now,
    detail: `${text} via ${source}`,
  });
  return isSchoolBedtime(window)
    ? `${childName}'s BunnyPad is back on the school's bedtime, ${text}.`
    : `${childName}'s BunnyPad will sleep from ${text} every night, starting tonight.`;
}

/** The parent portal's bedtime card: set one child's window. */
export const setForScholar = authedMutation({
  args: {
    scholarId: v.id("users"),
    startMinutes: v.number(),
    endMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    await requireGuardianOf(ctx, args.scholarId);
    const check = await checkGuardianBedtime(ctx, {
      guardianUserId: ctx.user._id,
      ...args,
    });
    if (!check.ok) throw new ConvexError(check.message);
    return {
      message: await applyGuardianBedtime(ctx, ctx.user._id, check, "parent_app"),
    };
  },
});

/** The parent aide's write, for the guardian the turn was prepared for.
 *  Returns every refusal as a message the aide says back. */
export const setFromGuardian = internalMutation({
  args: {
    guardianUserId: v.id("users"),
    scholarId: v.id("users"),
    source: guardianSourceValidator,
    startMinutes: v.number(),
    endMinutes: v.number(),
  },
  handler: async (ctx, args) => {
    // The web aide runs as the real owner of a view-as session, which is
    // read-only. A no-op for SMS, which has no session.
    try {
      await assertNotImpersonating(ctx);
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
    const check = await checkGuardianBedtime(ctx, args);
    if (!check.ok) return check;
    return {
      ok: true as const,
      message: await applyGuardianBedtime(
        ctx,
        args.guardianUserId,
        check,
        args.source,
      ),
    };
  },
});

/** The aide's staff-preview twin of setFromGuardian: the same refusals,
 *  nothing written. */
export const previewFromGuardian = internalQuery({
  args: {
    guardianUserId: v.id("users"),
    scholarId: v.id("users"),
    startMinutes: v.number(),
    endMinutes: v.number(),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; message?: string }> => {
    const check = await checkGuardianBedtime(ctx, args);
    return check.ok ? { ok: true } : check;
  },
});

/** Every one of a guardian's children's bedtimes, for the parent aide.
 *  Scoped by the guardian's own `guardianships` rows. */
export const statusForGuardian = internalQuery({
  args: { guardianUserId: v.id("users") },
  handler: async (ctx, args) => {
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", args.guardianUserId))
      .collect();
    const children = [];
    for (const link of links) {
      const scholar = await ctx.db.get(link.scholarUserId);
      if (!scholar) continue;
      children.push({
        name: scholar.name ?? "Your child",
        bedtime: await scholarBedtimeFor(ctx, scholar),
      });
    }
    return children;
  },
});

/** The parent portal's BunnyPad tab: one child's bedtime, for a guardian.
 *  Null when bedtime doesn't apply to the child. */
export const forParent = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<ScholarBedtime | null> => {
    await requireGuardianOf(ctx, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    return scholar ? await scholarBedtimeFor(ctx, scholar) : null;
  },
});

/** The scholar profile's read-only bedtime line, for staff who can reach the
 *  scholar. Null when bedtime doesn't apply to them. */
export const forScholar = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args): Promise<ScholarBedtime | null> => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    return scholar ? await scholarBedtimeFor(ctx, scholar) : null;
  },
});
