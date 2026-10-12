// Bulk External-App grants — the STAFF surface for "give this app to a whole
// audience" (a scholarGroup or an institution). Writes/read the `appAudiences`
// join; the scholar-side launcher resolves these at read time (scholarApps.ts +
// lib/appAudiences.ts). Credentials never live here — a grant provisions the
// TILE, never a shared password (each kid's login stays per-scholar).
//
// Gated by scholarAdminMutation/Query (teacher / admin / operations staff) for every
// scope — single scholar, group, and school-wide alike — matching today's
// per-scholar management (plan §10, decided). See
// review/bulk-external-apps-plan.html §6 & §9.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { scholarAdminMutation, scholarAdminQuery } from "./lib/customFunctions";
import {
  scholarIdsForInstitution,
  scholarInstitutionId,
} from "./lib/scholarEnrollment";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  requireScholarAdminScope,
  resolveAppByName,
  resolveGroupByName,
  resolveInstitutionByName,
  resolveScholarByNameOrUsername,
  isScholarInScope,
  isGroupInScope,
  isInstitutionInScope,
  groupLabelInScope,
  HIDDEN_GROUP,
  type ExternalAppScope,
} from "./lib/externalAppsResolve";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import { timeZoneForInstitution } from "./lib/institutionTime";
import {
  APP_PLACEMENT_GRACE_MS,
  APP_PLACEMENT_LEAD_MS,
  parseHHMM,
} from "./masterSchedule";
import { assertCuratableInstitution } from "./lib/access";
import { scheduleUnlockRevocationCheck } from "./lib/deviceAppUnlockScheduling";
import {
  assignmentIdsCovering,
  catalogAppIsVisible,
  openAppPushesForInstitution,
  scholarAppAccessAt,
  type AppAuthority,
  type ScholarAppAccess,
} from "./lib/deviceAppProjection";
import {
  isPushShowing,
  liveUntil,
  pushCoversScholar,
  pushExpiresAt,
} from "./lib/pushes";
import { groupIdsForScholar } from "./lib/scholarGroupMembership";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
} from "../shared/institutionDay";
import { shiftScheduleWeekStartMs } from "../shared/scheduleWeek";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import { resolveAppIconUrl } from "./lib/externalAppIconUrl";
import { managedNativeAppKeyForApp } from "./lib/managedNativeApps";
import { externalAppKind } from "../shared/appKind";
import { auditManagedClaim } from "./lib/managedDeviceClaimState";
import {
  resolveInstitutionLens,
  scholarInstitutionReadableInLens,
} from "./lib/institutionLens";
import { audienceInstitutionId } from "./lib/auditLog";

/**
 * ⚠️ TENANCY GATE for every audience-grant WRITE (assign / unassign / enable
 * toggle). A role check alone is a cross-tenant leak (CLAUDE.md → "Isolation is
 * per-handler, so it is your job"): without this, a teacher at school B could
 * revoke/disable school A's grants (a DoS on another school's kids) or grant an
 * app to school A's group — and re-point a shared app's grants to bypass the
 * customApps.updateStaticApp tenant gate.
 *
 * We gate the AUDIENCE (the group/school you are granting TO), never the app.
 * `externalApps` deliberately has NO institutionId: the catalog is GLOBAL and
 * shared on purpose (multiple schools legitimately grant the same third-party
 * app), so an app-level institution check would break real sharing. The
 * tenancy that matters is who you are granting to. DO NOT "helpfully" add an
 * app-level institution check here — it would be wrong.
 *
 * The group branch gates on the group's parent SCHOOL, not on roster overlap —
 * see the comment inside. Roster-overlap semantics are correct for read paths
 * and wrong for a write gate.
 *
 * `audienceId` is a plain string (one column for both kinds), so we normalize it
 * exactly as `resolveAudienceMeta` does. But this is a WRITE gate, so it FAILS
 * CLOSED: an id that does not normalize is REFUSED, not silently skipped. That
 * deliberately differs from `resolveAudienceMeta`'s read-side leniency (which
 * returns exists:false for a dangling/foreign id) — a write must never fall
 * through the gate on a malformed audience id.
 */
async function requireAudienceInScope(
  ctx: MutationCtx,
  user: Doc<"users">,
  kind: AudienceKind,
  audienceId: string,
): Promise<void> {
  if (kind === "group") {
    const gid = ctx.db.normalizeId("scholarGroups", audienceId);
    if (!gid) throw new Error("Forbidden: unresolvable group audience");
    const group = await ctx.db.get(gid);
    // A write gate refuses a dangling id rather than treating "no such group"
    // as harmless (assign would catch it later; unassign/enable would not).
    if (!group) throw new Error("Forbidden: unresolvable group audience");
    // Gate on the group's STAMPED parent school, mirroring
    // scholarGroups.requireGroupInstitutionAccess — deliberately NOT the
    // roster-based requireGroupScholarAccess, whose read-side leniency is a
    // hole here: it forbids only a WHOLLY foreign group, so an EMPTY foreign
    // group (never forbidden) or a mixed group containing a single scholar you
    // can reach would both let you write a grant onto another school's group.
    // The lens treats a legacy UNSTAMPED group as the primary
    // school, matching how the rest of the lens layer reads those.
    const lens = await resolveInstitutionLens(ctx, user, "all");
    if (!scholarInstitutionReadableInLens(lens, group.institutionId)) {
      throw new Error("Forbidden: group is not in your institution");
    }
    return;
  }
  const iid = ctx.db.normalizeId("institutions", audienceId);
  if (!iid) throw new Error("Forbidden: unresolvable institution audience");
  // Throws "Forbidden: that institution isn't in your context" for a foreign
  // school.
  await assertCuratableInstitution(ctx, user, iid);
}

/**
 * Is one grant's audience inside the caller's tenancy scope? Used to filter the
 * grant/scholar detail returned by BOTH the bot-facing reads (aideListApps /
 * aideGetAppAccess) AND the web `scholarAdminQuery` reads (listAppsWithAudiences
 * / listAudiencesForApp / enablementForApp) — either would otherwise report
 * another school's group names, school names, and scholar facepiles to a teacher
 * at a different school. The web reads build the same scope the aide path uses,
 * via `requireScholarAdminScope(ctx, ctx.user._id)`.
 *
 * This scopes the GRANTS within each app row; it never drops an app from the
 * catalog. Browsable cross-school discovery of which apps EXIST is a deliberate
 * feature (a school must be able to see an app and adopt it) — see
 * coreListAppsWithAudiences, which always returns one row per app.
 */
async function audienceInScope(
  ctx: QueryCtx,
  kind: AudienceKind,
  audienceId: string,
  scope: ExternalAppScope,
): Promise<boolean> {
  if (kind === "institution") {
    const iid = ctx.db.normalizeId("institutions", audienceId);
    return !!iid && isInstitutionInScope(scope, iid);
  }
  const gid = ctx.db.normalizeId("scholarGroups", audienceId);
  const group = gid ? await ctx.db.get(gid) : null;
  return !!group && isGroupInScope(scope, group);
}

/** Keep only the grants whose audience is inside `scope`. A `null` scope
 *  (unrestricted — e.g. a platform admin, or an internal caller passing none)
 *  keeps every grant. Filters grants ONLY; never removes an app from a list. */
async function grantsInScope(
  ctx: QueryCtx,
  grants: Doc<"appAudiences">[],
  scope: ExternalAppScope | null,
): Promise<Doc<"appAudiences">[]> {
  if (!scope) return grants;
  const checked = await Promise.all(
    grants.map(async (g) => ({
      g,
      ok: await audienceInScope(ctx, g.audienceKind, g.audienceId, scope),
    })),
  );
  return checked.filter((r) => r.ok).map((r) => r.g);
}

const audienceKind = v.union(v.literal("group"), v.literal("institution"));
type AudienceKind = "group" | "institution";
type AppGrantVia = "ui" | "aide" | "slack";

type AudienceMeta = {
  label: string;
  emoji: string | null;
  memberCount: number;
  exists: boolean;
};

/** A grant's audience → display label + live member count (for chips + the
 *  "grants to N scholars now" footer). Returns exists:false for a dangling id. */
export async function resolveAudienceMeta(
  ctx: QueryCtx,
  kind: AudienceKind,
  audienceId: string,
): Promise<AudienceMeta> {
  if (kind === "group") {
    const gid = ctx.db.normalizeId("scholarGroups", audienceId);
    const group = gid ? await ctx.db.get(gid) : null;
    if (!group) {
      return { label: "Unknown group", emoji: null, memberCount: 0, exists: false };
    }
    return {
      label: group.name,
      emoji: group.emoji ?? null,
      memberCount: group.scholarIds.length,
      exists: true,
    };
  }
  const iid = ctx.db.normalizeId("institutions", audienceId);
  const inst = iid ? await ctx.db.get(iid) : null;
  if (!iid || !inst) {
    return { label: "Unknown school", emoji: null, memberCount: 0, exists: false };
  }
  const memberCount = (await scholarIdsForInstitution(ctx, iid)).size;
  return {
    label: inst.name,
    emoji: inst.emoji ?? null,
    memberCount,
    exists: true,
  };
}

