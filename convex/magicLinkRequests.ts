import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { admitMagicLinkRequest } from "./lib/authGuards";

/**
 * The `signIn` wrapper's gate for a magic-link request (convex/auth.ts).
 * False means the wrapper answers `{ started: true }` and sends nothing.
 * See `admitMagicLinkRequest`.
 */
export const admit = internalMutation({
  args: { email: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { email }) => await admitMagicLinkRequest(ctx, email),
});
