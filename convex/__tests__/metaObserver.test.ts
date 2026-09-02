// Meta-observer write-path tests (convex/metaChat.ts → applyMetaAnalysis). The
// model is "stubbed" by calling the write mutation directly with a synthetic
// structured result — the Anthropic call lives in the "use node" action
// (metaObserver.ts) and can't run in convexTest, so we test the deterministic
// write path (safety alert + consented-idea capture) that the action feeds.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { normalizeMetaSourceMessageId } from "../metaObserver";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: { name?: string; username?: string } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role: role as Doc<"users">["role"],
    }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedChat(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  purpose: "reflection" | "introspection" = "reflection",
): Promise<Id<"metaChats">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("metaChats", {
      scholarId,
      purpose,
      threadKey: purpose === "reflection" ? "2026-07-03" : "standing",
      ...(purpose === "reflection" ? { dayKey: "2026-07-03" } : {}),
      createdAt: now,
      lastMessageAt: now,
    }),
  );
}

type AnalysisArgs = {
  chatId: Id<"metaChats">;
  safetyAlert?: {
    severity: "critical" | "warning";
    category?: string;
    summary: string;
    excerpt?: string;
  };
  suggestions: Array<{
    title: string;
    scholarWords: string;
    distilled: string;
    consented: boolean;
  }>;
  portraitEvidence?: Array<{
    conceptLabel: string;
    masteryLevel: number;
    note: string;
    quote: string;
  }>;
};

async function applyAnalysis(
  t: ReturnType<typeof convexTest>,
  args: AnalysisArgs,
) {
  const sourceMessageId = `${args.chatId}:student`;
  const claim = await t.run(async (ctx) => {
    const chat = await ctx.db.get(args.chatId);
    if (!chat) throw new Error("Missing test chat");
    const throughAt = (chat.observerCursorAt ?? 0) + 1;
    const leaseId = `lease:${throughAt}`;
    await ctx.db.patch(chat._id, {
      observerLeaseId: leaseId,
      observerLeaseExpiresAt: Date.now() + 60_000,
    });
    return {
      leaseId,
      rangeKey: `${chat.observerCursorAt ?? "start"}:${throughAt}`,
      expectedCursorAt: chat.observerCursorAt,
      throughAt,
    };
  });
  return await t.mutation(internal.metaChat.applyMetaAnalysis, {
    ...args,
    ...claim,
    newUserMessageIds: [sourceMessageId],
    safetyAlert: args.safetyAlert
      ? { ...args.safetyAlert, sourceMessageId }
      : undefined,
  });
}

const consented = (title: string) => ({
  title,
  scholarWords: `I wish ${title} was a thing`,
  distilled: `Add ${title}.`,
  consented: true,
});

describe("applyMetaAnalysis — safety alert", () => {
  test("accepts the bracketed source id shown in the observer transcript", () => {
    expect(normalizeMetaSourceMessageId("[message-1]")).toBe("message-1");
    expect(normalizeMetaSourceMessageId(" message-1 ")).toBe("message-1");
  });

  test("raises a welfare alert with source meta_chat + the meta dedupKey", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { name: "Kai Nakamura", username: "kai1" });
    const chatId = await seedChat(t, kai);

    await applyAnalysis(t, {
      chatId,
      safetyAlert: {
        severity: "warning",
        category: "abuse",
        summary: "Scholar described being hurt at home.",
        excerpt: "my dad hit me",
      },
      suggestions: [],
    });

    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].kind).toBe("welfare");
    expect(alerts[0].source).toBe("meta_chat");
    expect(alerts[0].severity).toBe("warning");
    expect(alerts[0].dedupKey).toBe(`welfare-meta:${kai}:${chatId}:student`);
    expect(alerts[0].scholarId).toBe(kai);
    expect(alerts[0].body).toContain("hurt at home");
  });

  test("deduped on a second run for the same chat (12h window)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai2" });
    const chatId = await seedChat(t, kai);
    const args = {
      chatId,
      safetyAlert: {
        severity: "critical" as const,
        summary: "Stated intent to self-harm.",
        excerpt: "I want to disappear",
      },
      suggestions: [],
    };
    await applyAnalysis(t, args);
    await applyAnalysis(t, args);
    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
  });
});

