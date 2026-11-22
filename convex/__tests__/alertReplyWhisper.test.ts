import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeSession, makeWorld } from "./factories/world";
import { whisperLeftAfterTurn } from "../lib/teacherWhisper";
import { makeSlackTools } from "../lib/slackTools";
import type { ActionCtx } from "../_generated/server";
import { alertThreadContextLine } from "../slackBot";
import { CLEARED_RECEIPT_TEXT, deliveredReceiptText } from "../whisperReceipts";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function pendingWhisper(
  t: TestConvex<typeof schema>,
  sessionId: Id<"sessions">,
) {
  return (await t.run((ctx) => ctx.db.get(sessionId)))?.pendingWhisper;
}

describe("queueTeacherWhisper (Slack whisper_to_session)", () => {
  test("a teacher's whisper lands on their scholar's session, and a second one goes after it", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const scholar = school.scholars[0];
    const sessionId = await makeSession(t, scholar, {
      title: "Food web builder",
      lastMessageAt: Date.now() - 4 * 60_000,
    });

    const first = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "  Get one predator eating first, then scenery.  ",
    });
    expect(first).toMatchObject({
      ok: true,
      scholarName: scholar.name,
      sessionTitle: "Food web builder",
      queuedAfterAnother: false,
    });
    expect(await pendingWhisper(t, sessionId)).toBe(
      "Get one predator eating first, then scenery.",
    );

    const second = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.admin.id,
      sessionId,
      text: "Remind him the fox needs a food source.",
    });
    expect(second).toMatchObject({ ok: true, queuedAfterAnother: true });
    expect(await pendingWhisper(t, sessionId)).toBe(
      "Get one predator eating first, then scenery.\n\nRemind him the fox needs a food source.",
    );
  });

  test("operations staff are refused and nothing is written", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);

    const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.ops.id,
      sessionId,
      text: "Tell her she has plenty of time.",
    });
    expect(result.ok).toBe(false);
    expect(await pendingWhisper(t, sessionId)).toBeUndefined();
  });

  test("a teacher-role account that is only operations staff at the scholar's school is refused", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    // Global role says teacher; the membership at this school says staff.
    await t.run((ctx) => ctx.db.patch(school.ops.id, { role: "teacher" }));
    const sessionId = await makeSession(t, school.scholars[0]);

    const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.ops.id,
      sessionId,
      text: "Tell her she has plenty of time.",
    });
    expect(result.ok).toBe(false);
    expect(await pendingWhisper(t, sessionId)).toBeUndefined();
  });

  test("refuses once the waiting whispers would pass the total cap", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const waiting = "w".repeat(3500);
    const sessionId = await makeSession(t, school.scholars[0], {
      pendingWhisper: waiting,
    });

    const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "x".repeat(900),
    });
    expect(result.ok).toBe(false);
    expect(await pendingWhisper(t, sessionId)).toBe(waiting);
  });

  test("another school's teacher cannot whisper to this school's scholar", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 2, parentsPerSchool: 0 });
    const [primary, other] = world.schools;
    const sessionId = await makeSession(t, primary.scholars[0]);

    const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: other.teacher.id,
      sessionId,
      text: "Tell him to stop for tonight.",
    });
    expect(result.ok).toBe(false);
    expect(await pendingWhisper(t, sessionId)).toBeUndefined();
  });

  test("first-party only: a non-primary school's own teacher is refused", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 2, parentsPerSchool: 0 });
    const other = world.schools[1];
    expect(other.isPrimary).toBe(false);
    const sessionId = await makeSession(t, other.scholars[0]);

    const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: other.teacher.id,
      sessionId,
      text: "Encourage her to keep going.",
    });
    expect(result.ok).toBe(false);
    expect(await pendingWhisper(t, sessionId)).toBeUndefined();
  });

  test("a platform admin can whisper to a primary-school scholar", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const sessionId = await makeSession(t, world.schools[0].scholars[0]);

    const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: world.platformAdmin!.id,
      sessionId,
      text: "Ask what the fox eats.",
    });
    expect(result.ok).toBe(true);
    expect(await pendingWhisper(t, sessionId)).toBe("Ask what the fox eats.");
  });

  test("rejects a bad session id, an empty whisper and an over-long one", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);

    for (const args of [
      { sessionId: "not-a-session-id", text: "Hello" },
      { sessionId, text: "   " },
      { sessionId, text: "x".repeat(1001) },
    ]) {
      const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
        callerUserId: school.teacher.id,
        ...args,
      });
      expect(result.ok).toBe(false);
    }
    expect(await pendingWhisper(t, sessionId)).toBeUndefined();
  });
});

