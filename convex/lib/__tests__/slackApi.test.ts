import { describe, expect, test, afterEach, vi } from "vitest";
import {
  lookupSlackUserByEmail,
  fetchSlackUserInfo,
  fetchThreadReplies,
  fetchConversationMembers,
  postMessage,
  postContext,
  addReaction,
  removeReaction,
  escapeSlackText,
  normalizeSlackLinks,
  normalizeSlackMarkdown,
  canvasCreate,
  canvasSetAccess,
  canvasEdit,
  fetchCanvasContent,
  getFilePermalink,
  setConversationTopic,
  SLACK_TOPIC_MAX,
} from "../slackApi";

// Capture the last fetch call so we can assert HOW each Slack method is
// encoded. The lookup/read methods MUST be form-encoded — Slack rejects a
// JSON body for users.lookupByEmail / users.info / conversations.replies
// with `invalid_arguments` (verified against the live API 2026-06-13).

type Captured = { url: string; init: RequestInit };
let captured: Captured | null = null;

function stubFetch(jsonResponse: unknown) {
  captured = null;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify(jsonResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  captured = null;
});

function contentType(init: RequestInit): string {
  const h = init.headers as Record<string, string> | undefined;
  return h?.["Content-Type"] ?? "";
}

describe("read methods are form-encoded (not JSON)", () => {
  test("lookupSlackUserByEmail posts form-encoded with the email", async () => {
    stubFetch({ ok: true, user: { id: "U123", real_name: "Avery" } });
    const result = await lookupSlackUserByEmail("xoxb-tok", "avery@example.com");

    expect(result).toEqual({ slackUserId: "U123", name: "Avery" });
    expect(captured!.url).toContain("users.lookupByEmail");
    expect(captured!.init.method).toBe("POST");
    expect(contentType(captured!.init)).toBe("application/x-www-form-urlencoded");
    // The email must be in the (form) body, URL-encoded — NOT a JSON blob.
    const body = String(captured!.init.body);
    expect(body).toBe("email=avery%40example.com");
    expect(body).not.toContain("{"); // would indicate a JSON body (the bug)
  });

  test("fetchSlackUserInfo posts form-encoded with the user id", async () => {
    stubFetch({ ok: true, user: { profile: { display_name: "Lehua" } } });
    const info = await fetchSlackUserInfo("xoxb-tok", "U999");
    expect(info.name).toBe("Lehua");
    expect(captured!.url).toContain("users.info");
    expect(contentType(captured!.init)).toBe("application/x-www-form-urlencoded");
    expect(String(captured!.init.body)).toBe("user=U999");
  });

  test("fetchThreadReplies caps aide context while preserving the root and newest turns", async () => {
    stubFetch({
      ok: true,
      messages: Array.from({ length: 82 }, (_, i) => ({
        ts: `1.${String(i).padStart(6, "0")}`,
        text: `message ${i}`,
      })),
    });
    const msgs = await fetchThreadReplies("xoxb-tok", "C1", "100.5", 20);
    expect(msgs).toHaveLength(20);
    expect(msgs[0].text).toBe("message 0");
    expect(msgs[1].text).toBe("message 63");
    expect(msgs.at(-1)?.text).toBe("message 81");
    expect(captured!.url).toContain("conversations.replies");
    expect(contentType(captured!.init)).toBe("application/x-www-form-urlencoded");
    const body = String(captured!.init.body);
    expect(body).toContain("channel=C1");
    expect(body).toContain("ts=100.5");
    expect(body).toContain("limit=200");
  });

  test("fetchConversationMembers posts form-encoded and returns the member ids", async () => {
    stubFetch({ ok: true, members: ["U1", "U2"] });
    const res = await fetchConversationMembers("xoxb-tok", "C1");
    expect(res).toEqual({ ok: true, members: ["U1", "U2"] });
    expect(captured!.url).toContain("conversations.members");
    expect(contentType(captured!.init)).toBe("application/x-www-form-urlencoded");
    const body = String(captured!.init.body);
    expect(body).toContain("channel=C1");
    expect(body).toContain("limit=200");
    expect(body).not.toContain("{"); // form body, never JSON
  });

  test("fetchConversationMembers surfaces Slack's error (fail-closed signal)", async () => {
    stubFetch({ ok: false, error: "missing_scope" });
    const res = await fetchConversationMembers("xoxb-tok", "C1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_scope");
    expect(res.members).toEqual([]);
  });
});

