// /family-chat — staff text the parent aide AS one of their school's parents,
// to see the replies a family would get before parent SMS reaches them.
//
// The reply comes from the real SMS pipeline (lib/parentAideTurn
// `simulateParentSmsTurn`: the same prompt, guardianship scope, tools, and
// model as `parentSms.processSmsTurns`). What makes it a simulation:
//   - the thread lives in the staff member's browser and is sent with each
//     turn; nothing is written to the parent's `parentChatMessages` thread,
//     and no inbound/consent row is read or written;
//   - nothing is texted: the reply comes back to the page, run through the
//     same SMS body transform a phone would get;
//   - the BunnyPad freeze/find tools say what they would do and change
//     nothing (the freeze STATUS read is real).
//
// Refusals are ConvexErrors so the page can show them (production redacts a
// plain Error's message).
//
// Who may simulate whom: the aide's read tools show a child's learning
// record, so a caller may simulate a guardian ONLY when they may already read
// the work of EVERY one of that guardian's children (`canUserReadScholarWork`
// in lib/access): a teacher or school admin with live standing at each
// child's school, or a platform admin. Curriculum designers and base staff
// (with or without operations grants) have no route to a child's work, so
// they can't reach it through a parent preview either.

import { ConvexError, v } from "convex/values";
import { internalQuery } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { authedAction, staffQuery } from "./lib/customFunctions";
import { requireUser } from "./lib/auth";
import { ROLES, isPlatformAdminRole, isStaffRole } from "./lib/roles";
import { hasActiveStaffMembershipAtInstitution } from "./lib/staffCapabilities";
import { allScholarIds, scholarIdsForInstitution } from "./lib/scholarEnrollment";
import { canUserReadScholarWork } from "./lib/access";
import { requireAnthropicApiKey } from "./lib/anthropic";
import {
  PARENT_AIDE_MAX_TOKENS,
  simulateParentSmsTurn,
  type SimulatedParentMessage,
} from "./lib/parentAideTurn";

/** Turns kept per simulated thread; a cost cap, not a calibrated limit. */
export const SIMULATED_THREAD_MAX_MESSAGES = 40;
/** Longest message staff may "text" as the parent (~10 SMS segments). */
export const SIMULATED_MESSAGE_MAX_CHARS = 1600;
/**
 * Longest aide reply the page may send back as history: the aide's own
 * output cap at a generous ~6 chars per token. Bounds the payload without
 * locking a thread after a long reply, which the SMS cap above did.
 */
export const SIMULATED_REPLY_MAX_CHARS = PARENT_AIDE_MAX_TOKENS * 6;

const FORBIDDEN =
  "Forbidden: you can only preview parents whose children's work you can see";

/**
 * The guardian's children when `staff` may simulate them, else null: `staff`
 * must be able to read every child's work, so a guardian with one child out
 * of reach (another school, or a role with no teaching access) is refused.
 * `readable` memoizes the per-scholar check across guardians (siblings).
 */
async function simulableChildren(
  ctx: QueryCtx,
  staff: Doc<"users">,
  parentUserId: Id<"users">,
  readable: Map<Id<"users">, boolean>,
): Promise<Array<{ id: Id<"users">; name: string }> | null> {
  if (!isStaffRole(staff.role)) return null;
  const links = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", parentUserId))
    .collect();
  const children: Array<{ id: Id<"users">; name: string }> = [];
  for (const link of links) {
    const child = await ctx.db.get(link.scholarUserId);
    // The same children the aide scopes to (parentChat.getContext).
    if (!child || child.role !== ROLES.SCHOLAR) continue;
    if (!readable.has(child._id)) {
      readable.set(child._id, await canUserReadScholarWork(ctx, staff, child._id));
    }
    if (!readable.get(child._id)) return null;
    children.push({ id: child._id, name: child.name ?? "Scholar" });
  }
  return children.length > 0 ? children : null;
}

/**
 * Where to look for guardians: the scholars at each live school where the
 * caller teaches or administers (the only standing `canUserReadScholarWork`
 * admits short of platform admin), or every scholar for a platform admin.
 * Reads scale with the caller's own schools, not the guardianships table.
 */
