import { describe, expect, test } from "vitest";
import basicDocument from "./fixtures/googleDocs/basic.json";
import legacyDocument from "./fixtures/googleDocs/legacy.json";
import structureDocument from "./fixtures/googleDocs/structure.json";
import suggestionsDocument from "./fixtures/googleDocs/suggestions.json";
import tabsDocument from "./fixtures/googleDocs/tabs.json";
import {
  buildInsertRequests,
  buildReplaceRequests,
  findExactlyOne,
  flattenTabBody,
} from "../googleDocsText";

describe("findExactlyOne", () => {
  test("distinguishes zero, one, and all repeated literal matches", () => {
    expect(findExactlyOne("alpha beta", "missing")).toEqual({ kind: "none" });
    expect(findExactlyOne("alpha beta", "beta")).toEqual({
      kind: "one",
      index: 6,
    });
    expect(findExactlyOne("target target target", "target")).toEqual({
      kind: "many",
      count: 3,
    });
  });

  test("counts non-overlapping occurrences without stopping after ambiguity", () => {
    expect(findExactlyOne("aaaaaa", "aa")).toEqual({
      kind: "many",
      count: 3,
    });
    expect(findExactlyOne("aaa", "aa")).toEqual({
      kind: "one",
      index: 0,
    });
  });

  test("is case-sensitive and rejects an empty needle", () => {
    expect(findExactlyOne("Alpha alpha", "alpha")).toEqual({
      kind: "one",
      index: 6,
    });
    expect(findExactlyOne("", "")).toEqual({
      kind: "invalid",
      reason: "empty_needle",
    });
    expect(findExactlyOne("text", "")).toEqual({
      kind: "invalid",
      reason: "empty_needle",
    });
  });
});

describe("flattenTabBody", () => {
  test("preserves paragraph newlines and maps styled TextRuns", () => {
    const flat = flattenTabBody(basicDocument, "tab-basic");

    expect(flat.text).toBe(
      "Alpha target omega\nSecond target line\nEmoji 😀 target 🎯\n",
    );
    expect(flat.text.startsWith("[[UNEDITABLE")).toBe(false);
    expect(flat.segments).toContainEqual({
      kind: "text",
      flatStart: 6,
      flatEnd: 12,
      tabId: "tab-basic",
      segmentId: "body",
      docsStartIndex: 7,
      docsEndIndex: 13,
    });
  });

  test("selects one tab even when another tab contains identical text", () => {
    const first = flattenTabBody(tabsDocument, "tab-one");
    const second = flattenTabBody(tabsDocument, "tab-two");

    expect(first.text).toBe("Shared phrase\n");
    expect(second.text).toBe(first.text);
    expect(first.segments[0]?.tabId).toBe("tab-one");
    expect(second.segments[0]?.tabId).toBe("tab-two");
    expect(findExactlyOne(first, "Shared phrase")).toEqual({
      kind: "one",
      index: 0,
    });
  });

  test("finds nested child tabs", () => {
    const child = flattenTabBody(tabsDocument, "tab-child");

    expect(child.text).toBe("Nested child\n");
    expect(child.segments[0]?.tabId).toBe("tab-child");
  });

  test("accepts legacy body-only documents", () => {
    const flat = flattenTabBody(legacyDocument, "legacy-tab");

    expect(flat.text).toBe("Legacy target\n");
    expect(flat.segments[0]?.tabId).toBe("legacy-tab");
  });

  test("emits opaque markers instead of flattening unsupported content", () => {
    const structural = flattenTabBody(structureDocument, "tab-structure");
    const suggestions = flattenTabBody(
      suggestionsDocument,
      "tab-suggestions",
    );

    expect(structural.text).toContain("[[UNEDITABLE:TABLE@14-30]]\n");
    expect(structural.text).not.toContain("Hidden cell");
    expect(suggestions.text).toBe(
      "Before [[UNEDITABLE:SUGGESTION@8-19]]\n",
    );
  });

  test("does not count text contained only in opaque boundary markers", () => {
    const structural = flattenTabBody(structureDocument, "tab-structure");

    expect(findExactlyOne(structural, "TABLE")).toEqual({ kind: "none" });
    expect(findExactlyOne(structural, "table")).toEqual({
      kind: "many",
      count: 2,
    });
  });
});

