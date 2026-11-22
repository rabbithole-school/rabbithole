// Rabbithole and Claude Tag in one Slack thread (convex/lib/slackPeerBots.ts).
//
// Rabbithole hands staff code requests to Claude Tag ("reply `@Claude go`").
// A live test on 2026-11-10 had the requester answer Claude's question with a
// message that mentioned only Claude, and Rabbithole replied anyway. These
// tests pin the three rules: a mention of another bot alone is not for
// Rabbithole; a thread Claude has joined is answered only on a direct mention;
// and when Rabbithole does answer there, Claude reads as its own speaker.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { SlackMessage } from "../lib/slackApi";
import { buildSlackTranscript } from "../lib/slackTranscript";
import { resolveSharedSlackLinks, SLACK_STREAM_TEXT_SOFT_LIMIT } from "../slackBot";
import {
  CLAUDE_TAG_SLACK_USER_ID as CLAUDE,
  CLAUDE_TAG_TRANSCRIPT_NAME,
  claudeHasJoinedThread,
  mentionsPeerBot,
  peerBotUserIds,
  relabelClaudeMessages,
  slackMentionTargets,
  threadInvolvesClaude,
} from "../lib/slackPeerBots";

const { slackToolRunner } = vi.hoisted(() => ({
  slackToolRunner: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = { messages: { toolRunner: slackToolRunner } };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

beforeEach(() => {
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const BOT = "B_BOT";
const CHANNEL = "C_BUILDS";
const THREAD = "500.000";

/** The thread Slack hands back: a Rabbithole handoff, the requester's
 *  `@Claude go`, Claude's scoping question. */
const claudeThread: SlackMessage[] = [
  { ts: "500.000", user: "U_LEHUA", text: "can the roster export include pronouns?" },
  {
    ts: "500.100",
    user: BOT,
    bot_id: "B_RH",
    text: "That needs a code change. Reply `@Claude go` and Claude will scope it with you.",
  },
  { ts: "500.200", user: "U_LEHUA", text: `<@${CLAUDE}> go` },
  {
    ts: "500.300",
    user: CLAUDE,
    bot_id: "B_CLAUDE",
    text: "Should pronouns be a new CSV column or folded into the name column?",
  },
];

const plainThread: SlackMessage[] = claudeThread.slice(0, 2);

/** Answers every Slack call; `conversations.replies` returns `thread`. The
 *  speaker is UNMAPPED unless a test seeds them, so reaching runConversation
 *  shows up as exactly one postMessage (the "can't tell who you are" notice). */
function stubSlack(thread: SlackMessage[], opts: { repliesOk?: boolean } = {}) {
  const calls: string[] = [];
  // The reply text as Slack received it (streamed chunks or a posted message).
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/api/")[1] ?? String(url);
    calls.push(method);
    if (method === "chat.appendStream" || method === "chat.postMessage") {
      const body = JSON.parse(String(init?.body)) as {
        chunks?: Array<{ type: string; text?: string }>;
        markdown_text?: string;
      };
      for (const c of body.chunks ?? []) {
        if (c.type === "markdown_text" && c.text) sent.push(c.text);
      }
      if (body.markdown_text) sent.push(body.markdown_text);
    }
    if (method === "conversations.replies") {
      return Response.json(
        opts.repliesOk === false
          ? { ok: false, error: "ratelimited" }
          : { ok: true, messages: thread },
      );
    }
    if (method === "conversations.info") {
      return Response.json({ ok: true, channel: { id: CHANNEL, is_channel: true } });
    }
    if (method === "users.info") {
      return Response.json({ ok: true, user: { real_name: "Lehua Torres" } });
    }
    return Response.json({ ok: true, ts: "9.9" });
  }) as typeof fetch;
  return {
    calls: () => calls,
    posts: () => calls.filter((c) => c === "chat.postMessage"),
    sent: () => sent.join(""),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function seedKnownThread(t: ReturnType<typeof convexTest>) {
  await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Avery Stone",
      username: "avery-peer",
      role: "platform_admin",
    });
    const chatId = await ctx.db.insert("chats", {
      teacherId: userId,
      title: "Roster export",
      pinned: false,
      lastMessageAt: Date.now(),
    });
    await ctx.db.insert("slackThreads", {
      channelId: CHANNEL,
      threadTs: THREAD,
      chatId,
      startedByUserId: userId,
      lastActivityAt: Date.now(),
    });
  });
}

async function deliver(
  t: ReturnType<typeof convexTest>,
  thread: SlackMessage[],
  event: Record<string, unknown>,
  opts: { repliesOk?: boolean } = {},
) {
  const stub = stubSlack(thread, opts);
  try {
    await t.action(internal.slackBot.handleEvent, {
      payload: {
        team_id: "T1",
        event_id: `Ev${Math.random()}`,
        authorizations: [{ user_id: BOT, is_bot: true }],
        event: {
          type: "message",
          user: "U_LEHUA",
          channel: CHANNEL,
          channel_type: "channel",
          ts: "500.900",
          thread_ts: THREAD,
          ...event,
        },
      },
    });
  } finally {
    stub.restore();
  }
  return stub;
}

describe("peer-bot helpers", () => {
  test("Claude is always a peer bot; another app is one once it posts", () => {
    const thread: SlackMessage[] = [
      { ts: "1", user: BOT, bot_id: "B_RH", text: "mine" },
      { ts: "2", user: "U0DEPLOYBOT", bot_id: "B_DEPLOY", text: "deployed" },
      { ts: "3", user: "U_LEHUA", text: "a person" },
    ];
    const ids = peerBotUserIds(thread, BOT);
    expect([...ids].sort()).toEqual([CLAUDE, "U0DEPLOYBOT"].sort());
    // Without our own id, a bot message can't be told from our own.
    expect([...peerBotUserIds(thread, null)]).toEqual([CLAUDE]);
  });

  test("mentions are read from Slack's <@id> tokens", () => {
    const peers = peerBotUserIds([], BOT);
    expect(mentionsPeerBot(`<@${CLAUDE}> a new column`, peers)).toBe(true);
    expect(mentionsPeerBot("<@U0HOKU> can you check?", peers)).toBe(false);
    expect(mentionsPeerBot("ask Claude about it", peers)).toBe(false);
  });

  test("Claude is in a thread once it has posted or been mentioned", () => {
    expect(threadInvolvesClaude(plainThread)).toBe(false);
    expect(threadInvolvesClaude(claudeThread.slice(0, 3))).toBe(true);
    expect(threadInvolvesClaude(claudeThread)).toBe(true);
  });

  test("a reply may mention the people in the thread, never a bot", () => {
    const names = new Map([
      ["U_LEHUA", "Lehua Torres"],
      ["U_HOKU", "Hoku Makani"], // only mentioned, never posted
      [BOT, "Rabbithole"],
      [CLAUDE, CLAUDE_TAG_TRANSCRIPT_NAME],
      ["U0DEPLOYBOT", "Deploys"],
      ["U0BUILDBOT", "Build Bot"], // a bot that was only mentioned
    ]);
    const thread: SlackMessage[] = [
      ...claudeThread,
      { ts: "500.400", user: "U0DEPLOYBOT", bot_id: "B_DEPLOY", text: "deployed" },
    ];
    // Slack's is_bot flag (from users.info) is the only sign of the bot that
    // never posted.
    const slackBots = new Set(["U0BUILDBOT"]);
    expect(slackMentionTargets(names, thread, BOT, slackBots)).toEqual([
      { slackUserId: "U_LEHUA", name: "Lehua Torres" },
      { slackUserId: "U_HOKU", name: "Hoku Makani" },
    ]);
    // Without our own id, our own messages' author still counts as a bot.
    expect(
      slackMentionTargets(names, thread, null, slackBots).map((t) => t.slackUserId),
    ).toEqual(["U_LEHUA", "U_HOKU"]);
  });

  test("Claude has joined only once it has posted", () => {
    expect(claudeHasJoinedThread(plainThread)).toBe(false);
    // The requester's `@Claude go` is a mention, not Claude posting.
    expect(claudeHasJoinedThread(claudeThread.slice(0, 3))).toBe(false);
    expect(claudeHasJoinedThread(claudeThread)).toBe(true);
  });
});

describe("routing a thread follow-up that isn't for Rabbithole", () => {
  test("a reply that mentions only Claude gets no reply, without a Slack read", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const stub = await deliver(t, plainThread, {
      text: `<@${CLAUDE}> a new column, please`,
    });
    expect(stub.calls()).toEqual([]);
  });

  test("a reply that mentions another app that posted here gets no reply", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const thread: SlackMessage[] = [
      ...plainThread,
      { ts: "500.150", user: "U0DEPLOYBOT", bot_id: "B_DEPLOY", text: "Preview is up." },
    ];
    const stub = await deliver(t, thread, { text: "<@U0DEPLOYBOT> redeploy please" });
    expect(stub.posts()).toEqual([]);
  });

  test("once Claude has joined, an un-mentioned follow-up gets no reply", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const stub = await deliver(t, claudeThread, {
      text: "a new column, and keep the old export working",
    });
    expect(stub.posts()).toEqual([]);
  });

  test("Claude's own post without a bot_id is never answered as a staff member", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const stub = await deliver(t, claudeThread, {
      user: CLAUDE,
      text: "Opened a draft PR.",
    });
    expect(stub.calls()).toEqual([]);
  });

  test("an ordinary follow-up in a thread without Claude is still answered", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const stub = await deliver(t, plainThread, { text: "and the grade too?" });
    expect(stub.posts()).toHaveLength(1);
  });

  test("a mention of a human is still answered", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const stub = await deliver(t, plainThread, { text: "<@U0HOKU> thoughts?" });
    expect(stub.posts()).toHaveLength(1);
  });

  test("if Slack won't return the thread, it answers as before", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const stub = await deliver(
      t,
      claudeThread,
      { text: "and the grade too?" },
      { repliesOk: false },
    );
    expect(stub.posts()).toHaveLength(1);
  });
});