describe("applyMetaAnalysis — consented idea capture", () => {
  test("consented idea → one scholarSuggestions row without a class EOD digest row", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "lehua3" });
    const kai = await seedUser(t, "scholar", { name: "Kai Nakamura", username: "kai3" });
    const chatId = await seedChat(t, kai);
    // One linked group + one UNlinked group both containing Kai.
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Geckos",
        scholarIds: [kai],
        slackChannelId: "C-GECKOS",
      });
      await ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Unlinked",
        scholarIds: [kai],
      });
    });

    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [consented("Star Map time travel")],
    });
    expect(res.captured).toBe(1);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Star Map time travel");
    // The retired field must not come back: a writer that still stamps it
    // would silently undo migrations:dropSuggestionStatus and block the narrow.
    expect(rows[0].status).toBeUndefined();
    expect(rows[0].archivedAt).toBeUndefined();
    expect(rows[0].sourceChatId).toBe(chatId);
    expect(rows[0].distilled).toBe("Add Star Map time travel.");
    expect(rows[0].scholarWords).toContain("I wish");

    // Workshop ideas use their dedicated inbox, never the class digest queue.
    const queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toEqual([]);
  });

  test("UNconsented idea → no row", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai4" });
    const chatId = await seedChat(t, kai);
    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [{ ...consented("Dark mode"), consented: false }],
    });
    expect(res.captured).toBe(0);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("at the open-ideas cap (5) → no new row", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai5" });
    const chatId = await seedChat(t, kai);
    await t.run(async (ctx) => {
      for (let i = 0; i < 5; i++) {
        await ctx.db.insert("scholarSuggestions", {
          scholarId: kai,
          title: `Existing idea ${i}`,
          scholarWords: "...",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
    });
    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [consented("One too many")],
    });
    expect(res.captured).toBe(0);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(5);
  });

  test("duplicate title (case-insensitive) of an open idea → no row", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai6" });
    const chatId = await seedChat(t, kai);
    await t.run(async (ctx) =>
      ctx.db.insert("scholarSuggestions", {
        scholarId: kai,
        title: "Dark Mode",
        scholarWords: "...",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [consented("dark mode")],
    });
    expect(res.captured).toBe(0);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("captures multiple distinct consented ideas up to the cap", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai7" });
    const chatId = await seedChat(t, kai);
    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [consented("Idea A"), consented("Idea B"), { ...consented("Idea C"), consented: false }],
    });
    expect(res.captured).toBe(2);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows.map((r) => r.title).sort()).toEqual(["Idea A", "Idea B"]);
  });
});

