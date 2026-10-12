import { describe, expect, test } from "vitest";
import { slackTextToMessageBody } from "../slackText";

describe("slackTextToMessageBody", () => {
  test("turns Slack's link markup into the message body's link forms", () => {
    expect(
      slackTextToMessageBody(
        "Book here: <https://calendar.app.google/abc?a=1&amp;b=2|Conference sign-up> or <https://example.com/x>",
      ),
    ).toBe(
      "Book here: [Conference sign-up](https://calendar.app.google/abc?a=1&b=2) or https://example.com/x",
    );
  });

  test("decodes Slack's escaped control characters", () => {
    expect(slackTextToMessageBody("5 &lt; 6 &amp;&amp; 7 &gt; 2")).toBe(
      "5 < 6 && 7 > 2",
    );
  });

  test("spells out a link whose label the [label](url) form cannot carry", () => {
    expect(slackTextToMessageBody("<https://a.example|[draft] plan>")).toBe(
      "[draft] plan (https://a.example)",
    );
  });
});
