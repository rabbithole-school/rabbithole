import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { buildPreReaderSection, buildYoungReaderTurnRules } from "../prompts";
import { buildSystemPrompt, buildSystemPromptParts } from "../sessionHelpers";
import { resolveReadingLevel } from "../sessionContextHelpers";
import { PRE_READER_LEVEL } from "../lib/readingLevels";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// The pre-reader tier activates the K tutor register (spoken to a 4–6-year-old
// via TTS). These tests pin the register rules (§5 of the young-learners plan),
// that it REPLACES the generic reading-level sentence at the tier and ONLY at
// the tier, that a per-session override reaches it, and that swapping it in
// leaves the prompt byte-identical for every other scholar.

// The exact generic reading-level sentence master emits for a graded scholar.
// Kept verbatim here so the byte-identity test below fails loudly if the live
// wording ever drifts.
const generic = (level: string) =>
  `\n\nREADING LEVEL: The scholar's reading level is set to "${level}". Adjust your vocabulary and sentence complexity accordingly. You can still explore advanced topics, but frame explanations at this reading level.`;

// ── buildSystemPrompt: renders at the tier, absent otherwise ─────────

describe("buildSystemPrompt — pre-reader register wiring", () => {
  const build = (readingLevel: string | null) =>
    buildSystemPrompt(null, readingLevel, "Kai", null, null, null);

  test("pre-reader level → the register replaces the generic sentence", () => {
    const prompt = build(PRE_READER_LEVEL);
    expect(prompt).toContain("PRE-READER MODE");
    // The generic one-liner must NOT also appear.
    expect(prompt).not.toContain("READING LEVEL: The scholar's reading level");
  });

  test("a graded level → generic sentence, NO register", () => {
    const prompt = build("5");
    expect(prompt).toContain(generic("5"));
    expect(prompt).not.toContain("PRE-READER MODE");
  });

  test("no reading level → neither the register nor the generic sentence", () => {
    const prompt = build(null);
    expect(prompt).not.toContain("PRE-READER MODE");
    expect(prompt).not.toContain("READING LEVEL:");
  });

  test("byte-identical for non-pre-readers: only the one slot differs", () => {
    // Swapping the register in for the generic sentence must change NOTHING
    // else in the assembled prompt — proving every graded scholar's prompt is
    // untouched by this change (deliverable #3).
    const graded = build("5");
    const pre = build(PRE_READER_LEVEL);
    const SLOT = "<<READING_LEVEL_SLOT>>";
    expect(graded).toContain(generic("5"));
    expect(pre).toContain(buildPreReaderSection());
    expect(graded.replace(generic("5"), SLOT)).toBe(
      pre.replace(buildPreReaderSection() + buildYoungReaderTurnRules(), SLOT),
    );
  });
});

// ── Cache placement: scholar-stable → the CACHED stable prefix ────────

describe("pre-reader register lands in the cached stable prefix (like the generic note)", () => {
  // The reading level is scholar-stable (a per-session override is
  // session-stable too), so both variants sit ahead of the prompt-cache
  // breakpoint and are read from cache every turn (TRA-185).
  // Positional call: only scholarName + readingLevel (2nd param) are set;
  // the remaining required leading args are null.
  const parts = (readingLevel: string | null) =>
    buildSystemPromptParts(
      null, // teacherWhisper
      readingLevel, // readingLevel
      "Kai", // scholarName
      null, // unitContext
      null, // personaContext
      null, // perspectiveContext
    );

  test("the register is in `stable` (cached), not the per-turn `dynamic` tail", () => {
    const { stable, dynamic } = parts(PRE_READER_LEVEL);
    expect(stable).toContain("PRE-READER MODE");
    expect(dynamic).not.toContain("PRE-READER MODE");
  });

  test("the generic reading-level note is in `stable` too — placement matched", () => {
    const { stable, dynamic } = parts("5");
    expect(stable).toContain("READING LEVEL:");
    expect(dynamic).not.toContain("READING LEVEL:");
  });
});

// ── Override path: a per-session override activates the tier ─────────

describe("resolveReadingLevel — pre-reader override precedence", () => {
  test("a per-session readingLevelOverride of pre-reader wins over a graded scholar", () => {
    expect(
      resolveReadingLevel({
        isSyntheticView: false,
        readingLevelOverride: PRE_READER_LEVEL,
        syntheticReadingLevel: undefined,
        scholarReadingLevel: "5",
      }),
    ).toBe(PRE_READER_LEVEL);
  });

  test("the scholar's own pre-reader level resolves through with no override", () => {
    expect(
      resolveReadingLevel({
        isSyntheticView: false,
        readingLevelOverride: undefined,
        syntheticReadingLevel: undefined,
        scholarReadingLevel: PRE_READER_LEVEL,
      }),
    ).toBe(PRE_READER_LEVEL);
  });
});

describe("getSessionContext — readingLevelOverride reaches the tier", () => {
  test("session readingLevelOverride: 'pre-reader' resolves to the tier", async () => {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Test scholar",
        username: "testscholar",
        role: "scholar",
        readingLevel: "5",
      }),
    );
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "New Project",
        isArchived: false,
        readingLevelOverride: PRE_READER_LEVEL,
      }),
    );

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    // The override wins over the scholar's stored graded level, so the tutor
    // gets the K register — a teacher can test-drive it per session.
    expect(c?.readingLevel).toBe(PRE_READER_LEVEL);
  });
});