describe("buildReplaceRequests", () => {
  test("maps a match split across styled TextRuns", () => {
    const flat = flattenTabBody(basicDocument, "tab-basic");
    const match = findExactlyOne(flat, "target 🎯");
    expect(match.kind).toBe("one");
    if (match.kind !== "one") return;

    expect(
      buildReplaceRequests(flat, match.index, "target 🎯".length, "goal"),
    ).toEqual([
      {
        deleteContentRange: {
          range: {
            tabId: "tab-basic",
            startIndex: 48,
            endIndex: 57,
          },
        },
      },
      {
        insertText: {
          location: {
            tabId: "tab-basic",
            index: 48,
          },
          text: "goal",
        },
      },
    ]);
  });

  test("uses UTF-16 indexes for surrogate pairs before and inside a match", () => {
    const flat = flattenTabBody(basicDocument, "tab-basic");
    const needle = "😀 target 🎯";
    const match = findExactlyOne(flat, needle);
    expect(match).toEqual({ kind: "one", index: 44 });
    if (match.kind !== "one") return;

    expect(needle.length).toBe(12);
    expect(buildReplaceRequests(flat, match.index, needle.length, "icons")).toEqual([
      {
        deleteContentRange: {
          range: {
            tabId: "tab-basic",
            startIndex: 45,
            endIndex: 57,
          },
        },
      },
      {
        insertText: {
          location: {
            tabId: "tab-basic",
            index: 45,
          },
          text: "icons",
        },
      },
    ]);
  });

  test("maps a newline-containing match across ordinary paragraphs", () => {
    const flat = flattenTabBody(basicDocument, "tab-basic");
    const needle = "omega\nSecond";
    const match = findExactlyOne(flat, needle);
    expect(match.kind).toBe("one");
    if (match.kind !== "one") return;

    expect(buildReplaceRequests(flat, match.index, needle.length, "next")).toEqual([
      {
        deleteContentRange: {
          range: {
            tabId: "tab-basic",
            startIndex: 14,
            endIndex: 26,
          },
        },
      },
      {
        insertText: {
          location: {
            tabId: "tab-basic",
            index: 14,
          },
          text: "next",
        },
      },
    ]);
  });

  test("omits insertText for an empty-string replacement", () => {
    const flat = flattenTabBody(legacyDocument, "legacy-tab");
    const match = findExactlyOne(flat, "target");
    expect(match.kind).toBe("one");
    if (match.kind !== "one") return;

    expect(buildReplaceRequests(flat, match.index, 6, "")).toEqual([
      {
        deleteContentRange: {
          range: {
            tabId: "legacy-tab",
            startIndex: 8,
            endIndex: 14,
          },
        },
      },
    ]);
  });

  test("refuses a range crossing a table marker", () => {
    const flat = flattenTabBody(structureDocument, "tab-structure");
    const needle = "table\n[[UNEDITABLE:TABLE@14-30]]\nAfter";
    const matchIndex = flat.text.indexOf(needle);
    expect(matchIndex).toBeGreaterThanOrEqual(0);
    expect(findExactlyOne(flat, needle)).toEqual({ kind: "none" });

    expect(buildReplaceRequests(flat, matchIndex, needle.length, "unsafe")).toEqual({
      kind: "refused",
      reason: "structural_boundary",
    });
  });

  test("refuses a range crossing a mid-paragraph inline object", () => {
    const flat = flattenTabBody(structureDocument, "tab-structure");
    const needle = "Inline [[UNEDITABLE:INLINE_OBJECT@49-50]] boundary";
    const matchIndex = flat.text.indexOf(needle);
    expect(matchIndex).toBeGreaterThanOrEqual(0);
    expect(findExactlyOne(flat, needle)).toEqual({ kind: "none" });

    expect(buildReplaceRequests(flat, matchIndex, needle.length, "unsafe")).toEqual({
      kind: "refused",
      reason: "structural_boundary",
    });
  });

  test("refuses deletion of the body's final newline", () => {
    const flat = flattenTabBody(legacyDocument, "legacy-tab");
    const match = findExactlyOne(flat, "target\n");
    expect(match.kind).toBe("one");
    if (match.kind !== "one") return;

    expect(buildReplaceRequests(flat, match.index, 7, "replacement")).toEqual({
      kind: "refused",
      reason: "final_body_newline",
    });
  });

  test("refuses empty needles and disallowed C0 controls", () => {
    const flat = flattenTabBody(legacyDocument, "legacy-tab");

    expect(buildReplaceRequests(flat, 0, 0, "replacement")).toEqual({
      kind: "refused",
      reason: "empty_needle",
    });
    expect(buildReplaceRequests(flat, 0, 6, "bad\u0000text")).toEqual({
      kind: "refused",
      reason: "invalid_control_character",
    });
    expect(buildReplaceRequests(flat, 0, 6, "bad\rtext")).toEqual({
      kind: "refused",
      reason: "invalid_control_character",
    });
  });
});

describe("buildInsertRequests", () => {
  test("inserts at the beginning, middle, and end paragraph boundaries", () => {
    const flat = flattenTabBody(basicDocument, "tab-basic");

    expect(buildInsertRequests(flat, 0, "Opening")).toEqual([
      {
        insertText: {
          location: { tabId: "tab-basic", index: 1 },
          text: "Opening\n",
        },
      },
    ]);
    expect(buildInsertRequests(flat, 1, "Between")).toEqual([
      {
        insertText: {
          location: { tabId: "tab-basic", index: 19 },
          text: "\nBetween",
        },
      },
    ]);
    expect(buildInsertRequests(flat, 3, "Closing")).toEqual([
      {
        insertText: {
          location: { tabId: "tab-basic", index: 57 },
          text: "\nClosing",
        },
      },
    ]);
  });

  test("allows newlines and tabs but rejects trailing newlines and C0 controls", () => {
    const flat = flattenTabBody(legacyDocument, "legacy-tab");

    expect(buildInsertRequests(flat, 0, "First\n\tSecond")).toEqual([
      {
        insertText: {
          location: { tabId: "legacy-tab", index: 1 },
          text: "First\n\tSecond\n",
        },
      },
    ]);
    expect(buildInsertRequests(flat, 0, "Trailing\n")).toEqual({
      kind: "refused",
      reason: "trailing_newline",
    });
    expect(buildInsertRequests(flat, 0, "Bad\rtext")).toEqual({
      kind: "refused",
      reason: "invalid_control_character",
    });
    expect(buildInsertRequests(flat, 0, "Bad\u000btext")).toEqual({
      kind: "refused",
      reason: "invalid_control_character",
    });
  });

  test("refuses insertion inside or immediately beside a table", () => {
    const flat = flattenTabBody(structureDocument, "tab-structure");

    expect(buildInsertRequests(flat, 1, "Beside table")).toEqual({
      kind: "refused",
      reason: "adjacent_structure",
    });
    expect(buildInsertRequests(flat, 2, "Inside table")).toEqual({
      kind: "refused",
      reason: "structural_boundary",
    });
  });
});
