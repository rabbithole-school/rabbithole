// About threads (parentThreads.kind "about"): one scholar ↔ their school's
// teachers, about ONE of the scholar's Quests or wonders. Pins get-or-create
// (create, reuse, refuse what isn't the scholar's, refuse other schools), who
// may read them, that old thread lists don't change, and the Slack relay that
// routes a teacher's reply under a mapped root into the right thread. All
// people here are made up. No copy assertions.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { threadFlavor } from "../lib/scholarThreadAccess";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestConvex = () => convexTest(schema, modules);
type T = ReturnType<typeof _makeTestConvex>;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.SLACK_BOT_TOKEN;
});

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60 * 24 * 30,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/**
 * Two schools. At Moli: scholars Ana and Ben, a teacher, a mentor with an
 * institution-wide grant, and Ana's guardian. At Kona: scholar Kai and a
 * teacher. Plus a platform admin. Each Moli scholar has a wonder (a seed) and
 * a Quest they wrote; Ana also has a Kona unit offered to her by a seed, which
 * must never count as her Quest.
 */
async function seedWorld(t: T) {
  return await t.run(async (ctx) => {
    const moli = await ctx.db.insert("institutions", {
      name: "Moli",
      slug: "moli-about",
      kind: "school",
      isPrimary: true,
    });
    const kona = await ctx.db.insert("institutions", {
      name: "Kona",
      slug: "kona-about",
      kind: "school",
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
    const ben = await user("ben", "scholar", { institutionId: moli });
    const kai = await user("kai", "scholar", { institutionId: kona });
    const teacher = await user("teacher", "teacher", { slackUserId: "U_TEACH" });
    await ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId: moli });
    const konaTeacher = await user("konateacher", "teacher", { slackUserId: "U_KONA" });
    await ctx.db.insert("memberships", {
      userId: konaTeacher,
      role: "teacher",
      institutionId: kona,
    });
    const admin = await user("admin", "platform_admin");
    const mentor = await user("mentor", "staff", { slackUserId: "U_MENTOR" });
    await ctx.db.insert("memberships", { userId: mentor, role: "staff", institutionId: moli });
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: mentor,
      institutionId: moli,
      capability: "scholars:mentor",
      grantedBy: admin,
      grantedAt: 1,
    });
    const parent = await user("parent", "parent", { slackUserId: "U_PARENT" });
    await ctx.db.insert("memberships", { userId: parent, role: "parent", institutionId: moli });
    await ctx.db.insert("guardianships", {
      parentUserId: parent,
      scholarUserId: ana,
      createdBy: admin,
    });

    const seed = async (scholarId: Id<"users">, topic: string, unitId?: Id<"units">) =>
      await ctx.db.insert("seeds", {
        scholarId,
        origin: "teacher",
        status: "active",
        topic,
        suggestionType: "teacher_suggestion",
        rationale: "Teacher-facing note.",
        ...(unitId ? { unitId } : {}),
      });
    const quest = async (
      title: string,
      extra: Partial<Doc<"units">> = {},
    ) =>
      await ctx.db.insert("units", { teacherId: teacher, title, isActive: true, ...extra });

    const anaWonder = await seed(ana, "Why do owls turn their heads so far?");
    const anaWonder2 = await seed(ana, "Why is the sky blue?");
    const benWonder = await seed(ben, "Is there a biggest prime?");
    // The kid's own questions: origin "wonder", their words in `topic`.
    await ctx.db.patch(anaWonder, { origin: "wonder" });
    await ctx.db.patch(benWonder, { origin: "wonder" });
    const anaQuest = await quest("Angle croc", { authorScholarId: ana, institutionId: moli });
    const benQuest = await quest("Bird flight", { authorScholarId: ben, institutionId: moli });
    const konaUnit = await quest("Kona unit", { institutionId: kona });
    await seed(ana, "A Kona unit", konaUnit);
    return {
      moli,
      kona,
      ana,
      ben,
      kai,
      teacher,
      konaTeacher,
      admin,
      mentor,
      parent,
      anaWonder,
      anaWonder2,
      benWonder,
      anaQuest,
      benQuest,
      konaUnit,
    };
  });
}

type World = Awaited<ReturnType<typeof seedWorld>>;

