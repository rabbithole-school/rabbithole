import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALGEBRA_KEY_HEIGHT,
  ALGEBRA_PAD_COLUMNS,
  LANDSCAPE_COLUMN_BUDGET,
  algebraAnswerColumnHeight,
  algebraHardwareKeys,
  algebraPadHeight,
  algebraPadRows,
  type AlgebraPadKey,
} from "../algebraPad";
import {
  createAlgebraAnswerState,
  algebraAnswerApplyKey,
  algebraAnswerEditActive,
  algebraAnswerToSubmission,
  type AlgebraAnswerState,
} from "../../../vendor/shared/algebraAnswerInput";
import {
  expressionTemplateInsertEmptyFraction,
  expressionTemplateInsertExponent,
  expressionTemplateInsertGroup,
  expressionTemplateInsertLog,
  expressionTemplateInsertRoot,
  expressionTemplateInsertSquare,
  expressionTemplateInsertSquareRoot,
} from "../expressionTemplateInput";

const PALETTES = ["algebra", "complex", "logs", "sequence"] as const;

function labels(row: AlgebraPadKey[]): string[] {
  return row.map((k) => (k.kind === "spacer" ? "_" : k.kind === "op" ? `{${k.op}}` : k.label));
}

/** Drive the pad the way the component does: tap keys by their label. */
function tap(palette: (typeof PALETTES)[number], solutionSet: boolean, taps: string[]): string {
  const keys = algebraPadRows(palette, { solutionSet }).flat();
  let state: AlgebraAnswerState = createAlgebraAnswerState(solutionSet);
  const ops = {
    fraction: expressionTemplateInsertEmptyFraction,
    power: expressionTemplateInsertExponent,
    square: expressionTemplateInsertSquare,
    sqrt: expressionTemplateInsertSquareRoot,
    root: expressionTemplateInsertRoot,
    log: expressionTemplateInsertLog,
    ln: (s: Parameters<typeof expressionTemplateInsertSquare>[0]) => expressionTemplateInsertGroup(s, "ln"),
  };
  for (const t of taps) {
    const key = keys.find((k) => k.kind !== "spacer" && (k.kind === "op" ? `{${k.op}}` === t : k.label === t));
    if (!key || key.kind === "spacer") throw new Error(`no key ${t} on the ${palette} pad`);
    state =
      key.kind === "key" ? algebraAnswerApplyKey(state, key.key) : algebraAnswerEditActive(state, ops[key.op]);
  }
  return algebraAnswerToSubmission(state);
}

describe("algebra keypad layout", () => {
  it.each(PALETTES)("%s: four rows of exactly eight cells, plain item and solution set", (palette) => {
    for (const solutionSet of [false, true]) {
      const rows = algebraPadRows(palette, { solutionSet });
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row).toHaveLength(ALGEBRA_PAD_COLUMNS);
    }
  });

  it("keeps the digit block, editing keys, operators and structures where the layout says", () => {
    const rows = algebraPadRows("algebra", { solutionSet: false }).map(labels);
    expect(rows[0]).toEqual(["7", "8", "9", "(", ")", "⌫", "←", "→"]);
    expect(rows[1]).toEqual(["4", "5", "6", "+", "−", "×", "{fraction}", "{power}"]);
    expect(rows[2]).toEqual(["1", "2", "3", "x", "y", "_", "{square}", "{sqrt}"]);
    expect(rows[3]).toEqual(["0", ".", "_", "_", "_", "_", "_", "{root}"]);
  });

  it("fills the free cells with each palette's own keys, and ± for a solution set", () => {
    const free = (palette: (typeof PALETTES)[number], solutionSet: boolean) => {
      const rows = algebraPadRows(palette, { solutionSet }).map(labels);
      return [rows[2][5], ...rows[3].slice(2, 6)];
    };
    expect(free("complex", false)).toEqual(["i", "_", "_", "_", "_"]);
    expect(free("logs", true)).toEqual(["{log}", "{ln}", "e", "±", "_"]);
    expect(free("sequence", false)).toEqual(["n", "_", "_", "_", "_"]);
    expect(free("algebra", true)).toEqual(["±", "_", "_", "_", "_"]);
  });

  it("has no ÷ key and one minus key", () => {
    const all = algebraPadRows("logs", { solutionSet: true }).flat().flatMap((k) => labels([k]));
    expect(all).not.toContain("÷");
    expect(all.filter((l) => l === "−")).toHaveLength(1);
  });

  it("with a hardware keyboard keeps only what a keyboard can't type well", () => {
    expect(labels(algebraHardwareKeys("logs", { solutionSet: true }))).toEqual([
      "{fraction}", "{power}", "{square}", "{sqrt}", "{root}", "{log}", "{ln}", "±",
    ]);
    expect(labels(algebraHardwareKeys("algebra", { solutionSet: false }))).toEqual([
      "{fraction}", "{power}", "{square}", "{sqrt}", "{root}",
    ]);
  });

  it("every key has a spoken label and a unique, stable test id", () => {
    const seen = new Set<string>();
    for (const palette of PALETTES) {
      for (const k of algebraPadRows(palette, { solutionSet: true }).flat()) {
        if (k.kind === "spacer") continue;
        expect(k.a11y.length).toBeGreaterThan(2);
        expect(k.testID).toMatch(/^pad-key-[a-z0-9]+$/);
        seen.add(k.testID);
      }
    }
    expect([...seen].sort()).toEqual(
      [
        "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
        "backspace", "close", "dot", "e", "frac", "i", "left", "ln", "log", "minus", "n", "open",
        "plus", "plusminus", "pow", "right", "root", "sqrt", "square", "times", "x", "y",
      ].map((s) => `pad-key-${s}`).sort(),
    );
  });
});