describe("a direct mention of Rabbithole in Claude's thread", () => {
  afterEach(() => {
    slackToolRunner.mockReset();
  });

  test("is answered", async () => {
    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    const stub = stubSlack(claudeThread);
    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: "EvMentionInClaudeThread",
          authorizations: [{ user_id: BOT, is_bot: true }],
          event: {
            type: "app_mention",
            user: "U_LEHUA",
            text: `<@${BOT}> which scholars have pronouns set?`,
            channel: CHANNEL,
            ts: "500.900",
            thread_ts: THREAD,
          },
        },
      });
    } finally {
      stub.restore();
    }
    // Unmapped speaker → the one identity notice: the mention reached the turn.
    expect(stub.posts()).toHaveLength(1);
  });

  /** One full turn: a mapped teacher @-mentions Rabbithole at the end of
   *  `prior`, and the model answers `reply` (streamed one delta per entry).
   *  Returns what the model was handed and what Slack was sent. */
  async function runMentionTurn(
    prior: SlackMessage[],
    reply: string | string[] = "Three scholars do.",
  ) {
    let config: { messages: Array<{ role: string; content: unknown }> } = {
      messages: [],
    };
    slackToolRunner.mockImplementationOnce((c: typeof config) => {
      config = c;
      return {
        async *[Symbol.asyncIterator]() {
          yield {
            async *[Symbol.asyncIterator]() {
              yield {
                type: "message_start",
                message: {
                  model: "claude-test",
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              };
              for (const text of Array.isArray(reply) ? reply : [reply]) {
                yield {
                  type: "content_block_delta",
                  delta: { type: "text_delta", text },
                };
              }
            },
          };
        },
      };
    });

    const t = convexTest(schema, modules);
    await seedKnownThread(t);
    await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "moli-peer",
        slug: "moli-peer",
        kind: "school" as const,
      });
      const userId = await ctx.db.insert("users", {
        name: "Lehua Torres",
        username: "lehua-peer",
        role: "teacher",
        slackUserId: "U_LEHUA",
        institutionId,
      });
      await ctx.db.insert("memberships", {
        userId,
        role: "teacher",
        institutionId,
      });
    });

    const trigger = `<@${BOT}> which scholars have pronouns set?`;
    const thread: SlackMessage[] = [
      ...prior,
      { ts: "500.900", user: "U_LEHUA", thread_ts: THREAD, text: trigger },
    ];
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const stub = stubSlack(thread);
    try {
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: `EvTurn${Math.random()}`,
          authorizations: [{ user_id: BOT, is_bot: true }],
          event: {
            type: "app_mention",
            user: "U_LEHUA",
            text: trigger,
            channel: CHANNEL,
            ts: "500.900",
            thread_ts: THREAD,
          },
        },
      });
    } finally {
      stub.restore();
    }
    expect(slackToolRunner).toHaveBeenCalledTimes(1);
    const textOf = (c: unknown): string =>
      typeof c === "string"
        ? c
        : (c as Array<{ type: string; text?: string }>)
            .map((b) => b.text ?? "")
            .join("\n");
    const byRole = (role: string) =>
      config.messages
        .filter((m) => m.role === role)
        .map((m) => textOf(m.content))
        .join("\n");
    return {
      assistantText: byRole("assistant"),
      userText: byRole("user"),
      everything: JSON.stringify(config),
      slackText: stub.sent(),
    };
  }

  test("hands the model Claude's messages as Claude's, not Rabbithole's or the requester's", async () => {
    const { assistantText, userText, everything } =
      await runMentionTurn(claudeThread);
    expect(assistantText).not.toContain("new CSV column");
    expect(userText).toContain(
      `${CLAUDE_TAG_TRANSCRIPT_NAME}: Should pronouns be a new CSV column`,
    );
    expect(userText).not.toContain("Lehua Torres: Should pronouns");
    // Rabbithole's own handoff stays Rabbithole's.
    expect(assistantText).toContain("Reply `@Claude go`");
    // Claude is in this thread, so it is a listed participant.
    expect(everything).toMatch(
      new RegExp(`Thread participants: [^"]*${CLAUDE_TAG_TRANSCRIPT_NAME.replace(/[()]/g, "\\$&")}`),
    );
  });

  test("the reply's @Name for a person pings them; @Claude stays text", async () => {
    // The model sees "@Lehua Torres", never an id, and writes the name back.
    // Mentioning Claude for real would summon it, so that one stays text.
    const { slackText } = await runMentionTurn(
      claudeThread,
      "@Lehua Torres, three scholars do. @Claude can add the column.",
    );
    expect(slackText).toBe(
      "<@U_LEHUA>, three scholars do. @Claude can add the column.",
    );
  });

  test("a name cut by a long reply's move to a new message still pings", async () => {
    // The second delta fits the first message and its name is held back; the
    // third pushes past the soft limit, so the reply continues in a new
    // message, and the held name has to go with it.
    const filler = "x".repeat(SLACK_STREAM_TEXT_SOFT_LIMIT - 11) + " ";
    const { slackText } = await runMentionTurn(plainThread, [
      filler,
      "@Lehua To",
      "rres, please review.",
    ]);
    expect(slackText).toBe(`${filler}<@U_LEHUA>, please review.`);
  });

  test("a thread without Claude never mentions Claude to the model", async () => {
    const { everything } = await runMentionTurn([
      { ts: "500.000", user: "U_LEHUA", text: "can the roster export include pronouns?" },
    ]);
    expect(everything).toContain("Thread participants:");
    expect(everything).not.toContain(CLAUDE_TAG_TRANSCRIPT_NAME);
  });
});

