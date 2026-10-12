import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { beginnerAlphabet } from "../../shared/beginnerReading";
import { internal } from "../_generated/api";
import {
  buildBeginnerReaderSection,
  buildEarlyReaderSection,
  buildGenericReadingLevelSection,
  buildLevelsSection,
  buildListenerDeliverySection,
  buildPreReaderSection,
  buildWriteByVoiceSection,
  buildYoungReaderTurnRules,
} from "../prompts";
import { buildSystemPrompt, buildSystemPromptParts } from "../sessionHelpers";
import {
  needsYoungReaderTurnRules,
  PRE_READER_LEVEL,
  resolveEffectiveLevels,
  selectLevelSections,
  type ReadLevel,
  type WriteMode,
} from "../lib/readingLevels";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// TALK decides what the tutor says (the register); READ decides only how the
// words arrive. These tests pin that split structurally (which builders are
// chosen, and that the assembled prompt carries exactly those builders' output)
// rather than rehashing prompt wording.

// ── Section selection: talk → register, read/write → delivery ────────

const sections = (
  register: string,
  youngReaderTurnRules: boolean,
  listenerDelivery: boolean,
  writeByVoice = false,
  beginnerDelivery = false,
) => ({
  register,
  youngReaderTurnRules,
  listenerDelivery,
  beginnerDelivery,
  writeByVoice,
});

describe("selectLevelSections", () => {
  test("talk 7 + listener → grade-7 register, turn rules, listener delivery", () => {
    expect(
      selectLevelSections({ talk: "7", read: "listener", write: "own" }),
    ).toEqual(sections("generic", true, true));
  });

  test("talk 7 + beginner → grade-7 register, the turn rules, beginner delivery (TRA-504)", () => {
    expect(
      selectLevelSections({ talk: "7", read: "beginner", write: "own" }),
    ).toEqual(sections("generic", true, false, false, true));
  });

  test("talk 7 + reader → the grade-7 register alone", () => {
    expect(
      selectLevelSections({ talk: "7", read: "reader", write: "own" }),
    ).toEqual(sections("generic", false, false));
  });

  test("talk K + listener → the pre-reader register (it carries delivery itself)", () => {
    expect(
      selectLevelSections({ talk: "K", read: "listener", write: "own" }),
    ).toEqual(sections("preReader", true, false));
  });

  test("unset talk + listener → the pre-reader register", () => {
    expect(
      selectLevelSections({ talk: null, read: "listener", write: "own" }).register,
    ).toBe("preReader");
  });

  test("talk 2 + listener → early-reader register, turn rules, listener delivery", () => {
    expect(
      selectLevelSections({ talk: "2", read: "listener", write: "own" }),
    ).toEqual(sections("earlyReader", true, true));
  });

  test("an early talk level keeps the turn rules for a reader", () => {
    expect(
      selectLevelSections({ talk: "K", read: "reader", write: "own" }),
    ).toEqual(sections("earlyReader", true, false));
    expect(
      selectLevelSections({ talk: null, read: "reader", write: "voice" }),
    ).toEqual(sections("none", false, false, true));
  });
});

describe("needsYoungReaderTurnRules — read below reader, or an early talk level", () => {
  test.each([
    ["7", "listener", true],
    ["7", "beginner", true],
    ["college", "beginner", true],
    ["K", "reader", true],
    ["2.9", "reader", true],
    ["3", "reader", false],
    ["7", "reader", false],
    [null, "reader", false],
  ] as const)("talk %s + read %s → %s", (talk, read, expected) => {
    expect(needsYoungReaderTurnRules({ talk, read })).toBe(expected);
  });
});

describe("resolver → selection, end to end", () => {
  const pick = (args: Parameters<typeof resolveEffectiveLevels>[0]) =>
    selectLevelSections(resolveEffectiveLevels(args));

  test("a stored pre-reader is unchanged: K register plus turn rules", () => {
    expect(
      pick({
        isSyntheticView: false,
        session: {},
        scholar: { readingLevel: PRE_READER_LEVEL },
      }),
    ).toEqual(sections("preReader", true, false));
  });

  test("talk 7 + listener scholar → grade-7 register, voice delivery", () => {
    expect(
      pick({
        isSyntheticView: false,
        session: {},
        scholar: { readingLevel: "7", readLevel: "listener" },
      }),
    ).toEqual(sections("generic", true, true));
  });

  test("a talk override of 5 on a K listener changes the register, not the delivery", () => {
    const levels = resolveEffectiveLevels({
      isSyntheticView: false,
      session: { readingLevelOverride: "5" },
      scholar: { readingLevel: "K", readLevel: "listener" },
    });
    expect(levels).toEqual({ talk: "5", read: "listener", write: "own" });
    expect(selectLevelSections(levels)).toEqual(sections("generic", true, true));
  });

  test("a read override changes delivery and keeps the talk register", () => {
    expect(
      pick({
        isSyntheticView: false,
        session: { readLevelOverride: "reader" },
        scholar: { readingLevel: "K", readLevel: "listener" },
      }),
    ).toEqual(sections("earlyReader", true, false));
  });
});

