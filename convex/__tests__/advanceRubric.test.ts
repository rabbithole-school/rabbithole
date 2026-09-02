import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { scoreRubricVerdicts } from "../lib/deliverable";
import { buildTutorSystemPrompt } from "../sessionStreamHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

const CRITERIA = [
  { id: "a", label: "A" },
  { id: "b", label: "B" },
];

describe("scoreRubricVerdicts (pure)", () => {
  test("all full → passed, overall full", () => {
    const r = scoreRubricVerdicts(CRITERIA, [
      { criterionId: "a", level: "full" },
      { criterionId: "b", level: "full" },
    ]);
    expect(r.passed).toBe(true);
    expect(r.overall).toBe("full");
    expect(r.earned).toBe(2);
    expect(r.total).toBe(2);
  });

  test("all half → fractional credit without passing", () => {
    const r = scoreRubricVerdicts(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      [
        { criterionId: "a", level: "half" },
        { criterionId: "b", level: "half" },
        { criterionId: "c", level: "half" },
      ],
    );
    expect(r.earned).toBe(1.5);
    expect(r.total).toBe(3);
    expect(r.overall).toBe("half");
    expect(r.passed).toBe(false);
  });

  test("mixed verdicts sum full and half credit without passing", () => {
    const r = scoreRubricVerdicts(
      [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
        { id: "c", label: "C" },
      ],
      [
        { criterionId: "a", level: "full" },
        { criterionId: "b", level: "half" },
        { criterionId: "c", level: "not" },
      ],
    );
    expect(r.earned).toBe(1.5);
    expect(r.total).toBe(3);
    expect(r.overall).toBe("not");
    expect(r.passed).toBe(false);
  });

  test("any not → not passed, overall not; omitted criteria default to not", () => {
    const r = scoreRubricVerdicts(CRITERIA, [{ criterionId: "a", level: "full" }]);
    expect(r.passed).toBe(false);
    expect(r.overall).toBe("not");
    expect(r.verdicts).toEqual([
      { criterionId: "a", level: "full" },
      { criterionId: "b", level: "not" },
    ]);
  });

  test("any half (no not) → overall half, not passed", () => {
    const r = scoreRubricVerdicts(CRITERIA, [
      { criterionId: "a", level: "full" },
      { criterionId: "b", level: "half" },
    ]);
    expect(r.overall).toBe("half");
    expect(r.passed).toBe(false);
  });

  test("drops unknown criteria + collapses duplicates (first wins)", () => {
    const r = scoreRubricVerdicts(CRITERIA, [
      { criterionId: "a", level: "full" },
      { criterionId: "a", level: "not" }, // duplicate ignored
      { criterionId: "zzz", level: "full" }, // unknown dropped
      { criterionId: "b", level: "full" },
    ]);
    expect(r.passed).toBe(true);
    expect(r.verdicts).toEqual([
      { criterionId: "a", level: "full" },
      { criterionId: "b", level: "full" },
    ]);
  });

  test("empty criteria cannot pass vacuously", () => {
    expect(() => scoreRubricVerdicts([], [])).toThrow(
      /criteria are ready/,
    );
  });
});

async function seedActivityWithAdvanceRubric(t: TC, withBadge = false) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "T",
      username: "t-" + Math.random().toString(36).slice(2, 7),
      role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "S",
      username: "s-" + Math.random().toString(36).slice(2, 7),
      role: "scholar",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Unit",
      isActive: true,
      ...(withBadge
        ? { badgeOnCompletion: { title: "Test Badge", icon: "⭐" } }
        : {}),
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Chat activity",
      kind: "online",
      order: 0,
      systemPrompt: "...",
      advanceRubric: { criteria: CRITERIA },
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      lessonId,
      activityId,
      title: "Session",
      isArchived: false,
    });
    return { scholarId, unitId, lessonId, activityId, sessionId };
  });
}

async function completionsFor(t: TC, scholarId: Id<"users">, activityId: Id<"activities">) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholarId).eq("activityId", activityId),
      )
      .collect(),
  );
}

