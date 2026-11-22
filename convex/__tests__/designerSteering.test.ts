// App designer steering by an activity's MODEL CONTRACT: the prompt section's
// presence (never its wording), the mission-tool gate, the parking lot's
// caps, the silent-turn finalize, and buildContract reaching the tutor context.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  SCHOLAR_RULES_STEERING,
  buildParkingLotSection,
  buildVibecodeSection,
  type DesignerBuildContract,
} from "../prompts";
import { buildTutorSystemPromptParts } from "../sessionStreamHelpers";
import {
  PARKING_LOT_LIMITS,
  PARK_IDEA_TOOL_NAME,
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
    expect(buildVibecodeSection({ buildContract: null })).toBe(
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
    expect(prompt).not.toContain("stay_silent");
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
    });
    const quest = buildVibecodeSection({
      buildContract: CONTRACT,
      mission: { ...mission, ownQuest: true },
    });
    // Same builder lead-in, different steering after it.
    expect(quest.startsWith(teacher.slice(0, 200))).toBe(true);
    expect(quest).not.toBe(teacher);
    // The model is still visible as an idea to offer; no gate, no silence.
    expect(quest).toContain(CONTRACT.invariants[0]);
    expect(quest).not.toContain(CONTRACT.gate!);
    // Saving what one app cannot do still goes through park_idea.
    expect(quest).toContain(PARK_IDEA_TOOL_NAME);
    expect(teacher).toContain(CONTRACT.gate!);
  });

  test("teacher build renders the contract but never parking or silence", () => {
    const prompt = buildVibecodeSection({
      teacherBuild: true,
      appRequest: "a pond app",
      buildContract: CONTRACT,
    });
    expect(prompt).toContain(CONTRACT.invariants[0]);
    expect(prompt).toContain(CONTRACT.gate!);
    expect(prompt).not.toContain(PARK_IDEA_TOOL_NAME);
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

  test("the Play lead-in sends a scholar to Edit only when they can open it", () => {
    const lead = (
      playEditAccess: "allowed" | "locked" | "hidden",
      hasApp: boolean,
    ) => buildVibecodeSection({ playMode: true, playEditAccess, hasApp });
    // Edit open, app on screen: today's line, also the default.
    expect(lead("allowed", true)).toBe(buildVibecodeSection({ playMode: true }));
    const variants = [
      lead("allowed", true),
      lead("allowed", false),
      lead("locked", true),
      lead("hidden", true),
      lead("locked", false),
    ];
    expect(new Set(variants).size).toBe(variants.length);
    // With nothing to play and no Edit, locked and hidden read the same.
    expect(lead("hidden", false)).toBe(lead("locked", false));
  });

  test("the scholar's rules steer every scholar build but the own Quest, a teacher build and Play", () => {
    const rules = SCHOLAR_RULES_STEERING.trim();
    // No contract and no mission: an old free-play copy, or an app built in an
    // open chat.
    expect(buildVibecodeSection()).toContain(rules);
    expect(buildVibecodeSection({ freePlay: true })).toContain(rules);
    const mission = {
      source: "default" as const,
      gate: "GATE-a-first-version-has-run-once",
      freedoms: [],
      invariants: [],
      questLine: null,
      unlocksBuild: null,
      buildStepOpen: false,
    };
    // A contract or a mission: the rules take over once the gate is met, in
    // the same session (one app, one way of building after the gate).
    expect(buildVibecodeSection({ buildContract: CONTRACT })).toContain(rules);
    expect(buildVibecodeSection({ mission: { ...mission, ownQuest: false } })).toContain(rules);
    // The exclusions each stand on their own: the scholar's own Quest, a
    // teacher build, and Play.
    expect(buildVibecodeSection({ mission: { ...mission, ownQuest: true } })).not.toContain(rules);
    expect(buildVibecodeSection({ teacherBuild: true, appRequest: "a pond app" })).not.toContain(rules);
    expect(buildVibecodeSection({ playMode: true })).not.toContain(rules);
  });

  test("a finished activity keeps its contract and scholar-led rules", () => {
    const open = buildVibecodeSection({ buildContract: CONTRACT });
    const done = buildVibecodeSection({
      buildContract: CONTRACT,
      activityComplete: true,
    });
    for (const piece of [...CONTRACT.invariants, CONTRACT.gate!]) {
      expect(done).toContain(piece);
    }
    expect(open).toContain(SCHOLAR_RULES_STEERING.trim());
    expect(done).toContain(SCHOLAR_RULES_STEERING.trim());
  });

  test("Play mode stays the one-line Play lead-in", () => {
    expect(
      buildVibecodeSection({
        playMode: true,
        buildContract: CONTRACT,
        }),
    ).toBe(buildVibecodeSection({ playMode: true }));
  });
});

