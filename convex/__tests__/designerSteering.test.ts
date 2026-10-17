// App designer steering by an activity's MODEL CONTRACT: the prompt section's
// presence (never its wording), the mission-tool gate, the parking lot's
// caps, the silent-turn finalize, and buildContract reaching the tutor context.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  buildParkingLotSection,
  buildVibecodeSection,
  type DesignerBuildContract,
} from "../prompts";
import { buildTutorSystemPromptParts } from "../sessionStreamHelpers";
import {
  PARKING_LOT_LIMITS,
  PARK_IDEA_TOOL_NAME,
  STAY_SILENT_TOOL_NAME,
  appendParkingLotEntry,
  missionToolOffer,
} from "../lib/designerTools";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Fictional, and distinctive enough that its presence proves plumbing.
const CONTRACT: DesignerBuildContract = {
  invariants: ["INV-pond-oxygen-falls-as-algae-grows"],
  freedoms: ["FREE-what-the-fish-look-like"],
  gate: "GATE-oxygen-curve-has-run-once",
};

describe("buildVibecodeSection with a model contract", () => {
  test("no contract renders today's prompt byte-for-byte", () => {
    expect(buildVibecodeSection({ buildContract: null, allowSilence: true })).toBe(
      buildVibecodeSection(),
    );
    expect(
      buildVibecodeSection({
        vibecodeStarterUsedAt: 1,
        buildContract: null,
      }),
    ).toBe(buildVibecodeSection({ vibecodeStarterUsedAt: 1 }));
  });

  test("a contract renders its invariants, freedoms, and gate and names park_idea", () => {
    const prompt = buildVibecodeSection({ buildContract: CONTRACT });
    for (const piece of [
      ...CONTRACT.invariants,
      ...CONTRACT.freedoms,
      CONTRACT.gate!,
    ]) {
      expect(prompt).toContain(piece);
    }
    expect(prompt).toContain(PARK_IDEA_TOOL_NAME);
  });

  test("the contract steering section is present only under a contract", () => {
    const withContract = buildVibecodeSection({ buildContract: CONTRACT });
    const without = buildVibecodeSection();
    expect(withContract.length).toBeGreaterThan(without.length);
    expect(withContract.startsWith(without.slice(0, 200))).toBe(true);
    expect(buildVibecodeSection({ buildContract: null })).toBe(without);
  });

  test("in the scholar's own Quest the contract is offered, not enforced", () => {
    const mission = {
      source: "authored" as const,
      gate: CONTRACT.gate!,
      freedoms: CONTRACT.freedoms,
      invariants: CONTRACT.invariants,
      questLine: null,
      unlocksBuild: null,
      buildStepOpen: false,
    };
    const teacher = buildVibecodeSection({
      buildContract: CONTRACT,
      mission: { ...mission, ownQuest: false },
      allowSilence: true,
    });
    const quest = buildVibecodeSection({
      buildContract: CONTRACT,
      mission: { ...mission, ownQuest: true },
      allowSilence: true,
    });
    // Same builder lead-in, different steering after it.
    expect(quest.startsWith(teacher.slice(0, 200))).toBe(true);
    expect(quest).not.toBe(teacher);
    // The model is still visible as an idea to offer; no gate, no silence.
    expect(quest).toContain(CONTRACT.invariants[0]);
    expect(quest).not.toContain(CONTRACT.gate!);
    expect(quest).not.toContain(STAY_SILENT_TOOL_NAME);
    // Saving what one app cannot do still goes through park_idea.
    expect(quest).toContain(PARK_IDEA_TOOL_NAME);
    expect(teacher).toContain(CONTRACT.gate!);
  });

  test("stay_silent is named iff allowSilence", () => {
    expect(
      buildVibecodeSection({ buildContract: CONTRACT, allowSilence: true }),
    ).toContain(STAY_SILENT_TOOL_NAME);
    expect(
      buildVibecodeSection({ buildContract: CONTRACT, allowSilence: false }),
    ).not.toContain(STAY_SILENT_TOOL_NAME);
    // allowSilence alone (no contract) changes nothing.
    expect(buildVibecodeSection({ allowSilence: true })).toBe(
      buildVibecodeSection(),
    );
  });

  test("teacher build renders the contract but never parking or silence", () => {
    const prompt = buildVibecodeSection({
      teacherBuild: true,
      appRequest: "a pond app",
      buildContract: CONTRACT,
      allowSilence: true,
    });
    expect(prompt).toContain(CONTRACT.invariants[0]);
    expect(prompt).toContain(CONTRACT.gate!);
    expect(prompt).not.toContain(PARK_IDEA_TOOL_NAME);
    expect(prompt).not.toContain(STAY_SILENT_TOOL_NAME);
    expect(
      buildVibecodeSection({ teacherBuild: true, appRequest: "a pond app" }),
    ).toBe(
      buildVibecodeSection({
        teacherBuild: true,
        appRequest: "a pond app",
        buildContract: null,
      }),
    );
  });

  test("Play mode stays the one-line Play lead-in", () => {
    expect(
      buildVibecodeSection({
        playMode: true,
        buildContract: CONTRACT,
        allowSilence: true,
      }),
    ).toBe(buildVibecodeSection({ playMode: true }));
  });
});