async function aboutThreads(t: T) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("parentThreads").collect()).filter(
      (thread) => threadFlavor(thread) === "about",
    ),
  );
}

describe("opening an about thread", () => {
  test("creates one thread per (scholar, Quest or wonder) and reuses it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const ana = await withUser(t, w.ana);
    const teacher = await withUser(t, w.teacher);

    const wonder = { type: "wonder" as const, seedId: w.anaWonder };
    const first = await ana.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: wonder,
    });
    const again = await ana.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: wonder,
    });
    const byTeacher = await teacher.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: wonder,
    });
    expect(again.threadId).toBe(first.threadId);
    expect(byTeacher.threadId).toBe(first.threadId);

    const other = await ana.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: { type: "wonder", seedId: w.anaWonder2 },
    });
    const questThread = await ana.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: { type: "quest", unitId: w.anaQuest },
    });
    expect(new Set([first.threadId, other.threadId, questThread.threadId]).size).toBe(3);

    const thread = await t.run(async (ctx) => ctx.db.get(first.threadId));
    expect(thread).toMatchObject({
      kind: "scholar",
      flavor: "about",
      about: wonder,
      scholarId: w.ana,
      institutionId: w.moli,
    });
    const participants = await t.run(async (ctx) =>
      ctx.db
        .query("parentThreadParticipants")
        .withIndex("by_thread", (q) => q.eq("threadId", first.threadId))
        .collect(),
    );
    expect(participants.map((row) => [row.parentUserId, row.side])).toEqual([
      [w.ana, "scholar"],
    ]);
    expect(await aboutThreads(t)).toHaveLength(3);
  });

  test("refuses a Quest or wonder that isn't the scholar's, and every outsider", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const attempts: Array<[Id<"users">, Id<"users">, Doc<"parentThreads">["about"]]> = [
      // Ana asking about Ben's wonder and Ben's Quest under her own name.
      [w.ana, w.ana, { type: "wonder", seedId: w.benWonder }],
      [w.ana, w.ana, { type: "quest", unitId: w.benQuest }],
      // Ana opening a thread with Ben as its scholar.
      [w.ana, w.ben, { type: "wonder", seedId: w.benWonder }],
      // A seed points Ana at a Kona unit: still not a Quest at her school.
      [w.ana, w.ana, { type: "quest", unitId: w.konaUnit }],
      [w.teacher, w.ana, { type: "quest", unitId: w.konaUnit }],
      // The teacher, with Ben's wonder under Ana.
      [w.teacher, w.ana, { type: "wonder", seedId: w.benWonder }],
      // Staff with no standing at Moli, a mentor, a guardian.
      [w.konaTeacher, w.ana, { type: "wonder", seedId: w.anaWonder }],
      [w.mentor, w.ana, { type: "wonder", seedId: w.anaWonder }],
      [w.parent, w.ana, { type: "wonder", seedId: w.anaWonder }],
      // Kai is at Kona: the Moli teacher can't open one with Kai.
      [w.teacher, w.kai, { type: "wonder", seedId: w.anaWonder }],
    ];
    for (const [caller, scholarId, about] of attempts) {
      const as = await withUser(t, caller);
      await expect(
        as.mutation(api.scholarMessages.openAboutThreadForScholar, {
          scholarId,
          about: about!,
        }),
      ).rejects.toThrow("Conversation not found");
    }
    expect(await aboutThreads(t)).toHaveLength(0);
  });

  test("a Quest offered by a seed at the scholar's own school counts", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const offered = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: w.teacher,
        institutionId: w.moli,
        title: "Owl necks",
        isActive: true,
      });
      await ctx.db.insert("seeds", {
        scholarId: w.ana,
        origin: "teacher",
        status: "pending",
        topic: "Owl necks",
        suggestionType: "teacher_suggestion",
        rationale: "Teacher-facing note.",
        unitId,
      });
      return unitId;
    });
    const teacher = await withUser(t, w.teacher);
    await teacher.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: { type: "quest", unitId: offered },
    });
    // Ben was never offered it.
    const ben = await withUser(t, w.ben);
    await expect(
      ben.mutation(api.scholarMessages.openAboutThreadForScholar, {
        scholarId: w.ben,
        about: { type: "quest", unitId: offered },
      }),
    ).rejects.toThrow("Conversation not found");
    expect(await aboutThreads(t)).toHaveLength(1);
  });
});

