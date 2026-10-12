import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { createStreamStopPredicate } from "../lib/aideStream";
import { renderStoppedAssistantContent } from "../../shared/stoppedTurn";
import { shouldPersistStreamContent } from "../sessionStreamHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Doc<"users">["role"],
  username: string,
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("stop requests", () => {
  test("each public mutation stamps its authorized streaming row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-stop");
    const teacherId = await seedUser(t, "teacher", "teacher-stop");
    const parentId = await seedUser(t, "parent", "parent-stop");
    const { sessionId, sessionMessageId, curriculumMessageId, metaMessageId, parentMessageId } =
      await t.run(async (ctx) => {
        const sessionId = await ctx.db.insert("sessions", {
          userId: scholarId,
          title: "Stop test",
          isArchived: false,
        });
        const sessionMessageId = await ctx.db.insert("messages", {
          sessionId,
          role: "assistant",
          content: "Partial",
          streamId: "session-stream",
          flagged: false,
        });
        const curriculumMessageId = await ctx.db.insert(
          "curriculumMessages",
          {
            teacherId,
            role: "assistant",
            content: "Partial",
            streamId: "curriculum-stream",
          },
        );
        const chatId = await ctx.db.insert("metaChats", {
          scholarId,
          purpose: "introspection",
          threadKey: "standing",
          createdAt: Date.now(),
          lastMessageAt: Date.now(),
        });
        const metaMessageId = await ctx.db.insert("metaMessages", {
          chatId,
          role: "assistant",
          content: "Partial",
          streamId: "meta-stream",
          createdAt: Date.now(),
        });
        const parentMessageId = await ctx.db.insert("parentChatMessages", {
          parentUserId: parentId,
          role: "assistant",
          content: "Partial",
          streamId: "parent-stream",
        });
        return {
          sessionId,
          sessionMessageId,
          curriculumMessageId,
          metaMessageId,
          parentMessageId,
        };
      });

    expect(
      await (await withUser(t, scholarId)).mutation(api.sessions.requestStop, {
        sessionId,
      }),
    ).toEqual({ stopped: true });
    expect(
      await (await withUser(t, teacherId)).mutation(
        api.curriculumAssistant.requestStop,
        { messageId: curriculumMessageId },
      ),
    ).toEqual({ stopped: true });
    expect(
      await (await withUser(t, scholarId)).mutation(api.metaChat.requestStop, {
        messageId: metaMessageId,
      }),
    ).toEqual({ stopped: true });
    expect(
      await (await withUser(t, parentId)).mutation(api.parentChat.requestStop, {
        messageId: parentMessageId,
      }),
    ).toEqual({ stopped: true });

    const stoppedAt = Date.now();
    const rows = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(sessionMessageId),
        ctx.db.get(curriculumMessageId),
        ctx.db.get(metaMessageId),
        ctx.db.get(parentMessageId),
      ]),
    );
    for (const row of rows) {
      expect(row?.stopRequestedAt).toBe(stoppedAt);
      expect(row?.streamId).toBeTruthy();
    }
  });
});

describe("steering sends", () => {
  test("each send stamps the previous in-flight assistant row", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-steer");
    const teacherId = await seedUser(t, "teacher", "teacher-steer");
    const parentId = await seedUser(t, "parent", "parent-steer");
    const seeded = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Steering test",
        isArchived: false,
      });
      const sessionMessageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Partial",
        streamId: "session-stream",
        flagged: false,
        lastStreamActivityAt: Date.now(),
      });
      const curriculumMessageId = await ctx.db.insert("curriculumMessages", {
        teacherId,
        role: "assistant",
        content: "Partial",
        streamId: "curriculum-stream",
      });
      const chatId = await ctx.db.insert("metaChats", {
        scholarId,
        purpose: "introspection",
        threadKey: "standing",
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      });
      const metaMessageId = await ctx.db.insert("metaMessages", {
        chatId,
        role: "assistant",
        content: "Partial",
        streamId: "meta-stream",
        createdAt: Date.now(),
      });
      const parentMessageId = await ctx.db.insert("parentChatMessages", {
        parentUserId: parentId,
        role: "assistant",
        content: "Partial",
        streamId: "parent-stream",
      });
      return {
        sessionId,
        sessionMessageId,
        curriculumMessageId,
        chatId,
        metaMessageId,
        parentMessageId,
      };
    });

    await (await withUser(t, scholarId)).mutation(api.sessions.sendMessage, {
      sessionId: seeded.sessionId,
      message: "New direction",
    });
    await (await withUser(t, teacherId)).mutation(
      api.curriculumAssistant.sendMessage,
      { message: "New direction" },
    );
    await (await withUser(t, scholarId)).mutation(api.metaChat.sendMessage, {
      chatId: seeded.chatId,
      content: "New direction",
    });
    await (await withUser(t, parentId)).mutation(api.parentChat.sendMessage, {
      content: "New direction",
    });

    const rows = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(seeded.sessionMessageId),
        ctx.db.get(seeded.curriculumMessageId),
        ctx.db.get(seeded.metaMessageId),
        ctx.db.get(seeded.parentMessageId),
      ]),
    );
    for (const row of rows) {
      expect(row?.stopRequestedAt).toEqual(expect.any(Number));
    }
  });
});

