import { describe, expect, test } from "vitest";
import {
  extractSlackPermalinks,
  isRequesterAllowed,
  parseSlackPermalink,
} from "../slackPermalink";

describe("parseSlackPermalink", () => {
  test("parses the p-digits into a ts (dot before last six)", () => {
    const ref = parseSlackPermalink(
      "https://example.slack.com/archives/C0123456789/p1783662930395019",
    );
    expect(ref).toEqual({ channelId: "C0123456789", ts: "1783662930.395019" });
  });

  test("honors thread_ts and cid query params (cid overrides path channel)", () => {
    const ref = parseSlackPermalink(
      "https://example.slack.com/archives/C0123456789/p1783662930395019?thread_ts=1783632923.742759&cid=C0123456789",
    );
    expect(ref).toEqual({
      channelId: "C0123456789",
      ts: "1783662930.395019",
      threadTs: "1783632923.742759",
    });
  });

  test("cid query param overrides a differing path channel", () => {
    const ref = parseSlackPermalink(
      "https://example.slack.com/archives/CPATH0000/p1700000000123456?cid=CREAL1111",
    );
    expect(ref?.channelId).toBe("CREAL1111");
  });

  test("handles private-group and DM channel prefixes", () => {
    expect(
      parseSlackPermalink(
        "https://example.slack.com/archives/G01ABCDE/p1700000000123456",
      )?.channelId,
    ).toBe("G01ABCDE");
    expect(
      parseSlackPermalink(
        "https://example.slack.com/archives/D01ABCDE/p1700000000123456",
      )?.channelId,
    ).toBe("D01ABCDE");
  });

  test("returns null for non-archive Slack URLs and plain web pages", () => {
    expect(
      parseSlackPermalink("https://example.slack.com/team/U012345"),
    ).toBeNull();
    expect(parseSlackPermalink("https://example.com/archives/C1/p123")).toBeNull();
    expect(parseSlackPermalink("not a url at all")).toBeNull();
    // Too few digits to carry 6 fractional + ≥1 whole.
    expect(
      parseSlackPermalink("https://example.slack.com/archives/C1/p123456"),
    ).toBeNull();
  });

  test("tolerates trailing punctuation and surrounding text", () => {
    const ref = parseSlackPermalink(
      "see (https://example.slack.com/archives/C0123456789/p1783662930395019).",
    );
    expect(ref).toEqual({ channelId: "C0123456789", ts: "1783662930.395019" });
  });

  test("parses a Slack-wrapped <url> token", () => {
    const ref = parseSlackPermalink(
      "<https://example.slack.com/archives/C0123456789/p1783662930395019>",
    );
    expect(ref).toEqual({ channelId: "C0123456789", ts: "1783662930.395019" });
  });

  // ── The REAL shape Slack delivers over the Events API ────────────────────
  // Slack does NOT hand us a bare URL: it wraps links as `<url>` / `<url|label>`
  // and HTML-escapes `&`→`&amp;`, so a permalink's `?thread_ts=…&cid=…` arrives
  // as `?thread_ts=…&amp;cid=…`. Without unescaping, URLSearchParams splits on
  // the literal `&` inside `&amp;` and drops every param after the first.
  test("parses the real HTML-escaped, angle-bracket-wrapped delivered shape", () => {
    const ref = parseSlackPermalink(
      "<https://example.slack.com/archives/C0123456789/p1783662930395019?thread_ts=1783632923.742759&amp;cid=C0123456789>",
    );
    expect(ref).toEqual({
      channelId: "C0123456789",
      ts: "1783662930.395019",
      threadTs: "1783632923.742759",
    });
  });

  test("keeps thread_ts even when cid comes first in an &amp;-escaped query", () => {
    // cid before thread_ts: the &amp; would otherwise swallow thread_ts (the
    // param after the first `&`), silently losing the thread parent.
    const ref = parseSlackPermalink(
      "<https://example.slack.com/archives/CPATH0000/p1783662930395019?cid=CREAL1111&amp;thread_ts=1783632923.742759>",
    );
    expect(ref).toEqual({
      channelId: "CREAL1111",
      ts: "1783662930.395019",
      threadTs: "1783632923.742759",
    });
  });
});

describe("extractSlackPermalinks", () => {
  test("finds a permalink embedded in a sentence", () => {
    const refs = extractSlackPermalinks(
      "implement this <https://example.slack.com/archives/C0123456789/p1783662930395019?thread_ts=1783632923.742759&cid=C0123456789> in a draft PR",
    );
    expect(refs).toEqual([
      {
        channelId: "C0123456789",
        ts: "1783662930.395019",
        threadTs: "1783632923.742759",
      },
    ]);
  });

  test("extracts from a real delivered message (leading <@mention>, &amp;-escaped)", () => {
    // The literal Events-API `text`: an @-mention token, then the wrapped +
    // HTML-escaped permalink, then the instruction.
    const refs = extractSlackPermalinks(
      "<@U0123456789> <https://example.slack.com/archives/C0123456789/p1783662930395019?thread_ts=1783632923.742759&amp;cid=C0123456789> implement this in a draft PR",
    );
    expect(refs).toEqual([
      {
        channelId: "C0123456789",
        ts: "1783662930.395019",
        threadTs: "1783632923.742759",
      },
    ]);
  });

  test("dedupes identical links and returns none for plain text", () => {
    const url = "https://example.slack.com/archives/C1AAAAAAA/p1700000000123456";
    expect(extractSlackPermalinks(`${url} and again ${url}`)).toHaveLength(1);
    expect(extractSlackPermalinks("no links here")).toEqual([]);
  });

  test("caps the number of resolved links", () => {
    const text = [
      "https://example.slack.com/archives/C1AAAAAAA/p1700000000000001",
      "https://example.slack.com/archives/C2BBBBBBB/p1700000000000002",
      "https://example.slack.com/archives/C3CCCCCCC/p1700000000000003",
      "https://example.slack.com/archives/C4DDDDDDD/p1700000000000004",
    ].join("\n");
    expect(extractSlackPermalinks(text, 3)).toHaveLength(3);
  });
});

describe("isRequesterAllowed", () => {
  const AUTHOR = "UAUTHOR";

  test("same conversation as the request is always allowed (no member set needed)", () => {
    expect(isRequesterAllowed("C_HERE", "C_HERE", null, AUTHOR)).toBe(true);
    // Even an empty/unknown member set doesn't matter for the same channel.
    expect(isRequesterAllowed("C_HERE", "C_HERE", new Set(), AUTHOR)).toBe(true);
  });

  test("cross-conversation: allowed only when the requester is a member", () => {
    const members = new Set([AUTHOR, "UOTHER"]);
    expect(isRequesterAllowed("C_OTHER", "C_HERE", members, AUTHOR)).toBe(true);
    expect(
      isRequesterAllowed("C_OTHER", "C_HERE", new Set(["USOMEONE"]), AUTHOR),
    ).toBe(false);
  });

  test("fails closed when membership couldn't be established", () => {
    // null/undefined member set = couldn't verify → never allow cross-channel.
    expect(isRequesterAllowed("C_OTHER", "C_HERE", null, AUTHOR)).toBe(false);
    expect(isRequesterAllowed("C_OTHER", "C_HERE", undefined, AUTHOR)).toBe(
      false,
    );
    // No current channel + no members = fail closed.
    expect(isRequesterAllowed("C_OTHER", null, null, AUTHOR)).toBe(false);
  });
});