/** Find the single existing grant row for (app, audience), if any. */
async function findGrant(
  ctx: QueryCtx,
  appId: Id<"externalApps">,
  kind: AudienceKind,
  audienceId: string,
): Promise<Doc<"appAudiences"> | null> {
  return await ctx.db
    .query("appAudiences")
    .withIndex("by_audience", (q) =>
      q.eq("audienceKind", kind).eq("audienceId", audienceId),
    )
    .filter((q) => q.eq(q.field("appId"), appId))
    .first();
}

/** The actual scholar ids an audience currently resolves to (not just the
 *  count `resolveAudienceMeta` reports) — used to know who to re-check for a
 *  managed-native unlock after their grant is removed/disabled. Read BEFORE
 *  the grant write so a dangling/empty audience still resolves cleanly. */
async function scholarIdsForAudience(
  ctx: QueryCtx,
  kind: AudienceKind,
  audienceId: string,
): Promise<Id<"users">[]> {
  if (kind === "group") {
    const gid = ctx.db.normalizeId("scholarGroups", audienceId);
    const group = gid ? await ctx.db.get(gid) : null;
    return group?.scholarIds ?? [];
  }
  const iid = ctx.db.normalizeId("institutions", audienceId);
  if (!iid) return [];
  return [...(await scholarIdsForInstitution(ctx, iid))];
}

/**
 * Grant a catalog app to a whole audience (a scholarGroup or an institution),
 * in ONE action that stays true as membership changes. Idempotent per
 * (app, audience): a second call re-enables/updates the existing grant rather
 * than duplicating it. Teacher/admin/operations staff.
 */
