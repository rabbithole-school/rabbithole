/**
 * Outcome probe (adoptable #1, review/sim-realism-lessons.html §5) — the pure
 * item-generation, deterministic grading, wiring, and prompt/parse helpers. No
 * model call: the sim kid answering an item is INJECTED (askPre/askPost), so we
 * mock it and assert the grading is deterministic and judge-free.
 *
 * Covers: templated-only skill resolution, isomorphic + deterministic pre/post
 * pairs, deterministic grading of a known item, runProbe wiring with a mocked
 * sim-kid answer, graceful skip when no skills resolve, per-variant mean, and
 * the buildProbeAnswerPrompt / extractProbeAnswer prompt helpers.
 */
import { describe, expect, test } from "vitest";
import {
  resolveProbeSkills,
  buildProbePairs,
  gradeProbeItem,
  summarizeProbe,
  runProbe,
  meanProbe,
  type ProbeItem,
} from "../lib/curriculumProbe";
import { generateItem } from "../lib/practice/templates";
import { parseItemId } from "../lib/practice/session";
import { formatAnswer } from "../lib/practice/answers";
import {
  buildProbeAnswerPrompt,
  extractProbeAnswer,
  type SimProfile,
} from "../lib/curriculumSimShared";

const SKILL = "add_within_20_no_regroup";
const SKILL2 = "subtract_within_10";
const NOT_A_SKILL = "definitely_not_a_real_skill";

const PROFILE: SimProfile = {
  name: "Cog",
  readingLevel: "Grade 4",
  dossier: "9 years old. Reads well; shaky with quantities.",
  traits: ["goes off on tangents"],
  archetype: "strong-reader-weak-number-sense",
};

/**
 * Re-derive the correct answer for a probe item from its itemId — exactly what
 * the deterministic grader does internally. Test-only: proves grading needs no
 * judge, just the template.
 */
function correctAnswerFor(itemId: string): string {
  const parsed = parseItemId(itemId);
  if (!parsed) throw new Error(`unparseable itemId: ${itemId}`);
  const item = generateItem(parsed.skillKey, parsed.seed, parsed.form);
  if (!item) throw new Error(`no item for ${itemId}`);
  return formatAnswer(item.answer);
}

describe("resolveProbeSkills", () => {
  test("keeps only templated skills, deduped, order preserved", () => {
    expect(resolveProbeSkills([SKILL, NOT_A_SKILL, SKILL, SKILL2])).toEqual([
      SKILL,
      SKILL2,
    ]);
  });

  test("empty when nothing resolves", () => {
    expect(resolveProbeSkills([])).toEqual([]);
    expect(resolveProbeSkills([NOT_A_SKILL])).toEqual([]);
  });
});

describe("buildProbePairs — isomorphic + deterministic", () => {
  test("each pair shares a skill but uses distinct items (isomorphic)", () => {
    const pairs = buildProbePairs([SKILL], 12345, 3);
    expect(pairs).toHaveLength(3);
    for (const pair of pairs) {
      // Same template → same structure.
      expect(pair.pre.skillKey).toBe(SKILL);
      expect(pair.post.skillKey).toBe(SKILL);
      // Different seed → different numbers (distinct item + stem).
      expect(pair.pre.itemId).not.toBe(pair.post.itemId);
      expect(pair.pre.stem).not.toBe(pair.post.stem);
    }
  });

  test("round-robins across multiple skills", () => {
    const pairs = buildProbePairs([SKILL, SKILL2], 42, 3);
    const skills = pairs.map((p) => p.skillKey);
    expect(skills).toEqual([SKILL, SKILL2, SKILL]);
  });

  test("deterministic in the seed", () => {
    expect(buildProbePairs([SKILL], 777, 3)).toEqual(
      buildProbePairs([SKILL], 777, 3),
    );
  });

  test("threads fraction answerShape while integer probes stay flat", () => {
    const [fractionPair] = buildProbePairs(["fraction_as_division"], 17, 1);
    expect(fractionPair.pre).toMatchObject({
      skillKey: "fraction_as_division",
      answerType: "expression",
      answerShape: "twoD",
    });
    expect(fractionPair.post).toMatchObject({ answerShape: "twoD" });

    const [integerPair] = buildProbePairs([SKILL], 17, 1);
    expect(integerPair.pre).not.toHaveProperty("answerShape");
    expect(integerPair.post).not.toHaveProperty("answerShape");
  });

  test("empty (graceful skip) when no skill resolves", () => {
    expect(buildProbePairs([NOT_A_SKILL], 1)).toEqual([]);
    expect(buildProbePairs([], 1)).toEqual([]);
  });
});

describe("gradeProbeItem — deterministic, no judge", () => {
  test("grades a known item correctly and rejects a wrong answer", () => {
    const [pair] = buildProbePairs([SKILL], 999, 1);
    const right = correctAnswerFor(pair.pre.itemId);
    expect(gradeProbeItem(pair.pre, right)).toBe(true);
    expect(gradeProbeItem(pair.pre, "99999")).toBe(false);
    expect(gradeProbeItem(pair.pre, "")).toBe(false);
  });

  test("grades the extracted answer of a realistic kid reply", () => {
    const [pair] = buildProbePairs([SKILL], 555, 1);
    const right = correctAnswerFor(pair.post.itemId);
    const reply = `hmm let me think... i'll add them up\nANSWER: ${right}`;
    expect(gradeProbeItem(pair.post, extractProbeAnswer(reply))).toBe(true);
  });
});

