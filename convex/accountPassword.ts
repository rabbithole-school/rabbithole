/**
 * Self-service password change — the signed-in user sets their OWN password.
 *
 * ── Why this exists (it replaces a client-side dance) ────────────────────
 * `SetPasswordDialog` used to do this entirely from the browser:
 *     deleteMyAuthAccounts()  →  signOut()  →  signIn(… flow: "signUp")
 * That had two problems, one of them security-relevant:
 *
 *   1. It opened an UNCLAIMED WINDOW. Between the delete and the re-signUp the
 *      account had no credential, so anyone who knew the username could win the
 *      race and bind their own password to it.
 *   2. That final `flow: "signUp"` is indistinguishable, server-side, from an
 *      attacker claiming a username — it arrives unauthenticated (signOut has
 *      already run). So the account-adoption guard in `createOrUpdateUser`
 *      could not tell the two apart, which is exactly what made the
 *      "username coupon" hole (TODO #scholar-self-claim) impossible to close
 *      while that flow existed.
 *
 * Doing it server-side fixes both: the caller's session proves who they are
 * BEFORE anything is mutated, the secret is swapped in place with
 * `modifyAccountCredentials` (no delete → no window), and the caller stays
 * signed in. Other sessions are invalidated, which is the useful half of the
 * old sign-out.
 *
 * Runs in the default Convex runtime (no "use node") — the auth helpers need an
 * ActionCtx, not Node.
 */
import { v } from "convex/values";
import { action, internalMutation, internalQuery } from "./_generated/server";
import {
  createAccount,
  getAuthSessionId,
  getAuthUserId,
  invalidateSessions,
  modifyAccountCredentials,
  retrieveAccount,
} from "@convex-dev/auth/server";
import { internal } from "./_generated/api";
import { grantPasswordBind } from "./lib/authGuards";
import { scholarHasPasswordCredential } from "./lib/scholarCredential";
import type { Id } from "./_generated/dataModel";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
} from "../shared/password";

export { MIN_PASSWORD_LENGTH };

/**
 * What `setMyPassword` needs to know about the caller before it writes. Kept
 * internal: it reports credential PRESENCE, never any secret.
 */
export const passwordContext = internalQuery({
  args: { userId: v.id("users") },
  handler: async (
    ctx,
    args,
  ): Promise<{
    username: string | null;
    hasPassword: boolean;
    mustResetPassword: boolean;
  } | null> => {
    const user = await ctx.db.get(args.userId);
    if (!user) return null;
    return {
      username: user.username ?? null,
      hasPassword: await scholarHasPasswordCredential(ctx, args.userId),
      mustResetPassword: user.mustResetPassword === true,
    };
  },
});

/** Clear the forced-reset flag once a new password is actually in place. */
export const clearMustReset = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (user?.mustResetPassword) {
      await ctx.db.patch(args.userId, { mustResetPassword: false });
    }
  },
});

/**
 * Authorize the FIRST password bind for an already-authenticated caller. The
 * action verifies the session before calling this; the grant is short-lived and
 * consumed by the auth callback. See lib/authGuards.
 */
export const allowPasswordBind = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    await grantPasswordBind(ctx, args.userId);
  },
});

/**
 * Set the signed-in user's password.
 *
 * `currentPassword` is REQUIRED when they already have one — that re-auth is
 * what stops a borrowed unlocked device from silently re-keying the account —
 * and is skipped only when `mustResetPassword` is set, since a forced reset is
 * precisely the case where the old secret is not trusted/known.
 *
 * Returns nothing useful on purpose: the caller keeps its existing session, so
 * there is no token to hand back.
 */
export const setMyPassword = action({
  args: {
    currentPassword: v.optional(v.string()),
    newPassword: v.string(),
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated.");

    const newPassword = normalizePassword(args.newPassword);
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }

    const context = await ctx.runQuery(internal.accountPassword.passwordContext, {
      userId,
    });
    if (!context) throw new Error("Account not found.");
    if (!context.username) {
      throw new Error("This account has no username — ask your teacher.");
    }
    // The synthetic address the Password provider keys scholar accounts on.
    const email = `${context.username}@local`;

    if (context.hasPassword && !context.mustResetPassword) {
      const currentPassword = args.currentPassword ?? "";
      if (!normalizePassword(currentPassword)) {
        throw new Error("Enter your current password.");
      }
      // Per its own docs, retrieveAccount returns null when there is no such
      // account but THROWS when the secret doesn't match — so both have to be
      // handled, and neither may leak which of the two happened. The provider's
      // crypto applies the shared normalization rule.
      let verified = false;
      try {
        verified =
          (await retrieveAccount(ctx, {
            provider: "password",
            account: { id: email, secret: currentPassword },
          })) !== null;
      } catch {
        verified = false;
      }
      if (!verified) throw new Error("Current password is incorrect.");
    }

    if (context.hasPassword) {
      // Swap in place — no delete, so there is never a moment where the account
      // has no credential for someone else to claim.
      await modifyAccountCredentials(ctx, {
        provider: "password",
        account: { id: email, secret: newPassword },
      });
    } else {
      // First password for an account that signed in some other way (device
      // pairing, managed claim, magic link). Binding to a scholar row needs an
      // explicit grant; here it is justified by the caller's own session, which
      // getAuthUserId verified above.
      await ctx.runMutation(internal.accountPassword.allowPasswordBind, {
        userId,
      });
      await createAccount(ctx, {
        provider: "password",
        account: { id: email, secret: newPassword },
        profile: { email },
      });
    }

    await ctx.runMutation(internal.accountPassword.clearMustReset, { userId });

    // Sign every OTHER device out — the useful half of the old signOut(). The
    // caller keeps working; a shared iPad someone left signed in does not.
    const sessionId = await getAuthSessionId(ctx);
    await invalidateSessions(ctx, {
      userId,
      ...(sessionId ? { except: [sessionId as Id<"authSessions">] } : {}),
    });

    return { ok: true };
  },
});
