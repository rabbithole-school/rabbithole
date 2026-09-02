import { v } from "convex/values";
import { internalQuery, internalMutation } from "./_generated/server";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { isStaffRole } from "./lib/roles";
import { resolveActiveMembership } from "./lib/access";

/**
 * Physical-environment tools for the staff/curriculum bots (aide · Slack · MCP ·
 * unit designer). These are INTERNAL functions the tool layer
 * (convex/lib/physicalEnvTools.ts) calls with an explicit `callerUserId` — the
 * same pattern as convex/teacherAide.ts. The authed, UI-facing CRUD lives in
 * convex/spaces.ts + convex/equipment.ts; this file is the bot-facing seam:
 * name-based resolution (a teacher says "remove the metronome", not an id) and
 * institution resolved from the acting staffer.
 *
 * Governance: every function re-checks `isStaffRole` (defense in depth — the
 * bot surfaces are already staff-gated) and scopes to ONE institution.
 */

const supervision = v.union(
  v.literal("none"),
  v.literal("adult_present"),
  v.literal("teacher_only"),
);
const spaceKind = v.union(
  v.literal("classroom"),
  v.literal("lab"),
  v.literal("music"),
  v.literal("art"),
  v.literal("library"),
  v.literal("makerspace"),
  v.literal("outdoor"),
  v.literal("gym"),
  v.literal("other"),
);

/**
 * The institution the acting staffer curates: their active membership's
 * institution, else the primary school (single-school deployments have one
 * obvious home). Throws for a non-staff caller.
 */
async function resolveActorInstitution(
  ctx: QueryCtx,
  callerUserId: Id<"users">,
): Promise<{ institutionId: Id<"institutions">; institutionName: string }> {
  const user = await ctx.db.get(callerUserId);
  if (!user || !isStaffRole(user.role)) {
    throw new Error("Forbidden: school-inventory tools are staff-only");
  }
  const membership = await resolveActiveMembership(ctx, user);
  let institutionId = membership?.institutionId ?? null;
  if (!institutionId) {
    const all = await ctx.db.query("institutions").collect();
    institutionId = all.find((i) => i.isPrimary)?._id ?? all[0]?._id ?? null;
  }
  if (!institutionId) {
    throw new Error("No institution is set up to hold a physical inventory.");
  }
  const inst = await ctx.db.get(institutionId);
  return { institutionId, institutionName: inst?.name ?? "the school" };
}

async function gearList(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
): Promise<Doc<"equipment">[]> {
  return ctx.db
    .query("equipment")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
}

/** Strict-ish name resolver: exact (case-insensitive) wins; else a unique
 *  substring match; ambiguity/none reported so the bot can ask rather than act
 *  on the wrong item. */
function resolveOne(
  items: Doc<"equipment">[],
  name: string,
): { item?: Doc<"equipment">; ambiguous?: string[]; none?: boolean } {
  const norm = name.trim().toLowerCase();
  if (!norm) return { none: true };
  const exact = items.filter((e) => e.name.toLowerCase() === norm);
  if (exact.length === 1) return { item: exact[0] };
  if (exact.length > 1) return { ambiguous: exact.map((e) => e.name) };
  const partial = items.filter((e) => e.name.toLowerCase().includes(norm));
  if (partial.length === 1) return { item: partial[0] };
  if (partial.length > 1) return { ambiguous: partial.map((e) => e.name) };
  return { none: true };
}

/** Find-or-create a room by name within the institution. */
async function ensureRoom(
  ctx: MutationCtx,
  institutionId: Id<"institutions">,
  roomName: string,
): Promise<{ id: Id<"spaces">; created: boolean }> {
  const spaces = await ctx.db
    .query("spaces")
    .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
    .collect();
  const norm = roomName.trim().toLowerCase();
  const match = spaces.find((s) => s.name.toLowerCase() === norm);
  if (match) return { id: match._id, created: false };
  const id = await ctx.db.insert("spaces", {
    institutionId,
    name: roomName.trim(),
    isActive: true,
  });
  return { id, created: true };
}

// ── READ ──────────────────────────────────────────────────────────────

/**
 * The whole school inventory for the acting staffer's institution — rooms +
 * ACTIVE equipment, each with its tutor-suggestable gate + supervision + safety
 * so a curriculum bot can reference "what's available" (and see what the tutor
 * currently may/may not suggest) when designing.
 */
export const inventoryForActor = internalQuery({
  args: { callerUserId: v.id("users") },
  handler: async (ctx, { callerUserId }) => {
    const { institutionId, institutionName } = await resolveActorInstitution(
      ctx,
      callerUserId,
    );
    const spaces = (
      await ctx.db
        .query("spaces")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect()
    ).filter((s) => s.isActive);
    const equipment = (await gearList(ctx, institutionId)).filter(
      (e) => e.isActive,
    );
    const roomName = new Map(spaces.map((s) => [s._id, s.name]));
    return {
      institutionName,
      spaces: spaces.map((s) => ({
        name: s.name,
        kind: s.kind ?? null,
        description: s.description ?? null,
      })),
      equipment: equipment.map((e) => ({
        name: e.name,
        room: e.spaceId ? (roomName.get(e.spaceId) ?? null) : null,
        category: e.category ?? null,
        quantity: e.quantity ?? null,
        description: e.description ?? null,
        // Whether the AI tutor may currently suggest this to a scholar.
        tutorSuggestable: e.tutorSuggestable,
        supervision: e.supervision ?? "none",
        safetyNotes: e.safetyNotes ?? null,
        usageIdeas: e.usageIdeas ?? [],
      })),
    };
  },
});

// ── WRITE ─────────────────────────────────────────────────────────────