describe("summarizeProbe", () => {
  test("computes pre/post/delta and per-item correctness", () => {
    const pairs = buildProbePairs([SKILL], 314, 2);
    const preAnswers = pairs.map(() => "99999"); // all wrong before
    const postAnswers = pairs.map((p) => correctAnswerFor(p.post.itemId)); // all right after
    const summary = summarizeProbe(pairs, preAnswers, postAnswers);

    expect(summary.itemsPerProbe).toBe(2);
    expect(summary.preScore).toBe(0);
    expect(summary.postScore).toBe(1);
    expect(summary.delta).toBe(1);
    expect(summary.skills).toEqual([SKILL]);
    expect(summary.items).toHaveLength(2);
    for (const it of summary.items) {
      expect(it.preCorrect).toBe(false);
      expect(it.postCorrect).toBe(true);
      expect(it.preStem).not.toBe(it.stem); // isomorphic pre/post
    }
  });

  test("missing answers grade as incorrect", () => {
    const pairs = buildProbePairs([SKILL], 8, 1);
    const summary = summarizeProbe(pairs, [undefined], [null]);
    expect(summary.preScore).toBe(0);
    expect(summary.postScore).toBe(0);
    expect(summary.delta).toBe(0);
  });
});

describe("runProbe — wired into a session run (mocked sim-kid answer)", () => {
  test("cold-wrong pre, learned-correct post → positive delta", async () => {
    const pairs = buildProbePairs([SKILL, SKILL2], 2024, 3);
    const askedPre: string[] = [];
    const askedPost: string[] = [];

    // The sim kid: wrong on every PRE item, correct on every POST item.
    const askPre = async (item: ProbeItem) => {
      askedPre.push(item.itemId);
      return "0"; // deliberately wrong
    };
    const askPost = async (item: ProbeItem) => {
      askedPost.push(item.itemId);
      return correctAnswerFor(item.itemId);
    };

    const summary = await runProbe(pairs, askPre, askPost);

    // Every pre + post item was answered by the (mock) kid — no other calls.
    expect(askedPre).toEqual(pairs.map((p) => p.pre.itemId));
    expect(askedPost).toEqual(pairs.map((p) => p.post.itemId));
    expect(summary.preScore).toBe(0);
    expect(summary.postScore).toBe(1);
    expect(summary.delta).toBe(1);
    expect(summary.items.every((it) => !it.preCorrect && it.postCorrect)).toBe(true);
  });

  test("no learning → zero delta", async () => {
    const pairs = buildProbePairs([SKILL], 111, 2);
    const wrong = async () => "88888";
    const summary = await runProbe(pairs, wrong, wrong);
    expect(summary.delta).toBe(0);
    expect(summary.postScore).toBe(0);
  });
});

describe("meanProbe", () => {
  test("null when nothing to aggregate", () => {
    expect(meanProbe([])).toBeNull();
  });

  test("means pre/post/delta across sessions", () => {
    const mean = meanProbe([
      { preScore: 0, postScore: 1, delta: 1 },
      { preScore: 0.5, postScore: 0.5, delta: 0 },
    ]);
    expect(mean).toEqual({ preScore: 0.25, postScore: 0.75, delta: 0.5, n: 2 });
  });
});

describe("buildProbeAnswerPrompt / extractProbeAnswer", () => {
  const item = { stem: "7 + 5 = ?", answerType: "integer" as const };

  test("PRE probe is cold — persona present, no session context", () => {
    const { system, user } = buildProbeAnswerPrompt(PROFILE, item);
    expect(system).toContain("Cog");
    expect(system).toContain("Grade 4");
    expect(user).toContain("7 + 5 = ?");
    expect(user).not.toContain("just finished");
  });

  test("POST probe folds in the finished session transcript", () => {
    const { user } = buildProbeAnswerPrompt(PROFILE, item, {
      activityTitle: "Adding Up",
      transcript: [
        { role: "tutor", content: "What happens when you combine them?" },
        { role: "scholar", content: "I count on from the bigger one." },
      ],
    });
    expect(user).toContain("just finished");
    expect(user).toContain("Adding Up");
    expect(user).toContain("count on from the bigger one");
  });

  test("multipleChoice items render numbered choices", () => {
    const { user } = buildProbeAnswerPrompt(PROFILE, {
      stem: "Which is bigger?",
      answerType: "multipleChoice",
      choices: ["less than (<)", "equal (=)", "greater than (>)"],
    });
    expect(user).toContain("0) less than (<)");
    expect(user).toContain("2) greater than (>)");
    expect(user).toContain("NUMBER of your choice");
  });

  test("extractProbeAnswer pulls the last ANSWER: line, else the last line", () => {
    expect(extractProbeAnswer("thinking hard\nANSWER: 42")).toBe("42");
    expect(extractProbeAnswer("ANSWER: 3/8")).toBe("3/8");
    expect(extractProbeAnswer("ANSWER: 1\nwait no\nANSWER: 2")).toBe("2");
    expect(extractProbeAnswer("no tag here\njust 12")).toBe("just 12");
  });
});
