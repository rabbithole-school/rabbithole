import { describe, expect, test, afterEach, vi } from "vitest";
import {
  lookupSlackUserByEmail,
  fetchSlackUserInfo,
  fetchThreadReplies,
  fetchConversationMembers,
  postMessage,
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
  renameAgentSession,
  setAgentSessionStatus,
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

  test("fetchSlackUserInfo reports whether the account is a bot", async () => {
    stubFetch({ ok: true, user: { is_bot: true, profile: { display_name: "Deploys" } } });
    expect(await fetchSlackUserInfo("xoxb-tok", "U0DEPLOYBOT")).toMatchObject({
      name: "Deploys",
      isBot: true,
    });
    stubFetch({ ok: true, user: { profile: { display_name: "Lehua" } } });
    expect((await fetchSlackUserInfo("xoxb-tok", "U999")).isBot).toBe(false);
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

  test("agent-session calls go to agents.sessions.*, never the legacy assistant.threads.*", async () => {
    stubFetch({ ok: true });
    await renameAgentSession("xoxb-tok", { channelId: "C1", threadTs: "1.1", title: "Tide pools" });
    expect(captured!.url).toMatch(/\/agents\.sessions\.rename$/);
    expect(JSON.parse(String(captured!.init.body))).toEqual({
      channel_id: "C1",
      thread_ts: "1.1",
      title: "Tide pools",
    });

    await setAgentSessionStatus("xoxb-tok", { channelId: "C1", threadTs: "1.1", status: "processing" });
    expect(captured!.url).toMatch(/\/agents\.sessions\.setStatus$/);
    expect(JSON.parse(String(captured!.init.body))).toEqual({
      channel_id: "C1",
      thread_ts: "1.1",
      status: "processing",
    });
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

  test("labels email links with the address, never the mailto: scheme", () => {
    expect(normalizeSlackLinks("Ana Lee (<mailto:ana@example.com>) is a parent")).toBe(
      "Ana Lee (<mailto:ana@example.com|ana@example.com>) is a parent",
    );
    expect(normalizeSlackLinks("[mailto:ana@example.com](mailto:ana@example.com) or [Ana](mailto:ana@example.com)")).toBe(
      "<mailto:ana@example.com|ana@example.com> or <mailto:ana@example.com|Ana>",
    );
    expect(normalizeSlackLinks("Write ana.lee+x@example.com. Or mailto:bo@example.org")).toBe(
      "Write <mailto:ana.lee+x@example.com|ana.lee+x@example.com>. Or <mailto:bo@example.org|bo@example.org>",
    );
  });

  test("leaves labeled mail links, mentions and addresses inside URLs alone", () => {
    const text =
      "<mailto:ana@example.com|Ana> <@U123> <https://mail.example/?u=ana@example.com|Oct 7> <https://x.example/a@b.com>";
    expect(normalizeSlackLinks(text)).toBe(text);
  });

  test("leaves code, italics and malformed mail markup intact", () => {
    for (const text of [
      "`a@b.com` and ```\nx a@b.com\n```",
      "<mailto:a@b.com?subject=hi there>",
      "a@sub.example.c and a@b.com-x",
    ]) {
      expect(normalizeSlackLinks(text)).toBe(text);
    }
    expect(normalizeSlackLinks("_a@b.com_")).toBe("_<mailto:a@b.com|a@b.com>_");
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

  test("text goes as markdown_text chunks, never the top-level argument", async () => {
    // Slack rejects a stream that mixes the two styles (streaming_mode_mismatch,
    // live-probed 2026-11-08), and task cards only exist as chunks.
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.append("hello");
    await s.flush();
    s.append(" again");
    await s.finish();

    const appends = calls.filter((c) => c.url.includes("chat.appendStream"));
    expect(appends).toHaveLength(2);
    for (const a of appends) {
      expect(a.body.markdown_text).toBeUndefined();
      expect(a.body.chunks).toEqual([
        { type: "markdown_text", text: expect.any(String) },
      ]);
    }
    expect(
      appends.map((a) => (a.body.chunks as Array<{ text: string }>)[0].text).join(""),
    ).toBe("hello again");
  });

  test("setTasks puts cards after the text before them, and updates them in place", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    // All queued before any send happens: order must still hold.
    s.append("Let me look.");
    s.setTasks([{ id: "run0-0", title: "Reading scholar profile", status: "in_progress" }]);
    s.append("Still looking.");
    await s.flush();
    s.setTasks([
      {
        id: "run0-0",
        title: "x".repeat(300), // over Slack's 256 cap → must truncate
        status: "complete",
      },
    ]);
    s.append("Done.");
    await s.finish();

    const chunks = calls
      .filter((c) => c.url.includes("chat.appendStream"))
      .flatMap((c) => c.body.chunks as Array<Record<string, unknown>>);
    expect(chunks.map((c) => `${c.type}:${c.status ?? c.text}`)).toEqual([
      "markdown_text:Let me look.",
      "task_update:in_progress",
      "markdown_text:Still looking.",
      "task_update:complete",
      "markdown_text:Done.",
    ]);
    expect(chunks[1]).toMatchObject({ id: "run0-0", title: "Reading scholar profile" });
    expect((chunks[3].title as string).length).toBe(256);
  });

  test("a card first described after some text never goes out ahead of it", async () => {
    // Live-caught 2026-11-08: with a shared "latest cards" state, an earlier
    // queued update carried a card added later and jumped the text between.
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.setTasks([{ id: "run0-0", title: "Added 3 activities", status: "complete" }]);
    s.append("Now I'll assign it.");
    s.setTasks([{ id: "run1-0", title: "Assigning unit", status: "in_progress" }]);
    await s.finish();

    const order = calls
      .filter((c) => c.url.includes("chat.appendStream"))
      .flatMap((c) => c.body.chunks as Array<Record<string, unknown>>)
      .map((c) => (c.type === "task_update" ? c.id : c.text));
    expect(order).toEqual(["run0-0", "Now I'll assign it.", "run1-0"]);
  });

  test("setTasks resends only the cards that changed", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    const done = { id: "run0-0", title: "Read 7 sessions", status: "complete" as const };
    const planting = { id: "run0-1", title: "Planting seed", status: "in_progress" as const };
    s.setTasks([done]);
    await s.flush();
    s.setTasks([done, planting]);
    await s.flush();
    s.setTasks([done, planting]);
    await s.finish();

    const sent = calls
      .filter((c) => c.url.includes("chat.appendStream"))
      .map((c) => (c.body.chunks as Array<{ id: string }>).map((t) => t.id));
    expect(sent).toEqual([["run0-0"], ["run0-1"]]);
  });

  test("card updates queued back to back go out once, in their latest state", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.setTasks([{ id: "run0-0", title: "Adding activity…", status: "in_progress" }]);
    s.setTasks([{ id: "run0-0", title: "Added activity", status: "complete" }]);
    await s.finish();

    const chunks = calls
      .filter((c) => c.url.includes("chat.appendStream"))
      .flatMap((c) => c.body.chunks as Array<Record<string, unknown>>);
    expect(chunks).toEqual([
      { type: "task_update", id: "run0-0", title: "Added activity", status: "complete" },
    ]);
  });

  test("a carded reply's cleanup rebuilds the blocks instead of erasing the cards", async () => {
    // chat.update with markdown_text replaces the whole message, cards
    // included (live-probed 2026-11-08), so a reply with cards is rebuilt.
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.append("Checking.");
    s.setTasks([
      { id: "run0-0", title: "Assigning unit", status: "error", details: "No cohort named Otters" },
    ]);
    s.append("See (https://github.example/org/site/pull/56)).");
    await s.finish();

    const update = calls.at(-1)!;
    expect(update.url).toContain("chat.update");
    expect(update.body.markdown_text).toBeUndefined();
    // No `text`: beside blocks Slack caps it at 4,000 characters
    // (msg_too_long), and without it Slack builds it from the blocks.
    expect(update.body).not.toHaveProperty("text");
    expect(update.body.blocks).toEqual([
      { type: "markdown", text: "Checking." },
      {
        type: "task_card",
        task_id: "run0-0",
        title: "Assigning unit",
        status: "error",
        details: {
          type: "rich_text",
          elements: [
            {
              type: "rich_text_section",
              elements: [{ type: "text", text: "No cohort named Otters" }],
            },
          ],
        },
      },
      { type: "markdown", text: "See (<https://github.example/org/site/pull/56>))." },
    ]);
  });

  test("a carded reply whose cleanup changes nothing is left as streamed", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
    s.append("Checking.");
    s.setTasks([{ id: "run0-0", title: "Read 7 sessions", status: "complete" }]);
    s.append("All good.");
    await s.finish();
    expect(calls.at(-1)!.url).toContain("chat.stopStream");
  });

  test("a card update Slack rejected is retried once before the stream stops", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let rejectedOnce = false;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      const chunks = (body.chunks ?? []) as Array<{ status?: string }>;
      const settling = chunks.some((c) => c.status === "complete");
      if (String(url).includes("appendStream") && settling && !rejectedOnce) {
        rejectedOnce = true;
        return Response.json({ ok: false, error: "ratelimited" });
      }
      return Response.json({ ok: true, ts: "5.5" });
    }) as typeof fetch;
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", { channel: "C1", threadTs: "1.1", recipientUserId: "U1" });
    s.setTasks([{ id: "run0-0", title: "Adding activity…", status: "in_progress" }]);
    await s.flush();
    s.setTasks([{ id: "run0-0", title: "Added activity", status: "complete" }]);
    await s.flush();
    await s.finish();

    const methods = calls.map((c) => c.url.split("/").pop());
    expect(methods).toEqual([
      "chat.startStream",
      "chat.appendStream", // in_progress, accepted
      "chat.appendStream", // complete, rejected
      "chat.appendStream", // complete, retried
      "chat.stopStream",
    ]);
  });

  test("an open stream that stops taking text gets closed, and only the rest is posted", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let appends = 0;
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      if (String(url).includes("appendStream") && ++appends === 2) {
        return Response.json({ ok: false, error: "message_not_in_streaming_state" });
      }
      return Response.json({ ok: true, ts: "5.5" });
    }) as typeof fetch;
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", { channel: "C1", threadTs: "1.1", recipientUserId: "U1" });
    s.append("First part.");
    await s.flush();
    s.append("\n\nSecond part.");
    await s.flush();
    await s.finish();

    const tail = calls.map((c) => c.url.split("/").pop()).slice(-2);
    expect(tail).toEqual(["chat.stopStream", "chat.postMessage"]);
    expect(calls.at(-1)!.body.markdown_text).toBe("Second part.");
  });

  test("setTasks degrades silently when streaming is unavailable", async () => {
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
    s.setTasks([{ id: "t", title: "T", status: "in_progress" }]);
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

  test("applies finalization before normalizing a completed stream", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
      finalize: (text) => text.replace("wrong-id", "correct-id"),
    });
    s.append("See https://docs.google.com/document/d/wrong-id/edit");
    await s.flush();
    await s.finish();

    expect(calls.at(-1)!.url).toContain("chat.update");
    expect(calls.at(-1)!.body.markdown_text).toBe(
      "See <https://docs.google.com/document/d/correct-id/edit>",
    );
  });

  test("applies finalization in the single-message fallback", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
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
      finalize: (text) => text.replace("wrong-id", "correct-id"),
    });
    s.append("See https://docs.google.com/document/d/wrong-id/edit");
    await s.flush();
    await s.finish();

    expect(calls.at(-1)!.url).toContain("chat.postMessage");
    expect(calls.at(-1)!.body.markdown_text).toBe(
      "See <https://docs.google.com/document/d/correct-id/edit>",
    );
  });

  test("streams a person's @Name as a real mention, even split across deltas", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
      mentions: [{ slackUserId: "U_LEHUA", name: "Lehua Torres" }],
    });
    s.append("One question for @Lehua To");
    await s.flush();
    s.append("rres: should it stay?");
    await s.finish();

    const texts = calls
      .filter((c) => c.url.includes("chat.appendStream"))
      .flatMap((c) => c.body.chunks as Array<{ text?: string }>)
      .map((c) => c.text);
    // The half-written name was held back rather than sent as text.
    expect(texts).toEqual(["One question for ", "<@U_LEHUA>: should it stay?"]);
    // Already a mention when it streamed, so nothing needed a later edit.
    expect(calls.some((c) => c.url.includes("chat.update"))).toBe(false);
  });

  test("a name held back at the end of a text run goes out before the next card", async () => {
    const calls = captureAll();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
      mentions: [{ slackUserId: "U_LEHUA", name: "Lehua Torres" }],
    });
    s.append("Checking with @Lehua Torres");
    s.setTasks([{ id: "run0-0", title: "Reading roster", status: "in_progress" }]);
    s.append("Done.");
    await s.finish();

    const chunks = calls
      .filter((c) => c.url.includes("chat.appendStream"))
      .flatMap((c) => c.body.chunks as Array<Record<string, unknown>>);
    expect(chunks.map((c) => `${c.type}:${c.status ?? c.text}`)).toEqual([
      "markdown_text:Checking with <@U_LEHUA>",
      "task_update:in_progress",
      "markdown_text:Done.",
    ]);
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