describe("write methods stay JSON", () => {
  test("postMessage posts a JSON body (works for chat.* methods)", async () => {
    stubFetch({ ok: true, ts: "1.2" });
    await postMessage("xoxb-tok", { channel: "C1", text: "hello", markdown: true });
    expect(captured!.url).toContain("chat.postMessage");
    expect(contentType(captured!.init)).toContain("application/json");
    const body = JSON.parse(String(captured!.init.body));
    expect(body.channel).toBe("C1");
    expect(body.markdown_text).toBe("hello");
  });

  test("postMessage suppresses unfurls by default (content-free app shell)", async () => {
    stubFetch({ ok: true, ts: "1.2" });
    await postMessage("xoxb-tok", { channel: "C1", text: "hi" });
    const body = JSON.parse(String(captured!.init.body));
    expect(body.unfurl_links).toBe(false);
    expect(body.unfurl_media).toBe(false);
  });

  test("postMessage with unfurl:true opts links/media back in (external previews)", async () => {
    stubFetch({ ok: true, ts: "1.2" });
    await postMessage("xoxb-tok", { channel: "C1", text: "hi", unfurl: true });
    const body = JSON.parse(String(captured!.init.body));
    expect(body.unfurl_links).toBe(true);
    expect(body.unfurl_media).toBe(true);
  });

  test("postContext suppresses unfurls by default", async () => {
    stubFetch({ ok: true, ts: "1.2" });
    await postContext("xoxb-tok", { channel: "C1", text: "aside" });
    expect(captured!.url).toContain("chat.postMessage");
    const body = JSON.parse(String(captured!.init.body));
    expect(body.unfurl_links).toBe(false);
    expect(body.unfurl_media).toBe(false);
  });
});

describe("outbound Slack link normalization", () => {
  test("removes unsupported citation wrappers while preserving cited text and Slack links", () => {
    expect(
      normalizeSlackMarkdown(
        'A <cite index="source-1">quoted <https://docs.example|source></cite> B </cite> C <cite index="unfinished"',
      ),
    ).toBe(
      'A quoted <https://docs.example|source> B  C <cite index="unfinished"',
    );
  });

  test("keeps trailing closing parentheses out of a GitHub URL", () => {
    expect(
      normalizeSlackLinks("(https://github.example/org/site/pull/56))"),
    ).toBe("(<https://github.example/org/site/pull/56>))");
  });

  test("keeps following prose outside a bare social URL", () => {
    expect(
      normalizeSlackLinks("(https://social.example/launches).\nStill working."),
    ).toBe("(<https://social.example/launches>).\nStill working.");
  });

  test("converts Markdown links while preserving native Slack links and balanced URL parentheses", () => {
    expect(
      normalizeSlackLinks(
        "[Open site](https://site.example/path_(draft)) and <https://existing.example|existing> then https://docs.example/(guide).",
      ),
    ).toBe(
      "<https://site.example/path_(draft)|Open site> and <https://existing.example|existing> then <https://docs.example/(guide)>.",
    );
  });

  test("normalizes markdown_text sent through postMessage", async () => {
    stubFetch({ ok: true, ts: "1.2" });
    await postMessage("xoxb-tok", {
      channel: "C1",
      text: "See [the site](https://site.example) (https://social.example/launches).",
      markdown: true,
    });
    const body = JSON.parse(String(captured!.init.body));
    expect(body.markdown_text).toBe(
      "See <https://site.example|the site> (<https://social.example/launches>).",
    );
  });
});

