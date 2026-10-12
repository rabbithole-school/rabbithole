import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { buildActivitySection, buildSystemPrompt } from "../sessionHelpers";
import type { Doc, Id } from "../_generated/dataModel";
import { emptyDeck } from "../../shared/slidesScene";
import { upsertGoogleSlides } from "../lib/activityPresentationResources";
import { insertCodeRevision } from "../codeArtifactRevisions";
import { deleteSessionCascade } from "../lib/cascade";

const modules = (import.meta as ImportMeta & { glob: (pattern: string) => Record<string, () => Promise<unknown>> }).glob("../**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>, role: "scholar" | "teacher" = "scholar") {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: role === "scholar" ? "Test Scholar" : "Test Teacher",
      username: role === "scholar" ? "testscholar" : "testteacher",
      role,
    });
    return userId;
  });
}

async function withScholar(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  // @convex-dev/auth's getAuthUserId reads ctx.auth.getUserIdentity().subject,
  // expecting the format "<userId>|<sessionId>". For tests we only need the
  // userId portion to resolve correctly.
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId: scholarId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${scholarId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnitWithLesson(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  opts: { unitTitle?: string; lessonTitle?: string } = {},
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: opts.unitTitle ?? "Test Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: opts.lessonTitle ?? "Test Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Test Activity",
      kind: "online",
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  name: string,
  isPrimary = false,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name,
      slug: name.toLowerCase().replace(/\W+/g, "-"),
      kind: "school",
      emoji: "🏫",
      ...(isPrimary ? { isPrimary: true } : {}),
    }),
  );
}

async function seedTeacherInInstitution(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  username: string,
) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: username,
      username,
      role: "teacher",
    });
    await ctx.db.insert("memberships", {
      userId: teacherId,
      institutionId,
      role: "teacher",
    });
    return teacherId;
  });
}

describe("activities.get", () => {
  test("returns null when a live activity has no lesson", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const activityId = await t.run(async (ctx) =>
      ctx.db.insert("activities", {
        title: "Orphaned activity",
        kind: "online",
        order: 0,
      }),
    );

    await expect((await withScholar(t, teacherId)).query(api.activities.get, { id: activityId }))
      .resolves.toBeNull();
  });

  test("returns null when an activity's lesson was deleted", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { lessonId, activityId } = await seedUnitWithLesson(t, teacherId);
    await t.run(async (ctx) => ctx.db.delete(lessonId));

    await expect((await withScholar(t, teacherId)).query(api.activities.get, { id: activityId }))
      .resolves.toBeNull();
  });

  test("enforces unit access for a complete activity hierarchy", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await seedInstitution(t, "School A", true);
    const schoolB = await seedInstitution(t, "School B");
    const teacherA = await seedTeacherInInstitution(t, schoolA, "teacher-a");
    const teacherB = await seedTeacherInInstitution(t, schoolB, "teacher-b");
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: teacherA,
        institutionId: schoolA,
        title: "School A Unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "School A Lesson",
        order: 0,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "School A Activity",
        kind: "online",
        order: 0,
      });
    });

    await expect((await withScholar(t, teacherA)).query(api.activities.get, { id: activityId }))
      .resolves.toMatchObject({ _id: activityId });
    await expect((await withScholar(t, teacherB)).query(api.activities.get, { id: activityId }))
      .rejects.toThrow("Forbidden: unit is not in your institution");
  });
});

