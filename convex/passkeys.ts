/**
 * WebAuthn / passkey ceremonies + credential storage.
 *
 * @convex-dev/auth has no passkey provider, so we implement WebAuthn with
 * SimpleWebAuthn. This file owns:
 *   - internal CRUD over `passkeys` + `webauthnChallenges` (used by the
 *     actions here AND by the sign-in `authorize` in convex/auth.ts)
 *   - public ACTIONS that run the two WebAuthn ceremonies:
 *       registration (enroll a credential) and the *options* half of
 *       authentication. The *verify* half of authentication lives in
 *       convex/auth.ts because that's where the session gets minted.
 *   - public queries/mutations for a user to inspect/manage their own
 *     passkeys.
 *
 * The actual sign-in (verify authentication + mint session) is the
 * `Passkey` ConvexCredentials provider in convex/auth.ts.
 *
 * Crypto note: SimpleWebAuthn here runs in Convex's DEFAULT runtime (Web
 * Crypto), NOT "use node" — it must match the runtime of the auth
 * provider's `authorize`, which also verifies in the default runtime.
 *
 * See .claude/rules/rabbithole-passkeys.md.
 */
import { v } from "convex/values";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
} from "@simplewebauthn/server";
import { isoBase64URL, isoUint8Array } from "@simplewebauthn/server/helpers";
import type {
  RegistrationResponseJSON,
  AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import {
  action,
  internalMutation,
  internalQuery,
  type ActionCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  authedQuery,
  authedMutation,
  platformAdminQuery,
  scholarAdminQuery,
  scholarAdminMutation,
} from "./lib/customFunctions";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireActiveScholarAccess } from "./lib/access";
import { getSessionOwner } from "./lib/auth";
import { getPasskeyConfig, CHALLENGE_TTL_MS } from "./lib/passkeyConfig";
import { isPasskeyRole, isStaffRole, ROLES, type Role } from "./lib/roles";

// ── Internal CRUD (callable from actions + auth.ts authorize) ──────────

/** Create a challenge row, return its id (used as opaque challengeId). */
export const createChallenge = internalMutation({
  args: {
    challenge: v.string(),
    type: v.union(v.literal("registration"), v.literal("authentication")),
    userId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("webauthnChallenges", {
      challenge: args.challenge,
      type: args.type,
      userId: args.userId,
      expiresAt: Date.now() + CHALLENGE_TTL_MS,
    });
  },
});

/**
 * Atomically read + delete a challenge (one-shot, anti-replay). Returns
 * null if missing, expired, or the wrong ceremony type.
 */
export const takeChallenge = internalMutation({
  args: {
    challengeId: v.id("webauthnChallenges"),
    type: v.union(v.literal("registration"), v.literal("authentication")),
  },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.challengeId);
    if (!row) return null;
    // Always consume, even on mismatch, so a bad attempt burns the row.
    await ctx.db.delete(args.challengeId);
    if (row.type !== args.type) return null;
    if (row.expiresAt < Date.now()) return null;
    return { challenge: row.challenge, userId: row.userId ?? null };
  },
});

/**
 * Sweep expired/abandoned challenge rows. Challenges are normally consumed
 * one-shot by `takeChallenge`, but an abandoned ceremony (the browser
 * prompt is dismissed, the tab is closed) leaves its row behind forever —
 * there's no consume on the unhappy path. TTL is 5 min, so anything past
 * `expiresAt` is dead weight; an hourly cron keeps the table from growing
 * unbounded. Bounded scan (no expiresAt index — the live table is small).
 */
export const sweepExpiredChallenges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("webauthnChallenges").take(2000);
    let removed = 0;
    for (const row of rows) {
      if (row.expiresAt < now) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return { removed };
  },
});

/** Look up a credential by its (base64url) credential ID. */
export const getByCredentialId = internalQuery({
  args: { credentialId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("passkeys")
      .withIndex("by_credentialId", (q) =>
        q.eq("credentialId", args.credentialId),
      )
      .unique();
  },
});

/** List a user's credentials (internal — for excludeCredentials). */
export const listByUserInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

