// TRA-519 PR3, server half (Lane C1): "Make it a Quest" from a parked idea (B2),
// and learn-before-you-build (B6): the Quest build-step lock on units.get and on
// every session-opening path, plus the badge-moment appendBuildStep.
//
// Fictional names only.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { questBuildLockLabel } from "../../shared/missionCopy";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function asUser(t: T, userId: Id<"users">) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

const LEARN_TITLE = "Work out how herons hunt";
const TEXT_DELIVERABLE = {
  kind: "text" as const,
  prompt: "Write what you worked out.",
  mode: "none" as const,
  criteria: [],
};
const APP_DELIVERABLE = {
  kind: "artifact" as const,
  prompt: "Build it.",
  mode: "none" as const,
  criteria: [],
};

type World = {
  institutionId: Id<"institutions">;
  scholarId: Id<"users">;
  otherScholarId: Id<"users">;
  teacherId: Id<"users">;
  unitId: Id<"units">;
  lessonId: Id<"lessons">;
  learnId: Id<"activities">;
  awayId: Id<"activities">;
  buildId: Id<"activities">;
};

/**
 * A scholar's own Quest: [learning step] -> [away-from-screen step] -> [build
 * step]. The build step's prerequisite is the learning step; the away step must
 * never block.
 */
async function questWorld(
  t: T,
  opts: { withBuild?: boolean; teacherUnit?: boolean } = {},
): Promise<World> {
  const institutionId = await seedTestInstitution(t);
  const scholarId = await seedScholarInInstitution(t, { institutionId });
  const otherScholarId = await seedScholarInInstitution(t, { institutionId });
  const teacherId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Tess",
      username: "tess-teacher",
      role: "teacher",
      institutionId,
    }),
  );
  await grantInstitutionMembership(t, teacherId, institutionId, "teacher");
  const ids = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: opts.teacherUnit ? teacherId : scholarId,
      institutionId,
      title: "Heron migration",
      isActive: true,
      ...(opts.teacherUnit ? {} : { authorScholarId: scholarId }),
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson one",
      order: 0,
    });
    const learnId = await ctx.db.insert("activities", {
      lessonId,
      title: LEARN_TITLE,
      order: 0,
      kind: "online",
      deliverable: TEXT_DELIVERABLE,
    });
    const awayId = await ctx.db.insert("activities", {
      lessonId,
      title: "Watch a heron outside",
      order: 1,
      kind: "offline",
    });
    const buildId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build a heron simulation",
      order: 2,
      kind: "online",
      appActivity: true,
      deliverable: APP_DELIVERABLE,
    });
    if (opts.withBuild === false) await ctx.db.delete(buildId);
    return { unitId, lessonId, learnId, awayId, buildId };
  });
  return {
    institutionId,
    scholarId,
    otherScholarId,
    teacherId,
    ...ids,
  };
}

async function complete(t: T, w: World, scholarId: Id<"users">, activityId: Id<"activities">) {
  await t.run((ctx) =>
    ctx.db.insert("activityCompletions", {
      scholarId,
      activityId,
      unitId: w.unitId,
      lessonId: w.lessonId,
      completedAt: Date.now(),
    }),
  );
}

