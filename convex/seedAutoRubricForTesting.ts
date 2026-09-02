// Seed an auto-mode rubric activity for end-to-end testing. Pairs
// with seedRubricActivityForTesting (manual mode) so we can compare
// the two modes side by side in dev.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const seed = internalMutation({
  args: { teacherUsername: v.string() },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) throw new Error("teacher not found");

    const unitTitle = "Weekend News (auto-rubric test)";
    let unit = (
      await ctx.db
        .query("units")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
        .collect()
    ).find((u) => u.title === unitTitle);
    if (!unit) {
      const id = await ctx.db.insert("units", {
        teacherId: teacher._id,
        title: unitTitle,
        emoji: "🤖",
        isActive: true,
      });
      unit = (await ctx.db.get(id))!;
    }

    const lessonTitle = "Auto-rubric weekend story";
    let lesson = (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unit!._id))
        .collect()
    ).find((l) => l.title === lessonTitle);
    if (!lesson) {
      const id = await ctx.db.insert("lessons", {
        unitId: unit._id,
        title: lessonTitle,
        order: 0,
      });
      lesson = (await ctx.db.get(id))!;
    }

    const activityTitle = "Write your weekend story (auto)";
    let activity = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson!._id))
        .collect()
    ).find((a) => a.title === activityTitle);
    const deliverable = {
      kind: "text" as const,
      mode: "auto" as const,
      prompt:
        "Write a short story about something that happened to you over the weekend. Tell us who was there, what happened, and why it mattered to you.",
      notes:
        "Look for a clear narrative arc (opening, middle, ending), specific details — at least one named person or moment — not just 'I had fun'. Length and mechanics calibrated to the scholar's reading level. Vague summary-style writing should be a 'half' or 'not'.",
      criteria: [], // generator fills per-scholar
    };
    const scholarDescription =
      "Write a short story about a weekend moment that mattered to you. Make it vivid with details from the day.";
    if (!activity) {
      const id = await ctx.db.insert("activities", {
        lessonId: lesson._id,
        title: activityTitle,
        kind: "online" as const,
        systemPrompt:
          "Help the scholar draft a short weekend story. Be warm but specific. When their draft looks like it meets the rubric, encourage them to submit.",
        order: 0,
        scholarDescription,
        deliverable,
      });
      activity = (await ctx.db.get(id))!;
    } else {
      await ctx.db.patch(activity._id, { deliverable, scholarDescription });
    }

    return {
      unitId: unit._id,
      lessonId: lesson._id,
      activityId: activity._id,
    };
  },
});
