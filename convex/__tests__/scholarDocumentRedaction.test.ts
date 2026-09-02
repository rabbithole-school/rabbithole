import { describe, expect, test } from "vitest";
import {
  escapeControlCharsInStrings,
  findChronologicalAgeClaim,
  parseRedactionJson,
} from "../scholarDocumentActions";

// parseRedactionJson is the privacy seam: it must surface BOTH the teacher
// (score-bearing) summary and the redacted (number-free) variant, and it must
// fail loudly rather than let a document through without the redacted text —
// otherwise score-bearing content could silently reach the scholar-facing tutor.

const validPayload = JSON.stringify({
  summary: "Jamie's FSIQ is 131 (98th percentile); VCI 140.",
  keyFindings: ["FSIQ 131 — very superior", "VCI 140 vs. reading 103 gap"],
  redactedSummary:
    "Jamie's overall reasoning is very superior; verbal reasoning sits well above reading, a stealth-dyslexia pattern.",
  redactedKeyFindings: [
    "Very superior reasoning — pitch high",
    "Verbal reasoning far above reading: stealth-dyslexia gap",
  ],
});

describe("parseRedactionJson", () => {
  test("parses all four fields", () => {
    const r = parseRedactionJson(validPayload);
    expect(r.summary).toContain("131");
    expect(r.keyFindings).toHaveLength(2);
    expect(r.redactedSummary).toContain("stealth-dyslexia");
    expect(r.redactedKeyFindings).toHaveLength(2);
    // The redacted variant must not carry the scores.
    expect(r.redactedSummary).not.toMatch(/\d/);
  });

  test("rejects chronology in every generated summary field", () => {
    const payload = JSON.stringify({
      summary:
        "Avery, age 7, was assessed on 2026-01-15. The 7-year-old student earned FSIQ 131.",
      keyFindings: ["Assessed at age 7; VCI 140."],
      redactedSummary: "This is a portrait of a 7-year-old's cognition.",
      redactedKeyFindings: ["Aged 7 at testing."],
    });
    expect(() => parseRedactionJson(payload)).toThrow(
      /non-authoritative chronology/,
    );
  });

  test("strips ```json code fences", () => {
    const fenced = "```json\n" + validPayload + "\n```";
    expect(() => parseRedactionJson(fenced)).not.toThrow();
    expect(parseRedactionJson(fenced).redactedKeyFindings).toHaveLength(2);
  });

  describe("findChronologicalAgeClaim", () => {
    test.each([
      "She is 9 and reads well.",
      "She just turned 9 last month.",
      "At the time of testing she was 9.",
      "The child is currently 9.",
      "She was tested at 9 years, 3 months.",
      "Avery (b. 2017) earned FSIQ 131.",
      "DOB 03/15/2017",
      "Date of birth: March 15, 2017",
      "Born on 3/15/17",
      "Chronological age: 9-4",
      "CA 9:4 at testing",
      "ca 9:4 at testing",
      "She just turned nine.",
      "She celebrated her ninth birthday.",
    ])("detects chronology phrasing: %s", (text) => {
      expect(findChronologicalAgeClaim(text)).not.toBeNull();
    });

    test("permits age-equivalent scores, assessment dates, and other test numbers", () => {
      const text =
        "Reading age equivalent: 9 years old; language age equivalent nine years old; assessed on 2026-01-15 with FSIQ 131 at the 98th percentile.";
      expect(findChronologicalAgeClaim(text)).toBeNull();
    });
  });

  test("throws when redactedSummary is missing (privacy invariant)", () => {
    const noRedacted = JSON.stringify({
      summary: "FSIQ 131.",
      keyFindings: ["FSIQ 131"],
      redactedKeyFindings: ["very superior"],
    });
    expect(() => parseRedactionJson(noRedacted)).toThrow(/redactedSummary/);
  });

  test("throws when summary is missing", () => {
    const noSummary = JSON.stringify({
      redactedSummary: "very superior reasoning",
      redactedKeyFindings: [],
    });
    expect(() => parseRedactionJson(noSummary)).toThrow(/summary/);
  });

  test("non-array key findings degrade to empty arrays, not crashes", () => {
    const weird = JSON.stringify({
      summary: "FSIQ 131",
      keyFindings: "not an array",
      redactedSummary: "very superior",
      redactedKeyFindings: null,
    });
    const r = parseRedactionJson(weird);
    expect(r.keyFindings).toEqual([]);
    expect(r.redactedKeyFindings).toEqual([]);
  });

  test("recovers from a raw newline inside a string literal", () => {
    // The model emitted a literal newline inside `summary` (illegal JSON —
    // "Bad control character in string literal"). We should repair + parse,
    // not error, so a real eval doesn't get stuck in `error` forever.
    const withRawNewline =
      '{"summary": "Line one.\nLine two with FSIQ 128.",' +
      ' "keyFindings": ["FSIQ 128"],' +
      ' "redactedSummary": "Overall reasoning well above average.",' +
      ' "redactedKeyFindings": ["reasoning above average"]}';
    expect(() => JSON.parse(withRawNewline)).toThrow(); // precondition: raw JSON is invalid
    const r = parseRedactionJson(withRawNewline);
    expect(r.summary).toContain("Line one.");
    expect(r.summary).toContain("Line two");
    expect(r.keyFindings).toEqual(["FSIQ 128"]);
    expect(r.redactedSummary).toContain("above average");
  });

  test("recovers from raw tabs/carriage returns inside strings", () => {
    const withTabs =
      '{"summary": "Col A\tCol B\r\nrow.",' +
      ' "redactedSummary": "A structured table of results.",' +
      ' "keyFindings": [], "redactedKeyFindings": []}';
    const r = parseRedactionJson(withTabs);
    expect(r.summary).toContain("Col A");
    expect(r.redactedSummary).toContain("structured table");
  });

  test("escapeControlCharsInStrings leaves already-escaped sequences alone", () => {
    // A valid payload with a properly-escaped \n must be byte-identical after
    // the repair pass (we only touch RAW control chars, never escaped ones).
    const valid = '{"summary": "a\\nb", "redactedSummary": "x"}';
    expect(escapeControlCharsInStrings(valid)).toBe(valid);
  });

  test("escapeControlCharsInStrings ignores control chars outside strings", () => {
    // Whitespace between tokens (a raw newline outside any string) is legal
    // JSON and must be preserved untouched.
    const pretty = '{\n  "summary": "hi",\n  "redactedSummary": "yo"\n}';
    expect(escapeControlCharsInStrings(pretty)).toBe(pretty);
    expect(parseRedactionJson(pretty).summary).toBe("hi");
  });
});
