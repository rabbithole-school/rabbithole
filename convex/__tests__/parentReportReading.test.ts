import { describe, expect, test } from "vitest";
import {
  buildUnitExtract,
  formatUnitNotes,
  parseUnitReadingNotes,
  type ReadingSession,
  type UnitReadingInput,
} from "../lib/parentReportReading";
import {
  buildParentReportUserPrompt,
  checkDraft,
  datedEvidenceLine,
  pickEvidence,
  type ParentReportEvidence,
} from "../lib/parentReport";

/**
 * The parent-report reading pass (pure): the dated extract of a scholar's own
 * turns across a unit, and the code check on the reader's quotes. Fixtures are
 * fictional ("Rowan").
 */

const DAY = 24 * 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 18); // Oct 1

function session(day: number, pairs: [string | null, string][]): ReadingSession {
  const startedAt = T0 + day * DAY;
  const turns: ReadingSession["turns"] = [];
  let at = startedAt;
  for (const [ai, scholar] of pairs) {
    if (ai !== null) turns.push({ role: "ai", text: ai, at: (at += 1000) });
    turns.push({ role: "scholar", text: scholar, at: (at += 1000) });
  }
  return { startedAt, title: `Day ${day}`, turns };
}

const input: UnitReadingInput = {
  unitTitle: "Area",
  unitAsked: "Explain each area formula in writing.",
  sessions: [
    // Out of order on purpose: the extract sorts by date.
    session(40, [["Does the rule still hold for a slanted triangle?", "yes because you can move the pieces back into the rectangle"]]),
    session(0, [
      ["What do you notice?", "a triangle is always half of a rectangle"],
      [null, "I'm not sure it works for every “triangle” though"],
    ]),
    session(20, [["How many tiles?", "I think it's 24 tiles"]]),
  ],
};

describe("buildUnitExtract", () => {
  test("numbers scholar turns in date order and keeps the end of a long AI message", () => {
    const long = `${"setup ".repeat(100)}So what is the real question here?`;
    const e = buildUnitExtract({
      ...input,
      sessions: [session(0, [[long, "first answer"], [null, "second answer"]]), session(5, [["Next?", "third answer"]])],
    });
    expect(e.text).toMatch(/\[1\] Child \(Oct 1\): first answer/);
    expect(e.text).toMatch(/\[2\] Child \(Oct 1\): second answer/);
    expect(e.text).toMatch(/\[3\] Child \(Oct 6\): third answer/);
    // The AI line is clipped hard and keeps its last words (the question).
    const aiLine = e.text.split("\n").find((l) => l.startsWith("AI: …"))!;
    expect(aiLine).toMatch(/So what is the real question here\?$/);
    expect(aiLine.length).toBeLessThan(320);
    // A scholar turn right after another one has no AI line before it.
    expect(e.text).not.toMatch(/first answer\nAI:/);
    expect(e.scholarTurns).toBe(3);
    expect(e.sessionsKept).toBe(2);
  });

  test("over budget, whole sessions are kept spread across the unit, first and last always", () => {
    const sessions = Array.from({ length: 10 }, (_, i) => session(i * 3, [["Q?", `answer in session ${i} ${"x".repeat(400)}`]]));
    const all = buildUnitExtract({ ...input, sessions }, { budget: 1_000_000 });
    expect(all.sessionsKept).toBe(10);
    const e = buildUnitExtract({ ...input, sessions }, { budget: 2_000 });
    expect(e.sessionsKept).toBeLessThan(10);
    expect(e.sessionsKept).toBeGreaterThanOrEqual(2);
    expect(e.sessionsTotal).toBe(10);
    expect(e.text.length).toBeLessThanOrEqual(2_000);
    expect(e.text).toMatch(/answer in session 0 /);
    expect(e.text).toMatch(/answer in session 9 /);
    // Sessions are never cut mid-way: every kept session's turn is whole.
    expect(e.text.match(/\[\d+\] Child/g)).toHaveLength(e.sessionsKept);
  });
});