describe("activities tutor model storage", () => {
  test("public create/update store only a vibecode Fable override", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "Tutor Model School");
    const teacherId = await seedTeacherInInstitution(
      t,
      institutionId,
      "tutor-model-teacher",
    );
    const lessonId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        institutionId,
        title: "Build Lab",
        isActive: true,
      });
      return await ctx.db.insert("lessons", {
        unitId,
        title: "Model Motion",
        order: 0,
      });
    });
    const asTeacher = await withScholar(t, teacherId);

    const activityId = await asTeacher.mutation(api.activities.create, {
      lessonId,
      title: "Build a Motion Model",
      kind: "vibecode",
      tutorModel: "sonnet",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(activityId)))?.tutorModel,
    ).toBeUndefined();

    await asTeacher.mutation(api.activities.update, {
      id: activityId,
      tutorModel: "fable",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(activityId)))?.tutorModel,
    ).toBe("fable");

    await asTeacher.mutation(api.activities.update, {
      id: activityId,
      title: "Build a Better Motion Model",
    });
    expect(await t.run((ctx) => ctx.db.get(activityId))).toMatchObject({
      title: "Build a Better Motion Model",
      tutorModel: "fable",
    });

    await asTeacher.mutation(api.activities.update, {
      id: activityId,
      tutorModel: "sonnet",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(activityId)))?.tutorModel,
    ).toBeUndefined();

    await asTeacher.mutation(api.activities.update, {
      id: activityId,
      tutorModel: "fable",
    });
    await asTeacher.mutation(api.activities.update, {
      id: activityId,
      kind: "offline",
    });
    expect(await t.run((ctx) => ctx.db.get(activityId))).toMatchObject({
      kind: "offline",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(activityId)))?.tutorModel,
    ).toBeUndefined();
  });

  test("internal upsert/update normalize defaults and clear stale overrides", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { lessonId } = await seedUnitWithLesson(t, teacherId);

    const vibecode = await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      title: "Build a Weather Model",
      kind: "vibecode",
      tutorModel: "sonnet",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(vibecode.activityId)))?.tutorModel,
    ).toBeUndefined();

    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byId: vibecode.activityId },
      title: "Build a Weather Model",
      kind: "vibecode",
      tutorModel: "fable",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(vibecode.activityId)))?.tutorModel,
    ).toBe("fable");

    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byId: vibecode.activityId },
      title: "Build a Weather Model",
      kind: "offline",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(vibecode.activityId)))?.tutorModel,
    ).toBeUndefined();

    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byId: vibecode.activityId },
      title: "Build a Weather Model",
      kind: "vibecode",
      tutorModel: "fable",
    });
    await t.mutation(internal.activities.updateInternal, {
      id: vibecode.activityId,
      kind: "offline",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(vibecode.activityId)))?.tutorModel,
    ).toBeUndefined();

    const staleId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Legacy Offline Override",
        kind: "offline",
        tutorModel: "fable",
        order: 2,
      }),
    );
    await t.mutation(internal.activities.upsertInternal, {
      parent: { kind: "lesson", lessonId },
      match: { byId: staleId },
      title: "Legacy Offline Override",
      kind: "offline",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(staleId)))?.tutorModel,
    ).toBeUndefined();
  });
});

// TRA-340: a photo submission and the conversation-rubric upsert share one
// artifact-less `deliverables` row, so an activity may never hold both bars.
// upsertInternal already refused the combination; the edit paths did not.
describe("activities update — one evaluation bar", () => {
  const photoDeliverable = {
    kind: "photo" as const,
    prompt: "Snap your sketch",
    mode: "manual" as const,
    criteria: [{ id: "labels", label: "Labels", description: "Parts named" }],
  };

  async function seedAdvanceRubricActivity(t: ReturnType<typeof convexTest>) {
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);
    await t.run((ctx) =>
      ctx.db.patch(activityId, {
        advanceRubric: { criteria: [{ id: "noticed", label: "Noticed it" }] },
      }),
    );
    return { teacherId, activityId };
  }

  test("public update refuses a deliverable on an advanceRubric activity", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, activityId } = await seedAdvanceRubricActivity(t);
    const asTeacher = await withScholar(t, teacherId);

    await expect(
      asTeacher.mutation(api.activities.update, {
        id: activityId,
        deliverable: photoDeliverable,
      }),
    ).rejects.toThrow(/already has a conversation advance gate/i);
    const activity = await t.run((ctx) => ctx.db.get(activityId));
    expect(activity?.deliverable).toBeUndefined();
    expect(activity?.advanceRubric?.criteria[0].id).toBe("noticed");

    // Clearing, and unrelated edits, still go through.
    await asTeacher.mutation(api.activities.update, {
      id: activityId,
      deliverable: null,
      title: "Renamed",
    });
    expect((await t.run((ctx) => ctx.db.get(activityId)))?.title).toBe(
      "Renamed",
    );
  });

  test("updateInternal (curriculum bot) refuses the same combination", async () => {
    const t = convexTest(schema, modules);
    const { activityId } = await seedAdvanceRubricActivity(t);

    await expect(
      t.mutation(internal.activities.updateInternal, {
        id: activityId,
        deliverable: photoDeliverable,
      }),
    ).rejects.toThrow(/already has a conversation advance gate/i);
    expect(
      (await t.run((ctx) => ctx.db.get(activityId)))?.deliverable,
    ).toBeUndefined();
  });
});

