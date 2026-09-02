// Institution invites — the multi-tenant onboarding surface.
//
// A platform admin mints a `create_institution` invite that lets an outside
// partner (e.g. "Prism Academy") create their OWN institution and become its
// school_admin — never a platform admin, and with no global grant. A school
// admin mints `join_institution` invites for THEIR OWN institution only, for
// teacher/scholar roles (minting a school_admin join stays platform-only).
//
// Redemption happens in `users.registerWithCode` (the single signup entry
// point), so the existing auth-callback handshake keeps working. The shared
// validity/gating helpers live in convex/lib/institutionInvites.ts.
//
// See the `institutionInvites` table comment in convex/schema.ts and
// review/institution-scoping-audit.html.

import { v } from "convex/values";
import {
  platformAdminMutation,
  platformAdminQuery,
  schoolAdminMutation,
  schoolAdminQuery,
} from "./lib/customFunctions";
import { query } from "./_generated/server";
import { ROLES, isPasskeyRole, type Role } from "./lib/roles";
import { resolveInstitutionLens } from "./lib/institutionLens";
import {
  findInviteByCode,
  generateInviteCode,
  inviteStatus,
  inviteUrl,
  invitePath,
  isInviteRedeemable,
  type InstitutionInvite,
} from "./lib/institutionInvites";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

// Shared arg validators for the mint mutations.
const mintCommonArgs = {
  label: v.optional(v.string()),
  expiresAt: v.optional(v.number()),
  maxUses: v.optional(v.number()),
} as const;

function normalizeMintCommon(args: {
  label?: string;
  expiresAt?: number;
  maxUses?: number;
}): { label?: string; expiresAt?: number; maxUses?: number } {
  const label = args.label?.trim() || undefined;
  if (args.expiresAt !== undefined && args.expiresAt <= Date.now()) {
    throw new Error("Expiry must be in the future");
  }
  if (args.maxUses !== undefined && (!Number.isInteger(args.maxUses) || args.maxUses < 1)) {
    throw new Error("Max uses must be a positive whole number");
  }
  return { label, expiresAt: args.expiresAt, maxUses: args.maxUses };
}

async function insertInvite(
  ctx: MutationCtx,
  fields: {
    kind: "create_institution" | "join_institution";
    institutionId?: Id<"institutions">;
    role?: Role & ("school_admin" | "teacher" | "scholar");
    createdBy: Id<"users">;
    label?: string;
    expiresAt?: number;
    maxUses?: number;
  },
): Promise<{ inviteId: Id<"institutionInvites">; code: string; path: string; url: string }> {
  const code = generateInviteCode();
  const inviteId = await ctx.db.insert("institutionInvites", {
    code,
    kind: fields.kind,
    ...(fields.institutionId ? { institutionId: fields.institutionId } : {}),
    ...(fields.role ? { role: fields.role } : {}),
    createdBy: fields.createdBy,
    createdAt: Date.now(),
    usedCount: 0,
    ...(fields.label ? { label: fields.label } : {}),
    ...(fields.expiresAt !== undefined ? { expiresAt: fields.expiresAt } : {}),
    ...(fields.maxUses !== undefined ? { maxUses: fields.maxUses } : {}),
  });
  return { inviteId, code, path: invitePath(code), url: inviteUrl(code) };
}

// ── Mint ──────────────────────────────────────────────────────────────

/**
 * Platform-admin: mint a `create_institution` invite. The redeemer names +
 * creates their OWN new institution and becomes its school_admin. Grants
 * nothing global. This is the headline multi-tenant onboarding link.
 */
export const mintCreateInstitutionInvite = platformAdminMutation({
  args: { ...mintCommonArgs },
  handler: async (ctx, args) => {
    const common = normalizeMintCommon(args);
    return await insertInvite(ctx, {
      kind: "create_institution",
      createdBy: ctx.user._id,
      ...common,
    });
  },
});

/**
 * School-admin: mint a `join_institution` invite for the caller's OWN
 * institution. Role is limited to teacher | scholar — a school_admin can never
 * mint a school_admin (or any other) join, and can never target another
 * institution (the target is resolved from their own membership lens, not an
 * arg). A platform_admin acting here is scoped to their home/primary; to mint
 * for an arbitrary institution (or a school_admin join) they use
 * `mintJoinInviteForInstitution`.
 */
