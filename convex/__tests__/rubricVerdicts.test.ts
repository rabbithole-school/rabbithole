import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { resolveScorableArtifactId } from "../deliverables";
import type { Doc, Id } from "../_generated/dataModel";
import {
  applySlideOps,
  emptyDeck,
  type Deck,
} from "../../shared/slidesScene";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${role}`,
      username: `t${role}_${Math.random().toString(36).slice(2, 6)}`,
      role,
    }),
  );
}

async function seedActivityWithCriteria(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  deliverableKind: "text" | "slides" = "text",
): Promise<Id<"activities">> {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Test Lesson",
      order: 0,
    });
    return await ctx.db.insert("activities", {
      lessonId,
      title: "Write a story",
      kind: "online" as const,
      systemPrompt: "...",
      order: 0,
      deliverable: {
        kind: deliverableKind,
        mode: "manual" as const,
        prompt: "Write something",
        criteria: [
          { id: "structure", label: "Beginning, middle, end" },
          { id: "length", label: "Length" },
          { id: "specificity", label: "Specificity" },
        ],
      },
    });
  });
}

describe("applyCheckResult persists per-criterion verdicts", () => {
  test("happy path: verdicts + overall + derived rubricPassed all persist", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Write a story",
        isArchived: false,
      } as unknown as Doc<"sessions">),
    );

    const deliverableId = await t.run(async (ctx) =>
      ctx.db.insert("deliverables", {
        activityId,
        scholarId,
        sessionId,
        textContent: "submission",
        submittedAt: Date.now(),
      }),
    );

    await t.mutation(internal.deliverables.applyCheckResult, {
      deliverableId,
      verdicts: [
        { criterionId: "structure", level: "full", note: "ok" },
        { criterionId: "length", level: "half", note: "borderline" },
        { criterionId: "specificity", level: "not", note: "missing" },
      ],
      overall: "half",
      feedback: "Needs revision.",
      conceptLabel: "Storytelling",
      domain: "Writing",
      masteryLevel: 2,
      confidence: 0.7,
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row?.overall).toBe("half");
    expect(row?.rubricPassed).toBe(false);
    expect(row?.rubricFeedback).toBe("Needs revision.");
    expect(row?.verdicts).toEqual([
      { criterionId: "structure", level: "full", note: "ok" },
      { criterionId: "length", level: "half", note: "borderline" },
      { criterionId: "specificity", level: "not", note: "missing" },
    ]);
  });

  test("overall=full records diagnostics without completing the activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Write a story",
        isArchived: false,
      } as unknown as Doc<"sessions">),
    );

    const deliverableId = await t.run(async (ctx) =>
      ctx.db.insert("deliverables", {
        activityId,
        scholarId,
        sessionId,
        textContent: "great story",
        submittedAt: Date.now(),
      }),
    );

    await t.mutation(internal.deliverables.applyCheckResult, {
      deliverableId,
      verdicts: [
        { criterionId: "structure", level: "full" },
        { criterionId: "length", level: "full" },
        { criterionId: "specificity", level: "full" },
      ],
      overall: "full",
      feedback: "Passed.",
      conceptLabel: "Storytelling",
      domain: "Writing",
      masteryLevel: 3,
      confidence: 0.9,
    });

    const row = await t.run(async (ctx) => ctx.db.get(deliverableId));
    expect(row?.rubricPassed).toBe(true);
    expect(row?.overall).toBe("full");

    const session = await t.run(async (ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeUndefined();

    const completions = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(completions).toHaveLength(0);
  });
});

describe("applyRubricScoreFromTool sanitizes model verdicts (no '5 of 4 stars')", () => {
  async function seedSessionWithArtifact(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    activityId: Id<"activities">,
  ) {
    return await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Write a story",
        isArchived: false,
      } as unknown as Doc<"sessions">);
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId,
        title: "My doc",
        content: "the work",
        lastEditedBy: "scholar" as const,
      });
      return { sessionId, artifactId };
    });
  }

  test("duplicate + invalid 'full' verdicts can't exceed the criteria count", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId); // 3 criteria
    const { sessionId, artifactId } = await seedSessionWithArtifact(
      t,
      scholarId,
      activityId,
    );

    // A misbehaving model: 'structure' twice + an invented criterion, all
    // "full" — 5 "full" verdicts against a 3-criterion rubric.
    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      artifactId,
      verdicts: [
        { criterionId: "structure", level: "full" },
        { criterionId: "structure", level: "full" },
        { criterionId: "length", level: "full" },
        { criterionId: "specificity", level: "full" },
        { criterionId: "made-up", level: "full" },
      ],
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    const stored = rows[0].verdicts ?? [];
    // Exactly one verdict per criterion — no dupes, no invented ids.
    expect(stored).toHaveLength(3);
    expect(stored.map((v) => v.criterionId).sort()).toEqual([
      "length",
      "specificity",
      "structure",
    ]);
    const fullCount = stored.filter((v) => v.level === "full").length;
    expect(fullCount).toBe(3); // never 5
    expect(rows[0].overall).toBe("full");
    expect(rows[0].flairEarned?.map((flair) => flair.criterionId)).toEqual([
      "structure",
      "length",
      "specificity",
    ]);
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.activityCompletedAt).toBeUndefined();
    const completions = await t.run((ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(completions).toHaveLength(0);
  });

  test("commits newly earned flair and its transcript notice together", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const { sessionId, artifactId } = await seedSessionWithArtifact(
      t,
      scholarId,
      activityId,
    );
    const currentMessageId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
      }),
    );

    const result = await t.mutation(
      internal.deliverables.applyRubricScoreFromTool,
      {
        sessionId,
        artifactId,
        verdicts: [{ criterionId: "structure", level: "full" }],
        streamSplit: {
          currentMessageId,
          contentSoFar: "You built a clear sequence.",
        },
      },
    );

    const [deliverable, messages] = await t.run(async (ctx) => [
      await ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
      await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    ]);
    const flairNotice = messages.find((message) => message.flairAwards?.length);

    expect(deliverable?.flairEarned?.map((flair) => flair.criterionId)).toEqual([
      "structure",
    ]);
    expect(flairNotice?.toolAction).toBe("Earned flair");
    expect(flairNotice?.flairAwards).toEqual([
      {
        criterionId: "structure",
        label: "Beginning, middle, end",
      },
    ]);
    expect(result.newAssistantMessageId).toEqual(
      messages.find(
        (message) =>
          message.role === "assistant" &&
          message._id !== currentMessageId &&
          message.content === "",
      )?._id,
    );
  });

  test("snapshots the grader's note onto the flair and never rewrites it", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const { sessionId, artifactId } = await seedSessionWithArtifact(
      t,
      scholarId,
      activityId,
    );

    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      artifactId,
      verdicts: [
        {
          criterionId: "structure",
          level: "full",
          note: "You landed the ending instead of trailing off.",
        },
      ],
    });

    const afterAward = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    );
    expect(afterAward?.flairEarned?.[0].note).toBe(
      "You landed the ending instead of trailing off.",
    );
    expect(afterAward?.verdicts?.[0].note).toBe(
      "You landed the ending instead of trailing off.",
    );

    // A later re-check can downgrade the live verdict, but flair is permanent —
    // its note must stay the celebration it was awarded with, never a deficit
    // sentence from a subsequent check.
    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      artifactId,
      verdicts: [
        {
          criterionId: "structure",
          level: "half",
          note: "The ending stops mid-thought now.",
        },
      ],
    });

    const afterRecheck = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    );
    expect(afterRecheck?.flairEarned?.[0].note).toBe(
      "You landed the ending instead of trailing off.",
    );
  });

  test("flair is monotonic, keeps its original earnedAt, and appends newly full criteria", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const { sessionId, artifactId } = await seedSessionWithArtifact(
      t,
      scholarId,
      activityId,
    );

    const first = await t.mutation(
      internal.deliverables.applyRubricScoreFromTool,
      {
        sessionId,
        artifactId,
        verdicts: [{ criterionId: "structure", level: "full" }],
      },
    );
    expect(first.newlyEarnedFlairLabels).toEqual(["Beginning, middle, end"]);
    expect(first.newlyEarnedFlair).toEqual([
      {
        criterionId: "structure",
        label: "Beginning, middle, end",
      },
    ]);
    const firstRow = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    );
    const originalEarnedAt = firstRow?.flairEarned?.[0].earnedAt;
    expect(originalEarnedAt).toEqual(expect.any(Number));

    const second = await t.mutation(
      internal.deliverables.applyRubricScoreFromTool,
      {
        sessionId,
        artifactId,
        verdicts: [
          { criterionId: "structure", level: "not" },
          { criterionId: "length", level: "full" },
        ],
      },
    );
    expect(second.newlyEarnedFlairLabels).toEqual(["Length"]);

    const third = await t.mutation(
      internal.deliverables.applyRubricScoreFromTool,
      {
        sessionId,
        artifactId,
        verdicts: [
          { criterionId: "structure", level: "full" },
          { criterionId: "length", level: "half" },
        ],
      },
    );
    expect(third.newlyEarnedFlairLabels).toEqual([]);

    const finalRow = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .unique(),
    );
    expect(finalRow?.flairEarned).toHaveLength(2);
    expect(finalRow?.flairEarned?.map((flair) => flair.criterionId)).toEqual([
      "structure",
      "length",
    ]);
    expect(finalRow?.flairEarned?.[0].earnedAt).toBe(originalEarnedAt);
  });

  test("a criterion the model omits is stored as 'not' (not dropped)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId); // 3 criteria
    const { sessionId, artifactId } = await seedSessionWithArtifact(
      t,
      scholarId,
      activityId,
    );

    // Model only reports one criterion.
    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      artifactId,
      verdicts: [{ criterionId: "structure", level: "full" }],
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .first(),
    );
    const stored = row?.verdicts ?? [];
    expect(stored).toHaveLength(3);
    const byId = Object.fromEntries(stored.map((v) => [v.criterionId, v.level]));
    expect(byId.structure).toBe("full");
    expect(byId.length).toBe("not");
    expect(byId.specificity).toBe("not");
    // Not every criterion is full → overall is not a pass.
    expect(row?.overall).toBe("not");
    expect(row?.rubricPassed).toBe(false);
  });
});

describe("resolveScorableArtifactId + artifact_id fallback (missing-id bug)", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let slideElementId = 0;

  function deckWithText(text: string): Deck {
    const result = applySlideOps(
      emptyDeck("Evidence deck", "slide-1"),
      [
        {
          op: "addElement",
          slideId: "slide-1",
          element: {
            type: "text",
            frame: { x: 40, y: 40, w: 800, h: 160 },
            text,
            style: { fontSize: 48, bold: true },
          },
        },
      ],
      () => `slide-element-${++slideElementId}`,
    );
    if (!result.ok) throw new Error(result.error);
    return result.deck;
  }

  async function seedSession(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    activityId: Id<"activities">,
  ): Promise<Id<"sessions">> {
    return await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Write a story",
        isArchived: false,
      } as unknown as Doc<"sessions">),
    );
  }

  async function insertArtifact(
    t: ReturnType<typeof convexTest>,
    sessionId: Id<"sessions">,
    title: string,
    content: string,
  ): Promise<Id<"artifacts">> {
    return await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title,
        content,
        lastEditedBy: "scholar" as const,
      }),
    );
  }

  test("session with 0 artifacts → null (caller keeps the error)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const sessionId = await seedSession(t, scholarId, activityId);

    const resolved = await t.run((ctx) =>
      resolveScorableArtifactId(ctx, sessionId),
    );
    expect(resolved).toBeNull();
  });

  test("session with 1 artifact → that artifact", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const sessionId = await seedSession(t, scholarId, activityId);
    const artifactId = await insertArtifact(t, sessionId, "Doc", "the work");

    const resolved = await t.run((ctx) =>
      resolveScorableArtifactId(ctx, sessionId),
    );
    expect(resolved).toBe(artifactId);
  });

  test("session with 2 artifacts → the newest by _creationTime", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const sessionId = await seedSession(t, scholarId, activityId);

    const older = await insertArtifact(t, sessionId, "Older", "first");
    await sleep(3);
    const newer = await insertArtifact(t, sessionId, "Newer", "second");

    const resolved = await t.run((ctx) =>
      resolveScorableArtifactId(ctx, sessionId),
    );
    expect(resolved).toBe(newer);
    expect(resolved).not.toBe(older);
  });

  test("text deliverable ignores a slides artifact and resolves the newest text artifact", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId, "text");
    const sessionId = await seedSession(t, scholarId, activityId);

    const older = await insertArtifact(t, sessionId, "Older", "first");
    await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Deck",
        content: JSON.stringify(deckWithText("Deck copy")),
        lastEditedBy: "scholar",
        type: "slides",
      }),
    );
    await sleep(3);
    const newer = await insertArtifact(t, sessionId, "Newer", "final");

    const resolved = await t.run((ctx) =>
      resolveScorableArtifactId(ctx, sessionId),
    );
    expect(resolved).toBe(newer);
    expect(resolved).not.toBe(older);
  });

  test("slides deliverable resolves and snapshots the deck instead of text notes", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId, "slides");
    const sessionId = await seedSession(t, scholarId, activityId);
    const deckCopy = "Volcanoes release pressure through vents.";
    const deck = deckWithText(deckCopy);
    const slidesArtifactId = await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId,
        title: "Volcano deck",
        content: JSON.stringify(deck),
        lastEditedBy: "scholar",
        type: "slides",
      }),
    );
    await sleep(3);
    await insertArtifact(
      t,
      sessionId,
      "Planning notes",
      "NOTES ONLY: replace this with the real deck.",
    );

    const resolved = await t.run((ctx) =>
      resolveScorableArtifactId(ctx, sessionId),
    );
    expect(resolved).toBe(slidesArtifactId);

    await t.mutation(internal.deliverables.applyRubricScoreFromTool, {
      sessionId,
      verdicts: [{ criterionId: "structure", level: "full" }],
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .first(),
    );
    expect(row?.artifactId).toBe(slidesArtifactId);
    expect(row?.textContent).toContain(deckCopy);
    expect(row?.textContent).toContain("[slide stats]");
    expect(row?.textContent).not.toContain("NOTES ONLY");
    expect(row?.textContent).not.toContain('"schemaVersion"');
  });

  test("does not cross session boundaries", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const sessionA = await seedSession(t, scholarId, activityId);
    const sessionB = await seedSession(t, scholarId, activityId);
    await insertArtifact(t, sessionB, "B doc", "b");

    // sessionA owns no artifacts — B's must not leak in.
    const resolved = await t.run((ctx) =>
      resolveScorableArtifactId(ctx, sessionA),
    );
    expect(resolved).toBeNull();
  });

  test("applyRubricScoreFromTool with NO artifactId scores the newest artifact (stars pay out)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId); // 3 criteria
    const sessionId = await seedSession(t, scholarId, activityId);

    await insertArtifact(t, sessionId, "Older", "first draft");
    await sleep(3);
    const newer = await insertArtifact(t, sessionId, "Newer", "final draft");

    const result = await t.mutation(
      internal.deliverables.applyRubricScoreFromTool,
      {
        sessionId,
        // artifactId intentionally omitted — the reported bug shape.
        verdicts: [
          { criterionId: "structure", level: "full" },
          { criterionId: "length", level: "full" },
          { criterionId: "specificity", level: "full" },
        ],
      },
    );

    expect(result.passed).toBe(true);
    expect(result.earned).toBe(3);
    expect(result.total).toBe(3);

    // The deliverable row was written against the NEWEST artifact.
    const rows = await t.run((ctx) =>
      ctx.db
        .query("deliverables")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].artifactId).toBe(newer);
    expect(rows[0].rubricPassed).toBe(true);
  });

  test("applyRubricScoreFromTool with NO artifactId + NO artifacts still errors", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const activityId = await seedActivityWithCriteria(t, teacherId);
    const sessionId = await seedSession(t, scholarId, activityId);

    await expect(
      t.mutation(internal.deliverables.applyRubricScoreFromTool, {
        sessionId,
        verdicts: [{ criterionId: "structure", level: "full" }],
      }),
    ).rejects.toThrow(/Pass artifact_id/);
  });
});

describe("activities.createInternal enforces deliverable for online", () => {
  test("REFUSES online activity without deliverable", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U",
        isActive: true,
      });
      return await ctx.db.insert("lessons", {
        unitId,
        title: "L",
        order: 0,
      });
    });

    await expect(
      t.mutation(internal.activities.createInternal, {
        lessonId,
        title: "X",
        kind: "online" as const,
      }),
    ).rejects.toThrow(/REFUSED/);
  });

  test("accepts online activity with criteria-shaped deliverable", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const lessonId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "U",
        isActive: true,
      });
      return await ctx.db.insert("lessons", {
        unitId,
        title: "L",
        order: 0,
      });
    });

    const id = await t.mutation(internal.activities.createInternal, {
      lessonId,
      title: "X",
      kind: "online" as const,
      deliverable: {
        kind: "text" as const,
        mode: "manual" as const,
        prompt: "Write",
        criteria: [{ id: "overall", label: "Overall" }],
      },
    });
    const a = await t.run(async (ctx) => ctx.db.get(id));
    expect(a?.deliverable?.criteria).toHaveLength(1);
    expect(a?.deliverable?.criteria[0].id).toBe("overall");
  });
});