describe("activities.saveTeacherSlidesDeck", () => {
  test("saves a valid Rabbit Slides deck for a curriculum editor", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);
    const asTeacher = await withScholar(t, teacherId);
    const deck = emptyDeck("Activity deck", "sl1");

    const result = await asTeacher.mutation(api.activities.saveTeacherSlidesDeck, {
      id: activityId,
      deckJson: JSON.stringify(deck),
      baseRevision: 0,
    });

    expect(result).toEqual({ ok: true, revision: 0, slideCount: 1 });
    const stored = await t.run(async (ctx) => ctx.db.get(activityId));
    expect(stored?.slidesDeck).toBe(JSON.stringify(deck));
    const resource = await t.run(async (ctx) =>
      ctx.db
        .query("activityResources")
        .withIndex("by_activity", (q) => q.eq("activityId", activityId))
        .first(),
    );
    expect(resource?.source).toEqual({
      kind: "rabbit_slides",
      deck: JSON.stringify(deck),
    });
  });

  test("dual-writes Google presentation provenance and detaches its resource", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);
    const asTeacher = await withScholar(t, teacherId);

    await asTeacher.mutation(api.activities.attachGoogleSlidesDeck, {
      id: activityId,
      presentationId: "google-deck-1",
      url: "https://docs.google.com/presentation/d/google-deck-1/edit",
      ownedByUs: false,
      name: "Reference slides",
    });

    const attached = await t.run(async (ctx) => {
      const activity = await ctx.db.get(activityId);
      const resources = await ctx.db
        .query("activityResources")
        .withIndex("by_activity", (q) => q.eq("activityId", activityId))
        .collect();
      return { activity, resources };
    });
    expect(attached.activity?.googleSlidesOwnerId).toBe(teacherId);
    expect(attached.resources).toHaveLength(1);
    expect(attached.resources[0].source).toMatchObject({
      kind: "google_slides",
      presentationId: "google-deck-1",
      principal: { kind: "personal_oauth", userId: teacherId },
    });

    await asTeacher.mutation(api.activities.detachGoogleSlidesDeck, {
      id: activityId,
    });
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("activityResources")
          .withIndex("by_activity", (q) => q.eq("activityId", activityId))
          .collect(),
      ),
    ).toHaveLength(0);
  });

  test("keeps Google as a teacher reference while Rabbit slides take precedence", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);
    const asTeacher = await withScholar(t, teacherId);
    await asTeacher.mutation(api.activities.attachGoogleSlidesDeck, {
      id: activityId,
      presentationId: "google-reference",
      url: "https://docs.google.com/presentation/d/google-reference/edit",
      ownedByUs: true,
    });
    await asTeacher.mutation(api.activities.saveTeacherSlidesDeck, {
      id: activityId,
      deckJson: JSON.stringify(emptyDeck("Rabbit deck", "sl1")),
      baseRevision: 0,
    });

    const presentations = await asTeacher.query(
      api.activityResources.presentationsForActivity,
      { activityId },
    );
    expect(presentations.map((row) => row.source.kind).sort()).toEqual([
      "google_slides",
      "rabbit_slides",
    ]);
    const state = await t.query(
      internal.lib.unitDesignerTools.readActivitySlidesDeck,
      { activityId },
    );
    expect(state?.slidesDeck).toContain("Rabbit deck");
    expect(state?.googleSlidesPresentationId).toBe("google-reference");
  });

  test("refuses a workspace principal outside the activity institution", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);
    await expect(
      t.run((ctx) =>
        upsertGoogleSlides(ctx, {
          activityId,
          uploadedBy: teacherId,
          presentationId: "workspace-deck",
          url: "https://docs.google.com/presentation/d/workspace-deck/edit",
          principal: {
            kind: "workspace_bot",
            institutionId: "missing-institution" as Id<"institutions">,
            credentialId: "missing-credential" as Id<"institutionGoogleAccounts">,
          },
        }),
      ),
    ).rejects.toThrow(/credential must belong/i);
  });

  test("accepts only the activity institution's Workspace bot credential", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "Workspace School");
    const teacherId = await seedUser(t, "teacher");
    const { unitId, activityId } = await seedUnitWithLesson(t, teacherId);
    const { workspaceCredentialId, scannerCredentialId } = await t.run(
      async (ctx) => {
        await ctx.db.patch(unitId, { institutionId });
        const workspaceCredentialId = await ctx.db.insert(
          "institutionGoogleAccounts",
          {
            institutionId,
            purpose: "workspace_bot",
            identityType: "google_oauth",
            email: "workspace@example.com",
            scopes: [],
            connectedAt: Date.now(),
          },
        );
        const scannerCredentialId = await ctx.db.insert(
          "institutionGoogleAccounts",
          {
            institutionId,
            identityType: "google_oauth",
            email: "scanner@example.com",
            scopes: [],
            connectedAt: Date.now(),
          },
        );
        return { workspaceCredentialId, scannerCredentialId };
      },
    );

    await expect(
      t.run((ctx) =>
        upsertGoogleSlides(ctx, {
          activityId,
          uploadedBy: teacherId,
          presentationId: "workspace-deck",
          url: "https://docs.google.com/presentation/d/workspace-deck/edit",
          principal: {
            kind: "workspace_bot",
            institutionId,
            credentialId: workspaceCredentialId,
          },
        }),
      ),
    ).resolves.toBeDefined();

    await expect(
      t.run((ctx) =>
        upsertGoogleSlides(ctx, {
          activityId,
          uploadedBy: teacherId,
          presentationId: "scanner-deck",
          url: "https://docs.google.com/presentation/d/scanner-deck/edit",
          principal: {
            kind: "workspace_bot",
            institutionId,
            credentialId: scannerCredentialId,
          },
        }),
      ),
    ).rejects.toThrow(/Workspace bot/i);
  });

  test("returns a typed error when the stored deck is corrupt", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);
    await t.run(async (ctx) => ctx.db.patch(activityId, { slidesDeck: "{not json" }));
    const asTeacher = await withScholar(t, teacherId);

    const result = await asTeacher.mutation(api.activities.saveTeacherSlidesDeck, {
      id: activityId,
      deckJson: JSON.stringify(emptyDeck("Replacement", "sl1")),
      baseRevision: 0,
    });

    expect(result).toEqual({
      ok: false,
      error: "The saved deck is corrupt. Reopen or replace it before editing.",
    });
  });
});

