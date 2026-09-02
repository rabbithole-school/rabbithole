/**
 * One-time enrollment tokens — the bootstrap path for a staffer's FIRST
 * passkey.
 *
 * Passwordless staff can't log in to register their first credential, so
 * an admin (or the CLI, for last-admin recovery) issues a single-use,
 * time-boxed token. The staffer opens /enroll?token=... and runs the
 * registration ceremony (see convex/passkeys.ts startEnrollmentWithToken).
 *
 * Only a sha256 hash of the raw token is stored; the raw token is shown to
 * the admin exactly once. See .claude/rules/rabbithole-passkeys.md.
 */
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { platformAdminMutation, scholarAdminMutation, schoolAdminMutation } from "./lib/customFunctions";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { createAccount, modifyAccountCredentials } from "@convex-dev/auth/server";
import { ENROLLMENT_TOKEN_TTL_MS } from "./lib/passkeyConfig";
import { isPasskeyRole, ROLES, type Role } from "./lib/roles";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { requireScholarsAccessible } from "./lib/access";
import { scholarHasPasswordCredential } from "./lib/scholarCredential";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
} from "../shared/password";
import { grantPasswordBind } from "./lib/authGuards";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return isoBase64URL.fromBuffer(bytes);
}

/** Shared: create a token row for a user, return the raw token.
 * Exported for the Slack bot's `issue_parent_enroll_link` tool
 * (convex/slackAdminOps.ts) — same invalidate-then-issue semantics. */
export async function createTokenForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
  issuedBy: Id<"users"> | undefined,
): Promise<string> {
  // Invalidate any outstanding unused tokens for this user first.
  const prior = await ctx.db
    .query("enrollmentTokens")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const t of prior) {
    if (!t.usedAt) await ctx.db.delete(t._id);
  }
  const raw = generateRawToken();
  const tokenHash = await sha256Hex(raw);
  await ctx.db.insert("enrollmentTokens", {
    userId,
    tokenHash,
    expiresAt: Date.now() + ENROLLMENT_TOKEN_TTL_MS,
    issuedBy,
  });
  return raw;
}

/**
 * Shared token lookup for BOTH validateToken (internal, used by the redemption
 * actions) and tokenInfo (public, used by the /enroll page). Single source of
 * the validity rules — an unused, unexpired token whose user still exists —
 * so the page can never render a ceremony for a token a redeem will reject
 * (or vice-versa). Returns the RAW role (no scholar default): a role-less user
 * must not be silently treated as a scholar and slip past the redeem gate.
 */
async function lookupEnrollmentToken(
  ctx: QueryCtx,
  token: string,
): Promise<{
  userId: Id<"users">;
  username: string | null;
  name: string | null;
  role: string | null;
} | null> {
  const tokenHash = await sha256Hex(token);
  const row = await ctx.db
    .query("enrollmentTokens")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
  if (!row || row.usedAt || row.expiresAt < Date.now()) return null;
  const user = await ctx.db.get(row.userId);
  if (!user) return null;
  return {
    userId: row.userId,
    username: user.username ?? null,
    name: user.name ?? null,
    role: user.role ?? null,
  };
}

/** Internal: validate a raw token, returning the target user (or null). */
export const validateToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => lookupEnrollmentToken(ctx, args.token),
});

/**
 * Public: given a raw enrollment token, report just enough for the /enroll
 * page to render the right ceremony, or null if invalid/expired/used. No
 * secrets. The token itself is the bearer credential (already shown once to
 * the operator), so exposing the username it points at is the same trust level
 * as the existing passkey `startEnrollmentWithToken`.
 *
 * `ceremony` is computed SERVER-side from the role (`isPasskeyRole`) so the
 * page never re-derives pin-vs-passkey from a raw role literal — the
 * client's branch and the server's redemption gate can't drift. Scholars →
 * "pin"; passkey-eligible staff/parents → "passkey".
 */
export const tokenInfo = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const info = await lookupEnrollmentToken(ctx, args.token);
    if (!info) return null;
    return {
      username: info.username,
      name: info.name,
      ceremony: isPasskeyRole(info.role as Role | null) ? "passkey" : "pin",
    };
  },
});

