import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestRole =
  | "scholar"
  | "teacher"
  | "curriculum_designer"
  | "parent"
  | "platform_admin";

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  name: string,
  slug: string,
  isPrimary = false,
) {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name,
      slug,
      kind: "school",
      isPrimary,
    }),
  );
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: TestRole,
  name: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name,
      username: `${name.toLowerCase().replace(/\W+/g, "-")}-${role}`,
      role,
      institutionId: role === "scholar" ? institutionId : undefined,
    });
    if (institutionId) {
      await ctx.db.insert("memberships", {
        userId,
        role,
        institutionId,
      });
    }
    return userId;
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedCatalogUnit(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  title: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId,
      institutionId,
      title,
      isActive: true,
    }),
  );
}

async function seedIndependentStudy(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  title: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId: scholarId,
      institutionId,
      authorScholarId: scholarId,
      title,
      isActive: true,
    }),
  );
}

async function seedUnitChildren(
  t: ReturnType<typeof convexTest>,
  unitId: Id<"units">,
) {
  return await t.run(async (ctx) => {
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Systems and signals",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Trace the signal",
      kind: "online",
      order: 0,
    });
    return { lessonId, activityId };
  });
}

async function seedTwoInstitutionWorld(t: ReturnType<typeof convexTest>) {
  const moliId = await seedInstitution(t, "Moli School", "moli", true);
  const konaId = await seedInstitution(t, "Kona School", "kona");
  const moliTeacherId = await seedUser(
    t,
    "teacher",
    "Hoku Makani",
    moliId,
  );
  const konaTeacherId = await seedUser(
    t,
    "teacher",
    "Lehua Torres",
    konaId,
  );
  const moliScholarId = await seedUser(
    t,
    "scholar",
    "Avery Stone",
    moliId,
  );
  const konaScholarId = await seedUser(
    t,
    "scholar",
    "Kai Kahale",
    konaId,
  );
  const moliCatalogId = await seedCatalogUnit(
    t,
    moliTeacherId,
    "Moli Systems",
    moliId,
  );
  const konaCatalogId = await seedCatalogUnit(
    t,
    konaTeacherId,
    "Kona Systems",
    konaId,
  );
  const moliStudyId = await seedIndependentStudy(
    t,
    moliScholarId,
    "Moli Study",
    moliId,
  );
  const konaStudyId = await seedIndependentStudy(
    t,
    konaScholarId,
    "Kona Study",
    konaId,
  );
  return {
    moliId,
    konaId,
    moliTeacherId,
    konaTeacherId,
    moliScholarId,
    konaScholarId,
    moliCatalogId,
    konaCatalogId,
    moliStudyId,
    konaStudyId,
  };
}

