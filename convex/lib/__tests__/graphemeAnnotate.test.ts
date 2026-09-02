import { describe, expect, test } from "vitest";
import {
  normalizeTeams,
  findCandidates,
  buildAnnotationUserMessage,
  parseGraphemeToolResponse,
  selectSpans,
  validateSpans,
  annotateFromToolResult,
} from "../graphemeAnnotate";

describe("normalizeTeams", () => {
  test("trims, lowercases, dedupes preserving order", () => {
    expect(normalizeTeams([" SH ", "th", "Sh"])).toEqual(["sh", "th"]);
  });

  test("drops single letters and non-letter junk", () => {
    expect(normalizeTeams(["s", "sh", "e4", "s h", ""])).toEqual(["sh"]);
  });

  test("empty inventory → empty (the model short-circuit)", () => {
    expect(normalizeTeams([])).toEqual([]);
    // Also short-circuits when every entry is junk.
    expect(normalizeTeams(["a", "!", "1"])).toEqual([]);
  });
});

describe("findCandidates", () => {
  test("finds every case-insensitive literal occurrence, ordered by start", () => {
    const c = findCandidates("The ship is near the shore.", ["sh", "th"]);
    // "sh" in ship(@4) and shore(@21); "th" in The? no — case-insensitive "th"
    // matches "Th" in "The"(@0) and "th" in "the"(@17).
    expect(c.map((x) => `${x.team}@${x.start}`)).toEqual([
      "th@0",
      "sh@4",
      "th@17",
      "sh@21",
    ]);
    // ids are sequential in that reading order.
    expect(c.map((x) => x.id)).toEqual([0, 1, 2, 3]);
    // offsets really point at the team's letters.
    for (const cand of c) {
      expect("The ship is near the shore.".slice(cand.start, cand.end).toLowerCase()).toBe(
        cand.team,
      );
    }
  });

  test("includes FALSE surface matches (mishap) so the model can exclude them", () => {
    const c = findCandidates("That was a mishap.", ["sh"]);
    expect(c).toHaveLength(1);
    expect(c[0].start).toBe(13); // the "sh" inside mis|hap
  });

  test("non-overlapping per team, left to right", () => {
    // "shush" = s h u s h → "sh" at 0..2 and 3..5.
    const c = findCandidates("shush", ["sh"]);
    expect(c.map((x) => x.start)).toEqual([0, 3]);
  });

  test("empty inventory → no candidates (no model call)", () => {
    expect(findCandidates("anything at all", [])).toEqual([]);
  });

  test("no literal occurrence → no candidates (no model call)", () => {
    expect(findCandidates("the quick brown fox", ["oo", "igh"])).toEqual([]);
  });

  test("longer team ordered before a shorter overlapping team at same start", () => {
    // both "tch" and "ch" present; at the "ch" inside "tch" they share an end.
    const c = findCandidates("watch", ["ch", "tch"]);
    // "tch"@2 and "ch"@3 — different starts, ordered by start.
    expect(c.map((x) => `${x.team}@${x.start}`)).toEqual(["tch@2", "ch@3"]);
  });
});