describe("reactions (add/remove) — the react-only affordance", () => {
  // reactions.add / reactions.remove are JSON "write" methods and share the
  // ONE `reactions:write` scope (👀 works today, so no new permission). The
  // react-only path removes the auto-👀 and adds the chosen emoji in its place.
  test("addReaction posts JSON channel/timestamp/name to reactions.add", async () => {
    stubFetch({ ok: true });
    await addReaction("xoxb-tok", { channel: "C1", timestamp: "111.222", name: "eyes" });
    expect(captured!.url).toContain("reactions.add");
    expect(captured!.init.method).toBe("POST");
    expect(contentType(captured!.init)).toContain("application/json");
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({ channel: "C1", timestamp: "111.222", name: "eyes" });
  });

  test("removeReaction can clear the eyes acknowledgement after a reply", async () => {
    stubFetch({ ok: true });
    await removeReaction("xoxb-tok", { channel: "C1", timestamp: "111.222", name: "eyes" });
    expect(captured!.url).toContain("reactions.remove");
    expect(captured!.init.method).toBe("POST");
    expect(contentType(captured!.init)).toContain("application/json");
    const body = JSON.parse(String(captured!.init.body));
    expect(body).toEqual({ channel: "C1", timestamp: "111.222", name: "eyes" });
  });

  test("removeReaction swallows Slack errors (no_reaction) without throwing", async () => {
    // reactions:write missing, or the reaction was never added → Slack returns
    // an error; the reconciliation is best-effort and must not throw.
    stubFetch({ ok: false, error: "no_reaction" });
    await expect(
      removeReaction("xoxb-tok", { channel: "C1", timestamp: "1.2", name: "rabbit" }),
    ).resolves.toBeUndefined();
  });

  test("the react-only emoji names are Slack standard short names", async () => {
    // 🐰 🥕 👍 — the react_only vocabulary — are all standard Unicode short
    // names (no custom workspace emoji), so reactions.add resolves them.
    for (const name of ["rabbit", "carrot", "+1"]) {
      stubFetch({ ok: true });
      await addReaction("xoxb-tok", { channel: "C1", timestamp: "9.9", name });
      const body = JSON.parse(String(captured!.init.body));
      expect(body.name).toBe(name);
    }
  });
});

describe("setConversationTopic — self-documenting channel topic on link", () => {
  // conversations.setTopic is a form-encoded method (like the other lookup
  // methods). It needs the *:write.topic scopes and is called ONLY after a
  // human LINK action, best-effort so a topic failure never fails the link.
  test("posts form-encoded channel + topic to conversations.setTopic", async () => {
    stubFetch({ ok: true, topic: "📚 Geckos · Rabbithole activity updates" });
    const res = await setConversationTopic(
      "xoxb-tok",
      "C1",
      "📚 Geckos · Rabbithole activity updates",
    );
    expect(res).toEqual({ ok: true });
    expect(captured!.url).toContain("conversations.setTopic");
    expect(captured!.init.method).toBe("POST");
    expect(contentType(captured!.init)).toBe("application/x-www-form-urlencoded");
    const params = new URLSearchParams(String(captured!.init.body));
    expect(params.get("channel")).toBe("C1");
    expect(params.get("topic")).toBe("📚 Geckos · Rabbithole activity updates");
    // Form body, never JSON.
    expect(String(captured!.init.body)).not.toContain("{");
  });

  test("returns ok:false with the error (does NOT throw) when Slack rejects", async () => {
    // e.g. missing_scope on an old install — the link must still succeed, so
    // the helper surfaces the error rather than throwing.
    stubFetch({ ok: false, error: "missing_scope" });
    const res = await setConversationTopic("xoxb-tok", "C1", "anything");
    expect(res).toEqual({ ok: false, error: "missing_scope" });
  });

  test("swallows a thrown fetch (network error) and returns ok:false", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const res = await setConversationTopic("xoxb-tok", "C1", "anything");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("network down");
  });

  test("truncates a topic longer than Slack's 250-char cap", async () => {
    stubFetch({ ok: true });
    const long = "x".repeat(SLACK_TOPIC_MAX + 50);
    await setConversationTopic("xoxb-tok", "C1", long);
    const params = new URLSearchParams(String(captured!.init.body));
    expect(params.get("topic")!.length).toBe(SLACK_TOPIC_MAX);
  });
});

describe("SlackStreamer", () => {
  test("startStream always includes recipient_user_id (channel surfaces too)", async () => {
    // Slack rejects chat.startStream without recipient_user_id —
    // missing_recipient_user_id, seen on prod 2026-06-13 in channel threads.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true, ts: "9.9" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientTeamId: "T1",
      recipientUserId: "U_AUTHOR",
    });
    s.append("x".repeat(SlackStreamer.FLUSH_CHARS + 1)); // force a flush → startStream
    await s.flush();
    await s.finish();

    const start = calls.find((c) => c.url.includes("chat.startStream"));
    expect(start).toBeDefined();
    expect(start!.body.recipient_user_id).toBe("U_AUTHOR");
    expect(start!.body.recipient_team_id).toBe("T1");
    expect(start!.body.thread_ts).toBe("1.1");
  });
});

