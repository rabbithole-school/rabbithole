// "Welcome to Rabbithole" onboarding — the seed + auto-enroll plumbing.
//
// - `seedOnboarding`  : idempotent. Find-or-creates the system account
//                       (rabbithole-guide) + the welcome unit / lesson /
//                       3 activities / badge config. Run from db-seed.sh as
//                       its OWN step (so it lands even when the bulk seed's
//                       "already seeded" skip fires) and safe to re-run.
// - `enrollScholar`   : internal mutation scheduled from every scholar-
//                       creation path. Idempotent + guarded. Gives the new
//                       scholar their own single-member assignment of the
//                       self-paced welcome unit and pushes beat 1 live, so
//                       they land on a guided first quest instead of an
//                       empty plate. The assignment stays self-paced so the
//                       in-session "Continue" CTA carries them through the
//                       rest; beat 1 is the only scheduled push.
//
// Auto-enroll is a NO-OP when the welcome unit hasn't been seeded (e.g. prod
// before this ships, or a test that didn't seed it) and can be killed with
// the DISABLE_ONBOARDING_AUTOENROLL env var. See
// review/getting-to-know-you-quest-plan.html.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ROLES } from "./lib/roles";
import { isProgramGuest } from "./lib/enrollmentStanding";
import { syncScheduleMirrorAll } from "./lib/scheduleMirror";
import {
  ONBOARDING_UNIT,
  ONBOARDING_UNIT_SLUG,
  ONBOARDING_SYSTEM_USERNAME,
} from "./onboardingData";

// ── Resolve helpers ────────────────────────────────────────────────────

/** The welcome unit, by its stable slug. Null until seeded. */
async function getOnboardingUnit(ctx: QueryCtx | MutationCtx) {
  return await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", ONBOARDING_UNIT_SLUG))
    .first();
}

/** The system account that owns the welcome unit + every onboarding
 *  assignment. Created by the seed; resolved by username. */
async function getSystemUser(ctx: QueryCtx | MutationCtx) {
  return await ctx.db
    .query("users")
    .withIndex("by_username", (q) =>
      q.eq("username", ONBOARDING_SYSTEM_USERNAME),
    )
    .first();
}

// ── Seed (idempotent) ──────────────────────────────────────────────────

type SeedResult = {
  systemUserId: Id<"users">;
  unitId: Id<"units">;
  created: boolean;
};

/**
 * Re-sync an already-seeded welcome unit's activities to the fixture. The unit
 * is system-owned + fixture-defined, so the fixture wins. Titles are stable
 * fixture keys for the legacy rows (activities do not store fixture slugs);
 * matching by title preserves completion history when activities are reordered.
 * A same-size/order fallback repairs title drift. Missing activities are
 * inserted. Retiring an activity requires reference migration, so surplus rows
 * stay attached until the resumable migration in `convex/migrations.ts` moves
 * schedules and unfinished sessions, reconciles badges, and detaches them.
 * Idempotent.
 */
export async function reconcileOnboardingActivities(
  ctx: MutationCtx,
  unitId: Id<"units">,
) {
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  lessons.sort((a, b) => a.order - b.order);
  const lesson = lessons[0];
  if (!lesson) return;
  const existing = await ctx.db
    .query("activities")
    .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
    .collect();
  const claimedIds = new Set<Id<"activities">>();
  const resolvedByOrder = new Map<number, Id<"activities">>();
  for (const a of ONBOARDING_UNIT.activities) {
    const fields = {
      title: a.title,
      description: a.description,
      // The onboarding fixture's descriptions are authored scholar-voiced
      // (convex/onboardingData.ts), so they double as the scholar card blurb.
      scholarDescription: a.description,
      kind: "online" as const,
      order: a.order,
      durationMinutes: a.durationMinutes,
      systemPrompt: a.systemPrompt,
      deliverable: a.deliverable,
      advanceRubric: a.advanceRubric,
      defaultMode: "classFocus" as const,
    };
    const foundByTitle = existing.find(
      (row) => !claimedIds.has(row._id) && row.title === a.title,
    );
    const foundByOrder =
      existing.length === ONBOARDING_UNIT.activities.length
        ? existing.find(
            (row) => !claimedIds.has(row._id) && row.order === a.order,
          )
        : undefined;
    const found = foundByTitle ?? foundByOrder;
    if (found) {
      await ctx.db.patch(found._id, fields);
      claimedIds.add(found._id);
      resolvedByOrder.set(a.order, found._id);
    } else {
      const activityId = await ctx.db.insert("activities", {
        lessonId: lesson._id,
        ...fields,
      });
      claimedIds.add(activityId);
      resolvedByOrder.set(a.order, activityId);
    }
  }

}

