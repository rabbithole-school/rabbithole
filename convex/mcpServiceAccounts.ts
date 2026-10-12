// Institution-scoped MCP SERVICE ACCOUNTS (bearer tokens).
//
// A school admin connecting Rabbithole's remote MCP server from a shared
// surface (a Claude Tag / Claude-in-Slack channel) needs ONE credential the
// whole channel acts as — not a real person's sign-in. This module backs a
// per-institution Teacher service account (role `teacher`) and Staff service
// account (role `staff` + the `school:operations` capability, which is what
// gives base staff any tools at all), each a hidden `users` row (isSystem)
// that can be authenticated ONLY by a long-lived bearer token the admin
// issues, pastes into Claude Tag, and can revoke. Per-teacher OAuth
// (convex/mcpOauth.ts) is unchanged; this is the machine-identity sibling.
//
// Token format: `rhsa_<kind>_<random>`. Only the sha256 hash is stored
// (`mcpServiceTokens.tokenHash`); the plaintext is returned exactly once from
// `issueToken`. At the /api/mcp route a bearer starting `rhsa_` is exchanged
// for a short-lived Convex Auth JWT via the "mcpServiceToken" provider
// (convex/auth.ts → redeemToken here). Each token owns exactly ONE auth
// session, created here and handed to Convex Auth by id, so exchanges never
// accumulate session rows and `revokeToken` deletes that one row — which the
// per-request probe in convex/mcp.ts (whoami) turns into an immediate 401.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { schoolAdminMutation, schoolAdminQuery } from "./lib/customFunctions";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { ROLES } from "./lib/roles";
import { sha256Hex, randomToken } from "./lib/oauthCrypto";
import { ensureActiveStaffCapabilityGrant } from "./lib/staffCapabilities";
import { revokeAuthSession } from "./lib/authSessions";
import type { Doc, Id } from "./_generated/dataModel";

type ServiceKind = "teacher" | "staff";
const kindValidator = v.union(v.literal("teacher"), v.literal("staff"));
const SERVICE_KINDS: ServiceKind[] = ["teacher", "staff"];

// Mirrors @convex-dev/auth's default session lifetime (sessions.ts) so the
// session we hand Convex Auth behaves like one it created itself.
const SESSION_TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30;

function roleForKind(kind: ServiceKind): typeof ROLES.TEACHER | typeof ROLES.STAFF {
  return kind === "teacher" ? ROLES.TEACHER : ROLES.STAFF;
}

function serviceUsername(institution: Doc<"institutions">, kind: ServiceKind): string {
  return `svc-${institution.slug}-${kind}`;
}

function serviceName(institution: Doc<"institutions">, kind: ServiceKind): string {
  return `${institution.name} ${kind} service account`;
}

/** Active (non-revoked) tokens for an institution, via `by_institution`. */
async function activeTokensFor(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
): Promise<Doc<"mcpServiceTokens">[]> {
  const tokens = await ctx.db
    .query("mcpServiceTokens")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  return tokens.filter((t) => t.revokedAt === undefined);
}

/**
 * Find or create the hidden service `users` row + its `memberships` row for an
 * institution+kind. The existing service user is located through the tokens
 * already issued for this institution (they carry `userId`), so a renamed
 * institution slug can never orphan a live credential; the username is only a
 * creation-time convention. A pre-existing row under that username that is NOT
 * already a system account is refused rather than adopted — otherwise a school
 * admin could turn a person into a machine identity by issuing a token.
 */
async function findOrCreateServiceUser(
  ctx: MutationCtx,
  institution: Doc<"institutions">,
  kind: ServiceKind,
  adminId: Id<"users">,
): Promise<Doc<"users">> {
  const role = roleForKind(kind);
  const name = serviceName(institution, kind);

  let user: Doc<"users"> | null = null;
  const priorToken = (await activeTokensFor(ctx, institution._id)).find((t) => t.kind === kind);
  if (priorToken) user = await ctx.db.get(priorToken.userId);

  if (!user) {
    const username = serviceUsername(institution, kind);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", username))
      .unique();
    if (existing && existing.isSystem !== true) {
      throw new Error(
        `The username ${username} belongs to a person; rename that account before issuing a token`,
      );
    }
    user = existing;
    if (!user) {
      const id = await ctx.db.insert("users", {
        name,
        username,
        role,
        isSystem: true,
        institutionId: institution._id,
        profileSetupComplete: true,
      });
      user = (await ctx.db.get(id))!;
    }
  }

  // Reconcile the security-critical shape back to least privilege on every
  // issue, so a drifted row (an admin's role edit) can't widen the token.
  const patch: Partial<Doc<"users">> = {};
  if (user.name !== name) patch.name = name;
  if (user.role !== role) patch.role = role;
  if (user.isSystem !== true) patch.isSystem = true;
  if (user.institutionId !== institution._id) patch.institutionId = institution._id;
  if (user.profileSetupComplete !== true) patch.profileSetupComplete = true;
  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(user._id, patch);
    user = (await ctx.db.get(user._id))!;
  }

  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", user!._id))
    .collect();
  const membership = memberships.find((m) => m.institutionId === institution._id);
  if (!membership) {
    await ctx.db.insert("memberships", {
      userId: user._id,
      role,
      institutionId: institution._id,
      createdBy: adminId,
    });
  } else if (membership.role !== role) {
    await ctx.db.patch(membership._id, { role });
  }

  // Base staff has no tools until it holds a capability; school operations
  // (scholar accounts + portfolio, no sensitive data) is the staff authority.
  if (kind === "staff") {
    await ensureActiveStaffCapabilityGrant(ctx, {
      granteeUserId: user._id,
      institutionId: institution._id,
      capability: "school:operations",
      grantedBy: adminId,
    });
  }

  return user;
}

