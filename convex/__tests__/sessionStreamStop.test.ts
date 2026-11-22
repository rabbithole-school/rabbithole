/**
 * /session-stream × a scholar's Stop. Aborting the Anthropic request while
 * the reply is still arriving ended the turn silently on the dev rig
 * (2026-11-09): the stopped row kept its streamId and was never finalized
 * or billed. A stop now reads the rest of the message unseen and ends at
 * its boundary, so finalizeStream and recordUsage run.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";

const { toolRunner, messagesStream } = vi.hoisted(() => ({
  toolRunner: vi.fn(),
  messagesStream: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = { messages: { toolRunner } };
    messages = { stream: messagesStream };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;
type Event = Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
  toolRunner.mockReset();
  messagesStream.mockReset();
});

const start: Event = {
  type: "message_start",
  message: { model: "claude-test", usage: { input_tokens: 3, output_tokens: 0 } },
};
const say = (text: string): Event => ({
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text },
});
const toolUse: Event = {
  type: "content_block_start",
  index: 1,
  content_block: { type: "tool_use", id: "t1", name: "create_artifact", input: {} },
};
const end = (output: number): Event => ({
  type: "message_delta",
  delta: { stop_reason: "tool_use" },
  usage: { output_tokens: output },
});

async function seedTurn(t: TestCtx) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: `hoku-${crypto.randomUUID()}`,
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Volcanoes",
      isArchived: false,
    });
    await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "How do volcanoes form?",
      flagged: false,
    });
    const streamId = crypto.randomUUID();
    const assistantMsgId = await ctx.db.insert("messages", {
      sessionId,
      role: "assistant",
      content: "",
      streamId,
      flagged: false,
    });
    const authSessionId = await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
    return { userId, sessionId, streamId, assistantMsgId, authSessionId };
  });
}

function asScholar(t: TestCtx, turn: Awaited<ReturnType<typeof seedTurn>>) {
  return t.withIdentity({
    subject: `${turn.userId}|${turn.authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function runTurn(t: TestCtx, turn: Awaited<ReturnType<typeof seedTurn>>) {
  const response = await asScholar(t, turn).fetch("/session-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: turn.sessionId,
      streamId: turn.streamId,
      assistantMsgId: turn.assistantMsgId,
      platform: "web",
    }),
  });
  const events = (await response.text())
    .split("\n\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => JSON.parse(l.slice(6)) as Record<string, unknown>);
  return { status: response.status, events };
}

const long = "Magma rises through cracks in the crust. ".repeat(8); // > persist cadence

describe("/session-stream stop", () => {
  test("a Stop mid-reply finalizes and bills the reply, with no abort and no further tool", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    const seen = { aborted: 0, toolRan: false };
    const pressStop = () =>
      asScholar(t, turn).mutation(api.sessions.requestStop, {
        sessionId: turn.sessionId,
      });
    // The stop lands, and the next persist (every ~200 characters) is
    // where the stream sees it; from there on nothing more is shown.
    const messages: Array<Array<Event | (() => Promise<unknown>)>> = [
      [start, say("Great question. "), pressStop, say(long), say("never shown"), toolUse, end(11)],
      [start, say("Here is your diagram.")],
    ];
    const stream = (steps: Array<Event | (() => Promise<unknown>)>) => ({
      abort: () => {
        seen.aborted++;
      },
      async *[Symbol.asyncIterator]() {
        for (const step of steps) {
          if (typeof step === "function") await step();
          else yield step;
        }
      },
    });
    toolRunner.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < messages.length; i++) {
          if (i > 0) seen.toolRan = true;
          yield stream(messages[i]);
        }
      },
    }));
    messagesStream.mockImplementation(() => stream(messages[0]));

    const { status, events } = await runTurn(t, turn);

    expect(status).toBe(200);
    expect(seen.aborted).toBe(0);
    expect(seen.toolRan).toBe(false);
    const shown = events.filter((e) => "text" in e).map((e) => e.text).join("");
    expect(shown).not.toContain("never shown");
    expect(events.at(-1)).toMatchObject({ done: true, stopped: true });
    const row = await t.run((ctx) => ctx.db.get(turn.assistantMsgId as Id<"messages">));
    expect(row).toMatchObject({ model: "claude-test", tokensUsed: 11 });
    expect(row?.streamId).toBeUndefined();
    expect(row?.stopRequestedAt).toEqual(expect.any(Number));
    expect(row?.content).toBe(shown);
    expect(shown).toBe(`Great question. ${long}`);
    const usage = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(usage.length).toBeGreaterThan(0);
  });

  test("a stopped reply finalized after the next turn is billed but keeps the newer preview", async () => {
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    // The scholar steered: the next turn started and finished while the
    // stopped reply was still reading out.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId: turn.sessionId,
        role: "user",
        content: "Actually, tell me about lava.",
        flagged: false,
      });
      const newer = await ctx.db.insert("messages", {
        sessionId: turn.sessionId,
        role: "assistant",
        content: "",
        streamId: crypto.randomUUID(),
        flagged: false,
      });
      await ctx.runMutation(internal.sessionHelpers.finalizeStream, {
        messageId: newer,
        sessionId: turn.sessionId,
        content: "Lava is magma that reaches the surface.",
        model: "claude-test",
        tokensUsed: 5,
      });
    });
    await t.mutation(internal.sessionHelpers.finalizeStream, {
      messageId: turn.assistantMsgId,
      sessionId: turn.sessionId,
      content: "Magma rises through",
      model: "claude-test",
      tokensUsed: 9,
    });
    const { row, session } = await t.run(async (ctx) => ({
      row: await ctx.db.get(turn.assistantMsgId),
      session: await ctx.db.get(turn.sessionId),
    }));
    expect(row).toMatchObject({ content: "Magma rises through", tokensUsed: 9 });
    expect(row?.streamId).toBeUndefined();
    expect(session?.lastMessagePreview).toBe("Lava is magma that reaches the surface.");
  });
});
