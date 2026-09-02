import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InstitutionMark, resolveInstitutionMark } from "./InstitutionMark";

// The whole point of InstitutionMark: the fallback chain is defined ONCE, so
// "emoji is only ever a fallback for the logo" holds at every render site. This
// pins the ordering — logo → emoji → the name's initial.
describe("resolveInstitutionMark — the fallback chain", () => {
  test("a logo url wins over both emoji and name", () => {
    expect(
      resolveInstitutionMark({
        logoUrl: "https://example.com/logo.png",
        emoji: "🏫",
        name: "Moli School",
      }),
    ).toEqual({ kind: "logo", src: "https://example.com/logo.png" });
  });

  test("falls back to the emoji when there is no logo", () => {
    expect(
      resolveInstitutionMark({ logoUrl: null, emoji: "🏫", name: "Moli School" }),
    ).toEqual({ kind: "emoji", glyph: "🏫" });
  });

  test("a blank/whitespace logo url is treated as absent", () => {
    expect(
      resolveInstitutionMark({ logoUrl: "   ", emoji: "🌋", name: "Nuni" }),
    ).toEqual({ kind: "emoji", glyph: "🌋" });
  });

  test("falls back to the name's initial when neither logo nor emoji is set", () => {
    expect(
      resolveInstitutionMark({ logoUrl: null, emoji: null, name: "Moli School" }),
    ).toEqual({ kind: "text", text: "M" });
  });

  test("a blank emoji is skipped in favor of the initial", () => {
    expect(
      resolveInstitutionMark({ emoji: "  ", name: "kailua academy" }),
    ).toEqual({ kind: "text", text: "K" });
  });

  test("last resort is '?' when even the name is empty", () => {
    expect(resolveInstitutionMark({})).toEqual({ kind: "text", text: "?" });
    expect(
      resolveInstitutionMark({ logoUrl: "", emoji: "", name: "   " }),
    ).toEqual({ kind: "text", text: "?" });
  });

  test("the initial is surrogate-pair safe (multi-codepoint first char)", () => {
    expect(resolveInstitutionMark({ name: "𝓜oli" })).toEqual({
      kind: "text",
      text: "𝓜".toUpperCase(),
    });
  });

  describe("InstitutionMark accessibility", () => {
    test("names an emoji mark after its institution", () => {
      expect(
        renderToStaticMarkup(
          createElement(InstitutionMark, { emoji: "🏫", name: "Moli School" }),
        ),
      ).toContain('role="img" aria-label="Moli School"');
    });

    test("gives an unnamed emoji mark a stable fallback name", () => {
      expect(
        renderToStaticMarkup(createElement(InstitutionMark, { emoji: "🏫" })),
      ).toContain('role="img" aria-label="School"');
    });
  });
});
