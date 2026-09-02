// Backend tests for the Workshop reflection-chat domain (convex/metaChat.ts):
// per-day get-or-create + timezone, ownership, the Prep Time block config, and
// the teacher-visible read. Fixtures mirror the standard set.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import { buildMetaSystemPrompt } from "../metaPrompts";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");
const paginationOpts = { numItems: 100, cursor: null };

afterEach(() => {
  vi.useRealTimers();
});

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role = "scholar",
  overrides: {
    name?: string;
    username?: string;
    institutionId?: Id<"institutions">;
  } = {},
): Promise<Id<"users">> {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username: overrides.username ?? `test${role}`,
      role: role as Doc<"users">["role"],
      ...(overrides.institutionId ? { institutionId: overrides.institutionId } : {}),
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

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  over: { timeZone?: string } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli School",
      slug: `moli-${Math.random()}`,
      kind: "school",
      isPrimary: true,
      ...(over.timeZone ? { timeZone: over.timeZone } : {}),
    }),
  );
}

async function grantTeacherMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", {
      userId,
      role: "teacher",
      institutionId,
    }),
  );
}

// Seed the canonical Scholar's Prep bell block (Move 5: the single source of
// truth for WHEN the ritual runs) — an active Term + a kind:"prep" scheduleBlock.
async function seedPrepSchedule(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  over: {
    startLocal?: string;
    endLocal?: string;
    weekdays?: number[];
    label?: string;
  } = {},
) {
  await t.run(async (ctx) => {
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Term",
      startsAt: 0,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: "open",
      institutionId,
    });
    await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "scholar-practice-lab",
      label: over.label ?? "Scholar’s Prep",
      startLocal: over.startLocal ?? "14:30",
      endLocal: over.endLocal ?? "15:00",
      weekdays: over.weekdays ?? [1, 2, 3, 4],
      order: 8,
      kind: "prep",
    });
  });
}

// A group whose roster contains `scholarIds` and which RUNS the ritual (carries a
// `prepTime` participation entry). The entry's times are vestigial (Move 5).
async function seedParticipatingGroup(
  t: ReturnType<typeof convexTest>,
  teacher: Id<"users">,
  scholarIds: Id<"users">[],
  over: { name?: string; institutionId?: Id<"institutions"> } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      name: over.name ?? "Geckos",
      scholarIds,
      ...(over.institutionId ? { institutionId: over.institutionId } : {}),
      dailyBlocks: [
        {
          key: "prepTime",
          label: "Scholar’s Prep",
          startLocal: "14:30",
          endLocal: "15:00",
          days: [1, 2, 3, 4, 5],
          timezone: "Pacific/Honolulu",
        },
      ],
    }),
  );
}

describe("getOrCreateToday", () => {
  test("idempotent within a day — a second call returns the same thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai1" });
    const asKai = await withUser(t, kai);

    const first = await asKai.mutation(api.metaChat.getOrCreateToday, {});
    const second = await asKai.mutation(api.metaChat.getOrCreateToday, {});
    expect(second.chatId).toBe(first.chatId);

    const chats = await t.run(async (ctx) =>
      ctx.db.query("metaChats").collect(),
    );
    expect(chats).toHaveLength(1);
    expect(chats[0].scholarId).toBe(kai);
  });

  describe("getOrCreateIntrospection", () => {
    test("returns one standing thread, separate from each day's reflection", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
      const t = convexTest(schema, modules);
      const kai = await seedUser(t, "scholar", { username: "kaiAsk" });
      const asKai = await withUser(t, kai);

      const reflection = await asKai.mutation(api.metaChat.getOrCreateToday, {});
      const first = await asKai.mutation(
        api.metaChat.getOrCreateIntrospection,
        {},
      );
      const second = await asKai.mutation(
        api.metaChat.getOrCreateIntrospection,
        {},
      );

      expect(second.chatId).toBe(first.chatId);
      expect(first.chatId).not.toBe(reflection.chatId);
      const row = await t.run(async (ctx) => ctx.db.get(first.chatId));
      expect(row?.purpose).toBe("introspection");
      expect(row?.threadKey).toBe("standing");
      expect(row?.dayKey).toBeUndefined();
    });
  });

  test("scholarId is always the caller — two scholars get separate threads", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai2" });
    const lani = await seedUser(t, "scholar", { username: "lani2" });

    const kaiChat = await (await withUser(t, kai)).mutation(
      api.metaChat.getOrCreateToday,
      {},
    );
    const laniChat = await (await withUser(t, lani)).mutation(
      api.metaChat.getOrCreateToday,
      {},
    );
    expect(kaiChat.chatId).not.toBe(laniChat.chatId);

    const kaiRow = await t.run(async (ctx) => ctx.db.get(kaiChat.chatId));
    expect(kaiRow?.scholarId).toBe(kai);
  });

  test("rejects an unauthenticated caller", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.metaChat.getOrCreateToday, {}),
    ).rejects.toThrow(/Not authenticated/);
  });

  test("dayKey respects the scholar's institution prep timezone", async () => {
    vi.useFakeTimers();
    // 05:00 UTC: Honolulu is still 2026-07-02; Kiritimati is already 2026-07-03.
    vi.setSystemTime(new Date("2026-07-03T05:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "lehuaTz" });
    const kai = await seedUser(t, "scholar", { username: "kaiTz" });

    // No participating pod → default Pacific/Honolulu → 2026-07-02.
    const honoluluDay = await (await withUser(t, kai)).mutation(
      api.metaChat.getOrCreateToday,
      {},
    );
    expect(honoluluDay.dayKey).toBe("2026-07-02");

    // Move 5: the window's timezone now comes from the scholar's INSTITUTION (its
    // bell-schedule prep block), not the group entry. Put Lani in a Kiritimati
    // institution that runs Scholar's Prep → 2026-07-03.
    const institutionId = await seedInstitution(t, {
      timeZone: "Pacific/Kiritimati",
    });
    await seedPrepSchedule(t, institutionId);
    const lani = await seedUser(t, "scholar", {
      username: "laniTz",
      institutionId,
    });
    await seedParticipatingGroup(t, teacher, [lani], {
      name: "Line Islands",
      institutionId,
    });
    const kiritimatiDay = await (await withUser(t, lani)).mutation(
      api.metaChat.getOrCreateToday,
      {},
    );
    expect(kiritimatiDay.dayKey).toBe("2026-07-03");
  });
});