describe("applyAdvanceRubricScoreFromTool", () => {
  test("the tutor scores before replying and winds down instead of asking another question on pass", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedActivityWithAdvanceRubric(t);
    const context = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(context).not.toBeNull();

    const prompt = buildTutorSystemPrompt(context!);
    expect(prompt).toContain("before any scholar-facing text in that turn");
    expect(prompt).toContain(
      "The app writes the scholar-facing completion close after the tool succeeds",
    );
    expect(prompt).toContain("Completion does not close the chat");
  });

  test("a partial score stores an artifact-less row but does NOT complete", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, activityId, sessionId } =
      await seedActivityWithAdvanceRubric(t);

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId,
        verdicts: [{ criterionId: "a", level: "full" }], // b omitted → not
      }),
    );
    expect(res.passed).toBe(false);

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].artifactId).toBeUndefined(); // artifact-less
    expect(rows[0].rubricPassed).toBe(false);
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(0);
  });

  test("a full pass completes the activity + mints the unit badge", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, unitId, activityId, sessionId } =
      await seedActivityWithAdvanceRubric(t, true);

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId,
        verdicts: [
          { criterionId: "a", level: "full" },
          { criterionId: "b", level: "full" },
        ],
      }),
    );
    expect(res.passed).toBe(true);

    // Activity marked complete...
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(1);
    // ...session fast-forwarded (celebration)...
    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeTruthy();
    const completedContext = await t.run(async (ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(completedContext?.advanceRubricContext?.isComplete).toBe(true);
    const completedPrompt = buildTutorSystemPrompt(completedContext!);
    expect(completedPrompt).toContain("This activity is already complete");
    expect(completedPrompt).toContain("respond normally to whatever they ask next");
    expect(completedPrompt).toContain(
      "discuss their update naturally without recording new conversation-rubric verdicts",
    );
    // ...and the badge minted (only activity in the unit → unit complete).
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

  test("rejects a canonical pass before writes when the closing text was invalid", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, activityId, sessionId } =
      await seedActivityWithAdvanceRubric(t);

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId,
        rejectPassingScore: true,
        verdicts: [
          { criterionId: "a", level: "full" },
          { criterionId: "b", level: "full" },
          { criterionId: "unknown", level: "half" },
        ],
      }),
    );

    expect(res).toMatchObject({
      passed: false,
      rejectedCompletion: true,
    });
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(0);
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(0);
  });

  test("does not change rubric state when completion already landed", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, activityId, sessionId } =
      await seedActivityWithAdvanceRubric(t);

    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId,
        verdicts: [
          { criterionId: "a", level: "full" },
          { criterionId: "b", level: "full" },
        ],
      }),
    );
    expect(first).toMatchObject({ passed: true, alreadyComplete: false });
    const before = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    );

    const repeated = await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId,
        verdicts: [
          { criterionId: "a", level: "not" },
          { criterionId: "b", level: "not" },
        ],
      }),
    );

    expect(repeated).toMatchObject({ alreadyComplete: true });
    const after = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    );
    expect(after).toEqual(before);
    expect(await completionsFor(t, scholarId, activityId)).toHaveLength(1);
  });

  test("re-scoring updates the same artifact-less row (no duplicate)", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedActivityWithAdvanceRubric(t);
    const call = (level: "half" | "full") =>
      t.run(async (ctx) =>
        ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
          sessionId,
          verdicts: [
            { criterionId: "a", level: "full" },
            { criterionId: "b", level },
          ],
        }),
      );
    await call("half");
    await call("full");
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].rubricPassed).toBe(true);
  });
});

describe("splitStream — silent split for the chat rubric", () => {
  async function setup(t: TC) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "S",
        username: "s-" + Math.random().toString(36).slice(2, 7),
        role: "scholar",
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId,
        title: "Session",
        isArchived: false,
      });
      const msgId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
      });
      return { sessionId, msgId };
    });
  }
  const toolRows = (t: TC, sessionId: Id<"sessions">) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("messages")
          .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
          .collect()
      ).filter((m) => m.role === "tool"),
    );

  test("a non-empty toolAction (document rubric) persists a tool row", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, msgId } = await setup(t);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: msgId,
        sessionId,
        contentSoFar: "Here's my reply.",
        toolAction: "Reviewed work",
      }),
    );
    const rows = await toolRows(t, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolAction).toBe("Reviewed work");
  });

  test("toolContent is persisted as the tool row content (physical-task card)", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, msgId } = await setup(t);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: msgId,
        sessionId,
        contentSoFar: "Go grab the bells.",
        toolAction: "physical_task",
        toolContent: "task_abc123",
      }),
    );
    const rows = await toolRows(t, sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolAction).toBe("physical_task");
    expect(rows[0].content).toBe("task_abc123");
  });

  test("a blank toolAction (chat advance rubric) splits silently — no tool row", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, msgId } = await setup(t);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: msgId,
        sessionId,
        contentSoFar: "Here's my reply.",
        toolAction: "",
      }),
    );
    expect(await toolRows(t, sessionId)).toHaveLength(0);
    // The split still finalized the reply + opened a fresh assistant placeholder.
    const assistants = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("messages")
          .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
          .collect()
      ).filter((m) => m.role === "assistant"),
    );
    expect(assistants.length).toBe(2);
    expect(assistants.some((m) => m.content === "Here's my reply.")).toBe(true);
  });

  test("anchors completion UI to the post-tool closing message", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, msgId } = await setup(t);
    const closingMessageId = await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: msgId,
        sessionId,
        contentSoFar: "",
        toolAction: "",
        marksActivityCompletion: true,
      }),
    );

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletionMessageId).toBe(closingMessageId);
  });

  test("anchors completion UI to an already-streamed closing message", async () => {
    const t = convexTest(schema, modules);
    const { sessionId, msgId } = await setup(t);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: msgId,
        sessionId,
        contentSoFar: "You connected pressure loss to expanding gas.",
        toolAction: "",
        marksActivityCompletion: true,
        completionAnchorCurrentMessage: true,
      }),
    );

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletionMessageId).toBe(msgId);
  });
});