describe("stream finalization", () => {
  test("finalizers preserve the durable stop timestamp", async () => {
    const t = convexTest(schema, modules);
    const stopRequestedAt = 123_456;
    const scholarId = await seedUser(t, "scholar", "scholar-finalize");
    const teacherId = await seedUser(t, "teacher", "teacher-finalize");
    const parentId = await seedUser(t, "parent", "parent-finalize");
    const seeded = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Finalize test",
        isArchived: false,
      });
      const sessionMessageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "session-stream",
        stopRequestedAt,
        flagged: false,
      });
      const curriculumMessageId = await ctx.db.insert("curriculumMessages", {
        teacherId,
        role: "assistant",
        content: "",
        streamId: "curriculum-stream",
        stopRequestedAt,
      });
      const chatId = await ctx.db.insert("metaChats", {
        scholarId,
        purpose: "introspection",
        threadKey: "standing",
        createdAt: Date.now(),
        lastMessageAt: Date.now(),
      });
      const metaMessageId = await ctx.db.insert("metaMessages", {
        chatId,
        role: "assistant",
        content: "",
        streamId: "meta-stream",
        stopRequestedAt,
        createdAt: Date.now(),
      });
      const parentMessageId = await ctx.db.insert("parentChatMessages", {
        parentUserId: parentId,
        role: "assistant",
        content: "",
        streamId: "parent-stream",
        stopRequestedAt,
      });
      return {
        sessionId,
        sessionMessageId,
        curriculumMessageId,
        metaMessageId,
        parentMessageId,
      };
    });

    await t.mutation(internal.sessionHelpers.finalizeStream, {
      messageId: seeded.sessionMessageId,
      sessionId: seeded.sessionId,
      content: "Stopped session reply",
    });
    await t.mutation(internal.curriculumAssistant.finalizeStream, {
      messageId: seeded.curriculumMessageId,
      content: "Stopped curriculum reply",
    });
    await t.mutation(internal.metaChat.finalizeStream, {
      messageId: seeded.metaMessageId,
      content: "Stopped meta reply",
    });
    await t.mutation(internal.parentChat.finalizeStream, {
      messageId: seeded.parentMessageId,
      content: "Stopped parent reply",
    });

    const rows = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(seeded.sessionMessageId),
        ctx.db.get(seeded.curriculumMessageId),
        ctx.db.get(seeded.metaMessageId),
        ctx.db.get(seeded.parentMessageId),
      ]),
    );
    for (const row of rows) {
      expect(row?.stopRequestedAt).toBe(stopRequestedAt);
      expect(row?.streamId).toBeUndefined();
    }
  });
});

describe("stopped model history", () => {
  test("renders the shared marker only for stopped assistant content", () => {
    expect(renderStoppedAssistantContent("Partial answer", undefined)).toBe(
      "Partial answer",
    );
    expect(renderStoppedAssistantContent("Partial answer", 1)).toBe(
      "Partial answer\n\n[The user stopped this response here.]",
    );
    expect(renderStoppedAssistantContent("", 1)).toBe(
      "[The user stopped this response here.]",
    );
  });
});

