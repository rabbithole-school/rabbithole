// Unit tests for the pure helpers in convex/lib/slackApi.ts.
import { describe, expect, test } from "vitest";
import { resolveSlackEmoji } from "../lib/slackApi";

/** A rich_text block the way Slack actually sends one. */
function blocksWithEmoji(
  parts: Array<{ text: string } | { name: string; unicode?: string }>,
) {
  return [
    {
      type: "rich_text",
      block_id: "b1",
      elements: [
        {
          type: "rich_text_section",
          elements: parts.map((p) =>
            "text" in p
              ? { type: "text", text: p.text }
              : { type: "emoji", name: p.name, ...(p.unicode ? { unicode: p.unicode } : {}) },
          ),
        },
      ],
    },
  ];
}

describe("resolveSlackEmoji", () => {
  // Slack sends `:shortcode:` in `text`; a scholar reads a staff reply OUTSIDE
  // Slack, so an unresolved shortcode reaches a child as literal ":rabbit2:".
  test("substitutes the codepoint Slack supplies in the blocks", () => {
    const text = "thanks for letting us know! :rabbit2: Mr Andy";
    const blocks = blocksWithEmoji([
      { text: "thanks for letting us know! " },
      { name: "rabbit2", unicode: "1f407" },
      { text: " Mr Andy" },
    ]);
    expect(resolveSlackEmoji(text, blocks)).toBe(
      "thanks for letting us know! \u{1F407} Mr Andy",
    );
  });

  test("handles a multi-codepoint emoji", () => {
    const blocks = blocksWithEmoji([{ name: "flag-us", unicode: "1f1fa-1f1f8" }]);
    expect(resolveSlackEmoji("hi :flag-us:", blocks)).toBe("hi \u{1F1FA}\u{1F1F8}");
  });

  test("leaves a CUSTOM emoji (no unicode) exactly as written", () => {
    // Never silently delete a human's characters — a custom workspace emoji has
    // no codepoint to substitute.
    const blocks = blocksWithEmoji([{ name: "partyparrot" }]);
    expect(resolveSlackEmoji("nice :partyparrot:", blocks)).toBe(
      "nice :partyparrot:",
    );
  });

  test("does not maul colon-shaped text that isn't an emoji", () => {
    const blocks = blocksWithEmoji([{ name: "rabbit2", unicode: "1f407" }]);
    expect(resolveSlackEmoji("meet at 10:30:00 sharp", blocks)).toBe(
      "meet at 10:30:00 sharp",
    );
    expect(resolveSlackEmoji("ratio 3:4", blocks)).toBe("ratio 3:4");
  });

  test("is a no-op with no blocks, no emoji, or no colons", () => {
    expect(resolveSlackEmoji("plain text", undefined)).toBe("plain text");
    expect(resolveSlackEmoji("has :rabbit2: but no blocks", null)).toBe(
      "has :rabbit2: but no blocks",
    );
    expect(resolveSlackEmoji("no colons here", blocksWithEmoji([]))).toBe(
      "no colons here",
    );
  });

  test("finds emoji nested anywhere in the block tree", () => {
    const blocks = [
      {
        type: "rich_text",
        elements: [
          {
            type: "rich_text_list",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "emoji", name: "tada", unicode: "1f389" }],
              },
            ],
          },
        ],
      },
    ];
    expect(resolveSlackEmoji("shipped :tada:", blocks)).toBe(
      "shipped \u{1F389}",
    );
  });

  test("a malformed codepoint leaves the shortcode intact rather than throwing", () => {
    const blocks = blocksWithEmoji([{ name: "broken", unicode: "zzzz" }]);
    expect(resolveSlackEmoji("oh :broken:", blocks)).toBe("oh :broken:");
  });
});
