import { describe, expect, test } from "vitest";
import { fixRuntimeSource, fixSource, studioFix } from "./studioFix";

/**
 * The same oracle the fixer itself uses, kept local to the test file so
 * assertions like "the repaired source genuinely parses" don't just trust
 * `result.ok` — they re-derive it independently.
 */
function parses(source: string): boolean {
  try {
    new Function('"use strict";\n' + source);
    return true;
  } catch {
    return false;
  }
}

describe("fixSource — already-correct programs are untouched", () => {
  test("a program that already parses is returned byte-for-byte unchanged", () => {
    const source = [
      "function go() {",
      "  let count = 0;",
      "  while (canGo()) {",
      "    forward();",
      "    count = count + 1;",
      "  }",
      "  if (atGoal() === true) {",
      "    pen(\"green\");",
      "  }",
      "  return count;",
      "}",
      "go();",
    ].join("\n");
    const result = fixSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
  });

  test("empty input is left alone", () => {
    const result = fixSource("");
    expect(result).toEqual({ source: "", fixes: [], ok: true });
  });

  test("whitespace-only input is left alone, whitespace preserved exactly", () => {
    const source = "   \n\t\n  ";
    const result = fixSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
  });

  test("a deliberately unusual but valid identifier is never renamed", () => {
    // Entry is forced via a genuine, unrelated parse break (bad case on a
    // control word) so this actually exercises the wrong-case pass's
    // vocabulary check, not just the top-level short-circuit.
    const source = ["IF (canGo()) {", "  Zebra();", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("Zebra()");
    expect(result.fixes.some((f) => f.was === "Zebra")).toBe(false);
  });
});

describe("fixSource — refusals (things it must NOT fix)", () => {
  test("missing semicolons are left alone — ASI already handles them", () => {
    const source = "let x = 1\nforward()";
    expect(parses(source)).toBe(true);
    const result = fixSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
  });

  test("== vs === is left alone — both work, not worth a lesson", () => {
    const source = "let x = 5;\nif (x == 3) {\n  forward();\n}";
    expect(parses(source)).toBe(true);
    const result = fixSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
    expect(result.source).toContain("x == 3");
  });

  test("an infinite while(true) with no exit is left alone", () => {
    const source = "while (true) {\n  forward();\n}";
    expect(parses(source)).toBe(true);
    const result = fixSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
  });

  test("a plausible-but-unknown identifier is never treated as a typo", () => {
    const source = ["IF (canGo()) {", "  myRobot();", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("myRobot()");
  });

  test("operators and number literals are never altered", () => {
    const source = ["IF (count() > 3) {", "  forward();", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("count() > 3");
  });

  test("a bare vocabulary word on the right of an = is left alone", () => {
    // "forward" here names a value, not a call to make — a different
    // situation from a bare command line, and not this fixer's business.
    const source = ["IF (canGo()) {", "  let x = forward;", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("let x = forward;");
  });
});

describe("fixSource — wrong case on a known word", () => {
  test("a mis-cased control keyword is corrected", () => {
    const source = ["IF (canGo()) {", "  forward();", "}"].join("\n");
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("if (canGo()) {\n  forward();\n}");
    expect(result.fixes).toEqual([
      { line: 1, was: "IF", now: "if", note: "JavaScript is fussy about capital letters." },
    ]);
  });

  test("a mis-cased vocabulary word is corrected, property access is left alone", () => {
    const source = ["IF (canGo()) {", "  Forward();", "  robot.Forward();", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("  forward();");
    expect(result.source).toContain("robot.Forward();"); // property access — untouched
    expect(result.fixes.filter((f) => f.was === "Forward").map((f) => f.line)).toEqual([2]);
  });

  test("words inside strings and comments are never re-cased", () => {
    const source = [
      "IF (canGo()) {",
      "  // While loops repeat",
      '  pen("Forward");',
      "}",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("// While loops repeat");
    expect(result.source).toContain('pen("Forward")');
    expect(result.fixes).toEqual([
      { line: 1, was: "IF", now: "if", note: "JavaScript is fussy about capital letters." },
    ]);
  });
});

describe("fixSource — a known command used without parentheses", () => {
  test("a bare vocabulary word on its own line gets ()", () => {
    const source = ["if (canGo()) {", "  forward", ""].join("\n"); // missing closing brace forces entry
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source.trim().endsWith("}")).toBe(true);
    expect(result.source).toContain("  forward()");
    const fix = result.fixes.find((f) => f.was === "forward");
    expect(fix).toEqual({
      line: 2,
      was: "forward",
      now: "forward()",
      note: "`forward` by itself is just that command's name — nothing happens until you call it: `forward()`.",
    });
  });

  test("a bare word not in the vocabulary is left alone", () => {
    const source = ["IF (canGo()) {", "  celebrate", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("  celebrate\n"); // still bare, no () added
  });
});

describe("fixSource — typographic substitutions", () => {
  test("smart double quotes from the iOS keyboard are straightened", () => {
    const source = "pen(\u201Cred\u201D);";
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toBe('pen("red");');
    expect(result.fixes).toEqual([
      {
        line: 1,
        was: "\u201Cred\u201D",
        now: '"red"',
        note: "Your keyboard turned a straight quote or dash into a curly one, so I straightened it back out.",
      },
    ]);
  });

  test("smart single quotes are straightened", () => {
    const source = "pen(\u2018blue\u2019);";
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("pen('blue');");
  });

  test("an en dash used as subtraction is straightened", () => {
    const source = "let x = 5 \u2013 2;\nforward();";
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("5 - 2");
  });

  test("a smart quote already protected inside a real string is left alone", () => {
    // The straight quotes are real delimiters here, so the curly quotes
    // inside are the scholar's own stylized text, not a keyboard slip.
    const source = [
      "IF (canGo()) {",
      '  pen("she said \u201Chi\u201D");',
      "}",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain('"she said \u201Chi\u201D"');
  });
});

describe("fixSource — other-language leftovers", () => {
  test("elif becomes else if", () => {
    const source = "if (x) {\n} elif (y) {\n}";
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("else if (y)");
  });

  test("lowercase and/or/not become &&, ||, !", () => {
    expect(fixSource("if (x and y) {\n  forward();\n}").source).toContain("x && y");
    expect(fixSource("if (x or y) {\n  forward();\n}").source).toContain("x || y");
    expect(fixSource("if (not x) {\n  forward();\n}").source).toContain("!x");
  });

  test("a trailing 'end' line is removed", () => {
    const source = ["if (canGo()) {", "  forward();", "end"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).not.toMatch(/^end$/m);
    expect(result.source.trim().endsWith("}")).toBe(true);
  });

  test("a trailing 'endif' line is removed", () => {
    const source = ["if (canGo()) {", "  forward();", "endif"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).not.toMatch(/endif/);
  });

  test("a trailing 'then' line is removed", () => {
    const source = ["if (canGo()) {", "then", "  forward();"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).not.toMatch(/^then$/m);
  });

  test("a lone 'do' line is removed", () => {
    const source = ["function go() {", "  forward();", "do"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).not.toMatch(/^do$/m);
  });

  test("'end' inside a comment or string survives untouched", () => {
    const source = [
      "if (canGo()) {",
      "  // the end of the loop",
      '  pen("the end");',
      "  forward();",
      "",
    ].join("\n"); // missing closing brace forces entry
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("// the end of the loop");
    expect(result.source).toContain('pen("the end")');
  });
});

describe("fixSource — = used where a comparison was meant", () => {
  test("a single = inside an if condition becomes ===", () => {
    const source = ["if (carrying() = 3) {", "  forward();", ""].join("\n"); // missing brace forces entry
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("if (carrying() === 3)");
    const fix = result.fixes.find((f) => f.was.includes("carrying"));
    expect(fix?.note).toBe("A single = sets a value, but a condition needs === to compare two values, so I changed it.");
  });

  test("a single = inside a while condition becomes ===", () => {
    const source = ["while (color() = \"red\") {", "  forward();", ""].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain('while (color() === "red")');
  });

  test("a plain assignment statement outside a condition is left alone", () => {
    const source = ["IF (canGo()) {", "  let x = 3;", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("let x = 3;");
  });

  test("an existing === condition elsewhere in the program is never mangled", () => {
    // Regression test: a naive per-character scan can mistake the LAST `=` of
    // an already-correct `===` for a stray bare `=` (the first two get
    // skipped as a pair, but nothing stopped the third from matching alone).
    // `While (` + `{` on the same line is the genuine, unrelated trigger that
    // forces this program into the fix pipeline at all.
    const source = ["While (canGo()) {", "  if (carrying() === 3) {", "    left();", "  }", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("if (carrying() === 3)");
    expect(result.source).not.toMatch(/carrying\(\) ={4,}/);
    expect(result.fixes.every((f) => !f.was.includes("carrying"))).toBe(true);
  });
});

describe("fixSource — missing let on first assignment to a new name", () => {
  // `total`, not `count`: `count` is a taught word (the `for (n of count(4))`
  // loop primitive), and the test below asserts taught words are deliberately
  // never auto-declared. Using one here tested the opposite rule by accident.
  test("a bare first assignment gets let, later reassignment does not", () => {
    const source = [
      "IF (canGo()) {",
      "  total = 0;",
      "  total = total + 1;",
      "  forward();",
      "}",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("  let total = 0;");
    expect(result.source).toContain("  total = total + 1;");
    expect(result.fixes.filter((f) => f.now.startsWith("let total")).length).toBe(1);
  });

  test("an already-declared name never gets a second let", () => {
    const source = ["IF (canGo()) {", "  let total = 0;", "  total = 1;", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).not.toContain("let total = 1");
  });

  test("a vocabulary word is never auto-declared with let", () => {
    const source = ["IF (canGo()) {", "  color = \"red\";", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain('  color = "red";');
  });
});

describe("fixSource — missing closing bracket/brace/paren at EOF", () => {
  test("a single missing closing brace is appended", () => {
    const source = "while (canGo()) {\n  forward();\n";
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("while (canGo()) {\n  forward();\n}");
    expect(result.fixes).toEqual([
      {
        line: 2,
        was: "(end of program)",
        now: "}",
        note: "Your program was missing a closing curly brace at the end, so I added one.",
      },
    ]);
  });

  test("nested missing brackets are appended in the correct order", () => {
    const source = "function go() {\n  if (canGo()) {\n    forward();\n";
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source.endsWith("}}")).toBe(true);
    expect(parses(result.source)).toBe(true);
  });

  test("never guesses an insertion point mid-program — only appends at EOF", () => {
    const source = "function go() {\n  if (canGo()) {\n    forward();\n  }\n";
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    // The already-closed inner block is untouched; only the outer brace is appended.
    expect(result.source).toBe(source + "}");
  });
});

describe("fixSource — strings and comments are never touched", () => {
  test("a vocabulary word spelled out in a string survives untouched", () => {
    const source = [
      "if (canGo()) {",
      '  // Forward means go forward',
      '  pen("say Forward");',
      "  forward",
      "",
    ].join("\n"); // missing closing brace forces entry
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("// Forward means go forward");
    expect(result.source).toContain('pen("say Forward")');
    expect(result.source).toContain("  forward()"); // the real bare command IS fixed
  });

  test("a block comment survives untouched", () => {
    const source = [
      "IF (canGo()) {",
      "  /* Forward and While and elif are just words here */",
      "  forward();",
      "}",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("/* Forward and While and elif are just words here */");
  });

  test("a template literal's contents survive untouched", () => {
    const source = [
      "IF (canGo()) {",
      "  pen(`Forward ${1 + 1} While`);",
      "}",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("pen(`Forward ${1 + 1} While`)");
  });
});

describe("fixSource — idempotence and never-worse guarantees", () => {
  test("fixing a fixed program produces no further fixes", () => {
    const source = ["IF (canGo()) {", "  Forward", "}"].join("\n");
    const once = fixSource(source);
    expect(once.ok).toBe(true);
    const twice = fixSource(once.source);
    expect(twice).toEqual({ source: once.source, fixes: [], ok: true });
  });

  test("idempotence holds for a program needing several repairs at once", () => {
    const source = ["While (canGo()) {", "  Forward", "}"].join("\n");
    const once = fixSource(source);
    const twice = fixSource(once.source);
    expect(twice.fixes).toEqual([]);
    expect(twice.source).toBe(once.source);
  });

  test("a hopeless program is returned completely unchanged with ok:false", () => {
    const source = "forward() + ;";
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result).toEqual({ source, fixes: [], ok: false });
  });

  test("a differently hopeless program (unnamed function) is also refused cleanly", () => {
    const source = "function () {\n  forward();\n}";
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result).toEqual({ source, fixes: [], ok: false });
  });
});

describe("fixSource — line numbers always point at the ORIGINAL source", () => {
  test("a fix after an earlier line-deleting repair still reports its true original line", () => {
    const source = ["While (canGo()) {", "end", "  Forward", "}"].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toBe("while (canGo()) {\n  forward()\n}");

    const endFix = result.fixes.find((f) => f.was === "end");
    expect(endFix?.line).toBe(2);

    const whileFix = result.fixes.find((f) => f.was === "While");
    expect(whileFix?.line).toBe(1);

    const forwardCaseFix = result.fixes.find((f) => f.was === "Forward");
    expect(forwardCaseFix?.line).toBe(3);

    const parensFix = result.fixes.find((f) => f.was === "forward");
    expect(parensFix?.line).toBe(3);
  });

  test("multiple repairs spread across many original lines each keep their own line number", () => {
    const source = [
      "While (canGo()) {", // 1
      "end", // 2
      "  pen(\u201Cred\u201D);", // 3
      "  forward();", // 4
      "  pen(\u2018blue\u2019);", // 5
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain('pen("red")');
    expect(result.source).toContain("pen('blue')");
    expect(result.source.trim().endsWith("}")).toBe(true);

    const whileFix = result.fixes.find((f) => f.was === "While");
    expect(whileFix?.line).toBe(1);
    const endFix = result.fixes.find((f) => f.was === "end");
    expect(endFix?.line).toBe(2);
    const redFix = result.fixes.find((f) => f.was.includes("red"));
    expect(redFix?.line).toBe(3);
    const blueFix = result.fixes.find((f) => f.was.includes("blue"));
    expect(blueFix?.line).toBe(5);
    const braceFix = result.fixes.find((f) => f.was === "(end of program)");
    expect(braceFix?.line).toBe(5);
  });
});

describe("fixSource — realistic whole-program cases", () => {
  test("the canonical Scratch-habits example needs three repairs and comes out running", () => {
    const source = ["While (canGo()) {", "  Forward", "}"].join("\n");
    expect(parses(source)).toBe(false);
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(parses(result.source)).toBe(true);
    expect(result.source).toBe("while (canGo()) {\n  forward()\n}");
    expect(result.fixes.length).toBe(3);
    expect(result.fixes.some((f) => f.was === "While" && f.now === "while")).toBe(true);
    expect(result.fixes.some((f) => f.was === "Forward" && f.now === "forward")).toBe(true);
    expect(result.fixes.some((f) => f.was === "forward" && f.now === "forward()")).toBe(true);
  });

  test("a Python-habits program with elif, and/or, and a missing brace", () => {
    const source = [
      "if (wallAhead()) {",
      "  left();",
      "} elif (canGo() and not carrying()) {",
      "  forward();",
      "",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(parses(result.source)).toBe(true);
    expect(result.source).toContain("else if (canGo() && !carrying())");
  });

  test("smart quotes plus a bare command plus a missing brace, all in one program", () => {
    const source = [
      "if (onColor()) {",
      "  pen(\u201Cred\u201D);",
      "  Forward",
      "",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(parses(result.source)).toBe(true);
    expect(result.source).toContain('pen("red")');
    expect(result.source).toContain("forward()");
  });

  test("a first-day program combining wrong case, missing let, and a stray = in a condition", () => {
    const source = [
      "WHILE (canGo()) {",
      "  steps = 0",
      "  IF (steps = 3) {",
      "    left();",
      "  }",
      "  Forward",
      "  steps = steps + 1",
      "}",
    ].join("\n");
    const result = fixSource(source);
    expect(result.ok).toBe(true);
    expect(parses(result.source)).toBe(true);
    expect(result.source).toContain("while (canGo())");
    expect(result.source).toContain("if (steps === 3)");
    expect(result.source).toContain("let steps = 0");
    expect(result.source).toContain("forward()");
  });
});

describe("studioFix — integration alias", () => {
  test("studioFix is the same function as fixSource", () => {
    expect(studioFix).toBe(fixSource);
    const source = ["IF (canGo()) {", "  Forward", "}"].join("\n");
    expect(studioFix(source)).toEqual(fixSource(source));
  });
});

// ── fixRuntimeSource — the second entry point ────────────────────────────────
//
// These programs all PARSE on their own (that's the whole reason `fixSource`
// can't see them): the sandbox calls `fixRuntimeSource` only after it has
// already RUN the program and the run went wrong — it threw, or it moved the
// robot zero steps and drew nothing. This suite never has to reproduce that
// detection; it only exercises what the fixer does to programs in that shape.

describe("fixRuntimeSource — a wrong-cased call that throws ReferenceError", () => {
  test("Forward() alone is renamed to forward()", () => {
    const source = "Forward();";
    expect(parses(source)).toBe(true); // it parses — that's the hole fixSource can't see
    const result = fixRuntimeSource(source);
    expect(result.ok).toBe(true);
    expect(parses(result.source)).toBe(true);
    expect(result.source).toBe("forward();");
    expect(result.fixes).toEqual([
      { line: 1, was: "Forward", now: "forward", note: "JavaScript is fussy about capital letters." },
    ]);
  });
});

describe("fixRuntimeSource — a bare command that silently does nothing", () => {
  test("bare forward (no parentheses, no error, robot never moves) gets ()", () => {
    const source = "forward";
    expect(parses(source)).toBe(true); // a valid, silent no-op — the worst outcome this surface can produce
    const result = fixRuntimeSource(source);
    expect(result.ok).toBe(true);
    expect(parses(result.source)).toBe(true);
    expect(result.source).toBe("forward()");
    expect(result.fixes).toEqual([
      {
        line: 1,
        was: "forward",
        now: "forward()",
        note: "`forward` by itself is just that command's name — nothing happens until you call it: `forward()`.",
      },
    ]);
  });
});

describe("fixRuntimeSource — never rewrites a name the scholar declared themselves", () => {
  test("a program that defines its own Forward() is returned completely untouched", () => {
    const source = ["function Forward() {", "  forward();", "}", "Forward();"].join("\n");
    expect(parses(source)).toBe(true);
    const result = fixRuntimeSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
  });

  test("a shadowed vocabulary word left bare is not force-called either", () => {
    // The scholar's own `pen` function, referenced (not called) on its own
    // line — plausibly deliberate, since it's THEIR name, not Scratch's verb.
    const source = ["function pen() {", '  color("red");', "}", "pen"].join("\n");
    expect(parses(source)).toBe(true);
    const result = fixRuntimeSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
  });
});

describe("fixRuntimeSource — a stray = in a condition", () => {
  test("if (carrying() = 3) becomes if (carrying() === 3)", () => {
    const source = "if (carrying() = 3) {\n  left();\n}";
    expect(parses(source)).toBe(true); // valid on its own — V8 defers the invalid-target error to runtime
    const result = fixRuntimeSource(source);
    expect(result.ok).toBe(true);
    expect(parses(result.source)).toBe(true);
    expect(result.source).toBe("if (carrying() === 3) {\n  left();\n}");
    expect(result.fixes).toEqual([
      {
        line: 1,
        was: "if (carrying() = 3)",
        now: "if (carrying() === 3)",
        note: "A single = sets a value, but a condition needs === to compare two values, so I changed it.",
      },
    ]);
  });
});

describe("fixRuntimeSource — a genuinely correct program is a fixed point", () => {
  test("nothing is rewritten when the program already runs correctly", () => {
    const source = [
      "function go() {",
      "  let count = 0;",
      "  while (canGo()) {",
      "    forward();",
      "    count = count + 1;",
      "  }",
      "  if (atGoal() === true) {",
      '    pen("green");',
      "  }",
      "  return count;",
      "}",
      "go();",
    ].join("\n");
    const result = fixRuntimeSource(source);
    expect(result).toEqual({ source, fixes: [], ok: true });
  });

  test("empty input is left alone", () => {
    expect(fixRuntimeSource("")).toEqual({ source: "", fixes: [], ok: true });
  });
});

describe("fixRuntimeSource — deliberately excludes fixMissingLet", () => {
  test("a wrong-cased call is fixed, but a bare undeclared assignment keeps no let", () => {
    // `let` is a taught concept the scholar must see land in their OWN editor
    // buffer (via the sandbox's idle reformat), never a silent runtime fixer.
    const source = "Forward();\ncount = 0;";
    expect(parses(source)).toBe(true);
    const result = fixRuntimeSource(source);
    expect(result.ok).toBe(true);
    expect(result.source).toContain("forward();");
    expect(result.source).not.toContain("let count");
    expect(result.source).toContain("count = 0;");
    expect(result.fixes).toHaveLength(1);
    expect(result.fixes[0].was).toBe("Forward");
  });
});

describe("fixRuntimeSource — deliberately excludes fixMissingClosingBrackets", () => {
  test("a program that never parses at all comes back untouched with ok:false", () => {
    // `True` would happily get case-fixed, but the missing closing brace is
    // a job for `fixSource`, not this entry point — so the combined result
    // still doesn't parse, and the all-or-nothing revert must fire here too.
    const source = "while (True) {";
    expect(parses(source)).toBe(false);
    const result = fixRuntimeSource(source);
    expect(result).toEqual({ source, fixes: [], ok: false });
  });
});