export const assignToAudience = scholarAdminMutation({
  args: {
    appId: v.id("externalApps"),
    audienceKind,
    audienceId: v.string(),
    // Default true; pass false to create a paused grant.
    enabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => coreAssignToAudience(ctx, args, ctx.user),
});

// ── Shared audience-grant core (public mutations + aide* wrappers) ─────────

async function coreAssignToAudience(
  ctx: MutationCtx,
  args: {
    appId: Id<"externalApps">;
    audienceKind: AudienceKind;
    audienceId: string;
    enabled?: boolean;
  },
  user: Doc<"users">,
  via: AppGrantVia = "ui",
): Promise<{
  grantId: Id<"appAudiences">;
  created: boolean;
  memberCount: number;
}> {
  await requireAudienceInScope(ctx, user, args.audienceKind, args.audienceId);
  const app = await ctx.db.get(args.appId);
  if (!app) throw new Error("App not found");
  const meta = await resolveAudienceMeta(ctx, args.audienceKind, args.audienceId);
  if (!meta.exists) {
    throw new Error(
      args.audienceKind === "group" ? "Group not found" : "School not found",
    );
  }
  const enabled = args.enabled ?? true;
  const existing = await findGrant(
    ctx,
    args.appId,
    args.audienceKind,
    args.audienceId,
  );
  // The OPENING edge nudges too. Under the lease model only revocation
  // needed a hook — granting access could never require closing an unlock —
  // so this path was silent. A managed device's allowlist is now a projection
  // of exactly this fact, and "a teacher grants the app, the kid taps it" is
  // the workflow the inversion exists to make instant, so a new or re-enabled
  // grant marks every covered scholar's device dirty. Latency only: the
  // reconciler re-derives the set from scratch either way.
  const nudge = async () => {
    const scholarIds = await scholarIdsForAudience(
      ctx,
      args.audienceKind,
      args.audienceId,
    );
    await scheduleUnlockRevocationCheck(ctx, {
      externalAppId: args.appId,
      scholarIds,
    });
  };
  if (existing) {
    if (existing.enabled !== enabled) {
      await ctx.db.patch(existing._id, { enabled });
      await auditManagedClaim(
        ctx,
        user._id,
        enabled ? "app-grant.audience-enabled" : "app-grant.audience-disabled",
        user._id,
        JSON.stringify({
          appId: args.appId,
          audienceKind: args.audienceKind,
          audienceId: args.audienceId,
          previousEnabled: existing.enabled,
          newEnabled: enabled,
          via,
        }),
        await audienceInstitutionId(ctx, args.audienceKind, args.audienceId),
      );
      await nudge();
    }
    return { grantId: existing._id, created: false, memberCount: meta.memberCount };
  }
  const grantId = await ctx.db.insert("appAudiences", {
    appId: args.appId,
    audienceKind: args.audienceKind,
    audienceId: args.audienceId,
    enabled,
    addedBy: user._id,
  });
  await auditManagedClaim(
    ctx,
    user._id,
    "app-grant.audience-assigned",
    user._id,
    JSON.stringify({
      appId: args.appId,
      audienceKind: args.audienceKind,
      audienceId: args.audienceId,
      previousEnabled: null,
      newEnabled: enabled,
      via,
    }),
    await audienceInstitutionId(ctx, args.audienceKind, args.audienceId),
  );
  if (enabled) await nudge();
  return { grantId, created: true, memberCount: meta.memberCount };
}

async function coreUnassignAudience(
  ctx: MutationCtx,
  args: {
    appId: Id<"externalApps">;
    audienceKind: AudienceKind;
    audienceId: string;
  },
  user: Doc<"users">,
  via: AppGrantVia = "ui",
): Promise<{ removed: number }> {
  await requireAudienceInScope(ctx, user, args.audienceKind, args.audienceId);
  const rows = await ctx.db
    .query("appAudiences")
    .withIndex("by_audience", (q) =>
      q.eq("audienceKind", args.audienceKind).eq("audienceId", args.audienceId),
    )
    .filter((q) => q.eq(q.field("appId"), args.appId))
    .collect();
  if (rows.length === 0) return { removed: 0 };
  // Resolve BEFORE deleting, so the audience is still there to enumerate.
  const scholarIds = await scholarIdsForAudience(
    ctx,
    args.audienceKind,
    args.audienceId,
  );
  for (const r of rows) await ctx.db.delete(r._id);
  await auditManagedClaim(
    ctx,
    user._id,
    "app-grant.audience-unassigned",
    user._id,
    JSON.stringify({
      appId: args.appId,
      audienceKind: args.audienceKind,
      audienceId: args.audienceId,
      previousEnabled: rows[0].enabled,
      newEnabled: "removed",
      via,
    }),
    await audienceInstitutionId(ctx, args.audienceKind, args.audienceId),
  );
  await scheduleUnlockRevocationCheck(ctx, {
    externalAppId: args.appId,
    scholarIds,
  });
  return { removed: rows.length };
}

/**
 * Remove a grant (the whole "app → audience" fact). The tile disappears for
 * everyone the grant covered; any per-scholar credentials parked on a
 * `source:"grant"` scholarApps row are RETAINED (re-attach on re-grant).
 * Teacher/admin/operations staff. Idempotent.
 */
export const unassignAudience = scholarAdminMutation({
  args: {
    appId: v.id("externalApps"),
    audienceKind,
    audienceId: v.string(),
  },
  handler: async (ctx, args) => coreUnassignAudience(ctx, args, ctx.user),
});

/**
 * Pause / resume a grant without deleting it (a paused grant resolves to no
 * tiles). Teacher/admin/operations staff.
 */
export const setAudienceEnabled = scholarAdminMutation({
  args: {
    appId: v.id("externalApps"),
    audienceKind,
    audienceId: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    // Flipping `enabled` on a foreign school's grant is exactly the DoS (and the
    // reach-re-pointing move), so gate it identically to assign/unassign.
    await requireAudienceInScope(ctx, ctx.user, args.audienceKind, args.audienceId);
    const grant = await findGrant(
      ctx,
      args.appId,
      args.audienceKind,
      args.audienceId,
    );
    if (!grant) throw new Error("Grant not found");
    if (grant.enabled !== args.enabled) {
      await ctx.db.patch(grant._id, { enabled: args.enabled });
      await auditManagedClaim(
        ctx,
        ctx.user._id,
        args.enabled
          ? "app-grant.audience-enabled"
          : "app-grant.audience-disabled",
        ctx.user._id,
        JSON.stringify({
          appId: args.appId,
          audienceKind: args.audienceKind,
          audienceId: args.audienceId,
          previousEnabled: grant.enabled,
          newEnabled: args.enabled,
          via: "ui",
        }),
        await audienceInstitutionId(ctx, args.audienceKind, args.audienceId),
      );
      // BOTH edges — a managed device's allowlist is a projection of this
      // grant, so re-enabling one is as much an allowlist change as pausing it.
      const scholarIds = await scholarIdsForAudience(
        ctx,
        args.audienceKind,
        args.audienceId,
      );
      await scheduleUnlockRevocationCheck(ctx, {
        externalAppId: args.appId,
        scholarIds,
      });
    }
  },
});

/** The audiences one app is granted to, resolved to labels + counts. Scoped to
 *  the caller's tenant: a staffer sees only grants to their own school's groups
 *  and institution, never another school's. */
export const listAudiencesForApp = scholarAdminQuery({
  args: { appId: v.id("externalApps") },
  handler: async (ctx, args) => {
    const scope = await requireScholarAdminScope(ctx, ctx.user._id);
    const allGrants = await ctx.db
      .query("appAudiences")
      .withIndex("by_app", (q) => q.eq("appId", args.appId))
      .collect();
    const grants = await grantsInScope(ctx, allGrants, scope);
    return await Promise.all(
      grants.map(async (g) => {
        const meta = await resolveAudienceMeta(ctx, g.audienceKind, g.audienceId);
        return {
          grantId: g._id,
          audienceKind: g.audienceKind,
          audienceId: g.audienceId,
          enabled: g.enabled,
          label: meta.label,
          emoji: meta.emoji,
          memberCount: meta.memberCount,
        };
      }),
    );
  },
});

/**
 * Current *complete* enablement for one app — the seed for the manage-access
 * drawer's check/uncheck editor. Returns the granted group + institution ids
 * and the direct scholars (each with its scholarApps link id, so the editor can
 * remove a direct add via `removeFromScholar`). "Direct" matches the Apps-tab
 * definition: manual/default rows only, never grant-parked credential rows.
 * Scoped to the caller's tenant — foreign-school grants and scholars are omitted
 * so the editor never shows or lets a staffer touch another school's access.
 */
export const enablementForApp = scholarAdminQuery({
  args: { appId: v.id("externalApps") },
  handler: async (ctx, { appId }) => {
    const scope = await requireScholarAdminScope(ctx, ctx.user._id);
    const allGrants = await ctx.db
      .query("appAudiences")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    const grants = await grantsInScope(ctx, allGrants, scope);
    const groupIds = grants
      .filter((g) => g.audienceKind === "group")
      .map((g) => g.audienceId);
    const institutionIds = grants
      .filter((g) => g.audienceKind === "institution")
      .map((g) => g.audienceId);
    const links = await ctx.db
      .query("scholarApps")
      .withIndex("by_app", (q) => q.eq("appId", appId))
      .collect();
    const direct = links
      .filter(
        (l) =>
          (l.source === "manual" || l.source === "default") &&
          isScholarInScope(scope, l.scholarId),
      )
      .map((l) => ({ scholarId: l.scholarId, scholarAppId: l._id }));
    return { groupIds, institutionIds, direct };
  },
});

/**
 * The Apps tab home (§6.2): every non-archived catalog app with its live
 * audiences (as chips) + how many scholars have it directly (the "+N scholars"
 * chip). The one place to see every app AND who has it. The catalog stays whole
 * (every non-archived app appears), but audiences, the direct count, and the
 * facepile are scoped to the caller's tenant.
 */
export const listAppsWithAudiences = scholarAdminQuery({
  args: { groupId: v.optional(v.id("scholarGroups")) },
  handler: async (ctx, { groupId }) => {
    const scope = await requireScholarAdminScope(ctx, ctx.user._id);
    return coreListAppsWithAudiences(ctx, {
      includeArchived: false,
      groupId,
      scope,
    });
  },
});

/** Shared row-builder for the Apps-home list + the aide `list_external_apps`
 *  tool. `includeArchived` keeps archived apps (flagged) so the bot can list
 *  and un-archive them; the web Apps tab passes false to hide them as before. */
async function coreListAppsWithAudiences(
  ctx: QueryCtx,
  opts: {
    includeArchived: boolean;
    groupId?: Id<"scholarGroups">;
    /** The caller's tenant scope — narrows audiences, the direct count, and the
     *  facepile to that tenant. Now set on BOTH the web (listAppsWithAudiences)
     *  and bot (aideListApps) surfaces; a null scope is unrestricted (keeps
     *  every grant) and is used only by internal callers that pass none. The
     *  scope never filters the app rows themselves — the catalog stays whole. */
    scope?: ExternalAppScope | null;
  },
) {
  const scope = opts.scope ?? null;
  const group = opts.groupId ? await ctx.db.get(opts.groupId) : null;
  // Scope-check the group, with the SAME message as "doesn't exist" — otherwise
  // a valid FOREIGN id succeeds where an invalid one throws, which is an
  // existence oracle for another school's group topology. (It also silently
  // suppressed the caller's own institution grants via groupFiltered below.)
  // This refuses the ARGUMENT; it never filters the app rows — the catalog
  // stays whole either way.
  if (opts.groupId) {
    if (!group) throw new Error("Group not found");
    // Refuse only a group demonstrably owned by ANOTHER school — same message as
    // "doesn't exist", so a valid foreign id is not an existence oracle for
    // another school's group topology (it also silently suppressed the caller's
    // own institution grants via groupFiltered below).
    //
    // A LEGACY UNSTAMPED group (no institutionId) is deliberately NOT refused:
    // isGroupInScope falls back to whole-roster containment there, which reports
    // false for an empty legacy group — i.e. a teacher's own pre-stamping group,
    // which must keep the historical all-institution fallback. Its grants are
    // still filtered by audienceInScope, so nothing foreign leaks either way;
    // the residual is existence of an unstamped group, and those are stamped
    // lazily by the membership mutations.
    if (scope && group.institutionId && !isGroupInScope(scope, group)) {
      throw new Error("Group not found");
    }
  }
  const all = await ctx.db.query("externalApps").collect();
  const apps = opts.includeArchived ? all : all.filter((a) => !a.archived);
  const rows = await Promise.all(
    apps.map(async (app) => {
      const grants = await ctx.db
        .query("appAudiences")
        .withIndex("by_app", (q) => q.eq("appId", app._id))
        .collect();
      const groupFiltered =
        group?.institutionId === undefined
          ? grants
          : grants.filter(
              (grant) =>
                grant.audienceKind !== "institution" ||
                grant.audienceId === String(group.institutionId),
            );
      const applicableGrants = await grantsInScope(ctx, groupFiltered, scope);
      const audiences = await Promise.all(
        applicableGrants.map(async (g) => {
          const meta = await resolveAudienceMeta(
            ctx,
            g.audienceKind,
            g.audienceId,
          );
          return {
            grantId: g._id,
            audienceKind: g.audienceKind,
            audienceId: g.audienceId,
            enabled: g.enabled,
            label: meta.label,
            emoji: meta.emoji,
            memberCount: meta.memberCount,
          };
        }),
      );
      // Direct adds (a teacher added it to one scholar) — NOT grant-parked
      // credential rows, which are visibility-neutral.
      const links = await ctx.db
        .query("scholarApps")
        .withIndex("by_app", (q) => q.eq("appId", app._id))
        .collect();
      const directLinks = links.filter(
        (l) =>
          (l.source === "manual" || l.source === "default") &&
          (!scope || isScholarInScope(scope, l.scholarId)),
      );
      const directScholarCount = directLinks.length;
      // Tiny slice of scholar info for the DRY <ScholarFacepile> — first
      // few avatars + the full count drives the "+M" overflow badge.
      const directFacepile = await Promise.all(
        directLinks.slice(0, 5).map(async (l) => {
          const u = await ctx.db.get(l.scholarId);
          return {
            _id: l.scholarId,
            name: u?.name ?? u?.username ?? null,
            image: u?.image ?? null,
            username: u?.username ?? null,
          };
        }),
      );
      return {
        _id: app._id,
        name: app.name,
        webUrl: app.webUrl,
        // The native launch scheme (already consumed by the native AppLauncher,
        // schema `externalApps.nativeUrlScheme`). Surfaced here only so the web
        // Preview helper can tell "native app with no web page to show" from
        // "plain web app"; the teacher UI never renders the raw scheme.
        nativeUrlScheme: app.nativeUrlScheme ?? null,
        iconUrl: await resolveAppIconUrl(ctx, app),
        iconEmoji: app.iconEmoji ?? null,
        color: app.color ?? null,
        // Unset means "scholarApp" per the schema (externalApps.credentialSource),
        // so report the effective value rather than a null the model would have
        // to know the default for.
        credentialSource: app.credentialSource ?? "scholarApp",
        defaultForNewScholars: !!app.defaultForNewScholars,
        archived: !!app.archived,
        // Non-null only for a catalog entry whose nativeUrlScheme matches a
        // profile-managed native app (PR #3212's per-device MDM unlock) — the
        // teacher UI uses this to explain the one-app-at-a-time unlock, never
        // to expose the underlying bundle id/scheme/SimpleMDM identifiers.
        managedNativeAppKey: managedNativeAppKeyForApp(app),
        // The app's KIND — web website / Rabbithole custom app / native iPad
        // app — derived ONCE here (shared/appKind.ts) so the teacher Apps
        // filter and the aide's list_external_apps tool read one canonical
        // signal, never a client-side re-parse of the launch URL.
        appKind: externalAppKind(app),
        audiences,
        directScholarCount,
        directFacepile,
      };
    }),
  );
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// ── "Who can use this app" read (audiences + direct scholars, by name) ─────

/** Resolve one app's full enablement to display labels: its group + institution
 *  grants (with live member counts + enabled state) and its DIRECT scholars. */
// ─── Block-scoped access ────────────────────────────────────────────────────
//
// An app reaches a scholar by THREE authorities, and `launcherShowsApp`
// (lib/appAudiences.ts) checks all three: a direct `scholarApps` row, an
// `appAudiences` grant, and a LIVE PUSH. `coreGetAppAccess` below answers only
// the first two, so for any app that follows the 2026-09-15 block-scoped
// ruling — access from a `schedulePlacements` row carrying `externalAppId`,
// deliberately NOT a standing grant — it returned "0 groups, 0 schools, 0
// scholars", which is indistinguishable from genuinely revoked.
//
// That is not a cosmetic gap. On 2026-09-21 it reported a correctly-configured
// Scratch as ungranted; the agent reading it told two people the grants had
// "got dropped somewhere in the reshuffle" and recommended restoring the
// standing grants, which was approved mid-class and undid the block-scoping.
// The zeros were true; the sentence built on them was not.

const LOOKAROUND_MS = 2 * 60 * 60_000; // Andy, 2026-09-21: now ± 2 hours.

const WEEKDAY_LABEL = ["", "Mon", "Tue", "Wed", "Thu", "Fri"] as const;

/**
 * Shift an "HH:MM" wall-clock label by whole minutes, for DESCRIBING a
 * recurring window ("14:50-16:40"). Wall-clock arithmetic is correct here and
 * only here: a recurring placement has no single instant to convert, and the
 * block's own start/end are stored as local HH:MM. Absolute instants (a
 * materialized push) are formatted from epoch ms in the institution's zone
 * instead — never from these strings.
 */
export function shiftLocalLabel(hhmm: string, deltaMinutes: number): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const total = h * 60 + m + deltaMinutes;
  // Wrap rather than clamp: clamping would silently misreport a window that
  // genuinely crosses midnight, and a wrong time reads as authoritative.
  const wrapped = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(
    wrapped % 60,
  ).padStart(2, "0")}`;
}

export function localInstant(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleString("en-CA", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The clocked half of "who can use this app": the recurring placements that
 * grant it (`blockScoped`) and every push of it (`appPushAccess`, below).
 *
 * Tenancy for the recurring rule rides on the placement's GROUP being in the
 * caller's scope (`isGroupInScope`).
 */
async function appScheduleAccess(
  ctx: QueryCtx,
  appId: Id<"externalApps">,
  scope: ExternalAppScope | null,
  now: number,
) {
  const placements = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_external_app", (q) => q.eq("externalAppId", appId))
    .collect();

  const blockScoped: Array<{
    group: string;
    day: string;
    block: string;
    blockLocal: string;
    windowLocal: string;
    teacher: string | null;
  }> = [];

  for (const p of placements) {
    // A shelved placement (no weekday/block) grants nothing — it is a
    // not-yet-scheduled item, so reporting it as access would overstate.
    if (p.weekday == null || p.blockId == null) continue;
    const group = await ctx.db.get(p.groupId);
    if (!group) continue;
    if (scope && !isGroupInScope(scope, group)) continue;
    const block = await ctx.db.get(p.blockId);
    if (!block) continue;

    const teacher = p.teacherId ? await ctx.db.get(p.teacherId) : null;
    blockScoped.push({
      group: group.name,
      day: WEEKDAY_LABEL[p.weekday] ?? `weekday ${p.weekday}`,
      block: block.label,
      blockLocal: `${block.startLocal}-${block.endLocal}`,
      windowLocal: `${shiftLocalLabel(
        block.startLocal,
        -APP_PLACEMENT_LEAD_MS / 60_000,
      )}-${shiftLocalLabel(block.endLocal, APP_PLACEMENT_GRACE_MS / 60_000)}`,
      teacher: teacher?.name ?? null,
    });
  }
  return { blockScoped, pushes: await appPushAccess(ctx, appId, scope, now) };
}

/**
 * Every push of this app, read from the tile's own source and judged by the
 * tile's own predicates: `openAppPushesForInstitution`, `isPushShowing` and
 * `catalogAppIsVisible`, as `livePushedAppIdsForScholar` uses them. So both
 * writers appear — a block placement's window (`source: "schedule"`) and a
 * teacher's push (`source: "teacher"`) — and `live` is true exactly when the
 * push is putting the app on its audience's tiles: including after its window
 * has ended if nothing has cleared it yet (`overrun`), and never for an
 * archived app, whose pushes stay open for staff to clear (TRA-337) while
 * every tile drops it. This read used to reach pushes only through
 * `schedulePlacements` and judge them with its own `startsAt <= now < endsAt`,
 * so both of those put the app on a tile while it reported nobody (TRA-426).
 *
 * A live push is always listed. One that is not live is listed only when its
 * window overlaps now ± 2h, so "opens at 14:50" stays distinguishable from
 * "not granted" without listing every planned block of the week.
 *
 * Tenancy rides on the push's own `institutionId`, the boundary
 * `pushCoversScholar` never crosses: only the caller's schools are read.
 */
async function appPushAccess(
  ctx: QueryCtx,
  appId: Id<"externalApps">,
  scope: ExternalAppScope | null,
  now: number,
) {
  const institutions =
    !scope || scope.institutions === "all"
      ? await ctx.db.query("institutions").collect()
      : (
          await Promise.all([...scope.institutions].map((id) => ctx.db.get(id)))
        ).filter((i): i is Doc<"institutions"> => i !== null);
  const appVisible = catalogAppIsVisible(await ctx.db.get(appId));

  const pushes: Array<{
    live: boolean;
    source: "schedule" | "teacher";
    group: string;
    windowLocal: string;
    liveUntilLocal: string | null;
    overrun: boolean;
    occurrenceDate: string | null;
    startsAt: number;
    endsAt: number | null;
  }> = [];

  for (const institution of institutions) {
    const { pushes: open, clock } = await openAppPushesForInstitution(
      ctx,
      institution._id,
      now,
    );
    for (const push of open) {
      if (push.target.kind !== "app" || push.target.externalAppId !== appId) {
        continue;
      }
      const live = appVisible && isPushShowing(push, clock);
      const endsAt = pushExpiresAt(push.timing);
      // `startsAt` is the planned time: the materializer always sets it and
      // a teacher's push never does, so fall back to `setAt`.
      const beginsAt = push.startsAt ?? push.setAt;
      if (beginsAt === undefined) continue;
      if (!live) {
        const startsWithin = Math.abs(beginsAt - now) <= LOOKAROUND_MS;
        const endsWithin =
          endsAt !== null && Math.abs(endsAt - now) <= LOOKAROUND_MS;
        const spansNow = beginsAt <= now && (endsAt === null || endsAt >= now);
        if (!startsWithin && !endsWithin && !spansNow) continue;
      }
      const group = await pushAudienceLabel(ctx, push.audience, institution.name);
      // A push to a deleted group covers nobody.
      if (group === null) continue;
      const until = live ? liveUntil(push, clock) : null;
      pushes.push({
        live,
        source: push.schedulePlacementId ? "schedule" : "teacher",
        group,
        windowLocal: `${localInstant(beginsAt, clock.timeZone)} - ${
          endsAt === null ? "(no end)" : localInstant(endsAt, clock.timeZone)
        }`,
        liveUntilLocal:
          until === null ? null : localInstant(until, clock.timeZone),
        // Live past its window: the clear is late, not the window long.
        overrun: live && endsAt !== null && endsAt <= now,
        occurrenceDate: push.occurrenceDate ?? null,
        startsAt: beginsAt,
        endsAt,
      });
    }
  }
  pushes.sort((a, b) => a.startsAt - b.startsAt);
  return pushes;
}

/**
 * Who a push covers, worded as a teacher's push labels it (pushes.createFocus):
 * the group's name, all of a school's scholars (named, since this read can
 * span schools), or a count. Null for a group that no longer exists.
 */
async function pushAudienceLabel(
  ctx: QueryCtx,
  audience: Doc<"pushes">["audience"],
  schoolName: string,
): Promise<string | null> {
  const count = (n: number) => `${n} scholar${n === 1 ? "" : "s"}`;
  switch (audience.kind) {
    case "group":
      return (await ctx.db.get(audience.groupId))?.name ?? null;
    case "institution":
      return `All scholars at ${schoolName}`;
    case "scholars":
      return count(audience.scholarIds.length);
    case "assignment": {
      const assignment = await ctx.db.get(audience.assignmentId);
      return assignment ? count(assignment.scholarIds.length) : null;
    }
  }
}

const GRANT_AUDIT_ACTIONS = [
  "app-grant.audience-assigned",
  "app-grant.audience-unassigned",
  "app-grant.audience-enabled",
  "app-grant.audience-disabled",
  "app-grant.scholar-assigned",
  "app-grant.scholar-unassigned",
  "app-grant.scholar-enabled",
  "app-grant.scholar-disabled",
] as const;

/**
 * Recent grant changes for THIS app, so "was this deliberately changed?" is
 * answerable — the question that went unasked on 2026-09-21, when the record
 * already held the five removals that contradicted "dropped in the reshuffle".
 *
 * App-scoped by construction: filtering to an app the caller already resolved
 * through their own institution lens is tenant-safe without `auditLog`'s
 * tenancy key. The general, institution-scoped reader is `get_audit_log`
 * (convex/auditLog.ts, TRA-362).
 */
async function appGrantHistory(
  ctx: QueryCtx,
  appId: Id<"externalApps">,
  timeZone: string,
) {
  const out: Array<{ at: string; action: string; by: string; via: string | null }> = [];
  for (const action of GRANT_AUDIT_ACTIONS) {
    const rows = await ctx.db
      .query("auditLog")
      .withIndex("by_action", (q) => q.eq("action", action))
      .order("desc")
      .take(40);
    for (const r of rows) {
      if (!r.detail?.includes(appId)) continue;
      const actor = await ctx.db.get(r.actorUserId);
      let via: string | null = null;
      try {
        via = (JSON.parse(r.detail) as { via?: string }).via ?? null;
      } catch {
        via = null;
      }
      out.push({
        at: localInstant(r.at, timeZone),
        action: action.replace("app-grant.", ""),
        by: actor?.name ?? actor?.username ?? "unknown",
        via,
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 12);
}

async function coreGetAppAccess(
  ctx: QueryCtx,
  appId: Id<"externalApps">,
  scope: ExternalAppScope | null = null,
) {
  const allGrants = await ctx.db
    .query("appAudiences")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .collect();
  const grants = await grantsInScope(ctx, allGrants, scope);
  const groups: Array<{
    name: string;
    emoji: string | null;
    memberCount: number;
    enabled: boolean;
  }> = [];
  const institutions: Array<{
    name: string;
    emoji: string | null;
    memberCount: number;
    enabled: boolean;
  }> = [];
  for (const g of grants) {
    const meta = await resolveAudienceMeta(ctx, g.audienceKind, g.audienceId);
    const row = {
      name: meta.label,
      emoji: meta.emoji,
      memberCount: meta.memberCount,
      enabled: g.enabled,
    };
    if (g.audienceKind === "group") groups.push(row);
    else institutions.push(row);
  }
  const links = await ctx.db
    .query("scholarApps")
    .withIndex("by_app", (q) => q.eq("appId", appId))
    .collect();
  const directLinks = links.filter(
    (l) =>
      (l.source === "manual" || l.source === "default") &&
      (!scope || isScholarInScope(scope, l.scholarId)),
  );
  const scholars = await Promise.all(
    directLinks.map(async (l) => {
      const u = await ctx.db.get(l.scholarId);
      return {
        name: u?.name ?? u?.username ?? "Unknown",
        username: u?.username ?? null,
        enabled: l.enabled,
        // Extended Education (program-guest) rows carry a tag so the aide
        // tool edge can apply the enrolled-only default (see
        // lib/scholarParticipationTooling.ts); enrolled rows are unchanged.
        ...extendedEducationTag({ enrollmentStanding: u?.enrollmentStanding }),
      };
    }),
  );
  return { groups, institutions, scholars };
}

// ── One scholar: may they open it, through what, until when (TRA-445) ──────
//
// The app-centric read above cannot answer "can Kai open this?": it names
// standing grants by audience, and a push to a list of scholars or an
// assignment only as a count ("1 scholar"). On 2026-09-15 answering that for
// one scholar took reading five tables by hand; on 2026-09-21 a block-scoped
// app read as ungranted and a standing grant was wrongly restored.
//
// So a "no" here says what is set up around it, and never names grants as
// the missing piece: a block-scoped app has none by design (the 2026-09-15
// ruling), and a sentence listing them reads as "broken, add a grant".
//
// It states FACTS FROM ROWS, never a forecast. Whether and when a class opens
// the app is the scheduler's decision (masterSchedule.ts: the term, the
// teacher, a wrap-up, a closed day), and re-deriving it here would be a second
// copy of that rule, the bug class this program removes (T7). So "when it
// opens" comes only from pushes the scheduler or a teacher already created,
// and a class placement is stated as configuration, annotated where its row
// alone shows it cannot open anything.

/** One route in the per-scholar answer, worded for staff. */
type ScholarRoute = {
  route: "direct" | "group grant" | "school grant" | "schedule push" | "teacher push";
  /** The route by name, as it reads after "via": "the Robotics group grant". */
  name: string;
  /** When this route is expected to end, school-local; null when it has no
   *  end of its own. */
  untilLocal: string | null;
  /** A push whose window has closed with nothing cleared yet. */
  overrun: boolean;
  /** A push's window close, school-local; null for any other route. */
  windowEndsLocal: string | null;
};

/** A push already planned for them (the scheduler's or a teacher's row): the
 *  one authority on when the app opens. The scheduler plans only about a
 *  week ahead, so the soonest is not necessarily the next opening. */
type PlannedOpening = {
  /** When it opens, school-local. */
  atLocal: string;
  /** As it reads after "It opens at …": "for Robotics (Block E)". */
  name: string;
  /** Its window, school-local. */
  windowLocal: string;
};

/** A session of the app covering them that a teacher ended, or called off
 *  before it opened, today (see `whenForScholar` for which clears count). */
type WrappedToday = {
  /** "Today's Robotics Block E session", "Sloane Kahale's push to them alone". */
  name: string;
  /** When the teacher cleared it, school-local. */
  atLocal: string;
  /** False: it was called off before it opened. */
  opened: boolean;
};

/** A schedule placement of the app for a class they are in: CONFIGURATION,
 *  stated as fact, never a promise that the app will open. */
type ScheduledClass = {
  /** "Robotics during Block E" */
  name: string;
  /** The placement's days and window, lead-in and grace included:
   *  "Mon/Wed 14:50-16:40", or "Mon 14:50-16:40, week of Oct 5 only". */
  windowLocal: string;
  /** Its term, and where today falls against the term's own dates. */
  term: string;
  termStatus: "current" | "ended" | "upcoming";
  termStartsLocal: string;
  termEndsLocal: string;
  /** A one-week placement whose week is over. */
  weekOver: boolean;
};

/** "HH:MM" in `timeZone`, for a sentence; `localInstant` for a field. */
function localClock(ms: number, timeZone: string): string {
  return new Date(ms).toLocaleTimeString("en-CA", {
    timeZone,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "Oct 2" in `timeZone`, with the year when it is not `now`'s. */
function localDate(ms: number, timeZone: string, now: number): string {
  const year = (at: number) =>
    new Date(at).toLocaleDateString("en-US", { timeZone, year: "numeric" });
  return new Date(ms).toLocaleDateString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(year(ms) === year(now) ? {} : { year: "numeric" }),
  });
}

/** "at 14:50 today", or "on Wed, Sep 30 at 14:50". */
function whenLocal(ms: number, timeZone: string, now: number): string {
  if (dayKeyForTimezone(ms, timeZone) === dayKeyForTimezone(now, timeZone)) {
    return `at ${localClock(ms, timeZone)} today`;
  }
  const day = new Date(ms).toLocaleDateString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `on ${day} at ${localClock(ms, timeZone)}`;
}

/** "a, b and c" */
function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}


/** Does this term belong to that school? A legacy UNSTAMPED term belongs to
 *  the primary school, the rule `requireScheduleScopeAccessible` applies. */
async function termBelongsTo(
  ctx: QueryCtx,
  term: Doc<"reportingPeriods">,
  institutionId: Id<"institutions"> | undefined,
): Promise<boolean> {
  if (!institutionId) return false;
  if (term.institutionId) return term.institutionId === institutionId;
  return (await primaryInstitutionId(ctx)) === institutionId;
}

/**
 * A schedule push's class, as the caller may see it: its group's name (or
 * `HIDDEN_GROUP`), and its block's label only when the placement's term
 * belongs to the push's own school. A legacy unstamped group can be placed in
 * another school's term, and the scheduler stamps its push with the primary
 * school (`institutionIdForPlacementGroup`), so the push can reach this
 * school's scholar while its block label is the other school's.
 */
async function schedulePushClass(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  push: Doc<"pushes">,
): Promise<{ group: string; block: string | null }> {
  const placement = push.schedulePlacementId
    ? await ctx.db.get(push.schedulePlacementId)
    : null;
  const groupId =
    push.audience.kind === "group" ? push.audience.groupId : (placement?.groupId ?? null);
  const group = (groupId ? await groupLabelInScope(ctx, scope, groupId) : null) ?? HIDDEN_GROUP;
  const term = placement ? await ctx.db.get(placement.periodId) : null;
  const block =
    placement?.blockId && term && (await termBelongsTo(ctx, term, push.institutionId))
      ? await ctx.db.get(placement.blockId)
      : null;
  return { group, block: block?.label ?? null };
}

/** A push as staff would name it: "the Robotics Block E schedule push",
 *  "Sloane Kahale's push to Robotics", "…'s push to a list of 3 scholars". */
async function pushRouteName(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  push: Doc<"pushes">,
): Promise<string> {
  const audience = push.audience;
  if (push.schedulePlacementId) {
    const { group, block } = await schedulePushClass(ctx, scope, push);
    if (group === HIDDEN_GROUP) return `a schedule push to ${HIDDEN_GROUP}`;
    return `the ${group}${block ? ` ${block}` : ""} schedule push`;
  }
  const pusher = await ctx.db.get(push.pushedBy);
  const by = pusher?.name ? `${pusher.name}'s push` : "a teacher's push";
  switch (audience.kind) {
    case "group":
      return `${by} to ${(await groupLabelInScope(ctx, scope, audience.groupId)) ?? HIDDEN_GROUP}`;
    case "institution": {
      // `pushCoversScholar` never crosses a school, so this is the scholar's
      // own school, which the caller's scope already holds.
      const school = await ctx.db.get(push.institutionId);
      return `${by} to all scholars at ${school?.name ?? "their school"}`;
    }
    case "scholars": {
      const n = audience.scholarIds.length;
      return n === 1 ? `${by} to them alone` : `${by} to a list of ${n} scholars`;
    }
    case "assignment": {
      const assignment = await ctx.db.get(audience.assignmentId);
      const n = assignment?.scholarIds.length ?? 0;
      return `${by} to an assignment roster of ${n} scholar${n === 1 ? "" : "s"}`;
    }
  }
}