describe("validateSpans — offset validation (the hard guarantee)", () => {
  const text = "The ship is near the shore.";

  test("valid span accepted", () => {
    const spans = validateSpans(text, [{ start: 4, end: 6, team: "sh" }]);
    expect(spans).toEqual([{ start: 4, end: 6, team: "sh" }]);
  });

  test("mismatched-letters span dropped", () => {
    // Claims "th" at 4..6 but those letters are "sh" → dropped.
    const spans = validateSpans(text, [{ start: 4, end: 6, team: "th" }]);
    expect(spans).toEqual([]);
  });

  test("out-of-range / inverted spans dropped", () => {
    expect(
      validateSpans(text, [
        { start: -1, end: 2, team: "th" },
        { start: 26, end: 40, team: "sh" },
        { start: 6, end: 4, team: "sh" },
      ]),
    ).toEqual([]);
  });

  test("overlapping spans resolved — earlier/longer kept, overlap dropped", () => {
    // "sea" at 0..3 and "ea" at 1..3 overlap; keep the earlier-start longer one.
    const t = "sea otter";
    const spans = validateSpans(t, [
      { start: 1, end: 3, team: "ea" },
      { start: 0, end: 3, team: "sea" },
    ]);
    expect(spans).toEqual([{ start: 0, end: 3, team: "sea" }]);
  });

  test("adjacent (touching, non-overlapping) spans both kept", () => {
    const t = "ooze"; // "oo"@0..2 and "ze"? use "sh"+"ea": "shea"
    const t2 = "shea"; // sh@0..2, ea@2..4 touch but don't overlap
    expect(validateSpans(t2, [
      { start: 0, end: 2, team: "sh" },
      { start: 2, end: 4, team: "ea" },
    ])).toEqual([
      { start: 0, end: 2, team: "sh" },
      { start: 2, end: 4, team: "ea" },
    ]);
    // silence unused-var lint on t
    expect(t).toBe("ooze");
  });

  test("result is sorted by start and team is lowercased", () => {
    const spans = validateSpans(text, [
      { start: 21, end: 23, team: "SH" },
      { start: 0, end: 2, team: "Th" },
    ]);
    expect(spans).toEqual([
      { start: 0, end: 2, team: "th" },
      { start: 21, end: 23, team: "sh" },
    ]);
  });

  test("junk team string dropped even if letters happen to match", () => {
    // single-letter "team" is not a valid team → dropped.
    expect(validateSpans("apple", [{ start: 0, end: 1, team: "a" }])).toEqual([]);
  });
});

describe("selectSpans", () => {
  const candidates = findCandidates("The ship is near the shore.", ["sh", "th"]);

  test("maps chosen ids back to spans; unknown ids ignored; deduped", () => {
    const spans = selectSpans(candidates, [1, 3, 999, 1]);
    expect(spans).toEqual([
      { start: 4, end: 6, team: "sh" },
      { start: 21, end: 23, team: "sh" },
    ]);
  });

  test("empty selection → no spans", () => {
    expect(selectSpans(candidates, [])).toEqual([]);
  });
});

describe("parseGraphemeToolResponse", () => {
  test("no tool_use block → null (annotate nothing)", () => {
    expect(parseGraphemeToolResponse([{ type: "text" }])).toBeNull();
  });

  test("extracts integer ids, filtering junk", () => {
    expect(
      parseGraphemeToolResponse([
        {
          type: "tool_use",
          input: { trueTeamIds: [0, 2, 3.5, "x", null] },
        },
      ]),
    ).toEqual([0, 2]);
  });

  test("missing/!array trueTeamIds → empty list", () => {
    expect(
      parseGraphemeToolResponse([{ type: "tool_use", input: {} }]),
    ).toEqual([]);
  });
});

describe("annotateFromToolResult — end-to-end (candidates + ids → validated spans)", () => {
  test("true digraphs kept, false surface match excluded", () => {
    const text = "The ship shows a mishap.";
    const candidates = findCandidates(text, ["sh"]);
    // ship@4, shows@9, mishap's sh@19. Model marks the first two true.
    const trueIds = candidates
      .filter((c) => c.start === 4 || c.start === 9)
      .map((c) => c.id);
    const spans = annotateFromToolResult(text, candidates, trueIds);
    expect(spans).toEqual([
      { start: 4, end: 6, team: "sh" },
      { start: 9, end: 11, team: "sh" },
    ]);
    // the mishap "sh" was never selected → not present.
    expect(spans.some((s) => s.start === 19)).toBe(false);
  });

  test("empty inventory path yields no spans", () => {
    const candidates = findCandidates("anything", []);
    expect(annotateFromToolResult("anything", candidates, [])).toEqual([]);
  });
});

describe("buildAnnotationUserMessage", () => {
  test("lists the text and each candidate with delimited match + word", () => {
    const text = "a shell";
    const candidates = findCandidates(text, ["sh"]);
    const msg = buildAnnotationUserMessage(text, candidates);
    expect(msg).toContain("TEXT:");
    expect(msg).toContain("a shell");
    expect(msg).toContain('«sh»');
    expect(msg).toContain('(in "shell")');
    expect(msg).toContain("[0] team \"sh\"");
  });
});
