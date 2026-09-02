import { describe, expect, it } from "vitest";
import {
  instructionSegmentCount,
  nodeHasFacetContent,
  nodeHasThreadContent,
  parseGaps,
  serializeGaps,
  strandFacetCoverage,
  strandThreadCoverage,
  threadNoun,
} from "./mathSkillsThreadRail";

const node = (over: Partial<{ hasTemplate: boolean; itemCount: number; hasManipulative: boolean }>) => ({
  hasTemplate: false,
  itemCount: 0,
  hasManipulative: false,
  ...over,
});

describe("nodeHasThreadContent", () => {
  it("questions: a template OR any stored item counts", () => {
    expect(nodeHasThreadContent(node({ hasTemplate: true }), "questions", false)).toBe(true);
    expect(nodeHasThreadContent(node({ itemCount: 3 }), "questions", false)).toBe(true);
    expect(nodeHasThreadContent(node({}), "questions", false)).toBe(false);
  });

  it("stories: reads the caller-supplied coverage flag (nodes carry no story flag)", () => {
    expect(nodeHasThreadContent(node({}), "stories", true)).toBe(true);
    expect(nodeHasThreadContent(node({ hasManipulative: true }), "stories", false)).toBe(false);
  });

  it("instruction: always false — it is strand/segment-scoped, not per-skill", () => {
    expect(nodeHasThreadContent(node({ hasTemplate: true, hasManipulative: true }), "instruction", true)).toBe(false);
  });
});

describe("nodeHasFacetContent (the Questions thread's answer-format facet)", () => {
  it("written: a template OR any stored word item — the old Questions coverage", () => {
    expect(nodeHasFacetContent(node({ hasTemplate: true }), "written")).toBe(true);
    expect(nodeHasFacetContent(node({ itemCount: 2 }), "written")).toBe(true);
    expect(nodeHasFacetContent(node({ hasManipulative: true }), "written")).toBe(false);
    expect(nodeHasFacetContent(node({}), "written")).toBe(false);
  });

  it("hands-on: reads the manipulative flag — the old Manipulatives coverage", () => {
    expect(nodeHasFacetContent(node({ hasManipulative: true }), "hands-on")).toBe(true);
    expect(nodeHasFacetContent(node({ hasTemplate: true }), "hands-on")).toBe(false);
    expect(nodeHasFacetContent(node({}), "hands-on")).toBe(false);
  });

  it("all: either format covers the skill (the whole pool)", () => {
    expect(nodeHasFacetContent(node({ hasTemplate: true }), "all")).toBe(true);
    expect(nodeHasFacetContent(node({ itemCount: 1 }), "all")).toBe(true);
    expect(nodeHasFacetContent(node({ hasManipulative: true }), "all")).toBe(true);
    expect(nodeHasFacetContent(node({}), "all")).toBe(false);
  });
});

describe("strandThreadCoverage", () => {
  it("formats a count for stories (never a percent)", () => {
    expect(strandThreadCoverage(0, 4, "stories")).toBe("0 of 4 skills have stories");
    expect(strandThreadCoverage(5, 5, "questions")).toBe("5 of 5 skills have questions");
  });

  it("formats instruction the same way (a skill 'has instruction' when a segment applies)", () => {
    expect(strandThreadCoverage(4, 21, "instruction")).toBe("4 of 21 skills have instruction");
    expect(strandThreadCoverage(21, 21, "instruction")).toBe("21 of 21 skills have instruction");
  });

  it("uses singular wording for a one-skill strand", () => {
    expect(strandThreadCoverage(1, 1, "questions")).toBe("1 of 1 skill has questions");
  });
});

describe("strandFacetCoverage (the Questions thread's facet-aware annotation)", () => {
  it("all: keeps the 'have questions' sentence and grows a second hands-on clause", () => {
    expect(strandFacetCoverage(6, 2, 6, "all")).toBe("6 of 6 skills have questions · 2 have hands-on");
    expect(strandFacetCoverage(5, 1, 5, "all")).toBe("5 of 5 skills have questions · 1 has hands-on");
    expect(strandFacetCoverage(6, 0, 6, "all")).toBe("6 of 6 skills have questions · 0 have hands-on");
  });

  it("written: the same 'N of M skills have …' shape, narrowed to written items", () => {
    expect(strandFacetCoverage(4, 2, 6, "written")).toBe("4 of 6 skills have written items");
  });

  it("hands-on: keeps the old Manipulatives sentence shape verbatim, same denominator", () => {
    expect(strandFacetCoverage(6, 4, 12, "hands-on")).toBe("4 of 12 skills have hands-on items");
    expect(strandFacetCoverage(0, 0, 5, "hands-on")).toBe("0 of 5 skills have hands-on items");
  });
});

describe("instructionSegmentCount", () => {
  it("0 when neither the strand nor the node carries a segment (a gap)", () => {
    expect(instructionSegmentCount(false, false)).toBe(0);
  });

  it("1 when the skill only inherits its strand's segment", () => {
    expect(instructionSegmentCount(true, false)).toBe(1);
  });

  it("1 when the skill only has its own node-grain segment (strand has none)", () => {
    expect(instructionSegmentCount(false, true)).toBe(1);
  });

  it("2 when the skill inherits its strand's AND adds its own node-grain segment", () => {
    expect(instructionSegmentCount(true, true)).toBe(2);
  });
});

describe("threadNoun", () => {
  it("maps each thread to its plural rail noun", () => {
    expect(threadNoun("questions")).toBe("questions");
    expect(threadNoun("stories")).toBe("stories");
    expect(threadNoun("instruction")).toBe("instruction");
  });
});

describe("gaps= URL round-trip", () => {
  it("serialises only when ON (default drops the param)", () => {
    expect(serializeGaps(true)).toBe("1");
    expect(serializeGaps(false)).toBeNull();
  });

  it("parses 1 → true and everything else → false", () => {
    expect(parseGaps("1")).toBe(true);
    expect(parseGaps(null)).toBe(false);
    expect(parseGaps("")).toBe(false);
    expect(parseGaps("0")).toBe(false);
    expect(parseGaps("true")).toBe(false);
  });

  it("round-trips ON and OFF", () => {
    expect(parseGaps(serializeGaps(true))).toBe(true);
    expect(parseGaps(serializeGaps(false))).toBe(false);
  });
});