/**
 * The service accounts + their active tokens for the caller's school. Read-only;
 * school-admin gate + the institution lens (a school_admin can never resolve a
 * school they don't administer). Falls back to the home institution exactly like
 * `institutions.getMySchool`, so the section and the page agree on which school
 * is shown. Revoked tokens are excluded.
 */
export const list = schoolAdminQuery({
  args: { scope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution found");

    const tokens = await activeTokensFor(ctx, institution._id);
    const names = new Map<Id<"users">, string>();
    const nameOf = async (id: Id<"users">) => {
      const cached = names.get(id);
      if (cached) return cached;
      const u = await ctx.db.get(id);
      const n = u?.name ?? u?.username ?? "Unknown";
      names.set(id, n);
      return n;
    };

    const accounts = [];
    for (const kind of SERVICE_KINDS) {
      const activeTokens = [];
      for (const t of tokens.filter((t) => t.kind === kind)) {
        activeTokens.push({
          _id: t._id,
          tokenHint: t.tokenHint,
          createdAt: t.createdAt,
          createdByName: await nameOf(t.createdBy),
          lastUsedAt: t.lastUsedAt ?? null,
        });
      }
      activeTokens.sort((a, b) => b.createdAt - a.createdAt);
      accounts.push({ kind, activeTokens });
    }
    return accounts;
  },
});

/**
 * Issue a new token for the institution's teacher or staff service account
 * (creating the account on first use). Returns the plaintext exactly once.
 * Multiple active tokens per kind are allowed so a channel can rotate.
 */
export const issueToken = schoolAdminMutation({
  args: { scope: v.optional(v.string()), kind: kindValidator },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const institution = lens.institution ?? lens.homeInstitution;
    if (!institution) throw new Error("No institution to issue a token for");

    const user = await findOrCreateServiceUser(ctx, institution, args.kind, ctx.user._id);

    const token = `rhsa_${args.kind}_${randomToken(32)}`;
    await ctx.db.insert("mcpServiceTokens", {
      institutionId: institution._id,
      userId: user._id,
      kind: args.kind,
      tokenHash: await sha256Hex(token),
      tokenHint: token.slice(-4),
      createdBy: ctx.user._id,
      createdAt: Date.now(),
    });

    return { token, tokenHint: token.slice(-4), kind: args.kind };
  },
});

/**
 * Revoke a token. School-admin gate + lens: the token's institution must be one
 * the caller administers (blocks cross-institution revocation). Deletes the one
 * auth session the token owns; when that was the service user's last active
 * token, every remaining session of the user goes too (belt and braces).
 */
export const revokeToken = schoolAdminMutation({
  args: { scope: v.optional(v.string()), tokenId: v.id("mcpServiceTokens") },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.scope);
    const token = await ctx.db.get(args.tokenId);
    if (!token) throw new Error("Token not found");
    if (!lens.allowedInstitutionIds.has(token.institutionId)) {
      throw new Error("Forbidden");
    }
    if (token.revokedAt !== undefined) return; // already revoked — idempotent

    await ctx.db.patch(token._id, {
      revokedAt: Date.now(),
      revokedBy: ctx.user._id,
    });
    if (token.sessionId) await killSession(ctx, token.sessionId);

    const remaining = await ctx.db
      .query("mcpServiceTokens")
      .withIndex("by_user", (q) => q.eq("userId", token.userId))
      .collect();
    if (!remaining.some((t) => t.revokedAt === undefined)) {
      const sessions = await ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", token.userId))
        .collect();
      for (const session of sessions) await killSession(ctx, session._id);
    }
  },
});

/** Session + refresh tokens (shared helper) + any mcpSessions sidecar. */
async function killSession(ctx: MutationCtx, sessionId: Id<"authSessions">): Promise<void> {
  await revokeAuthSession(ctx, sessionId);
  const sidecars = await ctx.db
    .query("mcpSessions")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const row of sidecars) await ctx.db.delete(row._id);
}

/**
 * Redeem a token hash → the service user + the token's one live session.
 * Called by the "mcpServiceToken" auth provider (convex/auth.ts), which hands
 * the sessionId to Convex Auth so it mints a JWT on THIS session instead of
 * creating a new row per exchange. Rejects a missing or revoked token; defence
 * in depth, also asserts the target row is a system account of the token's
 * kind at the token's institution before minting anything for it.
 */
export const redeemToken = internalMutation({
  args: { tokenHash: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ userId: Id<"users">; sessionId: Id<"authSessions"> } | null> => {
    const token = await ctx.db
      .query("mcpServiceTokens")
      .withIndex("by_hash", (q) => q.eq("tokenHash", args.tokenHash))
      .unique();
    if (!token || token.revokedAt !== undefined) return null;

    const user = await ctx.db.get(token.userId);
    if (!user || user.isSystem !== true) return null;
    if (user.role !== roleForKind(token.kind)) return null;
    if (user.institutionId !== token.institutionId) return null;

    const now = Date.now();
    let sessionId: Id<"authSessions"> | undefined = token.sessionId;
    const session = sessionId ? await ctx.db.get(sessionId) : null;
    if (!sessionId || !session || session.userId !== user._id || session.expirationTime <= now) {
      if (sessionId) await killSession(ctx, sessionId);
      sessionId = await ctx.db.insert("authSessions", {
        userId: user._id,
        expirationTime: now + SESSION_TOTAL_DURATION_MS,
      });
    }

    await ctx.db.patch(token._id, { lastUsedAt: now, sessionId });
    return { userId: user._id, sessionId };
  },
});