describe("activityCompletions.markComplete", () => {
  test("calling twice with same args produces only one completion record", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);

    const asScholar = await withScholar(t, scholarId);

    const id1 = await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId,
    });
    const id2 = await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId,
    });

    expect(id1).toEqual(id2);

    const allRows = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(allRows.length).toBe(1);
  });

  test("re-marking updates completedAt and note without duplicating", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const { activityId } = await seedUnitWithLesson(t, teacherId);

    const asScholar = await withScholar(t, scholarId);

    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId,
      note: "first note",
    });
    await new Promise((r) => setTimeout(r, 5));
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId,
      note: "second note",
    });

    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("activityCompletions")
        .withIndex("by_scholar_activity", (q) =>
          q.eq("scholarId", scholarId).eq("activityId", activityId),
        )
        .collect(),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].note).toBe("second note");
  });
});

describe("getSessionContext cascade ordering", () => {
  test("activity context appears after lesson context, and lesson is treated as background when activity is anchored", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    const { unitId, lessonId, activityId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Photosynthesis Unit",
        systemPrompt: "Unit-level instructions",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Light Reactions Lesson",
        systemPrompt: "Lesson-level instructions",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Chloroplast Diagram",
        kind: "online",
        systemPrompt: "Activity-level instructions",
        order: 0,
      });
      return { unitId, lessonId, activityId };
    });

    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        title: "Project",
        isArchived: false,
      }),
    );

    const ctxResult = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(ctxResult).not.toBeNull();
    const c = ctxResult!;

    expect(c.unitContext?.title).toBe("Photosynthesis Unit");
    expect(c.lessonContext?.title).toBe("Light Reactions Lesson");
    expect(c.lessonActivityContext?.title).toBe("Chloroplast Diagram");

    const prompt = buildSystemPrompt(
      null,
      null,
      null,
      c.unitContext,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      c.lessonContext,
      null,
      c.lessonActivityContext,
      null,
    );

    const unitIdx = prompt.indexOf('UNIT: "Photosynthesis Unit"');
    const lessonIdx = prompt.indexOf('LESSON: "Light Reactions Lesson"');
    const activityIdx = prompt.indexOf('ACTIVITY: "Chloroplast Diagram"');
    expect(unitIdx).toBeGreaterThanOrEqual(0);
    expect(lessonIdx).toBeGreaterThan(unitIdx);
    expect(activityIdx).toBeGreaterThan(lessonIdx);

    expect(prompt).toContain("Lesson Background (");
    expect(prompt).not.toContain("Lesson Instructions:");
    expect(prompt).toContain(
      "Activity Instructions (PRIMARY — these drive what you do right now):",
    );
    expect(prompt.indexOf("Activity Instructions (PRIMARY"))
      .toBeGreaterThan(prompt.indexOf("Lesson Background ("));
  });
});