describe("an about thread's school is the scholar's real enrollment", () => {
  test("an unenrolled scholar has no about threads, not even at the primary school", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // No users.institutionId and no scholar membership: the other kinds would
    // place this scholar in the primary school (Moli).
    const { drifter, wonder } = await t.run(async (ctx) => {
      const drifter = await ctx.db.insert("users", {
        username: "drifter",
        name: "Drifter Test",
        role: "scholar",
      });
      const wonder = await ctx.db.insert("seeds", {
        scholarId: drifter,
        origin: "teacher",
        status: "active",
        topic: "Why do cats purr?",
        suggestionType: "teacher_suggestion",
        rationale: "Teacher-facing note.",
      });
      return { drifter, wonder };
    });
    const about = { type: "wonder" as const, seedId: wonder };
    for (const caller of [w.teacher, w.admin, drifter]) {
      const as = await withUser(t, caller);
      await expect(
        as.mutation(api.scholarMessages.openAboutThreadForScholar, { scholarId: drifter, about }),
      ).rejects.toThrow("Conversation not found");
    }
    expect(
      await t.mutation(internal.scholarMessages.recordAboutSlackThread, {
        channelId: "C_CLASS",
        threadTs: "550.1",
        scholarId: drifter,
        about,
      }),
    ).toBeNull();

    // A thread stamped at the primary school for this scholar (however it got
    // there) gives the primary school's teachers nothing to write in.
    const threadId = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("parentThreads", {
        parentUserId: drifter,
        scholarId: drifter,
        institutionId: w.moli,
        kind: "about",
        about,
        lastMessageAt: 1,
      });
      await ctx.db.insert("parentThreadParticipants", {
        threadId,
        parentUserId: drifter,
        side: "scholar",
      });
      return threadId;
    });
    const teacher = await withUser(t, w.teacher);
    await expect(
      teacher.mutation(api.scholarMessages.reply, { threadId, body: "hi" }),
    ).rejects.toThrow();
    const detail = await teacher.query(api.scholarMessages.getThread, { threadId });
    expect(detail?.canReply ?? false).toBe(false);
    expect(
      await (await withUser(t, drifter)).query(api.scholarMessages.getThread, { threadId }),
    ).toBeNull();
  });

  test("a Quest stamped with the school a scholar left stays there", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // Ana wrote this Quest at Kona, then moved to Moli.
    const oldQuest = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId: w.konaTeacher,
        title: "Kona-era Quest",
        isActive: true,
        authorScholarId: w.ana,
        institutionId: w.kona,
      }),
    );
    for (const caller of [w.ana, w.teacher]) {
      const as = await withUser(t, caller);
      await expect(
        as.mutation(api.scholarMessages.openAboutThreadForScholar, {
          scholarId: w.ana,
          about: { type: "quest", unitId: oldQuest },
        }),
      ).rejects.toThrow("Conversation not found");
    }
    expect(await aboutThreads(t)).toHaveLength(0);
  });
});

