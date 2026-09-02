/**
 * Backing mutations for the Slack bot's operations-staff-flavored tools
 * (lib/slackTools.ts): parent enroll links + scholar password resets.
 *
 * These take an explicit `callerUserId` (the bot acts for a mapped Slack
 * user, not a Convex Auth identity) and RE-VERIFY the caller's role here
 * — defense in depth, because these two ops mint credentials. Both mint a
 * one-time enroll link via the shared `enrollment.createTokenForUser`, so
 * the credential path never forks.
 *
 * Returns are { ok, message } shaped (never throws for expected
 * failures) so the tool can hand the model a readable refusal.
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { ROLES, isScholarAdminRole } from "./lib/roles";
import { createTokenForUser, enrollPath, mintScholarPinToken } from "./enrollment";
import { requireScholarsAccessible } from "./lib/access";
import { siteUrl } from "./lib/channels";
import { schoolOperationsInstitutionIds } from "./lib/staffCapabilities";

async function schoolOperationsInstitutions(
  ctx: Parameters<typeof schoolOperationsInstitutionIds>[0],
  caller: Doc<"users">,
) {
  if (caller.role !== ROLES.STAFF) return null;
  const institutionIds = await schoolOperationsInstitutionIds(ctx, caller);
  // Base staff may never receive a global operations scope.
  return institutionIds === "all"
    ? new Set<Doc<"institutions">["_id"]>()
    : institutionIds;
}

export const issueParentEnrollLink = internalMutation({
  args: {
    callerUserId: v.id("users"),
    parentName: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; parentName: string; url: string }
    | { ok: false; message: string }
  > => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || (!isScholarAdminRole(caller.role) && caller.role !== ROLES.STAFF)) {
      return { ok: false, message: "Forbidden: scholar-admin role required" };
    }
    const operations = await schoolOperationsInstitutions(ctx, caller);
    if (operations && operations.size === 0) {
      return { ok: false, message: "Forbidden: school-operations grant required" };
    }

    const query = args.parentName.trim().toLowerCase();
    if (!query) return { ok: false, message: "Give me a parent name or email to look up." };

    const parents = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.PARENT))
      .collect();
    const matches = [];
    for (const parent of parents) {
      if (
        !(parent.name ?? "").toLowerCase().includes(query) &&
        !(parent.email ?? "").toLowerCase().includes(query)
      ) {
        continue;
      }
      if (operations) {
        const links = await ctx.db
          .query("guardianships")
          .withIndex("by_parent", (q) => q.eq("parentUserId", parent._id))
          .collect();
        const hasGrantedScholar = (
          await Promise.all(links.map((link) => ctx.db.get(link.scholarUserId)))
        ).some((scholar) => !!scholar?.institutionId && operations.has(scholar.institutionId));
        if (!hasGrantedScholar) continue;
      }
      matches.push(parent);
    }
    if (matches.length === 0) {
      return { ok: false, message: `No parent account found matching "${args.parentName}".` };
    }
    if (matches.length > 1) {
      const names = matches.map((p) => p.name ?? p.email ?? "(unnamed)").join(", ");
      return {
        ok: false,
        message: `Multiple parents match "${args.parentName}": ${names}. Be more specific.`,
      };
    }

    const parent = matches[0];
    const token = await createTokenForUser(ctx, parent._id, caller._id);
    const baseUrl = siteUrl();
    return {
      ok: true,
      parentName: parent.name ?? parent.email ?? "Parent",
      url: `${baseUrl}/enroll?token=${encodeURIComponent(token)}`,
    };
  },
});

/**
 * Mint a one-time PIN enroll link for a scholar (the Slack-bot backing for the
 * "kid forgot their PIN" moment). Replaces the old temp-PIN reset: that returned
 * a 4-digit PIN that was never stored server-side and so never worked in
 * production. The scholar opens the link, sets a PIN that IS stored, then signs
 * in. Redeeming the link clears their old sessions; issuing it does not (their
 * old PIN, if any, keeps working until they set a new one — no lockout window).
 */
export const issueScholarPinLink = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { ok: true; url: string; username: string }
    | { ok: false; message: string }
  > => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || (!isScholarAdminRole(caller.role) && caller.role !== ROLES.STAFF)) {
      return { ok: false, message: "Forbidden: scholar-admin role required" };
    }
    // Institution scope (defense in depth): a role check alone is a cross-tenant
    // account-takeover — a scholar-admin in school A could mint a PIN link for a
    // scholar in school B, set a PIN, and sign in as that child. Scope the mint
    // to the caller's own institution (platform admins stay global), matching
    // the in-app `enrollment.issueScholarEnrollLink`. Kept inside the try so the
    // Forbidden throw becomes the tool's readable { ok, message } refusal.
    try {
      const operations = await schoolOperationsInstitutions(ctx, caller);
      if (operations) {
        const scholar = await ctx.db.get(args.scholarId);
        if (!scholar?.institutionId || !operations.has(scholar.institutionId)) {
          throw new Error("Forbidden");
        }
      } else {
        await requireScholarsAccessible(ctx, caller, [args.scholarId]);
      }
      const { token, username } = await mintScholarPinToken(
        ctx,
        args.scholarId,
        caller._id,
      );
      return { ok: true, url: `${siteUrl()}${enrollPath(token)}`, username };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },
});