describe("the remote-mode whisper box (sessions.update)", () => {
  test("adds after a waiting Slack whisper instead of replacing it; null still clears", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);
    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.admin.id,
      sessionId,
      text: "Slack whisper",
    });

    const asTeacher = await world.as.staffOf(school);
    await asTeacher.mutation(api.sessions.update, {
      id: sessionId,
      pendingWhisper: "Remote-mode whisper",
    });
    expect(await pendingWhisper(t, sessionId)).toBe(
      "Slack whisper\n\nRemote-mode whisper",
    );

    await asTeacher.mutation(api.sessions.update, {
      id: sessionId,
      pendingWhisper: null,
    });
    expect(await pendingWhisper(t, sessionId)).toBeUndefined();
  });
});

describe("clearPendingWhisper keeps a whisper that arrived mid-turn", () => {
  test("pure: clears what the turn read and nothing else", () => {
    expect(whisperLeftAfterTurn("A", "A")).toBeUndefined();
    expect(whisperLeftAfterTurn("A\n\nB", "A")).toBe("B");
    expect(whisperLeftAfterTurn("C", "A")).toBe("C");
    expect(whisperLeftAfterTurn(undefined, "A")).toBeUndefined();
  });

  test("a Slack whisper queued during a streaming turn survives the clear", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0], {
      pendingWhisper: "Remote-mode whisper",
    });

    // The turn read "Remote-mode whisper"; a Slack whisper lands before it ends.
    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Slack whisper",
    });
    await t.mutation(internal.sessionHelpers.clearPendingWhisper, {
      sessionId,
      consumed: "Remote-mode whisper",
    });
    expect(await pendingWhisper(t, sessionId)).toBe("Slack whisper");

    await t.mutation(internal.sessionHelpers.clearPendingWhisper, {
      sessionId,
      consumed: "Slack whisper",
    });
    expect(await pendingWhisper(t, sessionId)).toBeUndefined();
  });
});

describe("alerts.threadBinding", () => {
  async function seedAlert(t: TestConvex<typeof schema>) {
    const world = await makeWorld(t, { schools: 2, parentsPerSchool: 0 });
    const scholar = world.schools[0].scholars[0];
    const sessionId = await makeSession(t, scholar, {
      title: "Food web builder",
      pendingWhisper: "Get one predator eating first.",
    });
    await t.run((ctx) =>
      ctx.db.insert("alerts", {
        kind: "off_mission",
        severity: "info",
        title: `Off mission — ${scholar.name}`,
        body: "The build drifted to scenery.",
        source: "test",
        scholarId: scholar.id,
        sessionId,
        status: "open",
        createdAt: Date.now(),
        slackChannelId: "C_ALERTS",
        slackMessageTs: "1794000000.000100",
      }),
    );
    return { world, scholar, sessionId };
  }
  const thread = { channelId: "C_ALERTS", threadTs: "1794000000.000100" };

  test("gives a teacher at the scholar's school the session and its waiting whisper", async () => {
    const t = convexTest(schema, modules);
    const { world, scholar, sessionId } = await seedAlert(t);

    const binding = await t.query(internal.alerts.threadBinding, {
      ...thread,
      callerUserId: world.schools[0].teacher.id,
    });
    expect(binding).toMatchObject({
      kind: "off_mission",
      scholarName: scholar.name,
      session: {
        refusal: null,
        sessionId,
        pendingWhisper: "Get one predator eating first.",
      },
    });
    expect(await t.query(internal.alerts.isAlertThread, thread)).toBe(true);
    expect(
      await t.query(internal.alerts.isAlertThread, { ...thread, channelId: "C_OTHER" }),
    ).toBe(false);
  });

  test("gives anyone else a refusal and none of the session's details", async () => {
    const t = convexTest(schema, modules);
    const { world } = await seedAlert(t);

    for (const callerUserId of [
      world.schools[1].teacher.id, // another school's teacher in a shared channel
      world.schools[0].ops.id, // operations staff
    ]) {
      const binding = await t.query(internal.alerts.threadBinding, {
        ...thread,
        callerUserId,
      });
      expect(binding?.session).toEqual({ refusal: expect.any(String) });
    }
  });
});

describe("alertThreadContextLine", () => {
  const now = Date.now();
  const whisperable = {
    title: "Off mission — Oliver Stone",
    scholarName: "Oliver Stone",
    kind: "off_mission",
    session: {
      refusal: null,
      sessionId: "session_123",
      pendingWhisper: "Get one predator eating first.",
      lastMessageAt: now - 4 * 60_000,
    },
  };

  test("hands over the session id and the waiting whisper", () => {
    expect(alertThreadContextLine(null, now)).toBeNull();
    const line = alertThreadContextLine(whisperable, now);
    expect(line).toContain("session_123");
    expect(line).toContain("Get one predator eating first.");
  });

  test("a refused requester gets no session id", () => {
    const line = alertThreadContextLine(
      { ...whisperable, session: { refusal: "needs a teacher." } },
      now,
    );
    expect(line).not.toBeNull();
    expect(line).not.toContain("session_123");
  });

  test("a session-less alert gets a line only when it is about practice", () => {
    expect(
      alertThreadContextLine(
        { ...whisperable, kind: "practice_stuck", session: null },
        now,
      ),
    ).not.toBeNull();
    expect(
      alertThreadContextLine(
        { ...whisperable, kind: "device_low_battery", session: null },
        now,
      ),
    ).toBeNull();
  });
});

