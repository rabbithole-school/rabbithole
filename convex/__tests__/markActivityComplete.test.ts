import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { buildTutorSystemPrompt } from "../sessionStreamHelpers";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

// ── Fixtures (copied from focusLockCompletion.test.ts / advanceRubric.test.ts) ──

async function seedUser(
  t: TC,
  role: "scholar" | "teacher" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const institutionId = await seedTestInstitution(t);
  const options = {
    institutionId,
    name: overrides.name ?? `Test ${role}`,
    username:
      overrides.username ?? `${role}-${Math.random().toString(36).slice(2, 8)}`,
  };
  return role === "teacher"
    ? seedStaffWithMembership(t, options)
    : seedScholarInInstitution(t, options);
}

async function withUser(t: TC, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

type ActivityShape = {
  /** attach a deliverable spec (photo, mode "artifact") */
  deliverable?: boolean;
  /** attach an advanceRubric */
  advanceRubric?: boolean;
  /** activity.kind override (default "online") */
  kind?: Doc<"activities">["kind"];
  /** drop the lesson anchor (scholar-scoped task) */
  noLesson?: boolean;
  withBadge?: boolean;
};

type SessionShape = {
  isTestDrive?: boolean;
  withAssignment?: boolean;
};

async function seedActivity(
  t: TC,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
  shape: ActivityShape & SessionShape = {},
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Unit",
      isActive: true,
      ...(shape.withBadge
        ? { badgeOnCompletion: { title: "Badge", icon: "⭐" } }
        : {}),
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      ...(shape.noLesson ? {} : { lessonId }),
      title: "Chat activity",
      kind: shape.kind ?? "online",
      order: 0,
      systemPrompt: "Explore the topic with the scholar.",
      ...(shape.deliverable
        ? {
            deliverable: {
              kind: "photo" as const,
              mode: "manual" as const,
              prompt: "Make a thing.",
              criteria: [{ id: "a", label: "A" }],
            },
          }
        : {}),
      ...(shape.advanceRubric
        ? { advanceRubric: { criteria: [{ id: "a", label: "A" }] } }
        : {}),
    });
    let assignmentId: Id<"assignments"> | undefined;
    if (shape.withAssignment) {
      assignmentId = await ctx.db.insert("assignments", {
        unitId,
        teacherId,
        scholarIds: [scholarId],
        startedAt: Date.now(),
      });
    }
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      lessonId,
      activityId,
      title: "Session",
      isArchived: false,
      ...(shape.isTestDrive ? { isTestDrive: true } : {}),
      ...(assignmentId ? { assignmentId } : {}),
    });
    return { unitId, lessonId, activityId, sessionId, assignmentId };
  });
}

async function addUserMessages(t: TC, sessionId: Id<"sessions">, n: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: `scholar turn ${i}`,
        flagged: false,
      });
    }
  });
}

async function completionsFor(
  t: TC,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholarId).eq("activityId", activityId),
      )
      .collect(),
  );
}

const callTool = (t: TC, sessionId: Id<"sessions">, summary?: string) =>
  t.run(async (ctx) =>
    ctx.runMutation(internal.activityCompletions.markCompleteFromTool, {
      sessionId,
      summary,
    }),
  );

// ── markCompleteFromTool: the write ──────────────────────────────────

