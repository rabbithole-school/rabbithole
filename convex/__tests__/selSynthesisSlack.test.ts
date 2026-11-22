import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  postThreadReplies,
  REPLY_SPACING_MS,
  type SelSlackMessage,
  type SelSlackScholar,
  selSynthesisSlackReplies,
  selSynthesisSlackSummary,
  selWeekEndingLabel,
} from "../selSynthesisSlack";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestInstance = ReturnType<typeof convexTest>;

const WEEK = "2026-10-22";
const WINDOW = {
  startMs: Date.parse("2026-10-23T01:00:00.000Z"),
  endMs: Date.parse("2026-10-30T01:00:00.000Z"),
};

const previousSlackToken = process.env.SLACK_BOT_TOKEN;
const realFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  if (previousSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = previousSlackToken;
});

type SlackPost = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: unknown[];
};

/** Stubs chat.postMessage; a top-level post gets ts "1.<n>", a reply "2.<n>". */
function stubSlackPosts() {
  const posts: SlackPost[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toContain("chat.postMessage");
    const body = JSON.parse(String(init?.body)) as SlackPost;
    posts.push({
      channel: body.channel,
      text: body.text,
      thread_ts: body.thread_ts,
      blocks: body.blocks,
    });
    return new Response(
      JSON.stringify({ ok: true, ts: body.thread_ts ? `2.${posts.length}` : `1.${posts.length}` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
  return posts;
}

async function seedSynthesis(
  t: TestInstance,
  scholarId: Id<"users">,
  institutionId: Id<"institutions">,
  over: { strengths?: string[]; watch?: string[]; quiet?: boolean } = {},
) {
  const claim = (text: string) => ({ text, cites: [] });
  await t.run((ctx) =>
    ctx.db.insert("selSyntheses", {
      scholarId,
      institutionId,
      weekKey: WEEK,
      strengths: (over.strengths ?? []).map(claim),
      watch: (over.watch ?? []).map(claim),
      quiet: over.quiet ?? false,
      window: WINDOW,
      model: "test-model",
      promptVersion: "test",
      generatedAt: Date.now(),
    }),
  );
}

/** One teacher's class groups in `institutionId`. */
async function seedGroups(
  t: TestInstance,
  institutionId: Id<"institutions">,
  groups: Array<{ name: string; scholarIds: Id<"users">[]; slackChannelId?: string }>,
) {
  await t.run(async (ctx) => {
    const teacherId = await ctx.db.insert("users", {
      name: "Sloane Kahale",
      username: "sloane",
      role: "teacher",
    });
    for (const group of groups) {
      await ctx.db.insert("scholarGroups", { teacherId, institutionId, ...group });
    }
  });
}

async function completeRun(t: TestInstance, institutionId: Id<"institutions">) {
  await t.mutation(internal.selSynthesisCron.claimRun, { institutionId, weekKey: WEEK });
  await t.mutation(internal.selSynthesisCron.settleRun, {
    institutionId,
    weekKey: WEEK,
    failedCount: 0,
  });
}

const HOKU: SelSlackScholar = {
  name: "Hoku Makani",
  url: "https://example.com/teacher/scholars/hoku",
  synthesis: {
    strengths: [
      { text: "Designed her own <tide pool> test." },
      { text: "Explained the &#39;why&#39; to a &quot;new&quot; partner &amp; listened." },
    ],
    watch: [{ text: "Left the reading job unfinished." }],
    quiet: false,
  },
};
const KAI: SelSlackScholar = {
  name: "Kai & Co",
  url: "https://example.com/teacher/scholars/kai",
  synthesis: { strengths: [], watch: [{ text: "Skipped clean-up twice." }], quiet: false },
};
const LEHUA: SelSlackScholar = {
  name: "Lehua Torres",
  url: "https://example.com/teacher/scholars/lehua",
  synthesis: { strengths: [], watch: [], quiet: true },
};

type RichNode = { type: string; text?: string; style?: unknown; elements?: RichNode[] };

describe("selSynthesisSlackSummary", () => {
  test("is a short overview naming who has strengths, watch items and a quiet week", () => {
    const { text, blocks } = selSynthesisSlackSummary({
      groupNames: ["Seals"],
      weekEndingLabel: "Thu, Oct 29",
      scholars: [HOKU, KAI, LEHUA],
    });
    expect(text.split("\n")).toEqual([
      ":seedling: *SEL write-ups — Seals · week ending Thu, Oct 29*",
      "3 scholars: 2 with write-ups, 1 quiet.",
      "*Strengths:* <https://example.com/teacher/scholars/hoku|Hoku Makani>",
      "*Watch:* <https://example.com/teacher/scholars/hoku|Hoku Makani>, <https://example.com/teacher/scholars/kai|Kai &amp; Co>",
      "*Quiet week:* <https://example.com/teacher/scholars/lehua|Lehua Torres>",
      "_Each write-up is in the thread, strengths first ↓_",
    ]);
    // The write-ups themselves live in the thread, not here.
    expect(text).not.toContain("tide pool");
    // The pointer to the thread is an aside: the grey context line. The
    // counts and names stay full size.
    expect(blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: text.split("\n").slice(0, 5).join("\n") },
      },
      {
        type: "context",
        block_id: "rh_grey_0",
        elements: [{ type: "mrkdwn", text: "_Each write-up is in the thread, strengths first ↓_" }],
      },
    ]);
  });

  test("an all-quiet week points at no thread", () => {
    const { text } = selSynthesisSlackSummary({
      groupNames: ["Seals"],
      weekEndingLabel: "Thu, Oct 29",
      scholars: [LEHUA],
    });
    expect(text).toContain("1 scholar, quiet this week.");
    expect(text).not.toContain("thread");
    expect(selSynthesisSlackReplies([LEHUA])).toEqual([]);
  });
});

describe("summary count line", () => {
  const quietOne = (name: string): SelSlackScholar => ({ ...LEHUA, name });
  const countLine = (scholars: SelSlackScholar[]) =>
    selSynthesisSlackSummary({ groupNames: ["Seals"], weekEndingLabel: "Thu", scholars }).text.split(
      "\n",
    )[1];

  test("reads naturally at the edges", () => {
    expect(countLine([HOKU, KAI, LEHUA])).toBe("3 scholars: 2 with write-ups, 1 quiet.");
    expect(countLine([HOKU, LEHUA, quietOne("Noa Kim")])).toBe(
      "3 scholars: 1 with a write-up, 2 quiet.",
    );
    expect(countLine([HOKU, KAI])).toBe("2 scholars, all with write-ups.");
    expect(countLine([HOKU])).toBe("1 scholar with a write-up.");
    expect(countLine([LEHUA, quietOne("Noa Kim")])).toBe("2 scholars, all quiet this week.");
    expect(countLine([LEHUA])).toBe("1 scholar, quiet this week.");
  });
});

describe("selSynthesisSlackReplies", () => {
  test("one reply per scholar with a write-up, as bold headings over bullet lists", () => {
    const replies = selSynthesisSlackReplies([HOKU, LEHUA, KAI]);
    expect(replies).toHaveLength(2);
    const [hoku, kai] = replies;

    const [block] = hoku.blocks as Array<{ type: string; elements: RichNode[] }>;
    expect(hoku.blocks).toHaveLength(1);
    expect(block.type).toBe("rich_text");
    expect(block.elements.map((e) => e.type)).toEqual([
      "rich_text_section",
      "rich_text_section",
      "rich_text_list",
      "rich_text_section",
      "rich_text_list",
    ]);
    expect(block.elements[0].elements?.[0]).toEqual({
      type: "link",
      url: HOKU.url,
      text: "Hoku Makani",
      style: { bold: true },
    });
    expect(block.elements[1].elements?.[0]).toMatchObject({
      text: "\nStrengths",
      style: { bold: true },
    });
    expect(block.elements[2]).toMatchObject({ style: "bullet" });
    const bullets = block.elements[2].elements?.map((item) => item.elements?.[0].text);
    // Rich text is literal: no Slack escaping, and HTML entities decoded once.
    expect(bullets).toEqual([
      "Designed her own <tide pool> test.",
      `Explained the 'why' to a "new" partner & listened.`,
    ]);
    expect(block.elements[3].elements?.[0]).toMatchObject({ text: "\nWatch" });

    // The mrkdwn fallback is escaped exactly once.
    expect(hoku.text.split("\n")).toEqual([
      "*<https://example.com/teacher/scholars/hoku|Hoku Makani>*",
      "*Strengths*",
      "• Designed her own &lt;tide pool&gt; test.",
      `• Explained the 'why' to a "new" partner &amp; listened.`,
      "*Watch*",
      "• Left the reading job unfinished.",
    ]);
    // Entities that would decode to an invalid character stay as written.
    const [odd] = selSynthesisSlackReplies([
      { ...KAI, synthesis: { ...KAI.synthesis, watch: [{ text: "x &#xD800; &#0; y" }] } },
    ]);
    expect(odd.text).toContain("x &amp;#xD800; &amp;#0; y");

    expect(JSON.stringify(replies)).not.toMatch(/&#\d+;|&quot;|&amp;amp;/);

    // A scholar with only watch items gets no Strengths heading.
    expect(kai.text).not.toContain("Strengths");
    expect(kai.text).toContain("*<https://example.com/teacher/scholars/kai|Kai &amp; Co>*");
  });
});

describe("selWeekEndingLabel", () => {
  test("labels the week by the meeting it closes at, in the school's clock", () => {
    expect(selWeekEndingLabel(WINDOW.endMs, "Pacific/Honolulu")).toBe("Thu, Oct 29");
  });
});

describe("postForWeek", () => {
  test("posts each linked channel its own institution's scholars, once, after completion", async () => {
    vi.useFakeTimers();
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const t = convexTest(schema, modules);
    const moli = await seedTestInstitution(t, { slug: "moli" });
    const other = await seedTestInstitution(t, { slug: "kaimana" });
    const hoku = await seedScholarInInstitution(t, { institutionId: moli, name: "Hoku Makani" });
    const lehua = await seedScholarInInstitution(t, { institutionId: moli, name: "Lehua Torres" });
    const visitor = await seedScholarInInstitution(t, { institutionId: other, name: "Avery Stone" });
    const unlinked = await seedScholarInInstitution(t, { institutionId: moli, name: "Kai Unlinked" });
    await seedSynthesis(t, hoku, moli, { strengths: ["Built a reef model."] });
    await seedSynthesis(t, lehua, moli, { quiet: true });
    await seedSynthesis(t, visitor, other, { strengths: ["Should never appear."] });
    await seedSynthesis(t, unlinked, moli, { strengths: ["No channel for this."] });
    await seedGroups(t, moli, [
      { name: "Seals", scholarIds: [lehua, hoku, visitor], slackChannelId: "C_SEALS" },
      { name: "Unlinked", scholarIds: [unlinked] },
    ]);
    const posts = stubSlackPosts();
    const args = { institutionId: moli, weekKey: WEEK, window: WINDOW };

    // Nothing goes out until the week's batch has completed.
    expect(await t.action(internal.selSynthesisSlack.postForWeek, args)).toEqual({ posted: 0 });
    expect(posts).toEqual([]);

    await completeRun(t, moli);
    expect(await t.action(internal.selSynthesisSlack.postForWeek, args)).toEqual({ posted: 1 });
    // The replies go out from their own scheduled action.
    expect(posts).toHaveLength(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // A summary, then Hoku's write-up threaded under it; quiet Lehua gets no reply.
    expect(posts.map((p) => [p.channel, p.thread_ts])).toEqual([
      ["C_SEALS", undefined],
      ["C_SEALS", "1.1"],
    ]);
    const [summary, reply] = posts;
    expect(summary.text).toContain("*Quiet week:*");
    expect(summary.text.indexOf("Hoku Makani")).toBeLessThan(summary.text.indexOf("Lehua Torres"));
    expect(summary.text).not.toContain("Built a reef model.");
    expect(reply.text).toContain("Built a reef model.");
    expect(reply.blocks).toHaveLength(1);
    const everything = JSON.stringify(posts);
    expect(everything).not.toContain("Avery Stone");
    expect(everything).not.toContain("Should never appear.");
    expect(everything).not.toContain("No channel for this.");

    // At-most-once: a later tick posts nothing.
    expect(await t.action(internal.selSynthesisSlack.postForWeek, args)).toEqual({ posted: 0 });
    expect(posts).toHaveLength(2);
  });
});

describe("postThreadReplies", () => {
  const replies: SelSlackMessage[] = ["a", "b", "c"].map((text) => ({ text }));
  const fakeClock = (rateLimitBudgetMs: number) => {
    const sleeps: number[] = [];
    return {
      sleeps,
      clock: {
        rateLimitBudgetMs,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    };
  };

  test("posts in order, spaced to Slack's per-channel pace", async () => {
    const sent: string[] = [];
    const { sleeps, clock } = fakeClock(10_000);
    const failed = await postThreadReplies(
      replies,
      async (reply) => {
        sent.push(reply.text);
        return { ok: true };
      },
      clock,
    );
    expect(failed).toBe(0);
    expect(sent).toEqual(["a", "b", "c"]);
    expect(sleeps).toEqual([REPLY_SPACING_MS, REPLY_SPACING_MS]);
  });

  test("keeps retrying a rate-limited reply after Retry-After while the budget lasts", async () => {
    const sent: string[] = [];
    let limited = 3;
    const { sleeps, clock } = fakeClock(10_000);
    const failed = await postThreadReplies(
      replies.slice(0, 2),
      async (reply) => {
        sent.push(reply.text);
        if (reply.text === "a" && limited-- > 0) {
          return { ok: false, error: "ratelimited", retryAfterMs: 2_000 };
        }
        return { ok: true };
      },
      clock,
    );
    expect(failed).toBe(0);
    expect(sent).toEqual(["a", "a", "a", "a", "b"]);
    expect(sleeps).toEqual([2_000, 2_000, 2_000, REPLY_SPACING_MS]);
    expect(clock.rateLimitBudgetMs).toBe(4_000);
  });

  test("gives up on a reply, and logs it, once the budget is spent", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { sleeps, clock } = fakeClock(5_000);
    const failed = await postThreadReplies(
      replies.slice(0, 2),
      async () => ({ ok: false, error: "ratelimited", retryAfterMs: 2_000 }),
      clock,
    );
    expect(failed).toBe(2);
    // Two waits fit the budget; the next reply gets one try and no retry.
    expect(sleeps).toEqual([2_000, 2_000, REPLY_SPACING_MS]);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});
