import { describe, expect, it } from "vitest";
import { MIN_DISTINCT_ITEMS, mixCandidates, skillByKey, skillBySlug, slugify, worksheetSkills } from "../catalog";
import { buildSheet, paperWording, parseSheetParams } from "../sheet";
import { DEFAULT_COUNT, sheetQuery } from "../params";
import { acceptRewrites, checkRewrite, isRewritable, numerals } from "../themeRewrite";

describe("catalog", () => {
  it("gives every page a unique, plain slug and a working sheet", () => {
    const skills = worksheetSkills();
    expect(skills.length).toBeGreaterThan(300);
    const slugs = new Set(skills.map((s) => s.slug));
    expect(slugs.size).toBe(skills.length);
    expect(new Set(skills.map((s) => s.shortLabel)).size).toBe(skills.length);
    for (const s of skills) {
      expect(s.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skillBySlug(s.slug)?.skillKey).toBe(s.skillKey);
      expect(buildSheet({ skillKeys: [s.skillKey], count: MIN_DISTINCT_ITEMS, seed: 1 }).items).toHaveLength(MIN_DISTINCT_ITEMS);
    }
  });

  it("drops dangling words a symbol tail leaves behind", () => {
    expect(slugify("Compare three-digit numbers using <, =, >")).toBe("compare-three-digit-numbers");
    expect(slugify("Express whole numbers as fractions (e.g. 3 = 3/1, 1 = 4/4)")).toBe("express-whole-numbers-as-fractions");
  });

  it("offers related skills to mix, never the skill itself", () => {
    const s = skillByKey("add_subtract_unlike")!;
    const mix = mixCandidates(s);
    expect(mix.length).toBeGreaterThan(0);
    expect(mix.map((m) => m.skillKey)).not.toContain(s.skillKey);
  });
});

describe("sheet", () => {
  it("reproduces the same sheet from the same URL and a different one from a new seed", () => {
    const p = parseSheetParams("add_subtract_like", { n: "10", seed: "4821" });
    const a = buildSheet(p).items.map((i) => i.stem);
    const b = buildSheet(parseSheetParams("add_subtract_like", { n: "10", seed: "4821" })).items.map((i) => i.stem);
    const c = buildSheet({ ...p, seed: 4822 }).items.map((i) => i.stem);
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    expect(c).not.toEqual(a);
  });

  it("falls back to defaults on a mangled link and keeps the page's skill first", () => {
    const p = parseSheetParams("add_subtract_like", { n: "7", seed: "-3", skills: "nope,add_subtract_like,simplify_fractions" });
    expect(p).toEqual({ skillKeys: ["add_subtract_like", "simplify_fractions"], count: DEFAULT_COUNT, seed: 1 });
    expect(sheetQuery(p)).toBe("?skills=add_subtract_like,simplify_fractions");
  });

  it("mixes skills by interleaving them", () => {
    const sheet = buildSheet({ skillKeys: ["add_subtract_like", "simplify_fractions"], count: 6, seed: 9 });
    expect(sheet.items.map((i) => i.skillKey)).toEqual([
      "add_subtract_like",
      "simplify_fractions",
      "add_subtract_like",
      "simplify_fractions",
      "add_subtract_like",
      "simplify_fractions",
    ]);
  });

  it("never prints the answer inside the worked steps the child sees", () => {
    for (const s of worksheetSkills()) {
      for (const item of buildSheet({ skillKeys: [s.skillKey], count: 6, seed: 3 }).items) {
        if (!item.steps) continue;
        expect(item.steps.faded.length).toBeGreaterThanOrEqual(1);
        expect(item.steps.revealed.length).toBeGreaterThanOrEqual(1);
        const blank = item.steps.faded.map((f) => f.blankText).join(" ");
        if (!item.answerText.includes(" ")) expect(numerals(blank)).not.toContain(item.answerText);
      }
    }
  });

  it("rewords screen instructions for paper", () => {
    expect(paperWording("Which is greater, 6 or 0? (type the larger number)")).toBe(
      "Which is greater, 6 or 0? (write the larger number)",
    );
  });
});

describe("theme rewrite guard", () => {
  const original = "Maya has 3/4 of a pizza and eats 1/4. How much is left?";

  it("accepts a new story with the same numbers", () => {
    expect(checkRewrite(original, "A T. rex has 3/4 of a fern pie and munches 1/4. How much is left?")).toEqual({ ok: true });
  });

  it("rejects a changed, added or dropped number, number word or unit", () => {
    expect(checkRewrite(original, "A T. rex has 2/4 of a pie and eats 1/4. How much is left?").ok).toBe(false);
    expect(checkRewrite(original, "Two dinosaurs have 3/4 of a pie and eat 1/4. How much is left?").ok).toBe(false);
    expect(checkRewrite("A rope is 12 cm long. Cut 5 cm. How long is it now?", "A tail is 12 inches long. Cut 5 inches. How long is it now?").ok).toBe(false);
    expect(checkRewrite(original, "A T. rex has 3/4 of a pie and eats 1/4.").ok).toBe(false);
  });

  it("reads numerals the way people write them", () => {
    expect(numerals("1,200 rocks, 3, and −4.5 and 2/3")).toEqual(["1200", "3", "-4.5", "2/3"]);
  });

  it("keeps a problem's plain wording when the model's rewrite fails the check", () => {
    const candidates = [
      { n: 1, stem: original },
      { n: 2, stem: "Sam reads 12 pages a day for 5 days. How many pages does Sam read?" },
    ];
    const reply = `Sure! {"problems":[{"n":1,"text":"A T. rex has 3/4 of a fern pie and munches 1/4. How much is left?"},{"n":2,"text":"A raptor reads 13 pages a day for 5 days. How many pages?"}]}`;
    const { accepted, rejected } = acceptRewrites(candidates, reply);
    expect([...accepted.keys()]).toEqual([1]);
    expect(rejected).toEqual([{ n: 2, reason: "numbers changed" }]);
  });

  it("only offers word problems without pictures, tables or choices", () => {
    expect(isRewritable({ stem: original })).toBe(true);
    expect(isRewritable({ stem: "3/8 + 2/8 = ?" })).toBe(false);
    expect(isRewritable({ stem: original, choices: ["a", "b"] })).toBe(false);
  });
});
