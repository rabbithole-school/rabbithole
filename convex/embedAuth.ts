/**
 * One-shot embed-session handoff tokens — the PRODUCTION auth bridge for the
 * native inline manipulative renderer (review/native-manipulative-plan).
 *
 * The native iPad app renders a practice manipulative inside a scoped
 * `react-native-webview` that loads the web `/embed/manipulative` route. That
 * WebView carries NO Convex Auth session (the native app's own session lives
 * in AsyncStorage, not a shared cookie), so the embedded page can't call the
 * `authedMutation` grader by itself. In the dev spike the page was reached via
 * a `/dev-login` redirect — dev-only by design.
 *
 * This is the prod path. The *already-authenticated* native app asks Convex
 * for a one-shot token bound to ITS OWN identity (`issueEmbedToken` — an
 * authedMutation that NEVER takes a target userId), hands it to the WebView in
 * the URL fragment, and the embed page redeems it via the `embedToken`
 * ConvexCredentials provider (convex/auth.ts), which consumes it atomically
 * (`consumeEmbedToken`) and mints a normal, revocable Convex Auth session.
 *
 * Security invariants (mirroring enrollment.ts / passkeys.ts):
 *   - Only a sha256 hash of the raw token is stored; the raw value is returned
 *     to the caller exactly once and never persisted.
 *   - Single-use: `consumeEmbedToken` stamps `usedAt` inside its transaction
 *     and rejects an already-used or expired token (a replay hits a burnt row).
 *   - Tight TTL (≤120s): the token only has to survive issue → WebView load.
 *   - Caller-scoped: the token is minted for `ctx.user._id`, so it can never
 *     be used to impersonate anyone else. This also means a teacher rehearsing
 *     an activity works — it's whoever called it, role-agnostic.
 *
 * Redeemed/stale rows are swept by an hourly cron (`sweepStaleEmbedTokens`),
 * following passkeys.sweepExpiredChallenges / enrollment.sweepStaleTokens.
 *
 * Crypto note: runs in Convex's DEFAULT runtime (Web Crypto via
 * lib/oauthCrypto) — no "use node" — matching the auth provider's `authorize`.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { authedMutation } from "./lib/customFunctions";
import { sha256Hex, randomToken } from "./lib/oauthCrypto";
import type { Id } from "./_generated/dataModel";

/** Embed tokens only bridge issue → load, so a tight TTL is both safe + ideal. */
export const EMBED_TOKEN_TTL_MS = 120 * 1000; // 120 seconds

/**
 * Issue a one-shot embed-session token for the CALLER. Deliberately takes NO
 * arguments — the token is always bound to `ctx.user._id`, so a scholar (or a
 * teacher rehearsing an activity) can only ever hand their OWN identity to the
 * embedded page. The raw token is returned exactly once; only its sha256 hash
 * is persisted.
 */
export const issueEmbedToken = authedMutation({
  args: {},
  handler: async (ctx): Promise<{ token: string }> => {
    const token = randomToken(32); // 32 random bytes -> 64 hex chars
    const now = Date.now();
    await ctx.db.insert("embedSessionTokens", {
      userId: ctx.user._id,
      tokenHash: await sha256Hex(token),
      createdAt: now,
      expiresAt: now + EMBED_TOKEN_TTL_MS,
    });
    return { token };
  },
});

/**
 * Atomically consume a raw embed token, returning its userId (or null). The
 * whole read → validate → stamp runs inside this mutation's transaction, which
 * is what makes it single-use + replay-safe: we look the row up by hash, reject
 * if it's missing / already used / expired, then mark `usedAt`. Called ONLY by
 * the `embedToken` provider's `authorize` in convex/auth.ts.
 */
export const consumeEmbedToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<{ userId: Id<"users"> } | null> => {
    const tokenHash = await sha256Hex(args.token);
    const row = await ctx.db
      .query("embedSessionTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!row) return null;
    if (row.usedAt !== undefined) return null; // single-use: already redeemed
    if (row.expiresAt < Date.now()) return null; // expired
    await ctx.db.patch(row._id, { usedAt: Date.now() });
    return { userId: row.userId };
  },
});

/**
 * Sweep used/expired embed tokens. The ≤120s TTL keeps live rows few, but a
 * redeemed token (`usedAt` set) and an issued-but-never-loaded token both
 * linger until swept. Bounded scan — the table is tiny (no `expiresAt` index
 * needed). Mirrors passkeys.sweepExpiredChallenges.
 */
export const sweepStaleEmbedTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("embedSessionTokens").take(2000);
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
