import { v } from "convex/values";
import { staffQuery, staffMutation } from "./lib/customFunctions";
import { assertCuratableInstitution } from "./lib/access";

/**
 * Spaces — rooms of the school's physical environment (DESIGN layer,
 * INSTITUTION-scoped). A space groups the `equipment` the tutor can send
 * scholars to touch. Curated by school staff (teacher, operations staff,
 * curriculum_designer, school_admin, platform_admin — the `staff` gate). The
 * physical space belongs to the school, not one
 * teacher — so everything keys off `institutionId`.
 *
 * See review/physical-environment-teaching-tool-plan.html + convex/equipment.ts
 * (the leaf the tutor actually references).
 */

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
 * List an institution's rooms. Curators see all rooms (active + archived) so
 * they can un-archive; the tutor read is a separate inline query in
 * getSessionContext (suggestable equipment only).
 */
export const list = staffQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    await assertCuratableInstitution(ctx, ctx.user, args.institutionId);
    const spaces = await ctx.db
      .query("spaces")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .collect();
    return spaces
      .map((s) => ({ ...s, id: s._id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

export const create = staffMutation({
  args: {
    institutionId: v.id("institutions"),
    name: v.string(),
    kind: v.optional(spaceKind),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await assertCuratableInstitution(ctx, ctx.user, args.institutionId);
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) throw new Error("Institution not found");
    return await ctx.db.insert("spaces", {
      institutionId: args.institutionId,
      name: args.name.trim(),
      kind: args.kind,
      description: args.description?.trim() || undefined,
      isActive: true,
    });
  },
});

export const update = staffMutation({
  args: {
    id: v.id("spaces"),
    name: v.optional(v.string()),
    kind: v.optional(spaceKind),
    description: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("Space not found");
    await assertCuratableInstitution(ctx, ctx.user, existing.institutionId);
    const cleaned: Record<string, unknown> = {};
    if (updates.name !== undefined) cleaned.name = updates.name.trim();
    if (updates.kind !== undefined) cleaned.kind = updates.kind;
    if (updates.description !== undefined)
      cleaned.description = updates.description.trim() || undefined;
    if (updates.isActive !== undefined) cleaned.isActive = updates.isActive;
    await ctx.db.patch(id, cleaned);
  },
});

/**
 * Soft-delete a room. Its equipment keeps its own `spaceId` (the tutor read
 * skips archived rooms via the active filter), so re-activating restores the
 * grouping without re-linking gear.
 */
export const archive = staffMutation({
  args: { id: v.id("spaces") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Space not found");
    await assertCuratableInstitution(ctx, ctx.user, existing.institutionId);
    await ctx.db.patch(args.id, { isActive: false });
  },
});
