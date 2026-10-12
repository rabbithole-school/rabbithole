import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Coverage for the busy-backend resilience work (draft PR #3458 follow-up):
//   1. reapAndInsertAssistantPlaceholder reaps a stale empty assistant row ONLY
//      when it carries a streamId (the original guard). A POST-TOOL split
//      placeholder has NO streamId; leaving a stale one is harmless (the client
//      treats a no-streamId empty row as idle), and reaping it could race a
//      live split, so it is deliberately spared.
//   2. sessions.retryAssistantTurn inserts a fresh placeholder for a FAILED
//      turn (last non-tool message is a user message, or a dead/finalized-empty
//      assistant row) and REFUSES (returns null) when the turn already replied
//      OR when the trailing empty placeholder is still fresh (live), so it can
//      never duplicate or delete a live turn.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Test Scholar",
      username: "testscholar",
      role: "scholar",
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const authSessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedSession(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId,
      title: "Test Project",
      isArchived: false,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. reap is streamId-only (a stale no-streamId split row is spared) ───

describe("reapAndInsertAssistantPlaceholder: streamId-only reap", () => {
  test("does NOT reap a stale empty assistant row that has NO streamId", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    // A stale POST-TOOL split placeholder: content "", NO streamId, old heartbeat.
    const now = Date.now();
    const splitId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        lastStreamActivityAt: now,
        flagged: false,
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(now + 25_000);
    await asUser.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "hello again",
    });
    vi.useRealTimers();

    // Spared: reap is streamId-only; a hidden empty no-streamId row is harmless.
    const split = await t.run(async (ctx) => ctx.db.get(splitId));
    expect(split).not.toBeNull();
  });

  test("DOES reap a stale empty assistant row that has a streamId", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    const now = Date.now();
    const orphanId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-stream",
        lastStreamActivityAt: now,
        flagged: false,
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(now + 25_000);
    await asUser.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "hello again",
    });
    vi.useRealTimers();

    const orphan = await t.run(async (ctx) => ctx.db.get(orphanId));
    expect(orphan).toBeNull(); // reaped
  });
});

// ── 2. sessions.retryAssistantTurn ──────────────────────────────────────

describe("sessions.retryAssistantTurn", () => {
  test("happy path: inserts a fresh placeholder when the last turn is a user message", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    // A user message whose reply evaporated (hard error deleted the placeholder).
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "why is the sky blue?",
        flagged: false,
      }),
    );

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).not.toBeNull();
    expect(result?.streamId).toBeTruthy();

    const placeholder = await t.run(async (ctx) =>
      ctx.db.get(result!.assistantMsgId),
    );
    expect(placeholder?.role).toBe("assistant");
    expect(placeholder?.content).toBe("");
    expect(placeholder?.streamId).toBe(result!.streamId);

    // Exactly one user message remains — no duplicate scholar turn.
    const userMsgs = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .filter((q) => q.eq(q.field("role"), "user"))
        .collect(),
    );
    expect(userMsgs).toHaveLength(1);
  });

  test("happy path: replaces a dead empty assistant placeholder after a user turn", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "explain photosynthesis",
        flagged: false,
      }),
    );
    // A DEAD placeholder: past the liveness window (old heartbeat).
    const deadPlaceholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-1",
        lastStreamActivityAt: Date.now() - 25_000,
        flagged: false,
      }),
    );

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).not.toBeNull();

    // The old dead placeholder is gone, replaced by the fresh one.
    const dead = await t.run(async (ctx) => ctx.db.get(deadPlaceholderId));
    expect(dead).toBeNull();
    expect(result!.assistantMsgId).not.toBe(deadPlaceholderId);

    const assistants = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .collect(),
    );
    expect(assistants).toHaveLength(1);
  });

  test("refuses (null) when the trailing empty placeholder is still LIVE (fresh)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "explain photosynthesis",
        flagged: false,
      }),
    );
    // A LIVE placeholder: fresh heartbeat — another tab is streaming or
    // busy-retrying it. Retrying now must NOT delete it.
    const livePlaceholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "live-1",
        lastStreamActivityAt: Date.now(),
        flagged: false,
      }),
    );

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).toBeNull();

    // The live placeholder is untouched.
    const live = await t.run(async (ctx) => ctx.db.get(livePlaceholderId));
    expect(live).not.toBeNull();
  });

  test("refuses (null) when the last turn already replied", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "hi",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Hello! What are you curious about today?",
        flagged: false,
      });
    });

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).toBeNull();

    // Nothing was inserted — still exactly one assistant row.
    const assistants = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .collect(),
    );
    expect(assistants).toHaveLength(1);
  });

  test("refuses (null) for an empty session", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).toBeNull();
  });

  test("ignores a trailing tool row and retries the user turn beneath it", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "draw me a cat",
        flagged: false,
      });
      // A tool row (e.g. an image) can trail the turn; it never ends it.
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "a friendly cat",
        toolAction: "generate_image",
        flagged: false,
      });
    });

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).not.toBeNull();
    expect(result?.streamId).toBeTruthy();
  });

  test("refuses (null) for a dead KICKOFF placeholder (silent turn, streamTrigger set)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    // A dead activity-kickoff placeholder: empty, streamId, streamTrigger set,
    // and NO preceding scholar message. It self-recovers through
    // startActivityKickoff — retryAssistantTurn must refuse.
    const kickoffId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-kickoff",
        streamTrigger: "activityKickoff",
        lastStreamActivityAt: Date.now() - 25_000,
        flagged: false,
      }),
    );

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).toBeNull();
    // Untouched.
    const kickoff = await t.run(async (ctx) => ctx.db.get(kickoffId));
    expect(kickoff).not.toBeNull();
  });

  test("refuses (null) for a dead RUBRIC-CHECK placeholder (preceded by an assistant, not a user)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    // A rubric-check turn persists NO scholar message: the placeholder is
    // preceded by a prior assistant reply. retryAssistantTurn must refuse
    // because the message before it (skipping tools) is not a `user` message.
    const deadRubricId = await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "here is my draft",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Nice work — I gave it a look.",
        flagged: false,
      });
      return ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-rubric",
        lastStreamActivityAt: Date.now() - 25_000,
        flagged: false,
      });
    });

    const result = await asUser.mutation(api.sessions.retryAssistantTurn, {
      sessionId,
    });
    expect(result).toBeNull();
    const deadRubric = await t.run(async (ctx) => ctx.db.get(deadRubricId));
    expect(deadRubric).not.toBeNull();
  });

  test("forbids a scholar retrying someone else's session", async () => {
    const t = convexTest(schema, modules);
    const ownerId = await seedUser(t);
    const sessionId = await seedSession(t, ownerId);
    await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "mine",
        flagged: false,
      }),
    );

    const intruderId = await t.run(async (ctx) =>
      ctx.db.insert("users", {
        name: "Intruder",
        username: "intruder",
        role: "scholar",
      }),
    );
    const asIntruder = await withUser(t, intruderId);

    await expect(
      asIntruder.mutation(api.sessions.retryAssistantTurn, { sessionId }),
    ).rejects.toThrow(/Forbidden/);
  });
});
