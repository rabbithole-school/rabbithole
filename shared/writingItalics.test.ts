import { describe, expect, it } from "vitest";
import {
  previewWritingItalics,
  splitWritingItalics,
  toggleWritingItalics,
} from "./writingItalics";

const join = (s: string) =>
  splitWritingItalics(s)
    .map((seg) => seg.text)
    .join("");
const italics = (s: string) =>
  splitWritingItalics(s)
    .filter((seg) => seg.kind === "italic")
    .map((seg) => seg.text);

describe("splitWritingItalics", () => {
  it("finds single-asterisk spans and round-trips the text exactly", () => {
    const s = "I read *Charlotte's Web* and saw a *Danaus plexippus* today.";
    expect(italics(s)).toEqual(["Charlotte's Web", "Danaus plexippus"]);
    expect(join(s)).toBe(s);
  });

  it("leaves bold, arithmetic, bullets and open markers alone", () => {
    for (const s of ["**bold** text", "2 * 3 * 4", "5*3*2", "3*4*5 = 60", "* a bullet", "half *open", "a ** b", "\\*not\\*"]) {
      expect(italics(s)).toEqual([]);
      expect(join(s)).toBe(s);
    }
  });

  it("does not let a span cross a line", () => {
    expect(italics("*one\ntwo*")).toEqual([]);
  });

  it("handles a one-letter span", () => {
    expect(italics("the letter *a* is short")).toEqual(["a"]);
  });
});

describe("previewWritingItalics", () => {
  it("drops markers and cuts after parsing, so a cut span stays italic", () => {
    expect(previewWritingItalics("I read *Charlotte's Web* today", 12)).toEqual([
      { kind: "text", text: "I read " },
      { kind: "italic", text: "Charl" },
    ]);
  });
});

describe("toggleWritingItalics", () => {
  it("wraps the selection and keeps it selected", () => {
    const s = "I read Holes today";
    const r = toggleWritingItalics(s, { start: 7, end: 12 });
    expect(r.content).toBe("I read *Holes* today");
    expect(r.content.slice(r.selection.start, r.selection.end)).toBe("*Holes*");
  });

  it("keeps edge spaces outside the markers", () => {
    const r = toggleWritingItalics("I read Holes today", { start: 6, end: 13 });
    expect(r.content).toBe("I read *Holes* today");
  });

  it("unwraps when the caret or selection sits inside a span", () => {
    const s = "I read *Holes* today";
    expect(toggleWritingItalics(s, { start: 10, end: 10 }).content).toBe("I read Holes today");
    expect(toggleWritingItalics(s, { start: 9, end: 11 }).content).toBe("I read Holes today");
    const r = toggleWritingItalics(s, { start: 7, end: 14 });
    expect(r.content).toBe("I read Holes today");
    expect(r.content.slice(r.selection.start, r.selection.end)).toBe("Holes");
  });

  it("drops an empty pair at the caret when nothing is selected", () => {
    const r = toggleWritingItalics("I read ", { start: 7, end: 7 });
    expect(r.content).toBe("I read **");
    expect(r.selection).toEqual({ start: 8, end: 8 });
  });

  it("press, type, press: the second press steps out instead of undoing", () => {
    const first = toggleWritingItalics("I read ", { start: 7, end: 7 });
    const typed = first.content.slice(0, 8) + "Holes" + first.content.slice(8);
    const caret = 8 + "Holes".length;
    const second = toggleWritingItalics(typed, { start: caret, end: caret });
    expect(second.content).toBe("I read *Holes*");
    expect(second.selection).toEqual({ start: caret + 1, end: caret + 1 });
  });

  it("pressing twice on an empty caret leaves nothing behind", () => {
    const first = toggleWritingItalics("ab", { start: 1, end: 1 });
    expect(toggleWritingItalics(first.content, first.selection).content).toBe("ab");
  });

  it("does nothing when the caret touches a span from outside", () => {
    expect(toggleWritingItalics("a *b* c", { start: 5, end: 5 }).content).toBe("a *b* c");
    expect(toggleWritingItalics("a *b* c", { start: 2, end: 2 }).content).toBe("a *b* c");
  });

  it("folds overlapping spans into one new span", () => {
    expect(italics(toggleWritingItalics("a *b* c", { start: 0, end: 4 }).content)).toEqual(["a b"]);
    expect(italics(toggleWritingItalics("a *b* c", { start: 0, end: 7 }).content)).toEqual(["a b c"]);
    expect(italics(toggleWritingItalics("*a* *b*", { start: 0, end: 7 }).content)).toEqual(["a b"]);
  });

  it("grows a mid-word selection to the whole word", () => {
    expect(toggleWritingItalics("I read Holes", { start: 8, end: 10 }).content).toBe("I read *Holes*");
  });

  it("keeps a list bullet outside the markers", () => {
    expect(toggleWritingItalics("* item", { start: 0, end: 6 }).content).toBe("* *item*");
    expect(toggleWritingItalics("1. item", { start: 0, end: 7 }).content).toBe("1. *item*");
  });

  it("wraps each line of a multi-line selection separately", () => {
    const r = toggleWritingItalics("one\n\ntwo", { start: 0, end: 8 });
    expect(r.content).toBe("*one*\n\n*two*");
    expect(italics(r.content)).toEqual(["one", "two"]);
  });

  it("round-trips: toggling twice restores the text", () => {
    const s = "a quick brown fox";
    const once = toggleWritingItalics(s, { start: 2, end: 7 });
    const twice = toggleWritingItalics(once.content, once.selection);
    expect(twice.content).toBe(s);
  });
});
