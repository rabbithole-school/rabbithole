import { v } from "convex/values";
import { authedQuery, curriculumMutation } from "./lib/customFunctions";
import { isCurriculumRole } from "./lib/roles";
import { requireAuthorOrPlatformAdmin } from "./lib/auth";
import { requireActiveLearnerInstitution } from "./lib/scholarEnrollment";

/**
 * Personas — DEPRECATED (anti-parasocial, 2026-06).
 *
 * Personas made the tutor "become" a character — the parasocial-riskiest
 * construct in the app. Rabbithole is a tool designed to be outgrown, so
 * personas are deprecated FOR NOW: the tutor no longer injects them, fresh
 * seeds no longer wire them to units, and they're hidden from active
 * teacher/scholar surfaces.
 *
 * This file (the `personas` table + its CRUD), `units.personaId`, and the
 * historical message snapshots are deliberately KEPT INTACT so existing data
 * and conversation history survive and re-enabling is reversible. Nothing in
 * the active UI calls create/update anymore.
 *
 * See TODO.html ("Reimagine personas") for the parasocially-safe redesign and
 * review/anti-parasocial-design.md for the broader initiative.
 */

/**
 * List all personas. Scholars see only active; teachers see all.
 */
export const list = authedQuery({
  args: { asLearner: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (args.asLearner) {
      await requireActiveLearnerInstitution(ctx, ctx.user._id);
    }
    const canManageCurriculum =
      !args.asLearner && isCurriculumRole(ctx.user.role);

    let personaList;
    if (canManageCurriculum) {
      personaList = await ctx.db.query("personas").order("desc").collect();
    } else {
      personaList = await ctx.db
        .query("personas")
        .withIndex("by_active", (q) => q.eq("isActive", true))
        .order("desc")
        .collect();
    }

    // Enrich with teacher name
    return Promise.all(
      personaList.map(async (p) => {
        const teacher = await ctx.db.get(p.teacherId);
        return {
          ...p,
          id: p._id,
          teacherName: teacher?.name ?? null,
          createdAt: p._creationTime,
        };
      })
    );
  },
});

/**
 * Get a single persona.
 */
export const get = authedQuery({
  args: { id: v.id("personas") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * Create a new persona (teachers only).
 */
export const create = curriculumMutation({
  args: {
    title: v.string(),
    emoji: v.string(),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("personas", {
      teacherId: ctx.user._id,
      title: args.title.trim(),
      emoji: args.emoji.trim(),
      description: args.description?.trim() || undefined,
      systemPrompt: args.systemPrompt?.trim() || undefined,
      isActive: true,
    });
  },
});

/**
 * Update a persona (teachers only).
 */
export const update = curriculumMutation({
  args: {
    id: v.id("personas"),
    title: v.optional(v.string()),
    emoji: v.optional(v.string()),
    description: v.optional(v.string()),
    systemPrompt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { id, ...updates } = args;
    const persona = await ctx.db.get(id);
    if (!persona) throw new Error("Persona not found");
    requireAuthorOrPlatformAdmin(ctx.user, persona);
    const cleaned: Record<string, string | undefined> = {};
    if (updates.title !== undefined) cleaned.title = updates.title.trim();
    if (updates.emoji !== undefined) cleaned.emoji = updates.emoji.trim();
    if (updates.description !== undefined)
      cleaned.description = updates.description.trim() || undefined;
    if (updates.systemPrompt !== undefined)
      cleaned.systemPrompt = updates.systemPrompt.trim() || undefined;

    await ctx.db.patch(id, cleaned);
  },
});

/**
 * Deactivate (soft-delete) a persona.
 */
export const deactivate = curriculumMutation({
  args: { id: v.id("personas") },
  handler: async (ctx, args) => {
    const persona = await ctx.db.get(args.id);
    if (!persona) throw new Error("Persona not found");
    requireAuthorOrPlatformAdmin(ctx.user, persona);
    await ctx.db.patch(args.id, { isActive: false });
  },
});