/** A route as staff read it, plus its push's window close as an instant (for
 *  the sentence; null for any other route). */
async function describeRoute(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  scholar: Doc<"users">,
  authority: AppAuthority,
  timeZone: string,
): Promise<{ route: ScholarRoute; windowEndsAt: number | null }> {
  const untilLocal =
    authority.until === null ? null : localInstant(authority.until, timeZone);
  const standing = { untilLocal, overrun: false, windowEndsLocal: null };
  switch (authority.kind) {
    case "direct":
      return {
        route: {
          route: "direct",
          // Both are their own row. "default" is seeded for every new scholar
          // when the app is a default, so it is not an add made for them.
          name:
            authority.source === "default"
              ? "the default apps every new scholar gets"
              : "a direct add to them",
          ...standing,
        },
        windowEndsAt: null,
      };
    case "grant": {
      if (authority.audience === "group") {
        const group = await groupLabelInScope(ctx, scope, authority.groupId);
        return {
          route: {
            route: "group grant",
            name: group ? `the ${group} group grant` : `a group grant to ${HIDDEN_GROUP}`,
            ...standing,
          },
          windowEndsAt: null,
        };
      }
      // The school `grantProvenanceForScholar` read the grant for.
      const institutionId = await scholarInstitutionId(ctx, scholar._id);
      const school =
        institutionId && isInstitutionInScope(scope, institutionId)
          ? await ctx.db.get(institutionId)
          : null;
      return {
        route: {
          route: "school grant",
          name: school ? `the school-wide grant at ${school.name}` : "a school-wide grant",
          ...standing,
        },
        windowEndsAt: null,
      };
    }
    case "push": {
      const push = await ctx.db.get(authority.pushId);
      const endsAt = push ? pushExpiresAt(push.timing) : null;
      return {
        route: {
          route: authority.source === "schedule" ? "schedule push" : "teacher push",
          name: push ? await pushRouteName(ctx, scope, push) : "a push",
          untilLocal,
          overrun: authority.overrun,
          windowEndsLocal: endsAt === null ? null : localInstant(endsAt, timeZone),
        },
        windowEndsAt: endsAt,
      };
    }
  }
}

