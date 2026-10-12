import { describe, expect, test } from "vitest";
import { linkedPasteText } from "../messagePaste";

describe("linkedPasteText", () => {
  test("keeps a link the browser would drop from a rich-text paste", () => {
    // What Chrome puts on text/plain when copying a Gmail draft paragraph.
    const text = "Please use the link below:\n\nGoogle Calendar Booking\n\nThanks!";
    expect(
      linkedPasteText({
        text,
        anchors: [
          {
            label: "Google Calendar Booking",
            href: "https://calendar.app.google/abc123",
          },
        ],
        selected: "",
      }),
    ).toBe(
      "Please use the link below:\n\n[Google Calendar Booking](https://calendar.app.google/abc123)\n\nThanks!",
    );
  });

  test("links repeated labels in order", () => {
    expect(
      linkedPasteText({
        text: "here and here",
        anchors: [
          { label: "here", href: "https://a.example" },
          { label: "here", href: "https://b.example" },
        ],
        selected: "",
      }),
    ).toBe("[here](https://a.example) and [here](https://b.example)");
  });

  test("leaves ordinary pastes to the browser", () => {
    const cases = [
      // no anchors
      { text: "just words", anchors: [], selected: "" },
      // bare-URL anchor already pastes as its URL
      {
        text: "https://a.example",
        anchors: [{ label: "https://a.example", href: "https://a.example" }],
        selected: "",
      },
      // non-HTTP and anchor-only (mailto) links
      {
        text: "email me",
        anchors: [{ label: "email me", href: "mailto:x@example.com" }],
        selected: "",
      },
      // label the plain text doesn't contain
      {
        text: "something else",
        anchors: [{ label: "Booking", href: "https://a.example" }],
        selected: "",
      },
    ];
    for (const input of cases) expect(linkedPasteText(input)).toBeNull();
  });

  test("pasting a URL over selected text links it", () => {
    expect(
      linkedPasteText({
        text: "https://calendar.app.google/abc123\n",
        anchors: [],
        selected: "Google Calendar Booking",
      }),
    ).toBe("[Google Calendar Booking](https://calendar.app.google/abc123)");
    // Pasting over a URL, or pasting prose, is a normal replace.
    expect(
      linkedPasteText({
        text: "https://b.example",
        anchors: [],
        selected: "https://a.example",
      }),
    ).toBeNull();
    expect(
      linkedPasteText({ text: "new words", anchors: [], selected: "old" }),
    ).toBeNull();
  });
});