describe("landscape height budget (two columns: question left, answer right)", () => {
  it("is the 820pt screen less header, Check lane, help row and stage padding", () => {
    expect(LANDSCAPE_COLUMN_BUDGET).toBe(586);
  });

  it.each(PALETTES)(
    "%s: answer box + form hint + 2-line nudge + set actions + pad fit the answer column",
    (palette) => {
      for (const solutionSet of [false, true]) {
        expect(algebraAnswerColumnHeight(palette, { solutionSet })).toBeLessThanOrEqual(LANDSCAPE_COLUMN_BUDGET);
      }
    },
  );

  it("keys stay at or above the 44pt touch floor and the pad is four rows", () => {
    expect(ALGEBRA_KEY_HEIGHT).toBeGreaterThanOrEqual(44);
    expect(480 * 0.116).toBeGreaterThanOrEqual(44); // portrait column
    expect(algebraPadHeight(4)).toBe(4 * 52 + 3 * 8);
  });
});

describe("typing Algebra 2 answers by tapping the pad", () => {
  it.each([
    ["algebra", ["(", "x", "+", "3", ")", "(", "x", "−", "2", ")"], "(x+3)(x-2)"],
    ["algebra", ["x", "{square}", "+", "3", "x", "−", "4"], "x^2+3x-4"],
    ["algebra", ["{fraction}", "x", "+", "1", "→", "x", "−", "2"], "(x+1)/(x-2)"],
    ["algebra", ["x", "{power}", "{fraction}", "2", "→", "3"], "x^(2/3)"],
    ["algebra", ["2", "{sqrt}", "3"], "2√3"],
    ["complex", ["3", "+", "2", "i"], "3+2i"],
    ["logs", ["{log}", "2", "→", "x", "+", "1"], "log_2(x+1)"],
    ["logs", ["{ln}", "x"], "ln(x)"],
    ["logs", ["e", "{power}", "2", "x"], "e^(2x)"],
    ["sequence", ["3", "(", "2", ")", "{power}", "(", "n", "−", "1"], "3(2)^(n-1)"],
    ["sequence", ["2", "{power}", "n", "−", "1"], "2^n-1"],
  ] as const)("%s: %j → %s", (palette, taps, expected) => {
    expect(tap(palette, false, [...taps])).toBe(expected);
  });

  it("a solution set with ± stays one typed answer", () => {
    expect(tap("complex", true, ["2", "±", "3", "i"])).toBe("2±3i");
  });
});

describe("wiring (source drift guards — no RN render harness here)", () => {
  const controls = readFileSync("src/components/practice/NativePracticeControls.tsx", "utf8");
  const practice = readFileSync("src/app/practice.tsx", "utf8");
  const placement = readFileSync("src/components/practice/NativePlacement.tsx", "utf8");

  it("PracticePadAnswer routes palette and solution-set items to the algebra pad", () => {
    expect(controls).toContain("usesAlgebraEditor({ answerType: props.answerType, answerPalette: props.answerPalette })");
    expect(controls).toContain("<AlgebraPadAnswer");
  });

  it("the drill and placement pass the palette, the form and the nudge, and send formNudgesUsed", () => {
    for (const src of [practice, placement]) {
      expect(src).toContain("answerPalette=");
      expect(src).toContain("answerForm=");
      expect(src).toContain("formNudge=");
      expect(src).toContain("formNudgesUsed");
      expect(src).toContain("formNudgeOf(");
    }
  });

  it("the drill's grade binding stops at a form nudge before any verdict bookkeeping", () => {
    const at = practice.indexOf("const onGrade = useCallback(");
    const nudge = practice.indexOf("receiveFormNudge(entry.itemId, nudge)", at);
    const setResult = practice.indexOf("setResult(res)", at);
    expect(nudge).toBeGreaterThan(at);
    expect(nudge).toBeLessThan(setResult);
  });

  // The grader only nudges when `formNudgesUsed` arrives, so a first submit must
  // send the number 0 — never omit it — on every path that can be nudged.
  it("a first submit sends formNudgesUsed: 0 from the drill, its mapping lane, placement, the chat item and web", () => {
    const chat = readFileSync("src/components/practice/ChatPracticeItem.tsx", "utf8");
    const web = readFileSync("../components/practice/PracticeSession.tsx", "utf8");
    // Drill: the counter defaults to 0 for an item it has not seen …
    expect(practice).toContain(
      "(itemId: string) => (formNudgesRef.current.itemId === itemId ? formNudgesRef.current.count : 0)",
    );
    // … and the outbox entry and the mapping call always pass it.
    expect(practice).toContain("formNudgesUsed: formNudgesUsedFor(current.itemId),\n        // Which list");
    expect(practice).toContain("formNudgesUsed: formNudgesUsedFor(current.itemId),\n            });");
    expect(placement).toContain("formNudgesRef.current.itemId === current.itemId ? formNudgesRef.current.count : 0");
    expect(placement).toContain("{ formNudgesUsed: used }");
    expect(chat).toContain("const formNudgesUsedRef = useRef(0);");
    expect(chat).toContain("formNudgesUsed: formNudgesUsedRef.current,");
    expect(web.match(/formNudgesRef\.current\.itemId === current\.itemId \? formNudgesRef\.current\.count : 0/g)?.length).toBe(3);
  });

  it("landscape items with a tall pad (algebra pad, box editor) use the two-column stage; everything else keeps the single column", () => {
    expect(practice).toContain('(usesAlgebraEditor(current) || current.answerShape === "twoD") &&');
    expect(practice).toContain("windowWidth > windowHeight &&");
    expect(practice).toContain("<View style={styles.twoColRight}>{stageAnswerEl}</View>");
    expect(practice).toContain("{stageQuestionEl}\n                  {stageAnswerEl}");
  });
});
