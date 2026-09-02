import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { buildShareBackSystemPrompt } from "../shareBackActions";
import { SCHOLAR_PRONOUN_GUIDANCE } from "../lib/scholarPronouns";

/**
 * Coverage for the Share Back backend (convex/shareBack.ts):
 *   - setSources gating (shareBack-kind only, no self-reference)
 *   - setRecipe + setFacilitationFocus gating
 *   - collateSources flattens deliverables across sources + angles +
 *     surfaces recipe + focus to the AI action
 *   - returns null when activity isn't a Share Back
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

test("share-back prompt uses the shared scholar-pronoun fallback", () => {
  expect(buildShareBackSystemPrompt("reflection", null)).toContain(
    SCHOLAR_PRONOUN_GUIDANCE,
  );
});

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" | "curriculum_designer",
  name: string,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", { role, name, username }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedUnitLesson(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson",
      order: 0,
    });
    return { unitId, lessonId };
  });
}

describe("shareBack read gating (curriculum-access)", () => {
  // Regression: getSources + listSourceCandidates were teacherQuery, so a
  // curriculum_designer opening a Share Back activity in the designer hit
  // "Forbidden: teacher or admin role required". They're configuration
  // reads paired with setSources (curriculumMutation), so designers must
  // be able to call them. See the curriculum_designer dashboard fix.
  test("curriculum_designer can read sources + candidates", async () => {
    const t = convexTest(schema, modules);
    const designerId = await seedUser(t, "curriculum_designer", "D", "d");
    const asDesigner = await withUser(t, designerId);
    const { lessonId } = await seedUnitLesson(t, designerId);
    const sb = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Share Back",
        kind: "shareBack",
        order: 0,
        shareBackRecipe: "reflection",
      }),
    );
    // Neither should throw (they did before the gate was loosened).
    await expect(
      asDesigner.query(api.shareBack.getSources, { activityId: sb }),
    ).resolves.toEqual([]);
    await expect(
      asDesigner.query(api.shareBack.listSourceCandidates, {
        shareBackActivityId: sb,
      }),
    ).resolves.toBeInstanceOf(Array);
  });

  test("scholar still cannot read sources (curriculum-access required)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const scholarId = await seedUser(t, "scholar", "S", "s");
    const asScholar = await withUser(t, scholarId);
    const { lessonId } = await seedUnitLesson(t, teacherId);
    const sb = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Share Back",
        kind: "shareBack",
        order: 0,
      }),
    );
    await expect(
      asScholar.query(api.shareBack.getSources, { activityId: sb }),
    ).rejects.toThrow();
  });
});

describe("shareBack.setSources", () => {
  test("refuses to set sources on a non-Share-Back activity", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const asTeacher = await withUser(t, teacherId);
    const { lessonId } = await seedUnitLesson(t, teacherId);
    const online = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Online",
        kind: "online",
        order: 0,
      }),
    );
    const source = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Source",
        kind: "online",
        order: 1,
      }),
    );
    await expect(
      asTeacher.mutation(api.shareBack.setSources, {
        activityId: online,
        sourceActivityIds: [source],
      }),
    ).rejects.toThrow(/Share Back/);
  });

  test("sets sources on a Share Back activity; drops self-reference", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const asTeacher = await withUser(t, teacherId);
    const { lessonId } = await seedUnitLesson(t, teacherId);
    const sb = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Share Back",
        kind: "shareBack",
        order: 0,
        shareBackRecipe: "reflection",
      }),
    );
    const source = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Source",
        kind: "online",
        order: 1,
      }),
    );
    await asTeacher.mutation(api.shareBack.setSources, {
      activityId: sb,
      sourceActivityIds: [source, sb], // self ref must be dropped
    });
    const row = await t.run((ctx) => ctx.db.get(sb));
    expect(row?.sourceActivityIds).toEqual([source]);
  });

  test("empty sources clears the source list", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const asTeacher = await withUser(t, teacherId);
    const { lessonId } = await seedUnitLesson(t, teacherId);
    const sb = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "SB",
        kind: "shareBack",
        order: 0,
        shareBackRecipe: "reflection",
      }),
    );
    const source = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Source",
        kind: "online",
        order: 1,
      }),
    );
    await asTeacher.mutation(api.shareBack.setSources, {
      activityId: sb,
      sourceActivityIds: [source],
    });
    await asTeacher.mutation(api.shareBack.setSources, {
      activityId: sb,
      sourceActivityIds: [],
    });
    const row = await t.run((ctx) => ctx.db.get(sb));
    expect(row?.sourceActivityIds).toEqual([]);
  });
});

describe("shareBack.setRecipe + setFacilitationFocus", () => {
  test("setRecipe rejects non-Share-Back activities", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const asTeacher = await withUser(t, teacherId);
    const { lessonId } = await seedUnitLesson(t, teacherId);
    const online = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Online",
        kind: "online",
        order: 0,
      }),
    );
    await expect(
      asTeacher.mutation(api.shareBack.setRecipe, {
        activityId: online,
        recipe: "galleryWalk",
      }),
    ).rejects.toThrow(/Share Back/);
  });

  test("setRecipe + setFacilitationFocus persist on a Share Back", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const asTeacher = await withUser(t, teacherId);
    const { lessonId } = await seedUnitLesson(t, teacherId);
    const sb = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "SB",
        kind: "shareBack",
        order: 0,
        shareBackRecipe: "reflection",
      }),
    );
    await asTeacher.mutation(api.shareBack.setRecipe, {
      activityId: sb,
      recipe: "exitTicket",
    });
    await asTeacher.mutation(api.shareBack.setFacilitationFocus, {
      activityId: sb,
      facilitationFocus: "  surface confusions about denominators  ",
    });
    const row = await t.run((ctx) => ctx.db.get(sb));
    expect(row?.shareBackRecipe).toBe("exitTicket");
    expect(row?.facilitationFocus).toBe("surface confusions about denominators");

    // Empty string clears.
    await asTeacher.mutation(api.shareBack.setFacilitationFocus, {
      activityId: sb,
      facilitationFocus: "   ",
    });
    const row2 = await t.run((ctx) => ctx.db.get(sb));
    expect(row2?.facilitationFocus).toBeUndefined();
  });
});

describe("shareBack.collateSources", () => {
  test("flattens deliverables across sources, joins scholar + angle + recipe + focus", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const kai = await seedUser(t, "scholar", "Kai", "kai");
    const { lessonId } = await seedUnitLesson(t, teacherId);

    const source = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Weekend News",
        kind: "online",
        order: 0,
        hasScholarAngles: true,
      }),
    );
    const sb = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Share Back",
        kind: "shareBack",
        order: 1,
        shareBackRecipe: "galleryWalk",
        sourceActivityIds: [source],
        facilitationFocus: "Every scholar gets the spotlight.",
      }),
    );
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: kai,
        title: "P",
        isArchived: false,
        activityId: source,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("deliverables", {
        activityId: source,
        scholarId: kai,
        sessionId,
        textContent: "My weekend story about the dog.",
        submittedAt: 1000,
        overall: "full",
        rubricPassed: true,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("scholarActivityAngles", {
        scholarId: kai,
        activityId: source,
        title: "Pets",
        description: "writing about animals",
        setAt: 900,
        setBy: "scholar",
      }),
    );

    const collated = await t.run((ctx) =>
      ctx.runQuery(internal.shareBack.collateSources, {
        shareBackActivityId: sb,
      }),
    );
    expect(collated).not.toBeNull();
    expect(collated!.deliverables).toHaveLength(1);
    const d = collated!.deliverables[0];
    expect(d.scholarName).toBe("Kai");
    expect(d.sourceActivityTitle).toBe("Weekend News");
    expect(d.angleTitle).toBe("Pets");
    expect(d.content).toContain("dog");
    expect(d.contentKind).toBe("text");
    expect(collated!.perSource[0].deliverableCount).toBe(1);
    // Recipe + focus surface to the AI action.
    expect(collated!.shareBackRecipe).toBe("galleryWalk");
    expect(collated!.facilitationFocus).toBe("Every scholar gets the spotlight.");
  });

  test("returns null when activity is not a Share Back", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const { lessonId } = await seedUnitLesson(t, teacherId);
    const plain = await t.run((ctx) =>
      ctx.db.insert("activities", {
        lessonId,
        title: "Plain offline",
        kind: "offline",
        order: 0,
      }),
    );
    const collated = await t.run((ctx) =>
      ctx.runQuery(internal.shareBack.collateSources, {
        shareBackActivityId: plain,
      }),
    );
    expect(collated).toBeNull();
  });
});
