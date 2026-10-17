// TRA-519 B1/B5/B6: the session's MISSION reaching the tutor. Which sessions
// get the tutor-stance MISSION section (and the parking lot), which steer by
// it in the builder's lead-in instead, and which get neither; the Quest
// mission line and planning text; and the Quest learning step that unlocks a
// build. Presence and absence only, never the wording.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  buildSideAppSection,
  buildTutorMissionSteering,
  buildVibecodeSection,
  designerContractFor,
  type DesignerBuildContract,
} from "../prompts";
import { buildTutorSystemPromptParts } from "../sessionStreamHelpers";
import { DEFAULT_APP_GATE, type SessionMission } from "../lib/mission";
import { PARK_IDEA_TOOL_NAME } from "../lib/designerTools";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

const TEXT_DELIVERABLE = {
  kind: "text" as const,
  prompt: "Write the story of the wave.",
  mode: "none" as const,
  criteria: [],
};
const LOT = [{ text: "IDEA-flappy-volcano", parkedAt: 1 }];

const MISSION: SessionMission = {
  source: "default",
  gate: "GATE-first-draft-exists",
  freedoms: [],
  invariants: [],
  questLine: null,
  ownQuest: false,
  unlocksBuild: null,
  buildStepOpen: false,
};

// ── Pure renderers ────────────────────────────────────────────────────────

describe("buildTutorMissionSteering", () => {
  test("renders the gate and each freedom, with a fallback when none", () => {
    const authored = buildTutorMissionSteering({
      ...MISSION,
      source: "authored",
      freedoms: ["FREE-which-moment", "FREE-funny-or-serious"],
    });
    for (const piece of ["GATE-first-draft-exists", "FREE-which-moment", "FREE-funny-or-serious"]) {
      expect(authored).toContain(piece);
    }
    const fallback = buildTutorMissionSteering(MISSION);
    expect(fallback).toContain("GATE-first-draft-exists");
    expect(fallback).not.toContain("FREE-");
    expect(fallback).toContain(PARK_IDEA_TOOL_NAME);
  });

  test("the SIDE APP section: three distinct variants; the locked one names the build step", () => {
    const plain = buildSideAppSection("text");
    const withMission = buildSideAppSection("text", { hasMission: true });
    const locked = buildSideAppSection("text", {
      hasMission: true,
      lockedBuild: "BUILD-step-title",
    });
    expect(new Set([plain, withMission, locked]).size).toBe(3);
    expect(locked).toContain("BUILD-step-title");
    expect(withMission).not.toContain("BUILD-step-title");
    expect(withMission).toContain("MISSION");
  });

  test("names the build it unlocks only for a Quest learning step", () => {
    expect(buildTutorMissionSteering(MISSION)).not.toContain("BUILD-step-title");
    expect(
      buildTutorMissionSteering({ ...MISSION, unlocksBuild: "BUILD-step-title" }),
    ).toContain("BUILD-step-title");
  });
});

describe("the builder steers by the mission", () => {
  const AUTHORED: DesignerBuildContract = {
    invariants: ["INV-oxygen-falls"],
    freedoms: ["FREE-fish-look"],
  };

  test("an authored contract is used verbatim; otherwise the mission's gate with no MUST BE TRUE items", () => {
    expect(
      designerContractFor({ ...MISSION, source: "authored", gate: DEFAULT_APP_GATE }, AUTHORED),
    ).toBe(AUTHORED);
    expect(designerContractFor(null, AUTHORED)).toBe(AUTHORED);
    expect(designerContractFor(null, null)).toBeNull();
    expect(designerContractFor({ ...MISSION, source: "quest" }, null)).toEqual({
      invariants: [],
      freedoms: [],
      gate: "GATE-first-draft-exists",
    });
  });

  test("a mission with no invariants renders no MUST BE TRUE block, and still parks", () => {
    const quest = buildVibecodeSection({ mission: { ...MISSION, source: "quest" } });
    expect(quest).toContain("GATE-first-draft-exists");
    expect(quest).not.toContain("MUST BE TRUE");
    expect(quest).toContain(PARK_IDEA_TOOL_NAME);
    // The authored contract path is unchanged by a mission that resolves to it.
    expect(
      buildVibecodeSection({
        buildContract: AUTHORED,
        mission: { ...MISSION, source: "authored", invariants: AUTHORED.invariants },
      }),
    ).toBe(buildVibecodeSection({ buildContract: AUTHORED }));
  });
});

