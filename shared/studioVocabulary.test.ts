import { describe, expect, test } from "vitest";
import { execute, humanize } from "../studio/src/runtime";
import { STUDIO_VOCABULARY } from "./studioContract";
import { STUDIO_LEVELS, buildWorld } from "./studioLevels";

/**
 * STUDIO_VOCABULARY is what the sandbox tells a scholar the robot knows. It
 * feeds the friendly unknown-name message ("you haven't taught the robot
 * `dance` yet"), so a word on this list that the runtime does not actually
 * provide is worse than an omission: the scholar is told a working word is
 * unknown, or an unknown word is silently accepted.
 *
 * The two lists drifted once — the contract advertised `pen` and `repeat`,
 * neither of which the runtime has ever handed the program. These tests exist
 * so the contract can only ever describe the runtime that exists.
 */
const world = () => buildWorld(STUDIO_LEVELS[0]);

describe("Studio vocabulary", () => {

  test.each([...STUDIO_VOCABULARY])("the runtime provides `%s`", (word) => {
    const r = execute(`${word}\n`, world());
    expect(r.error, `\`${word}\` is advertised but not in the runtime's scope`).toBeNull();
  });

  test("a word outside the vocabulary is reported in the teaching voice", () => {
    const r = execute("dance()\n", world());
    expect(r.error).not.toBeNull();
    // The whole point of the vocabulary. Asserting merely that SOMETHING
    // errored is too weak — that passed while the message was still the raw
    // engine string, which is what let the JavaScriptCore gap ship.
    expect(r.error?.message).toContain("There is no command called dance");
    expect(r.error?.message).not.toMatch(/is not defined|Can't find variable/);
  });

  test("a near-miss suggests the word it is near", () => {
    const r = execute("foward()\n", world());
    expect(r.error?.message).toContain("Did you mean forward?");
  });

  test("a name near nothing does not guess", () => {
    const r = execute("xylophone()\n", world());
    expect(r.error?.message).toContain("Check the spelling");
    expect(r.error?.message).not.toContain("Did you mean");
  });

  test("has no duplicates", () => {
    expect(new Set(STUDIO_VOCABULARY).size).toBe(STUDIO_VOCABULARY.length);
  });
});

/**
 * These tests exist because the suite runs in Node (V8) while the product runs
 * in an iPad WebView (JavaScriptCore), so every test above exercises only half
 * the engines that matter. The two phrase the commonest beginner error
 * completely differently, and matching only V8 shipped a raw engine message to
 * the one device this is for. Feed `humanize` both strings directly.
 */
describe("Studio error messages, on both engines", () => {
  const cases: Array<[string, string, string]> = [
    ["V8", "dance is not defined", "There is no command called dance"],
    ["JavaScriptCore", "Can't find variable: dance", "There is no command called dance"],
    ["V8", "foward is not defined", "Did you mean forward?"],
    ["JavaScriptCore", "Can't find variable: foward", "Did you mean forward?"],
    ["V8", "Assignment to constant variable.", "made with const"],
    ["JavaScriptCore", "Attempted to assign to readonly property.", "made with const"],
    ["V8", "forward is not a function", "not something you can call"],
    [
      "JavaScriptCore",
      "forward is not a function. (In 'forward()', 'forward' is undefined)",
      "not something you can call",
    ],
  ];

  test.each(cases)("%s: %s", (_engine, raw, expected) => {
    expect(humanize(new Error(raw))).toContain(expected);
  });

  test("an unrecognised message is passed through rather than mangled", () => {
    expect(humanize(new Error("Something we have never seen"))).toBe(
      "Something we have never seen",
    );
  });
});

/**
 * Every command is injected as a parameter of the generated function, and JS
 * forbids a body-level `let` from colliding with its own function's parameter.
 * So `let count = 0` — which rung 2 actively invites — was a hard SyntaxError
 * that no fixer could repair, because the clash was in our wrapper rather than
 * in the scholar's code. A declaration must win.
 */
describe("a scholar's own variable may share a name with a command", () => {
  test.each(STUDIO_VOCABULARY.map((w) => [w]))("let %s = 0 is not a syntax error", (word) => {
    const r = execute(`let ${word} = 0;\nforward();\n`, world());
    expect(r.error?.message ?? "").not.toMatch(/already been declared/i);
  });

  test("the declared name holds the scholar's value, not the command", () => {
    const r = execute("let count = 7;\nsay(count);\n", world());
    expect(r.error).toBeNull();
  });

  test("withdrawing one command leaves the others working", () => {
    const w = world();
    const r = execute("let color = 3;\nforward();\n", w);
    expect(r.error).toBeNull();
    expect(r.frames.some((f) => f.note === "move")).toBe(true);
  });

  test("a program that does not declare it still gets the command", () => {
    const r = execute("for (const n of count(3)) { forward(); }\n", world());
    expect(r.error).toBeNull();
  });
});
