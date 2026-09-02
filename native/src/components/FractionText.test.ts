import { describe, expect, test, vi } from "vitest";

// FractionText.tsx imports react-native + the theme at module load (a top-level
// StyleSheet.create). We only exercise the PURE `wrapTokens`, so stub both with
// the minimum the module touches at import time.
vi.mock("react-native", () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Text: "Text",
  View: "View",
}));
vi.mock("@/theme", () => ({
  fonts: { regular: "regular", medium: "medium", semibold: "semibold", bold: "bold" },
  useColors: () => ({ fg: "#000000", cyanSubtle: "#eef6ff", cyan: "#00aaff" }),
}));
vi.mock("../../modules/expo-math-view", () => ({ MathView: "MathView" }));

import { wrapTokens } from "./FractionText";

describe("wrapTokens — newline handling", () => {
  test("a trailing newline becomes a hard break, never a 2-line-tall token", () => {
    // The scrambled-table bug: "2\n" used to weld into a single Text two lines
    // tall, which staggered the flexWrap row. It must split into a word + break.
    expect(wrapTokens("2\n")).toEqual([{ type: "text", value: "2" }, { type: "break" }]);
  });

  test("a newline between table cells forces a break, not a welded token", () => {
    expect(wrapTokens("input | output\n1 | 2")).toEqual([
      { type: "text", value: "input " },
      { type: "text", value: "| " },
      { type: "text", value: "output" },
      { type: "break" },
      { type: "text", value: "1 " },
      { type: "text", value: "| " },
      { type: "text", value: "2" },
    ]);
  });

  test("consecutive newlines emit consecutive breaks", () => {
    expect(wrapTokens("a\n\nb")).toEqual([
      { type: "text", value: "a" },
      { type: "break" },
      { type: "break" },
      { type: "text", value: "b" },
    ]);
  });

  test("non-newline whitespace still welds onto the preceding word", () => {
    expect(wrapTokens("a  b")).toEqual([
      { type: "text", value: "a  " },
      { type: "text", value: "b" },
    ]);
  });

  test("a run with no newline yields no breaks", () => {
    expect(wrapTokens("Write 9 4/9 as ?/9")).toEqual([
      { type: "text", value: "Write " },
      { type: "text", value: "9 " },
      { type: "text", value: "4/9 " },
      { type: "text", value: "as " },
      { type: "text", value: "?/9" },
    ]);
  });

  test("a leading newline breaks before the first word", () => {
    expect(wrapTokens("\nnext")).toEqual([{ type: "break" }, { type: "text", value: "next" }]);
  });

  test("CRLF becomes exactly ONE break, never a welded \\r plus a break", () => {
    // "first\r\nsecond" used to keep "\r" welded onto "first" (a 2-line-tall RN
    // token) AND emit the explicit break — a doubled blank line on native. It
    // must normalise to a single break.
    expect(wrapTokens("first\r\nsecond")).toEqual([
      { type: "text", value: "first" },
      { type: "break" },
      { type: "text", value: "second" },
    ]);
  });

  test("a lone carriage return is one break too", () => {
    expect(wrapTokens("a\rb")).toEqual([
      { type: "text", value: "a" },
      { type: "break" },
      { type: "text", value: "b" },
    ]);
  });
});