// ── Which sessions get it (getSessionContext → the assembled prompt) ─────

async function seedScholar(t: T) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Kai Test",
      username: `mission-${crypto.randomUUID()}`,
      role: "scholar",
    }),
  );
}

/** A unit with one lesson whose activities are inserted in order. */
async function seedUnit(
  t: T,
  scholarId: Id<"users">,
  activities: Array<Partial<Doc<"activities">> & { title: string; kind: Doc<"activities">["kind"] }>,
  unit: { quest?: boolean; mission?: { text: string; gate?: string } } = {},
) {
  return await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      title: "Waves",
      isActive: true,
      ...(unit.quest ? { authorScholarId: scholarId } : {}),
      ...(unit.mission ? { mission: { ...unit.mission, setAt: 1 } } : {}),
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "How waves move",
      order: 0,
    });
    const activityIds: Id<"activities">[] = [];
    for (const [order, a] of activities.entries()) {
      activityIds.push(
        await ctx.db.insert("activities", {
          lessonId,
          systemPrompt: "Do the activity.",
          order,
          ...a,
        }),
      );
    }
    return { unitId, lessonId, activityIds };
  });
}

async function seedSession(
  t: T,
  scholarId: Id<"users">,
  where: {
    unitId?: Id<"units">;
    lessonId?: Id<"lessons">;
    activityId?: Id<"activities">;
  },
  extra: Partial<Doc<"sessions">> & { withApp?: boolean } = {},
) {
  const { withApp, ...fields } = extra;
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Session",
      isArchived: false,
      parkingLot: LOT,
      ...where,
      ...fields,
    });
    if (withApp) {
      await ctx.db.insert("artifacts", {
        sessionId,
        title: "Wave Toy",
        content: "<button>Wave</button>",
        lastEditedBy: "ai",
        type: "code",
        language: "html",
      });
    }
    return sessionId;
  });
}

async function contextFor(t: T, sessionId: Id<"sessions">) {
  const context = await t.run((ctx) =>
    ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
  );
  return context!;
}

async function render(
  t: T,
  sessionId: Id<"sessions">,
  extra: { playMode?: boolean } = {},
) {
  const context = await contextFor(t, sessionId);
  const parts = buildTutorSystemPromptParts({ ...context, ...extra });
  const tutorSection = context.mission
    ? buildTutorMissionSteering(context.mission)
    : null;
  return {
    context,
    stable: parts.stable,
    dynamic: parts.dynamic + parts.turnSystem,
    hasTutorMission: tutorSection != null && parts.stable.includes(tutorSection),
    hasLot: parts.turnSystem.includes(LOT[0].text),
  };
}

