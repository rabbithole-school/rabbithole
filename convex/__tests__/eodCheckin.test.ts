import { convexTest } from "convex-test";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { checkinDayStartMs, EOD_CHECKIN_SYSTEM } from "../lib/eodCheckin";
import type { SlackMessage } from "../lib/slackApi";
import { SCHOLAR_PRONOUN_GUIDANCE } from "../lib/scholarPronouns";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const WEEKDAY = Date.parse("2026-07-28T00:05:00.000Z"); // Mon 2:05 PM HST
const SATURDAY = Date.parse("2026-08-02T00:05:00.000Z"); // Sat 2:05 PM HST
const previousSlackToken = process.env.SLACK_BOT_TOKEN;
const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;

test("end-of-day narrative uses the shared scholar-pronoun fallback", () => {
  expect(EOD_CHECKIN_SYSTEM()).toContain(SCHOLAR_PRONOUN_GUIDANCE);
});

test("collectChannelDay keeps same-day signals tenant-scoped, ranked, deduped, and capped", async () => {
  const t = convexTest(schema, modules);
  const setup = await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Kestrel Academy",
      slug: "kestrel",
      kind: "school",
      timeZone: "Pacific/Honolulu",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Fictional Teacher",
      username: "fictional-teacher",
      role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Fictional Scholar",
      username: "fictional-scholar",
      role: "scholar",
      institutionId,
    });
    const otherScholarId = await ctx.db.insert("users", {
      name: "Other Scholar",
      username: "other-scholar",
      role: "scholar",
      institutionId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Fireflies",
      scholarIds: [scholarId],
      slackChannelId: "CFICTIONAL",
    });
    return { scholarId, otherScholarId, groupId };
  });

  const oldCreation = await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: setup.scholarId,
      title: "Yesterday",
      isArchived: false,
      lastMessageAt: Date.now(),
    });
    const signalId = await ctx.db.insert("sessionSignals", {
      scholarId: setup.scholarId,
      sessionId,
      signalType: "metacognition",
      intensity: "high",
      description: "Old reflection",
    });
    return (await ctx.db.get(signalId))!._creationTime;
  });

  const currentCreation = await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: setup.scholarId,
      title: "Today's work",
      isArchived: false,
      lastMessageAt: Date.now(),
    });
    const insertSignal = (signalType: string, intensity: string, description: string) =>
      ctx.db.insert("sessionSignals", {
        scholarId: setup.scholarId,
        sessionId,
        signalType,
        intensity,
        description,
      });
    await insertSignal("creative_approach", "high", "Tried a new diagram");
    await insertSignal("creative_approach", "high", "Revised the new diagram");
    await insertSignal("task_commitment", "high", "Returned to the hard case");
    await insertSignal("self_direction", "high", "Chose a new question");
    await insertSignal("metacognition", "moderate", "Named a confusion");

    const otherSessionId = await ctx.db.insert("sessions", {
      userId: setup.otherScholarId,
      title: "Other work",
      isArchived: false,
      lastMessageAt: Date.now(),
    });
    await ctx.db.insert("sessionSignals", {
      scholarId: setup.otherScholarId,
      sessionId: otherSessionId,
      signalType: "intellectual_intensity",
      intensity: "high",
      description: "Asked several questions",
    });
    const latest = await ctx.db
      .query("sessionSignals")
      .withIndex("by_scholar", (q) => q.eq("scholarId", setup.scholarId))
      .order("desc")
      .first();
    return latest!._creationTime;
  });

  const collected = await t.run(async (ctx) =>
    ctx.runQuery(internal.eodCheckin.collectChannelDay, {
      groupIds: [setup.groupId],
      dayStartMs: oldCreation + 0.001,
      nowMs: currentCreation,
    }),
  );
  const signals = collected.scholars[0]?.signals ?? [];
  expect(signals).toHaveLength(3);
  expect(signals.map((signal) => signal.type)).toEqual([
    "creative_approach",
    "self_direction",
    "task_commitment",
  ]);
  expect(signals[0].description).toBe("Revised the new diagram");
  expect(signals.map((signal) => signal.description)).not.toContain(
    "Old reflection",
  );
  expect(signals.map((signal) => signal.description)).not.toContain(
    "Asked several questions",
  );
  expect(signals.every((signal) => signal.sessionUrl.includes("/scholar/"))).toBe(
    true,
  );
});

test("collectChannelDay counts every practice attempt in the day, not a page of them", async () => {
  const t = convexTest(schema, modules);
  const dayStartMs = Date.parse("2026-09-01T10:00:00.000Z"); // midnight HST
  const nowMs = Date.parse("2026-09-02T00:05:00.000Z"); // 2:05 PM HST

  const setup = await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Kestrel Academy",
      slug: "kestrel",
      kind: "school",
      timeZone: "Pacific/Honolulu",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Fictional Teacher",
      username: "fictional-teacher",
      role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Fictional Scholar",
      username: "fictional-scholar",
      role: "scholar",
      institutionId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Fireflies",
      scholarIds: [scholarId],
      slackChannelId: "CFICTIONAL",
    });

    // 45 graded attempts across 30 distinct skills — comfortably past the
    // LIST_LIMIT page that used to decide both numbers.
    for (let i = 0; i < 45; i += 1) {
      await ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: `skill-${i % 30}`,
        correct: true,
        createdAt: dayStartMs + i * 60_000,
      });
    }
    // Retry rows are diagnostics, never graded attempts.
    await ctx.db.insert("practiceAttempts", {
      scholarId,
      nodeKey: "skill-retry-only",
      correct: false,
      retry: true,
      createdAt: dayStartMs + 60_000,
    });
    // Outside the window on either side.
    await ctx.db.insert("practiceAttempts", {
      scholarId,
      nodeKey: "skill-yesterday",
      correct: true,
      createdAt: dayStartMs - 60_000,
    });
    await ctx.db.insert("practiceAttempts", {
      scholarId,
      nodeKey: "skill-after-cutoff",
      correct: true,
      createdAt: nowMs + 60_000,
    });
    return { groupId };
  });

  const collected = await t.run(async (ctx) =>
    ctx.runQuery(internal.eodCheckin.collectChannelDay, {
      groupIds: [setup.groupId],
      dayStartMs,
      nowMs,
    }),
  );

  const scholar = collected.scholars[0];
  expect(scholar.practiceAttempts).toBe(45);
  expect(scholar.practiceDistinctSkills).toBe(30);
});