describe("buildActivitySection activity-kind instructions", () => {
  test.each([
    {
      kind: "vibecode" as const,
      systemPrompt: "Build a tide-pool simulator that reveals zonation.",
    },
    {
      kind: "online" as const,
      systemPrompt: "Compare the two chloroplast diagrams.",
    },
  ])("renders the authored instructions for $kind activities", ({
    kind,
    systemPrompt,
  }) => {
    const section = buildActivitySection({
      title: "Authored activity",
      description: null,
      kind,
      systemPrompt,
      durationMinutes: null,
      processTitle: null,
      processEmoji: null,
    });

    expect(section).toContain(systemPrompt);
  });

  test("keeps problem-set instructions tied to authored skill labels", () => {
    const section = buildActivitySection({
      title: "Practice activity",
      description: null,
      kind: "problem_set",
      systemPrompt: "This online-style instruction should not render.",
      durationMinutes: null,
      processTitle: null,
      processEmoji: null,
      problemSet: {
        domain: "whole-number-arithmetic",
        targetSkillKeys: ["compare_rates"],
        itemCount: 3,
        targetSkillLabels: ["Compare rates"],
      },
    });

    expect(section).toContain("Compare rates");
    expect(section).not.toContain(
      "This online-style instruction should not render.",
    );
  });
});

describe("problem-set tutor quest context", () => {
  test("threads authored targets into context while only rendering labels in the prompt", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const { sessionId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Practice unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Practice lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Regrouping quest",
        kind: "problem_set",
        order: 0,
        problemSet: {
          domain: "whole-number-arithmetic",
          targetSkillKeys: ["add_2digit_regroup", "add_2digit_no_regroup"],
          itemCount: 4,
        },
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Practice",
        isArchived: false,
      });
      return { sessionId };
    });

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(context?.lessonActivityContext?.problemSet).toMatchObject({
      domain: "whole-number-arithmetic",
      targetSkillKeys: ["add_2digit_regroup", "add_2digit_no_regroup"],
      itemCount: 4,
      targetSkillLabels: [
        "Add two 2-digit numbers with regrouping",
        "Add two 2-digit numbers without regrouping",
      ],
    });
    const section = buildActivitySection(context!.lessonActivityContext);
    // Labels render in the prompt; the raw stored skill key never leaks
    // (a redaction guard, not a wording pin).
    expect(section).toContain("Add two 2-digit numbers with regrouping");
    expect(section).not.toContain("add_2digit_regroup");
    expect(section).toContain("serve_practice_problem");
  });

  test("de-dupes authored targetSkillKeys while preserving order", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const { sessionId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Practice unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Practice lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Regrouping quest",
        kind: "problem_set",
        order: 0,
        problemSet: {
          domain: "whole-number-arithmetic",
          targetSkillKeys: [
            "add_2digit_regroup",
            "add_2digit_no_regroup",
            "add_2digit_regroup",
          ],
          itemCount: 4,
        },
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        activityId,
        title: "Practice",
        isArchived: false,
      });
      return { sessionId };
    });

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(context?.lessonActivityContext?.problemSet).toMatchObject({
      targetSkillKeys: ["add_2digit_regroup", "add_2digit_no_regroup"],
      targetSkillLabels: [
        "Add two 2-digit numbers with regrouping",
        "Add two 2-digit numbers without regrouping",
      ],
    });
  });
});