describe("the MISSION section and the parking lot, by session", () => {
  test("a deliverable activity: tutor MISSION section in the stable prefix, and its lot", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [
      { title: "Write the wave story", kind: "online", deliverable: TEXT_DELIVERABLE },
    ]);
    const sessionId = await seedSession(t, scholarId, {
      unitId: u.unitId,
      lessonId: u.lessonId,
      activityId: u.activityIds[0],
    });
    const r = await render(t, sessionId);
    expect(r.context.mission?.source).toBe("default");
    expect(r.hasTutorMission).toBe(true);
    expect(r.hasLot).toBe(true);
    expect(r.dynamic).not.toContain(buildTutorMissionSteering(r.context.mission!));
  });

  test("Play mode drops both", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [
      { title: "Write the wave story", kind: "online", deliverable: TEXT_DELIVERABLE },
    ]);
    const sessionId = await seedSession(t, scholarId, {
      unitId: u.unitId,
      lessonId: u.lessonId,
      activityId: u.activityIds[0],
    });
    const r = await render(t, sessionId, { playMode: true });
    expect(r.hasTutorMission).toBe(false);
    expect(r.hasLot).toBe(false);
  });

  test("a discussion (advanceRubric, no deliverable), an open chat and free play have no mission", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [
      {
        title: "Talk about waves",
        kind: "online",
        advanceRubric: { criteria: [{ id: "noticed", label: "Noticed it" }] },
      },
      { title: "Build the wave", kind: "online", appActivity: true },
    ]);
    const discussion = await seedSession(t, scholarId, {
      unitId: u.unitId,
      lessonId: u.lessonId,
      activityId: u.activityIds[0],
    });
    const openChat = await seedSession(t, scholarId, {});
    const freePlay = await seedSession(
      t,
      scholarId,
      { unitId: u.unitId, lessonId: u.lessonId, activityId: u.activityIds[1] },
      { sessionMode: "vibecode", freePlay: true, withApp: true },
    );
    for (const sessionId of [discussion, openChat]) {
      const r = await render(t, sessionId);
      expect(r.context.mission).toBeNull();
      expect(r.stable).not.toContain(PARK_IDEA_TOOL_NAME);
      expect(r.hasLot).toBe(false);
    }
    // Free play lists the lot as its opener, with no mission steering.
    const r = await render(t, freePlay);
    expect(r.context.mission).toBeNull();
    expect(r.stable).not.toContain(PARK_IDEA_TOOL_NAME);
  });

  test("a side app keeps the tutor MISSION section, with or without a draft", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [
      { title: "Write the wave story", kind: "online", deliverable: TEXT_DELIVERABLE },
    ]);
    const where = {
      unitId: u.unitId,
      lessonId: u.lessonId,
      activityId: u.activityIds[0],
    };
    const preGate = await seedSession(t, scholarId, where, { withApp: true });
    const postGate = await seedSession(t, scholarId, where, { withApp: true });
    await t.run((ctx) =>
      ctx.db.insert("artifacts", {
        sessionId: postGate,
        title: "The wave story",
        content: "The wave rose up and crashed on the reef.",
        lastEditedBy: "scholar",
        type: "text",
      }),
    );
    for (const sessionId of [preGate, postGate]) {
      const r = await render(t, sessionId);
      expect(r.context.appContext.role).toBe("side");
      expect(r.context.appContext.builderStance).toBe(false);
      expect(r.hasTutorMission).toBe(true);
      expect(r.hasLot).toBe(true);
      // The SIDE APP section defers to the MISSION on when to build.
      expect(r.stable).toContain(buildSideAppSection("text", { hasMission: true }));
      expect(r.stable).not.toContain(buildSideAppSection("text"));
    }
  });

  test("an app activity steers in the builder lead-in, never the tutor section", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [
      { title: "Build the wave", kind: "online", appActivity: true },
    ]);
    const sessionId = await seedSession(
      t,
      scholarId,
      { unitId: u.unitId, lessonId: u.lessonId, activityId: u.activityIds[0] },
      { sessionMode: "vibecode" },
    );
    const r = await render(t, sessionId);
    expect(r.context.mission?.gate).toBe(DEFAULT_APP_GATE);
    expect(r.hasTutorMission).toBe(false);
    expect(r.stable).toContain(DEFAULT_APP_GATE);
    expect(r.stable).toContain(PARK_IDEA_TOOL_NAME);
    expect(r.hasLot).toBe(true);
  });

  test("a teacher build gets neither the section nor the lot", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [
      {
        title: "Build the wave",
        kind: "online",
        appActivity: true,
        appRequest: "A wave app.",
      },
    ]);
    const sessionId = await seedSession(
      t,
      scholarId,
      { unitId: u.unitId, lessonId: u.lessonId, activityId: u.activityIds[0] },
      { sessionMode: "vibecode", isTestDrive: true },
    );
    const r = await render(t, sessionId);
    expect(r.hasTutorMission).toBe(false);
    expect(r.stable).not.toContain(PARK_IDEA_TOOL_NAME);
    expect(r.hasLot).toBe(false);
  });
});

