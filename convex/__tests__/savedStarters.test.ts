/**
 * Questions saved mid-build and follow-ups from a kid's own Quest (TRA-682):
 * which tools each session is offered, the seeds the tools write, and the
 * starters they become ("Things to wonder about").
 */
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { getFunctionName } from "convex/server";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import {
  makeTutorSessionTools,
  type TutorToolSessionState,
} from "../lib/tutorSessionTools";
import {
  PARK_IDEA_TOOL_NAME,
  SAVE_QUESTION_TOOL_NAME,
  makeDesignerTools,
  missionToolOffer,
} from "../lib/designerTools";
import { seedScholarText } from "../lib/seedLabel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

function toolState(): TutorToolSessionState {
  return {
    assistantMsgId: "message",
    fullContent: "",
    lastPersistLength: 0,
    completionHadPreToolText: false,
    rubricHadPreToolText: false,
    completionPreToolClosingIsValid: false,
    rubricPreToolClosingIsValid: false,
    suppressCompletionFollowUp: false,
    activityCompletedThisStream: false,
    pendingCompletionNote: null,
    createdCodeArtifact: false,
  };
}

async function tutorTools(
  isOwnIsUnit: boolean,
  runMutation: ReturnType<typeof vi.fn> = vi.fn(),
) {
  const scholarId = "scholar" as Id<"users">;
  const ctx = {
    runMutation,
    runQuery: () => Promise.resolve(null),
  } as unknown as ActionCtx;
  return await makeTutorSessionTools(ctx, () => {}, {
    session: {
      scholarId,
      sessionMode: "conversation",
      artifactData: null,
      appStateContext: null,
    } as Parameters<typeof makeTutorSessionTools>[2]["session"],
    projId: "session" as Id<"sessions">,
    callerUserId: scholarId,
    state: toolState(),
    splitAfterTool: async () => {},
    hasProcess: false,
    hasRubric: false,
    activityWasAlreadyComplete: false,
    hasConversationCompletion: false,
    hasActivityResources: false,
    hasPhysicalEnv: false,
    isAngleKickoff: false,
    isOwnIsUnit,
    ownIsUnitId: isOwnIsUnit ? ("unit" as Id<"units">) : null,
    instructionPlatform: "web",
    chatPracticeOn: false,
    teachBackOn: false,
  });
}

describe("which tools a session is offered", () => {
  test("a kid's own Quest: no create_lesson or create_activity, and save_follow_up", async () => {
    const names = (await tutorTools(true)).map((tool) => tool.name);
    expect(names).not.toContain("create_lesson");
    expect(names).not.toContain("create_activity");
    expect(names).toContain("save_follow_up");
  });

  test("any other session: no save_follow_up, and still no planning tools", async () => {
    const names = (await tutorTools(false)).map((tool) => tool.name);
    expect(names).not.toContain("save_follow_up");
    expect(names).not.toContain("create_lesson");
    expect(names).not.toContain("create_activity");
  });

  test("save_follow_up writes through the starter mutation as a follow_up", async () => {
    const runMutation = vi.fn().mockResolvedValue("saved");
    const tool = (await tutorTools(true, runMutation)).find(
      (x) => x.name === "save_follow_up",
    )!;
    await tool.run({ text: "Could a crocodile's jaws close at 0°?" } as never);
    expect(getFunctionName(runMutation.mock.calls[0][0])).toBe(
      getFunctionName(internal.sessions.saveStarterFromSession),
    );
    expect(runMutation.mock.calls[0][1]).toMatchObject({
      origin: "follow_up",
      text: "Could a crocodile's jaws close at 0°?",
    });
  });

  test("save_question rides with park_idea: a mission session, never free play", async () => {
    const saveQuestion = vi.fn().mockResolvedValue("saved");
    const offered = await makeDesignerTools({
      offer: missionToolOffer({ hasMission: true, workshopMode: "edit", teacherBuild: false }),
      parkIdea: vi.fn(),
      unparkIdea: vi.fn(),
      saveQuestion,
    });
    const names = offered.map((tool) => tool.name);
    expect(names).toContain(PARK_IDEA_TOOL_NAME);
    expect(names).toContain(SAVE_QUESTION_TOOL_NAME);
    await offered
      .find((tool) => tool.name === SAVE_QUESTION_TOOL_NAME)!
      .run({ text: "Do crocodiles really cry?" } as never);
    expect(saveQuestion).toHaveBeenCalledWith("Do crocodiles really cry?");

    const freePlay = await makeDesignerTools({
      offer: missionToolOffer({
        hasMission: false,
        workshopMode: "edit",
        teacherBuild: false,
        freePlay: true,
      }),
      parkIdea: vi.fn(),
      unparkIdea: vi.fn(),
      saveQuestion,
    });
    expect(freePlay.map((tool) => tool.name)).not.toContain(SAVE_QUESTION_TOOL_NAME);
  });
});

async function setup(t: T) {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Scholar A",
      username: "scholar-a",
      role: "scholar",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Teacher",
      username: "teacher",
      role: "teacher",
    });
    const ownQuest = await ctx.db.insert("units", {
      teacherId,
      title: "Angle croc",
      isActive: true,
      authorScholarId: scholarId,
    });
    const teacherUnit = await ctx.db.insert("units", {
      teacherId,
      title: "Bridges",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId: teacherUnit,
      title: "Spans",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Bridge builder",
      kind: "online",
      order: 0,
    } as Doc<"activities">);
    const questSession = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Planning",
      isArchived: false,
      unitId: ownQuest,
    });
    const buildSession = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Build",
      isArchived: false,
      unitId: teacherUnit,
      activityId,
    });
    return { scholarId, questSession, buildSession };
  });
}

