import { describe, expect, test } from "vitest";
import { foldTitle, pickByTitle } from "../lib/unitDesignerTools";

// The Curriculum Bot re-addresses lessons/activities by TITLE on every tool
// call. On prod (2026-09-03) a lookup failed and the bot told the teacher
// "the long title didn't match — likely the ʻokina in the stored title"
// before retrying with a shorter form. These pin the folding + tiering that
// make the first attempt land.

const items = [
  { title: "Mini-lecture" },
  { title: "Mini-lecture: ABO genetics" },
  { title: "Food Detective" },
  { title: "Kalo & ʻĀina" },
  { title: "Lesson 5: Research It & Map It" },
];

describe("foldTitle", () => {
  test("drops diacritics, the ʻokina, quotes, and punctuation; reads & as and", () => {
    expect(foldTitle("Kalo & ʻĀina")).toBe("kalo and aina");
    expect(foldTitle("Kalo and 'Aina")).toBe("kalo and aina");
    expect(foldTitle("  Lesson 5:  Research It & Map It ")).toBe(
      "lesson 5 research it and map it",
    );
    expect(foldTitle("Scholar’s “Big” Idea")).toBe("scholars big idea");
  });
});

describe("pickByTitle", () => {
  test("exact beats prefix beats substring", () => {
    expect(pickByTitle(items, "mini-lecture")?.title).toBe("Mini-lecture");
    expect(pickByTitle(items, "Mini-lecture: ABO")?.title).toBe(
      "Mini-lecture: ABO genetics",
    );
    expect(pickByTitle(items, "ABO genetics")?.title).toBe(
      "Mini-lecture: ABO genetics",
    );
  });

  test("ʻokina / diacritic / ampersand variants match the stored title", () => {
    expect(pickByTitle(items, "Kalo and 'Aina")?.title).toBe("Kalo & ʻĀina");
    expect(pickByTitle(items, "kalo & aina")?.title).toBe("Kalo & ʻĀina");
    expect(pickByTitle(items, "Lesson 5: Research It and Map It")?.title).toBe(
      "Lesson 5: Research It & Map It",
    );
  });

  test("a longer query that contains the stored title resolves to it", () => {
    expect(
      pickByTitle(items, "Food Detective: research it and map it")?.title,
    ).toBe("Food Detective");
    // Longest contained title wins over a shorter one also contained.
    expect(
      pickByTitle(items, "Mini-lecture: ABO genetics (revised)")?.title,
    ).toBe("Mini-lecture: ABO genetics");
  });

  test("no match and empty query return undefined", () => {
    expect(pickByTitle(items, "Volcano lab")).toBeUndefined();
    expect(pickByTitle(items, "   ")).toBeUndefined();
    expect(pickByTitle([], "Food Detective")).toBeUndefined();
  });
});