export const seedOnboarding = internalMutation({
  args: {},
  handler: async (ctx): Promise<SeedResult> => {
    // 1. System account (find-or-create). ALWAYS reconcile its security shape
    //    on every run — even when the unit already exists below — so a row
    //    seeded by older code (or with drifted fields) is forced back to the
    //    least-privilege, un-claimable shape (teacher + isSystem). This is the
    //    "idempotent-seed stale-data trap" guard: see .claude/rules/
    //    engineering-principles.md.
    let systemUser = await getSystemUser(ctx);
    if (!systemUser) {
      const id = await ctx.db.insert("users", {
        username: ONBOARDING_SYSTEM_USERNAME,
        name: "Rabbithole",
        // TEACHER (not admin): it only needs to OWN the welcome unit +
        // onboarding assignments — least privilege. And `isSystem` makes it
        // un-sign-in-able (see convex/auth.ts), so this hard-coded,
        // passwordless account can never be claimed.
        role: ROLES.TEACHER,
        isSystem: true,
        profileSetupComplete: true,
      });
      systemUser = (await ctx.db.get(id))!;
    } else if (systemUser.role !== ROLES.TEACHER || !systemUser.isSystem) {
      await ctx.db.patch(systemUser._id, {
        role: ROLES.TEACHER,
        isSystem: true,
      });
      systemUser = (await ctx.db.get(systemUser._id))!;
    }

    // 2. The welcome unit (find-or-create by slug). It's a SYSTEM-owned,
    //    fixture-defined unit, so the fixture is the source of truth: when it
    //    already exists, RECONCILE its activities to the fixture rather than
    //    leaving stale content — this picks up new fields like
    //    advanceRubric on an already-seeded deployment without a destructive
    //    re-seed (the idempotent-seed stale-data trap again).
    const existingUnit = await getOnboardingUnit(ctx);
    if (existingUnit) {
      await reconcileOnboardingActivities(ctx, existingUnit._id);
      return {
        systemUserId: systemUser._id,
        unitId: existingUnit._id,
        created: false,
      };
    }

    const unitId = await ctx.db.insert("units", {
      teacherId: systemUser._id,
      title: ONBOARDING_UNIT.title,
      slug: ONBOARDING_UNIT.slug,
      emoji: ONBOARDING_UNIT.emoji,
      subject: ONBOARDING_UNIT.subject,
      description: ONBOARDING_UNIT.description,
      scholarDescription: ONBOARDING_UNIT.scholarDescription,
      bigIdea: ONBOARDING_UNIT.bigIdea,
      isActive: true,
      badgeOnCompletion: {
        title: ONBOARDING_UNIT.badge.title,
        description: ONBOARDING_UNIT.badge.description,
        icon: ONBOARDING_UNIT.badge.icon,
      },
    });

    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: ONBOARDING_UNIT.lesson.title,
      order: 0,
      strand: "identity",
    });

    for (const a of ONBOARDING_UNIT.activities) {
      await ctx.db.insert("activities", {
        lessonId,
        title: a.title,
        description: a.description,
        // Scholar-voiced by design — see convex/onboardingData.ts.
        scholarDescription: a.description,
        kind: "online",
        order: a.order,
        durationMinutes: a.durationMinutes,
        systemPrompt: a.systemPrompt,
        deliverable: a.deliverable,
        advanceRubric: a.advanceRubric,
        defaultMode: "classFocus",
      });
    }

    return { systemUserId: systemUser._id, unitId, created: true };
  },
});

// ── Auto-enroll ─────────────────────────────────────────────────────────

/** Current fixture opener, with lowest-order fallback for malformed old data. */
async function firstOnlineActivity(ctx: MutationCtx, unitId: Id<"units">) {
  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (q) => q.eq("unitId", unitId))
    .collect();
  lessons.sort((a, b) => a.order - b.order);
  for (const lesson of lessons) {
    const acts = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lesson._id))
      .collect();
    const online = acts
      .filter((a) => a.kind === "online")
      .sort((a, b) => a.order - b.order);
    const fixtureOpener = online.find(
      (activity) => activity.title === ONBOARDING_UNIT.activities[0].title,
    );
    if (fixtureOpener) return fixtureOpener;
    if (online.length > 0) return online[0];
  }
  return null;
}

/**
 * Enroll a freshly-created scholar in the welcome quest. Idempotent +
 * heavily guarded so it's safe to fire-and-forget (scheduled) from every
 * account-creation path. No-op (never throws) when anything is off, so it
 * can never break sign-up.
 */
export const enrollScholar = internalMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }): Promise<null> => {
    if (process.env.DISABLE_ONBOARDING_AUTOENROLL === "true") return null;

    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return null;
    if (isProgramGuest(scholar)) return null;

    const unit = await getOnboardingUnit(ctx);
    const systemUser = await getSystemUser(ctx);
    // Not seeded on this deployment → nothing to enroll into.
    if (!unit || !systemUser) return null;
    // A scholar should never be enrolled in their own (IS) unit, and the
    // system account is never a scholar — both already excluded above, but
    // guard the unit author too.
    if (unit.authorScholarId) return null;

    // Idempotency: already has an assignment for this unit? (Covers retries
    // + the multi-path creation hooks firing more than once.)
    const existing = await ctx.db
      .query("assignments")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    if (existing.some((a) => a.scholarIds.some((id) => id === scholarId))) {
      return null;
    }

    const first = await firstOnlineActivity(ctx, unit._id);
    // Per-scholar single-member assignment owned by the system account, with
    // beat 1 pushed LIVE (setAt stamped) so it shows on the plate immediately.
    const schedule = first
      ? [
          {
            activityId: first._id,
            mode: "classFocus" as const,
            setAt: Date.now(),
          },
        ]
      : [];
    const assignmentId = await ctx.db.insert("assignments", {
      teacherId: systemUser._id,
      unitId: unit._id,
      scholarIds: [scholarId],
      title: ONBOARDING_UNIT.title,
      startedAt: Date.now(),
      selfPaced: true,
      activitySchedule: schedule,
    });
    // This writes `activitySchedule` directly instead of going through
    // `pushActivity`, so it has to mirror by hand. Without this, every scholar
    // onboarded after the backfill ran would carry a permanently mirror-less
    // live focus — a hole the drift counter would report but nothing would fix.
    if (schedule.length > 0) {
      const created = await ctx.db.get(assignmentId);
      if (created) await syncScheduleMirrorAll(ctx, created, schedule);
    }
    return null;
  },
});

// ── Read helpers (tests / tooling) ──────────────────────────────────────

export const getOnboardingUnitId = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"units"> | null> => {
    const unit = await getOnboardingUnit(ctx);
    return unit?._id ?? null;
  },
});