async function candidateScholarIds(
  ctx: QueryCtx,
  staff: Doc<"users">,
): Promise<Set<Id<"users">>> {
  if (isPlatformAdminRole(staff.role)) return await allScholarIds(ctx);
  const memberships = await ctx.db
    .query("memberships")
    .withIndex("by_user", (q) => q.eq("userId", staff._id))
    .collect();
  const ids = new Set<Id<"users">>();
  const seen = new Set<Id<"institutions">>();
  for (const m of memberships) {
    if (m.role !== ROLES.TEACHER && m.role !== ROLES.SCHOOL_ADMIN) continue;
    if (!m.institutionId || seen.has(m.institutionId)) continue;
    seen.add(m.institutionId);
    if (!(await hasActiveStaffMembershipAtInstitution(ctx, staff._id, m.institutionId))) {
      continue;
    }
    for (const id of await scholarIdsForInstitution(ctx, m.institutionId)) ids.add(id);
  }
  return ids;
}

/** The guardians this staff member may simulate, by name, with children. */
export const listParents = staffQuery({
  args: {},
  handler: async (ctx) => {
    const parentIds = new Set<Id<"users">>();
    for (const scholarId of await candidateScholarIds(ctx, ctx.user)) {
      const links = await ctx.db
        .query("guardianships")
        .withIndex("by_scholar", (q) => q.eq("scholarUserId", scholarId))
        .collect();
      for (const link of links) parentIds.add(link.parentUserId);
    }
    const readable = new Map<Id<"users">, boolean>();
    const rows = [];
    for (const parentUserId of parentIds) {
      const parent = await ctx.db.get(parentUserId);
      if (!parent) continue;
      const children = await simulableChildren(ctx, ctx.user, parentUserId, readable);
      if (!children) continue;
      rows.push({
        _id: parent._id,
        name: parent.name ?? "Parent",
        children: children.map((c) => c.name),
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * The gate the simulation action runs under the caller's own identity:
 * throws unless the signed-in user may simulate this guardian. Returns the
 * caller's role for the usage row.
 */
export const authorizeSimulation = internalQuery({
  args: { parentUserId: v.id("users") },
  handler: async (ctx, args) => {
    const staff = await requireUser(ctx);
    const children = await simulableChildren(
      ctx,
      staff,
      args.parentUserId,
      new Map(),
    );
    if (!children) throw new ConvexError(FORBIDDEN);
    return { callerRole: staff.role ?? "staff" };
  },
});

const simulatedMessage = v.object({
  role: v.union(v.literal("user"), v.literal("assistant")),
  content: v.string(),
});

/**
 * The reply `parentUserId` would get by text, given the simulated thread so
 * far (oldest first, ending with the message being "sent"). Writes nothing
 * the parent can see and sends nothing; see the header.
 */
export const reply = authedAction({
  args: {
    parentUserId: v.id("users"),
    messages: v.array(simulatedMessage),
  },
  handler: async (ctx, args): Promise<{ content: string; sms: string }> => {
    // authedAction has already refused a signed-out or read-only caller.
    const { callerRole } = await ctx.runQuery(
      internal.familyChat.authorizeSimulation,
      { parentUserId: args.parentUserId },
    );
    const history: SimulatedParentMessage[] = args.messages.map((m) => ({
      role: m.role,
      content: m.content.trim(),
    }));
    const last = history.at(-1);
    if (!last || last.role !== "user" || !last.content) {
      throw new ConvexError("Type a message to send.");
    }
    if (history.length > SIMULATED_THREAD_MAX_MESSAGES) {
      throw new ConvexError("This preview thread is full. Start over to keep going.");
    }
    if (
      history.some((m) =>
        m.role === "user"
          ? m.content.length > SIMULATED_MESSAGE_MAX_CHARS
          : m.content.length > SIMULATED_REPLY_MAX_CHARS,
      )
    ) {
      throw new ConvexError("That message is too long for a text.");
    }
    const { Anthropic } = await import("@anthropic-ai/sdk");
    const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
    return await simulateParentSmsTurn(ctx, {
      anthropic,
      parentUserId: args.parentUserId,
      history,
      callerRole,
    });
  },
});
