// Internal seed for the Class Digest feature (per-activity + per-cohort
// roll-up). Builds a realistic, varied cohort so the digest has genuine
// material to synthesize and the three-way progress read (done / in
// progress / not started) shows all three states.
//
// Creates (idempotent — re-running upserts, never duplicates):
//   Unit  "Weekend News (digest demo)" 📰  (teacher test-teacher-001)
//     Lesson "Sharing our weekends"
//       Activity 1 (online) "Write your Weekend News"  — the rich one
//       Activity 2 (online) "What makes a good story?"  — barely started
//   Assignment for that unit with 5 scholars (test-scholar-001..005)
//   Per scholar, mixed states on Activity 1:
//     001 Kai   — DONE, strong deliverable, rubric full
//     002 Lani  — DONE, thin deliverable, rubric half
//     003 Noah  — IN PROGRESS (project, no completion)
//     004       — IN PROGRESS, drifting off-task
//     005       — NOT STARTED (no project)
//
// Run: CONVEX_DEPLOYMENT=dev:<slug> npx convex run seedDigestDemo:seed '{}'

import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const SCHOLAR_USERNAMES = [
  "test-scholar-001",
  "test-scholar-002",
  "test-scholar-003",
  "test-scholar-004",
  "test-scholar-005",
] as const;

