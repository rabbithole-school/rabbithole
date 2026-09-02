/**
 * Pins the eval tool-call sanitizer: hallucinated tool-call text (the eval rig
 * binds no tools) must become a clean artifact marker, with no XML/JSON
 * scaffolding left behind, while normal prose is untouched.
 */
import { describe, expect, test } from "vitest";
import { sanitizeToolText, sanitizeTurns } from "../lib/toolText";

describe("sanitizeToolText", () => {
  test("well-formed XML invoke → image marker, no tags left", () => {
    const input = `Let me draw that for you!

<function_calls>
<invoke name="generate_image">
<parameter name="prompt">A colorful octopus diagram with three hearts labeled</parameter>
</invoke>
</function_calls>

Here it is!`;
    const out = sanitizeToolText(input);
    expect(out).toContain("[The tutor generated an image and showed it to the scholar here.]");
    expect(out).not.toMatch(/<\/?(?:function_calls|invoke|parameter)/);
    expect(out).toContain("Here it is!");
  });

  test("malformed/duplicated invokes collapse to one marker, no residue", () => {
    // Mirrors the real octopus-baked transcript: stray closers + repeats.
    const input = `<function_calls>
<invoke name="generate_image">
<parameter name="prompt">octopus hearts</parameter>
</invoke>
</parameter>
</invoke>
</function_calls>
<invoke name="generate_image">
<parameter name="prompt">octopus hearts again</parameter>
</invoke>
</function_calls>`;
    const out = sanitizeToolText(input);
    expect(out).not.toMatch(/<\/?(?:function_calls|invoke|parameter)/);
    // Consecutive identical markers are de-duped.
    const count = (out.match(/\[The tutor generated an image/g) ?? []).length;
    expect(count).toBe(1);
  });

  test("JSON-style call → marker (image and code)", () => {
    const img = sanitizeToolText(
      `Here you go: generate_image({"prompt": "a Roman arch", "width": 1024, "height": 768})`,
    );
    expect(img).toContain("[The tutor generated an image and showed it to the scholar here.]");
    expect(img).not.toContain("generate_image(");

    const code = sanitizeToolText(
      `Let's build it: create_code({"title": "Arch Builder", "prompt": "interactive arch"})`,
    );
    expect(code).toContain("interactive widget");
    expect(code).not.toContain("create_code(");
  });

  test("bracketed placeholder → image marker", () => {
    expect(sanitizeToolText("[Generating a Roman arch illustration...]")).toContain(
      "[The tutor generated an image",
    );
    expect(sanitizeToolText("*[generating now...]*")).toContain("[The tutor generated an image");
  });

  test("normal prose is unchanged", () => {
    const prose = "Great thinking! What do you notice about the wedge-shaped stones?";
    expect(sanitizeToolText(prose)).toBe(prose);
  });

  test("sanitizeTurns maps over a transcript", () => {
    const turns = [
      { role: "tutor", content: "[Generating image...] look!" },
      { role: "scholar", content: "ok i see it" },
    ];
    const out = sanitizeTurns(turns);
    expect(out[0].content).toContain("[The tutor generated an image");
    expect(out[1].content).toBe("ok i see it");
  });
});