describe("missionToolOffer", () => {
  const builderTurn = {
    hasMission: true,
    builderStance: true,
    workshopMode: "edit" as const,
    teacherBuild: false,
    appActivity: true,
    allowSilence: true,
    callerIsSessionOwner: true,
  };
  const tutorTurn = {
    ...builderTurn,
    builderStance: false,
    appActivity: false,
    allowSilence: false,
  };

  test("a builder-stance Edit turn on an app activity gets both tools", () => {
    expect(missionToolOffer(builderTurn)).toEqual({
      parkIdea: true,
      staySilent: true,
    });
    expect(
      missionToolOffer({ ...builderTurn, allowSilence: false }),
    ).toEqual({ parkIdea: true, staySilent: false });
  });

  test("a tutor-stance turn with a mission can park, and is never silenced", () => {
    expect(missionToolOffer(tutorTurn)).toEqual({
      parkIdea: true,
      staySilent: false,
    });
    // allowSilence is builder-only and app-activity-only.
    expect(
      missionToolOffer({ ...tutorTurn, allowSilence: true, appActivity: true }),
    ).toEqual({ parkIdea: true, staySilent: false });
    expect(
      missionToolOffer({ ...builderTurn, appActivity: false }),
    ).toEqual({ parkIdea: true, staySilent: false });
  });

  test("a non-owner (teacher in remote view) can park but is never silenced", () => {
    expect(
      missionToolOffer({ ...builderTurn, callerIsSessionOwner: false }),
    ).toEqual({ parkIdea: true, staySilent: false });
  });

  test("no mission, Play, a teacher build or free play gets neither", () => {
    for (const change of [
      { hasMission: false },
      { workshopMode: "play" as const },
      { teacherBuild: true },
      { freePlay: true },
    ]) {
      for (const turn of [builderTurn, tutorTurn]) {
        expect(missionToolOffer({ ...turn, ...change })).toEqual({
          parkIdea: false,
          staySilent: false,
        });
      }
    }
  });
});