describe("missionToolOffer", () => {
  const activeMission = {
    hasMission: true,
    workshopMode: "edit" as const,
    teacherBuild: false,
  };

  test("returns exactly the park offer for an active mission", () => {
    expect(missionToolOffer(activeMission)).toEqual({ parkIdea: true });
  });

  test("does not offer tools without a mission, in Play, teacher builds, or free play", () => {
    for (const change of [
      { hasMission: false },
      { workshopMode: "play" as const },
      { teacherBuild: true },
      { freePlay: true },
    ]) {
      expect(missionToolOffer({ ...activeMission, ...change })).toEqual({
        parkIdea: false,
      });
    }
  });

  test("makeDesignerTools never offers stay_silent", async () => {
    const { makeDesignerTools } = await import("../lib/designerTools");
    const tools = await makeDesignerTools({
      offer: { parkIdea: true },
      parkIdea: async () => "added" as const,
      unparkIdea: async () => "removed" as const,
    });
    expect(tools.map((tool) => tool.name)).toEqual([PARK_IDEA_TOOL_NAME, "unpark_idea"]);
  });

  test("set_provocation is offered only when the caller wires it", async () => {
    const { makeDesignerTools } = await import("../lib/designerTools");
    const base = {
      offer: { parkIdea: true },
      parkIdea: async () => "added" as const,
      unparkIdea: async () => "removed" as const,
    };
    const names = async (opts: Parameters<typeof makeDesignerTools>[0]) =>
      (await makeDesignerTools(opts)).map((tool) => tool.name);
    expect(await names(base)).not.toContain("set_provocation");
    expect(
      await names({ ...base, setProvocation: async () => "set" as const }),
    ).toContain("set_provocation");
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
  activity: { buildContract?: DesignerBuildContract } = {},
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

describe("sessions.setProvocation", () => {
  test("each call replaces the question, and empty text clears it", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t);
    const set = (text: string) =>
      t.mutation(internal.sessions.setProvocation, { sessionId, text });
    const read = async () =>
      (await t.run((ctx) => ctx.db.get(sessionId)))?.provocation;
    expect(await set("  What happens when gravity is weaker?  ")).toBe("set");
    expect(await read()).toBe("What happens when gravity is weaker?");
    expect(await set("Does a second rocket change your speed?")).toBe("set");
    expect(await read()).toBe("Does a second rocket change your speed?");
    expect(await set("   ")).toBe("cleared");
    expect(await read()).toBeUndefined();
  });
});

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
  test("carries the activity's contract without allowSilence", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, {
      buildContract: CONTRACT,
    });
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(context?.lessonActivityContext?.buildContract).toEqual(CONTRACT);
    expect(context?.lessonActivityContext).not.toHaveProperty("allowSilence");
  });

  test("no contract → neither field", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t);
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

  test("buildParkingLotSection varies its guidance by session state", () => {
    const lot = [{ text: "IDEA-rainbow-fish" }];
    const waiting = buildParkingLotSection(lot, "waiting");
    const finished = buildParkingLotSection(lot, "finished");
    const builder = buildParkingLotSection(lot, "builder");
    expect(new Set([waiting, finished, builder]).size).toBe(3);
    expect(finished).toContain("IDEA-rainbow-fish");
    expect(builder).toContain("unpark_idea");
  });

  async function promptFor(
    activity: { buildContract?: DesignerBuildContract },
    lot: Array<{ text: string; parkedAt: number; reason?: string }> | null,
  ) {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, activity);
    if (lot) await t.run((ctx) => ctx.db.patch(sessionId, { parkingLot: lot }));
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    const parts = buildTutorSystemPromptParts(context!);
    return parts.stable + parts.dynamic + parts.turnSystem;
  }
  const LOT = [{ text: "IDEA-rainbow-fish", parkedAt: 1, reason: "REASON-later" }];

  test("present iff the lot is non-empty", async () => {
    expect(await promptFor({ buildContract: CONTRACT }, LOT)).toContain(
      "IDEA-rainbow-fish",
    );
    // An app activity without a contract still parks ideas.
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

  test("the builder sees its open question each turn, outside the cached prefix", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, { buildContract: CONTRACT });
    const partsFor = async () => {
      const context = await t.run((ctx) =>
        ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
      );
      return buildTutorSystemPromptParts(context!);
    };
    expect((await partsFor()).turnSystem).not.toContain("SOMETHING TO FIGURE OUT NOW");
    await t.mutation(internal.sessions.setProvocation, {
      sessionId,
      text: "QUESTION-weaker-gravity",
    });

    const parts = await partsFor();
    expect(parts.stable).not.toContain("QUESTION-weaker-gravity");
    expect(parts.turnSystem).toContain("QUESTION-weaker-gravity");
    // A chat with a mission has no Flair tab: no question in its prompt.
    await t.run((ctx) => ctx.db.patch(sessionId, { sessionMode: "conversation" }));
    const chat = await partsFor();
    expect(chat.stable + chat.dynamic + chat.turnSystem).not.toContain(
      "QUESTION-weaker-gravity",
    );
  });

  test("a builder without the native tool sees neither its question nor tool steering", async () => {
    const t = convexTest(schema, modules);
    const { sessionId } = await seedVibecodeSession(t, { buildContract: CONTRACT });
    await t.mutation(internal.sessions.setProvocation, {
      sessionId,
      text: "QUESTION-weaker-gravity",
    });
    const context = await t.run((ctx) =>
      ctx.runQuery(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    const withoutTool = buildTutorSystemPromptParts({
      ...context!,
      offersProvocation: false,
    });
    const prompt = withoutTool.stable + withoutTool.dynamic + withoutTool.turnSystem;
    expect(prompt).not.toContain("set_provocation");
    expect(prompt).not.toContain("QUESTION-weaker-gravity");
    expect(prompt).not.toContain("- SOMETHING TO FIGURE OUT.");
    expect(prompt).toContain("Then offer the pushback in the same reply");

    const offline = buildTutorSystemPromptParts(context!);
    expect(offline.stable + offline.dynamic + offline.turnSystem).toContain(
      "set_provocation",
    );
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