describe("myPrepTimeBlock", () => {
  test("null when the caller's pod doesn't run the ritual", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai3" });
    const res = await (await withUser(t, kai)).query(
      api.metaChat.myPrepTimeBlock,
      {},
    );
    expect(res).toBeNull();
  });

  test("returns the institution's canonical window when the pod participates", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    await seedPrepSchedule(t, institutionId);
    const teacher = await seedUser(t, "teacher", { username: "lehua4" });
    const kai = await seedUser(t, "scholar", {
      username: "kai4",
      institutionId,
    });
    await seedParticipatingGroup(t, teacher, [kai], { institutionId });
    const res = await (await withUser(t, kai)).query(
      api.metaChat.myPrepTimeBlock,
      {},
    );
    expect(res?.key).toBe("prepTime");
    expect(res?.label).toBe("Scholar’s Prep");
    expect(res?.startLocal).toBe("14:30");
    expect(res?.endLocal).toBe("15:00");
    // The bell block's `weekdays` map to the window's `days`.
    expect(res?.days).toEqual([1, 2, 3, 4]);
  });

  test("a scholar in MULTIPLE pods gets ONE deterministic window (no arbitrary pick)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    await seedPrepSchedule(t, institutionId);
    const teacher = await seedUser(t, "teacher", { username: "lehuaMulti" });
    const kai = await seedUser(t, "scholar", {
      username: "kaiMulti",
      institutionId,
    });
    // Two participating pods, each with different (now-vestigial) entry times.
    await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Pod A",
        scholarIds: [kai],
        institutionId,
        dailyBlocks: [
          {
            key: "prepTime",
            label: "Scholar’s Prep",
            startLocal: "09:00",
            endLocal: "09:30",
            days: [1],
            timezone: "Pacific/Honolulu",
          },
        ],
      }),
    );
    await seedParticipatingGroup(t, teacher, [kai], {
      name: "Pod B",
      institutionId,
    });
    const res = await (await withUser(t, kai)).query(
      api.metaChat.myPrepTimeBlock,
      {},
    );
    // Always the bell block, regardless of which pod / how many.
    expect(res?.startLocal).toBe("14:30");
    expect(res?.endLocal).toBe("15:00");
  });

  test("does NOT show the ritual for a scholar whose pod has no prepTime entry", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    await seedPrepSchedule(t, institutionId);
    const teacher = await seedUser(t, "teacher", { username: "lehua5" });
    const kai = await seedUser(t, "scholar", {
      username: "kai5",
      institutionId,
    });
    // Kai's pod runs NO ritual (no prepTime entry), even though the school has a
    // bell block.
    await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Robotics",
        scholarIds: [kai],
        institutionId,
      }),
    );
    const res = await (await withUser(t, kai)).query(
      api.metaChat.myPrepTimeBlock,
      {},
    );
    expect(res).toBeNull();
  });

  test("teacher remote mode can read a scholar's canonical window", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    await seedPrepSchedule(t, institutionId);
    const teacher = await seedUser(t, "teacher", { username: "lehuaRemote" });
    await grantTeacherMembership(t, teacher, institutionId);
    const kai = await seedUser(t, "scholar", {
      username: "kaiRemotePrep",
      institutionId,
    });
    await seedParticipatingGroup(t, teacher, [kai], {
      name: "Geckos Remote",
      institutionId,
    });

    const res = await (await withUser(t, teacher)).query(
      api.metaChat.myPrepTimeBlock,
      { userId: kai },
    );
    expect(res?.key).toBe("prepTime");
    expect(res?.startLocal).toBe("14:30");
  });

  test("a scholar cannot pass another scholar's userId", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "lehuaGate" });
    const kai = await seedUser(t, "scholar", { username: "kaiGate" });
    const lani = await seedUser(t, "scholar", { username: "laniGate" });
    await seedParticipatingGroup(t, teacher, [lani], { name: "Lani's group" });

    await expect(
      (await withUser(t, kai)).query(api.metaChat.myPrepTimeBlock, {
        userId: lani,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

// The client-visible Workshop flag signal — proves the deployment env var is
// server-authored to the client (never a client env guess). The Workshop uses
// `ideaConvosEnabled` to hide the redundant standalone idea-composer box.
describe("workshopFlags", () => {
  const FLAG = "WORKSHOP_IDEA_CONVOS_ENABLED";
  afterEach(() => {
    delete process.env[FLAG];
  });

  test("ideaConvosEnabled is false by default (flag absent → ships dark)", async () => {
    const t = convexTest(schema, modules);
    delete process.env[FLAG];
    const kai = await seedUser(t, "scholar", { username: "kai6" });
    const res = await (await withUser(t, kai)).query(
      api.metaChat.workshopFlags,
      {},
    );
    expect(res).toEqual({ ideaConvosEnabled: false });
  });

  test("ideaConvosEnabled is true when the deployment flag is on", async () => {
    const t = convexTest(schema, modules);
    process.env[FLAG] = "true";
    const kai = await seedUser(t, "scholar", { username: "kai7" });
    const res = await (await withUser(t, kai)).query(
      api.metaChat.workshopFlags,
      {},
    );
    expect(res).toEqual({ ideaConvosEnabled: true });
  });
});

describe("setGroupDailyBlock", () => {
  async function seedGroup(t: ReturnType<typeof convexTest>, teacher: Id<"users">) {
    return await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Geckos",
        scholarIds: [],
      }),
    );
  }

  test("enabling is participation-only — no times required (Move 5)", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "lehua6" });
    const groupId = await seedGroup(t, teacher);
    const asTeacher = await withUser(t, teacher);

    // Turning the ritual on takes no window args — the bell schedule owns WHEN.
    await asTeacher.mutation(api.metaChat.setGroupDailyBlock, { groupId });
    let group = await t.run(async (ctx) => ctx.db.get(groupId));
    expect(group?.dailyBlocks).toHaveLength(1);
    expect(group?.dailyBlocks?.[0].key).toBe("prepTime");
    expect(group?.dailyBlocks?.[0].label).toBe("Scholar’s Prep");

    // Upsert (not append) — a second enable replaces the single prepTime entry.
    await asTeacher.mutation(api.metaChat.setGroupDailyBlock, { groupId });
    group = await t.run(async (ctx) => ctx.db.get(groupId));
    expect(group?.dailyBlocks).toHaveLength(1);
  });

  test("remove clears the prepTime entry", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "lehua7" });
    const groupId = await seedGroup(t, teacher);
    const asTeacher = await withUser(t, teacher);
    await asTeacher.mutation(api.metaChat.setGroupDailyBlock, { groupId });
    await asTeacher.mutation(api.metaChat.setGroupDailyBlock, {
      groupId,
      remove: true,
    });
    const group = await t.run(async (ctx) => ctx.db.get(groupId));
    expect(group?.dailyBlocks).toEqual([]);
  });

  test("a scholar is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "lehua8" });
    const scholar = await seedUser(t, "scholar", { username: "kai8" });
    const groupId = await seedGroup(t, teacher);
    await expect(
      (await withUser(t, scholar)).mutation(api.metaChat.setGroupDailyBlock, {
        groupId,
      }),
    ).rejects.toThrow(/Forbidden|teacher/i);
  });
});