export const seed = internalMutation({
  args: {},
  handler: async (ctx) => {
    const teacher = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", "test-teacher-001"))
      .first();
    if (!teacher) throw new Error("Seed teacher test-teacher-001 not found");

    const scholars: { id: Id<"users">; name: string }[] = [];
    for (const u of SCHOLAR_USERNAMES) {
      const s = await ctx.db
        .query("users")
        .withIndex("by_username", (q) => q.eq("username", u))
        .first();
      if (s) scholars.push({ id: s._id, name: s.name ?? u });
    }
    if (scholars.length < 5) {
      throw new Error(
        `Need 5 seeded scholars; found ${scholars.length}. Run pnpm db:seed.`,
      );
    }

    // ── Unit / lesson / activities (find-or-create) ──
    const unitTitle = "Weekend News (digest demo)";
    const unit = (
      await ctx.db
        .query("units")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
        .collect()
    ).find((u) => u.title === unitTitle);
    let unitId: Id<"units">;
    if (unit) {
      unitId = unit._id;
    } else {
      unitId = await ctx.db.insert("units", {
        teacherId: teacher._id,
        title: unitTitle,
        emoji: "📰",
        description:
          "Scholars write a short news report about their weekend, then read each other's.",
        isActive: true,
      });
    }

    const lessonTitle = "Sharing our weekends";
    const lesson = (
      await ctx.db
        .query("lessons")
        .withIndex("by_unit", (q) => q.eq("unitId", unitId))
        .collect()
    ).find((l) => l.title === lessonTitle);
    let lessonId: Id<"lessons">;
    if (lesson) {
      lessonId = lesson._id;
    } else {
      lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: lessonTitle,
        order: 0,
      });
    }

    const findOrCreateActivity = async (
      title: string,
      order: number,
      withDeliverable: boolean,
      scholarDescription: string,
    ): Promise<Id<"activities">> => {
      const existing = (
        await ctx.db
          .query("activities")
          .withIndex("by_lesson", (q) => q.eq("lessonId", lessonId))
          .collect()
      ).find((a) => a.title === title);
      if (existing) {
        await ctx.db.patch(existing._id, { scholarDescription });
        return existing._id;
      }
      return ctx.db.insert("activities", {
        lessonId,
        title,
        kind: "online" as const,
        order,
        scholarDescription,
        systemPrompt:
          "Help the scholar write a short, vivid news report about their weekend. Ask for sensory detail.",
        ...(withDeliverable
          ? {
              deliverable: {
                kind: "text" as const,
                mode: "none" as const,
                prompt: "Write your weekend news report (3-5 sentences).",
                criteria: [],
              },
            }
          : {}),
      });
    };
    const activity1 = await findOrCreateActivity(
      "Write your Weekend News",
      0,
      true,
      "Write a short news report about your weekend, bringing one moment to life with details.",
    );
    const activity2 = await findOrCreateActivity(
      "What makes a good story?",
      1,
      false,
      "Talk about what makes a story memorable. Try out your ideas with the tutor.",
    );

    // ── Assignment (find-or-create, ensure full roster) ──
    const assignment = (
      await ctx.db
        .query("assignments")
        .withIndex("by_teacher", (q) => q.eq("teacherId", teacher._id))
        .collect()
    ).find((a) => a.unitId === unitId && !a.archivedAt);
    let assignmentId: Id<"assignments">;
    const rosterIds = scholars.map((s) => s.id);
    if (assignment) {
      assignmentId = assignment._id;
      await ctx.db.patch(assignmentId, { scholarIds: rosterIds });
    } else {
      assignmentId = await ctx.db.insert("assignments", {
        teacherId: teacher._id,
        unitId,
        scholarIds: rosterIds,
        startedAt: Date.now() - 2 * 86_400_000,
        // Activity 1 pushed as class focus that has since ended (the
        // natural "now review what happened" moment).
        activitySchedule: [
          {
            activityId: activity1,
            mode: "classFocus" as const,
            setAt: Date.now() - 2 * 86_400_000,
            startsAt: Date.now() - 2 * 86_400_000,
            endsAt: Date.now() - 1 * 86_400_000,
          },
        ],
      });
    }

    // ── Per-scholar projects / deliverables / completions ──
    const now = Date.now();
    const plan: Array<{
      idx: number;
      state: "done" | "inProgress" | "notStarted";
      summary?: string;
      preview?: string;
      pulse?: number;
      deliverable?: { text: string; overall: "not" | "half" | "full" };
    }> = [
      {
        idx: 0,
        state: "done",
        summary:
          "Wrote a vivid tide-pool report; strong sensory detail (clear water, scuttling crabs, anemones closing). Confident voice.",
        pulse: 4.6,
        deliverable: {
          text: "On Saturday I went to the tide pools at Makapuu. The water was so clear I could see tiny crabs scuttling sideways under the rocks. A hermit crab carried its whole house on its back. When a wave came in, all the anemones closed up like little fists.",
          overall: "full",
        },
      },
      {
        idx: 1,
        state: "done",
        summary:
          "Recounted a soccer game in clear sequence, but the writing is a list of events with little description.",
        pulse: 3.4,
        deliverable: {
          text: "I played soccer on Sunday. First we warmed up. Then we played the game. Then we won 3 to 1. Then we got shave ice.",
          overall: "half",
        },
      },
      {
        idx: 2,
        state: "inProgress",
        summary:
          "Started a report about a hike up Diamond Head; stuck on how to open it and asking the tutor for a first sentence.",
        preview: "How do I start it? I don't know what the first sentence should be...",
        pulse: 3.1,
      },
      {
        idx: 3,
        state: "inProgress",
        summary:
          "High energy but drifting off-task — keeps steering the conversation to a video game instead of the weekend report.",
        preview: "but anyway in the game I built a HUGE redstone machine that...",
        pulse: 2.3,
      },
      { idx: 4, state: "notStarted" },
    ];

    const upsertSession = async (
      scholarId: Id<"users">,
      title: string,
      summary?: string,
      preview?: string,
      pulse?: number,
    ): Promise<Id<"sessions">> => {
      const existing = (
        await ctx.db
          .query("sessions")
          .withIndex("by_assignment", (q) =>
            q.eq("assignmentId", assignmentId),
          )
          .collect()
      ).find((p) => p.userId === scholarId && p.activityId === activity1);
      if (existing) {
        await ctx.db.patch(existing._id, {
          analysisSummary: summary,
          lastMessagePreview: preview,
          pulseScore: pulse,
        });
        return existing._id;
      }
      return ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId: activity1,
        assignmentId,
        title,
        isArchived: false,
        lastMessageAt: now - 3_600_000,
        lastMessageRole: "user",
        lastMessagePreview: preview ?? "...",
        analysisSummary: summary,
        pulseScore: pulse,
      });
    };

    for (const p of plan) {
      const scholar = scholars[p.idx];
      if (p.state === "notStarted") continue;
      const sessionId = await upsertSession(
        scholar.id,
        `Weekend News — ${scholar.name}`,
        p.summary,
        p.preview,
        p.pulse,
      );

      if (p.deliverable) {
        const existingDeliv = (
          await ctx.db
            .query("deliverables")
            .withIndex("by_activity", (q) => q.eq("activityId", activity1))
            .collect()
        ).find(
          (d) => d.scholarId === scholar.id && d.assignmentId === assignmentId,
        );
        if (!existingDeliv) {
          await ctx.db.insert("deliverables", {
            activityId: activity1,
            scholarId: scholar.id,
            sessionId,
            assignmentId,
            textContent: p.deliverable.text,
            submittedAt: now - 3_600_000,
            overall: p.deliverable.overall,
            rubricCheckedBy: "ai",
            rubricCheckedAt: now - 3_500_000,
          });
        }
      }

      if (p.state === "done") {
        const existingC = await ctx.db
          .query("activityCompletions")
          .withIndex("by_scholar_activity", (q) =>
            q.eq("scholarId", scholar.id).eq("activityId", activity1),
          )
          .first();
        if (!existingC) {
          await ctx.db.insert("activityCompletions", {
            scholarId: scholar.id,
            activityId: activity1,
            lessonId,
            unitId,
            assignmentId,
            completedAt: now - 3_400_000,
            sessionId,
          });
        }
      }
    }

    return {
      unitId,
      assignmentId,
      activityIds: { activity1, activity2 },
      scholarCount: scholars.length,
    };
  },
});
