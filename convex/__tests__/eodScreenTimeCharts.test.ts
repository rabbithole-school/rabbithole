import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { instantForLocalMinutes } from "../../shared/institutionDay";
import { TEST_ACCOUNT_IDS } from "../lib/testAccounts";

const rasterized: string[] = [];
vi.mock("../lib/chartRaster", () => ({
  CHART_PIXEL_SCALE: 2,
  rasterizeChartSvg: vi.fn(async (svg: string) => {
    rasterized.push(svg);
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  }),
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HST = "Pacific/Honolulu";
// Fri 2026-11-06 and Thu 2026-11-05, midnight HST.
const FRIDAY_START = Date.parse("2026-11-06T10:00:00.000Z");
const THURSDAY_START = Date.parse("2026-11-05T10:00:00.000Z");
const previousSlackToken = process.env.SLACK_BOT_TOKEN;

beforeEach(() => {
  rasterized.length = 0;
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
});

afterEach(() => {
  vi.useRealTimers();
  if (previousSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = previousSlackToken;
});

async function setUp(t: ReturnType<typeof convexTest>, dayStartMs = FRIDAY_START) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Kestrel Academy",
      slug: "kestrel",
      kind: "school",
      timeZone: HST,
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Fictional Teacher",
      username: "fictional-teacher",
      role: "teacher",
    });
    const avaId = await ctx.db.insert("users", {
      name: "Ava Fictional",
      username: "ava-fictional",
      role: "scholar",
      institutionId,
    });
    const benId = await ctx.db.insert("users", {
      name: "Ben Fictional",
      username: "ben-fictional",
      role: "scholar",
      institutionId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Fireflies",
      scholarIds: [avaId, benId],
      slackChannelId: "CFICTIONAL",
    });
    // Ava on her BunnyPad Tuesday morning, 9:00 to 9:40.
    for (let minute = 9 * 60; minute <= 9 * 60 + 40; minute += 1) {
      const clientAt = instantForLocalMinutes("2026-11-03", minute, HST);
      await ctx.db.insert("deviceActivityEvents", {
        userId: avaId,
        institutionId,
        deviceId: "fixture-ipad",
        kind:
          minute === 9 * 60
            ? "app_foreground"
            : minute === 9 * 60 + 40
              ? "app_background"
              : "heartbeat",
        clientAt,
        receivedAt: clientAt,
        dayKey: "2026-11-03",
        context: "unknown",
      });
    }
    const checkinId = await ctx.db.insert("eodCheckins", {
      channelId: "CFICTIONAL",
      dateKey: "2026-11-06",
      groupIds: [groupId],
      dayStartMs,
      institutionId,
      lifecycle: "completed",
      threadTs: "100.1",
      postedAt: dayStartMs + 14 * 60 * 60 * 1000,
    });
    return { checkinId, benId };
  });
}

function stubSlack(replies: Array<Record<string, unknown>> = []) {
  const realFetch = globalThis.fetch;
  const posts: Array<Record<string, unknown>> = [];
  const completes: Array<Record<string, unknown>> = [];
  let nextFileId = 0;
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url);
    if (method.includes("conversations.replies")) {
      return json({ ok: true, messages: replies });
    }
    if (method.includes("files.getUploadURLExternal")) {
      nextFileId += 1;
      return json({
        ok: true,
        upload_url: `https://files.slack.test/upload/F${nextFileId}`,
        file_id: `F${nextFileId}`,
      });
    }
    if (method.startsWith("https://files.slack.test/upload/")) {
      return new Response("OK", { status: 200 });
    }
    if (method.includes("files.completeUploadExternal")) {
      completes.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return json({ ok: true });
    }
    expect(method).toContain("chat.postMessage");
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return json({ ok: true, ts: "200.1" });
  }) as typeof fetch;
  return { posts, completes, restore: () => (globalThis.fetch = realFetch) };
}