describe("sendMessage + listMessages ownership", () => {
  test("persists a user turn + empty assistant row; only the owner can read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai10" });
    const mallory = await seedUser(t, "scholar", { username: "mallory10" });
    const asKai = await withUser(t, kai);

    const { chatId } = await asKai.mutation(api.metaChat.getOrCreateToday, {});
    const { assistantMsgId, streamId } = await asKai.mutation(
      api.metaChat.sendMessage,
      { chatId, content: "Today was hard but I got the fraction thing." },
    );
    expect(streamId).toBeTruthy();

    const mine = await asKai.query(api.metaChat.listMessages, {
      chatId,
      paginationOpts,
    });
    expect(mine.page).toHaveLength(2);
    expect(mine.page[0].role).toBe("assistant");
    expect(mine.page[1].role).toBe("user");
    expect(mine.page[0]._id).toBe(assistantMsgId);
    expect(mine.page[0].content).toBe("");

    // Another scholar can't read this thread.
    const notMine = await (await withUser(t, mallory)).query(
      api.metaChat.listMessages,
      { chatId, paginationOpts },
    );
    expect(notMine.page).toEqual([]);
  });

  test('the "<start>" opener sentinel is never persisted as a user turn (native client parity)', async () => {
    // The native client opens an empty thread by sending "<start>" through the
    // normal sendMessage path (web uses startOpener). The sentinel must not
    // land in metaMessages: the /meta-stream empty-thread branch materializes
    // the opener, and a persisted "<start>" would render as a literal bubble
    // in web transcripts and reach the model unexplained.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai11" });
    const asKai = await withUser(t, kai);

    const { chatId } = await asKai.mutation(api.metaChat.getOrCreateToday, {});
    const { assistantMsgId, streamId } = await asKai.mutation(
      api.metaChat.sendMessage,
      { chatId, content: "<start>" },
    );
    expect(streamId).toBeTruthy();

    const mine = await asKai.query(api.metaChat.listMessages, {
      chatId,
      paginationOpts,
    });
    // Only the empty assistant placeholder — no "<start>" user row.
    expect(mine.page).toHaveLength(1);
    expect(mine.page[0].role).toBe("assistant");
    expect(mine.page[0]._id).toBe(assistantMsgId);
    expect(mine.page.some((m) => m.content === "<start>")).toBe(false);
  });

  test("sendMessage into someone else's chat is Forbidden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai11" });
    const mallory = await seedUser(t, "scholar", { username: "mallory11" });
    const { chatId } = await (await withUser(t, kai)).mutation(
      api.metaChat.getOrCreateToday,
      {},
    );
    await expect(
      (await withUser(t, mallory)).mutation(api.metaChat.sendMessage, {
        chatId,
        content: "sneaky",
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("listForScholar (teacher-visible by design)", () => {
  test("a teacher can read a scholar's most recent reflection thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    const teacher = await seedUser(t, "teacher", {
      username: "lehua12",
      institutionId,
    });
    const kai = await seedUser(t, "scholar", {
      username: "kai12",
      institutionId,
    });
    await grantTeacherMembership(t, teacher, institutionId);
    const asKai = await withUser(t, kai);
    const { chatId } = await asKai.mutation(api.metaChat.getOrCreateToday, {});
    await asKai.mutation(api.metaChat.sendMessage, {
      chatId,
      content: "the drawing helped",
    });

    const view = await (await withUser(t, teacher)).query(
      api.metaChat.listForScholar,
      { scholarId: kai, paginationOpts },
    );
    expect(view?.chatId).toBe(chatId);
    expect(view?.messages.page[1].content).toBe("the drawing helped");
  });

  test("a scholar calling the teacher read is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kai13" });
    await expect(
      (await withUser(t, kai)).query(api.metaChat.listForScholar, {
        scholarId: kai,
        paginationOpts,
      }),
    ).rejects.toThrow(/Forbidden|teacher/i);
  });

  test("a teacher cannot read a scholar in another institution", async () => {
    const t = convexTest(schema, modules);
    const firstInstitution = await seedInstitution(t);
    const secondInstitution = await t.run(async (ctx) =>
      ctx.db.insert("institutions", {
        name: "Other School",
        slug: "other-school",
        kind: "school",
        isPrimary: false,
      }),
    );
    const teacher = await seedUser(t, "teacher", {
      username: "lehuaScoped",
      institutionId: firstInstitution,
    });
    const scholar = await seedUser(t, "scholar", {
      username: "kaiElsewhere",
      institutionId: secondInstitution,
    });
    await grantTeacherMembership(t, teacher, firstInstitution);

    await expect(
      (await withUser(t, teacher)).query(api.metaChat.listForScholar, {
        scholarId: scholar,
        paginationOpts,
      }),
    ).rejects.toThrow(/access|institution|Forbidden/i);
  });
});