// ── buildLevelsSection: exactly the chosen builders, in order ────────

describe("buildLevelsSection", () => {
  test("register, then turn rules, then the delivery add-ons", () => {
    expect(buildLevelsSection({ talk: "7", read: "listener", write: "voice" })).toBe(
      buildGenericReadingLevelSection("7") +
        buildYoungReaderTurnRules() +
        buildListenerDeliverySection() +
        buildWriteByVoiceSection(),
    );
    expect(buildLevelsSection({ talk: "7", read: "beginner", write: "own" })).toBe(
      buildGenericReadingLevelSection("7") +
        buildYoungReaderTurnRules() +
        buildBeginnerReaderSection(beginnerAlphabet([])),
    );
    expect(buildLevelsSection({ talk: "K", read: "listener", write: "own" })).toBe(
      buildPreReaderSection() + buildYoungReaderTurnRules(),
    );
    expect(buildLevelsSection({ talk: "2", read: "reader", write: "own" })).toBe(
      buildEarlyReaderSection("2") + buildYoungReaderTurnRules(),
    );
    expect(buildLevelsSection({ talk: "7", read: "reader", write: "own" })).toBe(
      buildGenericReadingLevelSection("7"),
    );
    expect(buildLevelsSection({ talk: null, read: "reader", write: "own" })).toBe("");
  });
});

// ── Wiring: the assembled prompt carries the slot, cached ────────────

describe("buildSystemPrompt — the levels slot", () => {
  // `readWrite` is the trailing positional param; everything between the six
  // required leading args and it takes its default (undefined).
  const READ_WRITE_INDEX = 54;
  const parts = (
    readingLevel: string | null,
    readWrite: { read: ReadLevel; write: WriteMode } | null,
  ) => {
    const args: unknown[] = new Array(READ_WRITE_INDEX + 1).fill(undefined);
    args.splice(0, 6, null, readingLevel, "Kai", null, null, null);
    args[READ_WRITE_INDEX] = readWrite;
    return (
      buildSystemPromptParts as unknown as (
        ...a: unknown[]
      ) => ReturnType<typeof buildSystemPromptParts>
    )(...args);
  };
  // If a param is ever added before readWrite, the talk-7 listener test fails
  // (the delivery section goes missing): the guard on READ_WRITE_INDEX.

  test("talk 7 + listener: the slot sits in the cached stable prefix", () => {
    const { stable, dynamic } = parts("7", { read: "listener", write: "own" });
    const slot = buildLevelsSection({ talk: "7", read: "listener", write: "own" });
    expect(stable).toContain(slot);
    expect(stable).not.toContain(buildPreReaderSection());
    expect(dynamic).not.toContain(buildListenerDeliverySection());
    expect(dynamic).not.toContain(buildYoungReaderTurnRules());
  });

  test("only the levels slot differs between scholars", () => {
    const build = (readingLevel: string | null) =>
      buildSystemPrompt(null, readingLevel, "Kai", null, null, null);
    const SLOT = "<<LEVELS_SLOT>>";
    const graded = build("5");
    const pre = build(PRE_READER_LEVEL);
    const none = build(null);
    expect(graded.replace(buildGenericReadingLevelSection("5"), SLOT)).toBe(
      pre.replace(buildPreReaderSection() + buildYoungReaderTurnRules(), SLOT),
    );
    // An unset level contributes nothing: removing the graded slot yields it.
    expect(graded.replace(buildGenericReadingLevelSection("5"), "")).toBe(none);
  });
});

// ── getSessionContext: the session's levels reach the tutor ─────────

describe("getSessionContext — the session's levels reach the tutor", () => {
  async function contextFor(
    user: Record<string, unknown>,
    session: Record<string, unknown>,
  ) {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Test scholar",
        username: "testscholar",
        role: "scholar",
        ...user,
      }),
    );
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "New Project",
        isArchived: false,
        ...session,
      }),
    );
    return t.query(internal.sessionHelpers.getSessionContext, { sessionId });
  }

  test("a legacy readingLevelOverride 'pre-reader' resolves to talk K + listener", async () => {
    const c = await contextFor(
      { readingLevel: "5" },
      { readingLevelOverride: PRE_READER_LEVEL },
    );
    expect(c?.readingLevel).toBe("K");
    expect(c?.readLevel).toBe("listener");
  });

  test("a readLevelOverride of listener keeps the scholar's talk level", async () => {
    const c = await contextFor(
      { readingLevel: "3", writeMode: "voice" },
      { readLevelOverride: "listener" },
    );
    expect(c?.readingLevel).toBe("3");
    expect(c?.readLevel).toBe("listener");
    expect(c?.writeMode).toBe("voice");
  });
});
