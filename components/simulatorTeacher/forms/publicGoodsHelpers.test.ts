import { describe, expect, test } from "vitest";

import {
  multiplierIssues,
  publicGoodsGoalSentence,
  totalDefaultCount,
} from "./publicGoodsHelpers";
import { validatePublicGoodsSpec } from "@/lib/simulator/templates/publicGoods";
import { defaultPublicGoodsSpec } from "./publicGoods";

function templateMeta() {
  return {
    id: "publicGoods",
    version: 1,
    senseIds: ["history"],
    actionKinds: ["withhold", "contribute"],
    metricKeys: [],
    summaryMetricKeys: [],
  };
}

describe("publicGoods multiplier constraint hints", () => {
  test("a multiplier strictly between 1 and the player count has no issues", () => {
    expect(multiplierIssues(2.4, 6)).toEqual([]);
  });

  test("flags a multiplier that is not greater than 1", () => {
    expect(multiplierIssues(1, 6)).toContain("Multiplier must be greater than 1.");
    expect(multiplierIssues(0.5, 6)).toContain("Multiplier must be greater than 1.");
  });

  test("flags a multiplier at or above the launched player count", () => {
    const issues = multiplierIssues(6, 6);
    expect(issues).toContain(
      "Multiplier must be less than the number of players launched by default (6).",
    );
  });

  test("hint set agrees with the real server validator: legal multiplier -> no issues and validateSpec passes", () => {
    const spec = defaultPublicGoodsSpec(templateMeta());
    if (spec.templateId !== "publicGoods") throw new Error("unreachable");
    expect(multiplierIssues(spec.config.multiplier, totalDefaultCount(spec.speciesSlots))).toEqual([]);
    expect(() => validatePublicGoodsSpec(spec)).not.toThrow();
  });

  test("hint set agrees with the real server validator: illegal multiplier -> issues and validateSpec throws", () => {
    const spec = defaultPublicGoodsSpec(templateMeta());
    if (spec.templateId !== "publicGoods") throw new Error("unreachable");
    const total = totalDefaultCount(spec.speciesSlots);
    const broken = { ...spec, config: { ...spec.config, multiplier: total } };
    expect(multiplierIssues(broken.config.multiplier, total).length).toBeGreaterThan(0);
    expect(() => validatePublicGoodsSpec(broken)).toThrow();
  });
});

describe("publicGoods criterion goal sentences", () => {
  test("minScore + maximize gets the catalog's plain-language phrase", () => {
    expect(publicGoodsGoalSentence("minScore", "maximize")).toBe("Lift the lowest score");
  });

  test("groupWelfare + maximize and contributionRate + maximize get their own plain phrasing", () => {
    expect(publicGoodsGoalSentence("groupWelfare", "maximize")).toBe("Grow total welfare");
    expect(publicGoodsGoalSentence("contributionRate", "maximize")).toBe("Encourage contribution");
  });

  test("a non-maximize direction falls back to a generic verb + label sentence", () => {
    expect(publicGoodsGoalSentence("minScore", "minimize")).toBe("Hold down lowest score (fairness floor)");
    expect(publicGoodsGoalSentence("contributionRate", "target")).toBe(
      "Aim for a target contribution rate",
    );
  });
});

describe("publicGoods population helpers", () => {
  test("totalDefaultCount sums every slot's defaultCount", () => {
    expect(
      totalDefaultCount([
        { defaultCount: 3 },
        { defaultCount: 2 },
      ]),
    ).toBe(5);
    expect(totalDefaultCount([])).toBe(0);
  });

  test("the default one-slot clone-village spec sums to a legal population and validates", () => {
    const spec = defaultPublicGoodsSpec(templateMeta());
    expect(spec.speciesSlots).toHaveLength(1);
    const total = totalDefaultCount(spec.speciesSlots);
    expect(total).toBeGreaterThanOrEqual(3);
    expect(() => validatePublicGoodsSpec(spec)).not.toThrow();
  });
});