describe("startOpener", () => {
  test("creates one empty assistant row on an empty thread", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiOpen1" });
    const asKai = await withUser(t, kai);
    const { chatId } = await asKai.mutation(api.metaChat.getOrCreateToday, {});

    const res = await asKai.mutation(api.metaChat.startOpener, { chatId });
    expect(res).not.toBeNull();
    expect(res?.streamId).toBeTruthy();

    const msgs = await asKai.query(api.metaChat.listMessages, {
      chatId,
      paginationOpts,
    });
    expect(msgs.page).toHaveLength(1);
    expect(msgs.page[0].role).toBe("assistant");
    expect(msgs.page[0].content).toBe("");
    expect(msgs.page[0]._id).toBe(res?.assistantMsgId);
  });

  test("returns null when the thread already has messages (no double opener)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiOpen2" });
    const asKai = await withUser(t, kai);
    const { chatId } = await asKai.mutation(api.metaChat.getOrCreateToday, {});
    await asKai.mutation(api.metaChat.sendMessage, { chatId, content: "hi" });

    const res = await asKai.mutation(api.metaChat.startOpener, { chatId });
    expect(res).toBeNull();
  });

  test("opening into someone else's chat is Forbidden", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiOpen3" });
    const mallory = await seedUser(t, "scholar", { username: "malloryOpen3" });
    const { chatId } = await (await withUser(t, kai)).mutation(
      api.metaChat.getOrCreateToday,
      {},
    );
    await expect(
      (await withUser(t, mallory)).mutation(api.metaChat.startOpener, { chatId }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("groupPrepTimeBlock", () => {
  test("null when the pod doesn't run the ritual; canonical window once it does", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t);
    await seedPrepSchedule(t, institutionId);
    const teacher = await seedUser(t, "teacher", { username: "lehuaGP" });
    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Geckos",
        scholarIds: [],
        institutionId,
      }),
    );
    const asTeacher = await withUser(t, teacher);
    expect(
      await asTeacher.query(api.metaChat.groupPrepTimeBlock, { groupId }),
    ).toBeNull();

    // Turn participation on → the group now reports the school's canonical
    // bell-schedule window (not the entry's vestigial times).
    await asTeacher.mutation(api.metaChat.setGroupDailyBlock, { groupId });
    const block = await asTeacher.query(api.metaChat.groupPrepTimeBlock, {
      groupId,
    });
    expect(block?.key).toBe("prepTime");
    expect(block?.startLocal).toBe("14:30");
    expect(block?.endLocal).toBe("15:00");
    expect(block?.days).toEqual([1, 2, 3, 4]);
  });

  test("a scholar is Forbidden", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher", { username: "lehuaGP2" });
    const scholar = await seedUser(t, "scholar", { username: "kaiGP2" });
    const groupId = await t.run(async (ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: teacher,
        name: "Geckos",
        scholarIds: [],
      }),
    );
    await expect(
      (await withUser(t, scholar)).query(api.metaChat.groupPrepTimeBlock, { groupId }),
    ).rejects.toThrow(/Forbidden|teacher/i);
  });
});