describe("whisper_to_session registration", () => {
  test("is built for teacher roles only", async () => {
    const names = async (role: string) =>
      (
        await makeSlackTools({} as ActionCtx, () => {}, {
          role: role as never,
          callerUserId: "user_1" as Id<"users">,
          surface: "channel",
          slackChannelId: "C1",
          token: "xoxb-test",
        })
      ).map((tool) => (tool as { name: string }).name);
    for (const role of ["teacher", "school_admin", "platform_admin"]) {
      expect(await names(role)).toContain("whisper_to_session");
    }
    for (const role of ["staff", "curriculum_designer", "parent"]) {
      expect(await names(role)).not.toContain("whisper_to_session");
    }
  });
});

describe("Slack whisper delivery receipts", () => {
  const slack = {
    channelId: "C_ALERTS",
    threadTs: "1794000000.000100",
    quoteReply: true,
  };

  async function scheduledNamed(t: TestConvex<typeof schema>, name: string) {
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    return jobs.filter((job) => job.name.includes(name));
  }

  async function receipts(
    t: TestConvex<typeof schema>,
    sessionId: Id<"sessions">,
  ) {
    return await t.run((ctx) =>
      ctx.db
        .query("slackWhisperReceipts")
        .withIndex("by_session_delivered", (q) => q.eq("sessionId", sessionId))
        .collect(),
    );
  }

  test("a Slack whisper is marked delivered, and its post scheduled, only on the turn that read it", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);

    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Get one predator eating first.",
      slack,
    });
    expect(await receipts(t, sessionId)).toMatchObject([
      {
        text: "Get one predator eating first.",
        slackChannelId: "C_ALERTS",
        slackThreadTs: "1794000000.000100",
        queuedBy: school.teacher.id,
      },
    ]);
    expect((await receipts(t, sessionId))[0].deliveredAt).toBeUndefined();

    // A turn that read something else leaves the receipt waiting.
    await t.mutation(internal.sessionHelpers.clearPendingWhisper, {
      sessionId,
      consumed: "A remote-mode whisper",
    });
    expect((await receipts(t, sessionId))[0].deliveredAt).toBeUndefined();

    await t.mutation(internal.sessionHelpers.clearPendingWhisper, {
      sessionId,
      consumed: "Get one predator eating first.",
    });
    expect((await receipts(t, sessionId))[0].deliveredAt).toEqual(
      expect.any(Number),
    );
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) => job.name.includes("postDelivered")),
    ).toHaveLength(1);

    // Delivered once: a later clear schedules nothing more.
    await t.mutation(internal.sessionHelpers.clearPendingWhisper, {
      sessionId,
      consumed: "Get one predator eating first.",
    });
    const after = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(after.filter((job) => job.name.includes("postDelivered"))).toHaveLength(1);
  });

  test("no receipt without a Slack thread", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);

    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Ask what the fox eats.",
    });
    expect(await receipts(t, sessionId)).toEqual([]);
  });

  test("a whisper that is only a substring of the one read is not reported delivered", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);
    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Slow down.",
      slack,
    });

    await t.mutation(internal.sessionHelpers.clearPendingWhisper, {
      sessionId,
      consumed: "Slow down. Check units first.",
    });
    expect((await receipts(t, sessionId))[0].deliveredAt).toBeUndefined();
  });

  test("a copy queued after the turn read the slot waits for the turn that reads it", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);
    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Ask about the fox.",
      slack,
    });
    const queuedAt = (await receipts(t, sessionId))[0].queuedAt;

    await t.mutation(internal.sessionHelpers.clearPendingWhisper, {
      sessionId,
      consumed: "Ask about the fox.",
      readAt: queuedAt - 1,
    });
    expect((await receipts(t, sessionId))[0].deliveredAt).toBeUndefined();
  });

  test("the remote-mode box clearing a Slack whisper removes its receipt and tells the thread", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);
    for (const text of ["Keep this one.", "Clear this one."]) {
      await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
        callerUserId: school.teacher.id,
        sessionId,
        text,
        slack,
      });
    }
    const asTeacher = await world.as.staffOf(school);

    // Adding from the box keeps both receipts.
    await asTeacher.mutation(api.sessions.update, {
      id: sessionId,
      pendingWhisper: "From the box.",
    });
    expect(await receipts(t, sessionId)).toHaveLength(2);
    expect(await scheduledNamed(t, "postInThread")).toHaveLength(0);

    // Clearing removes both and posts in their threads.
    await asTeacher.mutation(api.sessions.update, {
      id: sessionId,
      pendingWhisper: null,
    });
    expect(await receipts(t, sessionId)).toEqual([]);
    expect(await scheduledNamed(t, "postInThread")).toHaveLength(2);
  });

  test("no receipt, and no promised post, when the same words are already waiting", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0], {
      pendingWhisper: "Ask about the fox.",
    });

    const result = await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Ask about the fox.",
      slack,
    });
    expect(result).toMatchObject({ ok: true, receiptQueued: false });
    expect(await receipts(t, sessionId)).toEqual([]);
  });

  test("the quote comes from the turn's whole reply, even when a tool split it", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const sessionId = await makeSession(t, school.scholars[0]);
    const otherSessionId = await makeSession(t, school.scholars[1]);
    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Ask about the fox.",
      slack,
    });
    const receiptId = (await receipts(t, sessionId))[0]._id;
    const { firstId, otherId } = await t.run(async (ctx) => {
      const firstId = await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "Which animal does the fox catch first?",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId,
        role: "assistant",
        content: "",
        flagged: false,
      });
      const otherId = await ctx.db.insert("messages", {
        sessionId: otherSessionId,
        role: "assistant",
        content: "Another scholar's session.",
        flagged: false,
      });
      return { firstId, otherId };
    });

    const facts = await t.query(internal.whisperReceipts.deliveryFacts, {
      receiptId,
      turnFirstMessageId: firstId,
    });
    expect(facts?.text).toContain("Which animal does the fox catch first?");

    // A message id from another session is never quoted.
    const foreign = await t.query(internal.whisperReceipts.deliveryFacts, {
      receiptId,
      turnFirstMessageId: otherId,
    });
    expect(foreign?.text).not.toContain("Another scholar's session.");
  });

  test("the post quotes the reply's last paragraph, flattened and capped, and only when allowed", () => {
    const quoted = deliveredReceiptText("Oliver Stone", "Which animal first?", true);
    expect(quoted).toContain("Which animal first?");
    expect(
      deliveredReceiptText("Oliver Stone", "Which animal first?", false),
    ).not.toContain("Which animal first?");
    const firstTurn =
      "Hi Oliver! I'm an AI, a computer program.\n\nHere's a puzzle. **Which animal should the fox go after first, and why?**";
    const post = deliveredReceiptText("Oliver Stone", firstTurn, true);
    expect(post).toContain("Which animal should the fox go after first");
    expect(post).not.toContain("I'm an AI");
    expect(post).not.toContain("**");

    const long = `Intro.\n\nLet's make your fox hunt.\n${"Which animal should it eat first? ".repeat(20)}`;
    const capped = deliveredReceiptText("Oliver Stone", long, true);
    expect(capped).not.toContain("\n");
    expect(capped).toContain("…");
    expect(capped.length).toBeLessThan(400);
  });

  test("the delivered receipt posts as one grey line; the cleared notice stays full size", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const [school] = world.schools;
    const scholar = school.scholars[0];
    const sessionId = await makeSession(t, scholar);
    await t.mutation(internal.sessionHelpers.queueTeacherWhisper, {
      callerUserId: school.teacher.id,
      sessionId,
      text: "Ask about the fox.",
      slack,
    });
    const receiptId = (await receipts(t, sessionId))[0]._id;

    const posts: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const previousToken = process.env.SLACK_BOT_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, ts: "1794000000.000200" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    try {
      await t.action(internal.whisperReceipts.postDelivered, { receiptId });
      await t.action(internal.whisperReceipts.postInThread, {
        channelId: slack.channelId,
        threadTs: slack.threadTs,
        text: CLEARED_RECEIPT_TEXT,
      });
    } finally {
      globalThis.fetch = realFetch;
      if (previousToken === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = previousToken;
    }

    expect(posts).toHaveLength(2);
    const receipt = deliveredReceiptText(scholar.name ?? "", null, true);
    expect(posts[0]).toMatchObject({ channel: "C_ALERTS", thread_ts: slack.threadTs });
    expect(posts[0].markdown_text).toBeUndefined();
    // Its only block is the grey line.
    expect(posts[0].blocks).toEqual([
      {
        type: "context",
        block_id: "rh_grey_0",
        elements: [{ type: "mrkdwn", text: receipt }],
      },
    ]);
    expect(posts[0].text).toBe(receipt);
    // The cleared notice is posted exactly as before: no blocks.
    expect(posts[1]).toMatchObject({
      channel: "C_ALERTS",
      thread_ts: slack.threadTs,
      markdown_text: CLEARED_RECEIPT_TEXT,
    });
    expect(posts[1].blocks).toBeUndefined();
  });
});