export const mintJoinInvite = schoolAdminMutation({
  args: {
    role: v.union(v.literal(ROLES.TEACHER), v.literal(ROLES.SCHOLAR)),
    scope: v.optional(v.string()),
    ...mintCommonArgs,
  },
  handler: async (ctx, args) => {
    const common = normalizeMintCommon(args);
    // The caller's own institution — never a client-supplied id.
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institutionId =
      lens.institution?._id ??
      lens.homeInstitution?._id ??
      lens.primaryInstitution?._id;
    if (!institutionId) {
      throw new Error("No institution to mint an invite for");
    }
    return await insertInvite(ctx, {
      kind: "join_institution",
      institutionId,
      role: args.role,
      createdBy: ctx.user._id,
      ...common,
    });
  },
});

/**
 * Platform-admin: mint a `join_institution` invite for ANY institution, at any
 * role INCLUDING school_admin. This is the only path that can mint a
 * school_admin join — the school-admin surface (`mintJoinInvite`) deliberately
 * cannot. Used to add a co-leader to an existing school.
 */
export const mintJoinInviteForInstitution = platformAdminMutation({
  args: {
    institutionId: v.id("institutions"),
    role: v.union(
      v.literal(ROLES.SCHOOL_ADMIN),
      v.literal(ROLES.TEACHER),
      v.literal(ROLES.SCHOLAR),
    ),
    ...mintCommonArgs,
  },
  handler: async (ctx, args) => {
    const common = normalizeMintCommon(args);
    const inst = await ctx.db.get(args.institutionId);
    if (!inst) throw new Error("Institution not found");
    return await insertInvite(ctx, {
      kind: "join_institution",
      institutionId: args.institutionId,
      role: args.role,
      createdBy: ctx.user._id,
      ...common,
    });
  },
});

// ── List ──────────────────────────────────────────────────────────────

async function hydrateInvite(
  ctx: QueryCtx,
  invite: InstitutionInvite,
): Promise<{
  _id: Id<"institutionInvites">;
  kind: "create_institution" | "join_institution";
  code: string;
  url: string;
  path: string;
  institutionId: Id<"institutions"> | null;
  createdInstitutionId: Id<"institutions"> | null;
  institutionName: string | null;
  redeemedBy: Id<"users"> | null;
  redeemedAt: number | null;
  role: string | null;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  status: ReturnType<typeof inviteStatus>;
}> {
  const displayedInstitutionId =
    invite.institutionId ?? invite.createdInstitutionId;
  const inst = displayedInstitutionId
    ? ((await ctx.db.get(displayedInstitutionId)) as Doc<"institutions"> | null)
    : null;
  return {
    _id: invite._id,
    kind: invite.kind,
    code: invite.code,
    url: inviteUrl(invite.code),
    path: invitePath(invite.code),
    institutionId: invite.institutionId ?? null,
    createdInstitutionId: invite.createdInstitutionId ?? null,
    institutionName: inst?.name ?? null,
    redeemedBy: invite.redeemedBy ?? null,
    redeemedAt: invite.redeemedAt ?? null,
    role: invite.role ?? null,
    label: invite.label ?? null,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt ?? null,
    maxUses: invite.maxUses ?? null,
    usedCount: invite.usedCount,
    status: inviteStatus(invite, Date.now()),
  };
}

/** Platform-admin: every invite (both kinds), newest first. */
export const listInvites = platformAdminQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("institutionInvites").collect();
    rows.sort((a, b) => b.createdAt - a.createdAt);
    return await Promise.all(rows.map((r) => hydrateInvite(ctx, r)));
  },
});

/**
 * School-admin: the `join_institution` invites for the caller's OWN
 * institution, newest first. A platform_admin acting here sees the lensed
 * school's invites.
 */
export const listJoinInvites = schoolAdminQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institutionId =
      lens.institution?._id ??
      lens.homeInstitution?._id ??
      lens.primaryInstitution?._id;
    if (!institutionId) return [];
    const rows = await ctx.db
      .query("institutionInvites")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    const joins = rows.filter((r) => r.kind === "join_institution");
    joins.sort((a, b) => b.createdAt - a.createdAt);
    return await Promise.all(joins.map((r) => hydrateInvite(ctx, r)));
  },
});

