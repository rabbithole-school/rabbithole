import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

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

describe("shareBack tenancy (TRA-653)", () => {
  // Two schools on one deployment. A Share Back in Albatross must never see,
  // wire, or digest Puffin's curriculum.
  async function seedTwoSchools(t: ReturnType<typeof convexTest>) {
    return await t.run(async (ctx) => {
      const albatross = await ctx.db.insert("institutions", {
        name: "Albatross Academy",
        slug: "albatross",
        kind: "school",
        isPrimary: true,
      });
      const puffin = await ctx.db.insert("institutions", {
        name: "Puffin School",
        slug: "puffin",
        kind: "school",
        isPrimary: false,
      });
      const designer = await ctx.db.insert("users", {
        role: "curriculum_designer",
        name: "Alba Designer",
        username: "alba-designer",
      });
      await ctx.db.insert("memberships", {
        userId: designer,
        role: "curriculum_designer",
        institutionId: albatross,
      });
      const teacher = await ctx.db.insert("users", {
        role: "teacher",
        name: "Alba Teacher",
        username: "alba-teacher",
      });
      await ctx.db.insert("memberships", {
        userId: teacher,
        role: "teacher",
        institutionId: albatross,
      });
      const puffinTeacher = await ctx.db.insert("users", {
        role: "teacher",
        name: "Puffin Teacher",
        username: "puffin-teacher",
      });
      await ctx.db.insert("memberships", {
        userId: puffinTeacher,
        role: "teacher",
        institutionId: puffin,
      });
      const puffinScholar = await ctx.db.insert("users", {
        role: "scholar",
        name: "Puffin Scholar",
        username: "puffin-scholar",
        institutionId: puffin,
      });

      async function unitWith(
        institutionId: Id<"institutions"> | undefined,
        teacherId: Id<"users">,
        title: string,
      ) {
        const unitId = await ctx.db.insert("units", {
          teacherId,
          title,
          isActive: true,
          institutionId,
        });
        const lessonId = await ctx.db.insert("lessons", {
          unitId,
          title: `${title} lesson`,
          order: 0,
        });
        return lessonId;
      }
      const albaLesson = await unitWith(albatross, designer, "Alba Unit");
      const legacyLesson = await unitWith(undefined, designer, "Legacy Unit");
      const puffinLesson = await unitWith(puffin, puffinTeacher, "Puffin Unit");

      const albaSource = await ctx.db.insert("activities", {
        lessonId: albaLesson,
        title: "Alba Essay",
        kind: "online",
        order: 0,
      });
      const legacySource = await ctx.db.insert("activities", {
        lessonId: legacyLesson,
        title: "Legacy Essay",
        kind: "online",
        order: 0,
      });
      const puffinSource = await ctx.db.insert("activities", {
        lessonId: puffinLesson,
        title: "Puffin Secret Essay",
        kind: "online",
        order: 0,
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: puffinScholar,
        title: "P",
        isArchived: false,
        activityId: puffinSource,
      });
      await ctx.db.insert("deliverables", {
        activityId: puffinSource,
        scholarId: puffinScholar,
        sessionId,
        textContent: "Puffin scholar's work.",
        submittedAt: 1000,
      });
      const shareBack = await ctx.db.insert("activities", {
        lessonId: albaLesson,
        title: "Share Back",
        kind: "shareBack",
        order: 1,
        shareBackRecipe: "reflection",
      });
      const puffinShareBack = await ctx.db.insert("activities", {
        lessonId: puffinLesson,
        title: "Puffin Share Back",
        kind: "shareBack",
        order: 1,
        shareBackRecipe: "reflection",
      });
      return {
        designer,
        teacher,
        albaSource,
        legacySource,
        puffinSource,
        shareBack,
        puffinShareBack,
      };
    });
  }

  test("the source picker lists only the Share Back's own school", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    const asDesigner = await withUser(t, s.designer);
    const rows = await asDesigner.query(api.shareBack.listSourceCandidates, {
      shareBackActivityId: s.shareBack,
    });
    expect(rows.map((r) => r.title).sort()).toEqual([
      "Alba Essay",
      "Legacy Essay",
    ]);
  });

  test("another school's Share Back is refused", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    const asDesigner = await withUser(t, s.designer);
    const asTeacher = await withUser(t, s.teacher);
    await expect(
      asDesigner.query(api.shareBack.listSourceCandidates, {
        shareBackActivityId: s.puffinShareBack,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asDesigner.query(api.shareBack.getSources, {
        activityId: s.puffinShareBack,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asDesigner.mutation(api.shareBack.setRecipe, {
        activityId: s.puffinShareBack,
        recipe: "galleryWalk",
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asTeacher.query(api.shareBack.getDigest, {
        activityId: s.puffinShareBack,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("setSources refuses another school's activity", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    const asDesigner = await withUser(t, s.designer);
    await expect(
      asDesigner.mutation(api.shareBack.setSources, {
        activityId: s.shareBack,
        sourceActivityIds: [s.albaSource, s.puffinSource],
      }),
    ).rejects.toThrow(/school/);
    await asDesigner.mutation(api.shareBack.setSources, {
      activityId: s.shareBack,
      sourceActivityIds: [s.albaSource, s.legacySource],
    });
    const row = await t.run((ctx) => ctx.db.get(s.shareBack));
    expect(row?.sourceActivityIds).toEqual([s.albaSource, s.legacySource]);
  });

  test("setSources drops an already-wired cross-school source", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    await t.run((ctx) =>
      ctx.db.patch(s.shareBack, { sourceActivityIds: [s.puffinSource] }),
    );
    const asDesigner = await withUser(t, s.designer);
    // The editor re-sends the wired list plus the new pick.
    await asDesigner.mutation(api.shareBack.setSources, {
      activityId: s.shareBack,
      sourceActivityIds: [s.puffinSource, s.albaSource],
    });
    const row = await t.run((ctx) => ctx.db.get(s.shareBack));
    expect(row?.sourceActivityIds).toEqual([s.albaSource]);
  });

  test("a legacy cross-school source is hidden and never digested", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    await t.run((ctx) =>
      ctx.db.patch(s.shareBack, {
        sourceActivityIds: [s.albaSource, s.puffinSource],
      }),
    );
    const asDesigner = await withUser(t, s.designer);
    const sources = await asDesigner.query(api.shareBack.getSources, {
      activityId: s.shareBack,
    });
    expect(sources.map((r) => r.title)).toEqual(["Alba Essay"]);
    const collated = await t.query(internal.shareBack.collateSources, {
      shareBackActivityId: s.shareBack,
    });
    expect(collated?.perSource.map((p) => p.activityId)).toEqual([
      s.albaSource,
    ]);
    expect(collated?.deliverables).toEqual([]);
  });

  test("a digest built from another school's source is withheld", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(s.shareBack, { sourceActivityIds: [s.puffinSource] });
      await ctx.db.insert("shareBackDigests", {
        activityId: s.shareBack,
        status: "ready",
        summary: "Puffin work",
        sourceSnapshot: [
          {
            activityId: s.puffinSource,
            title: "Puffin Secret Essay",
            deliverableCount: 1,
          },
        ],
      });
    });
    const asTeacher = await withUser(t, s.teacher);
    await expect(
      asTeacher.query(api.shareBack.getDigest, { activityId: s.shareBack }),
    ).resolves.toBeNull();
  });

  test("setSources refuses a scholar's own Quest activity", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    const questActivity = await t.run(async (ctx) => {
      const scholar = await ctx.db.insert("users", {
        role: "scholar",
        name: "Hoku Makani",
        username: "hoku-quest",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId: scholar,
        title: "Hoku's Quest",
        isActive: true,
        authorScholarId: scholar,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Quest lesson",
        order: 0,
      });
      return await ctx.db.insert("activities", {
        lessonId,
        title: "Quest step",
        kind: "online",
        order: 0,
      });
    });
    const asDesigner = await withUser(t, s.designer);
    await expect(
      asDesigner.mutation(api.shareBack.setSources, {
        activityId: s.shareBack,
        sourceActivityIds: [questActivity],
      }),
    ).rejects.toThrow(/school/);
  });

  test("submission counts stop reading at the cap", async () => {
    const t = convexTest(schema, modules);
    const s = await seedTwoSchools(t);
    await t.run(async (ctx) => {
      const scholar = await ctx.db.insert("users", {
        role: "scholar",
        name: "Alba Scholar",
        username: "alba-scholar",
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholar,
        title: "P",
        isArchived: false,
        activityId: s.albaSource,
      });
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("deliverables", {
          activityId: s.albaSource,
          scholarId: scholar,
          sessionId,
          textContent: `work ${i}`,
          submittedAt: i,
        });
      }
    });
    const asDesigner = await withUser(t, s.designer);
    const rows = await asDesigner.query(api.shareBack.listSourceCandidates, {
      shareBackActivityId: s.shareBack,
    });
    const alba = rows.find((r) => r.title === "Alba Essay");
    expect(alba).toMatchObject({
      deliverableCount: 50,
      deliverableCountCapped: true,
    });
  });
});
