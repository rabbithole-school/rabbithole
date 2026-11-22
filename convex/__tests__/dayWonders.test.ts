// The day's wonders (TRA-680): after the end-of-day check-in, one Slack
// message per wonder in each linked class's channel, each its own thread
// mapped to that kid and that wonder. Pins what goes out and what stays out
// (a flagged kid, an unanswered wonder, another school's kid, a mixed-school
// channel, an empty window, an unlinked class), the window since the class's
// last run, exactly once per wonder across a re-run and retries, and that a
// plain reply in a wonder's thread reaches that wonder's conversation through
// 4a's relay. Every person here is made up.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { threadFlavor } from "../lib/scholarThreadAccess";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestConvex = () => convexTest(schema, modules);
type T = ReturnType<typeof _makeTestConvex>;

const CHANNEL = "C_SEALS";
// Monday 1:00 PM in Honolulu, so the whole test sits inside one school day.
const MONDAY_1PM_HST = Date.parse("2026-07-27T23:00:00.000Z");
const MINUTE = 60_000;
const TEACHER_NOTE = "Teacher-only: watch her focus";
const ALERT_BODY = "Possible disclosure, check in today";

const originalFetch = globalThis.fetch;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY_1PM_HST);
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
});
afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  delete process.env.SLACK_BOT_TOKEN;
});

type Posted = {
  ts: string;
  channel: string;
  threadTs?: string;
  text: string;
  blocks?: unknown[];
  metadata?: { event_type: string; event_payload: { delivery_id: string } };
};

/**
 * A Slack that remembers what was posted: history returns the channel's
 * roots, replies a thread's messages, both with their delivery metadata, as
 * the real API does with include_all_metadata. `failPostNumber` makes the
 * nth chat.postMessage fail; `losePostNumber` makes Slack take the nth but
 * lose its answer. `afterPost` runs after each accepted post and
 * `duringHistory` while a history scan runs, to change the world
 * mid-delivery.
 */
function fakeSlack(
  opts: {
    failPostNumber?: number;
    losePostNumber?: number;
    afterPost?: (n: number) => Promise<void>;
    duringHistory?: () => Promise<void>;
    /** Slack reports the channel as shared with another organization. */
    extShared?: boolean;
  } = {},
) {
  const posted: Posted[] = [];
  const methods: string[] = [];
  let postCount = 0;
  let nextTs = 1000;
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split("/").pop() ?? "";
    methods.push(method);
    const raw = String(init?.body ?? "");
    const body = raw.startsWith("{")
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(raw));
    const asMessage = (p: Posted) => ({
      ts: p.ts,
      bot_id: "B_BOT",
      text: p.text,
      ...(p.threadTs ? { thread_ts: p.threadTs } : {}),
      ...(p.metadata ? { metadata: p.metadata } : {}),
    });
    if (method === "chat.postMessage") {
      postCount += 1;
      if (postCount === opts.failPostNumber) {
        return Response.json({ ok: false, error: "ratelimited" });
      }
      const metadata =
        typeof body.metadata === "string" ? JSON.parse(body.metadata) : body.metadata;
      const blocks = typeof body.blocks === "string" ? JSON.parse(body.blocks) : body.blocks;
      const message: Posted = {
        ts: `${(nextTs += 1)}.0001`,
        channel: String(body.channel),
        ...(body.thread_ts ? { threadTs: String(body.thread_ts) } : {}),
        text: String(body.text ?? body.markdown_text ?? ""),
        ...(blocks ? { blocks } : {}),
        ...(metadata ? { metadata } : {}),
      };
      posted.push(message);
      if (postCount === opts.losePostNumber) {
        return Response.json({ ok: false, error: "internal_error" });
      }
      await opts.afterPost?.(postCount);
      return Response.json({ ok: true, ts: message.ts, channel: message.channel });
    }
    if (method === "conversations.history") {
      await opts.duringHistory?.();
      return Response.json({
        ok: true,
        messages: posted
          .filter((p) => p.channel === body.channel && !p.threadTs)
          .map(asMessage),
      });
    }
    if (method === "conversations.replies") {
      return Response.json({
        ok: true,
        messages: posted
          .filter(
            (p) =>
              p.channel === body.channel && (p.ts === body.ts || p.threadTs === body.ts),
          )
          .map(asMessage),
      });
    }
    if (method === "auth.test") {
      return Response.json({ ok: true, user_id: "B_BOT", bot_id: "BBOT", team_id: "T1" });
    }
    if (method === "conversations.info") {
      return Response.json({
        ok: true,
        channel: { id: body.channel, is_private: true, is_ext_shared: opts.extShared === true },
      });
    }
    return Response.json({ ok: true });
  }) as typeof fetch;
  return { posted, methods };
}

