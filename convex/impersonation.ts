// Admin impersonation ("View as user") — the server-side overlay model.
//
// The admin STAYS signed in as themselves; startImpersonation records an
// overlay keyed to the admin's OWN live session. While it's active,
// getCurrentUser (convex/lib/auth.ts) resolves as the target for scholar-
// facing reads + the app UI (read-only — assertNotImpersonating blocks
// writes), and the banner shows via myImpersonation. Exit ends the row.
//
// No session mint, no token-in-URL, no client bind, no re-mint — so the whole
// class of failures the old mint-based design hit (and the escalation risk) is
// gone by construction. OFF by default (IMPERSONATION_ENABLED); ships dormant.
// See review/admin-impersonation-redesign-plan.html §6.

import { v } from "convex/values";
import {
  query,
  mutation,
  internalMutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { platformAdminMutation } from "./lib/customFunctions";
import { getAuthSessionId } from "@convex-dev/auth/server";
import { getSessionOwner, getActiveOverlay } from "./lib/auth";
import {
  isImpersonationEnabled,
  impersonationTtlMs,
  isOverlayExpired,
} from "./lib/impersonationConfig";
import { isEnrolledScholar } from "./lib/enrollmentStanding";
import { ROLES, isPlatformAdminRole } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";

type ImpersonationTargetArgs = {
  targetUserId?: Id<"users">;
  targetHandle?: string;
};

async function resolveImpersonationTarget(
  ctx: QueryCtx | MutationCtx,
  admin: Doc<"users">,
  { targetUserId, targetHandle }: ImpersonationTargetArgs,
) {
  let resolvedId: Id<"users"> | null = targetUserId ?? null;
  if (!resolvedId && targetHandle) {
    const handle = targetHandle.trim();
    if (handle) {
      const byUsername = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", handle))
        .first();
      resolvedId = byUsername?._id ?? ctx.db.normalizeId("users", handle);
    }
  }
  if (!resolvedId) {
    throw new Error(
      targetHandle
        ? `No user matches "${targetHandle}" (try a username or a user id)`
        : "No target specified",
    );
  }

  if (resolvedId === admin._id) {
    throw new Error("Cannot view as yourself");
  }
  const target = await ctx.db.get(resolvedId);
  if (!target) throw new Error("No such user");

  if (isPlatformAdminRole(target.role)) {
    throw new Error("Cannot view as a platform admin");
  }
  const targetMemberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", resolvedId))
    .collect();
  if (targetMemberships.some((membership) => isPlatformAdminRole(membership.role))) {
    throw new Error("Cannot view as a platform admin");
  }

  return target;
}

async function requirePlatformAdminSessionOwner(ctx: QueryCtx | MutationCtx) {
  const owner = await getSessionOwner(ctx);
  if (!owner) throw new Error("Not authenticated");
  if (isPlatformAdminRole(owner.role)) return owner;

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", owner._id))
    .collect();
  if (memberships.some((membership) => isPlatformAdminRole(membership.role))) {
    return owner;
  }
  throw new Error("Platform admin access required");
}

/** Public flag read so the UI can show/hide the "View as" surfaces. */
export const isEnabled = query({
  args: {},
  handler: async () => isImpersonationEnabled(),
});

/**
 * Start viewing as a target. Platform-admin only. Records an overlay on the
 * ADMIN'S OWN session (getAuthSessionId) — no mint, no token. Enforces the
 * escalation guard (target is never a platform-admin, never self). Supersedes
 * any prior active overlay on this session so there's at most one.
 *
 * The target may be given as `targetUserId` (a Convex user id) OR `targetHandle`
 * (a username or an id string) — the latter powers /impersonate?user=<handle>,
 * so the URL can carry the friendly username (mirroring /dev-login?u=<username>)
 * instead of an opaque id.
 */
export const startImpersonation = platformAdminMutation({
  args: {
    targetUserId: v.optional(v.id("users")),
    targetHandle: v.optional(v.string()),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { targetUserId, targetHandle, reason }) => {
    if (!isImpersonationEnabled()) {
      throw new Error("Impersonation is not enabled on this deployment.");
    }
    const admin = ctx.user; // requirePlatformAdmin (real owner — no overlay yet)

    const target = await resolveImpersonationTarget(ctx, admin, {
      targetUserId,
      targetHandle,
    });

    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) throw new Error("No active session");
    const now = Date.now();

    // At most one active overlay per session — end any prior one.
    const prior = await ctx.db
      .query("impersonationOverlays")
      .withIndex("by_admin_session", (q) =>
        q.eq("adminSessionId", sessionId as Id<"authSessions">).eq("active", true),
      )
      .collect();
    for (const p of prior) {
      await ctx.db.patch(p._id, { active: false, endedAt: now });
    }

    await ctx.db.insert("impersonationOverlays", {
      adminUserId: admin._id,
      adminSessionId: sessionId as Id<"authSessions">,
      targetUserId: target._id,
      reason,
      startedAt: now,
      expiresAt: now + impersonationTtlMs(), // hard TTL — auto-expires (see impersonationConfig)
      active: true,
    });
    await ctx.db.insert("auditLog", {
      actorUserId: admin._id,
      action: "impersonation.start",
      targetUserId: target._id,
      at: now,
      detail: reason,
    });
    return { ok: true as const };
  },
});

