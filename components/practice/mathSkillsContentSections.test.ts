import { describe, expect, it } from "vitest";
import {
  FACET_ORDER,
  SECTION_ORDER,
  THREAD_ORDER,
  formatFromParams,
  migrateViewParam,
  serializeFormat,
  tabFromParams,
} from "./mathSkillsContentSections";

describe("SECTION_ORDER", () => {
  it("lists the three content threads, questions first and instruction last", () => {
    expect(SECTION_ORDER).toEqual([
      "questions",
      "stories",
      "instruction",
    ]);
  });
});

describe("THREAD_ORDER (the single thread bar's display order)", () => {
  it("puts Instruction second, next to Questions (Andy's order)", () => {
    expect(THREAD_ORDER).toEqual([
      "questions",
      "instruction",
      "stories",
    ]);
  });

  it("covers exactly the three threads", () => {
    expect([...THREAD_ORDER].sort()).toEqual([...SECTION_ORDER].sort());
  });
});

describe("FACET_ORDER (the Questions thread's answer-format facet)", () => {
  it("is All · Written · Hands-on, All first (the default)", () => {
    expect(FACET_ORDER).toEqual(["all", "written", "hands-on"]);
  });
});

describe("migrateViewParam (view= is an honest tab param)", () => {
  it("maps each live thread value to itself", () => {
    expect(migrateViewParam("questions")).toBe("questions");
    expect(migrateViewParam("stories")).toBe("stories");
    expect(migrateViewParam("instruction")).toBe("instruction");
  });

  it("folds the removed Manipulatives thread — and its legacy `coverage` alias — into Questions", () => {
    expect(migrateViewParam("manipulatives")).toBe("questions");
    expect(migrateViewParam("coverage")).toBe("questions");
  });

  it("degrades an absent or unrecognised param to questions (the default)", () => {
    expect(migrateViewParam(null)).toBe("questions");
    expect(migrateViewParam("")).toBe("questions");
    expect(migrateViewParam("bogus")).toBe("questions");
  });
});

describe("formatFromParams (the answer-format facet)", () => {
  it("takes an explicit `format=` at face value", () => {
    expect(formatFromParams({ view: null, format: "all" })).toBe("all");
    expect(formatFromParams({ view: null, format: "written" })).toBe("written");
    expect(formatFromParams({ view: null, format: "hands-on" })).toBe("hands-on");
  });

  it("defaults to `all` when the facet is absent or unrecognised", () => {
    expect(formatFromParams({ view: "questions", format: null })).toBe("all");
    expect(formatFromParams({ view: "questions", format: "" })).toBe("all");
    expect(formatFromParams({ view: "questions", format: "bogus" })).toBe("all");
  });

  it("seeds Hands-on from a legacy `view=manipulatives` / `view=coverage` (no explicit format)", () => {
    expect(formatFromParams({ view: "manipulatives", format: null })).toBe("hands-on");
    expect(formatFromParams({ view: "coverage", format: null })).toBe("hands-on");
  });

  it("an explicit `format=` overrides the legacy view seed", () => {
    expect(formatFromParams({ view: "manipulatives", format: "written" })).toBe("written");
    expect(formatFromParams({ view: "manipulatives", format: "all" })).toBe("all");
  });
});

describe("serializeFormat (round-trips as ?format=)", () => {
  it("drops the param for the `all` default, writes the others verbatim", () => {
    expect(serializeFormat("all")).toBeNull();
    expect(serializeFormat("written")).toBe("written");
    expect(serializeFormat("hands-on")).toBe("hands-on");
  });

  it("round-trips written and hands-on back through formatFromParams", () => {
    expect(
      formatFromParams({ view: "questions", format: serializeFormat("written") }),
    ).toBe("written");
    expect(
      formatFromParams({ view: "questions", format: serializeFormat("hands-on") }),
    ).toBe("hands-on");
  });
});

describe("legacy URL migration lands on exactly the old view", () => {
  it("`?view=manipulatives` → Questions thread + Hands-on facet", () => {
    expect(tabFromParams({ node: null, strand: null, view: "manipulatives" })).toBe(
      "questions",
    );
    expect(formatFromParams({ view: "manipulatives", format: null })).toBe("hands-on");
  });

  it("`?view=coverage` (older alias) → Questions thread + Hands-on facet", () => {
    expect(tabFromParams({ node: null, strand: null, view: "coverage" })).toBe(
      "questions",
    );
    expect(formatFromParams({ view: "coverage", format: null })).toBe("hands-on");
  });

  it("`?node=…&view=manipulatives` → that skill, Questions thread + Hands-on facet", () => {
    expect(tabFromParams({ node: "n1", strand: null, view: "manipulatives" })).toBe(
      "questions",
    );
    expect(formatFromParams({ view: "manipulatives", format: null })).toBe("hands-on");
  });
});

describe("tabFromParams", () => {
  it("a no-node URL with strand= opens the Instruction tab", () => {
    expect(
      tabFromParams({ node: null, strand: "equivalence", view: null }),
    ).toBe("instruction");
  });

  it("view= carries the tab directly when a skill is selected", () => {
    expect(tabFromParams({ node: "n1", strand: null, view: "stories" })).toBe(
      "stories",
    );
    expect(tabFromParams({ node: "n1", strand: null, view: null })).toBe(
      "questions",
    );
  });

  it("a node WITH a strand still follows view= (strand= is the skill's own strand)", () => {
    expect(
      tabFromParams({ node: "n1", strand: "equivalence", view: "stories" }),
    ).toBe("stories");
  });

  it("no node, no strand ⇒ migrated view= (default questions)", () => {
    expect(tabFromParams({ node: null, strand: null, view: "coverage" })).toBe(
      "questions",
    );
    expect(tabFromParams({ node: null, strand: null, view: null })).toBe(
      "questions",
    );
  });
});