describe("a linked Claude message", () => {
  test("is attributed to Claude, not Rabbithole", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      const method = String(url).split("/api/")[1] ?? String(url);
      if (method === "conversations.replies") {
        return Response.json({
          ok: true,
          messages: [
            {
              ts: "1783662930.395019",
              user: CLAUDE,
              bot_id: "B_CLAUDE",
              text: "Opened a draft PR for the pronoun column.",
            },
          ],
        });
      }
      if (method === "users.info") {
        return Response.json({ ok: true, user: { real_name: "Claude" } });
      }
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      const resolved = await resolveSharedSlackLinks(
        "xoxb-test",
        // Same-channel link (Slack ids carry no underscores), so no membership read.
        "<@UBOT00001> explain <https://example.slack.com/archives/CBUILDS01/p1783662930395019>",
        "UBOT00001",
        "CBUILDS01",
        "U_LEHUA",
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        ok: true,
        authorName: CLAUDE_TAG_TRANSCRIPT_NAME,
        text: "Opened a draft PR for the pronoun column.",
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the transcript builder, fed relabelled messages", () => {
  test("Claude's message is a named user turn and its mention reads as Claude", () => {
    const names = new Map([
      ["U_LEHUA", "Lehua Torres"],
      [CLAUDE, CLAUDE_TAG_TRANSCRIPT_NAME],
    ]);
    const turns = buildSlackTranscript({
      messages: relabelClaudeMessages(claudeThread),
      botUserId: BOT,
      names,
    });
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    const last = String(turns[2].content);
    expect(last).toContain(`Lehua Torres: @${CLAUDE_TAG_TRANSCRIPT_NAME} go`);
    expect(last).toContain(
      `${CLAUDE_TAG_TRANSCRIPT_NAME}: Should pronouns be a new CSV column`,
    );
    // Without the relabel, the same message was read as Rabbithole's own.
    const before = buildSlackTranscript({ messages: claudeThread, botUserId: BOT, names });
    expect(String(before.at(-1)?.content)).toContain("Should pronouns");
    expect(before.at(-1)?.role).toBe("assistant");
  });

  test("relabelling leaves every other message as it was", () => {
    const out = relabelClaudeMessages(claudeThread);
    expect(out.slice(0, 3)).toEqual(claudeThread.slice(0, 3));
    expect(out[3].bot_id).toBeUndefined();
    expect(out[3].user).toBe(CLAUDE);
  });
});
