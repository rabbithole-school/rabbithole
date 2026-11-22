import { describe, expect, test } from "vitest";
import {
  areaHighestClause,
  areaLevelEvidence,
  areaLevelLine,
  areaSummaryLine,
  areaSourcesClause,
  areaTermClause,
  checkDraft,
  fluentSkillItem,
  gradeAdjective,
  mathPaceLines,
  monthsInWords,
  overallMathEvidence,
  overallMathPositionLine,
  overallMathSourceLine,
  progressIntoGrade,
  SOURCE_SPLIT_MOSTLY,
  SOURCE_SPLIT_ALMOST_ALL_MINORITY,
  sourceSplitPhrase,
  termFluencyLine,
  withArticle,
  type AreaLevelInput,
} from "../lib/parentReport";
import type { LearnedPace, MathLevel } from "../lib/practice/frontierGrade";

/**
 * The overall-math evidence lines a Math parent report gets: position against
 * the enrolled grade, where the picture comes from, and pace for the term.
 */

const level = (value: number, over: Partial<MathLevel> = {}): MathLevel => ({
  value,
  baseValue: 0,
  dailyValue: value / 2,
  placementValue: value / 2,
  dailySkills: 40,
  placementSkills: 25,
  solidThroughRank: Math.floor(value) - 1,
  bands: [],
  ...over,
});

// Mid-November, local time (the grade equivalent reads Date.getMonth()): a
// third grader's grade equivalent is 3.4.
const NOV = new Date(2026, 10, 15).getTime();
const APR = new Date(2027, 3, 15).getTime();

const pace = (over: Partial<LearnedPace> = {}): LearnedPace => ({
  learnedMonths: 7,
  knownMonths: 4,
  learnedSkills: 20,
  knownSkills: 12,
  schoolMonths: 3,
  pace: 7 / 3,
  ...over,
});