/** Internal: mark a token used (called after a successful enrollment). */
export const consumeToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const tokenHash = await sha256Hex(args.token);
    const row = await ctx.db
      .query("enrollmentTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (row && !row.usedAt) {
      await ctx.db.patch(row._id, { usedAt: Date.now() });
    }
  },
});

/**
 * Admin: issue a one-time enrollment token for a staff user. Returns the
 * raw token + a ready-to-share path. Show it to the staffer ONCE.
 */
export const issueToken = platformAdminMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("User not found");
    // Passkey-eligible = staff OR parent. Parents enroll a passkey from an
    // admin/operations staff-issued link — that's their email-free login path.
    if (!isPasskeyRole(target.role)) {
      throw new Error("Enrollment links are only for passkey accounts (staff or parents)");
    }
    const token = await createTokenForUser(ctx, args.userId, ctx.user._id);
    return { token, path: `/enroll?token=${encodeURIComponent(token)}` };
  },
});

/**
 * Scholar-admin (teacher / operations staff / admin): issue a one-time enrollment link
 * for a SCHOLAR account. Unlike the passkey link above, a scholar's link lets
 * them (or the operator handing over the device) choose a PIN — scholars sign in
 * with a username + password, not a passkey, so their credentials stay ADDITIVE
 * and there's no lockout risk on a shared iPad (see PASSKEY_ROLES in
 * lib/roles.ts).
 *
 * This is the reliable replacement for the old "temp PIN" from
 * `users.resetScholarPassword`: that never STORED a credential — it depended on
 * the sign-in screen silently bootstrapping the account on first use, a path
 * that breaks in production because Convex redacts the `InvalidAccountId` error
 * the fallback keys off of. The link's redeem action (`redeemScholarEnrollToken`)
 * writes the hashed PIN server-side, so the scholar can just sign in.
 *
 * Scholar-admin gate (not platform-admin): a teacher/operations staff handles the
 * "kid forgot their PIN" moment, so this must be reachable from the scholar
 * profile + the school-admin Scholars tab + the Slack bot — same authority
 * level as the reset it replaces (`users.resetScholarPassword` was
 * scholarAdminMutation).
 *
 * Institution scope IS enforced here (via `requireScholarsAccessible`): a
 * school_admin / teacher / operations staff may only mint a link for a scholar in
 * their own institution — a role check alone is a cross-tenant account-takeover
 * (mint a PIN link for a scholar@B, set a PIN, sign in as them). Platform admins
 * stay global. This scoping was previously deferred (the old `resetScholarPassword`
 * lacked it too); with multi-tenancy live and this now reachable from the
 * school-admin roster, the boundary is required. The Slack twin
 * (`slackAdminOps.issueScholarPinLink` → `mintScholarPinToken`) applies the same
 * `requireScholarsAccessible` scope on its own `callerUserId`.
 */
export const issueScholarEnrollLink = scholarAdminMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await requireScholarsAccessible(ctx, ctx.user, [args.userId]);
    const { token } = await mintScholarPinToken(ctx, args.userId, ctx.user._id);
    return { token, path: enrollPath(token) };
  },
});

/** The relative path a scholar/staffer opens to redeem an enroll token. Single
 * source of the `/enroll?token=…` shape for every issuer (in-app + Slack). */
export function enrollPath(token: string): string {
  return `/enroll?token=${encodeURIComponent(token)}`;
}

/**
 * Validate a scholar target and mint a one-time PIN enroll token for them.
 * Shared by the in-app `issueScholarEnrollLink` and the Slack `issueScholarPinLink`
 * so the target validation + mint never fork (each entry point still owns its
 * OWN caller-auth: the mutation wrapper vs the Slack `callerUserId` role check).
 * Throws on an invalid target; returns the (guaranteed non-null) username too so
 * callers don't re-fetch.
 */
export async function mintScholarPinToken(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  issuedBy: Id<"users">,
): Promise<{ token: string; username: string }> {
  const target = await ctx.db.get(scholarId);
  if (!target || target.role !== ROLES.SCHOLAR) {
    throw new Error("Scholar not found");
  }
  if (!target.username) {
    throw new Error("This scholar has no username — set one before issuing a link.");
  }
  const token = await createTokenForUser(ctx, scholarId, issuedBy);
  return { token, username: target.username };
}