describe("B6: the Quest build step lock", () => {
  test("opening a locked build step throws the exact lock label", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    await expect(
      as.mutation(api.sessions.create, { activityId: w.buildId }),
    ).rejects.toThrow(questBuildLockLabel(LEARN_TITLE));
    expect(questBuildLockLabel(LEARN_TITLE)).toBe(
      "Unlocks when you finish Work out how herons hunt",
    );
    const opened = await t.run((ctx) => ctx.db.query("sessions").collect());
    expect(opened).toHaveLength(0);
  });

  test("a mismatched client unitId cannot skip the lock: the activity's own unit decides", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    // Another Quest of the same scholar, with nothing locked in it.
    const otherUnitId = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: w.scholarId,
        institutionId: w.institutionId,
        title: "Another quest",
        isActive: true,
        authorScholarId: w.scholarId,
      }),
    );
    const as = await asUser(t, w.scholarId);
    await expect(
      as.mutation(api.sessions.create, {
        unitId: otherUnitId,
        activityId: w.buildId,
      }),
    ).rejects.toThrow(questBuildLockLabel(LEARN_TITLE));
    await expect(
      as.mutation(api.sessions.create, {
        unitId: otherUnitId,
        lessonId: w.lessonId,
        activityId: w.buildId,
      }),
    ).rejects.toThrow(questBuildLockLabel(LEARN_TITLE));
  });

  test("a build step the scholar already started stays open: the lock never takes work away (migration)", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    // Not started yet: locked everywhere (open refused, row locked).
    await expect(
      as.mutation(api.sessions.create, { activityId: w.buildId }),
    ).rejects.toThrow(questBuildLockLabel(LEARN_TITLE));
    const before = await as.query(api.units.get, { id: w.unitId });
    expect(before?.questLocks[String(w.buildId)]).toBeDefined();

    // A build-step session from before the lock existed (prod data at deploy).
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        unitId: w.unitId,
        lessonId: w.lessonId,
        activityId: w.buildId,
        sessionMode: "vibecode",
        title: "Build a heron simulation",
        isArchived: false,
      }),
    );
    await expect(
      as.mutation(api.sessions.sendMessage, { sessionId, message: "make it fly" }),
    ).resolves.toBeTruthy();
    const after = await as.query(api.units.get, { id: w.unitId });
    expect(after?.questLocks[String(w.buildId)]).toBeUndefined();

    // A rehearsal session never counts as the scholar having started it.
    const t2 = convexTest(schema, modules);
    const w2 = await questWorld(t2);
    await t2.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w2.scholarId,
        institutionId: w2.institutionId,
        unitId: w2.unitId,
        lessonId: w2.lessonId,
        activityId: w2.buildId,
        sessionMode: "vibecode",
        title: "Rehearsal",
        isArchived: false,
        isTestDrive: true,
      }),
    );
    const as2 = await asUser(t2, w2.scholarId);
    await expect(
      as2.mutation(api.sessions.create, { activityId: w2.buildId }),
    ).rejects.toThrow(questBuildLockLabel(LEARN_TITLE));
  });

  test("the learning step and the away step are never locked", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    const { id } = await as.mutation(api.sessions.create, {
      activityId: w.learnId,
    });
    expect(id).toBeTruthy();
  });

  test("finishing the learning step unlocks the build step (the away step does not matter)", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    await expect(
      as.mutation(api.sessions.create, { activityId: w.buildId }),
    ).rejects.toThrow(/Unlocks when you finish/);
    await complete(t, w, w.scholarId, w.learnId);
    const { id } = await as.mutation(api.sessions.create, {
      activityId: w.buildId,
    });
    const session = await t.run((ctx) => ctx.db.get(id));
    expect(session?.activityId).toBe(w.buildId);
    expect(session?.sessionMode).toBe("vibecode");
  });

  test("another scholar's completion does not unlock mine", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    await complete(t, w, w.otherScholarId, w.learnId);
    const as = await asUser(t, w.scholarId);
    await expect(
      as.mutation(api.sessions.create, { activityId: w.buildId }),
    ).rejects.toThrow(/Unlocks when you finish/);
  });

  test("a teacher's unit is never locked", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { teacherUnit: true });
    const as = await asUser(t, w.scholarId);
    const { id } = await as.mutation(api.sessions.create, {
      activityId: w.buildId,
    });
    expect(id).toBeTruthy();
  });

  test("a teacher's rehearsal of a Quest build step is never blocked", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const asTeacher = await asUser(t, w.teacherId);
    const { id } = await asTeacher.mutation(api.sessions.create, {
      activityId: w.buildId,
      isTestDrive: true,
    });
    expect(id).toBeTruthy();
  });

  test("units.get reports the lock for the author only, and drops it on completion", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    const locked = await as.query(api.units.get, { id: w.unitId });
    expect(locked?.questLocks).toEqual({
      [String(w.buildId)]: { prerequisiteTitle: LEARN_TITLE, prerequisiteId: String(w.learnId) },
    });
    expect(locked?.canUnlockBuild).toBe(false);

    // Not the author: never locked (a teacher viewing it).
    const asTeacher = await asUser(t, w.teacherId);
    const seen = await asTeacher.query(api.units.get, { id: w.unitId });
    expect(seen?.questLocks).toEqual({});
    expect(seen?.canUnlockBuild).toBe(false);

    await complete(t, w, w.scholarId, w.learnId);
    const open = await as.query(api.units.get, { id: w.unitId });
    expect(open?.questLocks).toEqual({});
  });

  test("units.get on a teacher's unit carries no locks", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { teacherUnit: true });
    const asTeacher = await asUser(t, w.teacherId);
    const unit = await asTeacher.query(api.units.get, { id: w.unitId });
    expect(unit?.questLocks).toEqual({});
    expect(unit?.canUnlockBuild).toBe(false);
  });
});

