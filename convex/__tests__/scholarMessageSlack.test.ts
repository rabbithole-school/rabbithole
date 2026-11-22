// Scholar ↔ teacher conversations copied to the staff Slack channel
// (convex/scholarMessageSlack.ts). Pins: both sides' messages are copied into
// ONE Slack thread per conversation; the relevant teachers (opener, staff who
// wrote, class owners — teaching at the school, Slack-linked) are tagged on the
// first post and on every scholar message, never the author, never an outside
// mentor; first-party only; unset channel → no Slack call.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestConvex = () => convexTest(schema, modules);
type T = ReturnType<typeof _makeTestConvex>;

const CHANNEL = "C_SCHOLAR_MESSAGES";
const originalFetch = globalThis.fetch;
const ENV_KEYS = ["SLACK_BOT_TOKEN", "SLACK_SCHOLAR_MESSAGES_CHANNEL_ID", "SITE_URL"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let posts: Array<Record<string, unknown>>;

beforeEach(() => {
  // Scheduled copies run only when a test drains them, never mid-assertion.
  vi.useFakeTimers();
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  process.env.SLACK_SCHOLAR_MESSAGES_CHANNEL_ID = CHANNEL;
  process.env.SITE_URL = "http://localhost:1041";
  posts = [];
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toContain("chat.postMessage");
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, ts: `100.${posts.length}` }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/**
 * The primary school Moli: a scholar (Ana) in a class owned by a second
 * teacher, the teacher who messages her, a teacher with no Slack link, and a
 * mentor (staff + mentor grant, Slack-linked) who is not on the teaching team.
 */
async function seedWorld(t: T, { primary = true } = {}) {
  return await t.run(async (ctx) => {
    const moli = await ctx.db.insert("institutions", {
      name: "Moli",
      slug: "moli-sms",
      kind: "school",
      ...(primary ? { isPrimary: true } : {}),
    });
    const user = async (
      username: string,
      role: Doc<"users">["role"],
      extra: Partial<Doc<"users">> = {},
    ) =>
      await ctx.db.insert("users", {
        username,
        name: `${username[0].toUpperCase()}${username.slice(1)} Test`,
        role,
        ...extra,
      });
    const ana = await user("ana", "scholar", { institutionId: moli });
    const teacher = await user("teacher", "teacher", { slackUserId: "U_TEACHER" });
    const owner = await user("owner", "teacher", { slackUserId: "U_OWNER" });
    const unlinked = await user("unlinked", "teacher");
    const admin = await user("admin", "platform_admin");
    const mentor = await user("mentor", "staff", { slackUserId: "U_MENTOR" });
    for (const userId of [teacher, owner, unlinked]) {
      await ctx.db.insert("memberships", { userId, role: "teacher", institutionId: moli });
    }
    await ctx.db.insert("memberships", { userId: mentor, role: "staff", institutionId: moli });
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: mentor,
      institutionId: moli,
      capability: "scholars:mentor",
      grantedBy: admin,
      grantedAt: 1,
    });
    await ctx.db.insert("scholarGroups", {
      teacherId: unlinked,
      ownerId: owner,
      institutionId: moli,
      name: "Geckos",
      scholarIds: [ana],
    });
    // Another class's owner is not Ana's teacher.
    const other = await user("other", "teacher", { slackUserId: "U_OTHER" });
    await ctx.db.insert("memberships", { userId: other, role: "teacher", institutionId: moli });
    await ctx.db.insert("scholarGroups", {
      teacherId: other,
      ownerId: other,
      institutionId: moli,
      name: "Seals",
      scholarIds: [],
    });
    return { moli, ana, teacher, owner, unlinked, mentor };
  });
}

type World = Awaited<ReturnType<typeof seedWorld>>;

