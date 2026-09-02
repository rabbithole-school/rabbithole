import { describe, it, expect } from "vitest";
import {
  deriveHandoffItem,
  buildHandoffPrompt,
  HANDOFF_MAX_ASSISTANT_TURNS,
} from "../practice/handoff";
import { makeItemId } from "../practice/session";
import { generateItem } from "../practice/templates";

describe("buildHandoffPrompt", () => {
  const p = buildHandoffPrompt({ stem: "6222 − 2722 = ?", wrongAnswers: ["4500", "3400"] });

  it("includes the stem + the kid's wrong answers", () => {
    expect(p).toContain("6222 − 2722");
    expect(p).toContain('"4500"');
    expect(p).toContain('"3400"');
  });

  it("states the tutor was NOT given the correct answer, and is an all-in partner (not a leak gate)", () => {
    expect(p).toContain("weren't given the correct answer");
    expect(p).toContain("NOT graded");
    expect(p).toContain("great thinking partner");
  });
});

describe("deriveHandoffItem + turn cap", () => {
  it("returns null for a non-template item id (endpoint rejects it)", () => {
    expect(deriveHandoffItem("definitely-not-an-item-id")).toBeNull();
    expect(deriveHandoffItem("")).toBeNull();
  });

  it("re-derives with the SAME form the scholar saw — a #missing item is NOT flattened to the direct form", () => {
    // Regression: deriveHandoffItem used to drop the form, re-deriving the
    // direct product form. For a missing-operand item ("? × 8 = 56") that would
    // hand the tutor the wrong stem entirely (the direct product form).
    const key = "mult_facts_7_8_9";
    const seed = 4242;
    const missingId = makeItemId(key, seed, "missing");
    const directId = makeItemId(key, seed);

    const missing = deriveHandoffItem(missingId)!;
    const direct = deriveHandoffItem(directId)!;

    // It matches the missing form the scholar was actually served…
    const expected = generateItem(key, seed, "missing")!;
    expect(missing.stem).toBe(expected.stem);

    // …and is genuinely the inverse form, not the direct one.
    expect(missing.stem).toContain("?");
    expect(missing.stem).not.toMatch(/= \?$/); // direct ends "= ?"; missing hides an operand
    expect(missing.stem).not.toBe(direct.stem); // withheld-operand form ≠ product form
  });

  it("caps assistant turns at 4 (roadmap §8: 2–4, then hand back)", () => {
    expect(HANDOFF_MAX_ASSISTANT_TURNS).toBe(4);
  });
});