type WriteResult = { ok: boolean; message: string };

export const addEquipmentForActor = internalMutation({
  args: {
    callerUserId: v.id("users"),
    name: v.string(),
    roomName: v.optional(v.string()),
    category: v.optional(v.string()),
    quantity: v.optional(v.string()),
    description: v.optional(v.string()),
    tutorSuggestable: v.optional(v.boolean()),
    supervision: v.optional(supervision),
    safetyNotes: v.optional(v.string()),
    usageIdeas: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<WriteResult> => {
    const { institutionId, institutionName } = await resolveActorInstitution(
      ctx,
      args.callerUserId,
    );
    if (!args.name.trim()) return { ok: false, message: "Equipment needs a name." };
    let spaceId: Id<"spaces"> | undefined;
    let roomNote = "";
    if (args.roomName?.trim()) {
      const room = await ensureRoom(ctx, institutionId, args.roomName);
      spaceId = room.id;
      if (room.created) roomNote = ` (created room "${args.roomName.trim()}")`;
    }
    await ctx.db.insert("equipment", {
      institutionId,
      spaceId,
      name: args.name.trim(),
      category: args.category?.trim() || undefined,
      quantity: args.quantity?.trim() || undefined,
      description: args.description?.trim() || undefined,
      // Gate OFF by default — the tutor won't see it until a human opts it in
      // (the human-in-the-loop boundary), unless the caller explicitly opts in.
      tutorSuggestable: args.tutorSuggestable ?? false,
      supervision: args.supervision ?? "none",
      safetyNotes: args.safetyNotes?.trim() || undefined,
      usageIdeas: args.usageIdeas?.map((s) => s.trim()).filter(Boolean),
      isActive: true,
    });
    const gate = args.tutorSuggestable
      ? "the tutor may suggest it"
      : "OFF for the tutor until someone turns it on";
    return {
      ok: true,
      message: `Added "${args.name.trim()}" to ${institutionName}${roomNote} — ${gate}.`,
    };
  },
});

export const updateEquipmentForActor = internalMutation({
  args: {
    callerUserId: v.id("users"),
    name: v.string(),
    newName: v.optional(v.string()),
    roomName: v.optional(v.string()),
    category: v.optional(v.string()),
    quantity: v.optional(v.string()),
    description: v.optional(v.string()),
    tutorSuggestable: v.optional(v.boolean()),
    supervision: v.optional(supervision),
    safetyNotes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<WriteResult> => {
    const { institutionId } = await resolveActorInstitution(
      ctx,
      args.callerUserId,
    );
    const active = (await gearList(ctx, institutionId)).filter((e) => e.isActive);
    const r = resolveOne(active, args.name);
    if (r.ambiguous)
      return {
        ok: false,
        message: `"${args.name}" matches several items (${r.ambiguous.join(", ")}). Which one?`,
      };
    if (!r.item)
      return { ok: false, message: `No active equipment named "${args.name}".` };

    const patch: Record<string, unknown> = {};
    if (args.newName?.trim()) patch.name = args.newName.trim();
    if (args.roomName?.trim()) {
      patch.spaceId = (await ensureRoom(ctx, institutionId, args.roomName)).id;
    }
    if (args.category !== undefined)
      patch.category = args.category.trim() || undefined;
    if (args.quantity !== undefined)
      patch.quantity = args.quantity.trim() || undefined;
    if (args.description !== undefined)
      patch.description = args.description.trim() || undefined;
    if (args.tutorSuggestable !== undefined)
      patch.tutorSuggestable = args.tutorSuggestable;
    if (args.supervision !== undefined) patch.supervision = args.supervision;
    if (args.safetyNotes !== undefined)
      patch.safetyNotes = args.safetyNotes.trim() || undefined;
    await ctx.db.patch(r.item._id, patch);
    return { ok: true, message: `Updated "${r.item.name}".` };
  },
});

export const archiveEquipmentForActor = internalMutation({
  args: { callerUserId: v.id("users"), name: v.string() },
  handler: async (ctx, args): Promise<WriteResult> => {
    const { institutionId } = await resolveActorInstitution(
      ctx,
      args.callerUserId,
    );
    const active = (await gearList(ctx, institutionId)).filter((e) => e.isActive);
    const r = resolveOne(active, args.name);
    if (r.ambiguous)
      return {
        ok: false,
        message: `"${args.name}" matches several items (${r.ambiguous.join(", ")}). Which one should I remove?`,
      };
    if (!r.item)
      return { ok: false, message: `No active equipment named "${args.name}".` };
    await ctx.db.patch(r.item._id, { isActive: false });
    return { ok: true, message: `Removed "${r.item.name}" from the inventory.` };
  },
});

export const addRoomForActor = internalMutation({
  args: {
    callerUserId: v.id("users"),
    name: v.string(),
    kind: v.optional(spaceKind),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<WriteResult> => {
    const { institutionId, institutionName } = await resolveActorInstitution(
      ctx,
      args.callerUserId,
    );
    if (!args.name.trim()) return { ok: false, message: "A room needs a name." };
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect();
    const existing = spaces.find(
      (s) => s.name.toLowerCase() === args.name.trim().toLowerCase(),
    );
    if (existing) {
      if (!existing.isActive) await ctx.db.patch(existing._id, { isActive: true });
      return { ok: true, message: `"${existing.name}" already exists.` };
    }
    await ctx.db.insert("spaces", {
      institutionId,
      name: args.name.trim(),
      kind: args.kind,
      description: args.description?.trim() || undefined,
      isActive: true,
    });
    return { ok: true, message: `Added room "${args.name.trim()}" to ${institutionName}.` };
  },
});