describe("SlackStreamer responsiveness", () => {
  function captureAll() {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true, ts: "5.5" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return calls;
  }

  test("eager start() opens the stream before any text exists", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    await s.start();
    expect(calls.map((c) => c.url.split("/").pop())).toEqual(["chat.startStream"]);
    await s.finish();
  });

  test("taskUpdate sends a task_update chunk on the open stream", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    await s.start();
    s.taskUpdate({ id: "thinking", title: "Thinking", status: "in_progress" });
    s.taskUpdate({
      id: "thinking",
      title: "Thinking",
      status: "complete",
      details: "x".repeat(300), // over Slack's 256 cap → must truncate
    });
    await s.flush();
    await s.finish();

    const taskCalls = calls.filter(
      (c) => c.url.includes("chat.appendStream") && Array.isArray(c.body.chunks),
    );
    expect(taskCalls).toHaveLength(2);
    const first = (taskCalls[0].body.chunks as Array<Record<string, unknown>>)[0];
    expect(first).toMatchObject({
      type: "task_update",
      id: "thinking",
      title: "Thinking",
      status: "in_progress",
    });
    const second = (taskCalls[1].body.chunks as Array<Record<string, unknown>>)[0];
    expect(second.status).toBe("complete");
    expect((second.details as string).length).toBe(256);
  });

  test("taskUpdate degrades silently when streaming is unavailable", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      // startStream rejected → streamer must fall back, tasks must no-op.
      const isStart = String(url).includes("startStream");
      return new Response(
        JSON.stringify(isStart ? { ok: false, error: "not_allowed" } : { ok: true, ts: "1.2" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    await s.start();
    s.taskUpdate({ id: "t", title: "T", status: "in_progress" });
    s.append('the <cite index="source-1">reply</cite>');
    await s.finish();

    // Exactly one startStream attempt, NO appendStream, one postMessage fallback.
    const methods = calls.map((c) => c.url.split("/").pop());
    expect(methods.filter((m) => m === "chat.startStream")).toHaveLength(1);
    expect(methods.filter((m) => m === "chat.appendStream")).toHaveLength(0);
    expect(methods.filter((m) => m === "chat.postMessage")).toHaveLength(1);
    expect(calls.find((call) => call.url.includes("chat.postMessage"))!.body).toMatchObject({
      markdown_text: "the reply",
      // The fallback is a normal chat.postMessage, so it must inherit the same
      // unfurl suppression as every other post — otherwise a workspace where
      // streaming is unavailable would still show the generic app card.
      unfurl_links: false,
      unfurl_media: false,
    });
  });

  test("rewrites the completed stream with explicit links after stopping it", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.append("See (https://github.example/org/site/pull/56)).");
    await s.flush();
    await s.finish();

    expect(calls.map((call) => call.url.split("/").pop())).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.update",
    ]);
    expect(calls.at(-1)!.body).toEqual({
      channel: "C1",
      ts: "5.5",
      markdown_text: "See (<https://github.example/org/site/pull/56>)).",
    });
  });

  test("removes citation tags split across stream deltas after stopping it", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.append("The scholar <ci");
    s.append('te index="source-1">changed strategies');
    s.append("</cite> after checking the result.");
    await s.flush();
    await s.finish();

    expect(calls.map((call) => call.url.split("/").pop())).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
      "chat.update",
    ]);
    expect(calls.at(-1)!.body).toEqual({
      channel: "C1",
      ts: "5.5",
      markdown_text: "The scholar changed strategies after checking the result.",
    });
  });
});

