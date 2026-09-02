import { v } from "convex/values";
import { staffQuery, staffMutation } from "./lib/customFunctions";
import { assertCuratableInstitution } from "./lib/access";

/**
 * Equipment — the LEAF of the physical-environment inventory (DESIGN layer,
 * INSTITUTION-scoped). This is what the tutor references: the hand bells, the
 * singing bowl, the compass + straight-edge. It carries the concept tags
 * (bridge to the Knowledge-Tree lens), teacher-authored task seeds
 * (`usageIdeas`), and the human-in-the-loop gate (`tutorSuggestable` +
 * `supervision`).
 *
 * GOVERNANCE: the tutor NEVER sees an item unless a staffer flips
 * `tutorSuggestable` true — the redaction-boundary principle applied to the
 * physical world. Curated by school staff (teacher, operations staff,
 * curriculum_designer, school_admin, platform_admin — the `staff` gate). See
 * review/physical-environment-teaching-tool-plan.html.
 */

const supervision = v.union(
  v.literal("none"),
  v.literal("adult_present"),
  v.literal("teacher_only"),
);

/**
 * List an institution's equipment (curators see all — active + archived,
 * suggestable + not). The tutor's read is a separate inline query in
 * getSessionContext that fetches suggestable items only.
 */
export const listByInstitution = staffQuery({
  args: { institutionId: v.id("institutions") },
  handler: async (ctx, args) => {
    await assertCuratableInstitution(ctx, ctx.user, args.institutionId);
    const items = await ctx.db
      .query("equipment")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", args.institutionId),
      )
      .collect();
    const withUrls = await Promise.all(
      items.map(async (e) => ({
        ...e,
        id: e._id,
        photoUrl: e.photoStorageId
          ? await ctx.storage.getUrl(e.photoStorageId)
          : null,
      })),
    );
    return withUrls.sort((a, b) => a.name.localeCompare(b.name));
  },
});

/** Upload target for an equipment photo (mobile add-by-photo + edit dialog). */
export const generateUploadUrl = staffMutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Free a photo blob that was uploaded but never attached to an item (retake,
 * replace-before-save, canceled dialog) — else every retake orphans a blob
 * forever. Mirrors activityResources.discardUpload: a tight recency window
 * plus a check that nothing references the blob, so a stale or misdirected
 * call can never delete a photo in use.
 */
export const discardUpload = staffMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    if (!metadata) return;
    if (Date.now() - metadata._creationTime > 60 * 60 * 1000) {
      throw new Error("Upload cleanup window has expired");
    }
    const gear = await ctx.db
      .query("equipment")
      .withIndex("by_photo", (q) => q.eq("photoStorageId", args.storageId))
      .first();
    if (gear) return;
    const task = await ctx.db
      .query("physicalTasks")
      .withIndex("by_photo", (q) => q.eq("photoStorageId", args.storageId))
      .first();
    if (task) return;
    await ctx.storage.delete(args.storageId);
  },
});

export const create = staffMutation({
  args: {
    institutionId: v.id("institutions"),
    spaceId: v.optional(v.id("spaces")),
    name: v.string(),
    category: v.optional(v.string()),
    description: v.optional(v.string()),
    quantity: v.optional(v.string()),
    photoStorageId: v.optional(v.id("_storage")),
    tutorSuggestable: v.optional(v.boolean()),
    supervision: v.optional(supervision),
    safetyNotes: v.optional(v.string()),
    conceptIds: v.optional(v.array(v.id("concepts"))),
    usageIdeas: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await assertCuratableInstitution(ctx, ctx.user, args.institutionId);
    const institution = await ctx.db.get(args.institutionId);
    if (!institution) throw new Error("Institution not found");
    if (args.spaceId) {
      const space = await ctx.db.get(args.spaceId);
      if (!space || space.institutionId !== args.institutionId) {
        throw new Error("Space does not belong to this institution");
      }
    }
    return await ctx.db.insert("equipment", {
      institutionId: args.institutionId,
      spaceId: args.spaceId,
      name: args.name.trim(),
      category: args.category?.trim() || undefined,
      description: args.description?.trim() || undefined,
      quantity: args.quantity?.trim() || undefined,
      photoStorageId: args.photoStorageId,
      // Default OFF: a fresh item is invisible to the tutor until a staffer
      // opts it in (the human-in-the-loop gate).
      tutorSuggestable: args.tutorSuggestable ?? false,
      supervision: args.supervision,
      safetyNotes: args.safetyNotes?.trim() || undefined,
      conceptIds: args.conceptIds,
      usageIdeas: cleanIdeas(args.usageIdeas),
      isActive: true,
    });
  },
});

