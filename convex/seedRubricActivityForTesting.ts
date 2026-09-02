import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Seed a curriculum unit → lesson → document-flair activity for the
 * Phase E Playwright test. Idempotent by title. Returns the
 * activityId so the test can navigate straight to it.
 */
export const seed = internalMutation({
  args: { teacherUsername: v.string() },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) throw new Error("teacher not found");

    const unitTitle = "Weekend News (test)";
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
        emoji: "📰",
        isActive: true,
      });
      unit = (await ctx.db.get(id))!;
    }

    const lessonTitle = "Draft your story";
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

    const activityTitle = "Write the weekend story";
    let activity = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson!._id))
        .collect()
    ).find((a) => a.title === activityTitle);
    const deliverable = {
      kind: "text" as const,
      prompt:
        "Write a short story about something that happened to you over the weekend. Tell us who was there, what happened, and why it mattered to you.",
      mode: "manual" as const,
      criteria: [
        {
          id: "structure",
          label: "Beginning, middle, end",
          description: "The story has a clear opening, middle, and ending.",
        },
        {
          id: "length",
          label: "Length",
          description: "At least 4 sentences.",
        },
        {
          id: "specificity",
          label: "Specificity",
          description:
            "Mentions at least one specific person or event by name — not just 'I had fun'.",
        },
        {
          id: "mechanics",
          label: "Spelling & capitalization",
          description:
            "Correct for an 8-year-old: capitalize proper nouns and the start of sentences; common sight words (the, and, was, my, went) spelled correctly.",
        },
      ],
    };
    const scholarDescription =
      "Write a short story about a weekend moment that mattered to you. Give it a beginning, middle, and ending.";
    if (!activity) {
      const id = await ctx.db.insert("activities", {
        lessonId: lesson._id,
        title: activityTitle,
        kind: "online" as const,
        systemPrompt:
          "You're helping the scholar draft a short story about their weekend. Be warm but specific. When their draft looks like it meets the rubric, encourage them to click 'Check my work' in the right panel.",
        order: 0,
        scholarDescription,
        deliverable,
      });
      activity = (await ctx.db.get(id))!;
    } else {
      await ctx.db.patch(activity._id, {
        ...(activity.deliverable ? {} : { deliverable }),
        scholarDescription,
      });
    }

    return {
      unitId: unit._id,
      lessonId: lesson._id,
      activityId: activity._id,
    };
  },
});

export const wipe = internalMutation({
  args: { teacherUsername: v.string() },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) return;
    const units = await ctx.db
      .query("units")
      .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
      .collect();
    for (const u of units) {
      if (u.title !== "Weekend News (test)") continue;
      const lessons = await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", u._id))
        .collect();
      for (const l of lessons) {
        const acts = await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", l._id))
          .collect();
        for (const a of acts) {
          // also wipe any deliverables on this activity
          const dels = await ctx.db
            .query("deliverables")
            .withIndex("by_activity", (q) => q.eq("activityId", a._id))
            .collect();
          for (const d of dels) await ctx.db.delete(d._id);
          // wipe activityCompletions
          const comps = await ctx.db
            .query("activityCompletions")
            .withIndex("by_scholar_activity", (q) =>
              q.eq("scholarId", "" as never).eq("activityId", a._id),
            )
            .collect();
          for (const c of comps) await ctx.db.delete(c._id);
          await ctx.db.delete(a._id);
        }
        await ctx.db.delete(l._id);
      }
      await ctx.db.delete(u._id);
    }
  },
});