describe("SlackStreamer.discard — react-only retract", () => {
  test("stops and deletes an already-opened stream message", async () => {
    // A lead-in the model streamed before calling react_only has already
    // opened a Slack message via chat.startStream. discard() must retract it
    // (stopStream + delete on that ts) so Slack shows only the reaction — and
    // a subsequent finish() must NOT resurrect it as a postMessage.
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      return new Response(JSON.stringify({ ok: true, ts: "42.7" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.append("Sure —"); // opens the stream (startStream)
    await s.flush();
    await s.discard();
    await s.finish(); // must be a no-op after discard

    const methods = calls.map((c) => c.url.split("/").pop());
    expect(methods).toContain("chat.startStream");
    expect(methods).toContain("chat.stopStream");
    expect(methods).toContain("chat.delete");
    // The stop+delete target the streamed message's ts…
    const del = calls.find((c) => c.url.includes("chat.delete"));
    expect(del!.body).toMatchObject({ channel: "C1", ts: "42.7" });
    // …and finish() posts nothing new.
    expect(methods.filter((m) => m === "chat.postMessage")).toHaveLength(0);
  });

  test("no-op when nothing was ever posted", async () => {
    const calls: Array<{ url: string }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      calls.push({ url: String(url) });
      return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    // Never appended → no stream opened.
    await s.discard();

    // Nothing to stop or delete.
    expect(calls).toHaveLength(0);
  });
});

describe("escapeSlackText", () => {
  test("escapes Slack's three control characters (& first)", () => {
    expect(escapeSlackText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  test("neutralizes an injected <url|label> link from untrusted text", () => {
    // A scholar's verbatim message must NOT render as a clickable link in a
    // staff alert. After escaping, Slack shows the literal characters.
    expect(escapeSlackText("<https://evil.example|click here>")).toBe(
      "&lt;https://evil.example|click here&gt;",
    );
  });

  test("does not double-escape an already-escaped ampersand", () => {
    // & is replaced first, so &amp; → &amp;amp; — verifying the documented
    // order so callers know to pass RAW (un-escaped) text exactly once.
    expect(escapeSlackText("&amp;")).toBe("&amp;amp;");
  });

  test("leaves ordinary text untouched", () => {
    expect(escapeSlackText("I felt unsafe at home last night.")).toBe(
      "I felt unsafe at home last night.",
    );
  });
});

describe("canvas helpers — request shaping", () => {
  test("canvasCreate posts JSON document_content and returns the top-level canvas_id", async () => {
    stubFetch({ ok: true, canvas_id: "F0CANVAS" });
    const res = await canvasCreate("xoxb-tok", {
      title: "Quality Pulse — week of 2026-W27",
      markdown: "## This week\nGood.",
    });

    expect(res).toEqual({ ok: true, canvasId: "F0CANVAS", error: undefined });
    expect(captured!.url).toContain("canvases.create");
    expect(contentType(captured!.init)).toContain("application/json");
    const body = JSON.parse(String(captured!.init.body));
    expect(body.title).toBe("Quality Pulse — week of 2026-W27");
    expect(body.document_content).toEqual({
      type: "markdown",
      markdown: "## This week\nGood.",
    });
  });

  test("canvasCreate surfaces missing_scope without throwing", async () => {
    stubFetch({ ok: false, error: "missing_scope" });
    const res = await canvasCreate("xoxb-tok", { markdown: "x" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("missing_scope");
    expect(res.canvasId).toBeUndefined();
    // No title provided → the key is omitted entirely (not sent as undefined).
    const body = JSON.parse(String(captured!.init.body));
    expect("title" in body).toBe(false);
  });

  test("canvasSetAccess posts canvas_id + read access + channel_ids array", async () => {
    stubFetch({ ok: true });
    const res = await canvasSetAccess("xoxb-tok", {
      canvasId: "F0CANVAS",
      channelIds: ["C_ALERTS"],
    });
    expect(res.ok).toBe(true);
    expect(captured!.url).toContain("canvases.access.set");
    expect(contentType(captured!.init)).toContain("application/json");
    const body = JSON.parse(String(captured!.init.body));
    expect(body.canvas_id).toBe("F0CANVAS");
    expect(body.access_level).toBe("read"); // default is read, not write
    expect(body.channel_ids).toEqual(["C_ALERTS"]);
  });

  test("getFilePermalink is form-encoded (READ method) and returns file.permalink", async () => {
    stubFetch({ ok: true, file: { permalink: "https://x.slack.com/canvas/F0CANVAS" } });
    const link = await getFilePermalink("xoxb-tok", "F0CANVAS");
    expect(link).toBe("https://x.slack.com/canvas/F0CANVAS");
    expect(captured!.url).toContain("files.info");
    // files.info is a read method → must be form-encoded, like users.info.
    expect(contentType(captured!.init)).toBe("application/x-www-form-urlencoded");
    expect(String(captured!.init.body)).toBe("file=F0CANVAS");
  });

  test("getFilePermalink returns null on error (never throws)", async () => {
    stubFetch({ ok: false, error: "file_not_found" });
    expect(await getFilePermalink("xoxb-tok", "F0CANVAS")).toBeNull();
  });

  test("fetchCanvasContent returns request_failed when files.info throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;

    await expect(fetchCanvasContent("xoxb-tok", "F0CANVAS")).resolves.toEqual({
      ok: false,
      error: "request_failed",
    });
  });

  test("fetchCanvasContent returns request_failed when the download throws", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            file: {
              filetype: "quip",
              mimetype: "application/vnd.slack-docs",
              pretty_type: "Canvas",
              mode: "quip",
              editable: true,
              url_private_download: "https://files.slack.test/canvas",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockRejectedValueOnce(new Error("download failed")) as typeof fetch;

    await expect(fetchCanvasContent("xoxb-tok", "F0CANVAS")).resolves.toEqual({
      ok: false,
      error: "request_failed",
    });
  });

  test("fetchCanvasContent rejects a downloadable non-canvas file", async () => {
    const download = vi.fn();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            file: {
              filetype: "pdf",
              mimetype: "application/pdf",
              url_private_download: "https://files.slack.test/upload",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementationOnce(download) as typeof fetch;

    await expect(fetchCanvasContent("xoxb-tok", "FUPLOAD")).resolves.toEqual({
      ok: false,
      error: "not_a_canvas",
    });
    expect(download).not.toHaveBeenCalled();
  });

  test("fetchCanvasContent requires every Canvas document marker", async () => {
    const download = vi.fn();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            file: {
              filetype: "quip",
              mimetype: "application/pdf",
              mode: "hosted",
              url_private_download: "https://files.slack.test/not-canvas",
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementationOnce(download) as typeof fetch;

    await expect(fetchCanvasContent("xoxb-tok", "FNOTCANVAS")).resolves.toEqual({
      ok: false,
      error: "not_a_canvas",
    });
    expect(download).not.toHaveBeenCalled();
  });

  test("canvasEdit replaces the WHOLE document — replace op, JSON body, no section_id", async () => {
    stubFetch({ ok: true });
    const res = await canvasEdit("xoxb-tok", {
      canvasId: "F0CANVAS",
      markdown: "# Revised\nNew copy",
    });
    expect(res).toEqual({ ok: true });
    expect(captured!.url).toContain("canvases.edit");
    expect(contentType(captured!.init)).toContain("application/json");
    const body = JSON.parse(String(captured!.init.body));
    expect(body.canvas_id).toBe("F0CANVAS");
    expect(body.changes).toHaveLength(1);
    expect(body.changes[0].operation).toBe("replace");
    // A whole-document replace must NOT scope to a section.
    expect("section_id" in body.changes[0]).toBe(false);
    expect(body.changes[0].document_content).toEqual({
      type: "markdown",
      markdown: "# Revised\nNew copy",
    });
  });

  test("canvasEdit renames in a SECOND call when a title is given", async () => {
    // stubFetch keeps only the last call; capture every call to see both ops.
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const res = await canvasEdit("xoxb-tok", {
      canvasId: "F0CANVAS",
      markdown: "# Revised",
      title: "New title",
    });
    expect(res.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].changes).toMatchObject([{ operation: "replace" }]);
    expect(bodies[1].changes).toMatchObject([
      { operation: "rename", title_content: { type: "markdown", markdown: "New title" } },
    ]);
  });

  test("canvasEdit surfaces a replace error without renaming or throwing", async () => {
    stubFetch({ ok: false, error: "canvas_not_found" });
    const res = await canvasEdit("xoxb-tok", {
      canvasId: "Fmissing",
      markdown: "x",
      title: "T",
    });
    expect(res).toEqual({ ok: false, error: "canvas_not_found" });
  });
});