/** "It opens at 14:50 today ___": a planned push, by its class or its pusher. */
async function plannedPushName(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  push: Doc<"pushes">,
): Promise<string> {
  if (!push.schedulePlacementId) return `with ${await pushRouteName(ctx, scope, push)}`;
  const { group, block } = await schedulePushClass(ctx, scope, push);
  return `for ${group}${block ? ` (${block})` : ""}`;
}

/** "___ was wrapped up at 15:30": a cleared push, by its session or its pusher. */
async function wrappedPushName(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  push: Doc<"pushes">,
): Promise<string> {
  if (!push.schedulePlacementId) return await pushRouteName(ctx, scope, push);
  const { group, block } = await schedulePushClass(ctx, scope, push);
  return `today's ${block ? `${block} ` : ""}session for ${group}`;
}

/**
 * The app's schedule placements for a group the scholar is in (by
 * `groupIdsForScholar`, the membership rule a placement's push uses), stated
 * as CONFIGURATION: the class, its days and window, and its term's dates.
 * Only placements in a term of the scholar's own school: a legacy group can
 * sit in another school's term, whose block labels and dates are not this
 * caller's to see. Weekly placements that differ only by weekday merge
 * ("Mon/Wed"); a one-week placement names its week. Nothing here decides
 * whether or when one opens: that is the scheduler's job, and its planned
 * pushes say it.
 */