/**
 * Atomically pivot an active scholar view-as overlay to another user. This
 * authorizes against the REAL session owner, while ordinary platform-admin
 * mutations intentionally continue to resolve as the impersonated target.
 */
export const switchImpersonationTarget = mutation({
  args: { targetUserId: v.id("users") },
  handler: async (ctx, { targetUserId }) => {
    if (!isImpersonationEnabled()) {
      throw new Error("Impersonation is not enabled on this deployment.");
    }
    const overlay = await getActiveOverlay(ctx);
    if (!overlay) throw new Error("No active view-as session");

    const admin = await requirePlatformAdminSessionOwner(ctx);
    const target = await resolveImpersonationTarget(ctx, admin, { targetUserId });
    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) throw new Error("No active session");
    const now = Date.now();

    const active = await ctx.db
      .query("impersonationOverlays")
      .withIndex("by_admin_session", (q) =>
        q.eq("adminSessionId", sessionId as Id<"authSessions">).eq("active", true),
      )
      .collect();
    for (const current of active) {
      await ctx.db.patch(current._id, { active: false, endedAt: now });
    }

    await ctx.db.insert("impersonationOverlays", {
      adminUserId: admin._id,
      adminSessionId: sessionId as Id<"authSessions">,
      targetUserId: target._id,
      reason: overlay.reason,
      startedAt: now,
      expiresAt: now + impersonationTtlMs(),
      active: true,
    });
    await ctx.db.insert("auditLog", {
      actorUserId: admin._id,
      action: "impersonation.switch",
      targetUserId: target._id,
      at: now,
      detail: `from ${overlay.targetUserId}`,
    });
    return { ok: true as const };
  },
});

/**
 * Stop viewing-as. A PLAIN mutation (not gated, not identity-swapped): it must
 * run FROM the impersonated session and act on the REAL session owner. It
 * reads getAuthSessionId directly (never requireUser, which would resolve the
 * target) and ends the active overlay for that session. Idempotent.
 */
export const stopImpersonation = mutation({
  args: {},
  handler: async (ctx) => {
    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) return { ok: false as const };
    const now = Date.now();
    const active = await ctx.db
      .query("impersonationOverlays")
      .withIndex("by_admin_session", (q) =>
        q.eq("adminSessionId", sessionId as Id<"authSessions">).eq("active", true),
      )
      .collect();
    for (const ov of active) {
      await ctx.db.patch(ov._id, { active: false, endedAt: now });
      await ctx.db.insert("auditLog", {
        actorUserId: ov.adminUserId,
        action: "impersonation.stop",
        targetUserId: ov.targetUserId,
        at: now,
      });
    }
    return { ok: active.length > 0 };
  },
});

