// TRA-519 PR3, server half (Lane C1): "Make it a Quest" from a parked idea (B2),
// and learn-before-you-build (B6): the Quest build-step lock on units.get and on
// every session-opening path, plus the badge-moment appendBuildStep.
//
// Fictional names only.
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";

// These tests cover Quest app building, which is OFF in the product
// (shared/missionCopy.ts SCHOLAR_LED_APP_BUILDING) but kept for a revisit, so
// they run with it on. scholarAppBuildingOff.test.ts covers the off state.
vi.mock("../../shared/missionCopy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/missionCopy")>()),
  SCHOLAR_LED_APP_BUILDING: true,
}));

import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
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

describe("the learn-first lock is retired", () => {
  test("a kid's own multi-step Quest opens its later step before the learning step is done", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    const { id } = await as.mutation(api.sessions.create, { activityId: w.buildId });
    const session = await t.run((ctx) => ctx.db.get(id));
    expect(session?.activityId).toBe(w.buildId);
    expect(session?.sessionMode).toBe("vibecode");
  });

  test("a session already on the later step can be messaged", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
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
  });

  test("a teacher's unit and a teacher's rehearsal open as before", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { teacherUnit: true });
    const as = await asUser(t, w.scholarId);
    expect((await as.mutation(api.sessions.create, { activityId: w.buildId })).id).toBeTruthy();
    const asTeacher = await asUser(t, w.teacherId);
    const { id } = await asTeacher.mutation(api.sessions.create, {
      activityId: w.buildId,
      isTestDrive: true,
    });
    expect(id).toBeTruthy();
  });

  test("units.get keeps the old shape: questLocks empty, canUnlockBuild false", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const as = await asUser(t, w.scholarId);
    const unit = await as.query(api.units.get, { id: w.unitId });
    expect(unit?.questLocks).toEqual({});
    expect(unit?.canUnlockBuild).toBe(false);
  });
});

describe("B6: appendBuildStep (the badge moment)", () => {
  test("requires the Quest to be complete", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { withBuild: false });
    const as = await asUser(t, w.scholarId);
    await expect(
      as.mutation(api.quests.appendBuildStep, { unitId: w.unitId }),
    ).rejects.toThrow(/Finish the Quest/);

    await complete(t, w, w.scholarId, w.learnId);
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

describe("BUILD FIRST: getWithMessages' scholarBuildKickoff", () => {
  /** A build-first Quest beside the world's: its only step is the app. */
  async function buildFirstQuest(t: T, w: World) {
    return await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: w.scholarId,
        institutionId: w.institutionId,
        title: "Heron angles",
        isActive: true,
        authorScholarId: w.scholarId,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Build it",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Build a heron angle game",
        order: 0,
        kind: "online",
        appActivity: true,
        deliverable: APP_DELIVERABLE,
      });
      return { unitId, lessonId, activityId };
    });
  }

  async function appSession(
    t: T,
    w: World,
    at: { unitId: Id<"units">; lessonId: Id<"lessons">; activityId: Id<"activities"> },
    overrides: Partial<Doc<"sessions">> = {},
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: w.scholarId,
        institutionId: w.institutionId,
        unitId: at.unitId,
        lessonId: at.lessonId,
        activityId: at.activityId,
        sessionMode: "vibecode",
        title: "Build",
        isArchived: false,
        ...overrides,
      }),
    );
  }

  test("true for the owner of a build-first Quest step, and its kickoff starts", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const first = await buildFirstQuest(t, w);
    const sessionId = await appSession(t, w, first);
    const as = await asUser(t, w.scholarId);
    const data = await as.query(api.sessions.getWithMessages, { id: sessionId });
    expect(data.session.scholarBuildKickoff).toBe(true);
    // Never the teacher-only build hand-off.
    expect(
      Object.prototype.hasOwnProperty.call(data.session, "teacherBuildKickoff"),
    ).toBe(false);
    const kickoff = await as.mutation(api.sessions.startActivityKickoff, {
      sessionId,
    });
    expect(kickoff?.status).toBe("started");

    // A teacher reading the same session never triggers it.
    const asTeacher = await asUser(t, w.teacherId);
    const teacherView = await asTeacher.query(api.sessions.getWithMessages, {
      id: sessionId,
    });
    expect(teacherView.session.scholarBuildKickoff).toBe(false);
  });

  test("false for a B6 build step that follows a learning step", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const sessionId = await appSession(t, w, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.buildId,
    });
    const as = await asUser(t, w.scholarId);
    const data = await as.query(api.sessions.getWithMessages, { id: sessionId });
    expect(data.session.scholarBuildKickoff).toBe(false);
  });

  test("false for an app activity in a teacher's unit", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t, { teacherUnit: true });
    await t.run((ctx) => ctx.db.delete(w.learnId));
    const sessionId = await appSession(t, w, {
      unitId: w.unitId,
      lessonId: w.lessonId,
      activityId: w.buildId,
    });
    const as = await asUser(t, w.scholarId);
    const data = await as.query(api.sessions.getWithMessages, { id: sessionId });
    expect(data.session.scholarBuildKickoff).toBe(false);
  });

  test("false for a test drive", async () => {
    const t = convexTest(schema, modules);
    const w = await questWorld(t);
    const first = await buildFirstQuest(t, w);
    const sessionId = await appSession(t, w, first, { isTestDrive: true });
    const as = await asUser(t, w.scholarId);
    const data = await as.query(api.sessions.getWithMessages, { id: sessionId });
    expect(data.session.scholarBuildKickoff).toBe(false);
  });
});
