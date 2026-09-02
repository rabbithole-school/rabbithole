import { describe, expect, test } from "vitest";
import { previewableMessageLink, tokenizeMessageLinks } from "../messageLinks";

describe("tokenizeMessageLinks", () => {
  test("preserves text and newlines while peeling sentence punctuation", () => {
    const input = "Read https://example.com/path?x=1.\nThen reply.";
    const tokens = tokenizeMessageLinks(input);
    expect(tokens).toEqual([
      { type: "text", value: "Read " },
      { type: "url", value: "https://example.com/path?x=1" },
      { type: "text", value: ".\nThen reply." },
    ]);
    expect(tokens.map((token) => token.value).join("")).toBe(input);
  });

  test("keeps balanced closing brackets but peels unbalanced closers", () => {
    expect(tokenizeMessageLinks("https://en.wikipedia.org/wiki/Function_(mathematics)")).toEqual([
      { type: "url", value: "https://en.wikipedia.org/wiki/Function_(mathematics)" },
    ]);
    expect(tokenizeMessageLinks("(https://example.com/path)")).toEqual([
      { type: "text", value: "(" },
      { type: "url", value: "https://example.com/path" },
      { type: "text", value: ")" },
    ]);
  });

  test("only recognizes absolute HTTP URLs", () => {
    const input =
      "javascript:alert(1) data:text/html,nope ftp://example.com https:///missing-host";
    expect(tokenizeMessageLinks(input)).toEqual([{ type: "text", value: input }]);
  });

  test("retains valid query strings and hashes", () => {
    expect(
      tokenizeMessageLinks("https://example.com/path?a=one&b=two#section"),
    ).toEqual([
      {
        type: "url",
        value: "https://example.com/path?a=one&b=two#section",
      },
    ]);
  });

  test("selects at most one boundary URL for a preview card", () => {
    expect(
      previewableMessageLink("https://example.com/notes\nPlease read this."),
    ).toBe("https://example.com/notes");
    expect(
      previewableMessageLink("Please read https://example.com/notes."),
    ).toBe("https://example.com/notes");
    expect(
      previewableMessageLink("Please compare https://one.example and https://two.example now."),
    ).toBeNull();
  });

  test("selects URL-only and prose-ending URLs exactly as messages render them", () => {
    expect(previewableMessageLink("https://nytimes.com")).toBe("https://nytimes.com");
    expect(
      previewableMessageLink(
        "Here is a test of the photos from the first day of school: https://drive.google.com/drive/folders/1_l_Bm1TLgDt9P0sGPmgBdV3bAmq5SgNn",
      ),
    ).toBe(
      "https://drive.google.com/drive/folders/1_l_Bm1TLgDt9P0sGPmgBdV3bAmq5SgNn",
    );
  });
});
