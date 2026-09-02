import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { buildActivitySection, buildSystemPrompt } from "../sessionHelpers";
import type { Doc, Id } from "../_generated/dataModel";
import { emptyDeck } from "../../shared/slidesScene";
import { upsertGoogleSlides } from "../lib/activityPresentationResources";

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
    expect(section).toContain("serve_practice_problem");
    expect(section).toContain("up to 4 short, interactive problems");
    expect(section).toContain("Add two 2-digit numbers with regrouping");
    expect(section).not.toContain("add_2digit_regroup");
    // A problem set permits spaced repetition, but deliberately preserves the
    // canonical inline-practice guard against stacking or worksheet behavior.
    expect(section).toContain("refines the INLINE PRACTICE safety rules");
    expect(section).toContain("does not replace them");
    expect(section).toContain("never stack or chain");
    expect(section).toContain("serve exactly one");
    expect(section).toContain("leave real space for the scholar's thinking");
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

  test("keeps an ordinary online activity section byte-for-byte unchanged", () => {
    expect(
      buildActivitySection({
        title: "Ordinary activity",
        description: null,
        kind: "online",
        systemPrompt: null,
        durationMinutes: null,
        processTitle: null,
        processEmoji: null,
        recipe: null,
        problemSet: null,
      }),
    ).toBe(
      '\n\nACTIVITY: "Ordinary activity" (online)\n\n(This online activity has no explicit instructions yet — fall back to the lesson background and unit context.)',
    );
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
