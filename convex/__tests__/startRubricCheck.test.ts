import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { computePromptVersion } from "../lib/promptVersion";

// Coverage for sessions.startRubricCheck — the honest "Check my work" trigger.
// The bug it fixes: clicking "Check my work" used to send a real user message
// (`ok check "<title>"`), so the transcript showed a message the scholar never
// typed. startRubricCheck instead persists ONLY an assistant placeholder; the
// re-check instruction is injected ephemerally in /project-stream and never
// stored. So the core invariant proven here: NO user message is created.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedScholar(
  t: ReturnType<typeof convexTest>,
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: username,
      username,
      role: "scholar",
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const authSession: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", authSession);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  overrides: Partial<Doc<"sessions">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "Test Project",
      isArchived: false,
      ...overrides,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sessions.startRubricCheck", () => {
  test("creates an assistant placeholder and persists NO user message", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedScholar(t, "ownerscholar");
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    const res = await asUser.mutation(api.sessions.startRubricCheck, {
      sessionId,
    });
    expect(res.streamId).toBeTruthy();
    expect(res.assistantMsgId).toBeTruthy();
    expect(res.sessionId).toBe(sessionId);

    const messages = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    // The honesty invariant: a rubric check must NEVER fabricate a user turn.
    expect(messages.some((m) => m.role === "user")).toBe(false);
    // Exactly one assistant placeholder (empty content, streamId set) was made.
    const placeholders = messages.filter(
      (m) => m.role === "assistant" && m.content === "" && !!m.streamId,
    );
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]._id).toBe(res.assistantMsgId);
    expect(placeholders[0].promptVersion).toBe(await computePromptVersion());
  });

  test("reaps a stale orphaned placeholder before inserting the fresh one", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedScholar(t, "reapscholar");
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    const orphanId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-stream",
        flagged: false,
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25_000);
    const res = await asUser.mutation(api.sessions.startRubricCheck, {
      sessionId,
    });
    vi.useRealTimers();

    const orphan = await t.run(async (ctx) => ctx.db.get(orphanId));
    expect(orphan).toBeNull(); // reaped

    const live = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .filter((q) =>
          q.and(q.eq(q.field("role"), "assistant"), q.eq(q.field("content"), "")),
        )
        .collect(),
    );
    expect(live).toHaveLength(1);
    expect(live[0]._id).toBe(res.assistantMsgId);
    expect(live[0]._id).not.toBe(orphanId);
  });

  test("a different scholar cannot start a rubric check on someone else's session", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedScholar(t, "theowner");
    const intruderId = await seedScholar(t, "theintruder");
    const asIntruder = await withUser(t, intruderId);
    const sessionId = await seedSession(t, ownerId);

    await expect(
      asIntruder.mutation(api.sessions.startRubricCheck, { sessionId }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("is blocked once the session time limit has expired (parity with sendMessage)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedScholar(t, "timedscholar");
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId, {
      sessionTimeLimit: 1, // minute
      sessionStartTime: Date.now() - 5 * 60 * 1000, // started 5 min ago
    });

    await expect(
      asUser.mutation(api.sessions.startRubricCheck, { sessionId }),
    ).rejects.toThrow(/time limit/i);
  });
});
