import { describe, expect, it } from "vitest";

import { resolveTargetedPractice } from "./targetedPractice";

describe("resolveTargetedPractice", () => {
  it("does not create a targeted scope without a skill parameter", () => {
    expect(resolveTargetedPractice(null, undefined)).toBeNull();
  });

  it("waits while the node lookup is loading", () => {
    expect(resolveTargetedPractice("fraction_add_like", undefined)).toBeUndefined();
  });

  it("fails loudly when the skill key is unknown", () => {
    expect(resolveTargetedPractice("not_a_real_skill", null)).toEqual({
      error: "We couldn’t find that skill. Return to your map and choose another node.",
    });
  });

  it("fails loudly when the engine has nothing to serve for the node", () => {
    expect(
      resolveTargetedPractice("concept_only", {
        node: {
          nodeKey: "concept_only",
          domain: "fraction-arithmetic",
          practiceServeable: false,
        },
      }),
    ).toEqual({ error: "That node doesn’t have practice available yet." });
  });

  it("resolves the exact skill key and its canonical domain", () => {
    expect(
      resolveTargetedPractice("fraction_add_like", {
        node: {
          nodeKey: "fraction_add_like",
          domain: "fraction-arithmetic",
          practiceServeable: true,
        },
      }),
    ).toEqual({
      domain: "fraction-arithmetic",
      skillKeys: ["fraction_add_like"],
    });
  });
});
