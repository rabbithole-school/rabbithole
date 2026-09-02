import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

// Regression coverage for orphaned stream placeholders. An interrupted tutor
// stream (client disconnect / action timeout) can leave an assistant message
// row with content "" and its streamId still set — finalize never ran. Three
// defenses, tested here:
//   1. getSessionContext filters empty/orphaned rows out of the model history
//      (so a dead row can't 400 the next turn) while keeping isFirstTurn right.
//   2. sendMessage reaps stale orphaned placeholders so they don't pollute the
//      stored transcript the observer/teacher read.
//   3. finalizeAndSplit (via splitStream) deletes — never persists — an empty
//      placeholder when a tool fires before any text was streamed.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("users", {
      name: overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`),
      username:
        overrides.username ??
        (role === "scholar" ? "testscholar" : `test${role}`),
      role,
      readingLevel: overrides.readingLevel,
      image: overrides.image,
    });
  });
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
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

// ── 1. getSessionContext history filtering + isFirstTurn ──────────────

describe("getSessionContext: orphaned/empty placeholder filtering", () => {
  test("orphaned empty assistant row is dropped from history; isFirstTurn stays true", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "<start>",
        flagged: false,
      });
      // Orphan: stream started, never finalized (streamId set, content "").
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-stream-1",
        flagged: false,
      });
      // The scholar gave up and re-typed.
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "are you there?",
        flagged: false,
      });
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.chatHistory.map((m) => m.content)).toEqual([
      "<start>",
      "are you there?",
    ]);
    // The tutor never actually spoke (the only assistant row was an empty
    // orphan) — so this is still the first turn.
    expect(c?.isFirstTurn).toBe(true);
  });

  test("the current turn's trailing empty placeholder does not flip isFirstTurn", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    // Mirrors prod: sendMessage has just inserted the blank assistant
    // placeholder for the turn we're about to stream.
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "<start>",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "in-flight",
        flagged: false,
      });
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.chatHistory).toMatchObject([
      { role: "user", content: "<start>", imageId: null, generatedImage: false },
    ]);
    expect(c?.chatHistory[0]).toMatchObject({
      id: expect.any(String),
      sourceRole: "user",
    });
    expect(c?.isFirstTurn).toBe(true);
  });

  test("a real (non-empty) assistant turn is kept and flips isFirstTurn to false", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "<start>",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "What do you already know about tides?",
        flagged: false,
      });
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.chatHistory).toHaveLength(2);
    expect(c?.isFirstTurn).toBe(false);
  });

  test("an image-only user message (no text) is preserved", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    await t.run(async (ctx) => {
      const imageId = await ctx.storage.store(new Blob(["fake-image-bytes"]));
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "",
        imageId,
        flagged: false,
      });
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    // Image-only message survives the empty-content filter.
    expect(c?.chatHistory).toHaveLength(1);
    expect(c?.chatHistory[0].imageId).toBeTruthy();
  });

  test("an empty ASSISTANT row with an imageId is still dropped (filter matches http.ts attach)", async () => {
    // The history filter keeps empty rows only when imageId is set AND the row
    // is a user message — because http.ts only inlines an image for user rows.
    // A non-user empty+imageId row would otherwise reach the model as an empty
    // content block (Anthropic 400s on it). Currently unreachable (imageId is
    // only set on user/tool rows; tool rows are dropped earlier), but the guard
    // closes the latent footgun. This proves it.
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "look at this",
        flagged: false,
      });
      const imageId = await ctx.storage.store(new Blob(["fake-image-bytes"]));
      // Pathological: an assistant row that's empty but carries an imageId.
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        imageId,
        flagged: false,
      });
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    // Only the user message survives; the empty assistant+image row is dropped.
    expect(c?.chatHistory).toMatchObject([
      { role: "user", content: "look at this", imageId: null, generatedImage: false },
    ]);
  });
});

// ── 1b. getSessionContext: generated-image visibility ──────────────────
//
// Regression coverage for the "tutor regenerates a near-duplicate image"
// bug. A generated image lives on a `role:"tool"` row (finalizeAndSplit).
// getSessionContext used to drop ALL tool rows, so the model never saw the
// images it produced and would regenerate one a turn later. The image-bearing
// tool rows must now survive — replayed as a labeled USER turn — while other
// tool rows (whispers, plain actions) stay dropped.

describe("getSessionContext: generated-image visibility", () => {
  test("a generated-image tool row is kept and replayed as a labeled user turn", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    const imageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["fake-image-bytes"]));
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "<start>",
        flagged: false,
      });
      // The tutor generated an image on the opening turn (stored on a tool row,
      // alt text persisted as its content), then spoke.
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "A labeled aquaponics diagram: fish tank, grow beds, tubes.",
        toolAction: "Generated image",
        imageId: id,
        imagePrompt:
          "A labeled cross-section of an aquaponics system with fish tank, grow beds, and connecting tubes.",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Take a good look at this picture. What do you notice?",
        flagged: false,
      });
      return id;
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.chatHistory).toMatchObject([
      { role: "user", content: "<start>", imageId: null, generatedImage: false },
      {
        role: "user",
        content: "A labeled aquaponics diagram: fish tank, grow beds, tubes.",
        imageId,
        generatedImage: true,
        imagePrompt:
          "A labeled cross-section of an aquaponics system with fish tank, grow beds, and connecting tubes.",
      },
      {
        role: "assistant",
        content: "Take a good look at this picture. What do you notice?",
        imageId: null,
        generatedImage: false,
      },
    ]);
    // The tutor DID speak — generated-image rows (mapped to "user") must not
    // mask a real assistant turn.
    expect(c?.isFirstTurn).toBe(false);
  });

  test("a whisper tool row is still dropped from model history", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: "hi",
        flagged: false,
      });
      // A teacher whisper is a tool row WITHOUT an image — injected separately
      // via pendingWhisper, never replayed as conversation history.
      await ctx.db.insert("messages", {
        sessionId,
        role: "tool",
        content: "nudge toward estimation",
        toolAction: "whisper",
        flagged: false,
      });
    });

    const c = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(c?.chatHistory).toMatchObject([
      { role: "user", content: "hi", imageId: null, generatedImage: false },
    ]);
  });
});

// ── 2. sendMessage reap ────────────────────────────────────────────────

describe("sendMessage: orphan reap", () => {
  test("reaps a stale orphaned placeholder when the scholar sends again", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    // A stale orphan from a stream that died ~earlier.
    const orphanId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-stream-2",
        flagged: false,
      }),
    );

    // Jump the clock past the reap age guard, then send the next message.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25_000);
    await asUser.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "hello again",
    });
    vi.useRealTimers();

    const orphan = await t.run(async (ctx) => ctx.db.get(orphanId));
    expect(orphan).toBeNull(); // reaped

    // And the new turn's own (fresh) placeholder survives.
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
    expect(live[0]._id).not.toBe(orphanId);
  });

  test("does NOT reap a placeholder younger than the age guard (live-stream safety)", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    // A placeholder that was created just now — could be a stream that
    // legitimately just started; must not be reaped.
    const freshId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "maybe-live",
        flagged: false,
      }),
    );

    await asUser.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "typed fast",
    });

    const fresh = await t.run(async (ctx) => ctx.db.get(freshId));
    expect(fresh).not.toBeNull(); // spared
  });

  test("does NOT reap a slow-but-live stream: old _creationTime, fresh heartbeat", async () => {
    // The bug this guards: http.ts persists streamed content on a ~200-char
    // LENGTH threshold (not a timer), so a healthy stream — a long tool call
    // before any text, a thinking-pause, or a sub-200-char reply — can sit
    // empty + streamId-set for well over the 20s reap window. Keying the reap
    // off _creationTime would wrongly delete it; its later patch on the deleted
    // row would throw and the stream would die blank. The heartbeat
    // (lastStreamActivityAt, stamped by http.ts at message_start + each persist
    // tick) is the real liveness signal, so an "old by creation" row with a
    // RECENT heartbeat must be spared.
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    const liveId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "slow-but-live",
        flagged: false,
      }),
    );

    // Jump the clock 30s past creation (well past the 20s guard), but stamp a
    // FRESH heartbeat right before the send — i.e. http.ts just proved the
    // stream is alive (message_start / persist tick) at the "current" time.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.touchStreamActivity, {
        messageId: liveId,
      }),
    );
    await asUser.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "still here?",
    });
    vi.useRealTimers();

    const live = await t.run(async (ctx) => ctx.db.get(liveId));
    expect(live).not.toBeNull(); // spared — heartbeat is fresh even though _creationTime is old
  });

  test("DOES reap when the heartbeat itself is stale (dead slow stream)", async () => {
    // Counterpart to the above: an old _creationTime AND a stale heartbeat is a
    // genuinely dead stream and must be reaped.
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const asUser = await withUser(t, userId);
    const sessionId = await seedSession(t, userId);

    // Seed with a heartbeat 25s in the PAST relative to send time below.
    const now = Date.now();
    const deadId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "dead-slow",
        lastStreamActivityAt: now,
        flagged: false,
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(now + 25_000);
    await asUser.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "anyone home?",
    });
    vi.useRealTimers();

    const dead = await t.run(async (ctx) => ctx.db.get(deadId));
    expect(dead).toBeNull(); // reaped — heartbeat is older than the guard
  });
});

// ── 3. finalizeAndSplit (splitStream) empty guard ──────────────────────

describe("splitStream: empty placeholder guard", () => {
  test("deletes the prior placeholder when a tool fires before any text", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);

    const placeholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "splitting",
        promptVersion: "prompt-v1",
        flagged: false,
      }),
    );

    const newId = await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: placeholderId,
        sessionId,
        contentSoFar: "",
        toolAction: "generate_image",
      }),
    );

    const prior = await t.run(async (ctx) => ctx.db.get(placeholderId));
    expect(prior).toBeNull(); // deleted, not persisted as a blank turn

    // A tool message + a fresh placeholder were created.
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
    expect(rows.some((r) => r.role === "tool" && r.toolAction === "generate_image")).toBe(true);
    expect(
      rows.some(
        (r) =>
          r._id === newId &&
          r.role === "assistant" &&
          r.promptVersion === "prompt-v1",
      ),
    ).toBe(true);
  });

  test("preserves the prior placeholder's text when a tool fires after text", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);

    const placeholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Here's a diagram of the cell:",
        streamId: "splitting2",
        flagged: false,
      }),
    );

    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: placeholderId,
        sessionId,
        contentSoFar: "Here's a diagram of the cell:",
        toolAction: "generate_image",
      }),
    );

    const prior = await t.run(async (ctx) => ctx.db.get(placeholderId));
    expect(prior?.content).toBe("Here's a diagram of the cell:");
    expect(prior?.streamId).toBeUndefined(); // finalized
  });

  test("persists the original generated-image prompt separately from alt text", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    const placeholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "image-generation",
        flagged: false,
      }),
    );
    const imageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["fake-image-bytes"])),
    );

    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: placeholderId,
        sessionId,
        contentSoFar: "",
        toolAction: "Generated image",
        imageId,
        imageAltText: "A labeled animal cell diagram.",
        imagePrompt:
          "A colorful labeled animal cell, showing nucleus, mitochondria, and cell membrane.",
      }),
    );

    const generatedImage = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .filter((q) => q.eq(q.field("role"), "tool"))
        .first(),
    );
    expect(generatedImage).toMatchObject({
      content: "A labeled animal cell diagram.",
      imageId,
      imagePrompt:
        "A colorful labeled animal cell, showing nucleus, mitochondria, and cell membrane.",
    });
  });

  test("persists the complete earned-flair snapshot on the tool row", async () => {
    const t = convexTest(schema, modules);
    const userId = await seedUser(t);
    const sessionId = await seedSession(t, userId);
    const placeholderId = await t.run(async (ctx) =>
      ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        streamId: "flair-award",
        flagged: false,
      }),
    );
    const flairAwards = [
      {
        criterionId: "specificity",
        label: "Specificity",
      },
    ];

    await t.run(async (ctx) =>
      ctx.runMutation(internal.sessionHelpers.splitStream, {
        currentMessageId: placeholderId,
        sessionId,
        contentSoFar: "",
        toolAction: "Earned flair",
        flairAwards,
      }),
    );

    const flairMessage = await t.run(async (ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
        .filter((q) => q.eq(q.field("role"), "tool"))
        .first(),
    );
    expect(flairMessage).toMatchObject({
      content: "",
      toolAction: "Earned flair",
      flairAwards,
    });
  });
});