test("collectChannelDay excludes staff-only Whole Child and neutral notes", async () => {
  const t = convexTest(schema, modules);
  const setup = await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Kestrel Academy",
      slug: "kestrel",
      kind: "school",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Fictional Teacher",
      username: "fictional-teacher",
      role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Fictional Scholar",
      username: "fictional-scholar",
      role: "scholar",
      institutionId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Fireflies",
      scholarIds: [scholarId],
      slackChannelId: "CFICTIONAL",
    });
    const praiseId = await ctx.db.insert("observations", {
      teacherId,
      scholarId,
      note: "Built a clear model explanation.",
      type: "praise",
    });
    const wholeChildId = await ctx.db.insert("observations", {
      teacherId,
      scholarId,
      note: "Staff-only social-emotional context.",
      type: "note",
      category: "socialEmotional",
    });
    const noteId = await ctx.db.insert("observations", {
      teacherId,
      scholarId,
      note: "Neutral note without a category.",
      type: "note",
    });
    const observations = await Promise.all([
      ctx.db.get(praiseId),
      ctx.db.get(wholeChildId),
      ctx.db.get(noteId),
    ]);
    return {
      groupId,
      startsAt: Math.min(
        ...observations.map((observation) => observation!._creationTime),
      ),
      endsAt: Math.max(
        ...observations.map((observation) => observation!._creationTime),
      ),
    };
  });

  const collected = await t.run((ctx) =>
    ctx.runQuery(internal.eodCheckin.collectChannelDay, {
      groupIds: [setup.groupId],
      dayStartMs: setup.startsAt,
      nowMs: setup.endsAt,
    }),
  );
  expect(collected.scholars[0]?.observations).toEqual([
    { kind: "praise", text: "Built a clear model explanation." },
  ]);
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(WEEKDAY);
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.useRealTimers();
  if (previousSlackToken === undefined) {
    delete process.env.SLACK_BOT_TOKEN;
  } else {
    process.env.SLACK_BOT_TOKEN = previousSlackToken;
  }
  if (previousAnthropicKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
  }
});

async function seedLinkedGroup(
  t: ReturnType<typeof convexTest>,
  options: { linked?: boolean; withCompletion?: boolean } = {},
) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
      timeZone: "Pacific/Honolulu",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Test Teacher",
      username: "test-teacher",
      role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Kai",
      username: "kai",
      role: "scholar",
      institutionId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Geckos",
      scholarIds: [scholarId],
      ...(options.linked === false ? {} : { slackChannelId: "C123" }),
    });

    let activityId: Id<"activities"> | null = null;
    if (options.withCompletion) {
      activityId = await ctx.db.insert("activities", {
        title: "Fraction Lab",
        kind: "offline",
        order: 0,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId,
        completedAt: Date.now() - 60_000,
      });
    }
    return { institutionId, teacherId, scholarId, groupId, activityId };
  });
}