/** Run the action on a fake clock so its two-second upload wait costs nothing. */
async function runCharts(
  t: ReturnType<typeof convexTest>,
  checkinId: Id<"eodCheckins">,
) {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const run = t.action(internal.eodScreenTimeCharts.postCharts, {
    checkinId,
    channelId: "CFICTIONAL",
    roundupTs: "150.1",
  });
  let settled = false;
  void run.finally(() => (settled = true));
  while (!settled) {
    await vi.advanceTimersByTimeAsync(500);
  }
  return run;
}

describe("the roundup's charts", () => {
  test("post once in the roundup's thread, three images, test accounts left out", async () => {
    const t = convexTest(schema, modules);
    const { checkinId, benId } = await setUp(t);
    const testAccounts = TEST_ACCOUNT_IDS as Set<string>;
    testAccounts.add(benId);
    const slack = stubSlack();
    try {
      expect(await runCharts(t, checkinId)).toEqual({ posted: true, images: 3 });
      expect(rasterized).toHaveLength(3);
      expect(rasterized.join("")).toContain("Ava Fictional");
      expect(rasterized.join("")).not.toContain("Ben Fictional");
      // The third image is the week's activity bars (Both sides of the bell),
      // one bar per day of the week: Ava's 40 minutes on Tuesday.
      expect(rasterized[2]).toContain("Class average minutes by activity");
      expect(rasterized[2]).toMatch(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="#8a93a3"\/>/);
      // Uploaded privately, then shown by one message in the thread.
      expect(completes(slack)).toEqual([undefined, undefined, undefined]);
      expect(slack.posts).toHaveLength(1);
      expect(slack.posts[0]).toMatchObject({
        channel: "CFICTIONAL",
        thread_ts: "150.1",
        metadata: {
          event_type: "rabbithole_eod_checkin",
          event_payload: { delivery_id: `eod:${checkinId}:screenTimeCharts` },
        },
      });
      const blocks = slack.posts[0].blocks as Array<Record<string, unknown>>;
      expect(blocks.map((block) => block.type)).toEqual(["image", "image", "image"]);
      expect(blocks.map((block) => block.slack_file)).toEqual([
        { id: "F1" },
        { id: "F2" },
        { id: "F3" },
      ]);
    } finally {
      testAccounts.delete(benId);
      slack.restore();
    }
  });

  test("a rerun finds the charts already in the thread and posts nothing", async () => {
    const t = convexTest(schema, modules);
    const { checkinId } = await setUp(t);
    const slack = stubSlack([
      {
        ts: "151.1",
        thread_ts: "150.1",
        metadata: {
          event_type: "rabbithole_eod_checkin",
          event_payload: { delivery_id: `eod:${checkinId}:screenTimeCharts` },
        },
      },
    ]);
    try {
      expect(await runCharts(t, checkinId)).toEqual({
        posted: false,
        reason: "already posted",
      });
      expect(rasterized).toHaveLength(0);
      expect(slack.posts).toHaveLength(0);
    } finally {
      slack.restore();
    }
  });

  test("only a Friday check-in has a chart week", async () => {
    const t = convexTest(schema, modules);
    const { checkinId } = await setUp(t, THURSDAY_START);
    expect(
      await t.query(internal.eodCheckin.screenTimeChartWeek, { checkinId }),
    ).toBeNull();
    expect(
      await t.query(internal.eodCheckin.screenTimeChartDay, {
        checkinId,
        dayKey: "2026-11-03",
      }),
    ).toEqual([]);
  });

  test("a day outside the roundup's week reads nothing", async () => {
    const t = convexTest(schema, modules);
    const { checkinId } = await setUp(t);
    expect(
      await t.query(internal.eodCheckin.screenTimeChartDay, {
        checkinId,
        dayKey: "2026-10-27",
      }),
    ).toEqual([]);
    const tuesday = await t.query(internal.eodCheckin.screenTimeChartDay, {
      checkinId,
      dayKey: "2026-11-03",
    });
    expect(tuesday.find((row) => row.scholarName === "Ava Fictional")).toMatchObject({
      measuredMinutes: 40,
      schoolDay: true,
    });
  });
});

function completes(slack: ReturnType<typeof stubSlack>) {
  return slack.completes.map((body) => body.channel_id);
}