describe("appendParkingLotEntry", () => {
  test("clips text and reason to the character cap", () => {
    const long = "a".repeat(PARKING_LOT_LIMITS.maxChars + 50);
    const result = appendParkingLotEntry(undefined, { text: long, reason: long }, 5);
    expect(result.kind).toBe("added");
    if (result.kind !== "added") return;
    expect(result.lot).toHaveLength(1);
    expect(result.lot[0].text.length).toBe(PARKING_LOT_LIMITS.maxChars);
    expect(result.lot[0].reason!.length).toBe(PARKING_LOT_LIMITS.maxChars);
    expect(result.lot[0].parkedAt).toBe(5);
  });

  test("omits an empty reason and refuses empty text", () => {
    const added = appendParkingLotEntry([], { text: "jetpack", reason: " " }, 1);
    expect(added.kind === "added" && added.lot[0]).toEqual({
      text: "jetpack",
      parkedAt: 1,
    });
    expect(appendParkingLotEntry([], { text: "   " }, 1).kind).toBe("empty");
  });

  test("de-duplicates case-insensitively and stops at the entry cap", () => {
    const lot = [{ text: "Jetpack", parkedAt: 1 }];
    expect(appendParkingLotEntry(lot, { text: "jetpack" }, 2).kind).toBe(
      "duplicate",
    );
    const full = Array.from({ length: PARKING_LOT_LIMITS.maxEntries }, (_, i) => ({
      text: `idea ${i}`,
      parkedAt: i,
    }));
    expect(appendParkingLotEntry(full, { text: "one more" }, 99).kind).toBe(
      "full",
    );
  });
});

async function seedVibecodeSession(
  t: ReturnType<typeof convexTest>,
  activity: { buildContract?: DesignerBuildContract; allowSilence?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: `designer-${crypto.randomUUID()}`,
      role: "scholar",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId: userId,
      title: "Pond unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Pond lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Build a pond",
      kind: "vibecode",
      systemPrompt: "Build the oxygen model.",
      order: 0,
      ...activity,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Pond app",
      sessionMode: "vibecode",
      isArchived: false,
      unitId,
      lessonId,
      activityId,
      lastMessagePreview: "earlier preview",
    });
    return { userId, sessionId };
  });
}

describe("sessions.parkIdea", () => {
  test("appends to the session's parking lot and de-duplicates", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t);
    const park = (text: string, reason?: string) =>
      t.mutation(internal.sessions.parkIdea, {
        sessionId,
        text,
        ...(reason ? { reason } : {}),
      });
    expect(await park("a crossbow", "after the model runs")).toBe("added");
    expect(await park("A CROSSBOW")).toBe("duplicate");
    expect(await park("night mode")).toBe("added");
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.parkingLot?.map((e) => e.text)).toEqual([
      "a crossbow",
      "night mode",
    ]);
    expect(session?.parkingLot?.[0].reason).toBe("after the model runs");
  });

  test("parks in a chat-primary session too — the tool offer is the gate (TRA-519)", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t);
    await t.run((ctx) => ctx.db.patch(sessionId, { sessionMode: "conversation" }));
    expect(
      await t.mutation(internal.sessions.parkIdea, { sessionId, text: "x" }),
    ).toBe("added");
    expect(
      await t.mutation(internal.sessions.unparkIdea, { sessionId, text: "x" }),
    ).toBe("removed");
  });
});

describe("finalizeStream silent", () => {
  test("deletes the placeholder and leaves the session's preview alone", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t);
    const messageId: Id<"messages"> = await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "s1",
        flagged: false,
      }),
    );
    await t.mutation(internal.sessionHelpers.finalizeStream, {
      messageId,
      sessionId,
      content: "",
      silent: true,
    });
    expect(await t.run((ctx) => ctx.db.get(messageId))).toBeNull();
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.lastMessagePreview).toBe("earlier preview");
    expect(session?.lastMessageRole).toBeUndefined();
  });
});

describe("getSessionContext", () => {
  test("carries the activity's contract and allowSilence", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, {
      buildContract: CONTRACT,
      allowSilence: true,
    });
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(context?.lessonActivityContext?.buildContract).toEqual(CONTRACT);
    expect(context?.lessonActivityContext?.allowSilence).toBe(true);
  });

  test("no contract → neither field", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, { allowSilence: true });
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(context?.lessonActivityContext).not.toHaveProperty("buildContract");
    expect(context?.lessonActivityContext).not.toHaveProperty("allowSilence");
  });
});