async function scheduledForScholar(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  scholar: Doc<"users">,
  appId: Id<"externalApps">,
  groupIds: ReadonlyArray<Id<"scholarGroups">>,
  now: number,
  timeZone: string,
): Promise<ScheduledClass[]> {
  const inGroup = new Set(groupIds.map(String));
  type Entry = ScheduledClass & {
    order: number;
    days: Array<{ weekday: number; label: string }>;
    window: string;
    week: string | null;
  };
  const entries = new Map<string, Entry>();
  const placements = await ctx.db
    .query("schedulePlacements")
    .withIndex("by_external_app", (q) => q.eq("externalAppId", appId))
    .collect();
  for (const p of placements) {
    if (p.weekday == null || p.blockId == null) continue; // on the shelf: not scheduled
    if (!inGroup.has(String(p.groupId))) continue;
    const term = await ctx.db.get(p.periodId);
    if (!term || !(await termBelongsTo(ctx, term, scholar.institutionId))) continue;
    const block = await ctx.db.get(p.blockId);
    if (!block) continue;
    const window = `${shiftLocalLabel(block.startLocal, -APP_PLACEMENT_LEAD_MS / 60_000)}-${shiftLocalLabel(
      block.endLocal,
      APP_PLACEMENT_GRACE_MS / 60_000,
    )}`;
    const name = `${(await groupLabelInScope(ctx, scope, p.groupId)) ?? HIDDEN_GROUP} during ${block.label}`;
    const week = p.weekStartMs == null ? null : localDate(p.weekStartMs, timeZone, now);
    const key = [name, window, String(term._id), week ?? "weekly"].join("|");
    const order = p.weekday * 1440 + (parseHHMM(block.startLocal) ?? 0);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        name,
        windowLocal: "",
        term: term.label,
        termStatus: now < term.startsAt ? "upcoming" : now > term.endsAt ? "ended" : "current",
        termStartsLocal: localDate(term.startsAt, timeZone, now),
        termEndsLocal: localDate(term.endsAt, timeZone, now),
        weekOver:
          p.weekStartMs != null &&
          shiftScheduleWeekStartMs(p.weekStartMs, 1, timeZone) <= now,
        order,
        days: [],
        window,
        week,
      };
      entries.set(key, entry);
    }
    entry.order = Math.min(entry.order, order);
    const day: string = WEEKDAY_LABEL[p.weekday] ?? `weekday ${p.weekday}`;
    if (!entry.days.some((d) => d.label === day)) entry.days.push({ weekday: p.weekday, label: day });
  }
  return [...entries.values()]
    .sort((a, b) => a.order - b.order)
    .map(({ order: _order, days, window, week, ...entry }) => ({
      ...entry,
      windowLocal: `${[...days]
        .sort((a, b) => a.weekday - b.weekday)
        .map((d) => d.label)
        .join("/")} ${window}${week ? `, week of ${week} only` : ""}`,
    }));
}

