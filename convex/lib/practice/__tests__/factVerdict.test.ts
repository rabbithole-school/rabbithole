import { describe, expect, it } from "vitest";

import { FACT_FAMILY_SKILLS } from "../../../../shared/factKey";
import { factStemAnswer, localFactVerdict } from "../factVerdict";
import { gradeTemplateItem, makeItemId } from "../session";
import { generateItem } from "../templates";

describe("localFactVerdict", () => {
  // The drift guard: the client's verdict must agree with the server's oracle
  // on every Fast math template, for right AND wrong answers. If a template's
  // stem shape changes, this fails rather than the client silently grading
  // against a stem it no longer understands.
  it("agrees with the server grader on every fact-family template", () => {
    for (const skillKey of FACT_FAMILY_SKILLS) {
      for (let seed = 0; seed < 200; seed++) {
        const item = generateItem(skillKey, seed);
        expect(item, skillKey).not.toBeNull();
        const expected = factStemAnswer(item!.stem);
        expect(expected, item!.stem).not.toBeNull();
        const itemId = makeItemId(skillKey, seed);
        for (const raw of [String(expected), String(expected! + 1), ` ${expected} `]) {
          expect(localFactVerdict(item!, raw), `${item!.stem} ← ${raw}`).toBe(
            gradeTemplateItem(itemId, raw)!.correct,
          );
        }
      }
    }
  });

  it("has no opinion on anything but a bare, unit-free integer fact", () => {
    expect(localFactVerdict({ stem: "What is 7 × 8?", answerType: "integer" }, "56")).toBeNull();
    expect(localFactVerdict({ stem: "7 × 8 = ?", answerType: "expression" }, "56")).toBeNull();
    expect(
      localFactVerdict({ stem: "7 × 8 = ?", answerType: "integer", answerUnit: "cm" }, "56"),
    ).toBeNull();
    expect(localFactVerdict({ stem: "3/4 + 1/4 = ?", answerType: "integer" }, "1")).toBeNull();
  });

  it("parses answers the way the server does", () => {
    const item = { stem: "12 − 5 = ?", answerType: "integer" };
    expect(localFactVerdict(item, "7")).toBe(true);
    expect(localFactVerdict(item, "x = 7")).toBe(true);
    expect(localFactVerdict(item, "7.5")).toBe(false);
    expect(localFactVerdict(item, "")).toBe(false);
  });
});