/** Each posted message's first line, e.g. "*Quinn asked:* Why …?". */
const firstLines = (posted: Posted[]) => posted.map((p) => p.text.split("\n")[0]);

async function insertWonder(
  t: T,
  scholarId: Id<"users">,
  question: string,
  reply: string | null,
  extra: { session?: Partial<Doc<"sessions">> } = {},
) {
  const ids = await t.run(async (ctx) => {
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      origin: "wonder",
      status: "active",
      suggestionType: "frontier",
      topic: question,
      rationale: TEACHER_NOTE,
    });
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      title: question,
      isArchived: false,
      lastMessageAt: Date.now(),
      seedId,
      ...extra.session,
    });
    await ctx.db.insert("messages", {
      sessionId,
      role: "user",
      content: question,
      flagged: false,
    });
    if (reply !== null) {
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: reply,
        flagged: false,
      });
    }
    return { seedId, sessionId };
  });
  // Each wonder a minute after the last, so their order is unambiguous.
  vi.advanceTimersByTime(MINUTE);
  return ids;
}

/**
 * Moli (Honolulu) runs the Seals, linked to #seals, and the Otters, linked to
 * nothing. Seals: Quinn, Remy and Ivy at Moli, plus Kai, who is enrolled at
 * Kona. A Moli teacher has a Slack account.
 */
async function seedWorld(t: T) {
  return await t.run(async (ctx) => {
    const moli = await ctx.db.insert("institutions", {
      name: "Moli",
      slug: "moli-wonders",
      kind: "school",
      isPrimary: true,
      timeZone: "Pacific/Honolulu",
    });
    const kona = await ctx.db.insert("institutions", {
      name: "Kona",
      slug: "kona-wonders",
      kind: "school",
      timeZone: "Pacific/Honolulu",
    });
    const scholar = async (name: string, institutionId: Id<"institutions">) =>
      await ctx.db.insert("users", {
        username: name.toLowerCase().replace(/\s+/g, "-"),
        name,
        role: "scholar",
        institutionId,
      });
    const quinn = await scholar("Quinn Test", moli);
    const remy = await scholar("Remy Test", moli);
    const ivy = await scholar("Ivy Test", moli);
    const kai = await scholar("Kai Test", kona);
    const ana = await scholar("Ana Test", moli);
    const teacher = await ctx.db.insert("users", {
      username: "rivera",
      name: "Ms. Rivera",
      role: "teacher",
      slackUserId: "U_TEACH",
    });
    await ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId: moli });
    const seals = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId: moli,
      name: "Seals",
      scholarIds: [quinn, remy, ivy, kai],
      slackChannelId: CHANNEL,
    });
    const otters = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId: moli,
      name: "Otters",
      scholarIds: [ana],
    });
    return { moli, kona, quinn, remy, ivy, kai, ana, teacher, seals, otters };
  });
}

/** Run what is scheduled to start now, and wait for it. Only timers already
 *  due fire, so an attempt's follow-up (due when its lease runs out) waits
 *  for `leaseRunsOut`, never racing the attempt that scheduled it. */
async function runScheduledNow(t: T) {
  vi.advanceTimersByTime(0);
  await t.finishInProgressScheduledFunctions();
}

/** Run the day's pass and the deliveries it starts. */
async function runDay(t: T) {
  const result = await t.action(internal.dayWonders.postForDay, {});
  await runScheduledNow(t);
  return result;
}

