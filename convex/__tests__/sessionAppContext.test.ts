// TRA-519 one app surface: how the tutor stream sees a session's app.
// getSessionContext derives appContext (shared/appSurface.ts) from the session,
// its activity, and whether a code artifact exists; the prompt keys builder
// FEATURES on any app and the builder STANCE on an app that is the work.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { PRIOR_UNIT_WORK_HEADER } from "../lib/priorUnitWork";
import { buildToolsSection, buildSideAppSection } from "../prompts";
import { buildTutorSystemPrompt } from "../sessionStreamHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function seedWorld(t: T) {
  const institutionId = await seedTestInstitution(t);
  const teacherId = await seedStaffWithMembership(t, { institutionId });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Test Scholar",
  });
  const ids = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Volcanoes",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Why they erupt",
      order: 0,
    });
    const priorActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Explain the pressure",
      kind: "online",
      systemPrompt: "Explain the pressure.",
      order: 0,
    });
    const writingActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Write the paragraph",
      kind: "online",
      systemPrompt: "Help the scholar write a paragraph.",
      deliverable: {
        kind: "text",
        prompt: "Explain why volcanoes erupt.",
        mode: "none",
        criteria: [],
      },
      order: 1,
    });
    const legacyAppActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build the volcano",
      kind: "vibecode",
      systemPrompt: "Build a volcano model.",
      order: 2,
    });
    const foldedAppActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build the volcano, folded",
      kind: "online",
      appActivity: true,
      systemPrompt: "Build a volcano model.",
      order: 3,
    });
    return {
      unitId,
      lessonId,
      priorActivityId,
      writingActivityId,
      legacyAppActivityId,
      foldedAppActivityId,
    };
  });
  return { ...ids, scholarId };
}

async function seedSession(
  t: T,
  w: Awaited<ReturnType<typeof seedWorld>>,
  activityId: Id<"activities"> | null,
  extra: { sessionMode?: "vibecode"; withApp?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: w.scholarId,
      ...(activityId
        ? { unitId: w.unitId, lessonId: w.lessonId, activityId }
        : {}),
      title: "Session",
      isArchived: false,
      ...(extra.sessionMode ? { sessionMode: extra.sessionMode } : {}),
    });
    if (extra.withApp) {
      await ctx.db.insert("artifacts", {
        sessionId,
        title: "Volcano Toy",
        content: "<button>Erupt</button>",
        lastEditedBy: "ai",
        type: "code",
        language: "html",
      });
    }
    return sessionId;
  });
}

async function contextFor(t: T, sessionId: Id<"sessions">) {
  const c = await t.query(internal.sessionHelpers.getSessionContext, {
    sessionId,
  });
  expect(c).not.toBeNull();
  return c!;
}

describe("getSessionContext appContext", () => {
  test("a writing activity where the tutor built an app: side, with builder features", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const sessionId = await seedSession(t, w, w.writingActivityId, {
      withApp: true,
    });
    const c = await contextFor(t, sessionId);
    expect(c.appContext).toEqual({
      builderPrimary: false,
      hasApp: true,
      role: "side",
      builderFeatures: true,
      builderStance: false,
    });
    expect(c.sideAppWork).toEqual({ deliverableKind: "text" });
    // No parking lot or free play outside the builder stance.
    expect(c.parkingLot).toEqual([]);
    expect(c.freePlay).toBe(false);

    const prompt = buildTutorSystemPrompt(c);
    expect(prompt).toContain("SIDE APP:");
    expect(prompt).toContain("steer back to their writing");
    expect(prompt).not.toContain("APP BUILDER MODE");
    expect(prompt).toContain("RENDER CHECK");
    expect(prompt).toContain("taps Open on the card");
  });

  test("the same writing activity before any app: no builder features, no side section", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const sessionId = await seedSession(t, w, w.writingActivityId);
    const c = await contextFor(t, sessionId);
    expect(c.appContext).toMatchObject({
      hasApp: false,
      role: "side",
      builderFeatures: false,
      builderStance: false,
    });
    expect(c.sideAppWork).toBeNull();
    const prompt = buildTutorSystemPrompt(c);
    expect(prompt).not.toContain("SIDE APP:");
    expect(prompt).not.toContain("RENDER CHECK");
    expect(prompt).not.toContain("charm_icon");
  });

  test("an open chat with an app takes the builder stance", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const sessionId = await seedSession(t, w, null, { withApp: true });
    const c = await contextFor(t, sessionId);
    expect(c.appContext).toEqual({
      builderPrimary: false,
      hasApp: true,
      role: "work",
      builderFeatures: true,
      builderStance: true,
    });
    expect(c.sideAppWork).toBeNull();
    const prompt = buildTutorSystemPrompt(c);
    expect(prompt.startsWith("APP BUILDER MODE:")).toBe(true);
    expect(prompt).not.toContain("SIDE APP:");
    expect(prompt).toContain("taps Open on the card");
  });

  test.each([
    ["legacy", "legacyAppActivityId"],
    ["folded", "foldedAppActivityId"],
  ] as const)(
    "a %s app activity is builder-primary with the builder stance, before its first build",
    async (_label, key) => {
      const t = convexTest(schema, modules);
      const w = await seedWorld(t);
      const sessionId = await seedSession(t, w, w[key], {
        sessionMode: "vibecode",
      });
      const c = await contextFor(t, sessionId);
      expect(c.appContext).toEqual({
        builderPrimary: true,
        hasApp: false,
        role: "work",
        builderFeatures: true,
        builderStance: true,
      });
      // The ACTIVITY section reads the effective kind in both shapes.
      expect(c.lessonActivityContext?.kind).toBe("vibecode");
      const prompt = buildTutorSystemPrompt(c);
      expect(prompt.startsWith("APP BUILDER MODE:")).toBe(true);
      expect(prompt).toContain("Build brief");
      expect(prompt).toContain("RENDER CHECK");
    },
  );

  test("a side session with an app gets the scholar's prior unit work", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const prior = await seedSession(t, w, w.priorActivityId);
    await t.run((ctx) =>
      ctx.db.insert("deliverables", {
        activityId: w.priorActivityId,
        scholarId: w.scholarId,
        sessionId: prior,
        textContent: "Gas builds up under the rock until it bursts.",
        submittedAt: Date.UTC(2026, 9, 3),
      }),
    );
    const withoutApp = await seedSession(t, w, w.writingActivityId);
    expect((await contextFor(t, withoutApp)).priorUnitWork).toBeNull();

    const withApp = await seedSession(t, w, w.writingActivityId, {
      withApp: true,
    });
    const c = await contextFor(t, withApp);
    expect(c.priorUnitWork).toContain(PRIOR_UNIT_WORK_HEADER);
    expect(c.priorUnitWork).toContain("Gas builds up under the rock");
  });
});

describe("one app surface prompt text", () => {
  test("CODE ARTIFACTS describes one app surface in every session", () => {
    for (const builderFeatures of [false, true]) {
      const tools = buildToolsSection({ builderFeatures });
      expect(tools).not.toContain("cannot turn into one");
      expect(tools).not.toContain("opens in its own tab");
      expect(tools).toContain("lives in the app builder");
      expect(tools).toContain("taps Open to take it full screen");
    }
  });

  test("the side section names the work and never the builder stance", () => {
    expect(buildSideAppSection("slides")).toContain("their slides");
    expect(buildSideAppSection("map")).toContain("their map");
    expect(buildSideAppSection(null)).toContain("the discussion");
    for (const kind of ["text", "slides", null]) {
      expect(buildSideAppSection(kind)).not.toContain("APP BUILDER MODE");
    }
  });
});