describe("parseUnitReadingNotes", () => {
  const habit = (moments: { turn: number; quote: string }[], kind = "habit") =>
    JSON.stringify({ notes: [{ kind, note: "Checks an idea against a hard case.", moments: moments.map((m) => ({ date: "Jan 1", ...m })) }] });

  test("keeps a habit with two verified quotes, tolerant of case, spacing and curly quotes, dated from the turns", () => {
    const notes = parseUnitReadingNotes(
      "```json\n" +
        habit([
          { turn: 2, quote: "not sure it works for every \"triangle\"" },
          { turn: 4, quote: "You can  move the pieces back" },
        ]) +
        "\n```",
      input,
    );
    expect(notes).toHaveLength(1);
    expect(notes[0].moments.map((m) => [m.turn, m.date])).toEqual([
      [2, "Oct 1"],
      [4, "Nov 10"],
    ]);
  });

  test("drops invented quotes, and a habit left with one verified moment", () => {
    expect(
      parseUnitReadingNotes(
        habit([
          { turn: 1, quote: "a triangle is always half of a rectangle" },
          { turn: 3, quote: "words Rowan never wrote" },
        ]),
        input,
      ),
    ).toEqual([]);
    // A real quote cited at the wrong turn is not verified either.
    expect(
      parseUnitReadingNotes(
        habit([
          { turn: 1, quote: "a triangle is always half" },
          { turn: 3, quote: "a triangle is always half" },
        ]),
        input,
      ),
    ).toEqual([]);
    // An unfinished note may stand with no moment.
    expect(parseUnitReadingNotes(habit([], "unfinished"), input)).toHaveLength(1);
  });

  test("never throws on garbage", () => {
    for (const raw of ["", "not json", "{", "null", "[]", '{"notes": 5}', '{"notes": [null, 3, {"kind": "habit"}]}'])
      expect(parseUnitReadingNotes(raw, input)).toEqual([]);
  });

  test("format lists each note with its dated quotes, without turn numbers", () => {
    const notes = parseUnitReadingNotes(
      habit([
        { turn: 1, quote: "half of a rectangle" },
        { turn: 3, quote: "24 tiles" },
      ]),
      input,
    );
    const lines = formatUnitNotes("Area", notes);
    expect(lines[0]).toBe("### Area");
    expect(lines.slice(2)).toEqual(['  - Oct 1: "half of a rectangle"', '  - Oct 21: "24 tiles"']);
  });
});

describe("dated evidence lines", () => {
  const at = Date.UTC(2026, 10, 13, 20);

  test("the date ends the line and survives clipping; a piece number stays first", () => {
    const line = datedEvidenceLine({ text: `(piece 3) ${"word ".repeat(200)}`, at }, 120);
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.startsWith("(piece 3) ")).toBe(true);
    expect(line.endsWith("… (Nov 13)")).toBe(true);
    expect(datedEvidenceLine({ text: "Short line", at }, 120)).toBe("Short line (Nov 13)");
    expect(datedEvidenceLine({ text: "Summary", at, when: "week of Nov 9" }, 120)).toBe("Summary (week of Nov 9)");
  });

  test("pickEvidence still returns the raw text (the fluency code reads it as skill keys)", () => {
    expect(pickEvidence([{ text: "add_fractions", at }, { text: "add_fractions", at: at - 1 }], 5)).toEqual(["add_fractions"]);
  });
});

describe("drafting prompt", () => {
  const evidence: ParentReportEvidence = {
    scholarFirstName: "Rowan",
    pronouns: null,
    gradeLevel: null,
    subject: "Math",
    isSel: false,
    periodLabel: "Fall",
    periodStart: "2026-08-01",
    periodEnd: "2026-12-01",
    familyGoals: [],
    pieces: [],
    groups: [
      { key: "units", label: "Units and projects this term", items: ["Area"] },
      { key: "understanding", label: "Understanding shown", items: ["Area of triangles (Nov 13)"] },
    ],
  };

  test("verified notes sit right after the units group; none means no section", () => {
    const notes = parseUnitReadingNotes(
      JSON.stringify({
        notes: [{ kind: "change", note: "Moved from a guess to a check.", moments: [
          { turn: 1, quote: "half of a rectangle" },
          { turn: 4, quote: "move the pieces back" },
        ] }],
      }),
      input,
    );
    const prompt = buildParentReportUserPrompt(evidence, [], [{ unitTitle: "Area", notes }]);
    const units = prompt.indexOf("- Area");
    const quote = prompt.indexOf('"move the pieces back"');
    const next = prompt.indexOf("Area of triangles (Nov 13)");
    expect(units).toBeGreaterThan(-1);
    expect(quote).toBeGreaterThan(units);
    expect(next).toBeGreaterThan(quote);
    expect(buildParentReportUserPrompt(evidence)).not.toMatch(/move the pieces back/);
  });

  test("the draft check still passes a clean report", () => {
    expect(checkDraft("In October Rowan guessed a rule, and by November Rowan was testing it against hard cases.")).toEqual([]);
  });
});