// ── The homescreen "Today's reflection" snippet query ──────────────────────
describe("myReflectionSnippet", () => {
  async function seedSession(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
    fields: {
      title: string;
      lastMessageAt?: number;
      isArchived?: boolean;
      isTestDrive?: boolean;
      isOffline?: boolean;
    },
  ) {
    return await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        title: fields.title,
        isArchived: fields.isArchived ?? false,
        lastMessageAt: fields.lastMessageAt,
        isTestDrive: fields.isTestDrive,
        isOffline: fields.isOffline,
      }),
    );
  }

  test("names what the scholar did on Rabbithole today (default Honolulu tz)", async () => {
    vi.useFakeTimers();
    // 20:00 UTC → 10:00 HST on 2026-07-03.
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiSnip1" });
    await seedSession(t, kai, { title: "Free write", lastMessageAt: Date.now() });

    const res = await (await withUser(t, kai)).query(
      api.metaChat.myReflectionSnippet,
      {},
    );
    expect(res.subtitle).toBe("You worked on Free write today — how'd it go?");
  });

  test("null when nothing happened today — the client keeps its static fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiSnip2" });
    // A session from a previous day is not "today".
    await seedSession(t, kai, {
      title: "Old work",
      lastMessageAt: new Date("2026-07-01T20:00:00Z").getTime(),
    });

    const res = await (await withUser(t, kai)).query(
      api.metaChat.myReflectionSnippet,
      {},
    );
    expect(res.subtitle).toBeNull();
  });

  test("excludes archived / test-drive / offline sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiSnip3" });
    const now = Date.now();
    await seedSession(t, kai, { title: "Archived", isArchived: true, lastMessageAt: now });
    await seedSession(t, kai, { title: "Drive", isTestDrive: true, lastMessageAt: now });
    await seedSession(t, kai, { title: "Offline", isOffline: true, lastMessageAt: now });

    const res = await (await withUser(t, kai)).query(
      api.metaChat.myReflectionSnippet,
      {},
    );
    expect(res.subtitle).toBeNull();
  });
});