describe("stream stop predicate", () => {
  test("throttles liveness reads, forces tool-boundary reads, and latches stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const isStopRequested = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const predicate = createStreamStopPredicate({
      isLocallyStopped: () => false,
      isStopRequested,
    });

    await expect(predicate()).resolves.toBe(false);
    vi.setSystemTime(11_499);
    await expect(predicate()).resolves.toBe(false);
    expect(isStopRequested).toHaveBeenCalledTimes(1);

    await expect(predicate(true)).resolves.toBe(true);
    vi.setSystemTime(20_000);
    await expect(predicate()).resolves.toBe(true);
    expect(isStopRequested).toHaveBeenCalledTimes(2);
  });
});

describe("stop and steer boundaries", () => {
  test("a steering send stamps only its own thread's streaming row", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-isolation");
    const seeded = await t.run(async (ctx) => {
      const mkSession = async (title: string) => {
        const sessionId = await ctx.db.insert("sessions", {
          userId: scholarId,
          title,
          isArchived: false,
        });
        const messageId = await ctx.db.insert("messages", {
          sessionId,
          role: "assistant",
          content: "Partial",
          streamId: `${title}-stream`,
          flagged: false,
          lastStreamActivityAt: Date.now(),
        });
        return { sessionId, messageId };
      };
      return { a: await mkSession("thread-a"), b: await mkSession("thread-b") };
    });

    await (await withUser(t, scholarId)).mutation(api.sessions.sendMessage, {
      sessionId: seeded.a.sessionId,
      message: "Steer thread A only",
    });

    const [rowA, rowB] = await t.run(async (ctx) =>
      Promise.all([ctx.db.get(seeded.a.messageId), ctx.db.get(seeded.b.messageId)]),
    );
    expect(rowA?.stopRequestedAt).toEqual(expect.any(Number));
    expect(rowB?.stopRequestedAt).toBeUndefined();
    expect(rowB?.streamId).toBe("thread-b-stream");
  });

  test("a stop before the first token deletes the empty row instead of keeping a bare marker", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-empty-stop");
    const seeded = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Empty stop",
        isArchived: false,
      });
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "empty-stream",
        stopRequestedAt: Date.now(),
        flagged: false,
      });
      return { sessionId, messageId };
    });

    await t.mutation(internal.sessionHelpers.finalizeStream, {
      messageId: seeded.messageId,
      sessionId: seeded.sessionId,
      content: "",
    });

    expect(await t.run((ctx) => ctx.db.get(seeded.messageId))).toBeNull();
  });
});

