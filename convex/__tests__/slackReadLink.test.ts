// The read_slack_link bot tool reuses the SAME membership-gated resolver as the
// pre-turn inline pass (resolveSharedSlackLinks). These tests exercise that
// resolver + the tool-result formatter directly (Slack's Web API stubbed via
// `fetch`), proving the authorization delegates to isRequesterAllowed: a
// forwarded permalink into a conversation the REQUESTER isn't a member of must
// return the honest fail-closed note and NEVER the linked contents.
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  resolveSharedSlackLinks,
  formatReadSlackLinkResult,
} from "../slackBot";

const TOKEN = "xoxb-test";
const CURRENT_CHANNEL = "CHEREBBBB"; // where the request came from
const TARGET_CHANNEL = "CTARGETAA"; // where the forwarded link points
const REQUESTER = "UREQ00001";
const SECRET = "the secret plan the requester must not see";

// A cross-channel permalink in the real Slack-delivered shape (angle-bracket
// wrapped, &amp;-escaped, leading <@mention>).
const CROSS_LINK = `<@UBOT00001> <https://ws.slack.com/archives/${TARGET_CHANNEL}/p1783662930395019?cid=${TARGET_CHANNEL}&amp;thread_ts=1783632923.742759> read this`;

type Call = { method: string; params: URLSearchParams | null };

/** Stub Slack's Web API, routing by method and recording every call. */
function stubSlack(handlers: Record<string, unknown>): { calls: Call[] } {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/api/")[1] ?? String(url);
    const bodyStr = typeof init?.body === "string" ? init.body : "";
    const params = bodyStr ? new URLSearchParams(bodyStr) : null;
    calls.push({ method, params });
    const json = handlers[method] ?? { ok: false, error: "not_stubbed" };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("read_slack_link authorization (via resolveSharedSlackLinks)", () => {
  test("requester NOT a member → fail-closed note, content never fetched", async () => {
    // conversations.members returns a set WITHOUT the requester.
    const { calls } = stubSlack({
      "conversations.members": {
        ok: true,
        members: ["USOMEONE1", "UOTHER002"],
      },
      // If the read path were (wrongly) reached, it would return the secret.
      "conversations.replies": {
        ok: true,
        messages: [
          { ts: "1783662930.395019", user: "UAUTHR002", text: SECRET },
        ],
      },
      "users.info": { ok: true, user: { real_name: "Author Two" } },
    });

    const resolved = await resolveSharedSlackLinks(
      TOKEN,
      CROSS_LINK,
      "UBOT00001",
      CURRENT_CHANNEL,
      REQUESTER,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].ok).toBe(false);
    expect(resolved[0].error).toBe("requester_not_member");
    expect(resolved[0].text).toBeUndefined();

    // The membership gate ran; the message read did NOT.
    expect(calls.some((c) => c.method === "conversations.members")).toBe(true);
    expect(calls.some((c) => c.method === "conversations.replies")).toBe(false);

    // The tool result is the honest note, with none of the linked content.
    const out = formatReadSlackLinkResult(resolved);
    expect(out).toContain("I can only surface links from conversations you're in");
    expect(out).not.toContain(SECRET);
  });

  test("requester IS a member → content is read and returned", async () => {
    const { calls } = stubSlack({
      "conversations.members": {
        ok: true,
        members: [REQUESTER, "UOTHER002"],
      },
      "conversations.replies": {
        ok: true,
        messages: [
          { ts: "1783662930.395019", user: "UAUTHR002", text: SECRET },
        ],
      },
      "users.info": { ok: true, user: { real_name: "Author Two" } },
    });

    const resolved = await resolveSharedSlackLinks(
      TOKEN,
      CROSS_LINK,
      "UBOT00001",
      CURRENT_CHANNEL,
      REQUESTER,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].ok).toBe(true);
    expect(resolved[0].text).toContain(SECRET);
    expect(resolved[0].authorName).toBe("Author Two");
    expect(calls.some((c) => c.method === "conversations.replies")).toBe(true);

    const out = formatReadSlackLinkResult(resolved);
    expect(out).toContain(SECRET);
    expect(out).toContain("Author Two");
  });

  test("a link into the SAME conversation skips the membership call", async () => {
    const { calls } = stubSlack({
      "conversations.replies": {
        ok: true,
        messages: [
          { ts: "1783662930.395019", user: "UAUTHR002", text: "hi from here" },
        ],
      },
      "users.info": { ok: true, user: { real_name: "Author Two" } },
    });
    const sameChannelLink = `https://ws.slack.com/archives/${CURRENT_CHANNEL}/p1783662930395019`;

    const resolved = await resolveSharedSlackLinks(
      TOKEN,
      sameChannelLink,
      "UBOT00001",
      CURRENT_CHANNEL,
      REQUESTER,
    );

    expect(resolved[0].ok).toBe(true);
    // Same conversation = trivially allowed, so no conversations.members lookup.
    expect(calls.some((c) => c.method === "conversations.members")).toBe(false);
  });

  test("no Slack link in the text → the tool says so (points at web_fetch)", async () => {
    stubSlack({});
    const resolved = await resolveSharedSlackLinks(
      TOKEN,
      "just a plain question, no link",
      "UBOT00001",
      CURRENT_CHANNEL,
      REQUESTER,
    );
    expect(resolved).toHaveLength(0);
    const out = formatReadSlackLinkResult(resolved);
    expect(out).toContain("doesn't contain a Slack message link");
    expect(out).toContain("web_fetch");
  });
});