function stubSlackPosts(
  responses: Array<Record<string, unknown> | Response> = [],
  reads: {
    history?: Array<Record<string, unknown>>;
    replies?: Array<Record<string, unknown>>;
  } = {},
) {
  const realFetch = globalThis.fetch;
  const posts: Array<Record<string, unknown>> = [];
  const history = reads.history ?? [];
  const replies = reads.replies ?? [];
  globalThis.fetch = (async (
    url: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const method = String(url);
    if (method.includes("conversations.history")) {
      return new Response(
        JSON.stringify(history.shift() ?? { ok: true, messages: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (method.includes("conversations.replies")) {
      return new Response(
        JSON.stringify(replies.shift() ?? { ok: true, messages: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    expect(method).toContain("chat.postMessage");
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const response = responses[posts.length - 1];
    if (response instanceof Response) return response;
    return new Response(
      JSON.stringify(
        response ?? {
          ok: true,
          ts: `${posts.length}00.1`,
        },
      ),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as typeof fetch;
  return {
    posts,
    history,
    replies,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

describe("end-of-day Slack check-in", () => {
  test("excludes a transferred scholar left in a stamped group's stale roster", async () => {
    const t = convexTest(schema, modules);
    const collected = await t.run(async (ctx) => {
      const [moli, guests] = await Promise.all([
        ctx.db.insert("institutions", {
          name: "Moli School",
          slug: "moli",
          kind: "school",
        }),
        ctx.db.insert("institutions", {
          name: "Guests",
          slug: "guests",
          kind: "guest",
        }),
      ]);
      const teacherId = await ctx.db.insert("users", {
        role: "teacher",
        username: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        role: "scholar",
        username: "moved-scholar",
        name: "Moved Scholar",
        institutionId: guests,
      });
      // A stale pre-transfer membership must lose to users.institutionId during
      // the widen phase.
      await ctx.db.insert("memberships", {
        userId: scholarId,
        role: "scholar",
        institutionId: moli,
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        institutionId: moli,
        name: "Geckos",
        scholarIds: [scholarId],
        slackChannelId: "C123",
      });
      await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C123",
        text: "*Moved Scholar* completed *Old activity*",
        sent: false,
      });
      return await ctx.runQuery(internal.eodCheckin.collectChannelDay, {
        groupIds: [groupId],
        dayStartMs: WEEKDAY - 24 * 60 * 60 * 1000,
        nowMs: WEEKDAY,
      });
    });

    expect(collected.scholars).toEqual([]);
    expect(collected.queuedDigestLines).toEqual([]);
  });

  test("excludes every scholar from an unstamped legacy group's channel", async () => {
    const t = convexTest(schema, modules);
    const collected = await t.run(async (ctx) => {
      const institutionId = await ctx.db.insert("institutions", {
        name: "Guests",
        slug: "guests",
        kind: "guest",
      });
      const teacherId = await ctx.db.insert("users", {
        role: "teacher",
        username: "teacher",
      });
      const scholarId = await ctx.db.insert("users", {
        role: "scholar",
        username: "moved-scholar",
        institutionId,
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId,
        name: "Legacy group",
        scholarIds: [scholarId],
        slackChannelId: "C123",
      });
      await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C123",
        text: "*Moved Scholar* completed *Old activity*",
        sent: false,
      });
      return await ctx.runQuery(internal.eodCheckin.collectChannelDay, {
        groupIds: [groupId],
        dayStartMs: WEEKDAY - 24 * 60 * 60 * 1000,
        nowMs: WEEKDAY,
      });
    });

    expect(collected.scholars).toEqual([]);
    expect(collected.queuedDigestLines).toEqual([]);
  });

  test("keeps today's cohort moments while their digest regenerates", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, teacherId, scholarId, groupId } =
      await seedLinkedGroup(t);
    const seeded = await t.run(async (ctx) => {
      const outsideScholarId = await ctx.db.insert("users", {
        name: "Outside Scholar",
        username: "outside",
        role: "scholar",
        institutionId,
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Patterns",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Seeing structure",
        order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Pattern hunt",
        kind: "online",
        order: 0,
      });
      const assignmentId = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId, outsideScholarId],
        startedAt: Date.now(),
      });
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Pattern hunt",
        isArchived: false,
        lastMessageAt: Date.now() - 60_000,
      });
      const oldSessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Old pattern hunt",
        isArchived: false,
        lastMessageAt: WEEKDAY - 25 * 60 * 60 * 1000,
      });
      const outsideSessionId = await ctx.db.insert("sessions", {
        userId: outsideScholarId,
        unitId,
        lessonId,
        activityId,
        assignmentId,
        title: "Outside pattern hunt",
        isArchived: false,
        lastMessageAt: Date.now() - 60_000,
      });
      await ctx.db.insert("classDigests", {
        scope: "cohort",
        assignmentId,
        status: "pending",
        generatedAt: Date.now(),
        moments: [
          {
            kind: "breakthrough",
            scholarId,
            scholarName: "Stale stored name",
            sessionId,
            headline: "Found the repeating structure",
            detail: "Explained why the third case follows the same rule.",
          },
          {
            kind: "insight",
            scholarId,
            scholarName: "Kai",
            sessionId: oldSessionId,
            headline: "Old insight",
            detail: "This did not happen today.",
          },
          {
            kind: "insight",
            scholarId: outsideScholarId,
            scholarName: "Outside Scholar",
            sessionId: outsideSessionId,
            headline: "Outside-group insight",
            detail: "This belongs in another group's recap.",
          },
        ],
      });
      return { sessionId };
    });

    const collected = await t.run((ctx) =>
      ctx.runQuery(internal.eodCheckin.collectChannelDay, {
        groupIds: [groupId],
        dayStartMs: checkinDayStartMs(WEEKDAY),
        nowMs: WEEKDAY,
      }),
    );

    expect(collected.keyMoments).toEqual([
      expect.objectContaining({
        kind: "breakthrough",
        scholarName: "Kai",
        headline: "Found the repeating structure",
        detail: "Explained why the third case follows the same rule.",
        sessionUrl: expect.stringContaining(String(seeded.sessionId)),
      }),
    ]);
  });

  test("posts a parent and threaded fallback, finalizes, and dedupes", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, groupId } = await seedLinkedGroup(t, {
      withCompletion: true,
    });
    await t.run(async (ctx) => {
      await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C123",
        text: "*Kai* completed *Fraction Lab*",
        sent: false,
      });
    });

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const slack = stubSlackPosts();
    try {
      const first = await t.action(internal.eodCheckin.runDaily, {});
      expect(first).toEqual({ postedChannels: 1, skippedChannels: 0 });
      expect(slack.posts).toHaveLength(2);
      expect(slack.posts[0]).toMatchObject({
        channel: "C123",
        markdown_text: "🌅 Geckos' Rabbithole day is ready to unpack.",
        metadata: {
          event_type: "rabbithole_eod_checkin",
        },
      });
      expect(slack.posts[1]).toMatchObject({
        channel: "C123",
        thread_ts: "100.1",
      });
      expect(String(slack.posts[1].markdown_text)).toContain(
        "*Questions for you*",
      );
      expect(String(slack.posts[1].markdown_text)).toContain(
        "Fraction Lab",
      );

      const rows = await t.run(async (ctx) => ({
        checkins: await ctx.db.query("eodCheckins").collect(),
        threads: await ctx.db.query("slackThreads").collect(),
        queued: await ctx.db.query("slackNotificationQueue").collect(),
      }));
      expect(rows.checkins).toHaveLength(1);
      expect(rows.checkins[0]).toMatchObject({
        parentText: "🌅 Geckos' Rabbithole day is ready to unpack.",
        threadTs: "100.1",
      });
      expect(rows.threads).toHaveLength(1);
      expect(rows.threads[0]).toMatchObject({
        channelId: "C123",
        threadTs: "100.1",
        startedByUserId: teacherId,
      });
      expect(rows.queued).toHaveLength(1);
      expect(rows.queued[0].sent).toBe(true);

      const second = await t.action(internal.eodCheckin.runDaily, {});
      expect(second).toEqual({ postedChannels: 0, skippedChannels: 1 });
      expect(slack.posts).toHaveLength(2);
    } finally {
      slack.restore();
    }
  });

  test("finalization leaves activity queued when it arrived after the wrap-up snapshot", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, groupId } = await seedLinkedGroup(t);
    const { checkinId, capturedId, lateId } = await t.run(async (ctx) => {
      const capturedId = await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C123",
        text: "*Kai* completed *Fraction Lab*",
        sent: false,
      });
      const lateId = await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C123",
        text: "*Kai* submitted *Reflection*",
        sent: false,
      });
      const checkinId = await ctx.db.insert("eodCheckins", {
        channelId: "C123",
        dateKey: "2026-07-27",
        threadTs: "100.1",
        lifecycle: "reply_pending",
        initialQueueIds: [capturedId],
        groupIds: [groupId],
        postedAt: WEEKDAY,
      });
      return { checkinId, capturedId, lateId };
    });

    await t.mutation(internal.eodCheckin.finalizeCheckin, {
      checkinId,
      threadTs: "100.1",
      teacherId,
      channelId: "C123",
    });

    const state = await t.run(async (ctx) => ({
      captured: await ctx.db.get(capturedId),
      late: await ctx.db.get(lateId),
    }));
    expect(state.captured?.sent).toBe(true);
    expect(state.late?.sent).toBe(false);
  });

  test("reuses a staged parent after a threaded reply failure", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, groupId } = await seedLinkedGroup(t, {
      withCompletion: true,
    });

    await t.run(async (ctx) => {
      await ctx.db.insert("slackNotificationQueue", {
        groupId,
        channelId: "C123",
        text: "*Kai* completed *Fraction Lab*",
        sent: false,
      });
    });

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const slack = stubSlackPosts([
      { ok: true, ts: "100.1" },
      { ok: false, error: "thread reply failed" },
      { ok: true, ts: "100.2" },
    ]);
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 0,
        skippedChannels: 1,
      });
      expect(slack.posts).toHaveLength(2);
      expect(slack.posts.filter((post) => post.thread_ts === undefined)).toHaveLength(
        1,
      );

      const staged = await t.run(async (ctx) => ({
        checkins: await ctx.db.query("eodCheckins").collect(),
        queued: await ctx.db.query("slackNotificationQueue").collect(),
      }));
      expect(staged.checkins).toHaveLength(1);
      expect(staged.checkins[0]).toMatchObject({
        parentText: "🌅 Geckos' Rabbithole day is ready to unpack.",
        threadTs: "100.1",
        lifecycle: "reply_pending",
      });
      expect(staged.queued[0].sent).toBe(false);

      vi.setSystemTime(WEEKDAY + 2 * 60 * 60 * 1000 + 60_000);
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 1,
        skippedChannels: 0,
      });
      expect(slack.posts).toHaveLength(3);
      expect(slack.posts.filter((post) => post.thread_ts === undefined)).toHaveLength(
        1,
      );
      expect(slack.posts[2]).toMatchObject({
        channel: "C123",
        thread_ts: "100.1",
      });

      const finalized = await t.run(async (ctx) => ({
        checkins: await ctx.db.query("eodCheckins").collect(),
        threads: await ctx.db.query("slackThreads").collect(),
        queued: await ctx.db.query("slackNotificationQueue").collect(),
      }));
      expect(finalized.checkins).toHaveLength(1);
      expect(finalized.checkins[0]).toMatchObject({
        threadTs: "100.1",
        lifecycle: "completed",
      });
      expect(finalized.threads).toHaveLength(1);
      expect(finalized.threads[0]).toMatchObject({
        channelId: "C123",
        threadTs: "100.1",
        startedByUserId: teacherId,
      });
      expect(finalized.queued[0].sent).toBe(true);
    } finally {
      slack.restore();
    }
  });

  test("reconciles an ambiguous parent response before retrying the original date", async () => {
    const t = convexTest(schema, modules);
    await seedLinkedGroup(t, { withCompletion: true });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const slack = stubSlackPosts([
      { ok: false, error: "internal_error" },
      { ok: true, ts: "100.2" },
    ]);
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 0,
        skippedChannels: 1,
      });
      expect(slack.posts).toHaveLength(1);
      const pending = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").unique(),
      );
      expect(pending).toMatchObject({
        lifecycle: "reply_pending",
        retryAttempts: 1,
      });
      slack.history.push({
        ok: true,
        messages: [],
        response_metadata: { next_cursor: "next-page" },
      });
      slack.history.push({
        ok: true,
        messages: [
          {
            ts: "100.1",
            metadata: {
              event_type: "rabbithole_eod_checkin",
              event_payload: { delivery_id: `eod:${pending!._id}:parent` },
            },
          } satisfies Partial<SlackMessage>,
        ],
      });

      vi.setSystemTime(WEEKDAY + 5 * 60_000);
      expect(
        await t.action(internal.eodCheckin.runDaily, { sweepOnly: true }),
      ).toEqual({
        postedChannels: 1,
        skippedChannels: 0,
      });
      expect(slack.posts).toHaveLength(2);
      expect(slack.posts.filter((post) => post.thread_ts === undefined)).toHaveLength(
        1,
      );
      expect(slack.posts[1]).toMatchObject({
        thread_ts: "100.1",
        metadata: {
          event_payload: { delivery_id: expect.stringMatching(/:reply$/) },
        },
      });
    } finally {
      slack.restore();
    }
  });

  test("reconciles an ambiguously accepted reply instead of posting it twice", async () => {
    const t = convexTest(schema, modules);
    await seedLinkedGroup(t, { withCompletion: true });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const slack = stubSlackPosts([
      { ok: true, ts: "100.1" },
      { ok: false, error: "fatal_error" },
    ]);
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 0,
        skippedChannels: 1,
      });
      expect(slack.posts).toHaveLength(2);
      const pending = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").unique(),
      );
      slack.replies.push({
        ok: true,
        messages: [],
        response_metadata: { next_cursor: "next-page" },
      });
      slack.replies.push({
        ok: true,
        messages: [
          {
            ts: "100.2",
            thread_ts: "100.1",
            metadata: {
              event_type: "rabbithole_eod_checkin",
              event_payload: { delivery_id: `eod:${pending!._id}:reply` },
            },
          } satisfies Partial<SlackMessage>,
        ],
      });

      vi.setSystemTime(WEEKDAY + 5 * 60_000);
      expect(
        await t.action(internal.eodCheckin.runDaily, { sweepOnly: true }),
      ).toEqual({
        postedChannels: 1,
        skippedChannels: 0,
      });
      expect(slack.posts).toHaveLength(2);
      const checkin = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").unique(),
      );
      expect(checkin).toMatchObject({ lifecycle: "completed", threadTs: "100.1" });
    } finally {
      slack.restore();
    }
  });

  test("retains Slack Retry-After before sweeping a rate-limited parent", async () => {
    const t = convexTest(schema, modules);
    await seedLinkedGroup(t, { withCompletion: true });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const slack = stubSlackPosts([
      new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": "120",
        },
      }),
    ]);
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 0,
        skippedChannels: 1,
      });
      const checkin = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").unique(),
      );
      expect(checkin?.retryAt).toBeGreaterThanOrEqual(WEEKDAY + 120_000);

      vi.setSystemTime(WEEKDAY + 119_000);
      expect(
        await t.action(internal.eodCheckin.runDaily, { sweepOnly: true }),
      ).toEqual({
        postedChannels: 0,
        skippedChannels: 0,
      });
      expect(slack.posts).toHaveLength(1);
    } finally {
      slack.restore();
    }
  });

  test("sweeps a due retry after completed rows have filled the retry index", async () => {
    const t = convexTest(schema, modules);
    const { groupId } = await seedLinkedGroup(t);
    const dueId = await t.run(async (ctx) => {
      for (let index = 0; index <= 20; index += 1) {
        await ctx.db.insert("eodCheckins", {
          channelId: `Cdone${index}`,
          dateKey: "2026-07-27",
          groupIds: [groupId],
          lifecycle: "completed",
          postedAt: WEEKDAY,
        });
      }
      return await ctx.db.insert("eodCheckins", {
        channelId: "C123",
        dateKey: "2026-07-27",
        groupIds: [groupId],
        lifecycle: "reply_pending",
        retryAt: WEEKDAY - 1,
        postedAt: WEEKDAY,
      });
    });

    const due = await t.mutation(internal.eodCheckin.claimDueRetries, {});
    expect(due.map((checkin) => checkin._id)).toEqual([dueId]);
  });

  test("persists a check-in's institution for a later retry", async () => {
    const t = convexTest(schema, modules);
    const { groupId } = await seedLinkedGroup(t);
    const institutionId = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Harbor School",
        slug: "harbor",
        kind: "school",
      }),
    );
    const claim = await t.mutation(internal.eodCheckin.claimCheckin, {
      channelId: "C123",
      dateKey: "2026-07-27",
      groupIds: [groupId],
      dayStartMs: WEEKDAY,
      dateLabel: "Monday, July 27",
      institutionId,
    });
    const checkin = await t.run(async (ctx) =>
      ctx.db.get(claim.checkinId!),
    );
    expect(checkin?.institutionId).toBe(institutionId);
  });

  test("reclaims and finalizes an unfinalized claim after two hours", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, groupId } = await seedLinkedGroup(t);
    const claimArgs = {
      channelId: "C123",
      dateKey: "2026-07-27",
      groupIds: [groupId],
    };

    const first = await t.mutation(internal.eodCheckin.claimCheckin, claimArgs);
    expect(first.claimed).toBe(true);
    expect(first.checkinId).toBeDefined();

    const reclaimedAt = WEEKDAY + 2 * 60 * 60 * 1000 + 60_000;
    vi.setSystemTime(reclaimedAt);
    const reclaimed = await t.mutation(
      internal.eodCheckin.claimCheckin,
      claimArgs,
    );
    expect(reclaimed).toEqual(first);

    await t.mutation(internal.eodCheckin.finalizeCheckin, {
      checkinId: reclaimed.checkinId!,
      threadTs: "200.1",
      teacherId,
      channelId: "C123",
    });
    const checkins = await t.run(async (ctx) =>
      ctx.db.query("eodCheckins").collect(),
    );
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({
      postedAt: reclaimedAt,
      threadTs: "200.1",
    });
  });

  test("finishes a legacy staged parent without reposting its parent", async () => {
    const t = convexTest(schema, modules);
    const { groupId } = await seedLinkedGroup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("eodCheckins", {
        channelId: "C123",
        dateKey: "2026-07-27",
        groupIds: [groupId],
        threadTs: "100.1",
        lifecycle: "parent_staged",
        retryAt: WEEKDAY,
        postedAt: WEEKDAY - 2 * 60 * 60 * 1000,
      });
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const slack = stubSlackPosts();
    try {
      expect(
        await t.action(internal.eodCheckin.runDaily, { sweepOnly: true }),
      ).toEqual({ postedChannels: 1, skippedChannels: 0 });
      expect(slack.posts).toHaveLength(1);
      expect(slack.posts[0]).toMatchObject({
        channel: "C123",
        thread_ts: "100.1",
      });
      const checkin = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").unique(),
      );
      expect(checkin).toMatchObject({ lifecycle: "completed", threadTs: "100.1" });
    } finally {
      slack.restore();
    }
  });

  test("treats a lifecycle-less legacy thread as finalized", async () => {
    const t = convexTest(schema, modules);
    const { groupId } = await seedLinkedGroup(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("eodCheckins", {
        channelId: "C123",
        dateKey: "2026-07-27",
        groupIds: [groupId],
        threadTs: "100.1",
        postedAt: WEEKDAY - 3 * 60 * 60 * 1000,
      });
    });
    expect(
      await t.mutation(internal.eodCheckin.claimCheckin, {
        channelId: "C123",
        dateKey: "2026-07-27",
        groupIds: [groupId],
      }),
    ).toEqual({ claimed: false });
  });

  test("does not reclaim a fresh unfinalized claim", async () => {
    const t = convexTest(schema, modules);
    const { groupId } = await seedLinkedGroup(t);
    const claimArgs = {
      channelId: "C123",
      dateKey: "2026-07-27",
      groupIds: [groupId],
    };

    const first = await t.mutation(internal.eodCheckin.claimCheckin, claimArgs);
    vi.setSystemTime(WEEKDAY + 119 * 60_000);
    expect(
      await t.mutation(internal.eodCheckin.claimCheckin, claimArgs),
    ).toEqual({ claimed: false });

    const checkins = await t.run(async (ctx) =>
      ctx.db.query("eodCheckins").collect(),
    );
    expect(checkins).toHaveLength(1);
    expect(checkins[0].postedAt).toBe(WEEKDAY);
    expect(checkins[0]._id).toBe(first.checkinId);
  });

  test("never reclaims a finalized check-in", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, groupId } = await seedLinkedGroup(t);
    const claimArgs = {
      channelId: "C123",
      dateKey: "2026-07-27",
      groupIds: [groupId],
    };

    const first = await t.mutation(internal.eodCheckin.claimCheckin, claimArgs);
    expect(first.checkinId).toBeDefined();
    await t.mutation(internal.eodCheckin.finalizeCheckin, {
      checkinId: first.checkinId!,
      threadTs: "300.1",
      teacherId,
      channelId: "C123",
    });

    vi.setSystemTime(WEEKDAY + 2 * 60 * 60 * 1000 + 60_000);
    expect(
      await t.mutation(internal.eodCheckin.claimCheckin, claimArgs),
    ).toEqual({ claimed: false });
    const checkins = await t.run(async (ctx) =>
      ctx.db.query("eodCheckins").collect(),
    );
    expect(checkins).toHaveLength(1);
    expect(checkins[0]).toMatchObject({
      postedAt: WEEKDAY,
      threadTs: "300.1",
    });
  });

  test("scheduled gaps: live entries split done/missing; planned-only and archived ignored", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId, groupId } = await seedLinkedGroup(t);
    await t.run(async (ctx) => {
      const liveDone = await ctx.db.insert("activities", {
        title: "Tide Pool Field Notes",
        kind: "offline",
        order: 0,
      });
      const liveMissing = await ctx.db.insert("activities", {
        title: "Equal Shares Card Sort",
        kind: "offline",
        order: 1,
      });
      const plannedOnly = await ctx.db.insert("activities", {
        title: "Planned Only",
        kind: "offline",
        order: 2,
      });
      const archived = await ctx.db.insert("activities", {
        title: "Archived Activity",
        kind: "offline",
        order: 3,
      });
      await ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [scholarId],
        startedAt: Date.now() - 7 * 86_400_000,
        activitySchedule: [
          // Went live today → counted.
          { activityId: liveDone, mode: "classFocus", setAt: Date.now() - 3_600_000 },
          { activityId: liveMissing, mode: "classFocus", setAt: Date.now() - 3_600_000 },
          // Planned for today but never pushed live → never on anyone's
          // plate, must NOT produce a "missing completion".
          { activityId: plannedOnly, mode: "classFocus", startsAt: Date.now() - 3_600_000 },
        ],
      });
      await ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [scholarId],
        startedAt: Date.now() - 7 * 86_400_000,
        archivedAt: Date.now() - 3_600_000,
        activitySchedule: [
          { activityId: archived, mode: "classFocus", setAt: Date.now() - 3_600_000 },
        ],
      });
      await ctx.db.insert("activityCompletions", {
        scholarId,
        activityId: liveDone,
        completedAt: Date.now() - 60_000,
      });
    });

    const collected = await t.run(async (ctx) =>
      ctx.runQuery(internal.eodCheckin.collectChannelDay, {
        groupIds: [groupId],
        dayStartMs: checkinDayStartMs(Date.now()),
        nowMs: Date.now(),
      }),
    );
    const byTitle = new Map(
      collected.scheduled.map((row) => [row.activityTitle, row]),
    );
    expect([...byTitle.keys()].sort()).toEqual([
      "Equal Shares Card Sort",
      "Tide Pool Field Notes",
    ]);
    expect(byTitle.get("Tide Pool Field Notes")).toMatchObject({
      doneScholarNames: ["Kai"],
      missingScholarNames: [],
    });
    expect(byTitle.get("Equal Shares Card Sort")).toMatchObject({
      doneScholarNames: [],
      missingScholarNames: ["Kai"],
    });
  });

  test("past-due homework: dated, live, targeted, tenant-scoped, grouped across one-scholar copies", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, teacherId, scholarId: kaiId, groupId } =
      await seedLinkedGroup(t);
    const DAY = 86_400_000;
    const ids = await t.run(async (ctx) => {
      const mia = await ctx.db.insert("users", {
        name: "Mia", username: "mia", role: "scholar", institutionId,
      });
      const noa = await ctx.db.insert("users", {
        name: "Noa", username: "noa", role: "scholar", institutionId,
      });
      // On an assignment roster, but not in this channel's group: never named.
      const otherInstitution = await ctx.db.insert("institutions", {
        name: "Kestrel Academy", slug: "kestrel", kind: "school",
      });
      const outsider = await ctx.db.insert("users", {
        name: "Outsider", username: "outsider", role: "scholar",
        institutionId: otherInstitution,
      });
      await ctx.db.patch(groupId, { scholarIds: [kaiId, mia, noa] });

      const unitId = await ctx.db.insert("units", {
        teacherId, title: "Ocean Stories", isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId, title: "Reading at home", order: 0,
      });
      const offline = (title: string, readable = true) =>
        ctx.db.insert("activities", {
          title, kind: "offline", order: 0, lessonId,
          ...(readable ? { scholarDescription: "Do this at home." } : {}),
        });
      const readAloud = await offline("Read-aloud");
      const tideChart = await offline("Tide Chart");
      const undated = await offline("Undated Journal");
      const notYetDue = await offline("Due Tomorrow");
      const dueEarlierToday = await offline("Due Earlier Today");
      const ended = await offline("Ended Homework");
      const archivedAct = await offline("Archived Homework");
      // The Home hides offline homework with nothing to read at home …
      const unreadable = await offline("Unreadable Homework", false);
      // … and share-backs, which the teacher runs in the room.
      const shareBack = await ctx.db.insert("activities", {
        title: "Share Back", kind: "shareBack", order: 0, lessonId,
      });
      const liveAt = Date.now() - 10 * DAY;
      const cohort = await ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [kaiId, mia, noa, outsider],
        startedAt: liveAt,
        activitySchedule: [
          { activityId: readAloud, mode: "homework", setAt: liveAt, dueAt: Date.now() - 5 * DAY },
          // Targeted at Noa alone → only Noa can be incomplete.
          { activityId: tideChart, mode: "homework", setAt: liveAt, dueAt: Date.now() - 2 * DAY, scholarIds: [noa] },
          // Undated homework is open-ended by design → never asked about.
          { activityId: undated, mode: "homework", setAt: liveAt },
          { activityId: notYetDue, mode: "homework", setAt: liveAt, dueAt: Date.now() + DAY },
          // The Home's chip still says "due today" → not past due yet.
          { activityId: dueEarlierToday, mode: "homework", setAt: liveAt, dueAt: Date.now() - 3_600_000 },
          // Ended → already gone from Home.
          { activityId: ended, mode: "homework", setAt: liveAt, dueAt: Date.now() - 3 * DAY, endsAt: Date.now() - DAY },
          { activityId: unreadable, mode: "homework", setAt: liveAt, dueAt: Date.now() - 3 * DAY },
          { activityId: shareBack, mode: "homework", setAt: liveAt, dueAt: Date.now() - 3 * DAY },
        ],
      });
      // Lesson-less ONLINE ad-hoc homework: the group mark-done path refuses
      // it, so asking would promise an action the aide cannot take.
      const onlineCopy = await ctx.db.insert("activities", {
        title: "Online Copy", kind: "online", order: 0, systemPrompt: "Explore.",
      });
      await ctx.db.insert("assignments", {
        teacherId,
        kind: "adHocDispatch",
        scholarIds: [noa],
        startedAt: liveAt,
        activitySchedule: [
          { activityId: onlineCopy, mode: "homework", setAt: liveAt, dueAt: Date.now() - 6 * DAY },
        ],
      });
      await ctx.db.insert("assignments", {
        teacherId,
        scholarIds: [kaiId],
        startedAt: liveAt,
        archivedAt: Date.now() - DAY,
        activitySchedule: [
          { activityId: archivedAct, mode: "homework", setAt: liveAt, dueAt: Date.now() - 4 * DAY },
        ],
      });
      // Kai finished the read-aloud under THIS assignment; Mia's completion is
      // under a different run, so it does not close her copy here.
      await ctx.db.insert("activityCompletions", {
        scholarId: kaiId, activityId: readAloud, assignmentId: cohort,
        completedAt: Date.now() - 6 * DAY,
      });
      const otherRun = await ctx.db.insert("assignments", {
        teacherId, scholarIds: [mia], startedAt: liveAt, archivedAt: liveAt,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: mia, activityId: readAloud, assignmentId: otherRun,
        completedAt: Date.now() - 6 * DAY,
      });

      // The same web homework sent as one-scholar ad-hoc copies.
      const copies: Record<string, Id<"assignments">> = {};
      for (const [name, scholar, daysAgo] of [
        ["Kai", kaiId, 3],
        ["Mia", mia, 4],
      ] as const) {
        const activityId = await ctx.db.insert("activities", {
          title: "Bird Count Video", kind: "web", order: 0,
          webUrl: "https://example.test/birds",
        });
        copies[name] = await ctx.db.insert("assignments", {
          teacherId,
          kind: "adHocDispatch",
          scholarIds: [scholar],
          startedAt: liveAt,
          activitySchedule: [
            { activityId, mode: "homework", setAt: liveAt, dueAt: Date.now() - daysAgo * DAY },
          ],
        });
      }
      return { cohort, copies };
    });

    const collected = await t.run(async (ctx) =>
      ctx.runQuery(internal.eodCheckin.collectChannelDay, {
        groupIds: [groupId],
        dayStartMs: checkinDayStartMs(Date.now()),
        nowMs: Date.now(),
      }),
    );
    const byTitle = new Map(
      collected.overdueHomework.map((row) => [row.activityTitle, row]),
    );
    expect(collected.overdueHomework.map((row) => row.activityTitle)).toEqual([
      "Read-aloud", // 5 days
      "Bird Count Video", // 4 days (oldest copy)
      "Tide Chart", // 2 days
    ]);
    const urlFor = (id: Id<"assignments">) =>
      expect.stringContaining(`/teacher/schedule/${id}`);
    expect(byTitle.get("Read-aloud")).toMatchObject({
      earliestDueAt: Date.now() - 5 * DAY,
      duePhrase: expect.stringMatching(/^was due /),
      teacherName: "Test Teacher",
      incompleteScholars: [
        { name: "Mia", assignmentUrl: urlFor(ids.cohort) },
        { name: "Noa", assignmentUrl: urlFor(ids.cohort) },
      ],
    });
    expect(byTitle.get("Tide Chart")?.incompleteScholars.map((s) => s.name))
      .toEqual(["Noa"]);
    expect(byTitle.get("Bird Count Video")).toMatchObject({
      earliestDueAt: Date.now() - 4 * DAY,
      incompleteScholars: [
        { name: "Kai", assignmentUrl: urlFor(ids.copies.Kai) },
        { name: "Mia", assignmentUrl: urlFor(ids.copies.Mia) },
      ],
    });
    expect(JSON.stringify(collected.overdueHomework)).not.toContain("Outsider");
  });

  test("a quiet day with only past-due homework still posts the question with its link", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId } = await seedLinkedGroup(t);
    const assignmentId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", { teacherId, title: "Stories", isActive: true });
      const lessonId = await ctx.db.insert("lessons", {
        unitId, title: "At home", order: 0,
      });
      const activityId = await ctx.db.insert("activities", {
        title: "Read-aloud", kind: "offline", order: 0, lessonId,
        scholarDescription: "Read the story aloud at home.",
      });
      return ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: Date.now() - 10 * 86_400_000,
        activitySchedule: [
          {
            activityId,
            mode: "homework",
            setAt: Date.now() - 10 * 86_400_000,
            dueAt: Date.now() - 5 * 86_400_000,
          },
        ],
      });
    });

    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const slack = stubSlackPosts();
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 1,
        skippedChannels: 0,
      });
      const reply = String(slack.posts[1].markdown_text);
      const questions = reply.slice(reply.indexOf("Questions for you"));
      expect(questions).toContain(`/teacher/schedule/${assignmentId}|Read-aloud>`);
      expect(questions).toContain("Kai");
      // Asked in the questions, never narrated in the wrap-up above them.
      expect(reply.slice(0, reply.indexOf("Questions for you"))).not.toContain(
        "Read-aloud",
      );
    } finally {
      slack.restore();
    }
  });

  test("skips weekends without claiming a day", async () => {
    vi.setSystemTime(SATURDAY);
    const t = convexTest(schema, modules);
    await seedLinkedGroup(t, { withCompletion: true });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Slack should not be called");
    }) as typeof fetch;
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 0,
        skippedChannels: 0,
      });
      const checkins = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").collect(),
      );
      expect(checkins).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("claims but does not post on a zero-activity day", async () => {
    const t = convexTest(schema, modules);
    await seedLinkedGroup(t);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Slack should not be called");
    }) as typeof fetch;
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 0,
        skippedChannels: 1,
      });
      const checkins = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").collect(),
      );
      expect(checkins).toHaveLength(1);
      expect(checkins[0].threadTs).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("does nothing when no groups have linked channels", async () => {
    const t = convexTest(schema, modules);
    await seedLinkedGroup(t, { linked: false, withCompletion: true });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";

    expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
      postedChannels: 0,
      skippedChannels: 0,
    });
    const checkins = await t.run(async (ctx) =>
      ctx.db.query("eodCheckins").collect(),
    );
    expect(checkins).toHaveLength(0);
  });

  test("does nothing without a Slack bot token", async () => {
    const t = convexTest(schema, modules);
    await seedLinkedGroup(t, { withCompletion: true });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Slack should not be called");
    }) as typeof fetch;
    try {
      expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
        postedChannels: 0,
        skippedChannels: 0,
      });
      const checkins = await t.run(async (ctx) =>
        ctx.db.query("eodCheckins").collect(),
      );
      expect(checkins).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
