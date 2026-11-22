/**
 * /session-stream × mark_activity_complete (TRA-703). The completing turn used
 * to carry no tutor text: the app's stock line replaced the reply, so a
 * scholar's last question or correction went unanswered. Now the tutor
 * answers after the tool, and the app's plain "activity is done" note lands
 * last, in its own message.
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { completionClosingPool } from "../lib/tutorClosingGuidance";
import schema from "../schema";

const { toolRunner } = vi.hoisted(() => ({ toolRunner: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = { messages: { toolRunner } };
    messages = { stream: vi.fn() };
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
type RunnableTool = { name: string; run: (input: unknown) => Promise<unknown> };

afterEach(() => {
  vi.unstubAllEnvs();
  toolRunner.mockReset();
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
const completeTool: Event = {
  type: "content_block_start",
  index: 0,
  content_block: {
    type: "tool_use",
    id: "t1",
    name: "mark_activity_complete",
    input: {},
  },
};

const CORRECTION = "No, 40 doubled is 80 not 70. I think you made a math error.";
const REPLY = "You're right: 40 doubled is 80. That was my mistake.";

async function seedTurn(t: TestCtx) {
  return await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "Sloane Kahale",
      username: `sloane-${crypto.randomUUID()}`,
      role: "teacher",
    });
    const userId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: `hoku-${crypto.randomUUID()}`,
      role: "scholar",
      readingLevel: "5",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Puzzles",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Doubling",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "A few puzzles",
      kind: "online",
      order: 0,
      systemPrompt: "Work a few doubling puzzles with the scholar.",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      unitId,
      lessonId,
      activityId,
      title: "A few puzzles",
      isArchived: false,
    });
    for (const content of ["5 doubled is 10", "20 doubled is 40", CORRECTION]) {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content,
        flagged: false,
      });
    }
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

async function runTurn(t: TestCtx, turn: Awaited<ReturnType<typeof seedTurn>>) {
  const response = await t
    .withIdentity({
      subject: `${turn.userId}|${turn.authSessionId}`,
      issuer: "https://convex.dev",
    })
    .fetch("/session-stream", {
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

/**
 * A fake runner: the tool-first message, the tool run, then `after`.
 * `afterTool` runs between the tool and the reply (a stop or a disconnect);
 * `done` resolves once the runner has yielded everything.
 */
function scriptTurn(
  after: Event[],
  hooks: {
    afterTool?: () => Promise<void>;
    done?: () => void;
    failAfterTool?: boolean;
  } = {},
) {
  toolRunner.mockImplementation((params: { tools: RunnableTool[] }) => {
    const stream = (steps: Event[]) => ({
      abort: () => {},
      async *[Symbol.asyncIterator]() {
        yield* steps;
      },
    });
    return {
      async *[Symbol.asyncIterator]() {
        yield stream([start, completeTool]);
        const tool = params.tools.find(
          (candidate) => candidate.name === "mark_activity_complete",
        )!;
        await tool.run({ summary: "Worked doubling puzzles." });
        await hooks.afterTool?.();
        if (hooks.failAfterTool) throw new Error("model overloaded");
        yield stream([start, ...after]);
        hooks.done?.();
      },
    };
  });
}

async function assistantRows(t: TestCtx, sessionId: Id<"sessions">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("messages").collect()).filter(
      (row) =>
        row.sessionId === sessionId &&
        row.role === "assistant" &&
        row.content.trim(),
    ),
  );
}

describe("/session-stream activity completion", () => {
  test("the tutor's answer to the scholar's correction comes first, the note last", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    scriptTurn([say(REPLY)]);

    const { status, events } = await runTurn(t, turn);

    expect(status).toBe(200);
    const [note] = completionClosingPool("5");
    const shown = events.filter((e) => "text" in e).map((e) => e.text);
    expect(shown.join("")).toBe(`${REPLY}${note}`);
    const rows = await assistantRows(t, turn.sessionId);
    expect(rows.map((row) => row.content)).toEqual([REPLY, note]);
    const session = await t.run((ctx) => ctx.db.get(turn.sessionId));
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));
    expect(events.at(-1)).toMatchObject({ done: true });
  });

  test("with nothing left to answer, the note is the turn's only text", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    scriptTurn([]);

    const { events } = await runTurn(t, turn);

    const [note] = completionClosingPool("5");
    const shown = events.filter((e) => "text" in e).map((e) => e.text);
    expect(shown).toEqual([note]);
    const rows = await assistantRows(t, turn.sessionId);
    expect(rows.map((row) => row.content)).toEqual([note]);
  });
});

describe("/session-stream activity completion when the scholar leaves mid-turn", () => {
  // The activity is recorded at tool time, so the note must reach the
  // transcript whenever the turn finalizes; a recorded completion with no
  // note is the state this guards against.
  test("a disconnect after the tool still leaves the reply and the note", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    let disconnect!: () => void;
    const disconnected = new Promise<void>((resolve) => {
      disconnect = resolve;
    });
    let finished!: () => void;
    const runnerDone = new Promise<void>((resolve) => {
      finished = resolve;
    });
    scriptTurn([say(REPLY)], { afterTool: () => disconnected, done: finished });

    const response = await t
      .withIdentity({
        subject: `${turn.userId}|${turn.authSessionId}`,
        issuer: "https://convex.dev",
      })
      .fetch("/session-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: turn.sessionId,
          streamId: turn.streamId,
          assistantMsgId: turn.assistantMsgId,
          platform: "web",
        }),
      });
    await response.body!.cancel();
    disconnect();
    await runnerDone;
    const [note] = completionClosingPool("5");
    await vi.waitFor(async () => {
      const rows = await assistantRows(t, turn.sessionId);
      expect(rows.map((row) => row.content)).toEqual([REPLY, note]);
    });
    const session = await t.run((ctx) => ctx.db.get(turn.sessionId));
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));
  });

  test("Stop after the tool keeps what was said and still shows the note", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    scriptTurn([say(REPLY)], {
      afterTool: () =>
        t.run(async (ctx) => {
          for (const row of await ctx.db.query("messages").collect()) {
            if (row.sessionId === turn.sessionId && row.role === "assistant") {
              await ctx.db.patch(row._id, { stopRequestedAt: Date.now() });
            }
          }
        }),
    });

    const { events } = await runTurn(t, turn);

    const [note] = completionClosingPool("5");
    const rows = await assistantRows(t, turn.sessionId);
    expect(rows.at(-1)?.content).toBe(note);
    expect(events.at(-1)).toMatchObject({ done: true, stopped: true });
    const session = await t.run((ctx) => ctx.db.get(turn.sessionId));
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));
  });

  test("a model error after the tool still writes the note", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    scriptTurn([], { failAfterTool: true });

    const { events } = await runTurn(t, turn);

    expect(events.at(-1)).toMatchObject({ error: "Stream error" });
    const [note] = completionClosingPool("5");
    const rows = await assistantRows(t, turn.sessionId);
    expect(rows.map((row) => row.content)).toEqual([note]);
    const session = await t.run((ctx) => ctx.db.get(turn.sessionId));
    expect(session?.activityCompletedAt).toEqual(expect.any(Number));
  });
});
