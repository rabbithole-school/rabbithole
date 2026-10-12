// Auth-session teardown shared by every path that signs ONE session out:
// device sign-out (convex/devicePairing.ts), managed-device claims, MCP
// connection revoke (convex/mcpOauth.ts), and MCP service tokens
// (convex/mcpServiceAccounts.ts). Mirrors @convex-dev/auth's own deleteSession
// (session row + its refresh tokens); Convex Auth validates JWT signatures
// only, so deleting the row is what actually ends a session — callers that
// need revocation to bite before the JWT expires must ALSO check the row
// exists per request (see convex/mcp.ts whoami).

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

/** Delete an auth session + its refresh tokens. Returns false when already gone. */
export async function revokeAuthSession(
  ctx: MutationCtx,
  sessionId: Id<"authSessions">,
): Promise<boolean> {
  const session = await ctx.db.get(sessionId);
  if (!session) return false;
  const refreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const rt of refreshTokens) await ctx.db.delete(rt._id);
  await ctx.db.delete(sessionId);
  return true;
}
