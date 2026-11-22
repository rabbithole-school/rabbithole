import { describe, expect, it, vi } from "vitest";

import { parseWorldRules, ruleCardEvents } from "./RuleCards";

// Hoisted above the import: the chips need neither for these pure helpers.
vi.mock("react-native", () => ({
  Pressable: "Pressable",
  StyleSheet: { create: (s: unknown) => s },
  Text: "Text",
  View: "View",
}));
vi.mock("@/theme", () => ({ fonts: {}, useColors: () => ({}) }));

describe("parseWorldRules", () => {
  it("reads APP STATE rules, showing a never/forever value as ∞", () => {
    const rules = parseWorldRules({
      rules: [
        { thing: "Rocket", name: "Launch speed", value: 11, by: "scholar" },
        { thing: "Monster", name: "Steps to escape", value: 1e24, by: "guess" },
        { thing: "Monster", name: "Gets tired", value: Infinity },
        { name: "Gravity", value: "strong" },
        { name: "No value" },
        "junk",
      ],
    });
    expect(rules).toEqual([
      { thing: "Rocket", name: "Launch speed", value: "11", by: "scholar" },
      { thing: "Monster", name: "Steps to escape", value: "∞", by: "guess" },
      { thing: "Monster", name: "Gets tired", value: "∞", by: "guess" },
      { thing: "Your world", name: "Gravity", value: "strong", by: "guess" },
    ]);
  });

  it("never throws on a doc without rules", () => {
    expect(parseWorldRules(null)).toEqual([]);
    expect(parseWorldRules({ rules: "nope" })).toEqual([]);
  });

  it("renders saved string infinity values in either spelling and sign", () => {
    const values = [" Infinity ", "iNfInItY", " ∞ ", " -Infinity ", "-infinity", " -∞ "];
    expect(
      parseWorldRules({
        rules: values.map((value) => ({ thing: "Clock", name: value, value })),
      }).map((rule) => rule.value),
    ).toEqual(["∞", "∞", "∞", "−∞", "−∞", "−∞"]);
  });
});

describe("ruleCardEvents", () => {
  const rocket = { thing: "Rocket", name: "Speed", value: "5", by: "guess" as const };
  const moon = { thing: "Moon", name: "Gravity", value: "2", by: "guess" as const };

  it("records every thing once on the first look at an app", () => {
    const events = ruleCardEvents(null, [rocket, moon], "m1", "a:1");
    expect(events.map((e) => [e.thing, e.kind])).toEqual([
      ["Rocket", "current"],
      ["Moon", "current"],
    ]);
  });

  it("chips only the thing whose rule changed, marked changed", () => {
    const events = ruleCardEvents(
      [rocket, moon],
      [{ ...rocket, value: "9", by: "scholar" }, moon],
      "m2",
      "a:2",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ thing: "Rocket", kind: "updated", afterMessageId: "m2" });
    expect(events[0].rules[0].change).toBe("changed");
  });

  it("marks a thing whose rules are all new as new, and an unchanged world as nothing", () => {
    expect(ruleCardEvents([rocket], [rocket, moon], "m3", "a:3")).toMatchObject([
      { thing: "Moon", kind: "new" },
    ]);
    expect(ruleCardEvents([rocket, moon], [rocket, moon], "m4", "a:4")).toEqual([]);
  });
});
