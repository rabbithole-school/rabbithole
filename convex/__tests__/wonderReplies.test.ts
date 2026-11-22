// A teacher's reply on a wonder row (TRA-683): `wonders.todayForSelf` and
// `wonders.recentForSelf` rows carry `reply: { teacherName, threadId }` when a
// teacher at the scholar's school has written in the scholar's `about` thread
// for that wonder, else null. Pins the name (display name only), the thread
// (one the scholar can open), and what never counts: the scholar's own
// message, a retracted one, and a hand-inserted one from another school's
// teacher. All people here are made up. No copy assertions.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { DEFAULT_TIMEZONE, dayKeyForTimezone } from "../../shared/institutionDay";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Only the scheduler's timer is faked, so a notification a reply schedules
// stays pending and never runs after its test. The clock is real: convex-test
// stamps _creationTime from it, and "today" is read from it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function as(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** Two schools: at Moli a scholar and two teachers (one with no display
 *  name); at Kona a teacher. */
async function seedWorld(t: T) {
  return await t.run(async (ctx) => {
    const moli = await ctx.db.insert("institutions", {
      name: "Moli",
      slug: "moli-replies",
      kind: "school",
      isPrimary: true,
    });
    const kona = await ctx.db.insert("institutions", {
      name: "Kona",
      slug: "kona-replies",
      kind: "school",
    });
    const user = async (fields: Partial<Doc<"users">> & Pick<Doc<"users">, "role">) =>
      await ctx.db.insert("users", fields);
    const scholar = await user({
      username: "scholar-a",
      name: "Scholar A",
      role: "scholar",
      institutionId: moli,
    });
    const teacher = await user({ username: "teach-login", name: "Teacher Test", role: "teacher" });
    await ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId: moli });
    const unnamed = await user({ username: "unnamed-login", role: "teacher" });
    await ctx.db.insert("memberships", { userId: unnamed, role: "teacher", institutionId: moli });
    const konaTeacher = await user({ username: "kona-login", name: "Kona Teacher", role: "teacher" });
    await ctx.db.insert("memberships", {
      userId: konaTeacher,
      role: "teacher",
      institutionId: kona,
    });
    return { moli, kona, scholar, teacher, unnamed, konaTeacher };
  });
}

async function askAndOpenThread(
  t: T,
  scholarId: Id<"users">,
  question: string,
) {
  const asScholar = await as(t, scholarId);
  const { seedId } = await asScholar.mutation(api.wonders.ask, { question });
  const { threadId } = await asScholar.mutation(
    api.scholarMessages.openAboutThreadForScholar,
    { scholarId, about: { type: "wonder", seedId } },
  );
  return { asScholar, seedId, threadId };
}

async function rows(asScholar: Awaited<ReturnType<typeof as>>) {
  const today = await asScholar.query(api.wonders.todayForSelf, {
    dayKey: dayKeyForTimezone(Date.now(), DEFAULT_TIMEZONE),
  });
  const recent = await asScholar.query(api.wonders.recentForSelf, {});
  return { today: today.wonders, recent };
}

describe("a wonder row's teacher reply (TRA-683)", () => {
  test("a teacher's reply shows with their display name and a thread the scholar can open", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const { asScholar, seedId, threadId } = await askAndOpenThread(
      t,
      world.scholar,
      "Why do owls turn their heads so far?",
    );
    await (await as(t, world.teacher)).mutation(api.scholarMessages.reply, {
      threadId,
      body: "Great question. Want to look at owl skeletons with me tomorrow?",
    });

    const { today, recent } = await rows(asScholar);
    for (const list of [today, recent]) {
      const row = list.find((wonder) => wonder.seedId === seedId);
      expect(row?.reply).toEqual({ teacherName: "Teacher Test", threadId });
    }
    // The id is one the scholar can open in Messages.
    expect(await asScholar.query(api.scholarMessages.getThread, { threadId })).not.toBeNull();
    const listed = await asScholar.query(api.scholarMessages.listThreads, { kind: "about" });
    expect(listed.threads.map((thread) => thread._id)).toContain(threadId);
  });

  test("no thread, or a thread with no teacher message, gives null", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const asScholar = await as(t, world.scholar);
    await asScholar.mutation(api.wonders.ask, { question: "Do fish get thirsty?" });
    await askAndOpenThread(t, world.scholar, "Who invented zero?");

    const { today, recent } = await rows(asScholar);
    expect(today).toHaveLength(2);
    expect(recent).toHaveLength(2);
    for (const row of [...today, ...recent]) expect(row.reply).toBeNull();
  });

  test("the scholar's own message is not a reply, and a retracted teacher message is not either", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const { asScholar, threadId } = await askAndOpenThread(
      t,
      world.scholar,
      "Why is the sky blue?",
    );
    await asScholar.mutation(api.scholarMessages.reply, {
      threadId,
      body: "I also wonder about sunsets.",
    });
    const { messageId } = await (await as(t, world.teacher)).mutation(
      api.scholarMessages.reply,
      { threadId, body: "Let's talk about it." },
    );
    await t.run((ctx) => ctx.db.patch(messageId, { retractedAt: Date.now() }));

    const { today, recent } = await rows(asScholar);
    expect(today[0]?.reply).toBeNull();
    expect(recent[0]?.reply).toBeNull();
  });

  test("a hand-inserted message from another school's teacher is ignored", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const { asScholar, threadId } = await askAndOpenThread(
      t,
      world.scholar,
      "Is there a biggest prime?",
    );
    await (await as(t, world.teacher)).mutation(api.scholarMessages.reply, {
      threadId,
      body: "Try listing a few and see.",
    });
    // Nothing lets a Kona teacher post here; this row is made by hand, newer
    // than the real reply.
    await t.run((ctx) =>
      ctx.db.insert("parentMessages", {
        threadId,
        authorType: "teacher",
        authorUserId: world.konaTeacher,
        body: "Not from this school.",
        sentAt: Date.now() + 60_000,
      }),
    );

    const { today } = await rows(asScholar);
    expect(today[0]?.reply).toEqual({ teacherName: "Teacher Test", threadId });

    // With only the other school's message, there is no reply at all.
    const second = await askAndOpenThread(t, world.scholar, "Why do cats purr?");
    await t.run((ctx) =>
      ctx.db.insert("parentMessages", {
        threadId: second.threadId,
        authorType: "teacher",
        authorUserId: world.konaTeacher,
        body: "Not from this school.",
      }),
    );
    const after = await rows(asScholar);
    const row = after.recent.find((wonder) => wonder.seedId === second.seedId);
    expect(row?.reply).toBeNull();
  });

  test("a teacher with no display name gives a null name, never their login", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const { asScholar, threadId } = await askAndOpenThread(
      t,
      world.scholar,
      "How do bees find flowers?",
    );
    await (await as(t, world.unnamed)).mutation(api.scholarMessages.reply, {
      threadId,
      body: "Bees see colors we can't.",
    });

    const { recent } = await rows(asScholar);
    expect(recent[0]?.reply).toEqual({ teacherName: null, threadId });
  });
});