describe("parking lot in the prompt", () => {
  test("buildParkingLotSection: null when empty, one line per idea otherwise", () => {
    expect(buildParkingLotSection(null)).toBeNull();
    expect(buildParkingLotSection([])).toBeNull();
    expect(buildParkingLotSection([{ text: "  " }])).toBeNull();
    const section = buildParkingLotSection([
      { text: "IDEA-rainbow-fish", reason: "REASON-after-the-run" },
      { text: "IDEA-night-mode" },
    ]);
    expect(section).toContain("IDEA-rainbow-fish");
    expect(section).toContain("REASON-after-the-run");
    expect(section).toContain("IDEA-night-mode");
    expect(section).toContain("unpark_idea");
  });

  async function promptFor(
    activity: { buildContract?: DesignerBuildContract; allowSilence?: boolean },
    lot: Array<{ text: string; parkedAt: number; reason?: string }> | null,
    extra: { callerIsSessionOwner?: boolean } = {},
  ) {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, activity);
    if (lot) await t.run((ctx) => ctx.db.patch(sessionId, { parkingLot: lot }));
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    const parts = buildTutorSystemPromptParts({ ...context!, ...extra });
    return parts.stable + parts.dynamic + parts.turnSystem;
  }
  const LOT = [{ text: "IDEA-rainbow-fish", parkedAt: 1, reason: "REASON-later" }];

  test("present iff the lot is non-empty and the session has a mission", async () => {
    expect(await promptFor({ buildContract: CONTRACT }, LOT)).toContain(
      "IDEA-rainbow-fish",
    );
    // An app activity with no authored contract still has a mission (the
    // default app gate, TRA-519 B1), so its lot renders too.
    expect(await promptFor({}, LOT)).toContain("IDEA-rainbow-fish");
    const empty = await promptFor({ buildContract: CONTRACT }, []);
    expect(empty).toBe(await promptFor({ buildContract: CONTRACT }, null));
    expect(empty).not.toContain("IDEA-rainbow-fish");
  });

  test("rides in the per-turn session state, never the cached prefix", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, { buildContract: CONTRACT });
    await t.run((ctx) => ctx.db.patch(sessionId, { parkingLot: LOT }));
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    const parts = buildTutorSystemPromptParts(context!);
    expect(parts.stable).not.toContain("IDEA-rainbow-fish");
    expect(parts.turnSystem).toContain("IDEA-rainbow-fish");
  });

  test("the silence branch renders only for the session owner", async () => {
    const activity = { buildContract: CONTRACT, allowSilence: true };
    expect(await promptFor(activity, null)).toContain(STAY_SILENT_TOOL_NAME);
    expect(
      await promptFor(activity, null, { callerIsSessionOwner: false }),
    ).not.toContain(STAY_SILENT_TOOL_NAME);
  });
});

describe("removeParkingLotEntry", () => {
  test("removes an exact match ignoring case, then a containing match, else nothing", async () => {
    const { removeParkingLotEntry } = await import("../lib/designerTools");
    const lot = [
      { text: "A crossbow for the anomalies", parkedAt: 1 },
      { text: "Shaders and textures", parkedAt: 2 },
    ];
    const exact = removeParkingLotEntry(lot, "shaders and textures");
    expect(exact.kind).toBe("removed");
    if (exact.kind === "removed") expect(exact.lot.map((e) => e.text)).toEqual(["A crossbow for the anomalies"]);
    const partial = removeParkingLotEntry(lot, "the crossbow");
    expect(partial.kind).toBe("removed");
    if (partial.kind === "removed") expect(partial.lot.map((e) => e.text)).toEqual(["Shaders and textures"]);
    expect(removeParkingLotEntry(lot, "a hunger bar").kind).toBe("missing");
    expect(removeParkingLotEntry(undefined, "x").kind).toBe("missing");
  });
});