/** Insert a freshly-verified credential. */
export const insertCredential = internalMutation({
  args: {
    userId: v.id("users"),
    credentialId: v.string(),
    publicKey: v.string(),
    counter: v.number(),
    transports: v.optional(v.array(v.string())),
    deviceType: v.optional(v.string()),
    backedUp: v.optional(v.boolean()),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Guard against a duplicate credential row (idempotent re-enroll).
    const existing = await ctx.db
      .query("passkeys")
      .withIndex("by_credentialId", (q) =>
        q.eq("credentialId", args.credentialId),
      )
      .unique();
    if (existing) return existing._id;
    const passkeyId = await ctx.db.insert("passkeys", {
      ...args,
      createdAt: Date.now(),
    });
    // Enrolling a passkey COMPLETES passwordless setup for an invite-created
    // staff account — clear the pending flag so the account is now fully
    // enrolled (and the password-bootstrap gate no longer applies). Canonical
    // clear point: every passkey enrollment (token or in-app) lands here.
    const user = await ctx.db.get(args.userId);
    if (user?.pendingEnrollment) {
      await ctx.db.patch(args.userId, { pendingEnrollment: false });
    }
    return passkeyId;
  },
});

/**
 * Bump the signature counter + lastUsedAt after a successful auth, and
 * refresh the device-type/backup flags (a passkey can become synced after
 * registration, so we re-capture what the authenticator reports each time).
 */
export const recordAuthentication = internalMutation({
  args: {
    passkeyId: v.id("passkeys"),
    newCounter: v.number(),
    deviceType: v.optional(v.string()),
    backedUp: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.passkeyId, {
      counter: args.newCounter,
      lastUsedAt: Date.now(),
      ...(args.deviceType !== undefined ? { deviceType: args.deviceType } : {}),
      ...(args.backedUp !== undefined ? { backedUp: args.backedUp } : {}),
    });
  },
});

// ── Ceremony actions ───────────────────────────────────────────────────

/**
 * Authentication ceremony, step 1 (anonymous): produce options + a
 * challenge for a passwordless sign-in. We use discoverable credentials
 * (empty allowCredentials) so the browser offers any passkey for this RP.
 * The client then calls signIn("passkey", { response, challengeId }).
 */
export const startAuthentication = action({
  args: {},
  handler: async (ctx): Promise<{ options: unknown; challengeId: string }> => {
    const { rpID } = getPasskeyConfig();
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
    });
    const challengeId = await ctx.runMutation(
      internal.passkeys.createChallenge,
      { challenge: options.challenge, type: "authentication" },
    );
    return { options, challengeId };
  },
});

/**
 * Registration ceremony, step 1, for an ALREADY SIGNED-IN user adding
 * another passkey to their account.
 */
export const startEnrollment = action({
  args: {},
  handler: async (ctx): Promise<{ options: unknown; challengeId: string }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return await buildRegistrationOptions(ctx, userId);
  },
});

/** Registration ceremony, step 2, for a signed-in user. */
export const finishEnrollment = action({
  args: {
    challengeId: v.id("webauthnChallenges"),
    response: v.string(), // JSON-encoded RegistrationResponseJSON
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    await verifyAndStoreRegistration(ctx, {
      challengeId: args.challengeId,
      response: args.response,
      label: args.label,
      expectedUserId: userId,
    });
    return { ok: true };
  },
});

/**
 * Registration ceremony, step 1, via a one-time enrollment token (the
 * staffer is NOT signed in yet — bootstrapping their first passkey).
 */
export const startEnrollmentWithToken = action({
  args: { token: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    options: unknown;
    challengeId: string;
    username: string | null;
  }> => {
    const result = await ctx.runQuery(internal.enrollment.validateToken, {
      token: args.token,
    });
    if (!result) throw new Error("This enrollment link is invalid or expired.");
    // The enrollmentTokens table is shared with the scholar PIN flow
    // (enrollment.issueScholarEnrollLink). A passkey ceremony must refuse a
    // scholar's token, or driving a PIN link through these public actions
    // would register a passkey on a scholar account and burn the token without
    // ever setting the PIN. Mirror of the `role === SCHOLAR` gate in
    // enrollment.redeemScholarEnrollToken.
    if (!isPasskeyRole(result.role as Role | null)) {
      throw new Error("This link isn't for a passkey account.");
    }
    const built = await buildRegistrationOptions(ctx, result.userId);
    return { ...built, username: result.username };
  },
});

