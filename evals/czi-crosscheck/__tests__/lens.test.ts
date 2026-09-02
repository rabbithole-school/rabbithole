/**
 * Offline unit tests for the CZI lens's pure logic (no API): coaching-verdict
 * parsing, grade-band drift math, and turn pairing. Canned judge outputs stand
 * in for live LLM calls so the load-bearing mapping — "manageable=0 ⇒ answer-
 * dump concern", "band floor above reading level ⇒ pitched-above flag" — is
 * pinned deterministically.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  bandFloor,
  coerceGradeBand,
  computeGradeDrift,
  pairTurns,
  parseReadingLevel,
  scoreCoachingVerdict,
} from "../lib/cziLens";
import type { TutorCase } from "../lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
function loadFixture(id: string): TutorCase {
  const raw = JSON.parse(readFileSync(join(HERE, "..", "fixtures", `${id}.json`), "utf8"));
  return { ...raw, id, source: "fixture" };
}

describe("scoreCoachingVerdict", () => {
  const dumpRaw = {
    reasoning: "The feedback is a 10-step list — far too much to act on.",
    proposed_adjustment: "Ask one question instead of listing every step.",
    manageable_score: 0,
    key_features: {
      length: { met: 0, justification: "Well over four sentences." },
      number_of_distinct_issues: { met: 0, justification: "Ten steps at once." },
      clear_priority: { met: 0, justification: "No first step signalled." },
      student_knows_next_step: { met: 0, justification: "Overwhelming." },
    },
  };

  test("manageable=0 becomes an answer-dump concern", () => {
    const v = scoreCoachingVerdict("manageable", dumpRaw);
    expect(v.score).toBe(0);
    expect(v.concern).toBe(true);
    expect(v.keyFeatures.length.met).toBe(0);
    expect(v.proposedAdjustment).toMatch(/one question/);
  });

  test("manageable=1 is not a concern", () => {
    const v = scoreCoachingVerdict("manageable", { ...dumpRaw, manageable_score: 1 });
    expect(v.score).toBe(1);
    expect(v.concern).toBe(false);
  });

  test("acknowledges-strength reads its own score key", () => {
    const v = scoreCoachingVerdict("acknowledges-strength", {
      reasoning: "Names the student's 'clouds get full' idea.",
      proposed_adjustment: "Already meets the criterion.",
      acknowledges_strength_score: 1,
      key_features: {
        presence_of_praise: { met: 1, justification: "Calls it a sharp observation." },
      },
    });
    expect(v.score).toBe(1);
    expect(v.concern).toBe(false);
    expect(v.keyFeatures.presence_of_praise.met).toBe(1);
  });

  test("throws on a missing / invalid score", () => {
    expect(() => scoreCoachingVerdict("manageable", { key_features: {} })).toThrow(
      /manageable_score/,
    );
    expect(() => scoreCoachingVerdict("manageable", { manageable_score: 2 })).toThrow();
  });
});

describe("parseReadingLevel", () => {
  test.each([
    ["7", 7],
    ["4", 4],
    ["grade 7", 7],
    ["9-10", 9.5],
    ["K", 0],
    ["kindergarten", 0],
  ])("%s → %s", (input, expected) => {
    expect(parseReadingLevel(input)).toBe(expected);
  });

  test("unknown / empty → null (never fabricate a level)", () => {
    expect(parseReadingLevel(null)).toBeNull();
    expect(parseReadingLevel("")).toBeNull();
    expect(parseReadingLevel("advanced")).toBeNull();
  });
});

describe("computeGradeDrift", () => {
  test("band floor above reading level flags pitched-above", () => {
    // Tutor language measured 9-10; scholar reads at grade 4.
    const d = computeGradeDrift("9-10", "4");
    expect(d.bandFloor).toBe(9);
    expect(d.readingGrade).toBe(4);
    expect(d.drift).toBe(5);
    expect(d.pitchedAboveReadingLevel).toBe(true);
  });

  test("well-calibrated turn (band ≈ reading level) does not flag", () => {
    const d = computeGradeDrift("4-5", "4");
    expect(d.drift).toBe(0);
    expect(d.pitchedAboveReadingLevel).toBe(false);
  });

  test("unknown reading level yields null drift, no flag", () => {
    const d = computeGradeDrift("9-10", null);
    expect(d.readingGrade).toBeNull();
    expect(d.drift).toBeNull();
    expect(d.pitchedAboveReadingLevel).toBe(false);
  });

  test("threshold is configurable", () => {
    expect(computeGradeDrift("6-8", "5", 1).pitchedAboveReadingLevel).toBe(true); // drift 1
    expect(computeGradeDrift("6-8", "5", 3).pitchedAboveReadingLevel).toBe(false); // drift 1 < 3
  });

  test("bandFloor helper", () => {
    expect(bandFloor("K-1")).toBe(0);
    expect(bandFloor("11-CCR")).toBe(11);
  });
});

describe("coerceGradeBand", () => {
  test("passes the six canonical bands through", () => {
    for (const b of ["K-1", "2-3", "4-5", "6-8", "9-10", "11-CCR"] as const) {
      expect(coerceGradeBand(b)).toBe(b);
    }
  });

  test("maps the prompt's '11-12' top-band label onto '11-CCR'", () => {
    // Finding #2: the vendored grade-level user.txt word-count table uses
    // "11-12", so accept it as an alias rather than crash the turn.
    expect(coerceGradeBand("11-12")).toBe("11-CCR");
    expect(coerceGradeBand("11")).toBe("11-CCR");
  });

  test("returns null for junk / non-strings", () => {
    expect(coerceGradeBand("middle school")).toBeNull();
    expect(coerceGradeBand(7)).toBeNull();
    expect(coerceGradeBand(null)).toBeNull();
  });
});

describe("pairTurns", () => {
  test("pairs each tutor turn with the preceding real student turn, skipping <start>", () => {
    const dump = loadFixture("answer-dump");
    const pairs = pairTurns(dump);
    // Two assistant turns: the greeting (no real student text) and the dump.
    expect(pairs.length).toBe(2);
    expect(pairs[0].studentText).toBe(""); // greeting follows only "<start>"
    expect(pairs[1].studentText).toBe("why does it rain?");
    expect(pairs[1].feedbackText).toMatch(/step by step/);
  });

  test("socratic fixture pairs the probing reply with the student's guess", () => {
    const pairs = pairTurns(loadFixture("socratic"));
    const last = pairs[pairs.length - 1];
    expect(last.studentText).toMatch(/clouds get too full/);
    expect(last.feedbackText).toMatch(/what do you think/i);
  });
});