/** Let an attempt's lease run out, which fires its follow-up attempt. */
async function leaseRunsOut(t: T) {
  vi.advanceTimersByTime(11 * MINUTE);
  await t.finishInProgressScheduledFunctions();
}

async function notes(t: T) {
  return await t.run(async (ctx) => ctx.db.query("dayWonderNotes").collect());
}

async function mappings(t: T) {
  return await t.run(async (ctx) => ctx.db.query("aboutSlackThreads").collect());
}

async function welfareAlert(
  t: T,
  scholarId: Id<"users">,
  sessionId: Id<"sessions">,
  kind = "welfare",
  createdAt = Date.now(),
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("alerts", {
      kind,
      severity: "warning",
      title: "A note for staff",
      body: ALERT_BODY,
      source: "observer",
      scholarId,
      sessionId,
      status: "open",
      createdAt,
    });
  });
}

describe("the day's wonders", { timeout: 60_000 }, () => {
  test("one message per wonder, each its own thread mapped to that wonder", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const owls = await insertWonder(
      t,
      w.quinn,
      "Why can owls turn their heads so far?",
      "Owls have **14 neck bones**, twice as many as you.",
    );
    const sky = await insertWonder(
      t,
      w.quinn,
      "Why is the sky blue?",
      "Air scatters blue light more than red.",
    );
    const primes = await insertWonder(
      t,
      w.remy,
      "Is there a biggest prime number?",
      "No. Euclid showed that any list of primes always misses one.",
    );
    // Asked, but Rabbithole hasn't answered: left out.
    await insertWonder(t, w.remy, "What is the loudest animal?", null);
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack();

    expect(await runDay(t)).toEqual({ claimed: 1 });

    expect(slack.posted.every((p) => p.channel === CHANNEL && !p.threadTs)).toBe(true);
    expect(slack.posted.map((p) => p.text)).toEqual([
      "*Quinn asked:* Why can owls turn their heads so far?\n" +
        "*Rabbithole said:* Owls have 14 neck bones, twice as many as you.\n" +
        "Reply in this thread to write back to Quinn.",
      "*Quinn asked:* Why is the sky blue?\n" +
        "*Rabbithole said:* Air scatters blue light more than red.\n" +
        "Reply in this thread to write back to Quinn.",
      "*Remy asked:* Is there a biggest prime number?\n" +
        "*Rabbithole said:* No. Euclid showed that any list of primes always misses one.\n" +
        "Reply in this thread to write back to Remy.",
    ]);
    // The how-to-reply line is the small grey context block.
    expect(slack.posted[0].blocks).toEqual([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "*Quinn asked:* Why can owls turn their heads so far?\n" +
            "*Rabbithole said:* Owls have 14 neck bones, twice as many as you.",
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "Reply in this thread to write back to Quinn." }],
      },
    ]);
    // A seed's rationale never reaches Slack.
    expect(slack.posted.some((p) => p.text.includes(TEACHER_NOTE))).toBe(false);

    // Each message's thread is mapped to its own kid and wonder, and only that.
    const rows = await mappings(t);
    expect(
      rows
        .map((row) => ({ threadTs: row.threadTs, scholarId: row.scholarId, about: row.about }))
        .sort((a, b) => a.threadTs.localeCompare(b.threadTs)),
    ).toEqual([
      { threadTs: slack.posted[0].ts, scholarId: w.quinn, about: { type: "wonder", seedId: owls.seedId } },
      { threadTs: slack.posted[1].ts, scholarId: w.quinn, about: { type: "wonder", seedId: sky.seedId } },
      { threadTs: slack.posted[2].ts, scholarId: w.remy, about: { type: "wonder", seedId: primes.seedId } },
    ]);
    expect((await notes(t)).map((note) => note.state)).toEqual(["posted"]);
  });

  test("a plain reply in each wonder's thread lands in that wonder's conversation", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const owls = await insertWonder(t, w.quinn, "Why can owls turn their heads so far?", "14 neck bones.");
    const sky = await insertWonder(t, w.quinn, "Why is the sky blue?", "Air scatters blue.");
    const primes = await insertWonder(t, w.remy, "Is there a biggest prime?", "No.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack();
    await runDay(t);
    const [owlsRoot, skyRoot] = slack.posted;

    // The relay, as 4a tests it: plain thread replies from the teacher, with
    // no name at the start.
    vi.useRealTimers();
    const reply = async (eventId: string, threadTs: string, text: string, ts: string) =>
      await t.action(internal.slackBot.handleEvent, {
        payload: {
          team_id: "T1",
          event_id: eventId,
          authorizations: [{ user_id: "B_BOT", is_bot: true }],
          event: {
            type: "message",
            user: "U_TEACH",
            text,
            channel: CHANNEL,
            channel_type: "channel",
            ts,
            thread_ts: threadTs,
          },
        },
      });
    await reply("EvOwls", owlsRoot.ts, "Count the bones in your own neck tonight.", "5000.0001");
    await reply("EvSky", skyRoot.ts, "Look at the sky at sunset too.", "5000.0002");

    const staffMessages = async (scholarId: Id<"users">, seedId: Id<"seeds">) =>
      await t.run(async (ctx) => {
        const thread = (
          await ctx.db
            .query("parentThreads")
            .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
            .collect()
        ).find(
          (x) => threadFlavor(x) === "about" && x.about?.type === "wonder" && x.about.seedId === seedId,
        );
        if (!thread) return null;
        return (
          await ctx.db
            .query("parentMessages")
            .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
            .collect()
        )
          .filter((m) => m.authorType === "teacher")
          .map((m) => m.body);
      });
    expect(await staffMessages(w.quinn, owls.seedId)).toEqual([
      "Count the bones in your own neck tonight.",
    ]);
    expect(await staffMessages(w.quinn, sky.seedId)).toEqual(["Look at the sky at sunset too."]);
    expect(await staffMessages(w.remy, primes.seedId)).toBeNull();
  });

  test("a welfare alert keeps all of that kid's wonders out, and an archived chat stays out", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.ivy, "How do bees make honey?", "They dry nectar.");
    const shout = await insertWonder(t, w.ivy, "Why do people shout?", "Sometimes when upset.");
    await welfareAlert(t, w.ivy, shout.sessionId);
    await insertWonder(t, w.remy, "What is a black hole?", "A place gravity wins.", {
      session: { teacherArchivedAt: Date.now() },
    });
    const purr = await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack();

    await runDay(t);

    expect(firstLines(slack.posted)).toEqual(["*Quinn asked:* Why do cats purr?"]);
    expect(slack.posted.some((p) => p.text.includes(ALERT_BODY))).toBe(false);
    expect((await mappings(t)).map((row) => [row.scholarId, row.about])).toEqual([
      [w.quinn, { type: "wonder", seedId: purr.seedId }],
    ]);
  });

  test("a kid whose second flagged chat was deduped into an earlier connection note is skipped entirely", async () => {
    // Ivy's chats are Monday 9 am; the run is Monday 1:05 pm, so the window
    // opens Friday 1:05 pm. Her connection note on an older chat is from
    // Friday noon: before the window, and 69 hours before today's chats, so
    // inside the observer's 72-hour dedup and they got no alert of their own.
    vi.setSystemTime(Date.parse("2026-07-27T19:00:00Z")); // Mon 9 am HST
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const olderChat = await t.run(async (ctx) =>
      ctx.db.insert("sessions", { userId: w.ivy, title: "An older chat", isArchived: false }),
    );
    await welfareAlert(
      t,
      w.ivy,
      olderChat,
      "parasocial_reliance",
      Date.parse("2026-07-24T22:00:00Z"), // Fri noon HST
    );
    await insertWonder(t, w.ivy, "Are you my friend?", "I'm a tutor, and your teacher is near.");
    await insertWonder(t, w.ivy, "How do bees make honey?", "They dry nectar.");
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    vi.setSystemTime(Date.parse("2026-07-27T23:05:00Z")); // Mon 1:05 pm
    const slack = fakeSlack();

    await runDay(t);

    expect(firstLines(slack.posted)).toEqual(["*Quinn asked:* Why do cats purr?"]);
    expect((await mappings(t)).map((row) => row.scholarId)).toEqual([w.quinn]);
  });

  test("another school's kid on the roster stays out", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.kai, "Why do volcanoes erupt?", "Pressure builds below.");
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack();

    await runDay(t);

    expect(firstLines(slack.posted)).toEqual(["*Quinn asked:* Why do cats purr?"]);
    expect((await mappings(t)).map((row) => row.scholarId)).toEqual([w.quinn]);
  });

  test("a channel shared with another school's class gets nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("scholarGroups", {
        teacherId: w.teacher,
        institutionId: w.kona,
        name: "Turtles",
        scholarIds: [w.kai],
        slackChannelId: CHANNEL,
      });
    });
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    await insertWonder(t, w.kai, "Why do volcanoes erupt?", "Pressure builds below.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack();

    expect(await runDay(t)).toEqual({ claimed: 0 });

    expect(slack.methods).toEqual([]);
    expect(await notes(t)).toEqual([]);
  });

  test("a channel shared with another organization gets nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack({ extShared: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await runDay(t)).toEqual({ claimed: 1 });

    expect(slack.posted).toEqual([]);
    expect(await mappings(t)).toEqual([]);
    expect((await notes(t)).map((n) => n.state)).toEqual(["failed"]);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/shared with another organization/);
    warn.mockRestore();
  });

  test("a kid taken off the class between posts is skipped", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    await insertWonder(t, w.remy, "Is there a biggest prime?", "No.");
    vi.advanceTimersByTime(MINUTE);
    // Remy leaves the Seals after Quinn's message posts, before his own.
    const slack = fakeSlack({
      afterPost: async (n) => {
        if (n !== 1) return;
        await t.run(async (ctx) => {
          await ctx.db.patch(w.seals, { scholarIds: [w.quinn, w.ivy, w.kai] });
        });
      },
    });

    await runDay(t);

    expect(firstLines(slack.posted)).toEqual(["*Quinn asked:* Why do cats purr?"]);
    expect((await mappings(t)).map((row) => row.scholarId)).toEqual([w.quinn]);
    expect(await notes(t)).toMatchObject([{ state: "posted" }]);
  });

  test("a class unlinked while the channel history is read posts nothing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack({
      duringHistory: async () => {
        await t.run(async (ctx) => ctx.db.patch(w.seals, { slackChannelId: undefined }));
      },
    });

    await runDay(t);

    expect(slack.posted).toEqual([]);
    expect(await mappings(t)).toEqual([]);
    expect(await notes(t)).toMatchObject([{ state: "failed" }]);
  });

  test("two kids with one first name go under their full names", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const noahs = await t.run(async (ctx) => {
      const ids: Id<"users">[] = [];
      for (const name of ["Noah Kim", "Noah Lee"]) {
        ids.push(
          await ctx.db.insert("users", {
            username: name.toLowerCase().replace(" ", "-"),
            name,
            role: "scholar",
            institutionId: w.moli,
          }),
        );
      }
      const seals = (await ctx.db.get(w.seals))!;
      await ctx.db.patch(w.seals, { scholarIds: [...seals.scholarIds, ...ids] });
      return ids;
    });
    await insertWonder(t, noahs[0], "Why do bats hang upside down?", "It saves them effort.");
    await insertWonder(t, noahs[1], "Why do leaves change color?", "The green fades first.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack();

    await runDay(t);

    expect(slack.posted.map((p) => p.text.split(":*")[0])).toEqual([
      "*Noah Kim asked",
      "*Noah Lee asked",
    ]);
    expect(slack.posted[0].text).toContain("write back to Noah Kim.");
  });

  test("a class with nothing since the previous school day's run, and one with no channel, get nothing", async () => {
    // A Thursday wonder for the Seals, from before Friday's run, and today's
    // for the unlinked Otters. With no earlier run, Monday's run reaches
    // back to Friday's only. The world is made on Thursday too: a row can't
    // be created before an earlier one.
    vi.setSystemTime(MONDAY_1PM_HST - 4 * 24 * 60 * MINUTE);
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why is ice slippery?", "A thin wet layer.");
    vi.setSystemTime(MONDAY_1PM_HST);
    await insertWonder(t, w.ana, "Why do onions make you cry?", "They release a gas.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack();

    expect(await runDay(t)).toEqual({ claimed: 0 });

    expect(slack.methods).toEqual([]);
    expect(await notes(t)).toEqual([]);
    expect(await mappings(t)).toEqual([]);
  });

  test("an evening wonder goes out in the next school day's run, and nothing goes out twice", async () => {
    vi.setSystemTime(Date.parse("2026-07-27T19:00:00Z")); // Mon 9 am HST
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do owls hoot?", "To talk to other owls.");
    const slack = fakeSlack();
    vi.setSystemTime(Date.parse("2026-07-28T00:05:00Z")); // Mon 2:05 pm
    await runDay(t);
    vi.setSystemTime(Date.parse("2026-07-28T05:00:00Z")); // Mon 7 pm, at home
    await insertWonder(t, w.quinn, "Why is the moon pale?", "It reflects sunlight.");
    vi.setSystemTime(Date.parse("2026-07-28T20:00:00Z")); // Tue 10 am
    await insertWonder(t, w.remy, "Why do magnets stick?", "Moving charges line up.");
    vi.setSystemTime(Date.parse("2026-07-29T00:05:00Z")); // Tue 2:05 pm
    await runDay(t);

    expect(firstLines(slack.posted)).toEqual([
      "*Quinn asked:* Why do owls hoot?",
      "*Quinn asked:* Why is the moon pale?",
      "*Remy asked:* Why do magnets stick?",
    ]);
    const [monday, tuesday] = (await notes(t)).sort((a, b) => a.cutoffMs - b.cutoffMs);
    expect(monday.wonders).toHaveLength(1);
    expect(tuesday.wonders).toHaveLength(2);
    expect(tuesday.windowStartMs).toBe(monday.cutoffMs);
  });

  test("Monday's run covers the weekend", async () => {
    vi.setSystemTime(Date.parse("2026-07-24T19:00:00Z")); // Fri 9 am HST
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do owls hoot?", "To talk to other owls.");
    const slack = fakeSlack();
    vi.setSystemTime(Date.parse("2026-07-25T00:05:00Z")); // Fri 2:05 pm
    await runDay(t);
    vi.setSystemTime(Date.parse("2026-07-25T04:00:00Z")); // Fri 6 pm
    await insertWonder(t, w.quinn, "Why is the moon pale?", "It reflects sunlight.");
    vi.setSystemTime(Date.parse("2026-07-25T21:00:00Z")); // Sat 11 am
    await insertWonder(t, w.remy, "Why do cats purr?", "Nobody is quite sure.");
    vi.setSystemTime(Date.parse("2026-07-27T02:00:00Z")); // Sun 4 pm
    await insertWonder(t, w.ivy, "Why do waves break?", "The bottom slows them.");
    const fridayPosts = slack.posted.length;
    vi.setSystemTime(Date.parse("2026-07-28T00:05:00Z")); // Mon 2:05 pm
    await runDay(t);

    expect(fridayPosts).toBe(1);
    expect(firstLines(slack.posted.slice(fridayPosts))).toEqual([
      "*Ivy asked:* Why do waves break?",
      "*Quinn asked:* Why is the moon pale?",
      "*Remy asked:* Why do cats purr?",
    ]);
  });

  test("after a long gap a run reaches back three school days, no further", async () => {
    vi.setSystemTime(Date.parse("2026-07-06T19:00:00Z"));
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // The Seals' last run was three weeks ago.
    await t.run(async (ctx) => {
      await ctx.db.insert("dayWonderNotes", {
        groupId: w.seals,
        dayKey: "2026-07-06",
        channelId: CHANNEL,
        institutionId: w.moli,
        windowStartMs: Date.parse("2026-07-03T00:05:00Z"),
        cutoffMs: Date.parse("2026-07-07T00:05:00Z"),
        wonders: [],
        state: "posted",
        attempts: 1,
      });
    });
    vi.setSystemTime(Date.parse("2026-07-21T22:00:00Z")); // Tue noon, before Wed's run
    await insertWonder(t, w.quinn, "Why do owls hoot?", "To talk to other owls.");
    vi.setSystemTime(Date.parse("2026-07-23T04:00:00Z")); // Wed 6 pm
    await insertWonder(t, w.quinn, "Why is the moon pale?", "It reflects sunlight.");
    const slack = fakeSlack();
    vi.setSystemTime(Date.parse("2026-07-28T00:05:00Z")); // Mon 2:05 pm
    await runDay(t);

    expect(firstLines(slack.posted)).toEqual(["*Quinn asked:* Why is the moon pale?"]);
  });

  test("a re-run, a failed post and a stray delivery never post a wonder twice", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why can owls turn their heads so far?", "14 neck bones.");
    await insertWonder(t, w.quinn, "Why is the sky blue?", "Air scatters blue.");
    await insertWonder(t, w.remy, "Is there a biggest prime?", "No.");
    vi.advanceTimersByTime(MINUTE);
    // Post 2, Quinn's second wonder, fails once. The retry when the first
    // attempt's lease runs out posts it and Remy's, and only those.
    const slack = fakeSlack({ failPostNumber: 2 });

    await runDay(t);
    expect(slack.posted).toHaveLength(1);
    expect(await notes(t)).toMatchObject([{ state: "pending", attempts: 1 }]);
    await leaseRunsOut(t);
    // A re-run the same day finds the class already claimed, and a stray
    // delivery finds the run done.
    await runDay(t);
    const [note] = await notes(t);
    await t.action(internal.dayWonders.deliverNote, { noteId: note._id });
    await leaseRunsOut(t);

    expect(firstLines(slack.posted)).toEqual([
      "*Quinn asked:* Why can owls turn their heads so far?",
      "*Quinn asked:* Why is the sky blue?",
      "*Remy asked:* Is there a biggest prime?",
    ]);
    expect(await notes(t)).toMatchObject([{ state: "posted", attempts: 2 }]);
    expect(new Set((await mappings(t)).map((row) => row.threadTs)).size).toBe(3);
  });

  test("a failed post for a kid flagged before the retry leaves no mapping", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    const primes = await insertWonder(t, w.remy, "Is there a biggest prime?", "No.");
    vi.advanceTimersByTime(MINUTE);
    // Post 2, Remy's wonder, fails. A welfare alert lands before the retry.
    const slack = fakeSlack({ failPostNumber: 2 });

    await runDay(t);
    expect((await mappings(t)).map((row) => row.scholarId)).toEqual([w.quinn]);
    await welfareAlert(t, w.remy, primes.sessionId);
    await leaseRunsOut(t);

    expect(firstLines(slack.posted)).toEqual(["*Quinn asked:* Why do cats purr?"]);
    expect((await mappings(t)).map((row) => row.scholarId)).toEqual([w.quinn]);
    expect(await notes(t)).toMatchObject([{ state: "posted", attempts: 2 }]);
  });

  test("a post Slack took but whose answer was lost is mapped on the retry, not posted again", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack({ losePostNumber: 1 });

    await runDay(t);
    expect(await mappings(t)).toEqual([]);
    await leaseRunsOut(t);

    expect(slack.posted).toHaveLength(1);
    expect((await mappings(t)).map((row) => row.threadTs)).toEqual([slack.posted[0].ts]);
  });

  test("a wonder answered only after the run was claimed isn't added on a retry", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await insertWonder(t, w.quinn, "Why do cats purr?", "Nobody is quite sure.");
    // Asked before the run, answered only after it.
    const sky = await insertWonder(t, w.quinn, "Why is the sky blue?", null);
    vi.advanceTimersByTime(MINUTE);
    const slack = fakeSlack({ failPostNumber: 1 });

    await runDay(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        sessionId: sky.sessionId,
        role: "assistant",
        content: "Air scatters blue light more than red.",
        flagged: false,
      });
    });
    await leaseRunsOut(t);

    expect(firstLines(slack.posted)).toEqual(["*Quinn asked:* Why do cats purr?"]);
    expect(await mappings(t)).toHaveLength(1);
  });
});