// ── The day's actual record (getContext + snippet grounding) ───────────────
// The reflection must know the day's REAL record beyond chat sessions —
// morning math is pure practice and produces no session, which is exactly the
// gap the week-1 pilot flagged (the wrap-up improvised, even fabricating a
// problem that never happened). These prove the record is assembled from the
// per-scholar practice/completion/badge tables, day-scoped in the block
// timezone.
describe("today's record", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("getContext returns today's practice, placements, completions, and badges — yesterday excluded", async () => {
    vi.useFakeTimers();
    // 20:00 UTC → 10:00 HST on 2026-07-03 (default Honolulu timezone).
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { name: "Kai Nakamura", username: "kaiTR1" });
    const now = Date.now();
    const chatId = await t.run(async (ctx) =>
      ctx.db.insert("metaChats", {
        scholarId: kai,
        purpose: "reflection",
        threadKey: "2026-07-03",
        dayKey: "2026-07-03",
        createdAt: now,
        lastMessageAt: now,
      }),
    );

    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "mult_2x2",
        label: "2-digit × 2-digit multiplication",
        domain: "whole-number-arithmetic",
      });
      // Drilled TODAY (lastAttemptAt — the honest stamp).
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "mult_2x2",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 1,
        frontier: true,
        source: "practice",
        updatedAt: now,
        lastAttemptAt: now,
      });
      // Drilled two days ago — must be excluded.
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "old_skill",
        domain: "whole-number-arithmetic",
        repetition: 4,
        halfLifeDays: 2,
        frontier: false,
        source: "practice",
        updatedAt: now,
        lastAttemptAt: now - 2 * DAY,
      });
      // A placement row with a real lastPracticedAt-style insert but NO attempt
      // today must not count as drilling (inferred credit, no lastAttemptAt).
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "placed_skill",
        domain: "fraction-arithmetic",
        repetition: 3,
        halfLifeDays: 0.5,
        frontier: false,
        source: "placement",
        updatedAt: now,
      });
      // Placement check FINISHED today in fractions (completion is the last
      // write, so updatedAt is the completion stamp).
      await ctx.db.insert("practicePlacements", {
        scholarId: kai,
        domain: "fraction-arithmetic",
        status: "complete",
        probesAnswered: 8,
        updatedAt: now,
      });
      // An in-progress placement touched today must NOT count as finished.
      await ctx.db.insert("practicePlacements", {
        scholarId: kai,
        domain: "probability",
        status: "in_progress",
        probesAnswered: 2,
        updatedAt: now,
      });
      // Activity completed today.
      const activityId = await ctx.db.insert("activities", {
        title: "Convince me — pizza fractions",
        kind: "online",
        systemPrompt: "…",
        order: 0,
      });
      await ctx.db.insert("activityCompletions", {
        scholarId: kai,
        activityId,
        completedAt: now,
      });
      // Badge earned today + a stale one.
      await ctx.db.insert("scholarUnitBadges", {
        scholarId: kai,
        earnedAt: now,
        badgeSnapshot: { title: "Fraction Sense — completed" },
      });
      await ctx.db.insert("scholarUnitBadges", {
        scholarId: kai,
        earnedAt: now - 10 * DAY,
        badgeSnapshot: { title: "Ancient History" },
      });
    });

    const c = await t.query(internal.metaChat.getContext, { chatId });
    expect(c?.todayRecord?.practice).toEqual([
      // Domains sort by slug: fraction-arithmetic < whole-number-arithmetic.
      { domainLabel: "Fractions", skillLabels: [], placedToday: true },
      {
        domainLabel: "Whole-number arithmetic",
        skillLabels: ["2-digit × 2-digit multiplication"],
        placedToday: false,
      },
    ]);
    expect(c?.todayRecord?.completedActivities).toEqual([
      "Convince me — pizza fractions",
    ]);
    expect(c?.todayRecord?.badges).toEqual(["Fraction Sense — completed"]);

    // And the built prompt grounds "Today's context" in the record.
    const prompt = buildMetaSystemPrompt({
      firstName: c!.firstName,
      readingLevel: c!.readingLevel,
      todaySessions: c!.todaySessions,
      todayRecord: c!.todayRecord,
      weeklyGrowth: c!.weeklyGrowth,
      openIdeas: c!.openIdeas,
      ideaUpdates: c!.ideaUpdates,
      credits: c!.credits,
    });
    expect(prompt).toContain(
      "- Practiced Whole-number arithmetic: 2-digit × 2-digit multiplication",
    );
    expect(prompt).toContain(
      "- Finished a placement check in Fractions — found their starting spot",
    );
    expect(prompt).not.toContain("No sessions on Rabbithole today");
    expect(prompt).toContain(
      "never assert or invent a specific problem, activity, or result",
    );
  });

  test("a stale completed placement whose updatedAt was bumped today does NOT count as placed today", async () => {
    // A later patch to an already-complete row bumps updatedAt (historically
    // the retired explanation cache; still e.g. maintenance sweeps) — the
    // completion moment is the last probe's `at` (immutable), so a days-old
    // placement must not resurface as "finished today" just because some
    // patch landed today.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiTR4" });
    const now = Date.now();
    const chatId = await t.run(async (ctx) =>
      ctx.db.insert("metaChats", {
        scholarId: kai,
        purpose: "reflection",
        threadKey: "2026-07-03",
        dayKey: "2026-07-03",
        createdAt: now,
        lastMessageAt: now,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId: kai,
        domain: "fraction-arithmetic",
        status: "complete",
        probesAnswered: 2,
        probeLog: [
          { nodeKey: "a", strand: "s", outcome: "correct", at: now - 3 * DAY },
          {
            nodeKey: "b",
            strand: "s",
            outcome: "unknown",
            at: now - 3 * DAY,
            explanation: "cached today",
          },
        ],
        updatedAt: now, // bumped by the explanation-caching patch
      });
    });
    const c = await t.query(internal.metaChat.getContext, { chatId });
    expect(c?.todayRecord?.practice).toEqual([]);
  });

  test("a quiet day yields an all-empty record", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiTR2" });
    const now = Date.now();
    const chatId = await t.run(async (ctx) =>
      ctx.db.insert("metaChats", {
        scholarId: kai,
        purpose: "reflection",
        threadKey: "2026-07-03",
        dayKey: "2026-07-03",
        createdAt: now,
        lastMessageAt: now,
      }),
    );
    const c = await t.query(internal.metaChat.getContext, { chatId });
    expect(c?.todayRecord).toEqual({
      practice: [],
      completedActivities: [],
      badges: [],
    });
  });

  test("myReflectionSnippet names practice on a practice-only day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiTR3" });
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "skip_counting",
        domain: "whole-number-arithmetic",
        repetition: 1,
        halfLifeDays: 1,
        frontier: true,
        source: "practice",
        updatedAt: now,
        lastAttemptAt: now,
      });
    });
    const res = await (await withUser(t, kai)).query(
      api.metaChat.myReflectionSnippet,
      {},
    );
    expect(res.subtitle).toBe(
      "You worked on Whole-number arithmetic practice today — how'd it go?",
    );
  });
});