describe("applyMetaAnalysis — portrait evidence", () => {
  test("high-bar item → ONE reflection masteryObservations row (no session, with metaChatId + quote)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiP1" });
    const chatId = await seedChat(t, kai);

    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [],
      portraitEvidence: [
        {
          conceptLabel: "dividing fractions",
          masteryLevel: 3.5,
          note: "Self-reported: says it clicked once she drew it out herself.",
          quote: "when I drew it myself it finally made sense",
        },
      ],
    });
    expect(res.portraitEvidence).toBe(1);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.scholarId).toBe(kai);
    expect(row.evidenceType).toBe("reflection");
    expect(row.attemptContext).toBe("reflection");
    expect(row.metaChatId).toBe(chatId);
    expect(row.sessionId).toBeUndefined();
    expect(row.transcriptExcerpt).toBe("when I drew it myself it finally made sense");
    expect(row.conceptLabel).toBe("dividing fractions");
    expect(row.masteryLevel).toBe(3.5);
    expect(row.isSuperseded).toBe(false);
    // No supersession from a reflection.
    expect(row.supersedesId).toBeUndefined();
  });

  test("clamps a drifting masteryLevel to the 0-5 Bloom scale", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiP2" });
    const chatId = await seedChat(t, kai);
    await applyAnalysis(t, {
      chatId,
      suggestions: [],
      portraitEvidence: [
        { conceptLabel: "x", masteryLevel: 99, note: "n", quote: "q" },
      ],
    });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(rows[0].masteryLevel).toBe(5);
  });

  test("absent / empty portraitEvidence → NO masteryObservations rows", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiP3" });
    const chatId = await seedChat(t, kai);

    // Absent (existing welfare+ideas callers).
    const r1 = await applyAnalysis(t, {
      chatId,
      suggestions: [consented("An idea")],
    });
    expect(r1.portraitEvidence).toBe(0);
    // Explicitly empty.
    const r2 = await applyAnalysis(t, {
      chatId,
      suggestions: [],
      portraitEvidence: [],
    });
    expect(r2.portraitEvidence).toBe(0);

    const rows = await t.run(async (ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(rows).toHaveLength(0);
  });

  test("welfare alert still fires FIRST when portrait evidence is also present", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiP4" });
    const chatId = await seedChat(t, kai);
    const res = await applyAnalysis(t, {
      chatId,
      safetyAlert: { severity: "warning", summary: "Concerning disclosure." },
      suggestions: [],
      portraitEvidence: [
        { conceptLabel: "c", masteryLevel: 2, note: "n", quote: "q" },
      ],
    });
    expect(res.alerted).toBe(true);
    expect(res.portraitEvidence).toBe(1);
    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
    expect(alerts[0].source).toBe("meta_chat");
  });
});

describe("applyMetaAnalysis — idea-conversations flag gates the observer's suggestion arm", () => {
  afterEach(() => {
    delete process.env.WORKSHOP_IDEA_CONVOS_ENABLED;
  });

  test("flag ON → consented ideas are NOT captured (the tool is the sole capture path)", async () => {
    process.env.WORKSHOP_IDEA_CONVOS_ENABLED = "true";
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiFlagOn" });
    const chatId = await seedChat(t, kai);

    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [consented("Idea one"), consented("Idea two")],
    });
    // No double-capture: the observer distills nothing while the flag is on.
    expect(res.captured).toBe(0);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(0);
    // And no Slack digest fan-out fired for a suggestion that wasn't captured.
    const queued = await t.run(async (ctx) =>
      ctx.db.query("slackNotificationQueue").collect(),
    );
    expect(queued).toHaveLength(0);
  });

  test("flag ON → welfare + portrait jobs are UNTOUCHED (safety coverage unchanged)", async () => {
    process.env.WORKSHOP_IDEA_CONVOS_ENABLED = "true";
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiFlagOn2" });
    const chatId = await seedChat(t, kai);

    const res = await applyAnalysis(t, {
      chatId,
      safetyAlert: { severity: "warning", summary: "Concerning disclosure." },
      suggestions: [consented("Should not capture")],
      portraitEvidence: [
        { conceptLabel: "fractions", masteryLevel: 3, note: "n", quote: "q" },
      ],
    });
    expect(res.alerted).toBe(true);
    expect(res.captured).toBe(0); // suggestion arm off
    expect(res.portraitEvidence).toBe(1); // portrait arm on

    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
    const mastery = await t.run(async (ctx) =>
      ctx.db.query("masteryObservations").collect(),
    );
    expect(mastery).toHaveLength(1);
  });

  test("flag OFF (explicit) → observer captures exactly as today", async () => {
    process.env.WORKSHOP_IDEA_CONVOS_ENABLED = "false";
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiFlagOff" });
    const chatId = await seedChat(t, kai);

    const res = await applyAnalysis(t, {
      chatId,
      suggestions: [consented("Captured as before")],
    });
    expect(res.captured).toBe(1);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Captured as before");
  });
});