describe("buildSystemPrompt with no soft selection set", () => {
  test("does not leak unit/lesson/activity sections when project has no anchors", async () => {
    const prompt = buildSystemPrompt(
      null, // teacherWhisper
      null, // readingLevel
      "Kai", // scholarName
      null, // unitContext
      null, // personaContext
      null, // perspectiveContext
      null, // processContext
      null, // processStateData
      null, // artifactData
      null, // dossierContent
      null, // seedsData
      null, // masteryContext
      null, // signalContext
      null, // timingContext
      null, // lessonContext
      null, // teacherDirectives
      null, // lessonActivityContext
      null, // priorActivityContext
    );

    expect(prompt).not.toMatch(/\bUNIT:/);
    expect(prompt).not.toMatch(/\bLESSON:/);
    expect(prompt).not.toMatch(/\bACTIVITY:/);
    expect(prompt).not.toContain("Lesson Background");
    expect(prompt).not.toContain("Lesson Instructions");
    expect(prompt).not.toContain("Activity Instructions");
    expect(prompt).not.toContain("COMPLETED EARLIER IN THIS UNIT");
    expect(prompt).not.toContain("PERSONA:");
    expect(prompt).not.toContain("PERSPECTIVE LENS:");
  });
});

describe("activities.reorderInternal", () => {
  test("rewrites order to match the passed array", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { lessonId } = await seedUnitWithLesson(t, teacherId);

    const ids = await t.run(async (ctx) => {
      const a = await ctx.db.insert("activities", { lessonId, title: "A", kind: "online" as const, order: 1 });
      const b = await ctx.db.insert("activities", { lessonId, title: "B", kind: "online" as const, order: 2 });
      const c = await ctx.db.insert("activities", { lessonId, title: "C", kind: "online" as const, order: 3 });
      return { a, b, c };
    });

    await t.mutation(internal.activities.reorderInternal, {
      activityIds: [ids.c, ids.a, ids.b],
    });

    const after = await t.run(async (ctx) => ({
      a: await ctx.db.get(ids.a),
      b: await ctx.db.get(ids.b),
      c: await ctx.db.get(ids.c),
    }));
    expect(after.c?.order).toBe(0);
    expect(after.a?.order).toBe(1);
    expect(after.b?.order).toBe(2);
  });
});

// ── App designer autosave + code revision history (PR 2) ─────────────────────

async function seedVibecodeBuild(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  appRequest = "A spacecraft that throws boxes to show recoil.",
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "App designer unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "App designer lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Throw It Overboard",
      kind: "vibecode",
      appRequest,
      systemPrompt: "Build the app.",
      order: 0,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: teacherId,
      activityId,
      title: "Throw It Overboard",
      isArchived: false,
      isTestDrive: true,
    });
    const artifactId = await ctx.db.insert("artifacts", {
      sessionId,
      title: "Throw It Overboard",
      content: "<!doctype html><html><body>v0</body></html>",
      lastEditedBy: "ai",
      revision: 0,
      type: "code",
      language: "html",
    });
    return { activityId, sessionId, artifactId };
  });
}

