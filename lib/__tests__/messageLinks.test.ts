import { describe, expect, test } from "vitest";
import {
  messagePlainText,
  previewableMessageLink,
  tokenizeMessageLinks,
} from "../messageLinks";

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

describe("labelled links", () => {
  const body =
    "Please sign up here:\n\n[Google Calendar Booking](https://calendar.app.google/abc123)\n\nThanks!";

  test("tokenize as one link that keeps its exact source text", () => {
    const tokens = tokenizeMessageLinks(body);
    expect(tokens).toEqual([
      { type: "text", value: "Please sign up here:\n\n" },
      {
        type: "link",
        value: "[Google Calendar Booking](https://calendar.app.google/abc123)",
        label: "Google Calendar Booking",
        url: "https://calendar.app.google/abc123",
      },
      { type: "text", value: "\n\nThanks!" },
    ]);
    expect(tokens.map((token) => token.value).join("")).toBe(body);
  });

  test("keep balanced parentheses in the URL", () => {
    expect(
      tokenizeMessageLinks("[f](https://en.wikipedia.org/wiki/Function_(mathematics)).")[0],
    ).toMatchObject({
      type: "link",
      url: "https://en.wikipedia.org/wiki/Function_(mathematics)",
    });
  });

  test("never link a non-HTTP target", () => {
    const input = "[click](javascript:alert(1)) [x](https:///nohost)";
    expect(tokenizeMessageLinks(input).some((t) => t.type === "link")).toBe(false);
  });

  test("never earn a preview card", () => {
    expect(
      previewableMessageLink("[Booking](https://calendar.app.google/abc123)"),
    ).toBeNull();
  });

  test("flatten to label (url) for plain-text channels, or the label alone", () => {
    expect(messagePlainText(body)).toBe(
      "Please sign up here:\n\nGoogle Calendar Booking (https://calendar.app.google/abc123)\n\nThanks!",
    );
    expect(messagePlainText(body, { labelsOnly: true })).toBe(
      "Please sign up here:\n\nGoogle Calendar Booking\n\nThanks!",
    );
    expect(messagePlainText("See https://example.com.")).toBe(
      "See https://example.com.",
    );
  });
});