describe("the scholar's own Quest", () => {
  test("planning chat with a mission: no tutor MISSION section (the chat is theirs); the unit carries the line", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [], {
      quest: true,
      mission: { text: "QUEST-a-clicker-that-grows", gate: "QUEST-GATE-ran-once" },
    });
    const sessionId = await seedSession(t, scholarId, { unitId: u.unitId });
    const r = await render(t, sessionId);
    expect(r.context.mission?.source).toBe("quest");
    expect(r.hasTutorMission).toBe(false);
    expect(r.stable).not.toContain("QUEST-GATE-ran-once");
    expect(r.stable).toContain("QUEST-a-clicker-that-grows");
    expect(r.stable).toContain("set_quest_mission");
  });

  test("writing the Quest's mission (5b) is planning-chat only, not every Quest activity", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(
      t,
      scholarId,
      [{ title: "Explain how a wave breaks", kind: "online", deliverable: TEXT_DELIVERABLE }],
      { quest: true },
    );
    const count = (s: string) => s.split("set_quest_mission").length - 1;
    const planning = await render(
      t,
      await seedSession(t, scholarId, { unitId: u.unitId }),
    );
    const step = await render(
      t,
      await seedSession(t, scholarId, {
        unitId: u.unitId,
        lessonId: u.lessonId,
        activityId: u.activityIds[0],
      }),
    );
    // Both list the tool; only the planning chat also asks to write it.
    expect(count(step.stable)).toBeGreaterThanOrEqual(1);
    expect(count(planning.stable)).toBeGreaterThan(count(step.stable));
  });

  test("a side app in a locked Quest learning step says the app waits for the build step", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(
      t,
      scholarId,
      [
        { title: "Explain how a wave breaks", kind: "online", deliverable: TEXT_DELIVERABLE },
        { title: "BUILD-a-wave-simulation", kind: "online", appActivity: true },
      ],
      { quest: true },
    );
    const sessionId = await seedSession(
      t,
      scholarId,
      { unitId: u.unitId, lessonId: u.lessonId, activityId: u.activityIds[0] },
      { withApp: true },
    );
    const r = await render(t, sessionId);
    expect(r.stable).toContain(
      buildSideAppSection("text", {
        hasMission: true,
        lockedBuild: "BUILD-a-wave-simulation",
      }),
    );
  });

  test("planning chat without a mission: no MISSION section, but the planning text offers the tool", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [], { quest: true });
    const sessionId = await seedSession(t, scholarId, { unitId: u.unitId });
    const r = await render(t, sessionId);
    expect(r.context.mission).toBeNull();
    expect(r.hasLot).toBe(false);
    expect(r.stable).toContain("set_quest_mission");
  });

  test("a learning step names the build it unlocks, until it is complete", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(
      t,
      scholarId,
      [
        { title: "Explain how a wave breaks", kind: "online", deliverable: TEXT_DELIVERABLE },
        { title: "BUILD-a-wave-simulation", kind: "online", appActivity: true },
      ],
      { quest: true },
    );
    const sessionId = await seedSession(t, scholarId, {
      unitId: u.unitId,
      lessonId: u.lessonId,
      activityId: u.activityIds[0],
    });
    const locked = await render(t, sessionId);
    expect(locked.context.mission?.unlocksBuild).toBe("BUILD-a-wave-simulation");
    expect(locked.hasTutorMission).toBe(true);
    expect(locked.stable).toContain("BUILD-a-wave-simulation");

    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId: u.activityIds[0],
        lessonId: u.lessonId,
        unitId: u.unitId,
        completedAt: 2,
        sessionId,
      }),
    );
    // Unlocked: the learning step now points to the OPEN build step, where
    // the Quest's app is built (never here).
    const unlocked = await render(t, sessionId);
    expect(unlocked.context.mission?.unlocksBuild).toBe("BUILD-a-wave-simulation");
    expect(unlocked.context.mission?.buildStepOpen).toBe(true);
    expect(unlocked.context.unitContext?.questBuildOpen).toBe("BUILD-a-wave-simulation");
    expect(unlocked.hasTutorMission).toBe(true);
  });

  test("every learning step before a locked build names it; the build step itself does not", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(
      t,
      scholarId,
      [
        { title: "Read about waves", kind: "online", deliverable: TEXT_DELIVERABLE },
        { title: "Explain how a wave breaks", kind: "online", deliverable: TEXT_DELIVERABLE },
        { title: "BUILD-a-wave-simulation", kind: "online", appActivity: true },
      ],
      { quest: true },
    );
    for (const activityId of u.activityIds.slice(0, 2)) {
      const sessionId = await seedSession(t, scholarId, {
        unitId: u.unitId,
        lessonId: u.lessonId,
        activityId,
      });
      const r = await render(t, sessionId);
      expect(r.context.unitContext?.questBuildLocked).toBe("BUILD-a-wave-simulation");
      expect(r.context.mission?.unlocksBuild).toBe("BUILD-a-wave-simulation");
      expect(r.stable).toContain("BUILD-a-wave-simulation");
    }
    const buildSession = await seedSession(t, scholarId, {
      unitId: u.unitId,
      lessonId: u.lessonId,
      activityId: u.activityIds[2],
    });
    const b = await contextFor(t, buildSession);
    expect(b.unitContext?.questBuildLocked ?? null).toBeNull();
  });

  test("the planning chat of a Quest with a locked build step gets the unlock framing", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(
      t,
      scholarId,
      [
        { title: "Explain how a wave breaks", kind: "online", deliverable: TEXT_DELIVERABLE },
        { title: "BUILD-a-wave-simulation", kind: "online", appActivity: true },
      ],
      { quest: true },
    );
    const sessionId = await seedSession(t, scholarId, { unitId: u.unitId });
    const locked = await render(t, sessionId);
    expect(locked.context.unitContext?.questBuildLocked).toBe("BUILD-a-wave-simulation");

    await t.run((ctx) =>
      ctx.db.insert("activityCompletions", {
        scholarId,
        activityId: u.activityIds[0],
        lessonId: u.lessonId,
        unitId: u.unitId,
        completedAt: 2,
      }),
    );
    const unlocked = await render(t, sessionId);
    expect(unlocked.context.unitContext?.questBuildLocked ?? null).toBeNull();
    expect(unlocked.context.unitContext?.questBuildOpen).toBe("BUILD-a-wave-simulation");
  });

  test("a teacher's unit with the same shape unlocks nothing", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const u = await seedUnit(t, scholarId, [
      { title: "Explain how a wave breaks", kind: "online", deliverable: TEXT_DELIVERABLE },
      { title: "BUILD-a-wave-simulation", kind: "online", appActivity: true },
    ]);
    const sessionId = await seedSession(t, scholarId, {
      unitId: u.unitId,
      lessonId: u.lessonId,
      activityId: u.activityIds[0],
    });
    const r = await render(t, sessionId);
    expect(r.context.mission?.unlocksBuild).toBeNull();
    expect(r.context.unitContext?.questBuildOpen ?? null).toBeNull();
    expect(r.stable).not.toContain("BUILD-a-wave-simulation");
  });
});