describe("markCompleteFromTool — completes a conversation-only activity", () => {
  test("writes an assignment-scoped completion, stamps activityCompletedAt, stores the summary as note", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, sessionId, assignmentId } = await seedActivity(
      t,
      teacherId,
      scholarId,
      { withAssignment: true },
    );
    await addUserMessages(t, sessionId, 2);

    const res = await callTool(t, sessionId, "Explored why bridges arch.");
    expect(res.ok).toBe(true);

    const rows = await completionsFor(t, scholarId, activityId);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].assignmentId)).toBe(String(assignmentId));
    expect(String(rows[0].sessionId)).toBe(String(sessionId));
    expect(rows[0].note).toBe("Explored why bridges arch.");

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeTruthy();
  });

  test("is idempotent — a second call dedupes (no duplicate row) and reports alreadyComplete", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, sessionId } = await seedActivity(
      t,
      teacherId,
      scholarId,
      { withAssignment: true },
    );
    await addUserMessages(t, sessionId, 2);

    const first = await callTool(t, sessionId, "First.");
    expect(first).toEqual({ ok: true, alreadyComplete: false });
    const completionBefore = (await completionsFor(t, scholarId, activityId))[0];
    const sessionBefore = await t.run(async (ctx) => ctx.db.get(sessionId));
    const second = await callTool(t, sessionId, "Second.");
    expect(second).toEqual({ ok: true, alreadyComplete: true });

    const completionsAfter = await completionsFor(t, scholarId, activityId);
    expect(completionsAfter).toEqual([completionBefore]);
    expect(completionsAfter[0].note).toBe("First.");
    expect(await t.run(async (ctx) => ctx.db.get(sessionId))).toEqual(sessionBefore);
  });

  test("fast-forwards the process pipeline to its terminal step", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId } = await seedActivity(t, teacherId, scholarId);
    await addUserMessages(t, sessionId, 2);
    // A processState the completion should fast-forward.
    await t.run(async (ctx) => {
      const processId = await ctx.db.insert("processes", {
        teacherId,
        title: "CRAFT",
        steps: [
          { key: "A", title: "Start" },
          { key: "B", title: "End" },
        ],
        isActive: true,
      });
      await ctx.db.insert("processState", {
        sessionId,
        processId,
        currentStep: "A",
        steps: [
          { key: "A", status: "in_progress" },
          { key: "B", status: "not_started" },
        ],
      });
    });

    await callTool(t, sessionId);

    const state = await t.run(async (ctx) =>
      ctx.db
        .query("processState")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .first(),
    );
    expect(state?.currentStep).toBe("B");
    expect(state?.steps.every((s) => s.status === "completed")).toBe(true);
  });

  test("mints the unit badge when the completion finishes the unit", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, sessionId } = await seedActivity(t, teacherId, scholarId, {
      withBadge: true,
      withAssignment: true,
    });
    await addUserMessages(t, sessionId, 2);

    await callTool(t, sessionId, "Done.");

    const badges = await t.run(async (ctx) =>
      ctx.db
        .query("scholarUnitBadges")
        .withIndex("by_scholar_unit", (q) =>
          q.eq("scholarId", scholarId).eq("unitId", unitId),
        )
        .collect(),
    );
    expect(badges).toHaveLength(1);
  });
});

// ── markCompleteFromTool: structured refusals (never throws) ──────────

describe("markCompleteFromTool — refuses (structured, non-throwing) when the gate fails", () => {
  test("completes an activity with a deliverable", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, sessionId } = await seedActivity(
      t,
      teacherId,
      scholarId,
      { deliverable: true },
    );
    await addUserMessages(t, sessionId, 5);

    const res = await callTool(t, sessionId, "x");
    expect(res).toMatchObject({ ok: true, alreadyComplete: false });
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(1);
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));
  });

  test("refuses when the activity has an advanceRubric — writes nothing", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, sessionId } = await seedActivity(
      t,
      teacherId,
      scholarId,
      { advanceRubric: true },
    );
    await addUserMessages(t, sessionId, 5);

    const res = await callTool(t, sessionId, "x");
    expect(res).toMatchObject({ ok: false, reason: "has_advance_rubric" });
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(0);
  });

  test("refuses on a test drive — never writes a real completion", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, sessionId } = await seedActivity(
      t,
      teacherId,
      scholarId,
      { isTestDrive: true },
    );
    await addUserMessages(t, sessionId, 5);

    const res = await callTool(t, sessionId, "x");
    expect(res).toMatchObject({ ok: false, reason: "test_drive" });
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(0);
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeUndefined();
  });

  test("refuses (too_early) when the scholar has fewer than 2 messages", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, sessionId } = await seedActivity(
      t,
      teacherId,
      scholarId,
    );
    await addUserMessages(t, sessionId, 1); // only one scholar turn

    const res = await callTool(t, sessionId, "x");
    expect(res).toMatchObject({ ok: false, reason: "too_early" });
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(0);
  });

  test("the synthetic <start> auto-opener does not count as a scholar turn", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { activityId, sessionId } = await seedActivity(
      t,
      teacherId,
      scholarId,
    );
    // The web client auto-sends "<start>" to trigger the tutor's opener; it is
    // persisted as a user row but is not real engagement. <start> + 1 real
    // turn must still refuse; a second real turn unlocks the write.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "<start>",
        flagged: false,
      });
    });
    await addUserMessages(t, sessionId, 1);

    const early = await callTool(t, sessionId, "x");
    expect(early).toMatchObject({ ok: false, reason: "too_early" });
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(0);

    await addUserMessages(t, sessionId, 1);
    const res = await callTool(t, sessionId, "x");
    expect(res).toMatchObject({ ok: true });
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(1);
  });

  test("the refusal is a structured object with a model-facing message, not a throw", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId } = await seedActivity(t, teacherId, scholarId, {
      deliverable: true,
    });
    // No throw; a plain string message the model can act on.
    const res = await callTool(t, sessionId);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(typeof res.message).toBe("string");
      expect(res.message.length).toBeGreaterThan(0);
      // Not a raw "Failed:/Error:" developer string (scholar-safe convention).
      expect(res.message).not.toMatch(/^\s*(failed|error)\s*:/i);
    }
  });
});