/**
 * What is set up around a scholar who cannot open the app right now, as facts
 * from rows that already exist (see this section's header):
 *
 *   • `opens`: pushes of the app already planned (not yet set live) whose
 *     audience covers them (`pushCoversScholar`) and whose start is ahead,
 *     soonest first. The scheduler plans a class's push only when its own
 *     rules allow one (a term, no wrap-up, a school day), so these rows, not
 *     the placements, are the authority on when the app opens. It plans only
 *     about a week ahead, so the soonest of them is the soonest ALREADY
 *     PLANNED, not necessarily the next opening.
 *   • `wrappedToday`: today's sessions of the app covering them that a
 *     teacher wrapped up or called off. The scheduler stamps the same
 *     "teacher" clear when a class is deleted or merged
 *     (`settlePlacementAppPush`) or its app is detached
 *     (`coreUpdatePlacement`), which ends no session. So a clear counts only
 *     while its placement still exists and still targets this app, and while
 *     no newer push of the app covers them for that session.
 *   • `scheduled`: `scheduledForScholar`, configuration only.
 */
async function whenForScholar(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  scholar: Doc<"users">,
  appId: Id<"externalApps">,
  now: number,
  timeZone: string,
): Promise<{
  opens: Array<PlannedOpening & { at: number }>;
  wrappedToday: Array<WrappedToday & { at: number }>;
  scheduled: ScheduledClass[];
}> {
  const groupIds = await groupIdsForScholar(ctx, scholar);
  const opens: Array<PlannedOpening & { at: number }> = [];
  const wrappedToday: Array<WrappedToday & { at: number }> = [];
  const institutionId = scholar.institutionId;
  if (institutionId) {
    const today = dayKeyForTimezone(now, timeZone);
    const isThisApp = (p: Doc<"pushes">) =>
      p.target.kind === "app" && p.target.externalAppId === appId;
    // A push's session: a block's occurrence date, else the day it was set
    // (or planned for).
    const sessionOf = (p: Doc<"pushes">) =>
      p.occurrenceDate ??
      dayKeyForTimezone(p.setAt ?? p.startsAt ?? p._creationTime, timeZone);
    const { pushes: open } = await openAppPushesForInstitution(ctx, institutionId, now);
    const openOfApp = open.filter(isThisApp);
    const planned = openOfApp.filter(
      (p) => p.setAt === undefined && p.startsAt !== undefined && p.startsAt > now,
    );
    // The school's clears since its midnight, by index, then a teacher's clear
    // of TODAY's session.
    const cleared = (
      await ctx.db
        .query("pushes")
        .withIndex("by_institution_cleared", (q) =>
          q
            .eq("institutionId", institutionId)
            .gte("clearedAt", dayStartForDayKey(today, timeZone))
            .lte("clearedAt", now),
        )
        .collect()
    ).filter((p) => isThisApp(p) && p.clearedReason === "teacher" && sessionOf(p) === today);
    const audience = {
      scholarId: scholar._id,
      institutionId,
      groupIds,
      assignmentIds: await assignmentIdsCovering(ctx, scholar, [...openOfApp, ...cleared]),
    };
    for (const push of planned) {
      if (!pushCoversScholar(push, audience)) continue;
      const at = push.startsAt!;
      const endsAt = pushExpiresAt(push.timing);
      opens.push({
        at,
        atLocal: localInstant(at, timeZone),
        name: await plannedPushName(ctx, scope, push),
        windowLocal: `${localInstant(at, timeZone)} - ${
          endsAt === null ? "(no end)" : localInstant(endsAt, timeZone)
        }`,
      });
    }
    for (const push of cleared) {
      if (!pushCoversScholar(push, audience)) continue;
      // A deleted, merged or detached class clears with "teacher" too, and
      // ends no session: its placement is gone or no longer this app's.
      if (push.schedulePlacementId) {
        const placement = await ctx.db.get(push.schedulePlacementId);
        if (!placement || placement.externalAppId !== appId) continue;
      }
      // Nor is a session over while a newer push covers them for it.
      const superseded = openOfApp.some(
        (p) =>
          p._creationTime > push._creationTime &&
          sessionOf(p) === sessionOf(push) &&
          pushCoversScholar(p, audience),
      );
      if (superseded) continue;
      const at = push.clearedAt!;
      wrappedToday.push({
        at,
        atLocal: localInstant(at, timeZone),
        name: await wrappedPushName(ctx, scope, push),
        opened: push.setAt !== undefined,
      });
    }
    opens.sort((a, b) => a.at - b.at);
    wrappedToday.sort((a, b) => a.at - b.at);
  }
  return {
    opens,
    wrappedToday,
    scheduled: await scheduledForScholar(ctx, scope, scholar, appId, groupIds, now, timeZone),
  };
}

/** One placement, as a sentence of fact: "Scratch is scheduled for Robotics
 *  during Block E (Mon 14:50-16:40) this term (ends Dec 19)." — with, where
 *  its row alone shows it cannot open anything, the plain reason. */
function scheduledSentence(appName: string, c: ScheduledClass): string {
  const notes: string[] = [];
  if (c.termStatus === "ended") notes.push(`that term ended ${c.termEndsLocal}`);
  else if (c.termStatus === "upcoming") notes.push(`that term starts ${c.termStartsLocal}`);
  if (c.weekOver) notes.push("that week is over");
  const thisTerm = c.termStatus === "current" ? ` this term (ends ${c.termEndsLocal})` : "";
  return `${appName} is scheduled for ${c.name} (${c.windowLocal})${thisTerm}${
    notes.length ? `, but ${notes.join(", and ")}` : ""
  }.`;
}

/**
 * One scholar's answer to "may they open this app right now, through what,
 * and until when?" — `scholarAppAccessAt`, the launch gates' own check, worded
 * for staff. `canOpen` is therefore exactly what the scholar's tile and launch
 * gates say, never a re-derivation of the rule. When it is false and the app
 * is not archived, `when` states what is set up around it, as facts from rows
 * (`whenForScholar`), never a forecast.
 *
 * TENANCY. The scholar resolves inside the caller's scope
 * (`resolveScholarByNameOrUsername` narrows its pool before matching), so one
 * outside it is "not found", indistinguishable from a name that matches no
 * one. A group the caller cannot see is counted but never named
 * (`groupLabelInScope`).
 *
 * CLOCK. Everything here is judged at `now`, the instant the tool's action
 * took from the SERVER clock, which is also the instant the app-wide `pushes`
 * list beside it is judged at, so the two halves of one answer cannot
 * disagree about a push. An internal query, so no client can supply `now`.
 *
 * `untilLocal` is the EXPECTED end (`accessEndsAt`): null while any route has
 * no end of its own; for a push, its window's close, when the scheduled clear
 * retires it. If that clear is late the push stays on the scholar's tile as an
 * overrun until midnight, and a later read says so.
 */
async function scholarAccessForStaff(
  ctx: QueryCtx,
  scope: ExternalAppScope,
  scholarQuery: string,
  app: Doc<"externalApps">,
  now: number,
) {
  const scholar = await resolveScholarByNameOrUsername(ctx, scholarQuery, scope);
  const access = await scholarAppAccessAt(ctx, scholar, app._id, now);
  // The clock the pushes were judged by is the scholar's school's.
  const timeZone = await timeZoneForInstitution(ctx, scholar.institutionId);
  const described = [];
  for (const authority of access.via) {
    described.push(await describeRoute(ctx, scope, scholar, authority, timeZone));
  }
  // Only a scholar nothing covers right now needs "when": an archived app has
  // nothing that opens it.
  const when =
    access.denied === "no-authority"
      ? await whenForScholar(ctx, scope, scholar, app._id, now, timeZone)
      : null;
  const who = scholar.name ?? scholar.username ?? "This scholar";
  return {
    name: who,
    username: scholar.username ?? null,
    ...extendedEducationTag({ enrollmentStanding: scholar.enrollmentStanding }),
    canOpen: access.allowed,
    // Why not, when `canOpen` is false: nothing opens it for them at this
    // moment, or the app is archived. ("missing" cannot happen here: the app
    // was resolved by name in this same read. Were it gone, nothing would open
    // it, as with an archived app.)
    whyNot:
      access.denied === null
        ? null
        : access.denied === "no-authority"
          ? ("no-route" as const)
          : ("archived" as const),
    via: described.map((d) => d.route),
    untilLocal: access.until === null ? null : localInstant(access.until, timeZone),
    // Null when `canOpen` is true or the app is archived. Otherwise the pushes
    // already planned for them (the authority on when it opens), today's
    // wrapped-up sessions, and the class placements that name them, each
    // possibly empty.
    when: when && {
      opens: when.opens.map(({ at: _at, ...o }) => o),
      wrappedToday: when.wrappedToday.map(({ at: _at, ...w }) => w),
      scheduled: when.scheduled,
    },
    summary: scholarAccessSentence({
      who,
      appName: app.name,
      access,
      described,
      when,
      timeZone,
      now,
    }),
  };
}