describe("who can read an about thread", () => {
  async function anaThreadWithReply(t: T, w: World) {
    const teacher = await withUser(t, w.teacher);
    const { threadId } = await teacher.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: { type: "wonder", seedId: w.anaWonder },
    });
    const { messageId } = await teacher.mutation(api.scholarMessages.reply, {
      threadId,
      body: "Count the bones in your neck tonight.",
    });
    return { threadId, messageId };
  }

  test("the scholar and her school's teachers read and reply; nobody else gets anything", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { threadId, messageId } = await anaThreadWithReply(t, w);

    for (const reader of [w.ana, w.teacher, w.admin]) {
      const detail = await (await withUser(t, reader)).query(api.scholarMessages.getThread, {
        threadId,
      });
      expect(detail).toMatchObject({
        kind: "about",
        about: { type: "wonder", seedId: w.anaWonder },
        canReply: true,
      });
      expect(detail!.messages.map((m) => m._id)).toEqual([messageId]);
    }
    const ana = await withUser(t, w.ana);
    await ana.mutation(api.scholarMessages.reply, { threadId, body: "Seven!" });

    for (const outsider of [w.ben, w.kai, w.konaTeacher, w.mentor, w.parent]) {
      const as = await withUser(t, outsider);
      expect(await as.query(api.scholarMessages.getThread, { threadId })).toBeNull();
      expect(await as.query(api.scholarMessages.getThreadAttachments, { threadId })).toEqual([]);
      const listed = await as.query(api.scholarMessages.listThreads, { kind: "about" });
      expect(listed.threads.map((x) => x._id)).not.toContain(threadId);
      await expect(
        as.mutation(api.scholarMessages.reply, { threadId, body: "hi" }),
      ).rejects.toThrow();
      await expect(as.mutation(api.scholarMessages.markRead, { threadId })).rejects.toThrow();
    }
    // The guardian's family surfaces never show it either.
    const parent = await withUser(t, w.parent);
    const guardianThreads = await parent.query(api.parentMessages.listMyGuardianThreads, {});
    expect(guardianThreads.map((x) => x._id)).not.toContain(threadId);

    // Kid-safe delivery: every message in the thread went to the portal only.
    const deliveries = await t.run(async (ctx) => ctx.db.query("messageDeliveries").collect());
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.channel === "portal")).toBe(true);
  });

  test("old list calls are unchanged; kind \"about\" lists them", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { threadId } = await anaThreadWithReply(t, w);
    const mentorThread = await (await withUser(t, w.teacher)).mutation(
      api.scholarMessages.startMentorThreads,
      { scholarIds: [w.ana], body: "Hello from your teacher." },
    );

    for (const viewer of [w.ana, w.teacher]) {
      const as = await withUser(t, viewer);
      const plain = await as.query(api.scholarMessages.listThreads, {});
      expect(plain.threads.map((x) => x._id)).toEqual(mentorThread.threadIds);
      // A mentor row has exactly the fields it had before about threads.
      expect(plain.threads[0]).not.toHaveProperty("about");
      const about = await as.query(api.scholarMessages.listThreads, { kind: "about" });
      expect(about.threads.map((x) => x._id)).toEqual([threadId]);
      expect(about.threads[0]).toMatchObject({
        kind: "about",
        about: { type: "wonder", seedId: w.anaWonder },
      });
    }
    // The unread badge an old build shows counts only what its list shows.
    const ana = await withUser(t, w.ana);
    expect((await ana.query(api.scholarMessages.listThreads, {})).unreadCount).toBe(1);
  });

  test("an about thread names its subject: a wonder's question, a Quest's title", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const teacher = await withUser(t, w.teacher);
    const wonder = await teacher.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: { type: "wonder", seedId: w.anaWonder },
    });
    const quest = await teacher.mutation(api.scholarMessages.openAboutThreadForScholar, {
      scholarId: w.ana,
      about: { type: "quest", unitId: w.anaQuest },
    });
    await teacher.mutation(api.scholarMessages.startMentorThreads, {
      scholarIds: [w.ana],
      body: "Hello from your teacher.",
    });
    for (const viewer of [w.ana, w.teacher]) {
      const as = await withUser(t, viewer);
      const listed = await as.query(api.scholarMessages.listThreads, { kind: "about" });
      const titleOf = (id: Id<"parentThreads">) =>
        listed.threads.find((x) => x._id === id)?.aboutTitle;
      expect(titleOf(wonder.threadId)).toBe("Why do owls turn their heads so far?");
      expect(titleOf(quest.threadId)).toBe("Angle croc");
      const detail = await as.query(api.scholarMessages.getThread, {
        threadId: wonder.threadId,
      });
      expect(detail?.aboutTitle).toBe("Why do owls turn their heads so far?");
    }
    // A seed that isn't the kid's own wonder names only its kid-facing line:
    // its `topic` is a staff-side label.
    const [plainSeed, invitedSeed] = await t.run(async (ctx) => {
      const make = async (extra: Partial<Doc<"seeds">>) =>
        await ctx.db.insert("seeds", {
          scholarId: w.ana,
          origin: "teacher",
          status: "active",
          topic: "Staff label",
          suggestionType: "teacher_suggestion",
          rationale: "Teacher-facing note.",
          ...extra,
        });
      return [
        await make({}),
        await make({ scholarInvitation: "What would you try first?" }),
      ];
    });
    const staffTitles: (string | undefined)[] = [];
    for (const seedId of [plainSeed, invitedSeed]) {
      const { threadId } = await teacher.mutation(
        api.scholarMessages.openAboutThreadForScholar,
        { scholarId: w.ana, about: { type: "wonder", seedId } },
      );
      const detail = await (await withUser(t, w.ana)).query(api.scholarMessages.getThread, {
        threadId,
      });
      staffTitles.push(detail?.aboutTitle);
    }
    expect(staffTitles).toEqual([undefined, "What would you try first?"]);
    // Mentor rows keep the shape they had.
    const plain = await (await withUser(t, w.ana)).query(api.scholarMessages.listThreads, {});
    expect(plain.threads[0]).not.toHaveProperty("aboutTitle");
    // Another scholar's wonder is never named, even on a hand-built thread.
    const stray = await t.run(async (ctx) => {
      const thread = (await ctx.db.get(wonder.threadId))!;
      const { _id, _creationTime, ...rest } = thread;
      return await ctx.db.insert("parentThreads", {
        ...rest,
        about: { type: "wonder", seedId: w.benWonder },
      });
    });
    const detail = await (await withUser(t, w.ana)).query(api.scholarMessages.getThread, {
      threadId: stray,
    });
    expect(detail?.aboutTitle).toBeUndefined();
  });

  test("a reply-by-email address never reaches an about thread", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { threadId } = await anaThreadWithReply(t, w);
    const result = await t.mutation(internal.parentMessages.ingestInboundEmail, {
      toAddress: `reply+${threadId}@inbound.test`,
      fromEmail: "someone@family.test",
      body: "hello",
    });
    expect(result).toMatchObject({ ok: false, reason: "not-accepted" });
  });
});

