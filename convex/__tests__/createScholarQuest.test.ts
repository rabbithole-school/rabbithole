import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isNotStartedISUnit } from "../units";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  overrides: {
    name?: string;
    username?: string;
    institutionId?: Id<"institutions">;
  } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}${Math.random()}`,
      role,
      ...(overrides.institutionId ? { institutionId: overrides.institutionId } : {}),
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
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

async function seedInstitution(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli School",
      slug: `moli-${Math.random()}`,
      kind: "school",
      isPrimary: true,
    }),
  );
}

async function grantTeacherMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", {
      userId,
      role: "teacher",
      institutionId,
    }),
  );
}

describe("teacherAide.createScholarQuest — Curriculum Bot IS unit", () => {
  test("creates an Independent Study unit owned by the scholar", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");

    const { unitId, existed } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: teacherId,
        title: "SpaceX & the IPO Question",
        emoji: "🚀",
      }),
    );
    expect(existed).toBe(false);

    const unit = await t.run(async (ctx) => ctx.db.get(unitId));
    // The two invariants that make it surface for the scholar:
    expect(unit?.authorScholarId).toBe(scholarId);
    expect(unit?.teacherId).toBe(scholarId);
    expect(unit?.isActive).toBe(true);
    expect(unit?.emoji).toBe("🚀");
    // Same shape as units.createAndOfferQuestForScholar — earns a badge.
    expect(unit?.badgeOnCompletion?.title).toContain("SpaceX & the IPO Question");
  });

  test("is idempotent by (scholar, title) — no duplicate", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");

    const first = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: teacherId,
        title: "Word Detective",
      }),
    );
    const second = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: teacherId,
        title: "  word detective  ", // case + whitespace insensitive
      }),
    );
    expect(second.existed).toBe(true);
    expect(second.unitId).toBe(first.unitId);

    const mine = await t.run(async (ctx) =>
      ctx.db
        .query("units")
        .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
        .collect(),
    );
    expect(mine).toHaveLength(1);
  });

  test("the same title for two scholars makes two distinct units", async () => {
    const t = convexTest(schema, modules);
    const a = await seedUser(t, "scholar");
    const b = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");

    const ua = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId: a,
        authorId: teacherId,
        title: "Fractions Deep Dive",
      }),
    );
    const ub = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId: b,
        authorId: teacherId,
        title: "Fractions Deep Dive",
      }),
    );
    expect(ua.unitId).not.toBe(ub.unitId);
  });
});

describe("units.myIndependentStudyUnits — home surfacing", () => {
  test("uses the baked lesson title for a standalone Custom Quest card", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);
    const { unitId } = await asScholar.mutation(
      api.units.createQuest,
      { title: "why are ferns so old" },
    );
    await t.run(async (ctx) => {
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Cracking the Fern's Survival Code",
        order: 0,
      });
      await ctx.db.insert("activities", {
        lessonId,
        title: "No Flowers, No Seeds",
        kind: "online",
        order: 0,
      });
    });

    const cards = await asScholar.query(api.units.myIndependentStudyUnits, {});

    expect(cards).toHaveLength(1);
    expect(cards[0].title).toBe("Cracking the Fern's Survival Code");
  });

  test("surfaces a freshly-created bot unit; hasStartedSession flips once a project exists", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);

    const { unitId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: teacherId,
        title: "SpaceX & the IPO Question",
        emoji: "🚀",
      }),
    );

    // Before any project: it shows on the home, not-yet-started.
    let mine = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(mine).toHaveLength(1);
    expect(mine[0].unitId).toBe(unitId);
    expect(mine[0].hasStartedSession).toBe(false);

    // Once the scholar has a (non-archived) project anchored to the unit,
    // the plate represents it — so the standalone card stands down.
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        title: "Shares & Equity",
        isArchived: false,
      }),
    );
    mine = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(mine[0].hasStartedSession).toBe(true);
  });

  test("multi-activity IS unit stands down when the plate has a continuation", async () => {
    // SF1 regression: a multi-activity IS unit must NOT vanish from the
    // home when the scholar finishes activity 1 (its project becomes
    // "activity complete", so scholarPlate.activeForMe drops it) while
    // activities 2..N still remain. hasStartedSession must reflect
    // "in-progress (plate-visible)" — completed projects don't count —
    // so the standalone card resurfaces instead of leaving NEITHER a
    // plate row NOR a card.
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");
    const asScholar = await withUser(t, scholarId);

    const { unitId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: teacherId,
        title: "Tide Pools — Three Visits",
        emoji: "🌊",
      }),
    );

    // An online activity followed by a Simulator under one lesson.
    const { activity1, session } = await t.run(async (ctx) => {
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Field Notes",
        order: 0,
      });
      const activity1 = await ctx.db.insert("activities", {
        lessonId,
        title: "Visit 1",
        kind: "online",
        order: 0,
      });
      await ctx.db.insert("activities", {
        lessonId,
        title: "Visit 2",
        kind: "simulator",
        order: 1,
      });
      // The scholar started a project anchored to activity 1.
      const session = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        activityId: activity1,
        title: "Visit 1",
        isArchived: false,
      });
      return { activity1, session };
    });

    // Sanity: with activity 1 NOT yet complete, the project is in-progress
    // (the plate represents it) so the standalone card stands down.
    let mine = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(mine).toHaveLength(1);
    expect(mine[0].hasStartedSession).toBe(true);

    // Scholar finishes activity 1. Its project is now "activity complete",
    // but scholarPlate emits a continuation row for activity 2, so the
    // standalone card keeps standing down.
    await t.run(async (ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId: activity1,
        unitId,
        sessionId: session,
        completedAt: Date.now(),
      }),
    );

    mine = await asScholar.query(api.units.myIndependentStudyUnits, {});
    expect(mine).toHaveLength(1);
    expect(mine[0].hasStartedSession).toBe(true);
    // Partial progress still reflects the unit state.
    expect(mine[0].completedCount).toBe(1);
    expect(mine[0].onlineActivityCount).toBe(2);
  });

  test("an anchorless seed-quest session anchors its baked unit — no dual-listing (J8a)", async () => {
    // pilot9 J8a regression: a quest started from a TOPIC seed spawns an
    // ANCHORLESS session (seedId set, unitId null). The background bake creates
    // a scholar unit stamped with `bakedFromSeedId` but may never back-patch the
    // session's unitId (empty/failed bake). A dedup keyed on `session.unitId`
    // alone then double-lists the quest: an in-progress "Continue" card (the
    // anchorless session, via scholarPlate) AND a "not started / Start" card
    // (this baked unit). The seed→session/seed→unit identity must collapse them.
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholarId);

    // A topic seed the scholar saved / flew to.
    const seedId = await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "story",
        status: "active",
        topic: "Scale of the universe",
        domain: "General",
        suggestionType: "leap",
        rationale: "a starred keepsake",
      }),
    );

    // The bake created a scholar unit stamped with bakedFromSeedId — but left it
    // EMPTY (no online activity) and never stamped the seed's unitId nor linked
    // the session (the exact pilot failure).
    const { unitId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: scholarId,
        title: "Scale of the universe",
        bakedFromSeedId: seedId,
      }),
    );

    // Before the scholar flies to it, it's a legit not-started card.
    let cards = await asScholar.query(api.units.myIndependentStudyUnits, {});
    let card = cards.find((c) => c.unitId === unitId);
    expect(card).toBeTruthy();
    expect(card!.hasStartedSession).toBe(false);
    expect(isNotStartedISUnit(card!)).toBe(true);

    // The started quest is an ANCHORLESS session (seedId set, unitId null).
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Scale of the universe",
        isArchived: false,
        seedId,
        lastMessageAt: Date.now(),
      }),
    );

    // Now the anchorless session anchors its baked unit via bakedFromSeedId, so
    // the unit no longer double-renders as a second not-started card.
    cards = await asScholar.query(api.units.myIndependentStudyUnits, {});
    card = cards.find((c) => c.unitId === unitId);
    expect(card).toBeTruthy();
    expect(card!.hasStartedSession).toBe(true);
    expect(isNotStartedISUnit(card!)).toBe(false);
  });

  test("is private to its scholar — another scholar sees none", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "scholar");
    const other = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId: owner,
        authorId: teacherId,
        title: "Private Study",
      }),
    );

    const asOther = await withUser(t, other);
    const theirs = await asOther.query(api.units.myIndependentStudyUnits, {});
    expect(theirs).toHaveLength(0);
  });

  test("teacher remote mode can read a scholar's standalone IS cards", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const scholarId = await seedUser(t, "scholar", { institutionId });
    const teacherId = await seedUser(t, "teacher");
    await grantTeacherMembership(t, teacherId, institutionId);

    const { unitId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: teacherId,
        title: "Remote Visible Study",
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    const cards = await asTeacher.query(api.units.myIndependentStudyUnits, {
      userId: scholarId,
    });
    expect(cards.map((card) => card.unitId)).toEqual([unitId]);
  });

  test("a scholar cannot pass another scholar's userId", async () => {
    const t = convexTest(schema, modules);
    const owner = await seedUser(t, "scholar");
    const other = await seedUser(t, "scholar");
    const teacherId = await seedUser(t, "teacher");

    await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId: owner,
        authorId: teacherId,
        title: "Not Yours",
      }),
    );

    const asOther = await withUser(t, other);
    await expect(
      asOther.query(api.units.myIndependentStudyUnits, { userId: owner }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("units.aideDeleteEmptyUnit — the aide's self-undo", () => {
  // Reproduces the prod incident this tool exists for (2026-07-31): the aide
  // mis-scoped a cohort unit to a single scholar with create_scholar_quest,
  // realized one turn later, and had no way to take it back — so the stray
  // Quest sat on a real child's board. The undo must clear it completely.
  async function scholarUnitWithTeacher() {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const scholarId = await seedUser(t, "scholar", { institutionId });
    const teacherId = await seedUser(t, "teacher", { institutionId });
    await grantTeacherMembership(t, teacherId, institutionId);
    const { unitId } = await t.run(async (ctx) =>
      ctx.runMutation(internal.teacherAide.createScholarQuest, {
        scholarId,
        authorId: teacherId,
        title: "Introduction to Microbiology (Part 1)",
      }),
    );
    return { t, institutionId, scholarId, teacherId, unitId };
  }

  test("deletes an empty scholar-owned unit, clearing it off the Quests board", async () => {
    const { t, scholarId, teacherId, unitId } = await scholarUnitWithTeacher();

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
        callerUserId: teacherId,
        unitId,
      }),
    );
    expect(res.deleted).toBe(true);
    expect(res.wasScholarOwned).toBe(true);

    expect(await t.run(async (ctx) => ctx.db.get(unitId))).toBeNull();
    // The board reads by_authorScholar — the scholar must have nothing left.
    const stillMine = await t.run(async (ctx) =>
      ctx.db
        .query("units")
        .withIndex("by_authorScholar", (q) => q.eq("authorScholarId", scholarId))
        .collect(),
    );
    expect(stillMine).toHaveLength(0);
  });

  test("refuses a unit that has a lesson — archive, don't cascade", async () => {
    const { t, teacherId, unitId } = await scholarUnitWithTeacher();
    await t.run(async (ctx) =>
      ctx.db.insert("lessons", { unitId, title: "Life is made of cells", order: 0 }),
    );

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
          callerUserId: teacherId,
          unitId,
        }),
      ),
    ).rejects.toThrow(/Not empty.*lesson/);
    expect(await t.run(async (ctx) => ctx.db.get(unitId))).not.toBeNull();
  });

  test("refuses a unit a scholar has already worked in", async () => {
    const { t, scholarId, teacherId, unitId } = await scholarUnitWithTeacher();
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        title: "Microbes",
        isArchived: false,
      }),
    );

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
          callerUserId: teacherId,
          unitId,
        }),
      ),
    ).rejects.toThrow(/Not empty.*session/);
    expect(await t.run(async (ctx) => ctx.db.get(unitId))).not.toBeNull();
  });

  test("refuses a quest that was OFFERED — a seed would be left dangling", async () => {
    const { t, scholarId, teacherId, unitId } = await scholarUnitWithTeacher();
    // What `createAndOfferQuestForScholar` plants: a destination star on
    // the scholar's Sky pointing at the unit. Deleting past it would strand
    // a broken star, so `retract` (which dismisses the seed) is the only
    // correct way back.
    await t.run(async (ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        unitId,
        origin: "teacher",
        status: "active",
        suggestionType: "teacher_suggestion",
        topic: "Introduction to Microbiology (Part 1)",
        rationale: "A quest your teacher set up for you.",
      }),
    );

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
          callerUserId: teacherId,
          unitId,
        }),
      ),
    ).rejects.toThrow(/Not empty.*offer seed.*Retract the quest/);
    expect(await t.run(async (ctx) => ctx.db.get(unitId))).not.toBeNull();
  });

  test("refuses a unit that has been assigned to a cohort", async () => {
    const { t, teacherId, unitId } = await scholarUnitWithTeacher();
    await t.run(async (ctx) =>
      ctx.db.insert("assignments", {
        unitId,
        teacherId,
        title: "Microbiology",
        scholarIds: [],
        startedAt: Date.now(),
      }),
    );

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
          callerUserId: teacherId,
          unitId,
        }),
      ),
    ).rejects.toThrow(/Not empty.*assignment/);
  });

  test("a curriculum designer cannot reach into a scholar's Quests board", async () => {
    // The invariant behind handing this destructive tool to the whole
    // curriculum-design set: a designer may undo their own general unit but
    // never delete a unit belonging to a scholar.
    const { t, institutionId, unitId } = await scholarUnitWithTeacher();
    const designerId = await seedUser(t, "teacher", { institutionId });
    await t.run(async (ctx) => {
      await ctx.db.patch(designerId, { role: "curriculum_designer" });
      await ctx.db.insert("memberships", {
        userId: designerId,
        role: "curriculum_designer",
        institutionId,
      });
    });

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
          callerUserId: designerId,
          unitId,
        }),
      ),
    ).rejects.toThrow(/Forbidden/);
    expect(await t.run(async (ctx) => ctx.db.get(unitId))).not.toBeNull();
  });

  test("deletes an empty GENERAL unit and its unit-scoped bot thread", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const teacherId = await seedUser(t, "teacher", { institutionId });
    await grantTeacherMembership(t, teacherId, institutionId);
    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId,
        institutionId,
        title: "Introduction to Microbiology, Part 1",
        isActive: true,
      }),
    );
    const chatId = await t.run(async (ctx) =>
      ctx.db.insert("chats", {
        teacherId,
        unitId,
        title: "Unit bot",
        pinned: false,
        lastMessageAt: Date.now(),
      }),
    );

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
        callerUserId: teacherId,
        unitId,
      }),
    );
    expect(res.wasScholarOwned).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.get(unitId))).toBeNull();
    // No dangling unitId left behind.
    expect(await t.run(async (ctx) => ctx.db.get(chatId))).toBeNull();
  });

  test("a teacher from another institution cannot delete the unit", async () => {
    const { t, unitId } = await scholarUnitWithTeacher();
    const otherInstitutionId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Other School",
        slug: `other-${Math.random()}`,
        kind: "school",
      }),
    );
    const outsiderId = await seedUser(t, "teacher", {
      institutionId: otherInstitutionId,
    });
    await t.run(async (ctx) =>
      ctx.db.insert("memberships", {
        userId: outsiderId,
        role: "teacher",
        institutionId: otherInstitutionId,
      }),
    );

    await expect(
      t.run(async (ctx) =>
        ctx.runMutation(internal.units.aideDeleteEmptyUnit, {
          callerUserId: outsiderId,
          unitId,
        }),
      ),
    ).rejects.toThrow(/Forbidden/);
    expect(await t.run(async (ctx) => ctx.db.get(unitId))).not.toBeNull();
  });
});