/** Registration ceremony, step 2, via a one-time enrollment token. */
export const finishEnrollmentWithToken = action({
  args: {
    token: v.string(),
    challengeId: v.id("webauthnChallenges"),
    response: v.string(),
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const result = await ctx.runQuery(internal.enrollment.validateToken, {
      token: args.token,
    });
    if (!result) throw new Error("This enrollment link is invalid or expired.");
    // Refuse a scholar PIN token here too (see startEnrollmentWithToken).
    if (!isPasskeyRole(result.role as Role | null)) {
      throw new Error("This link isn't for a passkey account.");
    }
    await verifyAndStoreRegistration(ctx, {
      challengeId: args.challengeId,
      response: args.response,
      label: args.label,
      expectedUserId: result.userId,
    });
    await ctx.runMutation(internal.enrollment.consumeToken, {
      token: args.token,
    });
    return { ok: true };
  },
});

// ── Shared helpers (run inside actions) ─────────────────────────────────

async function buildRegistrationOptions(
  ctx: ActionCtx,
  userId: Id<"users">,
): Promise<{ options: unknown; challengeId: string }> {
  const { rpID, rpName } = getPasskeyConfig();
  const user = await ctx.runQuery(internal.users.getByIdInternal, {
    id: userId,
  });
  const existing = await ctx.runQuery(internal.passkeys.listByUserInternal, {
    userId,
  });
  const options = await generateRegistrationOptions({
    rpID,
    rpName,
    userName: user?.username ?? user?.name ?? "rabbithole-user",
    userDisplayName: user?.name ?? user?.username ?? "Rabbithole user",
    userID: isoUint8Array.fromUTF8String(userId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as AuthenticatorTransportFuture[] | undefined,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
  const challengeId = await ctx.runMutation(internal.passkeys.createChallenge, {
    challenge: options.challenge,
    type: "registration",
    userId,
  });
  return { options, challengeId };
}

async function verifyAndStoreRegistration(
  ctx: ActionCtx,
  args: {
    challengeId: Id<"webauthnChallenges">;
    response: string;
    label?: string;
    expectedUserId: Id<"users">;
  },
): Promise<void> {
  const taken = await ctx.runMutation(internal.passkeys.takeChallenge, {
    challengeId: args.challengeId,
    type: "registration",
  });
  if (!taken) throw new Error("Registration challenge expired — try again.");
  if (taken.userId && taken.userId !== args.expectedUserId) {
    throw new Error("Challenge does not belong to this user.");
  }

  const { rpID, origins } = getPasskeyConfig();
  const response = JSON.parse(args.response) as RegistrationResponseJSON;
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge: taken.challenge,
    expectedOrigin: origins,
    expectedRPID: rpID,
    requireUserVerification: false,
  });
  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Passkey could not be verified.");
  }
  const { credential, credentialDeviceType, credentialBackedUp } =
    verification.registrationInfo;
  await ctx.runMutation(internal.passkeys.insertCredential, {
    userId: args.expectedUserId,
    credentialId: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
    label: args.label,
  });
}

// ── User-facing queries / mutations ────────────────────────────────────

/**
 * Status for the current user. `mustEnroll` drives the forced-enrollment
 * gate: a staffer with zero passkeys must set one up before using the app.
 * `hasMultiDevice` is true when at least one passkey is syncable across
 * devices (the resilience signal — see the recovery design).
 */