describe("App designer autosave (setVibecodeStarterFromArtifact) idempotency", () => {
  test("re-promoting the same artifact revision is a no-op", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withScholar(t, teacherId);
    const { activityId, artifactId } = await seedVibecodeBuild(t, teacherId);

    const first = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    const second = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );

    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBe(first.updatedAt);

    const apps = await t.run((ctx) => ctx.db.query("customApps").collect());
    expect(apps).toHaveLength(1);
    expect(apps[0].sourceArtifactId).toBe(artifactId);
    expect(apps[0].sourceRevision).toBe(0);
  });

  test("re-promoting with app assets does not leak copied storage blobs (F6)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withScholar(t, teacherId);
    const assetBytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob([assetBytes], { type: "image/jpeg" })),
    );
    const { activityId, artifactId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Asset unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Asset lesson",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Asset app",
        kind: "vibecode",
        appRequest: "x",
        systemPrompt: "Build the app.",
        order: 0,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: teacherId,
        activityId,
        title: "Asset app",
        isArchived: false,
        isTestDrive: true,
        appAssetIds: [storageId],
      });
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId,
        title: "Asset app",
        content: `<!doctype html><html><body><img src="/app-assets/${storageId}"></body></html>`,
        lastEditedBy: "ai",
        revision: 0,
        type: "code",
        language: "html",
      });
      return { activityId, artifactId };
    });

    const storageCount = async () =>
      (await t.run((ctx) => ctx.db.system.query("_storage").collect())).length;

    const before = await storageCount();
    const first = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    const afterFirst = await storageCount();
    // The first promotion copied the one referenced asset into new storage.
    expect(afterFirst).toBe(before + 1);

    const second = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );
    const afterSecond = await storageCount();
    expect(second.id).toBe(first.id);
    expect(second.updatedAt).toBe(first.updatedAt);
    // The no-op re-promotion short-circuited BEFORE copying, so no orphan blob.
    expect(afterSecond).toBe(afterFirst);
  });

  test("a new revision promotes again into the same starter", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withScholar(t, teacherId);
    const { activityId, artifactId } = await seedVibecodeBuild(t, teacherId);

    const first = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );

    await t.run((ctx) =>
      ctx.db.patch(artifactId, {
        content: "<!doctype html><html><body>v1</body></html>",
        revision: 1,
      }),
    );

    const second = await asTeacher.action(
      api.vibecodeStarterActions.setVibecodeStarterFromArtifact,
      { activityId, artifactId },
    );

    expect(second.id).toBe(first.id);
    const apps = await t.run((ctx) => ctx.db.query("customApps").collect());
    expect(apps).toHaveLength(1);
    expect(apps[0].sourceRevision).toBe(1);
    expect(apps[0].html).toContain("v1");
  });
});

