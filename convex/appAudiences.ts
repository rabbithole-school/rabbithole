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
import { scholarIdsForInstitution } from "./lib/scholarEnrollment";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  requireScholarAdminScope,
  resolveAppByName,
  resolveGroupByName,
  resolveInstitutionByName,
  isScholarInScope,
  isGroupInScope,
  isInstitutionInScope,
  type ExternalAppScope,
} from "./lib/externalAppsResolve";
import { extendedEducationTag } from "./lib/scholarParticipationTooling";
import { assertCuratableInstitution } from "./lib/access";
import { scheduleUnlockRevocationCheck } from "./lib/deviceAppUnlockScheduling";
import { resolveAppIconUrl } from "./lib/externalAppIconUrl";
import { managedNativeAppKeyForScheme } from "./lib/managedNativeApps";
import {
  resolveInstitutionLens,
  institutionIdInLens,
} from "./lib/institutionLens";

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
    // institutionIdInLens treats a legacy UNSTAMPED group as the primary
    // school, matching how the rest of the lens layer reads those.
    const lens = await resolveInstitutionLens(ctx, user, "all");
    if (!institutionIdInLens(lens, group.institutionId)) {
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
): Promise<{ grantId: Id<"appAudiences">; created: boolean; memberCount: number }> {
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
  await scheduleUnlockRevocationCheck(ctx, { externalAppId: args.appId, scholarIds });
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
        managedNativeAppKey: managedNativeAppKeyForScheme(app.nativeUrlScheme),
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

// ── Internal aide* wrappers (verified callerUserId, no ctx.user) ───────────

export const aideListApps = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, { callerUserId }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    return coreListAppsWithAudiences(ctx, { includeArchived: true, scope });
  },
});

export const aideGetAppAccess = internalQuery({
  args: { callerUserId: v.id("users"), appName: v.string() },
  handler: async (ctx, { callerUserId, appName }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const app = await resolveAppByName(ctx, appName);
    const access = await coreGetAppAccess(ctx, app._id, scope);
    return {
      app: {
        id: app._id,
        name: app.name,
        webUrl: app.webUrl,
        archived: !!app.archived,
      },
      ...access,
    };
  },
});

export const aideSetGroupAccess = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    groupName: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { callerUserId, appName, groupName, enabled }) => {
    const scope = await requireScholarAdminScope(ctx, callerUserId);
    const caller = scope.caller;
    const app = await resolveAppByName(ctx, appName);
    const group = await resolveGroupByName(ctx, groupName, scope);
    if (enabled) {
      const r = await coreAssignToAudience(
        ctx,
        { appId: app._id, audienceKind: "group", audienceId: group._id, enabled: true },
        caller,
      );
      return {
        app: app.name,
        group: group.name,
        enabled: true,
        memberCount: r.memberCount,
      };
    }
    const r = await coreUnassignAudience(ctx, {
      appId: app._id,
      audienceKind: "group",
      audienceId: group._id,
    }, caller);
    return { app: app.name, group: group.name, enabled: false, removed: r.removed };
  },
});

export const aideSetInstitutionAccess = internalMutation({
  args: {
    callerUserId: v.id("users"),
    appName: v.string(),
    institutionName: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { callerUserId, appName, institutionName, enabled }) => {
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
      );
      return {
        app: app.name,
        institution: inst.name,
        enabled: true,
        memberCount: r.memberCount,
      };
    }
    const r = await coreUnassignAudience(ctx, {
      appId: app._id,
      audienceKind: "institution",
      audienceId: inst._id,
    }, caller);
    return {
      app: app.name,
      institution: inst.name,
      enabled: false,
      removed: r.removed,
    };
  },
});