describe("SlackStreamer and Slack's Stop button", () => {
  // Slack does not end a stream on the click: appends keep succeeding until
  // the app stops the stream itself (live-probed 2026-11-08).
  function fakeSlack() {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      calls.push({ method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, ts: "42.7" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return calls;
  }

  async function newStreamer() {
    const { SlackStreamer } = await import("../slackApi");
    return new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
    });
  }

  test("halt() drops the unsent words, settles the cards Slack shows, then stops the stream", async () => {
    const calls = fakeSlack();
    const s = await newStreamer();
    s.append("Let me look.");
    s.setTasks([{ id: "run0-0", title: "Reading recent sessions…", status: "in_progress" }]);
    await s.flush();
    const sentBefore = calls.length;
    s.append(" Kai has three sessions this week"); // buffered, not yet sent

    const halted = await s.halt([
      { id: "run0-0", title: "Read 3 sessions", status: "complete" },
      { id: "run0-1", title: "never shown", status: "complete" },
    ]);
    await s.finish(); // a no-op once halted

    expect(halted).toEqual({ shown: true, unsentChars: " Kai has three sessions this week".length });
    const after = calls.slice(sentBefore);
    expect(after.map((c) => c.method)).toEqual(["chat.appendStream", "chat.stopStream"]);
    // Only the card Slack already shows, in its settled state; no text.
    expect(after[0].body.chunks).toEqual([
      { type: "task_update", id: "run0-0", title: "Read 3 sessions", status: "complete" },
    ]);
    expect(JSON.stringify(calls)).not.toContain("Kai has three");
    expect(JSON.stringify(calls)).not.toContain("never shown");
  });

  test("halt() never sends the words queued behind a send still in flight", async () => {
    const calls: string[] = [];
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      const body = JSON.parse(String(init?.body)) as { chunks?: Array<{ text?: string }> };
      if (method === "chat.appendStream") {
        calls.push(body.chunks?.[0]?.text ?? "");
        if (calls.length === 1) await blocked;
      }
      return new Response(JSON.stringify({ ok: true, ts: "42.7" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const s = await newStreamer();
    s.append("Let me look."); // goes out at once, and Slack is slow to answer
    await new Promise((resolve) => setTimeout(resolve, 0));
    s.append(" Kai has three"); // queued behind it
    const halted = s.halt();
    release();
    expect(await halted).toEqual({ shown: true, unsentChars: " Kai has three".length });
    expect(calls).toEqual(["Let me look."]);
  });

  test("halt() counts unsent text in the model's characters, mentions included", async () => {
    // The caller trims its copy of the model's text by unsentChars, so a
    // rewritten mention must count as the name the model wrote.
    const calls = fakeSlack();
    const { SlackStreamer } = await import("../slackApi");
    const s = new SlackStreamer("xoxb-tok", {
      channel: "C1",
      threadTs: "1.1",
      recipientUserId: "U1",
      mentions: [{ slackUserId: "U0123456789", name: "Avery Stone" }],
    });
    s.append("Thanks @Avery Stone. ");
    await s.flush(); // sent, with the mention rewritten
    // Queued with one mention rewritten, and a half-written name held back.
    const unsent = "Next, @Avery Stone, then @Avery Sto";
    s.append(unsent);
    const halted = await s.halt();

    expect(halted).toEqual({ shown: true, unsentChars: unsent.length });
    const sent = calls
      .filter((c) => c.method === "chat.appendStream")
      .flatMap((c) => c.body.chunks as Array<{ text?: string }>)
      .map((c) => c.text);
    expect(sent).toEqual(["Thanks <@U0123456789>. "]);
  });

  test("halt() before anything reached Slack says so and sends nothing", async () => {
    const calls = fakeSlack();
    const s = await newStreamer();
    expect(await s.halt()).toEqual({ shown: false, unsentChars: 0 });
    await s.finish(); // still a no-op: no "(no response)" post
    expect(calls).toHaveLength(0);
  });

  test("a message closed mid-turn keeps the session processing, so Stop stays up", async () => {
    const calls = fakeSlack();
    const s = await newStreamer();
    s.append("A long first part.");
    await s.finish(undefined, { keepSessionProcessing: true });
    const last = await newStreamer();
    last.append("The end.");
    await last.finish();

    const stops = calls.filter((c) => c.method === "chat.stopStream");
    expect(stops[0].body.session_status).toBe("processing");
    // The turn's last message leaves it to Slack's default (`active`).
    expect(stops[1].body).not.toHaveProperty("session_status");
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