async function as(t: T, userId: Id<"users">) {
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

describe("the seeds the tools write", () => {
  test("a saved question names what the kid was building and reads as their question", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, buildSession, questSession } = await setup(t);
    expect(
      await t.mutation(internal.sessions.saveStarterFromSession, {
        sessionId: buildSession,
        origin: "saved_question",
        text: "  Do crocodiles   really cry? ",
      }),
    ).toBe("saved");
    expect(
      await t.mutation(internal.sessions.saveStarterFromSession, {
        sessionId: questSession,
        origin: "saved_question",
        text: "Why do owls turn their heads so far?",
      }),
    ).toBe("saved");
    // The same question again is the same seed.
    expect(
      await t.mutation(internal.sessions.saveStarterFromSession, {
        sessionId: buildSession,
        origin: "saved_question",
        text: "Do crocodiles really cry?",
      }),
    ).toBe("duplicate");

    const seeds = await t.run((ctx) => ctx.db.query("seeds").collect());
    expect(seeds).toHaveLength(2);
    const cry = seeds.find((seed) => seed.topic === "Do crocodiles really cry?")!;
    expect(cry).toMatchObject({
      scholarId,
      origin: "saved_question",
      status: "active",
      connectionTo: "Bridge builder",
      sessionId: buildSession,
    });
    expect(seedScholarText(cry)).toBe("Do crocodiles really cry?");
    const owl = seeds.find((seed) => seed.topic.startsWith("Why do owls"))!;
    // In their own Quest, it names the Quest.
    expect(owl.connectionTo).toBe("Angle croc");
  });

  test("a follow-up: the kid's own Quest only, one per chat", async () => {
    const t = convexTest(schema, modules);
    const { buildSession, questSession } = await setup(t);
    expect(
      await t.mutation(internal.sessions.saveStarterFromSession, {
        sessionId: buildSession,
        origin: "follow_up",
        text: "What if the bridge had two spans?",
      }),
    ).toBe("notHere");
    expect(
      await t.mutation(internal.sessions.saveStarterFromSession, {
        sessionId: questSession,
        origin: "follow_up",
        text: "Could the jaws snap shut at 0°?",
      }),
    ).toBe("saved");
    expect(
      await t.mutation(internal.sessions.saveStarterFromSession, {
        sessionId: questSession,
        origin: "follow_up",
        text: "Another one?",
      }),
    ).toBe("alreadySaved");

    const seeds = await t.run((ctx) => ctx.db.query("seeds").collect());
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      origin: "follow_up",
      status: "active",
      connectionTo: "Angle croc",
    });
    expect(seedScholarText(seeds[0])).toBe("Could the jaws snap shut at 0°?");
  });

  test("a rehearsal saves nothing", async () => {
    const t = convexTest(schema, modules);
    const { buildSession } = await setup(t);
    await t.run((ctx) => ctx.db.patch(buildSession, { isTestDrive: true }));
    expect(
      await t.mutation(internal.sessions.saveStarterFromSession, {
        sessionId: buildSession,
        origin: "saved_question",
        text: "Do crocodiles really cry?",
      }),
    ).toBe("notHere");
    expect(await t.run((ctx) => ctx.db.query("seeds").collect())).toHaveLength(0);
  });
});

describe("Things to wonder about lists them (TRA-682)", () => {
  test("saved questions and follow-ups are starters with their source and Quest; started ones drop out", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, buildSession, questSession } = await setup(t);
    await t.mutation(internal.sessions.saveStarterFromSession, {
      sessionId: buildSession,
      origin: "saved_question",
      text: "Do crocodiles really cry?",
    });
    await t.mutation(internal.sessions.saveStarterFromSession, {
      sessionId: questSession,
      origin: "follow_up",
      text: "Could the jaws snap shut at 0°?",
    });
    const asScholar = await as(t, scholarId);

    const starters = await asScholar.query(api.questionQueue.startersForSelf, {});
    expect(starters).toEqual([
      expect.objectContaining({
        line: "Could the jaws snap shut at 0°?",
        source: "followUp",
        detail: { questTitle: "Angle croc" },
      }),
      expect.objectContaining({
        line: "Do crocodiles really cry?",
        source: "parked",
        detail: { questTitle: "Bridge builder" },
      }),
    ]);

    // Asking one opens a chat from it: it is no longer something to ask.
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Do crocodiles really cry?",
        isArchived: false,
        seedId: starters[1].seedId,
      }),
    );
    const after = await asScholar.query(api.questionQueue.startersForSelf, {});
    expect(after.map((row) => row.line)).toEqual(["Could the jaws snap shut at 0°?"]);
  });

  test("the kid's own saved questions come before Rabbithole's live ideas", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, buildSession } = await setup(t);
    // A live observer idea (TRA-679), written first so it is the older one.
    await t.run((ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "active",
        suggestionType: "frontier",
        topic: "Tides",
        rationale: "Teacher-only note",
        scholarInvitation: "Why does the sea come in twice a day?",
      }),
    );
    await t.mutation(internal.sessions.saveStarterFromSession, {
      sessionId: buildSession,
      origin: "saved_question",
      text: "Do crocodiles really cry?",
    });

    const starters = await (await as(t, scholarId)).query(
      api.questionQueue.startersForSelf,
      {},
    );
    expect(starters.map((row) => row.source)).toEqual(["parked", "idea"]);
    expect(new Set(starters.map((row) => row.seedId)).size).toBe(starters.length);
  });
});