/** The one line a human reads: "Kai Kahale can open LEGO SPIKE via the
 *  Robotics Block E schedule push, until 16:40, when the window closes." A
 *  "no" states the rows around it, never a forecast, a fault or a missing
 *  grant. */
function scholarAccessSentence(args: {
  who: string;
  appName: string;
  access: ScholarAppAccess;
  described: ReadonlyArray<{ route: ScholarRoute; windowEndsAt: number | null }>;
  when: Awaited<ReturnType<typeof whenForScholar>> | null;
  timeZone: string;
  now: number;
}): string {
  const { who, appName, access, described, when: around, timeZone, now } = args;
  const today = dayKeyForTimezone(now, timeZone);
  const midnight = dayStartForDayKey(shiftDayKey(today, 1), timeZone);
  const when = (ms: number) =>
    ms === midnight
      ? "midnight"
      : dayKeyForTimezone(ms, timeZone) === today
        ? localClock(ms, timeZone)
        : localInstant(ms, timeZone);
  if (!access.allowed) {
    if (access.denied !== "no-authority" || !around) {
      return `${who} can't open ${appName}: it is archived, so nothing opens it until it is restored.`;
    }
    const { opens, wrappedToday, scheduled } = around;
    if (opens.length === 0 && wrappedToday.length === 0 && scheduled.length === 0) {
      // Scoped to what the caller sees: a class in another school's term is
      // left out of `scheduled` (scheduledForScholar), and can still open it.
      return `${who} can't open ${appName} right now, and no class they're in is on their school's schedule for it.`;
    }
    const sentences = [`${who} can't open ${appName} right now.`];
    // The soonest push ALREADY planned, not necessarily the next opening:
    // the scheduler plans only about a week ahead. The rest are in `when`.
    if (opens[0]) {
      sentences.push(`It opens ${whenLocal(opens[0].at, timeZone, now)} ${opens[0].name}.`);
    }
    for (const w of wrappedToday) {
      const name = w.name.charAt(0).toUpperCase() + w.name.slice(1);
      sentences.push(
        `${name} was ${w.opened ? "wrapped up" : "called off"} at ${localClock(w.at, timeZone)}.`,
      );
    }
    for (const c of scheduled) sentences.push(scheduledSentence(appName, c));
    if (opens.length === 0 && scheduled.length === 0) {
      sentences.push("No class they're in is on their school's schedule for it.");
    }
    // Two rows can read identically (a re-push, a duplicated placement).
    return [...new Set(sentences)].join(" ");
  }
  // A re-push is a second route with the same name: say it once.
  const names = [...new Set(described.map((d) => d.route.name))];
  const opens = `${who} can open ${appName} via ${joinAnd(names)}`;
  const until = access.until;
  if (until === null) {
    const endless = access.via.find((a) => a.until === null);
    return endless?.kind === "push"
      ? `${opens}, with no set end: the push lasts until a teacher clears it.`
      : `${opens}, with no set end: standing access lasts until someone removes it.`;
  }
  // The route whose end is the answer's end: the latest one.
  const last = described[access.via.findIndex((a) => a.until === until)];
  if (last?.route.overrun) {
    const closed = last.windowEndsAt === null ? "" : ` at ${when(last.windowEndsAt)}`;
    return `${opens}, until ${when(until)} at the latest: its window closed${closed}, but nothing has cleared the push yet (a clear normally lands within minutes).`;
  }
  if (last?.windowEndsAt != null) {
    return `${opens}, until ${when(until)}, when the window closes.`;
  }
  return `${opens}, until ${when(until)}.`;
}

// ── Internal aide* wrappers (verified callerUserId, no ctx.user) ───────────

export const aideListApps = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, { callerUserId }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    return coreListAppsWithAudiences(ctx, { includeArchived: true, scope });
  },
});

export const aideGetAppAccess = internalQuery({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    // The instant everything here is judged at: every push (live, live
    // until, the lookaround) and, with `scholar`, that scholar's answer, so
    // the two halves of one response cannot disagree about a push. Required,
    // because the fallback it replaced was Date.now() inside a query, which is
    // not a dependency and silently goes stale (the T11 rule in
    // .claude/rules/rabbithole-product-taste.md). The caller is the tool's
    // action, which passes its own Date.now(): the SERVER's clock, exact,
    // since a one-shot call from an action has no subscription to bucket.
    // This is an internal query, so no client can supply it.
    now: v.number(),
    // One scholar, by name or username: adds `forScholar`, whether they may
    // open the app right now, through what, and until when (TRA-445).
    // Resolved inside the caller's scope; outside it reads as "not found".
    scholar: v.optional(v.string()),
  },
  handler: async (ctx, { callerUserId, appName, now, scholar }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const app = await resolveAppByName(ctx, appName);
    const forScholar =
      scholar === undefined
        ? undefined
        : await scholarAccessForStaff(ctx, scope, scholar, app, now);
    const access = await coreGetAppAccess(ctx, app._id, scope);
    const schedule = await appScheduleAccess(ctx, app._id, scope, now);
    const timeZone = await timeZoneForInstitution(
      ctx,
      scope.caller.institutionId,
    );
    return {
      app: {
        id: app._id,
        name: app.name,
        webUrl: app.webUrl,
        archived: !!app.archived,
      },
      // Only when a scholar was named, so the app-wide answer is unchanged.
      ...(forScholar ? { forScholar } : {}),
      ...access,
      // The THIRD authority, previously missing entirely. `blockScoped` is the
      // recurring rule ("Robotics, Block E, Mon+Wed, 14:50-16:40"); `pushes`
      // are the pushes themselves, from a block or a teacher, each saying
      // whether it is live at this instant and until when.
      blockScoped: schedule.blockScoped,
      pushes: schedule.pushes,
      recentGrantChanges: await appGrantHistory(ctx, app._id, timeZone),
    };
  },
});

export const aideSetGroupAccess = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    groupName: v.string(),
    enabled: v.boolean(),
    via: v.optional(v.union(v.literal("aide"), v.literal("slack"))),
  },
  handler: async (ctx, { callerUserId, appName, groupName, enabled, via }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const caller = scope.caller;
    const app = await resolveAppByName(ctx, appName);
    const group = await resolveGroupByName(ctx, groupName, scope);
    if (enabled) {
      const r = await coreAssignToAudience(
        ctx,
        {
          appId: app._id,
          audienceKind: "group",
          audienceId: group._id,
          enabled: true,
        },
        caller,
        via ?? "aide",
      );
      return {
        app: app.name,
        group: group.name,
        enabled: true,
        memberCount: r.memberCount,
      };
    }
    const r = await coreUnassignAudience(
      ctx,
      {
        appId: app._id,
        audienceKind: "group",
        audienceId: group._id,
      },
      caller,
      via ?? "aide",
    );
    return { app: app.name, group: group.name, enabled: false, removed: r.removed };
  },
});

export const aideSetInstitutionAccess = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    institutionName: v.string(),
    enabled: v.boolean(),
    via: v.optional(v.union(v.literal("aide"), v.literal("slack"))),
  },
  handler: async (
    ctx,
    { callerUserId, appName, institutionName, enabled, via },
  ) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const caller = scope.caller;
    const app = await resolveAppByName(ctx, appName);
    const inst = await resolveInstitutionByName(ctx, institutionName, scope);
    if (enabled) {
      const r = await coreAssignToAudience(
        ctx,
        {
          appId: app._id,
          audienceKind: "institution",
          audienceId: inst._id,
          enabled: true,
        },
        caller,
        via ?? "aide",
      );
      return {
        app: app.name,
        institution: inst.name,
        enabled: true,
        memberCount: r.memberCount,
      };
    }
    const r = await coreUnassignAudience(
      ctx,
      {
        appId: app._id,
        audienceKind: "institution",
        audienceId: inst._id,
      },
      caller,
      via ?? "aide",
    );
    return {
      app: app.name,
      institution: inst.name,
      enabled: false,
      removed: r.removed,
    };
  },
});