async function latestMessageId(t: T, threadId: Id<"parentThreads">) {
  return await t.run(async (ctx) => {
    const messages = await ctx.db
      .query("parentMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect();
    return messages.at(-1)!._id;
  });
}

/** Run every scheduled function — the Slack copy among them — to completion. */
async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function send(t: T, from: Id<"users">, threadId: Id<"parentThreads">, body: string) {
  await (await withUser(t, from)).mutation(api.scholarMessages.reply, { threadId, body });
  await drain(t);
}

async function open(t: T, w: World, by: Id<"users"> = w.teacher) {
  const { threadIds } = await (await withUser(t, by)).mutation(
    api.scholarMessages.startMentorThreads,
    { scholarIds: [w.ana], body: "Aloha! How is the tank?" },
  );
  const threadId = threadIds[0];
  await drain(t);
  return { threadId, messageId: await latestMessageId(t, threadId) };
}

function mainText(post: Record<string, unknown>): string {
  const blocks = post.blocks as Array<{ type: string; text?: { text: string } }>;
  return blocks
    .filter((block) => block.type === "section")
    .map((block) => block.text?.text ?? "")
    .join("\n");
}

function mentionsIn(post: Record<string, unknown>): string[] {
  return [...mainText(post).matchAll(/<@([A-Z0-9_]+)>/g)].map((m) => m[1]).sort();
}

describe("scholar conversations → staff Slack channel", () => {
  test("every message in a scholar ↔ teacher conversation is scheduled for the copy", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await (await withUser(t, w.teacher)).mutation(api.scholarMessages.startMentorThreads, {
      scholarIds: [w.ana],
      body: "Aloha!",
    });
    const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.filter((job) => job.name === "scholarMessageSlack:copyToSlack")).toHaveLength(1);
  });

  test("one Slack thread per conversation; teachers tagged on the opener and on the scholar's replies", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { threadId, messageId } = await open(t, w);

    // The opener: a new root in the channel, tagging Ana's class owner — not
    // the author, not an unlinked teacher, not another class's owner.
    expect(posts).toHaveLength(1);
    expect(posts[0].channel).toBe(CHANNEL);
    expect(posts[0].thread_ts).toBeUndefined();
    expect(mentionsIn(posts[0])).toEqual(["U_OWNER"]);
    expect(mainText(posts[0])).toContain("*Teacher Test* wrote to *Ana Test* in Rabbithole:");
    expect(mainText(posts[0])).toContain("> Aloha! How is the tank?");
    expect(JSON.stringify(posts[0].blocks)).toMatch(
      /Reply in this thread to answer Ana Test in Rabbithole\. <http:\/\/localhost:1041\/teacher\/messages\?kind=scholars&thread=[A-Za-z0-9]+&inst=moli-sms\|Open Messages>/,
    );
    const mapping = await t.run(async (ctx) =>
      ctx.db
        .query("parentSlackThreads")
        .withIndex("by_parent_thread", (q) => q.eq("parentThreadId", threadId))
        .collect(),
    );
    expect(mapping).toMatchObject([{ channelId: CHANNEL, threadTs: "100.1" }]);
    const copied = await t.run(async (ctx) => ctx.db.get(messageId));
    expect(copied?.copiedToSlackAt).toBeTypeOf("number");

    // The scholar's reply: under the same root, tagging the teacher who wrote
    // to her and her class owner.
    await send(t, w.ana, threadId, "The snail laid eggs!");
    expect(posts).toHaveLength(2);
    expect(posts[1].thread_ts).toBe("100.1");
    expect(mentionsIn(posts[1])).toEqual(["U_OWNER", "U_TEACHER"]);
    expect(mainText(posts[1])).toContain("*Ana Test* wrote in Rabbithole:");

    // A teacher's follow-up is copied too, without paging anyone.
    await send(t, w.owner, threadId, "Wonderful, bring a photo tomorrow.");
    expect(posts).toHaveLength(3);
    expect(posts[2].thread_ts).toBe("100.1");
    expect(mentionsIn(posts[2])).toEqual([]);
    expect(mainText(posts[2])).toContain("*Owner Test* wrote to *Ana Test*");
  });

  test("an outside mentor is never tagged, even after writing in the conversation", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { threadId } = await open(t, w, w.mentor);
    expect(mentionsIn(posts[0])).toEqual(["U_OWNER"]);
    await send(t, w.ana, threadId, "Thanks!");
    expect(mentionsIn(posts[1])).toEqual(["U_OWNER"]);
  });

  test("a re-run for the same message posts nothing new", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { messageId } = await open(t, w);
    await t.action(internal.scholarMessageSlack.copyToSlack, { messageId });
    expect(posts).toHaveLength(1);
  });

  test("no channel configured, or not the primary school: nothing reaches Slack", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    delete process.env.SLACK_SCHOLAR_MESSAGES_CHANNEL_ID;
    await open(t, w);
    expect(posts).toHaveLength(0);

    const t2 = convexTest(schema, modules);
    const w2 = await seedWorld(t2, { primary: false });
    process.env.SLACK_SCHOLAR_MESSAGES_CHANNEL_ID = CHANNEL;
    await open(t2, w2);
    expect(posts).toHaveLength(0);
    const rows = await t2.run((ctx) => ctx.db.query("parentSlackThreads").collect());
    expect(rows).toHaveLength(0);
  });

  test("a Workshop conversation is not copied here", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { suggestionId } = await (await withUser(t, w.ana)).mutation(
      api.scholarSuggestions.createMine,
      { text: "Blue quest cards please" },
    );
    const threadId = await t.run(async (ctx) => (await ctx.db.get(suggestionId))!.threadId!);
    const messageId = await latestMessageId(t, threadId);
    await t.action(internal.scholarMessageSlack.copyToSlack, { messageId });
    expect(posts).toHaveLength(0);
  });

  test("a staff reply in the Slack thread reaches the scholar, once, and is not copied back", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { threadId } = await open(t, w);
    const threadTs = "100.1"; // the opener's ts from the fake Slack
    posts = [];
    const reply = (slackUserId: string, body: string, eventId: string) =>
      t.mutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: CHANNEL,
        threadTs,
        slackUserId,
        body,
        eventId,
      });

    const sent = await reply("U_OWNER", "Nice work on the tank!", "Ev1");
    expect(sent).toMatchObject({ handled: true, ok: true, action: "message", threadId });
    // A Slack retry of the same event is not a second message.
    expect(await reply("U_OWNER", "Nice work on the tank!", "Ev1")).toMatchObject({
      ok: true,
      action: "duplicate",
    });
    await drain(t);
    expect(posts).toHaveLength(0);

    const scholarView = await (await withUser(t, w.ana)).query(api.scholarMessages.getThread, {
      threadId,
    });
    expect(JSON.stringify(scholarView)).toContain("Nice work on the tank!");
    const rows = await t.run(async (ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    const fromSlack = rows.filter((row) => row.source === "slack");
    expect(fromSlack).toHaveLength(1);
    expect(fromSlack[0]).toMatchObject({ authorType: "teacher", authorUserId: w.owner });

    // An @-mention is a question for the aide: handed back, nothing posted.
    expect(
      await t.mutation(internal.parentMessages.ingestInboundSlackReply, {
        channelId: CHANNEL,
        threadTs,
        slackUserId: "U_OWNER",
        body: "<@U_BOT> what has Ana been stuck on?",
        eventId: "Ev4",
        mentionsBot: true,
      }),
    ).toMatchObject({ handled: false });

    // Same rule as an in-app reply: an outside mentor who isn't named on this
    // conversation, an unlinked Slack user, and a read-only account can't.
    expect(await reply("U_MENTOR", "hi", "Ev2")).toMatchObject({ handled: true, ok: false });
    await t.run((ctx) => ctx.db.patch(w.owner, { readOnly: true }));
    expect(await reply("U_OWNER", "hi again", "Ev5")).toMatchObject({
      handled: true,
      ok: false,
      reason: "unlinked",
    });
    expect(await reply("U_NOBODY", "hi", "Ev3")).toMatchObject({
      handled: true,
      ok: false,
      reason: "unlinked",
    });
  });
});