describe("purpose gating and observer serialization", () => {
  test("Ask Rabbithole keeps welfare coverage but writes no reflection state", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiAskObserver" });
    const chatId = await seedChat(t, kai, "introspection");

    const result = await applyAnalysis(t, {
      chatId,
      safetyAlert: {
        severity: "warning",
        summary: "Scholar described possible ongoing harm.",
      },
      suggestions: [consented("A new Workshop color")],
      portraitEvidence: [
        {
          conceptLabel: "fractions",
          masteryLevel: 3,
          note: "Self-reported learning.",
          quote: "I finally understand fractions",
        },
      ],
    });

    expect(result.alerted).toBe(true);
    expect(result.captured).toBe(0);
    expect(result.portraitEvidence).toBe(0);
    expect(
      await t.run(async (ctx) => ctx.db.query("alerts").collect()),
    ).toHaveLength(1);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("scholarSuggestions").collect()),
    ).toHaveLength(0);
    expect(
      await t.run(async (ctx) =>
        ctx.db.query("masteryObservations").collect()),
    ).toHaveLength(0);
  });

  test("an applied range is idempotent and advances the cursor once", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiRange" });
    const chatId = await seedChat(t, kai);
    const sourceMessageId = "message-1";
    await t.run(async (ctx) => {
      await ctx.db.patch(chatId, {
        observerLeaseId: "lease-1",
        observerLeaseExpiresAt: Date.now() + 60_000,
      });
    });
    const args = {
      chatId,
      leaseId: "lease-1",
      rangeKey: "start:100",
      expectedCursorAt: undefined,
      throughAt: 100,
      newUserMessageIds: [sourceMessageId],
      suggestions: [consented("One durable idea")],
      portraitEvidence: [],
    };

    const first = await t.mutation(
      internal.metaChat.applyMetaAnalysis,
      args,
    );
    const second = await t.mutation(
      internal.metaChat.applyMetaAnalysis,
      args,
    );

    expect(first.captured).toBe(1);
    expect(second.captured).toBe(0);
    const state = await t.run(async (ctx) => ({
      chat: await ctx.db.get(chatId),
      runs: await ctx.db.query("metaObserverRuns").collect(),
      ideas: await ctx.db.query("scholarSuggestions").collect(),
    }));
    expect(state.chat?.observerCursorAt).toBe(100);
    expect(state.chat?.observerLeaseId).toBeUndefined();
    expect(state.runs).toHaveLength(1);
    expect(state.ideas).toHaveLength(1);
  });

  test("only one action can claim the next completed range", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiLease" });
    const chatId = await seedChat(t, kai);
    await t.run(async (ctx) => {
      await ctx.db.insert("metaMessages", {
        chatId,
        role: "user",
        content: "A completed turn",
        createdAt: Date.now(),
      });
      await ctx.db.insert("metaMessages", {
        chatId,
        role: "assistant",
        content: "Thanks for telling me.",
        createdAt: Date.now(),
      });
    });

    const first = await t.mutation(
      internal.metaChat.claimMetaObserverRange,
      { chatId },
    );
    const second = await t.mutation(
      internal.metaChat.claimMetaObserverRange,
      { chatId },
    );

    expect(first).not.toBeNull();
    expect(first?.newMessages).toHaveLength(2);
    expect(second).toBeNull();
  });

  test("a claim stops before the first still-streaming assistant row", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiContiguous" });
    const chatId = await seedChat(t, kai);
    const firstAssistantId = await t.run(async (ctx) => {
      const now = Date.now();
      await ctx.db.insert("metaMessages", {
        chatId,
        role: "user",
        content: "First turn",
        createdAt: now,
      });
      const assistantId = await ctx.db.insert("metaMessages", {
        chatId,
        role: "assistant",
        content: "Still streaming",
        streamId: "stream-1",
        createdAt: now,
      });
      await ctx.db.insert("metaMessages", {
        chatId,
        role: "user",
        content: "Second turn",
        createdAt: now,
      });
      await ctx.db.insert("metaMessages", {
        chatId,
        role: "assistant",
        content: "Second reply finished first",
        createdAt: now,
      });
      return assistantId;
    });

    expect(
      await t.mutation(internal.metaChat.claimMetaObserverRange, { chatId }),
    ).toBeNull();

    await t.run(async (ctx) =>
      ctx.db.patch(firstAssistantId, { streamId: undefined }),
    );
    const claim = await t.mutation(
      internal.metaChat.claimMetaObserverRange,
      { chatId },
    );
    expect(claim?.newMessages.map((message) => message.content)).toEqual([
      "First turn",
      "Still streaming",
      "Second turn",
      "Second reply finished first",
    ]);
  });
});

