import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

// The week's screen time is tens of thousands of heartbeat rows. A read that
// fails (or runs past Convex's limits) must cost the roundup, never the
// check-in itself.
vi.mock("../deviceActivity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../deviceActivity")>()),
  readScholarDayUsage: vi.fn(async () => {
    throw new Error("Too many documents read in a single function execution");
  }),
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Fri 2026-11-06, 2:05 PM HST.
const FRIDAY = Date.parse("2026-11-07T00:05:00.000Z");
const previousSlackToken = process.env.SLACK_BOT_TOKEN;
const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FRIDAY);
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  if (previousSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = previousSlackToken;
});

test("a Friday check-in posts without its roundup when screen time can't be read", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
      timeZone: "Pacific/Honolulu",
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Fictional Teacher",
      username: "fictional-teacher",
      role: "teacher",
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Kai",
      username: "kai",
      role: "scholar",
      institutionId,
    });
    await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Geckos",
      scholarIds: [scholarId],
      slackChannelId: "C123",
    });
    const activityId = await ctx.db.insert("activities", {
      title: "Fraction Lab",
      kind: "offline",
      order: 0,
    });
    await ctx.db.insert("activityCompletions", {
      scholarId,
      activityId,
      completedAt: FRIDAY - 60_000,
    });
  });

  const posts: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    if (method.includes("conversations.")) return json({ ok: true, messages: [] });
    expect(method).toContain("chat.postMessage");
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json({ ok: true, ts: `${posts.length}00.1` });
  }) as typeof fetch;

  expect(await t.action(internal.eodCheckin.runDaily, {})).toEqual({
    postedChannels: 1,
    skippedChannels: 0,
  });
  // The parent and the threaded wrap-up, and no roundup.
  expect(posts).toHaveLength(2);
  const checkin = await t.run((ctx) => ctx.db.query("eodCheckins").unique());
  expect(checkin).toMatchObject({ lifecycle: "completed" });
  expect(checkin?.weekScreenTimeText).toBeUndefined();
});