describe("curriculum institution privacy", () => {
  test("a scholar lists only their institution's catalog units", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const asKonaScholar = await withUser(t, world.konaScholarId);

    const rows = await asKonaScholar.query(api.units.list, {});
    const ids = rows.map((row) => String(row._id));
    expect(ids).toContain(String(world.konaCatalogId));
    expect(ids).not.toContain(String(world.moliCatalogId));
  });

  test("units.get denies foreign catalog and Independent Study units", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const asMoliScholar = await withUser(t, world.moliScholarId);

    await expect(
      asMoliScholar.query(api.units.get, { id: world.konaCatalogId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asMoliScholar.query(api.units.get, { id: world.konaStudyId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asMoliScholar.query(api.units.get, { id: world.moliCatalogId }),
    ).resolves.toMatchObject({ title: "Moli Systems" });
    await expect(
      asMoliScholar.query(api.units.get, { id: world.moliStudyId }),
    ).resolves.toMatchObject({ title: "Moli Study" });
  });

  test("Independent Study access follows the canonical scholar-access roles", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const parentId = await seedUser(t, "parent", "Sloane Kahale");
    const curriculumDesignerId = await seedUser(
      t,
      "curriculum_designer",
      "Kona Curriculum Designer",
      world.konaId,
    );
    await t.run((ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: world.konaScholarId,
        createdBy: world.konaTeacherId,
      }),
    );

    const asParent = await withUser(t, parentId);
    const asKonaTeacher = await withUser(t, world.konaTeacherId);
    const asMoliTeacher = await withUser(t, world.moliTeacherId);
    const asCurriculumDesigner = await withUser(t, curriculumDesignerId);
    await expect(
      asParent.query(api.units.get, { id: world.konaStudyId }),
    ).resolves.toMatchObject({ title: "Kona Study" });
    await expect(
      asKonaTeacher.query(api.units.get, { id: world.konaStudyId }),
    ).resolves.toMatchObject({ title: "Kona Study" });
    await expect(
      asMoliTeacher.query(api.units.get, { id: world.konaStudyId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asCurriculumDesigner.query(api.units.get, {
        id: world.konaStudyId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("duplicate cannot copy a unit outside the caller's access scope", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const asMoliTeacher = await withUser(t, world.moliTeacherId);

    await expect(
      asMoliTeacher.mutation(api.units.duplicate, {
        unitId: world.konaCatalogId,
      }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asMoliTeacher.mutation(api.units.duplicate, {
        unitId: world.konaStudyId,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("legacy unstamped units belong to the primary institution", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const legacyCatalogId = await seedCatalogUnit(
      t,
      world.moliTeacherId,
      "Legacy Catalog",
    );

    const asMoliScholar = await withUser(t, world.moliScholarId);
    const asKonaScholar = await withUser(t, world.konaScholarId);
    const moliRows = await asMoliScholar.query(api.units.list, {});
    const konaRows = await asKonaScholar.query(api.units.list, {});
    expect(moliRows.map((row) => String(row._id))).toContain(
      String(legacyCatalogId),
    );
    expect(konaRows.map((row) => String(row._id))).not.toContain(
      String(legacyCatalogId),
    );
    await expect(
      asMoliScholar.query(api.units.get, { id: legacyCatalogId }),
    ).resolves.toMatchObject({ title: "Legacy Catalog" });
    await expect(
      asKonaScholar.query(api.units.get, { id: legacyCatalogId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("platform admins can read and list every institution", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const adminId = await seedUser(
      t,
      "platform_admin",
      "Avery Platform",
    );
    const asAdmin = await withUser(t, adminId);

    await expect(
      asAdmin.query(api.units.get, { id: world.konaCatalogId }),
    ).resolves.toMatchObject({ title: "Kona Systems" });
    await expect(
      asAdmin.query(api.units.get, { id: world.konaStudyId }),
    ).resolves.toMatchObject({ title: "Kona Study" });

    const listed = await asAdmin.query(api.units.list, {});
    expect(listed.map((row) => String(row._id))).toEqual(
      expect.arrayContaining([
        String(world.moliCatalogId),
        String(world.konaCatalogId),
        String(world.moliStudyId),
        String(world.konaStudyId),
      ]),
    );
    const board = await asAdmin.query(api.units.listScholarAuthored, {});
    expect(board.map((row) => String(row._id))).toEqual(
      expect.arrayContaining([
        String(world.moliStudyId),
        String(world.konaStudyId),
      ]),
    );
  });

  test("lesson and activity reads inherit their parent unit's scope", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const { lessonId, activityId } = await seedUnitChildren(
      t,
      world.moliCatalogId,
    );
    const asMoliTeacher = await withUser(t, world.moliTeacherId);
    const asKonaTeacher = await withUser(t, world.konaTeacherId);
    const asMoliScholar = await withUser(t, world.moliScholarId);

    await expect(
      asMoliTeacher.query(api.lessons.get, { id: lessonId }),
    ).resolves.toMatchObject({ title: "Systems and signals" });
    await expect(
      asMoliTeacher.query(api.activities.get, { id: activityId }),
    ).resolves.toMatchObject({ title: "Trace the signal" });
    await expect(
      asKonaTeacher.query(api.lessons.get, { id: lessonId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asKonaTeacher.query(api.activities.get, { id: activityId }),
    ).rejects.toThrow(/Forbidden/);
    await expect(
      asMoliScholar.query(api.lessons.get, { id: lessonId }),
    ).resolves.toMatchObject({ title: "Systems and signals" });
  });

  test("activity writes require edit access to the lesson's institution", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const { lessonId } = await seedUnitChildren(t, world.moliCatalogId);
    const asMoliTeacher = await withUser(t, world.moliTeacherId);
    const asKonaTeacher = await withUser(t, world.konaTeacherId);

    await expect(
      asMoliTeacher.mutation(api.activities.create, {
        lessonId,
        title: "Authorized activity",
        kind: "offline",
      }),
    ).resolves.toBeTruthy();
    await expect(
      asKonaTeacher.mutation(api.activities.create, {
        lessonId,
        title: "Foreign activity",
        kind: "offline",
      }),
    ).rejects.toThrow(/Forbidden/);

    await expect(
      t.mutation(internal.activities.createCatalogActivityInternal, {
        callerUserId: world.konaTeacherId,
        lessonId,
        title: "Foreign catalog activity",
        kind: "shareBack",
        shareBackRecipe: "reflection",
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("internal activity writes reject callers from a suspended institution", async () => {
    const t = convexTest(schema, modules);
    const world = await seedTwoInstitutionWorld(t);
    const { lessonId } = await seedUnitChildren(t, world.konaCatalogId);
    await t.run((ctx) =>
      ctx.db.patch(world.konaId, { disabledAt: Date.now() }),
    );

    await expect(
      t.mutation(internal.activities.createCatalogActivityInternal, {
        callerUserId: world.konaTeacherId,
        lessonId,
        title: "Suspended school activity",
        kind: "shareBack",
        shareBackRecipe: "reflection",
      }),
    ).rejects.toThrow(/access is paused/i);
  });

  test("legacy single-institution surfaces retain their existing visibility", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(
      t,
      "Moli School",
      "moli",
      true,
    );
    const teacherId = await seedUser(
      t,
      "teacher",
      "Hoku Makani",
      institutionId,
    );
    const scholarId = await seedUser(
      t,
      "scholar",
      "Oliver Stone",
      institutionId,
    );
    const catalogId = await seedCatalogUnit(
      t,
      teacherId,
      "Legacy Catalog",
    );
    const studyId = await seedIndependentStudy(
      t,
      scholarId,
      "Legacy Study",
    );
    const { lessonId, activityId } = await seedUnitChildren(t, catalogId);
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const scholarRows = await asScholar.query(api.units.list, {});
    expect(scholarRows.map((row) => String(row._id))).toEqual(
      expect.arrayContaining([String(catalogId), String(studyId)]),
    );
    const teacherRows = await asTeacher.query(api.units.list, {});
    expect(teacherRows.map((row) => String(row._id))).toEqual(
      expect.arrayContaining([String(catalogId), String(studyId)]),
    );
    const boardRows = await asTeacher.query(
      api.units.listScholarAuthored,
      {},
    );
    expect(boardRows.map((row) => String(row._id))).toContain(
      String(studyId),
    );
    await expect(
      asScholar.query(api.units.get, { id: catalogId }),
    ).resolves.toMatchObject({ title: "Legacy Catalog" });
    await expect(
      asScholar.query(api.units.get, { id: studyId }),
    ).resolves.toMatchObject({ title: "Legacy Study" });
    await expect(
      asTeacher.query(api.lessons.get, { id: lessonId }),
    ).resolves.toBeTruthy();
    await expect(
      asTeacher.query(api.activities.get, { id: activityId }),
    ).resolves.toBeTruthy();
  });

  test("pre-membership staff retain access to the legacy primary catalog", async () => {
    const t = convexTest(schema, modules);
    await seedInstitution(t, "Moli School", "moli", true);
    const teacherId = await seedUser(t, "teacher", "Hoku Makani");
    const catalogId = await seedCatalogUnit(
      t,
      teacherId,
      "Legacy Catalog",
    );
    const { lessonId, activityId } = await seedUnitChildren(t, catalogId);
    const asTeacher = await withUser(t, teacherId);

    const listed = await asTeacher.query(api.units.list, {});
    expect(listed.map((row) => String(row._id))).toContain(
      String(catalogId),
    );
    await expect(
      asTeacher.query(api.units.get, { id: catalogId }),
    ).resolves.toMatchObject({ title: "Legacy Catalog" });
    await expect(
      asTeacher.query(api.lessons.get, { id: lessonId }),
    ).resolves.toBeTruthy();
    await expect(
      asTeacher.query(api.activities.get, { id: activityId }),
    ).resolves.toBeTruthy();
  });
});

describe("unit creation institution stamps", () => {
  test("catalog and Independent Study creation paths stamp their owner institution", async () => {
    const t = convexTest(schema, modules);
    await seedInstitution(t, "Moli School", "moli", true);
    const institutionId = await seedInstitution(
      t,
      "Kona School",
      "kona",
    );
    const teacherId = await seedUser(
      t,
      "teacher",
      "Lehua Torres",
      institutionId,
    );
    const scholarId = await seedUser(
      t,
      "scholar",
      "Kai Kahale",
      institutionId,
    );
    const asTeacher = await withUser(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const catalogId = await asTeacher.mutation(api.units.create, {
      title: "Kona Catalog",
    });
    const duplicateId = await asTeacher.mutation(api.units.duplicate, {
      unitId: catalogId,
    });
    const { unitId: ownStudyId } = await asScholar.mutation(
      api.units.createQuest,
      { title: "My Kona Study" },
    );
    const { unitId: offeredStudyId } = await asTeacher.mutation(
      api.units.createAndOfferQuestForScholar,
      {
        scholarId,
        title: "Offered Kona Study",
      },
    );
    const { unitId: botStudyId } = await t.mutation(
      internal.teacherAide.createScholarQuest,
      {
        scholarId,
        authorId: teacherId,
        title: "Bot Kona Study",
      },
    );
    const { unitId: botCatalogId } = await t.mutation(
      internal.teacherAide.createCurriculumUnit,
      {
        authorId: teacherId,
        title: "Bot Kona Catalog",
      },
    );

    const ids = [
      catalogId,
      duplicateId,
      ownStudyId,
      offeredStudyId,
      botStudyId,
      botCatalogId,
    ];
    const units = await t.run((ctx) =>
      Promise.all(ids.map((id) => ctx.db.get(id))),
    );
    expect(
      units.every(
        (unit): unit is Doc<"units"> =>
          unit !== null && unit.institutionId === institutionId,
      ),
    ).toBe(true);
  });
});