// ── Focus lock lifts once the conversation activity is completed ──────

describe("markCompleteFromTool — lifts the class-focus lock", () => {
  test("currentClassFocusForMe drops the focused activity after the tool completes it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { unitId, activityId } = await seedActivity(
      t,
      teacherId,
      scholarId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const assignmentId = await asTeacher.mutation(api.assignments.create, {
      unitId,
      scholarIds: [scholarId],
    });
    await asTeacher.mutation(api.assignments.pushActivity, {
      assignmentId,
      activityId,
      mode: "classFocus",
    });

    // A session for THIS assignment + activity, with real engagement.
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        activityId,
        assignmentId,
        title: "Session",
        isArchived: false,
      }),
    );
    await addUserMessages(t, sessionId, 2);

    // Before: the scholar is locked to the focus push.
    expect(
      await asScholar.query(api.assignments.currentClassFocusForMe, {}),
    ).toHaveLength(1);

    const res = await callTool(t, sessionId, "Worked through it.");
    expect(res.ok).toBe(true);

    // After: the lock lifts (the completion counts for this assignment).
    expect(
      await asScholar.query(api.assignments.currentClassFocusForMe, {}),
    ).toHaveLength(0);
    // Teacher view is unaffected.
    expect(
      await asTeacher.query(api.assignments.currentClassFocusForMe, {}),
    ).toHaveLength(1);
  });
});

// ── Prompt section: appears iff conversation-only, gated by getSessionContext ──

describe("conversation-completion prompt section", () => {
  async function promptFor(
    t: TC,
    sessionId: Id<"sessions">,
  ): Promise<string> {
    const ctx = await t.run(async (c) =>
      c.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctx).not.toBeNull();
    return buildTutorSystemPrompt(ctx!);
  }

  test("appears for a conversation-only online activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId } = await seedActivity(t, teacherId, scholarId);

    const prompt = await promptFor(t, sessionId);
    expect(prompt).toContain('Wrapping up "Chat activity"');
    expect(prompt).toContain("mark_activity_complete");
    expect(prompt).toContain("do not manufacture another prerequisite");
    expect(prompt).toContain("one `tool_use` block");
    expect(prompt).toContain("ZERO `text` blocks");
    expect(prompt).toContain("Put that assessment only in the tool's `summary`");
    expect(prompt).toContain(
      "The app writes the scholar-facing completion close",
    );
    expect(prompt).toContain(
      "must not add a preface, assessment, recap, praise, question, task, or second closing",
    );
    expect(prompt).toContain("Completion does not close the chat");
  });

  test("appears when the activity has a deliverable", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId } = await seedActivity(t, teacherId, scholarId, {
      deliverable: true,
    });

    const prompt = await promptFor(t, sessionId);
    expect(prompt).toContain('Wrapping up "Chat activity"');
    expect(prompt).toContain("mark_activity_complete");
  });

  test("does NOT appear when the activity has an advanceRubric", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId } = await seedActivity(t, teacherId, scholarId, {
      advanceRubric: true,
    });

    const prompt = await promptFor(t, sessionId);
    expect(prompt).not.toContain("Wrapping up");
    expect(prompt).not.toContain("mark_activity_complete");
  });

  test("does NOT appear on a test drive", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const { sessionId } = await seedActivity(t, teacherId, scholarId, {
      isTestDrive: true,
    });

    const prompt = await promptFor(t, sessionId);
    expect(prompt).not.toContain("Wrapping up");
    expect(prompt).not.toContain("mark_activity_complete");
  });

  test("getSessionContext sets conversationCompletionContext for unfinished eligible activities", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    const conv = await seedActivity(t, teacherId, scholarId);
    const withDeliv = await seedActivity(t, teacherId, scholarId, {
      deliverable: true,
    });

    const ctxConv = await t.run(async (c) =>
      c.runQuery(internal.sessionHelpers.getSessionContext, {
        sessionId: conv.sessionId,
      }),
    );
    const ctxDeliv = await t.run(async (c) =>
      c.runQuery(internal.sessionHelpers.getSessionContext, {
        sessionId: withDeliv.sessionId,
      }),
    );
    expect(ctxConv?.conversationCompletionContext).toEqual({
      activityTitle: "Chat activity",
    });
    expect(ctxDeliv?.conversationCompletionContext).toEqual({
      activityTitle: "Chat activity",
    });

    await t.run(async (ctx) =>
      ctx.db.patch(conv.sessionId, { activityCompletedAt: Date.now() }),
    );
    const ctxCompleted = await t.run(async (c) =>
      c.runQuery(internal.sessionHelpers.getSessionContext, {
        sessionId: conv.sessionId,
      }),
    );
    expect(ctxCompleted?.conversationCompletionContext).toBeNull();
  });
});
