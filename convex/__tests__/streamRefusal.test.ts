// TRA-472: when /session-stream turns a turn away before the tutor starts, the
// placeholder records why, so an untouched empty placeholder without a record
// can only mean the request never arrived.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { LLM_BUSY_MESSAGE } from "../lib/llmLimiter";
import {
  shouldRecordStreamRefusal,
  streamRefusalReason,
  streamTurnRefFromBody,
} from "../lib/streamRefusal";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestCtx = ReturnType<typeof convexTest>;

describe("streamRefusal helpers", () => {
  test("a request names a turn only with all three ids", () => {
    expect(
      streamTurnRefFromBody({ sessionId: "s", assistantMsgId: "m", streamId: "x", platform: "web" }),
    ).toEqual({ sessionId: "s", assistantMsgId: "m", streamId: "x" });
    expect(streamTurnRefFromBody({ sessionId: "s", assistantMsgId: "m" })).toBeNull();
    expect(streamTurnRefFromBody(null)).toBeNull();
  });

  test("a busy 429 is a wait, not a refusal; any other error status is", () => {
    expect(shouldRecordStreamRefusal(429, LLM_BUSY_MESSAGE)).toBe(false);
    expect(shouldRecordStreamRefusal(429, "Daily budget reached")).toBe(true);
    expect(shouldRecordStreamRefusal(401, "Not authenticated")).toBe(true);
    expect(shouldRecordStreamRefusal(500, "Server error")).toBe(true);
    expect(shouldRecordStreamRefusal(200, "")).toBe(false);
  });

  test("reads the error out of a one-line SSE body", () => {
    expect(streamRefusalReason('data: {"error":"Forbidden"}\n\n')).toBe("Forbidden");
    expect(streamRefusalReason("plain text")).toBe("plain text");
    expect(streamRefusalReason("")).toBe("(no body)");
  });
});

async function seedOpener(t: TestCtx) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: `hoku-${crypto.randomUUID()}`,
      role: "scholar",
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId,
      title: "Why do volcanoes make islands?",
      isArchived: false,
    });
    await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: "<start>",
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
    return { userId, sessionId, streamId, assistantMsgId };
  });
}

async function placeholder(t: TestCtx, id: Id<"messages">) {
  return await t.run((ctx) => ctx.db.get(id));
}

describe("/session-stream refusals are recorded on the placeholder", () => {
  test("a request refused before the tutor starts stamps the status and reason", async () => {
    const t = convexTest(schema, modules);
    const turn = await seedOpener(t);

    // No identity: the handler answers 401 before any other work.
    const response = await t.fetch("/session-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: turn.sessionId,
        streamId: turn.streamId,
        assistantMsgId: turn.assistantMsgId,
        platform: "web",
      }),
    });
    expect(response.status).toBe(401);
    // The response the client reads is unchanged by the recording.
    expect(await response.text()).toContain("Not authenticated");

    const row = await placeholder(t, turn.assistantMsgId);
    expect(row?.streamRefusal).toMatchObject({
      status: 401,
      reason: "Not authenticated",
    });
    // Nothing else about the turn changes: a retry or the reap sees it as before.
    expect(row?.content).toBe("");
    expect(row?.streamId).toBe(turn.streamId);
  });

  test("a request without the turn's streamId cannot mark it", async () => {
    const t = convexTest(schema, modules);
    const turn = await seedOpener(t);

    const response = await t.fetch("/session-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: turn.sessionId,
        streamId: crypto.randomUUID(),
        assistantMsgId: turn.assistantMsgId,
        platform: "web",
      }),
    });
    expect(response.status).toBe(401);
    expect((await placeholder(t, turn.assistantMsgId))?.streamRefusal).toBeUndefined();
  });

  test("a placeholder that already has text is left alone", async () => {
    const t = convexTest(schema, modules);
    const turn = await seedOpener(t);
    await t.run((ctx) => ctx.db.patch(turn.assistantMsgId, { content: "Aloha!" }));

    const recorded = await t.run((ctx) =>
      ctx.runMutation(internal.sessionHelpers.recordStreamRefusal, {
        sessionId: String(turn.sessionId),
        assistantMsgId: String(turn.assistantMsgId),
        streamId: turn.streamId,
        status: 500,
        reason: "Server error",
      }),
    );
    expect(recorded).toBe(false);
    expect((await placeholder(t, turn.assistantMsgId))?.streamRefusal).toBeUndefined();
  });
});