describe("codeArtifactRevisions history", () => {
  test("recordTurnRevision records one row per changed turn, idempotently", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { sessionId, artifactId } = await seedVibecodeBuild(t, teacherId);

    const asstMsg1 = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "First cut — spacecraft + recoil",
        flagged: false,
      });
      return ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Built the first cut.",
        flagged: false,
      });
    });

    // Turn 1: no prior app → records revision 0.
    const first = await t.mutation(
      internal.codeArtifactRevisions.recordTurnRevision,
      { sessionId, messageId: asstMsg1, baselineRevision: -1 },
    );
    expect(first.recorded).toBe(true);
    // A re-run with the same baseline is idempotent (no duplicate row).
    await t.mutation(internal.codeArtifactRevisions.recordTurnRevision, {
      sessionId,
      messageId: asstMsg1,
      baselineRevision: -1,
    });

    // Turn 2: the app moves to revision 1 → records again.
    await t.run((ctx) =>
      ctx.db.patch(artifactId, {
        content: "<!doctype html><html><body>v1</body></html>",
        revision: 1,
      }),
    );
    const asstMsg2 = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "Add a mass slider",
        flagged: false,
      });
      return ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Added a mass slider.",
        flagged: false,
      });
    });
    const second = await t.mutation(
      internal.codeArtifactRevisions.recordTurnRevision,
      { sessionId, messageId: asstMsg2, baselineArtifactId: artifactId, baselineRevision: 0 },
    );
    expect(second.recorded).toBe(true);
    // A teacher build session reports its activity for the autosave promotion.
    expect(second.autosaveActivityId).toBeDefined();

    const rows = await t.run((ctx) =>
      ctx.db.query("codeArtifactRevisions").collect(),
    );
    expect(rows).toHaveLength(2);
    // requestText is resolved and STORED at record time (no read-time scan).
    const stored = rows.map((r) => r.requestText).sort();
    expect(stored).toEqual([
      "Add a mass slider",
      "First cut — spacecraft + recoil",
    ]);
  });

  test("listForSession returns metadata only, newest-first with version + thumbnail", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withScholar(t, teacherId);
    const { sessionId, artifactId } = await seedVibecodeBuild(t, teacherId);

    const storageId = await t.run(async (ctx) => {
      const blob = new Blob(["x"], { type: "image/jpeg" });
      return await ctx.storage.store(blob);
    });

    const asstMsg1 = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Built the first cut.",
        flagged: false,
        renderCheck: {
          checkId: "c1",
          requestedAt: Date.now(),
          answeredAt: Date.now(),
          snapshotStorageId: storageId,
        },
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("codeArtifactRevisions", {
        sessionId,
        artifactId,
        revision: 0,
        html: "<!doctype html><html><body>v0</body></html>",
        messageId: asstMsg1,
        requestText: "First cut — spacecraft + recoil",
        createdAt: 1000,
      });
      await ctx.db.insert("codeArtifactRevisions", {
        sessionId,
        artifactId,
        revision: 1,
        html: "<!doctype html><html><body>v1</body></html>",
        requestText: "Add a mass slider",
        createdAt: 2000,
      });
    });

    const list = await asTeacher.query(
      api.codeArtifactRevisions.listForSession,
      { sessionId },
    );
    expect(list).toHaveLength(2);
    // Newest first, dense version numbers (v1 = oldest).
    expect(list[0].revision).toBe(1);
    expect(list[0].version).toBe(2);
    expect(list[0].requestText).toBe("Add a mass slider");
    expect(list[1].revision).toBe(0);
    expect(list[1].version).toBe(1);
    expect(list[1].requestText).toBe("First cut — spacecraft + recoil");
    expect(list[1].snapshotStorageId).toBe(storageId);
    // Metadata only — never the html (F5).
    expect("html" in list[0]).toBe(false);
  });

  test("getRevisionHtml returns the revision html on click", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withScholar(t, teacherId);
    const { sessionId, artifactId } = await seedVibecodeBuild(t, teacherId);

    const revisionId = await t.run((ctx) =>
      ctx.db.insert("codeArtifactRevisions", {
        sessionId,
        artifactId,
        revision: 0,
        html: "<!doctype html><html><body>v0</body></html>",
        createdAt: 1000,
      }),
    );
    const fetched = await asTeacher.query(
      api.codeArtifactRevisions.getRevisionHtml,
      { revisionId },
    );
    expect(fetched?.html).toContain("v0");
    expect(fetched?.revision).toBe(0);
  });

  test("scholarUpdate stamps a restore revision with restoredFromRevision (F13)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const asTeacher = await withScholar(t, teacherId);
    const { artifactId } = await seedVibecodeBuild(t, teacherId);

    await asTeacher.mutation(api.artifacts.scholarUpdate, {
      artifactId,
      content: "<!doctype html><html><body>restored</body></html>",
      baseRevision: 0,
      restoredFromRevision: 0,
    });

    const rows = await t.run((ctx) =>
      ctx.db.query("codeArtifactRevisions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].restoredFromRevision).toBe(0);
    expect(rows[0].revision).toBe(1);
    expect(rows[0].html).toContain("restored");
  });

  test("recording caps a session at the newest 30 revisions (F2)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { sessionId, artifactId } = await seedVibecodeBuild(t, teacherId);

    // Insert 35 revisions through the shared recorder (the cap runs in the
    // same transaction as each insert).
    for (let revision = 0; revision < 35; revision += 1) {
      await t.run((ctx) =>
        insertCodeRevision(ctx, {
          sessionId,
          artifactId,
          revision,
          html: `<!doctype html><html><body>v${revision}</body></html>`,
        }),
      );
    }

    const rows = await t.run((ctx) =>
      ctx.db
        .query("codeArtifactRevisions")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows).toHaveLength(30);
    const kept = rows.map((r) => r.revision).sort((a, b) => a - b);
    // The oldest five (0..4) were dropped; the newest 30 (5..34) remain.
    expect(kept[0]).toBe(5);
    expect(kept[kept.length - 1]).toBe(34);
  });

  test("deleteSessionCascade removes the session's code revisions (F2)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const { sessionId, artifactId } = await seedVibecodeBuild(t, teacherId);

    await t.run((ctx) =>
      ctx.db.insert("codeArtifactRevisions", {
        sessionId,
        artifactId,
        revision: 0,
        html: "<!doctype html><html><body>v0</body></html>",
        createdAt: 1000,
      }),
    );

    await t.run((ctx) => deleteSessionCascade(ctx, {}, sessionId));

    const rows = await t.run((ctx) =>
      ctx.db.query("codeArtifactRevisions").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