describe("B6: appendBuildStep (the badge moment)", () => {
  test("requires the Quest to be complete; canUnlockBuild flips true when it is", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { withBuild: false });
    const as = await asUser(t, w.scholarId);
    expect((await as.query(api.units.get, { id: w.unitId }))?.canUnlockBuild).toBe(false);
    await expect(
      as.mutation(api.quests.appendBuildStep, { unitId: w.unitId }),
    ).rejects.toThrow(/Finish the Quest/);

    await complete(t, w, w.scholarId, w.learnId);
    expect((await as.query(api.units.get, { id: w.unitId }))?.canUnlockBuild).toBe(true);
    const { activityId } = await as.mutation(api.quests.appendBuildStep, {
      unitId: w.unitId,
    });
    const built = await t.run((ctx) => ctx.db.get(activityId));
    expect(built).toMatchObject({
      kind: "online",
      appActivity: true,
      title: "Build a simulation of Heron migration",
      // One rule for Quest build steps: graded like any Quest step.
      deliverable: { kind: "artifact", mode: "auto", criteria: [] },
    });
    expect(built?.buildContract).toBeUndefined();
    // Its own lesson, after the Quest's last one.
    expect(built?.lessonId).not.toBe(w.lessonId);
    const buildLesson = await t.run((ctx) => ctx.db.get(built!.lessonId!));
    expect(buildLesson).toMatchObject({ unitId: w.unitId, order: 1 });
    expect(built?.order).toBe(0);
    expect(built?.systemPrompt).toContain("simulation");
    expect(built?.systemPrompt).toContain("Heron migration");
    // Offered once: the Quest now has a build step.
    expect((await as.query(api.units.get, { id: w.unitId }))?.canUnlockBuild).toBe(false);
  });

  test("idempotent: a second call returns the same build step", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { withBuild: false });
    await complete(t, w, w.scholarId, w.learnId);
    const as = await asUser(t, w.scholarId);
    const first = await as.mutation(api.quests.appendBuildStep, { unitId: w.unitId });
    const second = await as.mutation(api.quests.appendBuildStep, { unitId: w.unitId });
    expect(second.activityId).toBe(first.activityId);
    const apps = await t.run(async (ctx) =>
      (await ctx.db.query("activities").collect()).filter(
        (a: Doc<"activities">) => a.appActivity === true,
      ),
    );
    expect(apps).toHaveLength(1);
  });

  test("a Quest that already has a build step returns it", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    const { activityId } = await as.mutation(api.quests.appendBuildStep, {
      unitId: w.unitId,
    });
    expect(activityId).toBe(w.buildId);
  });

  test("author only: another scholar and a teacher are refused", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { withBuild: false });
    await complete(t, w, w.scholarId, w.learnId);
    const asOther = await asUser(t, w.otherScholarId);
    await expect(
      asOther.mutation(api.quests.appendBuildStep, { unitId: w.unitId }),
    ).rejects.toThrow(/Forbidden/);
    const asTeacher = await asUser(t, w.teacherId);
    await expect(
      asTeacher.mutation(api.quests.appendBuildStep, { unitId: w.unitId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("the appended step is open immediately: the learning steps are all done", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { withBuild: false });
    await complete(t, w, w.scholarId, w.learnId);
    const as = await asUser(t, w.scholarId);
    const { activityId } = await as.mutation(api.quests.appendBuildStep, {
      unitId: w.unitId,
    });
    const { id } = await as.mutation(api.sessions.create, { activityId });
    expect(id).toBeTruthy();
  });

  test("a Quest ending in a choice lesson (one option picked) gets an OPEN build step", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { withBuild: false });
    await complete(t, w, w.scholarId, w.learnId);
    // Lesson two: pick 1 of 2. Option A is done, option B never started.
    const { choiceLessonId, optionA, optionB } = await t.run(async (ctx) => {
      const choiceLessonId = await ctx.db.insert("lessons", {
        unitId: w.unitId,
        title: "Pick one",
        order: 1,
        selectionMode: "choice",
        choicePickCount: 1,
      });
      const optionA = await ctx.db.insert("activities", {
        lessonId: choiceLessonId,
        title: "Option A: draw the heron",
        order: 0,
        kind: "online",
        deliverable: TEXT_DELIVERABLE,
      });
      const optionB = await ctx.db.insert("activities", {
        lessonId: choiceLessonId,
        title: "Option B: write about the heron",
        order: 1,
        kind: "online",
        deliverable: TEXT_DELIVERABLE,
      });
      return { choiceLessonId, optionA, optionB };
    });
    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId: w.scholarId,
        activityId: optionA,
        unitId: w.unitId,
        lessonId: choiceLessonId,
        completedAt: Date.now(),
      }),
    );
    const as = await asUser(t, w.scholarId);
    expect((await as.query(api.units.get, { id: w.unitId }))?.canUnlockBuild).toBe(true);
    const { activityId } = await as.mutation(api.quests.appendBuildStep, {
      unitId: w.unitId,
    });
    const built = await t.run((ctx) => ctx.db.get(activityId));
    expect(built?.lessonId).not.toBe(choiceLessonId);
    // Not locked behind the unpicked option B.
    const unit = await as.query(api.units.get, { id: w.unitId });
    expect(unit?.questLocks).toEqual({});
    const { id } = await as.mutation(api.sessions.create, { activityId });
    expect(id).toBeTruthy();
    expect(optionB).toBeTruthy();
  });

  test("an UNsatisfied choice lesson still locks the build step after it", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    // Make the learning step's lesson a pick-1 choice with a second option.
    await t.run(async (ctx) => {
      await ctx.db.patch(w.lessonId, {
        selectionMode: "choice",
        choicePickCount: 1,
      });
    });
    const as = await asUser(t, w.scholarId);
    await expect(
      as.mutation(api.sessions.create, { activityId: w.buildId }),
    ).rejects.toThrow(/Unlocks when you finish/);
  });
});

