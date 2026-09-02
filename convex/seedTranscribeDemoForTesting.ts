import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Stage the exact moment the transcribe change exists to fix, for a live
 * demo on the iPad: the scholar has already given their idea IN CHAT, the
 * tutor has asked them to write it in their document, and the document does
 * not contain it. The next scholar turn ("i alredy did it") is driven live.
 *
 * Dev-only fixture. The scholar wording here is invented — never a real
 * child's words.
 */
export const seed = internalMutation({
  args: {
    teacherUsername: v.string(),
    scholarUsername: v.string(),
    // Also stage the moment AFTER the scholar accepts the offer: the tutor's
    // reply, the transcription receipt row, and her words in the document.
    // Lets the receipt's rendering be checked without re-rolling the model.
    includeTranscription: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.teacherUsername))
      .first();
    if (!teacher) throw new Error(`teacher '${args.teacherUsername}' not found`);
    const scholar = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.scholarUsername))
      .first();
    if (!scholar) throw new Error(`scholar '${args.scholarUsername}' not found`);

    const unitTitle = "Pond Jar Study (demo)";
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
        emoji: "🔬",
        isActive: true,
      });
      unit = (await ctx.db.get(id))!;
    }

    const lessonTitle = "What is changing in the jar?";
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

    const deliverable = {
      kind: "text" as const,
      prompt:
        "Write your prediction about why the pond water is changing colour. Say what you think is happening AND why you think it.",
      mode: "manual" as const,
      criteria: [
        {
          id: "prediction",
          label: "States a prediction",
          description: "Says what they think is causing the change.",
        },
        {
          id: "reason",
          label: "Gives a reason",
          description: "Explains why they think that, using something they observed.",
        },
        {
          id: "evidence",
          label: "Uses the log",
          description: "Refers to what they actually saw over the days.",
        },
      ],
    };

    const activityTitle = "Write your prediction";
    let activity = (
      await ctx.db
        .query("activities")
        .withIndex("by_lesson", (q) => q.eq("lessonId", lesson!._id))
        .collect()
    ).find((a) => a.title === activityTitle);
    if (!activity) {
      const id = await ctx.db.insert("activities", {
        lessonId: lesson._id,
        title: activityTitle,
        kind: "online" as const,
        systemPrompt:
          "You're helping the scholar get their prediction about the pond jar into their document. Their thinking is ahead of their typing.",
        order: 0,
        scholarDescription:
          "Write your prediction about why the pond water is going dark, and say why you think it.",
        deliverable,
      });
      activity = (await ctx.db.get(id))!;
    }

    // A fresh session each run, so the demo always starts from the same beat.
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholar._id,
      unitId: unit._id,
      lessonId: lesson._id,
      activityId: activity._id,
      title: "Pond jar prediction",
      isArchived: false,
    });

    // The document holds her observations but NOT the prediction — the gap the
    // rubric grades and the tutor keeps asking her to close.
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "My Pond Log",
      content:
        "Day 1 the water was clear\nDay 3 it went a litle green\nDay 5 it is dark greeny brown",
      lastEditedBy: "scholar",
      revision: 3,
      type: "text",
    });

    const turns: Array<{ role: "user" | "assistant"; content: string }> = [
      { role: "user", content: "<start>" },
      {
        role: "assistant",
        content:
          "You've got five days of colours in your log — clear, then a little green, then dark greeny brown. What do you think is making it change?",
      },
      {
        role: "user",
        content: "i thnk the algee is what maks it go dark becuse it grew alot",
      },
      {
        role: "assistant",
        content:
          "That's a real prediction, and you gave a reason for it. Now put that in your document so it counts.",
      },
    ];
    for (const t of turns) {
      await ctx.db.insert("messages", {
        sessionId,
        role: t.role,
        content: t.content,
        flagged: false,
      });
    }

    if (args.includeTranscription) {
      const spoken = "i thnk the algee is what maks it go dark becuse it grew alot";
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content:
          "You already said it — want me to put your exact words in the box on the side?",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "yes",
        flagged: false,
      });
      // Same shape recordToolAction writes for a real transcribe.
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "",
        toolAction: "Wrote down your words",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content:
          "I put your words in — read it and tell me if I got it right.",
        flagged: false,
      });
      await ctx.db.patch(artifactId, {
        content: spoken,
        revision: 1,
        lastEditedBy: "ai",
        hasTutorTranscription: true,
        tutorTranscribedExcerpts: [spoken],
      });
    }

    return { sessionId, artifactId, activityId: activity._id, unitId: unit._id };
  },
});