// ── Revoke ────────────────────────────────────────────────────────────

/** Platform-admin: permanently revoke any invite. Idempotent. */
export const revokeInvite = platformAdminMutation({
  args: { inviteId: v.id("institutionInvites") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) return; // idempotent
    if (invite.revokedAt === undefined) {
      await ctx.db.patch(args.inviteId, { revokedAt: Date.now() });
    }
  },
});

/**
 * School-admin: revoke a `join_institution` invite for the caller's OWN
 * institution only. A platform_admin (lens.isAdmin) may revoke any join
 * invite; a school_admin is bounded to their allowed institutions.
 */
export const revokeJoinInvite = schoolAdminMutation({
  args: { inviteId: v.id("institutionInvites"), scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) return; // idempotent
    if (invite.kind !== "join_institution") {
      throw new Error("Not a join invite");
    }
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const inScope =
      lens.isAdmin ||
      (!!invite.institutionId &&
        lens.allowedInstitutionIds.has(invite.institutionId));
    if (!inScope) throw new Error("Invite not found");
    if (invite.revokedAt === undefined) {
      await ctx.db.patch(args.inviteId, { revokedAt: Date.now() });
    }
  },
});

// ── Delete ────────────────────────────────────────────────────────────

async function deleteTerminalInvite(
  ctx: MutationCtx,
  invite: InstitutionInvite,
): Promise<void> {
  if (isInviteRedeemable(invite, Date.now())) {
    throw new Error("Live invites must be revoked before deletion");
  }
  // Delete exactly one invite row. Membership provenance may retain this
  // inviteId; users, memberships, and institutions are intentionally untouched.
  await ctx.db.delete(invite._id);
}

/** Platform-admin: delete any dead invite. Idempotent if already deleted. */
export const deleteInvite = platformAdminMutation({
  args: { inviteId: v.id("institutionInvites") },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) return;
    await deleteTerminalInvite(ctx, invite);
  },
});

/**
 * School-admin: delete a dead `join_institution` invite for the caller's OWN
 * institution only. A platform_admin (lens.isAdmin) may delete any dead join
 * invite through this scoped surface.
 */
export const deleteJoinInvite = schoolAdminMutation({
  args: { inviteId: v.id("institutionInvites"), scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const invite = await ctx.db.get(args.inviteId);
    if (!invite) return;
    if (invite.kind !== "join_institution") {
      throw new Error("Not a join invite");
    }
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const inScope =
      lens.isAdmin ||
      (!!invite.institutionId &&
        lens.allowedInstitutionIds.has(invite.institutionId));
    if (!inScope) throw new Error("Invite not found");
    await deleteTerminalInvite(ctx, invite);
  },
});

// ── Public: /join page lookup ───────────────────────────────────────────

/**
 * Public: validate an invite code for the /join page. Returns null if the code
 * is unknown or no longer redeemable (revoked / expired / used up), so the page
 * can render a clear invalid/expired state. On success returns only what the
 * page needs to render the right form + ceremony — no secrets.
 *
 * `ceremony` is computed server-side from the redeemer's eventual role
 * (`isPasskeyRole`): a create_institution redeemer (→ school_admin) and staff
 * join redeemers enroll a passkey; a scholar join redeemer sets a password.
 */
export const inviteInfo = query({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const invite = await findInviteByCode(ctx, args.code);
    if (!invite || !isInviteRedeemable(invite, Date.now())) return null;

    // The role the redeemer ends up with: create_institution → school_admin;
    // join_institution → the invite's role.
    const effectiveRole: Role =
      invite.kind === "create_institution"
        ? ROLES.SCHOOL_ADMIN
        : (invite.role as Role);

    let institutionName: string | null = null;
    if (invite.kind === "join_institution" && invite.institutionId) {
      const inst = await ctx.db.get(invite.institutionId);
      institutionName = inst?.name ?? null;
    }

    return {
      kind: invite.kind,
      role: effectiveRole,
      institutionName,
      label: invite.label ?? null,
      ceremony: isPasskeyRole(effectiveRole) ? "passkey" : "password",
    };
  },
});