export const update = staffMutation({
  args: {
    id: v.id("equipment"),
    spaceId: v.optional(v.union(v.id("spaces"), v.null())),
    name: v.optional(v.string()),
    category: v.optional(v.string()),
    description: v.optional(v.string()),
    quantity: v.optional(v.string()),
    photoStorageId: v.optional(v.union(v.id("_storage"), v.null())),
    tutorSuggestable: v.optional(v.boolean()),
    supervision: v.optional(supervision),
    safetyNotes: v.optional(v.string()),
    conceptIds: v.optional(v.array(v.id("concepts"))),
    usageIdeas: v.optional(v.array(v.string())),
    isActive: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const existing = await ctx.db.get(id);
    if (!existing) throw new Error("Equipment not found");
    await assertCuratableInstitution(ctx, ctx.user, existing.institutionId);
    const cleaned: Record<string, unknown> = {};
    if (updates.spaceId !== undefined) {
      if (updates.spaceId === null) {
        cleaned.spaceId = undefined;
      } else {
        const space = await ctx.db.get(updates.spaceId);
        if (!space || space.institutionId !== existing.institutionId) {
          throw new Error("Space does not belong to this institution");
        }
        cleaned.spaceId = updates.spaceId;
      }
    }
    if (updates.name !== undefined) cleaned.name = updates.name.trim();
    if (updates.category !== undefined)
      cleaned.category = updates.category.trim() || undefined;
    if (updates.description !== undefined)
      cleaned.description = updates.description.trim() || undefined;
    if (updates.quantity !== undefined)
      cleaned.quantity = updates.quantity.trim() || undefined;
    if (updates.photoStorageId !== undefined) {
      const next =
        updates.photoStorageId === null ? undefined : updates.photoStorageId;
      // A replaced/removed photo is unreachable — free the old blob.
      if (existing.photoStorageId && existing.photoStorageId !== next) {
        await ctx.storage.delete(existing.photoStorageId);
      }
      cleaned.photoStorageId = next;
    }
    if (updates.tutorSuggestable !== undefined)
      cleaned.tutorSuggestable = updates.tutorSuggestable;
    if (updates.supervision !== undefined)
      cleaned.supervision = updates.supervision;
    if (updates.safetyNotes !== undefined)
      cleaned.safetyNotes = updates.safetyNotes.trim() || undefined;
    if (updates.conceptIds !== undefined) cleaned.conceptIds = updates.conceptIds;
    if (updates.usageIdeas !== undefined)
      cleaned.usageIdeas = cleanIdeas(updates.usageIdeas);
    if (updates.isActive !== undefined) cleaned.isActive = updates.isActive;
    await ctx.db.patch(id, cleaned);
  },
});

/**
 * Flip the human-in-the-loop gate. The pedagogically-important control: the
 * tutor sees this item only after a staffer opts it in.
 */
export const setTutorSuggestable = staffMutation({
  args: { id: v.id("equipment"), tutorSuggestable: v.boolean() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Equipment not found");
    await assertCuratableInstitution(ctx, ctx.user, existing.institutionId);
    await ctx.db.patch(args.id, { tutorSuggestable: args.tutorSuggestable });
  },
});

export const archive = staffMutation({
  args: { id: v.id("equipment") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Equipment not found");
    await assertCuratableInstitution(ctx, ctx.user, existing.institutionId);
    await ctx.db.patch(args.id, { isActive: false });
  },
});

/**
 * Hard-delete an item — the real "undo" that burst add-by-photo needs.
 * That flow creates rows OPTIMISTICALLY (one per snap, auto-saved with the
 * AI's guess), so junk snaps must vanish completely; archiving them instead
 * would pollute the archived list with noise the staffer never chose to keep.
 *
 * The one exception: a `physicalTask` may already reference this gear
 * (durable evidence for the portrait / ScholarFeed). Deleting would orphan
 * that history, so if ANY task points at this item we archive instead of
 * delete and report `archived: true`. Freshly snapped items never have tasks,
 * so they take the delete path and free their photo blob.
 */
export const remove = staffMutation({
  args: { id: v.id("equipment") },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.id);
    if (!existing) throw new Error("Equipment not found");
    await assertCuratableInstitution(ctx, ctx.user, existing.institutionId);

    const task = await ctx.db
      .query("physicalTasks")
      .withIndex("by_equipment", (q) => q.eq("equipmentId", args.id))
      .first();
    if (task) {
      await ctx.db.patch(args.id, { isActive: false });
      return { archived: true };
    }

    await ctx.db.delete(args.id);
    if (existing.photoStorageId) {
      await ctx.storage.delete(existing.photoStorageId);
    }
    return { archived: false };
  },
});

/** Trim + drop blank task-idea lines; undefined when nothing's left. */
function cleanIdeas(ideas: string[] | undefined): string[] | undefined {
  if (!ideas) return undefined;
  const cleaned = ideas.map((s) => s.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
}