// ── The credit moment (getContext → prompt → build-time stamp) ─────────────
// Proves the whole flow: an undelivered credit surfaces in the reflection
// prompt exactly once, and stamping it delivered at prompt-build time means the
// SECOND build omits it (the same at-most-once semantics as markResponsesSeen).
describe("credit moment", () => {
  async function seedChat(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
    const now = Date.now();
    return await t.run(async (ctx) =>
      ctx.db.insert("metaChats", {
        scholarId,
        purpose: "reflection",
        threadKey: "2026-07-03",
        dayKey: "2026-07-03",
        createdAt: now,
        lastMessageAt: now,
      }),
    );
  }

  test("undelivered credit surfaces once; build-time stamp omits it next build", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { name: "Kai Nakamura", username: "kaiCM1" });
    const chatId = await seedChat(t, kai);
    await t.run(async (ctx) =>
      ctx.db.insert("changelogEntries", {
        title: "Night Sky mode",
        kidBody: "The Sky can go dark now.",
        creditedScholarIds: [kai],
        creditDelivered: [],
        createdByUserId: kai,
        createdAt: 1,
      }),
    );

    // First build: the credit is undelivered → present in context + prompt.
    const ctx1 = await t.query(internal.metaChat.getContext, { chatId });
    expect(ctx1?.credits).toEqual([{ title: "Night Sky mode" }]);
    expect(ctx1?.creditDeliverIds).toHaveLength(1);
    const prompt1 = buildMetaSystemPrompt({
      firstName: ctx1!.firstName,
      readingLevel: ctx1!.readingLevel,
      todaySessions: ctx1!.todaySessions,
      openIdeas: ctx1!.openIdeas,
      ideaUpdates: ctx1!.ideaUpdates,
      credits: ctx1!.credits,
    });
    expect(prompt1).toContain("## A credit to deliver");
    expect(prompt1).toContain('"Night Sky mode"');

    // Stamp delivered at build time (what /meta-stream does).
    await t.mutation(internal.changelog.markCreditDelivered, {
      entryIds: ctx1!.creditDeliverIds,
      scholarId: kai,
      at: Date.now(),
    });

    // Second build: nothing left to deliver → section omitted.
    const ctx2 = await t.query(internal.metaChat.getContext, { chatId });
    expect(ctx2?.credits).toEqual([]);
    expect(ctx2?.creditDeliverIds).toHaveLength(0);
    const prompt2 = buildMetaSystemPrompt({
      firstName: ctx2!.firstName,
      readingLevel: ctx2!.readingLevel,
      todaySessions: ctx2!.todaySessions,
      openIdeas: ctx2!.openIdeas,
      ideaUpdates: ctx2!.ideaUpdates,
      credits: ctx2!.credits,
    });
    expect(prompt2).not.toContain("## A credit to deliver");
  });

  test("no credit for this scholar → no section", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiCM2" });
    const other = await seedUser(t, "scholar", { username: "otherCM2" });
    const chatId = await seedChat(t, kai);
    await t.run(async (ctx) =>
      ctx.db.insert("changelogEntries", {
        title: "Someone else's feature",
        kidBody: "x",
        creditedScholarIds: [other],
        creditDelivered: [],
        createdByUserId: other,
        createdAt: 1,
      }),
    );
    const ctx1 = await t.query(internal.metaChat.getContext, { chatId });
    expect(ctx1?.credits).toEqual([]);
  });
});

