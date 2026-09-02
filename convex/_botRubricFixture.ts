import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

const TEST_UNIT_TITLE = "Bot Rubric Test";

export const setupEmptyUnit = internalMutation({
  args: { teacherUsername: v.string() },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) throw new Error("teacher not found");
    const allUnits = await ctx.db.query("units").collect();
    let unit = allUnits.find(
      (u) => u.teacherId === teacher._id && u.title === TEST_UNIT_TITLE,
    );
    if (!unit) {
      const id = await ctx.db.insert("units", {
        teacherId: teacher._id,
        title: TEST_UNIT_TITLE,
        emoji: "🧪",
        description: "Throwaway test unit.",
        isActive: true,
      });
      unit = (await ctx.db.get(id))!;
    }
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unit!._id))
      .collect();
    for (const l of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      for (const a of acts) await ctx.db.delete(a._id);
      await ctx.db.delete(l._id);
    }
    const msgs = await ctx.db
      .query("curriculumMessages")
      .filter((q) => q.eq(q.field("unitId"), unit!._id))
      .collect();
    for (const m of msgs) await ctx.db.delete(m._id);
    return { unitId: unit._id, lessonsDeleted: lessons.length };
  },
});

export const inspect = internalQuery({
  args: { teacherUsername: v.string() },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) return { found: false };
    const allUnits = await ctx.db.query("units").collect();
    const unit = allUnits.find(
      (u) => u.teacherId === teacher._id && u.title === TEST_UNIT_TITLE,
    );
    if (!unit) return { found: false };
    const lessons = await ctx.db
      .query("lessons")
      .withIndex("by_unit", (q) => q.eq("unitId", unit._id))
      .collect();
    const activities = [];
    for (const l of lessons) {
      const acts = await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
        .collect();
      for (const a of acts) {
        activities.push({
          lesson: l.title,
          activity: a.title,
          hasDeliverable: !!a.deliverable,
          deliverableKind: a.deliverable?.kind ?? null,
          criteriaPreview: a.deliverable
            ? a.deliverable.criteria
                .map((c) =>
                  c.description ? `${c.label}: ${c.description}` : c.label,
                )
                .join(" | ")
                .slice(0, 800)
            : null,
          systemPromptPreview: (a.systemPrompt ?? "").slice(0, 200),
        });
      }
    }
    const msgs = await ctx.db
      .query("curriculumMessages")
      .filter((q) => q.eq(q.field("unitId"), unit._id))
      .collect();
    return {
      unitId: unit._id,
      activities,
      messageCount: msgs.length,
      lastAssistantMessage: msgs
        .filter((m) => m.role === "assistant")
        .slice(-1)[0]?.content?.slice(0, 1500) ?? null,
    };
  },
});