/**
 * Internal: prep a scholar to receive a fresh PIN. Kills their live sessions
 * (so a shared iPad's previous scholar is logged out) and clears the legacy
 * `mustResetPassword` flag (which the old temp-PIN reset sets and the scholar
 * page turns into a forced, non-dismissible "set a new password" dialog — it
 * would otherwise fire the instant the scholar signs in with the PIN they just
 * chose). Returns whether a password credential already exists so the caller
 * knows to MODIFY it in place rather than CREATE a new one.
 *
 * Deliberately does NOT delete the `authAccounts` row: the caller updates the
 * secret with `modifyAccountCredentials`, so there's no destructive
 * wipe-then-recreate window that could leave a scholar with no credential if
 * the write fails. Scholar-only. Uses the auth tables' indexes, not full
 * scans — this runs behind the public, unauthenticated redeem action.
 */
export const prepareScholarForEnroll = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args): Promise<{ hasPasswordAccount: boolean }> => {
    const user = await ctx.db.get(args.userId);
    if (!user || user.role !== ROLES.SCHOLAR) throw new Error("Scholar not found");

    const sessions = await ctx.db
      .query("authSessions")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .collect();
    for (const s of sessions) {
      const refreshTokens = await ctx.db
        .query("authRefreshTokens")
        .withIndex("sessionId", (q) => q.eq("sessionId", s._id))
        .collect();
      for (const rt of refreshTokens) await ctx.db.delete(rt._id);
      await ctx.db.delete(s._id);
    }

    if (user.mustResetPassword) {
      await ctx.db.patch(args.userId, { mustResetPassword: false });
    }

    // Authorize the bind that `redeemScholarEnrollToken` is about to perform.
    // Safe here and nowhere else: the caller already validated a live one-time
    // token for THIS user. The grant is short-lived and single-use — see
    // lib/authGuards.assertScholarAdoptionAuthorized.
    await grantPasswordBind(ctx, args.userId);

    return {
      hasPasswordAccount: await scholarHasPasswordCredential(ctx, args.userId),
    };
  },
});

/**
 * Redeem a scholar enrollment link: validate the token, set the chosen PIN as
 * the scholar's password (stored hashed via Convex Auth), then burn the token.
 * Returns the username so the client can immediately sign in with
 * `signIn("password", { flow: "signIn" })`.
 *
 * Called from the public /enroll page, so it's an unauthenticated action gated
 * ENTIRELY by the one-time token (same trust model as the passkey enroll
 * actions). Works for both first-time setup and a forgotten-PIN reset:
 * `createAccount` links to the existing scholar row through our
 * `createOrUpdateUser` callback the first time; `modifyAccountCredentials`
 * swaps the secret in place on a re-issue — no destructive clear, so a failed
 * write never strands the scholar without a credential (and the token isn't
 * consumed until the write succeeds, so the same link can be retried).
 */