describe("overall math position", () => {
  test("above grade level names the enrolled grade and the solid-through grade, with no decimal", () => {
    const line = overallMathPositionLine(level(6.7, { solidThroughRank: 5 }), 3, NOV)!;
    expect(line).toBe(
      "Across all math areas together: above grade level for third grade, the child's grade this year. Solid through fifth grade.",
    );
    expect(line).not.toMatch(/\d\.\d/);
  });

  test("nothing solid yet: the open skills start at kindergarten", () => {
    expect(overallMathPositionLine(level(3.4, { solidThroughRank: null }), 3, NOV)).toBe(
      "Across all math areas together: at grade level for third grade, the child's grade this year. Some kindergarten skills are still open.",
    );
  });

  test("solid through is named only from the grade below the enrolled one up", () => {
    // Enrolled third: solid through second is the boundary and is kept.
    expect(overallMathPositionLine(level(3.4, { solidThroughRank: 2 }), 3, NOV)).toMatch(/ Solid through second grade\.$/);
    expect(overallMathPositionLine(level(3.4, { solidThroughRank: 3 }), 3, NOV)).toMatch(/ Solid through third grade\.$/);
    // Solid through first: the open skills start in second grade.
    const line = overallMathPositionLine(level(3.4, { solidThroughRank: 1 }), 3, NOV)!;
    expect(line).toBe(
      "Across all math areas together: at grade level for third grade, the child's grade this year. Some second-grade skills are still open.",
    );
    expect(line).not.toMatch(/Solid through/);
    // Solid through kindergarten for a second grader: first-grade skills open.
    expect(overallMathPositionLine(level(2.4, { solidThroughRank: 0 }), 2, NOV)).toMatch(/Some first-grade skills are still open\.$/);
  });

  test("below hands the sentence to the teacher as a placeholder, never asserting it", () => {
    const line = overallMathPositionLine(level(2.3, { solidThroughRank: 1 }), 3, NOV)!;
    expect(line).toBe(
      'Across all math areas together: the record can\'t say yet how this compares with third-grade math. Write "[how this child\'s math compares with third-grade expectations]" for the teacher to fill in.',
    );
    expect(line).not.toMatch(/below|Solid through|still open/i);
  });

  test("kindergarten is worded as kindergarten", () => {
    expect(overallMathPositionLine(level(1.4, { solidThroughRank: 0 }), 0, NOV)).toBe(
      "Across all math areas together: above grade level for kindergarten, the child's grade this year. Solid through kindergarten.",
    );
    expect(overallMathPositionLine(level(0.5, { solidThroughRank: null }), 0, NOV)).toBe(
      "Across all math areas together: at grade level for kindergarten, the child's grade this year. Some kindergarten skills are still open.",
    );
  });

  test("no line without an enrolled grade or a level", () => {
    expect(overallMathPositionLine(level(4), null, NOV)).toBeNull();
    expect(overallMathPositionLine(level(4), -1, NOV)).toBeNull();
    expect(overallMathPositionLine(null, 3, NOV)).toBeNull();
    expect(overallMathEvidence(null, 3, NOV, pace())).toEqual([]);
  });

  test("uses the skills matrix's bands against the grade equivalent at the window's end", () => {
    // Level 4.0 for a third grader: 0.6 past the November grade equivalent
    // (ahead), 0.1 past the April one (on pace).
    expect(overallMathPositionLine(level(4, { solidThroughRank: null }), 3, NOV)).toMatch(/above grade level/);
    expect(overallMathPositionLine(level(4, { solidThroughRank: null }), 3, APR)).toMatch(/at grade level/);
    // On pace runs down to half a grade below; past that is the placeholder.
    expect(overallMathPositionLine(level(2.9, { solidThroughRank: null }), 3, NOV)).toMatch(/at grade level/);
    expect(overallMathPositionLine(level(2.8, { solidThroughRank: null }), 3, NOV)).toMatch(/\[how this child's math compares/);
  });
});

describe("where the picture comes from", () => {
  test("the split in words, then both counts", () => {
    expect(overallMathSourceLine(level(4))).toBe(
      "Where this picture comes from: about half from daily practice and half from the placement check-in (40 skills observed in daily practice work, 25 skills credited from the placement check-in).",
    );
  });

  test("one source only", () => {
    expect(overallMathSourceLine(level(4, { placementSkills: 0, dailySkills: 1 }))).toBe(
      "Where this picture comes from: all from daily practice (1 skill observed in daily practice work).",
    );
    expect(overallMathSourceLine(level(4, { dailySkills: 0 }))).toBe(
      "Where this picture comes from: all from the placement check-in (25 skills credited from the placement check-in).",
    );
  });

  test("almost all: one source under 10% of the credited skills", () => {
    expect(SOURCE_SPLIT_ALMOST_ALL_MINORITY).toBe(0.1);
    expect(sourceSplitPhrase(9, 91)).toBe("almost all from the placement check-in");
    expect(sourceSplitPhrase(10, 90)).toBe("mostly from the placement check-in");
    expect(sourceSplitPhrase(91, 9)).toBe("almost all from daily practice");
    expect(sourceSplitPhrase(90, 10)).toBe("mostly from daily practice");
  });

  test("the split's cut-offs: about half from 35% to 65% of skills from daily practice", () => {
    expect(SOURCE_SPLIT_MOSTLY).toBe(0.65);
    expect(sourceSplitPhrase(66, 34)).toBe("mostly from daily practice");
    expect(sourceSplitPhrase(65, 35)).toBe("about half from daily practice and half from the placement check-in");
    expect(sourceSplitPhrase(50, 50)).toBe("about half from daily practice and half from the placement check-in");
    expect(sourceSplitPhrase(35, 65)).toBe("about half from daily practice and half from the placement check-in");
    expect(sourceSplitPhrase(34, 66)).toBe("mostly from the placement check-in");
    expect(sourceSplitPhrase(5, 172)).toBe("almost all from the placement check-in");
    expect(sourceSplitPhrase(1, 0)).toBe("all from daily practice");
    expect(sourceSplitPhrase(0, 1)).toBe("all from the placement check-in");
    expect(sourceSplitPhrase(0, 0)).toBeNull();
    expect(overallMathSourceLine(level(4, { dailySkills: 0, placementSkills: 0 }))).toBeNull();
  });
});

describe("pace", () => {
  test("months round to whole or half months", () => {
    expect(monthsInWords(0.2)).toBe("less than half a month");
    expect(monthsInWords(0.6)).toBe("about half a month");
    expect(monthsInWords(1.1)).toBe("about 1 month");
    expect(monthsInWords(3.3)).toBe("about 3 and a half months");
    expect(monthsInWords(6.8)).toBe("about 7 months");
  });

  test("faster than the expected pace, with what was already known", () => {
    expect(mathPaceLines(pace())).toEqual([
      "Pace: about 7 months of new math learned in about 3 months of school, faster than the expected pace of one month of curriculum per month of school.",
      "Already known: about 4 months of curriculum were skills the child already knew and has now shown this term. These are not new learning.",
    ]);
  });

  test("about the expected pace, and no already-known line when it rounds to nothing", () => {
    const lines = mathPaceLines(pace({ learnedMonths: 3.3, schoolMonths: 3, pace: 1.1, knownMonths: 0.1 }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/, about the expected pace of one month/);
  });

  test("slower than the expected pace", () => {
    expect(mathPaceLines(pace({ learnedMonths: 1.5, schoolMonths: 3, pace: 0.5 }))[0]).toMatch(
      /about 1 and a half months of new math learned in about 3 months of school, slower than the expected pace/,
    );
  });

  test("a child who joined partway through the term: the window is said first, the pace lines follow unchanged", () => {
    const lines = mathPaceLines(pace(), "2026-11-01");
    expect(lines[0]).toMatch(/^Joined: .*2026-11-01.*only the time since then/);
    expect(lines.slice(1)).toEqual(mathPaceLines(pace()));
    expect(mathPaceLines(null, "2026-11-01")[0]).toMatch(/^Joined:/);
  });

  test("the band edges: 1.25 is faster, 0.75 is about expected", () => {
    expect(mathPaceLines(pace({ pace: 1.25 }))[0]).toMatch(/faster than/);
    expect(mathPaceLines(pace({ pace: 0.75 }))[0]).toMatch(/about the expected pace/);
  });

  test("under the fluent-skill floor: the count stated, too few for a pace, and no pace", () => {
    expect(mathPaceLines(pace({ learnedSkills: 4, knownSkills: 3 }))).toEqual([
      "Pace: 7 skills reached fluency in daily practice this term, too few to state a pace. Say nothing about pace, and nothing about how much the child practised: few new fluent skills can also mean the child spent the term reviewing skills already known.",
    ]);
    expect(mathPaceLines(pace({ learnedSkills: 1, knownSkills: 0 }))[0]).toMatch(/ 1 skill reached fluency/);
    expect(mathPaceLines(null)).toEqual([
      "Pace: 0 skills reached fluency in daily practice this term, too few to state a pace. Say nothing about pace, and nothing about how much the child practised: few new fluent skills can also mean the child spent the term reviewing skills already known.",
    ]);
    // At the floor the pace is stated.
    expect(mathPaceLines(pace({ learnedSkills: 5, knownSkills: 3 }))[0]).toMatch(/^Pace: about/);
  });

  test("withheld when the term is too short for a rate", () => {
    expect(mathPaceLines(pace({ pace: null }))).toEqual([
      "Pace: too little of the term has passed to state a pace. Say nothing about pace.",
    ]);
  });

  test("the whole group, in order", () => {
    const lines = overallMathEvidence(level(3.5, { solidThroughRank: 2 }), 3, NOV, pace({ learnedSkills: 2, knownSkills: 1 }));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Across all math areas together: at grade level/);
    expect(lines[1]).toMatch(/^Where this picture comes from/);
    expect(lines[2]).toMatch(/^Pace: 3 skills reached fluency .* too few to state a pace/);
  });
});

describe("draft check on pace wording", () => {
  test("a multiplier or percentage pace is flagged; months and arithmetic are not", () => {
    const flagged = /multiplier or percentage/;
    expect(checkDraft("Ada is learning at 2x the expected pace.").join("\n")).toMatch(flagged);
    expect(checkDraft("Ada is learning at 2.3 times the standard pace.").join("\n")).toMatch(flagged);
    expect(checkDraft("Ada learns twice the expected pace.").join("\n")).toMatch(flagged);
    expect(checkDraft("Ada worked at 150% of the expected pace.").join("\n")).toMatch(flagged);
    expect(checkDraft("Ada learned about 7 months of new math in about 3 months of school.").join("\n")).not.toMatch(flagged);
    expect(checkDraft("Ada can now solve 3 x 4 in her head.", "she/her").join("\n")).not.toMatch(flagged);
  });
});

describe("review findings: few fluent skills, draft checks, joined line", () => {
  test("few newly fluent skills is stated as a count, never as little practice", () => {
    const [line] = mathPaceLines(pace({ learnedSkills: 4, knownSkills: 3 }));
    expect(line).not.toMatch(/little (math )?practice/i);
    expect(line).toMatch(/\b7 skills\b/);
    expect(line).toMatch(/say nothing about pace/i);
  });
  test("decimal grades and multipliers in other word orders are flagged", () => {
    for (const bad of ["She works at a 6.9-grade level.", "Ada is at 6.9 grade in fractions.", "Ada learns twice as fast as expected.", "Ada moves two times as fast.", "Ada learns 1.5x faster than expected."]) {
      expect(checkDraft(bad, "she/her").length, bad).toBeGreaterThan(0);
    }
    for (const fine of ["Ada works on grade 6 fractions.", "Ada is working on sixth grade skills.", "Ada learned about 4 and a half months of new math in about 3 months of school."]) {
      expect(checkDraft(fine, "she/her"), fine).toEqual([]);
    }
  });
  test("a mid-term joiner with nothing credited still gets the Joined line", () => {
    expect(overallMathEvidence(null, 3, Date.UTC(2026, 10, 21), null, "2026-11-01")[0]).toMatch(/^Joined: .*2026-11-01/);
    expect(overallMathEvidence(null, 3, Date.UTC(2026, 10, 21), null)).toEqual([]);
  });
});

describe("how far into a grade", () => {
  test("five steps over one grade's own share, with none reading as just starting", () => {
    expect(progressIntoGrade(0)).toBe("just starting on");
    expect(progressIntoGrade(0.1)).toBe("just starting on");
    expect(progressIntoGrade(0.125)).toBe("about a quarter of the way through");
    expect(progressIntoGrade(0.3)).toBe("about a quarter of the way through");
    expect(progressIntoGrade(0.375)).toBe("about halfway through");
    expect(progressIntoGrade(0.6)).toBe("about halfway through");
    expect(progressIntoGrade(0.625)).toBe("most of the way through");
    expect(progressIntoGrade(0.875)).toBe("through nearly all of");
    expect(progressIntoGrade(0.99)).toBe("through nearly all of");
  });

  test("grade adjectives", () => {
    expect(gradeAdjective(0)).toBe("kindergarten");
    expect(gradeAdjective(7)).toBe("seventh-grade");
    expect(gradeAdjective(13)).toBe("grade-13");
  });

  test("the article before a grade word", () => {
    expect(withArticle("eighth-grade level")).toBe("an eighth-grade level");
    expect(withArticle("eleventh-grade skill")).toBe("an eleventh-grade skill");
    expect(withArticle("seventh-grade level")).toBe("a seventh-grade level");
    expect(withArticle("kindergarten level")).toBe("a kindergarten level");
    expect(withArticle("grade-8 level")).toBe("a grade-8 level");
    expect(areaHighestClause(4.6, 8.2)).toBe("Has also shown an eighth-grade skill in daily practice.");
  });
});

/** Bands for a level with no credit above its open grade: every grade below
 *  complete, the level's own grade covered by its decimal part (in hundredths). */
const contiguousBands = (levelValue: number) => {
  const whole = Math.floor(levelValue + 1e-9);
  return [
    ...Array.from({ length: whole }, (_, rank) => ({ rank, total: 100, daily: 100, placement: 0 })),
    { rank: whole, total: 100, daily: Math.round((levelValue - whole) * 100), placement: 0 },
  ];
};

const area = (over: Partial<AreaLevelInput> = {}): AreaLevelInput => {
  const levelValue = over.levelValue ?? 4.6;
  return {
    label: "Fractions",
    levelValue,
    highestValue: 4.9,
    dailySkills: 12,
    placementSkills: 5,
    learnedThisTerm: 3,
    knownThisTerm: 4,
    topCatalogRank: 6,
    bands: contiguousBands(levelValue),
    ...over,
  };
};

describe("within-grade wording follows that grade's own coverage (cross-family review)", () => {
  // K-4 complete, two-thirds of grade 5, none of grade 6, all of grade 7: the
  // level adds up to 6.67, but no grade-6 skill is credited.
  const gapped = [0, 1, 2, 3, 4].map((rank) => ({ rank, total: 3, daily: 3, placement: 0 })).concat([
    { rank: 5, total: 3, daily: 2, placement: 0 },
    { rank: 6, total: 3, daily: 0, placement: 0 },
    { rank: 7, total: 3, daily: 3, placement: 0 },
  ]);
  test("credit above the first open grade is never worded as progress through the summed grade", () => {
    const line = areaLevelLine(area({ levelValue: 6 + 2 / 3, highestValue: 7.9, bands: gapped, topCatalogRank: 8 }));
    expect(line).not.toMatch(/sixth/);
    expect(line).toMatch(/through fourth grade/);
    expect(line).toMatch(/fifth grade/);
    expect(line).toMatch(/seventh grade/);
  });
  test("contiguous coverage keeps the whole grade and how far into it", () => {
    expect(areaLevelLine(area())).toMatch(/^Fractions: working at a fourth-grade level, about halfway through that grade's skills here\./);
  });
});

describe("each math area's line", () => {
  test("the full line: whole grade, how far in, both sources, the term's split; no decimal", () => {
    const line = areaLevelLine(area());
    expect(line).toBe(
      "Fractions: working at a fourth-grade level, about halfway through that grade's skills here. 12 skills shown in daily practice and 5 credited from the placement check-in. This term: 3 skills new to the child this term reached fluency, along with 4 skills the child already knew and has now shown.",
    );
    expect(line).not.toMatch(/\d\.\d/);
  });

  test("the highest figure only when its whole grade is above the level's", () => {
    expect(areaHighestClause(4.6, 7.2)).toBe("Has also shown a seventh-grade skill in daily practice.");
    expect(areaHighestClause(4.6, 4.9)).toBeNull();
    expect(areaHighestClause(4.6, 3.9)).toBeNull();
    expect(areaHighestClause(4.6, null)).toBeNull();
    expect(areaHighestClause(4.0, 5.0)).toBe("Has also shown a fifth-grade skill in daily practice.");
    expect(areaLevelLine(area({ highestValue: 6.1 }))).toMatch(/here\. Has also shown a sixth-grade skill in daily practice\. 12 skills/);
  });

  test("an area with only placement credit says so plainly", () => {
    expect(
      areaLevelLine(area({ dailySkills: 0, placementSkills: 6, levelValue: 3.0, highestValue: null, learnedThisTerm: 0, knownThisTerm: 0 })),
    ).toBe(
      "Fractions: placed at a third-grade level by the placement check-in (6 skills credited), just starting on that grade's skills here. No skills shown in daily practice in this area yet.",
    );
    expect(areaLevelLine(area({ label: "Algebra 1", dailySkills: 0, placementSkills: 1, levelValue: 8.0, topCatalogRank: 9 }))).toBe(
      "Algebra 1: placed at an eighth-grade level by the placement check-in (1 skill credited), just starting on that grade's skills here. No skills shown in daily practice in this area yet.",
    );
    expect(areaLevelLine(area({ levelValue: 8.5, highestValue: 8.5, topCatalogRank: 9 }))).toMatch(/^Fractions: working at an eighth-grade level/);
  });

  test("a finished area has covered every skill and is never 'just starting' the next grade", () => {
    const line = areaLevelLine(area({ levelValue: 7, highestValue: 6.9, topCatalogRank: 6 }));
    expect(line).toBe(
      "Fractions: has covered every fractions skill through sixth grade. 12 skills shown in daily practice and 5 credited from the placement check-in. This term: 3 skills new to the child this term reached fluency, along with 4 skills the child already knew and has now shown.",
    );
    expect(line).not.toMatch(/seventh|just starting/);
    // Just short of the end is not finished.
    expect(areaLevelLine(area({ levelValue: 6.95, topCatalogRank: 6 }))).toMatch(/^Fractions: working at a sixth-grade level, through nearly all of/);
    // Finished by the placement check-in alone.
    expect(areaLevelLine(area({ label: "Algebra 1", levelValue: 10, topCatalogRank: 9, dailySkills: 0, placementSkills: 30, learnedThisTerm: 0, knownThisTerm: 0 }))).toBe(
      "Algebra 1: has covered every algebra 1 skill through ninth grade. 30 skills credited from the placement check-in. No skills shown in daily practice in this area yet.",
    );
    // No catalog top known: never finished.
    expect(areaLevelLine(area({ levelValue: 7, topCatalogRank: null }))).toMatch(/working at a seventh-grade level/);
  });

  test("sources: both, daily only, placement only, none", () => {
    expect(areaSourcesClause(12, 5)).toBe("12 skills shown in daily practice and 5 credited from the placement check-in.");
    expect(areaSourcesClause(1, 0)).toBe("1 skill shown in daily practice.");
    expect(areaSourcesClause(0, 1)).toBe("1 skill credited from the placement check-in.");
    expect(areaSourcesClause(0, 0)).toBeNull();
  });

  test("the term's split with zero on either side", () => {
    expect(areaTermClause(0, 0)).toBe("This term: no skills in this area turned fluent.");
    expect(areaTermClause(2, 0)).toBe("This term: 2 skills new to the child this term reached fluency.");
    expect(areaTermClause(0, 1)).toBe(
      "This term: 1 skill reached fluency, all skills the child already knew and has now shown. None were new learning.",
    );
    expect(areaTermClause(1, 1)).toBe(
      "This term: 1 skill new to the child this term reached fluency, along with 1 skill the child already knew and has now shown.",
    );
  });

  test("no line says a grade was moved up", () => {
    expect(areaLevelLine(area({ levelValue: 5.1, learnedThisTerm: 9 }))).not.toMatch(/moved up|up from/i);
  });
});

describe("the summary above the area lines", () => {
  test("one area", () => {
    expect(areaSummaryLine([area()])).toBe(
      "Summary of 1 area: The one area is at a fourth-grade level. Most new learning this term: Fractions (3 skills new).",
    );
    expect(areaSummaryLine([])).toBeNull();
    expect(areaLevelEvidence([])).toEqual([]);
  });

  test("three areas: the range, the most new learning, and the placement-only area", () => {
    const areas = [
      area({ label: "Whole-number arithmetic", levelValue: 5.2, learnedThisTerm: 2 }),
      area({ label: "Fractions", levelValue: 4.6, learnedThisTerm: 5 }),
      area({ label: "Algebra 1", levelValue: 8.0, dailySkills: 0, placementSkills: 1, learnedThisTerm: 0, knownThisTerm: 0, topCatalogRank: 9 }),
    ];
    expect(areaSummaryLine(areas)).toBe(
      "Summary of 3 areas: Areas with daily practice range from fourth-grade to fifth-grade level. Most new learning this term: Fractions (5 skills new) and Whole-number arithmetic (2 skills new). Resting on the placement check-in alone, with no daily practice yet: Algebra 1 (eighth-grade level).",
    );
    const lines = areaLevelEvidence(areas);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(areaSummaryLine(areas));
    expect(lines[3]).toBe(areaLevelLine(areas[2]));
  });

  test("nine areas: at most two named for new learning, ties broken by curriculum order, placement-only areas together", () => {
    const areas = [
      area({ label: "A1", levelValue: 7.0, learnedThisTerm: 4 }),
      area({ label: "A2", levelValue: 6.5, learnedThisTerm: 9 }),
      area({ label: "A3", levelValue: 6.9, learnedThisTerm: 4 }),
      area({ label: "A4", levelValue: 5.2, learnedThisTerm: 1 }),
      area({ label: "A5", levelValue: 6.0, learnedThisTerm: 0 }),
      area({ label: "A6", levelValue: 5.8, learnedThisTerm: 0 }),
      area({ label: "A7", levelValue: 7.1, learnedThisTerm: 2 }),
      area({ label: "A8", levelValue: 8.0, dailySkills: 0, learnedThisTerm: 0, knownThisTerm: 0, topCatalogRank: 9 }),
      area({ label: "A9", levelValue: 7.2, dailySkills: 0, learnedThisTerm: 0, knownThisTerm: 0, topCatalogRank: 9 }),
    ];
    expect(areaSummaryLine(areas)).toBe(
      "Summary of 9 areas: Areas with daily practice range from fifth-grade to sixth-grade level. Most new learning this term: A2 (9 skills new) and A1 (4 skills new). Resting on the placement check-in alone, with no daily practice yet: A8 (eighth-grade level) and A9 (seventh-grade level).",
    );
  });

  test("the range leaves out areas resting on the placement check-in alone", () => {
    const top = area({ label: "Algebra 1", levelValue: 8.0, dailySkills: 0, placementSkills: 1, learnedThisTerm: 0, knownThisTerm: 0, topCatalogRank: 9 });
    const areas = [
      area({ label: "Whole-number arithmetic", levelValue: 5.2, learnedThisTerm: 0 }),
      area({ label: "Probability", levelValue: 6.4, learnedThisTerm: 0 }),
      top,
    ];
    expect(areaSummaryLine(areas)).toBe(
      "Summary of 3 areas: Areas with daily practice range from fifth-grade to sixth-grade level. Resting on the placement check-in alone, with no daily practice yet: Algebra 1 (eighth-grade level).",
    );
    expect(areaSummaryLine(areas)).not.toMatch(/to eighth-grade/);
  });

  test("several areas with daily practice at one grade beside a placement-only area", () => {
    const areas = [
      area({ levelValue: 5.2, learnedThisTerm: 0 }),
      area({ label: "Probability", levelValue: 5.9, learnedThisTerm: 0 }),
      area({ label: "Geometry & measurement", levelValue: 3.1, dailySkills: 0, learnedThisTerm: 0, knownThisTerm: 0 }),
    ];
    expect(areaSummaryLine(areas)).toBe(
      "Summary of 3 areas: All 2 areas with daily practice are at a fifth-grade level. Resting on the placement check-in alone, with no daily practice yet: Geometry & measurement (third-grade level).",
    );
  });

  test("exactly one area with daily practice: that area's level, never a range", () => {
    const areas = [
      area({ label: "Fractions", levelValue: 4.2, dailySkills: 0, learnedThisTerm: 0, knownThisTerm: 0 }),
      area({ label: "Whole-number arithmetic", levelValue: 6.3, learnedThisTerm: 2 }),
      area({ label: "Geometry & measurement", levelValue: 3.5, dailySkills: 0, learnedThisTerm: 0, knownThisTerm: 0 }),
    ];
    expect(areaSummaryLine(areas)).toBe(
      "Summary of 3 areas: Whole-number arithmetic, the one area with daily practice, is at a sixth-grade level. Most new learning this term: Whole-number arithmetic (2 skills new). Resting on the placement check-in alone, with no daily practice yet: Fractions (fourth-grade level) and Geometry & measurement (third-grade level).",
    );
  });

  test("no area with daily practice: said in place of a range", () => {
    const areas = [
      area({ label: "Fractions", levelValue: 4.2, dailySkills: 0, learnedThisTerm: 0, knownThisTerm: 0 }),
      area({ label: "Geometry & measurement", levelValue: 3.5, dailySkills: 0, learnedThisTerm: 0, knownThisTerm: 0 }),
    ];
    expect(areaSummaryLine(areas)).toBe(
      "Summary of 2 areas: No area has daily practice yet; every level below comes from the placement check-in. Resting on the placement check-in alone, with no daily practice yet: Fractions (fourth-grade level) and Geometry & measurement (third-grade level).",
    );
    expect(areaSummaryLine([areas[0]])).toBe(
      "Summary of 1 area: No area has daily practice yet; every level below comes from the placement check-in. Resting on the placement check-in alone, with no daily practice yet: Fractions (fourth-grade level).",
    );
  });

  test("no new learning: no most-new-learning sentence", () => {
    const areas = [area({ learnedThisTerm: 0 }), area({ label: "Probability", levelValue: 4.1, learnedThisTerm: 0 })];
    expect(areaSummaryLine(areas)).toBe("Summary of 2 areas: All 2 areas are at a fourth-grade level.");
  });

  test("a finished area counts at its top catalog grade in the range", () => {
    const areas = [
      area({ label: "Probability", levelValue: 8, topCatalogRank: 7, learnedThisTerm: 0 }),
      area({ label: "Fractions", levelValue: 5.5, learnedThisTerm: 0 }),
    ];
    expect(areaSummaryLine(areas)).toBe("Summary of 2 areas: Areas range from fifth-grade to seventh-grade level.");
    expect(areaSummaryLine([areas[0]])).toBe("Summary of 1 area: The one area is at a seventh-grade level.");
    expect(areaSummaryLine([area({ levelValue: 8.3, learnedThisTerm: 0, topCatalogRank: 9 })])).toBe(
      "Summary of 1 area: The one area is at an eighth-grade level.",
    );
  });
});

describe("the term's fluent skills", () => {
  test("the count, split into learned and already known", () => {
    expect(termFluencyLine(0, 0)).toBeNull();
    expect(termFluencyLine(3, 0)).toBe("3 skills reached fluency in daily practice this term, all new to the child this term.");
    expect(termFluencyLine(0, 1)).toBe(
      "1 skill reached fluency in daily practice this term, all skills the child already knew and has now shown. None were new learning.",
    );
    expect(termFluencyLine(5, 7)).toBe(
      "12 skills reached fluency in daily practice this term: 5 new to the child this term and 7 the child already knew and has now shown.",
    );
  });

  test("each skill is marked new or already known", () => {
    expect(fluentSkillItem("Add unlike fractions", "4", true, "Oct 3")).toBe("Add unlike fractions (grade 4 skill): new to the child this term, fluent Oct 3");
    expect(fluentSkillItem("Count to 100", undefined, false, "Sep 9")).toBe("Count to 100: already known, now shown, fluent Sep 9");
  });
});