// Schema-consumer audit: a session-less (reflection) masteryObservation must
// flow through the MAIN scholar-facing mastery read (masteryObservations
// .listForScholar, the "My Learning" feed) without crashing — proving the
// sessionId→optional widening is tolerated end-to-end.
describe("session-less reflection observation through the scholar mastery read", () => {
  test("listForScholar returns the reflection row (no sessionId) without throwing", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiA1" });
    const chatId = await seedChat(t, kai);
    await applyAnalysis(t, {
      chatId,
      suggestions: [],
      portraitEvidence: [
        {
          conceptLabel: "learning by drawing",
          masteryLevel: 3,
          note: "Self-reported representation preference.",
          quote: "drawing it helps me",
        },
      ],
    });

    const asKai = await withUser(t, kai);
    const feed = await asKai.query(api.masteryObservations.listForScholar, {
      scholarId: kai,
    });
    expect(feed).toHaveLength(1);
    expect(feed[0].conceptLabel).toBe("learning by drawing");
    expect(feed[0].sessionId).toBeUndefined();
    expect(feed[0].evidenceType).toBe("reflection");
    // Unmapped (no standard) → the mastery-marker stop is null, not a crash.
    expect(feed[0].stop).toBeNull();
  });
});

describe("applyMetaAnalysis — robustness", () => {
  test("alert + capture together resolve; a safety alert never blocks idea capture (fire-and-forget)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai8" });
    const chatId = await seedChat(t, kai);
    // safetyAlert is raised BEFORE the idea write; even so, the consented idea
    // still lands — the alert step is wrapped fire-and-forget and can't throw
    // into the write path (mirrors observer.ts).
    const res = await applyAnalysis(t, {
      chatId,
      safetyAlert: {
        severity: "warning",
        summary: "Concerning disclosure.",
      },
      suggestions: [consented("Idea after alert")],
    });
    expect(res.alerted).toBe(true);
    expect(res.captured).toBe(1);
    const alerts = await t.run(async (ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(1);
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(1);
  });

  test("a missing chat is a no-op (never throws)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai9" });
    const chatId = await seedChat(t, kai);
    // Delete the chat, then run — applyMetaAnalysis must return cleanly.
    await t.run(async (ctx) => ctx.db.delete(chatId));
    const res = await t.mutation(internal.metaChat.applyMetaAnalysis, {
      chatId,
      leaseId: "missing-chat-lease",
      rangeKey: "start:1",
      throughAt: 1,
      newUserMessageIds: ["missing-message"],
      safetyAlert: {
        severity: "critical",
        summary: "x",
        sourceMessageId: "missing-message",
      },
      suggestions: [consented("Nope")],
    });
    expect(res).toEqual({ alerted: false, captured: 0, portraitEvidence: 0 });
    const rows = await t.run(async (ctx) =>
      ctx.db.query("scholarSuggestions").collect(),
    );
    expect(rows).toHaveLength(0);
  });
});