describe("mapping a Slack root to a Quest or wonder", () => {
  test("is idempotent and refuses what isn't the scholar's or already routed", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const record = (scholarId: Id<"users">, about: Doc<"aboutSlackThreads">["about"], threadTs = "500.1") =>
      t.mutation(internal.scholarMessages.recordAboutSlackThread, {
        channelId: "C_CLASS",
        threadTs,
        scholarId,
        about,
      });
    const first = await record(w.ana, { type: "wonder", seedId: w.anaWonder });
    expect(first).not.toBeNull();
    expect(await record(w.ana, { type: "wonder", seedId: w.anaWonder })).toBe(first);
    expect(await record(w.ana, { type: "wonder", seedId: w.benWonder })).toBeNull();
    expect(await record(w.ana, { type: "quest", unitId: w.konaUnit })).toBeNull();

    // A root already carrying a family/Workshop conversation keeps its route.
    await t.run(async (ctx) => {
      const familyThread = await ctx.db.insert("parentThreads", {
        parentUserId: w.parent,
        scholarId: w.ana,
        institutionId: w.moli,
        lastMessageAt: 1,
      });
      await ctx.db.insert("parentSlackThreads", {
        parentThreadId: familyThread,
        channelId: "C_CLASS",
        threadTs: "700.1",
        lastNotifiedAt: 1,
      });
    });
    expect(await record(w.ana, { type: "wonder", seedId: w.anaWonder }, "700.1")).toBeNull();
    // Mapping alone opens no conversation.
    expect(await aboutThreads(t)).toHaveLength(0);
  });
});

