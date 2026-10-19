// TRA-536: a deployment with no Anthropic key says so in the tutor's chat, and
// only the public local runner offers a place to add one.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { TUTOR_KEY_PATH, TUTOR_NEEDS_KEY_MESSAGE } from "../../shared/tutorKey";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;

afterEach(() => {
  vi.unstubAllEnvs();
});

function asLocalRunner() {
  vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
  vi.stubEnv("RABBITHOLE_ALLOW_DEV_LOGIN", "true");
  vi.stubEnv("RABBITHOLE_ALLOW_DEV_FIXTURES", "true");
}

describe("localRunnerKeySetup", () => {
  test("is unavailable on a hosted deployment, even with the dev flags on", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "https://example-123.convex.cloud");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_LOGIN", "true");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_FIXTURES", "true");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await expect(t.query(api.tutorKey.localRunnerKeySetup, {})).resolves.toEqual({
      available: false,
    });
  });

  test("is unavailable on a loopback backend the runner didn't mark", async () => {
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_LOGIN", "true");
    vi.stubEnv("RABBITHOLE_ALLOW_DEV_FIXTURES", "");
    const t = convexTest(schema, modules);
    await expect(t.query(api.tutorKey.localRunnerKeySetup, {})).resolves.toEqual({
      available: false,
    });
  });

  test("is available on the local runner only while no key is set", async () => {
    asLocalRunner();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const t = convexTest(schema, modules);
    await expect(t.query(api.tutorKey.localRunnerKeySetup, {})).resolves.toEqual({
      available: true,
    });
    // Once a key is set the page can't replace it: it 404s like a hosted one.
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
    await expect(t.query(api.tutorKey.localRunnerKeySetup, {})).resolves.toEqual({
      available: false,
    });
  });
});

async function seedTurn(t: TestCtx) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Key scholar",
      username: `key-${crypto.randomUUID()}`,
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "No key yet",
      isArchived: false,
    });
    await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "What makes a character want something?",
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

async function streamTurn(t: TestCtx, turn: Awaited<ReturnType<typeof seedTurn>>) {
  const scholar = t.withIdentity({
    subject: `${turn.userId}|${turn.authSessionId}`,
    issuer: "https://convex.dev",
  });
  const response = await scholar.fetch("/session-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: turn.sessionId,
      streamId: turn.streamId,
      assistantMsgId: turn.assistantMsgId,
      platform: "web",
    }),
  });
  const text = await response.text();
  const event = JSON.parse(text.trim().replace(/^data: /, "")) as {
    error?: string;
    addKeyPath?: string;
  };
  return { status: response.status, event };
}

async function placeholder(t: TestCtx, id: Id<"messages">) {
  return await t.run((ctx) => ctx.db.get(id));
}

describe("/session-stream without an Anthropic key", () => {
  test("says the tutor needs a key, with no place to add one off the local runner", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("CONVEX_CLOUD_URL", "https://example-123.convex.cloud");
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);

    const { status, event } = await streamTurn(t, turn);

    expect(status).toBe(503);
    expect(event.error).toBe(TUTOR_NEEDS_KEY_MESSAGE);
    expect(event.addKeyPath).toBeUndefined();
    // Nothing will fill the placeholder, so it is gone, not left "thinking".
    await expect(placeholder(t, turn.assistantMsgId)).resolves.toBeNull();
  });

  test("names the page for adding the key on the local runner", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    asLocalRunner();
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);

    const { status, event } = await streamTurn(t, turn);

    expect(status).toBe(503);
    expect(event.error).toBe(TUTOR_NEEDS_KEY_MESSAGE);
    expect(event.addKeyPath).toBe(TUTOR_KEY_PATH);
  });

  test("never deletes a placeholder that already carries content", async () => {
    const t = convexTest(schema, modules);
    const turn = await seedTurn(t);
    await t.run((ctx) =>
      ctx.db.patch(turn.assistantMsgId, { content: "A partial reply" }),
    );

    await t.mutation(internal.sessionHelpers.discardEmptyTurnPlaceholder, {
      messageId: turn.assistantMsgId,
      sessionId: turn.sessionId,
    });

    await expect(placeholder(t, turn.assistantMsgId)).resolves.toMatchObject({
      content: "A partial reply",
    });
  });
});
