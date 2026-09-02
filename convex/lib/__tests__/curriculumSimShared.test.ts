/**
 * Pure unit test for scholarAvatar (convex/lib/curriculumSimShared.ts) — the
 * robot-avatar resolver behind the Auto-improve storytelling UI. No convex-test:
 * it's a pure function (robot-name lookup + deterministic by-name fallback into
 * the image pool), so it's the cheapest, highest-leverage thing to test
 * (rabbithole-test-strategy.md).
 */
import { describe, expect, test } from "vitest";
import {
  scholarAvatar,
  DEFAULT_CAST,
  ROBOT_AVATARS,
  buildKidSystem,
  describeMisconception,
  type SimActivity,
  type SimProfile,
} from "../curriculumSimShared";
import { ERROR_PATTERNS } from "../practice/errorPatterns";

const isRobotSrc = (s: string) =>
  /^\/robot-scholars\/[a-z]+\.png$/.test(s) &&
  ROBOT_AVATARS.some((r) => s === `/robot-scholars/${r}.png`);

describe("scholarAvatar", () => {
  test("returns the matching robot face for each cast member", () => {
    for (const p of DEFAULT_CAST) {
      // every default cast member is named after a robot in the pool
      expect((ROBOT_AVATARS as readonly string[]).includes(p.name.toLowerCase())).toBe(true);
      expect(scholarAvatar(p.name)).toBe(`/robot-scholars/${p.name.toLowerCase()}.png`);
    }
    // explicit spot-checks against the known robot cast
    expect(scholarAvatar("Bolt")).toBe("/robot-scholars/bolt.png");
    expect(scholarAvatar("Blip")).toBe("/robot-scholars/blip.png");
  });

  test("matches case-insensitively", () => {
    expect(scholarAvatar("BOLT")).toBe("/robot-scholars/bolt.png");
    expect(scholarAvatar("  pip  ")).toBe("/robot-scholars/pip.png");
  });

  test("falls back to a pool robot face for an unknown name", () => {
    expect(isRobotSrc(scholarAvatar("Zatanna"))).toBe(true);
    expect(isRobotSrc(scholarAvatar("Quincy"))).toBe(true);
  });

  test("is deterministic — the same name always maps to the same face", () => {
    expect(scholarAvatar("Zatanna")).toBe(scholarAvatar("Zatanna"));
    expect(scholarAvatar("Quincy")).toBe(scholarAvatar("Quincy"));
  });

  test("empty string does not throw and returns a pool robot face", () => {
    expect(() => scholarAvatar("")).not.toThrow();
    expect(isRobotSrc(scholarAvatar(""))).toBe(true);
  });
});

// ─── Adoptable #5: misconception-scripted cast ──────────────────────────

const ACTIVITY: SimActivity = {
  title: "Multi-digit addition",
  kind: "online",
  systemPrompt: "Help the scholar add two-digit numbers.",
  learningGoal: "Add two two-digit numbers with regrouping.",
};

const baseProfile: SimProfile = {
  name: "Testo",
  readingLevel: "Grade 3",
  dossier: "A test kid.",
  traits: ["shows work"],
};

// Each pattern → a short faithful anchor phrase that must appear in its
// description (tracks the detector procedures in errorPatterns.ts).
const FAITHFUL_ANCHORS: Record<(typeof ERROR_PATTERNS)[number], RegExp> = {
  SMALLER_FROM_LARGER: /smaller.*bigger|bigger.*smaller|never borrow|regroup/i,
  DROPPED_CARRY: /carry/i,
  PLACE_MISALIGNMENT: /left|line.*up|place value/i,
  OFF_BY_ONE_SKIP: /skip-count|one (jump|step) too/i,
  REMAINDER_IGNORED: /remainder|leftover/i,
  REVERSED_OPERANDS: /flip|swap|bottom number/i,
};

describe("describeMisconception", () => {
  test("returns a faithful, non-empty description for every documented pattern", () => {
    for (const pattern of ERROR_PATTERNS) {
      const desc = describeMisconception(pattern);
      expect(typeof desc).toBe("string");
      expect(desc.trim().length).toBeGreaterThan(20);
      expect(desc).toMatch(FAITHFUL_ANCHORS[pattern]);
    }
  });

  test("gives a distinct description per pattern", () => {
    const all = ERROR_PATTERNS.map(describeMisconception);
    expect(new Set(all).size).toBe(ERROR_PATTERNS.length);
  });
});

describe("buildKidSystem — misconception injection", () => {
  test("a profile WITHOUT a misconception is unchanged (no regression)", () => {
    const prompt = buildKidSystem(baseProfile, ACTIVITY);
    expect(prompt).not.toMatch(/MISCONCEPTION/i);
    expect(prompt).not.toMatch(/keep applying your buggy method/i);
  });

  test("injects the faithful buggy-algorithm description + persistence rule", () => {
    const prompt = buildKidSystem(
      { ...baseProfile, misconception: { pattern: "DROPPED_CARRY" } },
      ACTIVITY,
    );
    expect(prompt).toMatch(/MISCONCEPTION/i);
    // faithful description of THIS bug
    expect(prompt).toContain(describeMisconception("DROPPED_CARRY"));
    // persistence: does NOT drop after one correction; needs genuine re-teach
    expect(prompt).toMatch(/single correction/i);
    expect(prompt).toMatch(/genuinely understand WHY/i);
    expect(prompt).toMatch(/re-teach/i);
    expect(prompt).toMatch(/do not sycophantically drop it/i);
  });

  test("folds an optional teacher note into the block", () => {
    const prompt = buildKidSystem(
      {
        ...baseProfile,
        misconception: {
          pattern: "SMALLER_FROM_LARGER",
          note: "shows up on borrowing problems",
        },
      },
      ACTIVITY,
    );
    expect(prompt).toContain("shows up on borrowing problems");
    expect(prompt).toContain(describeMisconception("SMALLER_FROM_LARGER"));
  });

  test("carries whichever of the six patterns the profile has", () => {
    for (const pattern of ERROR_PATTERNS) {
      const prompt = buildKidSystem(
        { ...baseProfile, misconception: { pattern } },
        ACTIVITY,
      );
      expect(prompt).toContain(describeMisconception(pattern));
    }
  });
});

describe("DEFAULT_CAST — a stock run exercises a misconception", () => {
  test("at least one default cast member carries a documented misconception", () => {
    const withMisconception = DEFAULT_CAST.filter((p) => p.misconception);
    expect(withMisconception.length).toBeGreaterThanOrEqual(1);
    for (const p of withMisconception) {
      expect(ERROR_PATTERNS).toContain(p.misconception!.pattern);
    }
  });

  test("the other default cast members remain ordinary (no misconception)", () => {
    expect(DEFAULT_CAST.some((p) => !p.misconception)).toBe(true);
  });
});