// The first test here pays for loading slackBot.ts and everything it imports
// (12-15 s on a loaded host, past the 20 s default under heavier load), so
// this block gets a longer per-test budget. Nothing here waits on a clock.
describe("a teacher's Slack reply under a mapped root", { timeout: 60_000 }, () => {
  const CHANNEL = "C_CLASS";

  type Call = { method: string; body: Record<string, string> };

  function stubSlack(calls: Call[], rootTs: string, opts: { authTest?: boolean } = {}) {
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop() ?? "";
      const raw = String(init?.body ?? "");
      const body = raw.startsWith("{")
        ? (JSON.parse(raw) as Record<string, string>)
        : Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method, body });
      if (method === "conversations.replies") {
        return Response.json({
          ok: true,
          messages: [{ ts: rootTs, bot_id: "B_BOT", text: "Today's wonders" }],
        });
      }
      if (method === "auth.test") {
        // The bot token's own workspace (or Slack failing to say).
        return opts.authTest === false
          ? Response.json({ ok: false, error: "invalid_auth" })
          : Response.json({ ok: true, user_id: "B_BOT", bot_id: "BBOT", team_id: "T1" });
      }
      return Response.json({ ok: true, ts: "999.9" });
    }) as typeof fetch;
  }

  async function reply(
    t: T,
    args: {
      eventId: string;
      user: string;
      text: string;
      threadTs: string;
      ts: string;
      teamId?: string;
      type?: "message" | "app_mention";
      noAuthorizations?: boolean;
    },
  ) {
    await t.action(internal.slackBot.handleEvent, {
      payload: {
        team_id: args.teamId ?? "T1",
        event_id: args.eventId,
        authorizations: args.noAuthorizations ? [] : [{ user_id: "B_BOT", is_bot: true }],
        event: {
          type: args.type ?? "message",
          user: args.user,
          text: args.text,
          channel: CHANNEL,
          channel_type: "channel",
          ts: args.ts,
          thread_ts: args.threadTs,
        },
      },
    });
  }

  async function staffMessagesAbout(t: T, scholarId: Id<"users">, seedId: Id<"seeds">) {
    return await t.run(async (ctx) => {
      const thread = (
        await ctx.db
          .query("parentThreads")
          .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
          .collect()
      ).find((x) => threadFlavor(x) === "about" && x.about?.type === "wonder" && x.about.seedId === seedId);
      if (!thread) return null;
      return (
        await ctx.db
          .query("parentMessages")
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .collect()
      ).filter((m) => m.authorType === "teacher");
    });
  }

  test("a root with one line: the reply lands in that thread and gets a ✅", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.mutation(internal.scholarMessages.recordAboutSlackThread, {
      channelId: CHANNEL,
      threadTs: "500.1",
      scholarId: w.ana,
      about: { type: "wonder", seedId: w.anaWonder },
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "500.1");

    await reply(t, {
      eventId: "EvAbout1",
      user: "U_TEACH",
      text: "Count the bones in your own neck tonight.",
      threadTs: "500.1",
      ts: "500.2",
    });

    const messages = await staffMessagesAbout(t, w.ana, w.anaWonder);
    expect(messages).toHaveLength(1);
    expect(messages![0]).toMatchObject({
      body: "Count the bones in your own neck tonight.",
      authorUserId: w.teacher,
      source: "slack",
    });
    expect(calls.find((c) => c.method === "reactions.add")?.body).toMatchObject({
      channel: CHANNEL,
      timestamp: "500.2",
      name: "white_check_mark",
    });
    expect(calls.some((c) => c.method === "chat.postMessage")).toBe(false);
  });

  test("a day's note: the reply goes to the scholar it names, and only there", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    for (const [scholarId, seedId] of [
      [w.ana, w.anaWonder],
      [w.ben, w.benWonder],
    ] as const) {
      await t.mutation(internal.scholarMessages.recordAboutSlackThread, {
        channelId: CHANNEL,
        threadTs: "600.1",
        scholarId,
        about: { type: "wonder", seedId },
      });
    }
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "600.1");

    await reply(t, {
      eventId: "EvAboutBen",
      user: "U_TEACH",
      text: "Ben, try listing the primes up to 50 first.",
      threadTs: "600.1",
      ts: "600.2",
    });
    expect(await staffMessagesAbout(t, w.ben, w.benWonder)).toHaveLength(1);
    expect(await staffMessagesAbout(t, w.ana, w.anaWonder)).toBeNull();

    // A reply that names nobody (or everybody) is refused out loud.
    await reply(t, {
      eventId: "EvAboutNobody",
      user: "U_TEACH",
      text: "Great questions today!",
      threadTs: "600.1",
      ts: "600.3",
    });
    await reply(t, {
      eventId: "EvAboutBoth",
      user: "U_TEACH",
      text: "Ana and Ben, come find me.",
      threadTs: "600.1",
      ts: "600.4",
    });
    expect(await staffMessagesAbout(t, w.ana, w.anaWonder)).toBeNull();
    expect(await staffMessagesAbout(t, w.ben, w.benWonder)).toHaveLength(1);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(2);
  });

  test("nobody but a teacher at the scholar's school gets through", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.mutation(internal.scholarMessages.recordAboutSlackThread, {
      channelId: CHANNEL,
      threadTs: "800.1",
      scholarId: w.ana,
      about: { type: "wonder", seedId: w.anaWonder },
    });
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "800.1");

    let n = 0;
    for (const user of ["U_KONA", "U_MENTOR", "U_PARENT", "U_NOBODY"]) {
      n += 1;
      await reply(t, {
        eventId: `EvAboutStranger${n}`,
        user,
        text: "Ana, here is something.",
        threadTs: "800.1",
        ts: `800.${n + 1}`,
      });
    }
    // Nothing landed, and no conversation was even opened.
    expect(await aboutThreads(t)).toHaveLength(0);
    expect(calls.some((c) => c.method === "reactions.add")).toBe(false);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(4);

    // The mutation holds the line on its own too: a Kona teacher passing
    // the role pre-check is refused at the school check.
    const mappingId = await t.run(async (ctx) =>
      (await ctx.db.query("aboutSlackThreads").first())!._id,
    );
    expect(
      await t.mutation(internal.scholarMessages.recordAboutSlackReply, {
        mappingId,
        channelId: CHANNEL,
        threadTs: "800.1",
        authorId: w.konaTeacher,
        body: "hi",
      }),
    ).toEqual({ status: "forbidden" });
    expect(
      await t.mutation(internal.scholarMessages.recordAboutSlackReply, {
        mappingId,
        channelId: CHANNEL,
        threadTs: "999.1", // not this mapping's root
        authorId: w.teacher,
        body: "hi",
      }),
    ).toEqual({ status: "not_found" });
    expect(await aboutThreads(t)).toHaveLength(0);
  });

  async function mapAnaWonder(t: T, w: World, threadTs: string) {
    await t.mutation(internal.scholarMessages.recordAboutSlackThread, {
      channelId: CHANNEL,
      threadTs,
      scholarId: w.ana,
      about: { type: "wonder", seedId: w.anaWonder },
    });
  }

  test("a root about one scholar refuses a reply that names a schoolmate", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await mapAnaWonder(t, w, "510.1");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "510.1");

    // Ben is at Ana's school but on no line here: it must not reach Ana.
    await reply(t, {
      eventId: "EvAboutBenUnderAna",
      user: "U_TEACH",
      text: "Ben, try the primes up to 50.",
      threadTs: "510.1",
      ts: "510.2",
    });
    await reply(t, {
      eventId: "EvAboutBenFullName",
      user: "U_TEACH",
      text: "Ben Test: come find me.",
      threadTs: "510.1",
      ts: "510.3",
    });
    // Slack markup in front of (or around) the name changes nothing.
    await reply(t, {
      eventId: "EvAboutBenBold",
      user: "U_TEACH",
      text: "&gt; :wave: <@U123> *Ben*, nice work",
      threadTs: "510.1",
      ts: "510.6",
    });
    expect(await aboutThreads(t)).toHaveLength(0);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(3);
    expect(calls.some((c) => c.method === "reactions.add")).toBe(false);

    // Addressing Ana, or nobody, still goes to her.
    await reply(t, {
      eventId: "EvAboutAnaNamed",
      user: "U_TEACH",
      text: "Ana, count the bones in your neck.",
      threadTs: "510.1",
      ts: "510.4",
    });
    await reply(t, {
      eventId: "EvAboutNoAddress",
      user: "U_TEACH",
      text: "Great question, then try a giraffe.",
      threadTs: "510.1",
      ts: "510.5",
    });
    expect(await staffMessagesAbout(t, w.ana, w.anaWonder)).toHaveLength(2);
  });

  test("a day's note never takes a name used as a word for an address", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const will = await t.run(async (ctx) => {
      const will = await ctx.db.insert("users", {
        username: "will",
        name: "Will Test",
        role: "scholar",
        institutionId: w.moli,
      });
      const seedId = await ctx.db.insert("seeds", {
        scholarId: will,
        origin: "teacher",
        status: "active",
        topic: "How do bridges hold up?",
        suggestionType: "teacher_suggestion",
        rationale: "Teacher-facing note.",
      });
      return { will, seedId };
    });
    for (const [scholarId, seedId] of [
      [will.will, will.seedId],
      [w.ben, w.benWonder],
    ] as const) {
      await t.mutation(internal.scholarMessages.recordAboutSlackThread, {
        channelId: CHANNEL,
        threadTs: "560.1",
        scholarId,
        about: { type: "wonder", seedId },
      });
    }
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "560.1");
    let n = 1;
    for (const text of [
      "Great question; we will investigate tomorrow",
      "Will you look at this?",
      "Nice one, Will!",
    ]) {
      n += 1;
      await reply(t, { eventId: `EvAboutWill${n}`, user: "U_TEACH", text, threadTs: "560.1", ts: `560.${n}` });
    }
    expect(await aboutThreads(t)).toHaveLength(0);
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(3);
    await reply(t, {
      eventId: "EvAboutWillAddressed",
      user: "U_TEACH",
      text: "Will, try a paper bridge first.",
      threadTs: "560.1",
      ts: "560.9",
    });
    expect(await staffMessagesAbout(t, will.will, will.seedId)).toHaveLength(1);
  });

  test("only our own workspace, with our bot identity known, gets through", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await mapAnaWonder(t, w, "520.1");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "520.1");

    // A user id from another workspace means nothing here.
    await reply(t, {
      eventId: "EvAboutOtherTeam",
      user: "U_TEACH",
      text: "Ana, hello.",
      threadTs: "520.1",
      ts: "520.2",
      teamId: "T_OTHER",
    });
    expect(await aboutThreads(t)).toHaveLength(0);

    // Our bot's id can't be resolved: a reply that might @-mention us can't
    // be told apart from one for the scholar, so nothing goes.
    const failing: Call[] = [];
    stubSlack(failing, "520.1", { authTest: false });
    await reply(t, {
      eventId: "EvAboutNoBotId",
      user: "U_TEACH",
      text: "Ana, hello.",
      threadTs: "520.1",
      ts: "520.3",
      noAuthorizations: true,
    });
    expect(await aboutThreads(t)).toHaveLength(0);
    expect([...calls, ...failing].some((c) => c.method === "reactions.add")).toBe(false);
    // Handled (nothing fell through to the aide), and nothing was said.
    expect(await t.run(async (ctx) => ctx.db.query("slackThreads").collect())).toHaveLength(0);
  });

  test("an @-mention under an about root never starts the aide", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await mapAnaWonder(t, w, "530.1");
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "530.1");

    await reply(t, {
      eventId: "EvAboutMention",
      type: "app_mention",
      user: "U_TEACH",
      text: "<@B_BOT> what did Ana ask?",
      threadTs: "530.1",
      ts: "530.2",
    });
    // One short visible refusal; no aide thread, and nothing reached Ana.
    const posts = calls.filter((c) => c.method === "chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ channel: CHANNEL, thread_ts: "530.1" });
    expect(calls.some((c) => c.method === "conversations.replies")).toBe(false);
    expect(await t.run(async (ctx) => ctx.db.query("slackThreads").collect())).toHaveLength(0);
    expect(await aboutThreads(t)).toHaveLength(0);
  });

  test("an aide chat's thread can't become an about root", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("slackThreads", {
        channelId: CHANNEL,
        threadTs: "540.1",
        startedByUserId: w.teacher,
        lastActivityAt: 1,
      });
    });
    expect(
      await t.mutation(internal.scholarMessages.recordAboutSlackThread, {
        channelId: CHANNEL,
        threadTs: "540.1",
        scholarId: w.ana,
        about: { type: "wonder", seedId: w.anaWonder },
      }),
    ).toBeNull();
    expect(await t.run(async (ctx) => ctx.db.query("aboutSlackThreads").collect())).toHaveLength(0);
  });

  test("a reply under a root nobody mapped opens nothing", async () => {
    const t = convexTest(schema, modules);
    await seedWorld(t);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    const calls: Call[] = [];
    stubSlack(calls, "900.1");
    await reply(t, {
      eventId: "EvUnmapped",
      user: "U_TEACH",
      text: "Ana, hello.",
      threadTs: "900.1",
      ts: "900.2",
    });
    expect(await aboutThreads(t)).toHaveLength(0);
    expect(calls.some((c) => c.method === "reactions.add")).toBe(false);
  });
});