// ── B2: "Make it a Quest" ────────────────────────────────────────────────

const LOT = [
  { text: "a heron board game", parkedAt: 1 },
  { text: "a podcast about herons", parkedAt: 2, reason: "later" },
];

async function lotSession(
  t: T,
  w: World,
  extra: Partial<Doc<"sessions">> = {},
): Promise<Id<"sessions">> {
  return await t.run((ctx) =>
    ctx.db.insert("sessions", {
      userId: w.scholarId,
      institutionId: w.institutionId,
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.learnId,
      title: LEARN_TITLE,
      isArchived: false,
      parkingLot: LOT,
      ...extra,
    }),
  );
}

describe("sessions.questFromParkedIdea", () => {
  test("plants a parked seed from the idea and stamps questSeedId on the lot entry", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const sessionId = await lotSession(t, w);
    const as = await asUser(t, w.scholarId);
    const { seedId } = await as.mutation(api.sessions.questFromParkedIdea, {
      sessionId,
      text: "a heron board game",
    });
    const seed = await t.run((ctx) => ctx.db.get(seedId));
    expect(seed).toMatchObject({
      scholarId: w.scholarId,
      origin: "parked",
      status: "active",
      suggestionType: "extension",
      topic: "a heron board game",
      scholarInvitation: "a heron board game",
      connectionTo: LEARN_TITLE,
      sessionId,
    });
    expect(seed?.rationale).toBe(
      `Saved for later during '${LEARN_TITLE}'; the scholar chose to make it a Quest.`,
    );
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.parkingLot?.[0]).toMatchObject({
      text: "a heron board game",
      questSeedId: seedId,
    });
    expect(session?.parkingLot?.[1].questSeedId).toBeUndefined();
    expect(session?.parkingLot).toHaveLength(2);
  });

  test("idempotent: the same idea re-opens the same seed, a loose match finds the entry", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const sessionId = await lotSession(t, w);
    const as = await asUser(t, w.scholarId);
    const first = await as.mutation(api.sessions.questFromParkedIdea, {
      sessionId,
      text: "a heron board game",
    });
    const second = await as.mutation(api.sessions.questFromParkedIdea, {
      sessionId,
      text: "A Heron Board Game",
    });
    expect(second.seedId).toBe(first.seedId);
    const seeds = await t.run((ctx) => ctx.db.query("seeds").collect());
    expect(seeds).toHaveLength(1);
  });

  test("a dismissed seed is replaced by a fresh one", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const sessionId = await lotSession(t, w);
    const as = await asUser(t, w.scholarId);
    const first = await as.mutation(api.sessions.questFromParkedIdea, {
      sessionId,
      text: "a heron board game",
    });
    await t.run((ctx) => ctx.db.patch(first.seedId, { status: "dismissed" }));
    const second = await as.mutation(api.sessions.questFromParkedIdea, {
      sessionId,
      text: "a heron board game",
    });
    expect(second.seedId).not.toBe(first.seedId);
  });

  test("an idea that is not in the lot is refused", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const sessionId = await lotSession(t, w);
    const as = await asUser(t, w.scholarId);
    await expect(
      as.mutation(api.sessions.questFromParkedIdea, {
        sessionId,
        text: "a volcano",
      }),
    ).rejects.toThrow(/not saved/);
    expect(await t.run((ctx) => ctx.db.query("seeds").collect())).toHaveLength(0);
  });

  test("owner only: another scholar and a teacher's remote view are refused", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const sessionId = await lotSession(t, w);
    const asOther = await asUser(t, w.otherScholarId);
    await expect(
      asOther.mutation(api.sessions.questFromParkedIdea, {
        sessionId,
        text: "a heron board game",
      }),
    ).rejects.toThrow(/Forbidden/);
    const asTeacher = await asUser(t, w.teacherId);
    await expect(
      asTeacher.mutation(api.sessions.questFromParkedIdea, {
        sessionId,
        text: "a heron board game",
      }),
    ).rejects.toThrow(/Forbidden/);
    expect(await t.run((ctx) => ctx.db.query("seeds").collect())).toHaveLength(0);
  });

  test("a test drive is refused even for its own teacher", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w.teacherId,
        institutionId: w.institutionId,
        unitId: w.unitId,
        activityId: w.learnId,
        title: LEARN_TITLE,
        isArchived: false,
        isTestDrive: true,
        parkingLot: LOT,
      }),
    );
    const asTeacher = await asUser(t, w.teacherId);
    await expect(
      asTeacher.mutation(api.sessions.questFromParkedIdea, {
        sessionId,
        text: "a heron board game",
      }),
    ).rejects.toThrow(/rehearsal/);
  });
});