export const redeemScholarEnrollToken = action({
  args: { token: v.string(), pin: v.string() },
  handler: async (ctx, args): Promise<{ username: string }> => {
    const pin = normalizePassword(args.pin);
    if (pin.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `PIN must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }

    const result = await ctx.runQuery(internal.enrollment.validateToken, {
      token: args.token,
    });
    if (!result) throw new Error("This enrollment link is invalid or expired.");
    if (result.role !== ROLES.SCHOLAR) {
      throw new Error("This link isn't for a scholar account.");
    }
    if (!result.username) throw new Error("This scholar has no username.");

    const { hasPasswordAccount } = await ctx.runMutation(
      internal.enrollment.prepareScholarForEnroll,
      { userId: result.userId },
    );

    // The synthetic email the Password provider + AuthForm use for scholars.
    const email = `${result.username}@local`;
    if (hasPasswordAccount) {
      // Re-issue: swap the secret in place (no delete → no lockout window).
      await modifyAccountCredentials(ctx, {
        provider: "password",
        account: { id: email, secret: pin },
      });
    } else {
      // First-time: create + link to the existing scholar row.
      //
      // Legal only because `prepareScholarForEnroll` above opened a short-lived
      // `passwordBindAllowedUntil` grant on this row: `createOrUpdateUser`
      // refuses to adopt a scholar row for any password sign-up without one,
      // which is what closes the username-coupon hole. The grant is justified
      // here by the one-time token this action already validated.
      await createAccount(ctx, {
        provider: "password",
        account: { id: email, secret: pin },
        profile: { email },
      });
    }

    await ctx.runMutation(internal.enrollment.consumeToken, {
      token: args.token,
    });
    return { username: result.username };
  },
});

/**
 * Scholar-admin (teacher/admin/operations staff): issue a one-time passkey
 * enrollment link for a PARENT account. This is the primary parent
 * onboarding path and needs no email — the operator hands the link to the
 * parent (text/in person), who registers a passkey and then signs in with
 * it. Surfaced in the ParentsManager. Parent-only; staff enrollment stays
 * on the admin-gated `issueToken`.
 */
export const issueParentEnrollLink = scholarAdminMutation({
  args: { parentId: v.id("users") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.parentId);
    if (!target || target.role !== ROLES.PARENT) {
      throw new Error("Parent not found");
    }
    const token = await createTokenForUser(ctx, args.parentId, ctx.user._id);
    return { token, path: `/enroll?token=${encodeURIComponent(token)}` };
  },
});

/**
 * Issue a passkey enrollment link for a STAFF account — school-admin only (the
 * institution leader). Restricted to the roles a school admin may grant
 * (teacher / operations staff / curriculum_designer); it deliberately will NOT mint a
 * link for another `school_admin` or `platform_admin` (those stay platform-only,
 * via `enrollment.issueToken` on the /admin console). Pairs with
 * `users.createInstitutionStaff`.
 */
export const issueStaffEnrollLink = schoolAdminMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.userId);
    const grantable: readonly string[] = [
      ROLES.TEACHER,
      ROLES.STAFF,
      ROLES.CURRICULUM_DESIGNER,
    ];
    if (!target || !target.role || !grantable.includes(target.role)) {
      throw new Error("Staff account not found");
    }
    // Institution scope: a school_admin may only issue a link for a staffer in
    // THEIR institution (else school_admin@A could mint an enroll link for a
    // teacher@B and take over the account). A platform_admin (lens.isAdmin) is
    // global. Mirrors the institution stamping in users.createInstitutionStaff.
    const lens = await resolveInstitutionLens(ctx, ctx.user);
    if (!lens.isAdmin) {
      const targetMemberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", args.userId))
        .collect();
      const inScope = targetMemberships.some(
        (m) => m.institutionId && lens.allowedInstitutionIds.has(m.institutionId),
      );
      if (!inScope) throw new Error("Staff account not found");
    }
    const token = await createTokenForUser(ctx, args.userId, ctx.user._id);
    return { token, path: `/enroll?token=${encodeURIComponent(token)}` };
  },
});

/**
 * Admin: reset a staffer's passkeys (lost device). Removes all their
 * credentials and issues a fresh enrollment token so they can re-enroll.
 */
export const adminResetPasskeys = platformAdminMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("User not found");
    const existing = await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
    for (const p of existing) await ctx.db.delete(p._id);
    const token = await createTokenForUser(ctx, args.userId, ctx.user._id);
    return {
      removed: existing.length,
      token,
      path: `/enroll?token=${encodeURIComponent(token)}`,
    };
  },
});

/**
 * Sweep dead enrollment-token rows: ones already used (`usedAt` set) or
 * past their 7-day expiry. `createTokenForUser` only clears a user's prior
 * *unused* tokens when issuing a new one, so consumed tokens and expired
 * tokens for users who never get re-issued would otherwise linger forever.
 * A daily cron is plenty (7-day TTL). Bounded scan — the table is small.
 */
export const sweepStaleTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("enrollmentTokens").take(2000);
    let removed = 0;
    for (const row of rows) {
      if (row.usedAt !== undefined || row.expiresAt < now) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return { removed };
  },
});

/**
 * CLI escape hatch for last-admin lockout. Run from master with prod
 * approval (see rabbithole-convex-deploys.md):
 *   npx convex run enrollment:issueTokenCli '{"username":"andy"}'
 */
export const issueTokenCli = internalMutation({
  args: {
    username: v.optional(v.string()),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    let userId = args.userId;
    if (!userId && args.username) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", args.username))
        .unique();
      if (!user) throw new Error(`No user with username ${args.username}`);
      userId = user._id;
    }
    if (!userId) throw new Error("Provide username or userId");
    const token = await createTokenForUser(ctx, userId, undefined);
    return { token, path: `/enroll?token=${encodeURIComponent(token)}` };
  },
});