// ── Weekly growth (getContext) ─────────────────────────────────────────────
// Proves getContext assembles the "how you've grown this past week" facts by
// reusing the /me surfaces (deriveGrowthStories + practiceMastery crossing
// stamps + badges), windowed to the last week, LABELS only.
describe("weekly growth", () => {
  const DAY = 24 * 60 * 60 * 1000;

  async function seedChatNow(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
  ) {
    const now = Date.now();
    return await t.run(async (ctx) =>
      ctx.db.insert("metaChats", {
        scholarId,
        purpose: "reflection",
        threadKey: "2026-07-05",
        dayKey: "2026-07-05",
        createdAt: now,
        lastMessageAt: now,
      }),
    );
  }

  async function seedObservation(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    over: { conceptLabel: string; masteryLevel: number; observedAt: number },
  ) {
    await t.run(async (ctx) =>
      ctx.db.insert("masteryObservations", {
        scholarId,
        conceptLabel: over.conceptLabel,
        domain: "science",
        observedAt: over.observedAt,
        transcriptExcerpt: "I figured out that the load splits between the ropes.",
        masteryLevel: over.masteryLevel,
        confidenceScore: 0.8,
        evidenceSummary: "reasoned about mechanical advantage",
        evidenceType: "session_observation",
        attemptContext: "project",
        studentInitiated: true,
        isSuperseded: false,
      }),
    );
  }

  test("getContext returns recent growth: math frontier moves, concepts, badges", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();
    const kai = await seedUser(t, "scholar", { name: "Kai Nakamura", username: "kaiWG1" });
    const chatId = await seedChatNow(t, kai);

    // A concept grown on — an arc spanning >7 days with a level rise and a fresh
    // observation this week (deriveGrowthStories quality bars).
    await seedObservation(t, kai, {
      conceptLabel: "how pulleys share a load",
      masteryLevel: 1,
      observedAt: now - 9 * DAY,
    });
    await seedObservation(t, kai, {
      conceptLabel: "how pulleys share a load",
      masteryLevel: 3,
      observedAt: now - 1 * DAY,
    });

    // Math frontier: labels resolve off knowledgeNodes by_domain.
    await t.run(async (ctx) => {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "add_fractions",
        label: "adding fractions",
        domain: "math",
      });
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: "multiply_mixed",
        label: "multiplying mixed numbers",
        domain: "math",
      });
      // Turned fluent this week (also advanced — must appear ONLY under fluent).
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "add_fractions",
        domain: "math",
        repetition: 5,
        halfLifeDays: 3,
        frontier: false,
        source: "practice",
        updatedAt: now,
        becameFluentAt: now - 1 * DAY,
        frontierAdvancedAt: now - 1 * DAY,
      });
      // A second fluent crossing on the SAME skill — the label must not repeat.
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "add_fractions",
        domain: "math",
        repetition: 6,
        halfLifeDays: 3,
        frontier: false,
        source: "practice",
        updatedAt: now,
        becameFluentAt: now - 2 * DAY,
      });
      // Frontier advanced this week (not yet fluent).
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "multiply_mixed",
        domain: "math",
        repetition: 3,
        halfLifeDays: 3,
        frontier: true,
        source: "practice",
        updatedAt: now,
        frontierAdvancedAt: now - 2 * DAY,
      });
      // A stale crossing outside the window — must be ignored.
      await ctx.db.insert("practiceMastery", {
        scholarId: kai,
        skillKey: "old_skill",
        domain: "math",
        repetition: 9,
        halfLifeDays: 3,
        frontier: false,
        source: "practice",
        updatedAt: now,
        becameFluentAt: now - 30 * DAY,
      });
      // A badge earned this week + a stale one.
      await ctx.db.insert("scholarUnitBadges", {
        scholarId: kai,
        earnedAt: now - 2 * DAY,
        badgeSnapshot: { title: "Aquaponics Architect" },
      });
      await ctx.db.insert("scholarUnitBadges", {
        scholarId: kai,
        earnedAt: now - 40 * DAY,
        badgeSnapshot: { title: "Ancient History" },
      });
    });

    const ctx1 = await t.query(internal.metaChat.getContext, { chatId });
    const growth = ctx1?.weeklyGrowth;
    expect(growth?.conceptsGrown).toContain("how pulleys share a load");
    expect(growth?.mathFluent).toContain("adding fractions");
    // Two fluent crossings on the same skill collapse to one label.
    expect(growth?.mathFluent).toEqual(["adding fractions"]);
    // Fluent crossing implies frontier moved → not double-listed under advanced.
    expect(growth?.mathAdvanced).toContain("multiplying mixed numbers");
    expect(growth?.mathAdvanced).not.toContain("adding fractions");
    // Out-of-window crossings and badges are excluded.
    expect(growth?.mathFluent).not.toContain("old_skill");
    expect(growth?.badges).toEqual(["Aquaponics Architect"]);
  });

  test("a quiet week yields all-empty lists (the prompt section is then omitted)", async () => {
    const t = convexTest(schema, modules);
    const kai = await seedUser(t, "scholar", { username: "kaiWG2" });
    const chatId = await seedChatNow(t, kai);
    const ctx1 = await t.query(internal.metaChat.getContext, { chatId });
    expect(ctx1?.weeklyGrowth).toEqual({
      conceptsGrown: [],
      mathFluent: [],
      mathAdvanced: [],
      badges: [],
    });

    // And the prompt built from an empty weeklyGrowth omits the section.
    const prompt = buildMetaSystemPrompt({
      firstName: ctx1!.firstName,
      readingLevel: ctx1!.readingLevel,
      todaySessions: ctx1!.todaySessions,
      weeklyGrowth: ctx1!.weeklyGrowth,
      openIdeas: ctx1!.openIdeas,
      ideaUpdates: ctx1!.ideaUpdates,
      credits: ctx1!.credits,
    });
    expect(prompt).not.toContain("has grown this past week");
  });
});