describe("a stopped placeholder that never spoke leaves no empty reply", () => {
  // TRA-501: a stream that died before its first word (a killed action, a
  // dropped connection) never finalizes. A steer stamped its empty row
  // `stopRequestedAt` inside the orphan reap's 20-second window, and the row
  // then stayed forever as an empty tutor reply. The fix checks back once the
  // liveness window has passed, and deletes only a row whose stream is dead.
  const seedEmptyStream = async (
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
  ) =>
    t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Dead stream",
        isArchived: false,
      });
      const messageId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-stream",
        flagged: false,
        lastStreamActivityAt: Date.now(),
      });
      return { sessionId, messageId };
    });

  const scheduledReaps = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (job) =>
          job.name.includes("reapDeadStoppedPlaceholder") &&
          job.state.kind === "pending",
      ),
    );

  test("a steer on a DEAD empty stream: stamped now, deleted once its heartbeat is stale", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-dead-steer");
    const seeded = await seedEmptyStream(t, scholarId);

    await (await withUser(t, scholarId)).mutation(api.sessions.sendMessage, {
      sessionId: seeded.sessionId,
      message: "hello?",
    });

    // Stamped, not deleted: a live stream may hold text it hasn't stored.
    const stamped = await t.run((ctx) => ctx.db.get(seeded.messageId));
    expect(stamped?.stopRequestedAt).toEqual(expect.any(Number));
    expect(await scheduledReaps(t)).toHaveLength(1);

    // No heartbeat ever comes: the stream is dead, so the check deletes it.
    vi.advanceTimersByTime(30_000);
    await t.mutation(internal.sessions.reapDeadStoppedPlaceholder, {
      messageId: seeded.messageId,
    });
    expect(await t.run((ctx) => ctx.db.get(seeded.messageId))).toBeNull();
  });

  // Found live on a dev deployment: a completion turn's app-written closing is
  // shown before it is stored, so its row is "" at the moment of a Stop. When
  // Stop deleted empty rows outright, the closing vanished.
  test("a LIVE stream's stopped empty row survives the check and keeps the text it finalizes", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-live-stop");
    const seeded = await seedEmptyStream(t, scholarId);

    await (await withUser(t, scholarId)).mutation(api.sessions.requestStop, {
      sessionId: seeded.sessionId,
    });
    expect(await t.run((ctx) => ctx.db.get(seeded.messageId))).not.toBeNull();

    // The stream is alive (its heartbeat is fresh) when the check runs.
    vi.advanceTimersByTime(25_000);
    await t.mutation(internal.sessionHelpers.touchStreamActivity, {
      messageId: seeded.messageId,
    });
    await t.mutation(internal.sessions.reapDeadStoppedPlaceholder, {
      messageId: seeded.messageId,
    });
    expect(await t.run((ctx) => ctx.db.get(seeded.messageId))).not.toBeNull();

    // It finalizes the closing it had already shown.
    const shownButNotStored = "You finished that one.";
    await t.mutation(internal.sessionHelpers.finalizeStream, {
      messageId: seeded.messageId,
      sessionId: seeded.sessionId,
      content: shownButNotStored,
    });
    const row = await t.run((ctx) => ctx.db.get(seeded.messageId));
    expect(row?.content).toBe(shownButNotStored);
    expect(row?.streamId).toBeUndefined();

    // A later check finds a finalized row and leaves it alone.
    vi.advanceTimersByTime(60_000);
    await t.mutation(internal.sessions.reapDeadStoppedPlaceholder, {
      messageId: seeded.messageId,
    });
    expect((await t.run((ctx) => ctx.db.get(seeded.messageId)))?.content).toBe(
      shownButNotStored,
    );
  });

  test("Stop stamps a partial reply and schedules no reap for it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-partial-stop");
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Partial",
        isArchived: false,
      }),
    );
    const partialId = await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Half a thought",
        streamId: "live-stream",
        flagged: false,
        lastStreamActivityAt: Date.now(),
      }),
    );
    await (await withUser(t, scholarId)).mutation(api.sessions.requestStop, {
      sessionId,
    });
    const partial = await t.run((ctx) => ctx.db.get(partialId));
    expect(partial?.stopRequestedAt).toEqual(expect.any(Number));
    expect(partial?.content).toBe("Half a thought");
    expect(await scheduledReaps(t)).toHaveLength(0);
  });

  // Replays the stream's own write sequence (http.ts /session-stream) around
  // a Stop: the real send creates the placeholder, the stream writes text
  // exactly when `shouldPersistStreamContent` says so, the scholar presses
  // Stop, and the stream finalizes what it had. A young reader's reply is far
  // under the 200-character interval, so before the first-text write existed
  // the row was still "" here and Stop deleted words already on screen.
  test("Stop after a short reply has shown text keeps that text", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-short-stop");
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Short reply",
        isArchived: false,
      }),
    );
    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "the fawn",
    });
    const placeholderId = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect();
      return rows.find((m) => m.role === "assistant" && m.streamId)!._id;
    });

    // The stream releases its first sentence to the screen.
    const shown = "A spotted fawn by the river!";
    let lastPersistLength = 0;
    expect(shouldPersistStreamContent(shown.length, lastPersistLength)).toBe(true);
    await t.mutation(internal.sessionHelpers.updateStreamContent, {
      messageId: placeholderId,
      content: shown,
    });
    lastPersistLength = shown.length;

    // The scholar presses Stop while the reply is on screen.
    await asScholar.mutation(api.sessions.requestStop, { sessionId });
    expect(
      await t.query(internal.sessionHelpers.isStopRequested, {
        messageId: placeholderId,
      }),
    ).toBe(true);

    // The stream sees the stop and finalizes what it showed.
    await t.mutation(internal.sessionHelpers.finalizeStream, {
      messageId: placeholderId,
      sessionId,
      content: shown,
    });
    const row = await t.run((ctx) => ctx.db.get(placeholderId));
    expect(row?.content).toBe(shown);
    expect(row?.stopRequestedAt).toEqual(expect.any(Number));
  });
});

describe("shouldPersistStreamContent", () => {
  test("writes a placeholder's first visible text at once, for every turn", () => {
    expect(shouldPersistStreamContent(0, 0)).toBe(false);
    expect(shouldPersistStreamContent(1, 0)).toBe(true);
    // Once something is stored, short additions wait for the next interval.
    expect(shouldPersistStreamContent(60, 30)).toBe(false);
  });
});
