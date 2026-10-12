import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import {
  buildBeginnerReaderSection,
  buildEarlyReaderSection,
  buildYoungReaderTurnRules,
} from "../prompts";
import { buildSystemPromptParts } from "../sessionHelpers";
import type { ReadLevel, WriteMode } from "../lib/readingLevels";
import { beginnerAlphabet } from "../../shared/beginnerReading";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// READ beginner (TRA-504) adds DELIVERY rules to the reading-level slot. The
// TALK level still picks the register, so a beginner who talks at grade 5 gets
// grade-5 words, never K wording.

const READ_WRITE_INDEX = 54; // same guard as preReaderSection.test.ts
function parts(
  talk: string | null,
  readWrite: {
    read: ReadLevel;
    write: WriteMode;
    beginnerTeams?: string[];
  } | null,
  unit: Record<string, unknown> | null = null,
) {
  const args: unknown[] = new Array(READ_WRITE_INDEX + 1).fill(undefined);
  args.splice(0, 6, null, talk, "Kai", unit, null, null);
  args[READ_WRITE_INDEX] = readWrite;
  return (
    buildSystemPromptParts as unknown as (
      ...a: unknown[]
    ) => ReturnType<typeof buildSystemPromptParts>
  )(...args);
}

describe("beginner delivery rules in the reading-level slot", () => {
  const section = (teams: string[]) =>
    buildBeginnerReaderSection(beginnerAlphabet(teams));

  test("follow the talk register, in the cached prefix", () => {
    const { stable, dynamic } = parts("2", {
      read: "beginner",
      write: "own",
      beginnerTeams: ["ck", "sh"],
    });
    const register = buildEarlyReaderSection("2");
    // register, then TRA-501's turn rules, then the beginner delivery rules
    expect(stable).toContain(
      register + buildYoungReaderTurnRules() + section(["ck", "sh"]),
    );
    expect(dynamic).not.toContain("<your-turn>");
  });

  test("a grade-5 talker keeps the grade-5 note, not a K register", () => {
    const { stable } = parts("5", { read: "beginner", write: "own" });
    expect(stable).toContain('reading level is set to "5"');
    expect(stable).not.toContain("PRE-READER MODE");
    expect(stable).toContain(section([]));
  });

  test("the inventory's teams are the only teams the line may use", () => {
    expect(section(["ck", "sh"])).toContain("ck sh");
    expect(section([])).not.toContain("letter teams:");
  });

  test("reader and listener never get it", () => {
    for (const read of ["reader", "listener"] as const) {
      const { stable, dynamic } = parts("2", { read, write: "own" });
      expect(stable + dynamic).not.toContain("<your-turn>");
    }
  });
});

describe("getSessionContext — a beginner's inventory reaches the prompt", () => {
  async function contextFor(user: Record<string, unknown>, teams: string[]) {
    const t = convexTest(schema, modules);
    const userId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Test scholar",
        username: "testscholar",
        role: "scholar",
        ...user,
      }),
    );
    await t.run(async (ctx) => {
      if (teams.length === 0) return;
      await ctx.db.insert("graphemeInventories", {
        scholarId: userId,
        teams: teams.map((team, i) => ({
          team,
          stage: i === 0 ? "graduated" : "training",
        })),
        updatedAt: 0,
      });
    });
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: "New Project",
        isArchived: false,
      }),
    );
    return t.query(internal.sessionHelpers.getSessionContext, { sessionId });
  }

  test("every inventory team, graduated included, for a beginner", async () => {
    const c = await contextFor({ readingLevel: "2", readLevel: "beginner" }, [
      "ck",
      "SH",
    ]);
    expect(c?.readLevel).toBe("beginner");
    expect(c?.beginnerTeams).toEqual(["ck", "sh"]);
  });

  test("nothing for a reader", async () => {
    const c = await contextFor({ readingLevel: "2" }, ["ck"]);
    expect(c?.beginnerTeams).toEqual([]);
  });
});

describe("own Independent Study quest — young-reader planning rules", () => {
  // The scholar's own quest, still being planned (no lessons yet).
  const quest = {
    title: "Sharks",
    description: null,
    systemPrompt: null,
    rubric: null,
    youtubeUrl: null,
    videoTranscript: null,
    bigIdea: null,
    essentialQuestions: null,
    enduringUnderstandings: null,
    isOwnIsUnit: true,
    ownIsUnitOutline: [],
  };
  const MARK = "FOR THIS YOUNG READER";

  test("listener and beginner get the kid-word, ask-once planning note", () => {
    for (const read of ["listener", "beginner"] as const) {
      expect(parts("2", { read, write: "own" }, quest).stable).toContain(MARK);
    }
  });

  test("a reader's quest planning is unchanged", () => {
    expect(parts("2", { read: "reader", write: "own" }, quest).stable).not.toContain(MARK);
  });
});