export const myStatus = authedQuery({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    hasPasskey: boolean;
    count: number;
    isStaff: boolean;
    mustEnroll: boolean;
    hasMultiDevice: boolean;
  }> => {
    // Passkeys belong to the REAL session owner, not the impersonation target
    // — enrollment/status is about "my account", and resolving the target here
    // would (wrongly) route an impersonated staff view into /setup-passkey.
    const owner = (await getSessionOwner(ctx)) ?? ctx.user;
    const rows = await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", owner._id))
      .collect();
    const isStaff = isStaffRole(owner.role);
    return {
      hasPasskey: rows.length > 0,
      count: rows.length,
      isStaff,
      mustEnroll: isStaff && rows.length === 0,
      hasMultiDevice: rows.some((r) => r.deviceType === "multiDevice"),
    };
  },
});

/** List the current user's passkeys (no secrets). */
export const listMine = authedQuery({
  args: {},
  handler: async (ctx) => {
    const owner = (await getSessionOwner(ctx)) ?? ctx.user;
    const rows = await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", owner._id))
      .collect();
    return rows.map((r) => ({
      _id: r._id,
      label: r.label,
      deviceType: r.deviceType,
      backedUp: r.backedUp,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    }));
  },
});

/** Admin: passkey count per user (for the admin user table). */
export const adminCounts = platformAdminQuery({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("passkeys").collect();
    const counts: Record<string, number> = {};
    for (const p of all) {
      counts[p.userId] = (counts[p.userId] ?? 0) + 1;
    }
    return counts;
  },
});

/** Delete one of the current user's own passkeys. */
export const deleteMine = authedMutation({
  args: { passkeyId: v.id("passkeys") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.passkeyId);
    if (!row || row.userId !== ctx.user._id) {
      throw new Error("Forbidden");
    }
    await ctx.db.delete(args.passkeyId);
  },
});

/**
 * DEV-ONLY enrollment bypass — inserts a SENTINEL passkey so a staff user
 * isn't force-redirected to /setup-passkey (`mustEnroll = isStaff && count
 * === 0`). Called ONLY from the `devLogin` provider in convex/auth.ts, which
 * is itself double-guarded against prod (refuses on the prod slug + requires
 * DEV_TEST_LOGIN_SECRET, never set on prod).
 *
 * The credentialId MUST be valid base64url: `buildRegistrationOptions` feeds
 * every stored credentialId into `generateRegistrationOptions`' excludeCredentials,
 * which throws on a non-base64url id — so a colon (or any non-[A-Za-z0-9-_]
 * char) here would BREAK real passkey enrollment for this user. We use a
 * base64url-safe sentinel prefix + the (base64url) userId. It still can never
 * match a real WebAuthn assertion id, so it's inert for actual sign-in — it
 * only satisfies the count gate for test / handoff sessions.
 */
export const devEnsureEnrollmentBypass = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user || !isStaffRole(user.role)) return;
    const existing = await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    if (existing) return;
    await ctx.db.insert("passkeys", {
      userId,
      // base64url-safe (hyphen, not colon) — see comment above.
      credentialId: `dev-login-sentinel-${userId}`,
      publicKey: "",
      counter: 0,
      label: "dev-login sentinel (not a real passkey)",
      createdAt: Date.now(),
    });
  },
});

// ── Scholar passkey administration (teacher / admin / operations staff) ────────
//
// Scholars enroll passkeys OPT-IN (their password always keeps working —
// see review/native-passkey-plan.md Phase B), so recovery is simple:
// removing a lost passkey instantly restores password-only sign-in. No
// enrollment token needed, unlike the staff flow in enrollment.ts.

/** How many passkeys a scholar has — drives the remove button. */
export const countForScholar = scholarAdminQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const rows = await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();
    return rows.length;
  },
});

/** Remove ALL of a scholar's passkeys (lost passkey / fresh start). */
export const resetForScholar = scholarAdminMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, args) => {
    await requireActiveScholarAccess(ctx, ctx.user, args.scholarId);
    const target = await ctx.db.get(args.scholarId);
    if (!target) throw new Error("Scholar not found");
    if (target.role !== ROLES.SCHOLAR) {
      throw new Error("Can only reset scholar passkeys");
    }
    const existing = await ctx.db
      .query("passkeys")
      .withIndex("by_user", (q) => q.eq("userId", args.scholarId))
      .collect();
    for (const p of existing) await ctx.db.delete(p._id);
    return { removed: existing.length };
  },
});