/**
 * Banner driver. For the CURRENT session, returns the active view-as pair or
 * null. A plain (non-throwing) query — it renders app-wide, including on
 * unauthenticated frames, so it must never throw. Reads the REAL session owner
 * for the admin label (getSessionOwner), the overlay for the target.
 */
export const myImpersonation = query({
  args: {},
  handler: async (ctx) => {
    // getActiveOverlay applies the enabled-flag, session scoping, AND the TTL —
    // so an expired overlay yields null here too (banner drops with the swap).
    const overlay = await getActiveOverlay(ctx);
    if (!overlay) return null;
    const target = await ctx.db.get(overlay.targetUserId);
    const admin = await getSessionOwner(ctx); // real owner (overlay-independent)
    let switchableScholars: Array<{
      id: string;
      name: string;
      username: string | null;
      image: null;
      readingLevel: null;
      gradeLevel: null;
      dateOfBirth: null;
      lastMessageAt: null;
      groupIds: string[];
      isMine: false;
      enrollmentStanding: "enrolled";
    }> = [];

    if (
      target?.role === ROLES.SCHOLAR &&
      admin &&
      isPlatformAdminRole(admin.role)
    ) {
      const institutions = await ctx.db.query("institutions").collect();
      const primaryInstitution =
        institutions.find((institution) => institution.isPrimary) ??
        institutions[0] ??
        null;
      const targetInstitution = target.institutionId
        ? await ctx.db.get(target.institutionId)
        : primaryInstitution;
      const scholars = await ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
        .collect();

      switchableScholars = scholars
        .filter(
          (scholar) =>
            isEnrolledScholar(scholar) &&
            (targetInstitution
              ? scholar.institutionId === targetInstitution._id ||
                (targetInstitution.isPrimary && scholar.institutionId === undefined)
              : scholar.institutionId === undefined),
        )
        .map((scholar) => ({
          id: String(scholar._id),
          name: scholar.name ?? scholar.username ?? "(unnamed)",
          username: scholar.username ?? null,
          image: null,
          readingLevel: null,
          gradeLevel: null,
          dateOfBirth: null,
          lastMessageAt: null,
          groupIds: [],
          isMine: false as const,
          enrollmentStanding: "enrolled" as const,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }

    return {
      targetUserId: overlay.targetUserId,
      targetName: target?.name ?? target?.username ?? "Unknown user",
      targetUsername: target?.username ?? null,
      adminName: admin?.name ?? admin?.username ?? "Unknown admin",
      adminUsername: admin?.username ?? null,
      switchableScholars,
      startedAt: overlay.startedAt,
      expiresAt: overlay.expiresAt ?? null,
    };
  },
});

/**
 * Sweep stale "view-as" overlays (hourly cron). Deactivates any still-`active`
 * overlay that is either past its TTL OR orphaned — its anchor authSession no
 * longer exists (the admin signed out, or the session row was expired away). A
 * closed tab that never hit Exit is thus cleaned up instead of showing `active`
 * for the ~30-day life of the login. Read-time enforcement (getActiveOverlay
 * ignores expired overlays) already makes them inert; this keeps the table +
 * audit trail honest. Tiny table (view-as is rare) → a full active-scan is fine.
 */
export const sweepStaleOverlays = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const active = await ctx.db
      .query("impersonationOverlays")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect();
    let ended = 0;
    for (const ov of active) {
      const expired = isOverlayExpired(ov, now);
      const orphaned = (await ctx.db.get(ov.adminSessionId)) === null;
      if (!expired && !orphaned) continue;
      await ctx.db.patch(ov._id, { active: false, endedAt: now });
      await ctx.db.insert("auditLog", {
        actorUserId: ov.adminUserId,
        action: "impersonation.expire",
        targetUserId: ov.targetUserId,
        at: now,
        detail: orphaned ? "session ended" : "ttl",
      });
      ended += 1;
    }
    return { ended, scanned: active.length };
  },
});
