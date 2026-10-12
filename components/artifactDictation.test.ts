import { describe, expect, test } from "vitest";
import { insertDictatedText } from "./ArtifactPanel";

// The scholar's writing box gained a dictation mic (the tutor's typing
// accommodation was retired). Speech is spliced through the same save path as
// typing; this covers only the caret/spacing math that decides WHERE it lands.
describe("insertDictatedText", () => {
  test("appends after the last word when there is no caret", () => {
    expect(insertDictatedText("The fox", "ran home", null)).toEqual({
      content: "The fox ran home",
      caret: "The fox ran home".length,
    });
  });

  test("does not add a leading space onto empty content", () => {
    expect(insertDictatedText("", "hello world", null)).toEqual({
      content: "hello world",
      caret: "hello world".length,
    });
  });

  test("preserves a trailing paragraph break instead of spacing over it", () => {
    expect(insertDictatedText("Para one.\n", "Para two.", null)).toEqual({
      content: "Para one.\nPara two.",
      caret: "Para one.\nPara two.".length,
    });
  });

  test("splices at the caret and pads only against non-whitespace", () => {
    // Caret sits after "The " (index 4) — the leading space is already there,
    // so only a trailing space is added before "dog".
    expect(insertDictatedText("The dog", "big", { start: 4, end: 4 })).toEqual({
      content: "The big dog",
      caret: "The big".length,
    });
  });

  test("replaces the selected range", () => {
    expect(insertDictatedText("The old dog", "new", { start: 4, end: 7 })).toEqual({
      content: "The new dog",
      caret: "The new".length,
    });
  });

  test("handles a backwards selection", () => {
    expect(insertDictatedText("abcdef", "X", { start: 5, end: 2 })).toEqual({
      content: "ab X f",
      caret: 4,
    });
  });

  test("leaves content untouched when the transcript is blank", () => {
    expect(insertDictatedText("hi", "   ", null)).toEqual({ content: "hi", caret: 2 });
  });
});
