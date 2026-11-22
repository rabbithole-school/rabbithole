/**
 * A kid's own Sky (TRA-699): the per-kid refresh (rows, embeddings, layout)
 * with a fake embedder, the triggers that schedule it, and `skyStars.forSelf`.
 * Pins what earns a star (lib/skySources.ts): own stars only, at the kid's
 * current school; no teacher-archived or test-drive chat; no proposal still
 * waiting or declined, and no offer never started; the shown Quest bright,
 * with its trail; and a read that never touches a vector. Fictional names and
 * questions only.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { makeWorld, type WorldScholar } from "./factories/world";
import { skyForScholar } from "../skyStars";
import { deleteUserCore } from "../users";
import {
  noteSkyStar,
  noteSkyTurn,
  runSkyHook,
  refreshIsDue,
  SKY_REFRESH_STALE_MS,
} from "../lib/skyRefresh";

// A fake embedder: a text's vector is the sum of a fixed vector per word, so
// texts that share words sit close in meaning. No network.
const embedder = vi.hoisted(() => {
  const DIMS = 512;
  function wordVector(word: string): number[] {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const out: number[] = [];
    for (let i = 0; i < DIMS; i++) {
      h = Math.imul(h ^ (h >>> 13), 1274126177);
      out.push(((h >>> 0) / 4294967296) * 2 - 1);
    }
    return out;
  }
  const calls: string[][] = [];
  /** Set to make the next requests fail, as the provider does when down. */
  const state = { failing: false };
  return {
    calls,
    state,
    embed(texts: string[]): number[][] {
      if (state.failing) throw new Error("embeddings are down");
      calls.push(texts);
      return texts.map((text) => {
        const sum = new Array<number>(DIMS).fill(0);
        for (const word of text.toLowerCase().match(/[a-z]+/g) ?? ["blank"]) {
          wordVector(word).forEach((x, i) => (sum[i] += x));
        }
        return sum;
      });
    },
  };
});
vi.mock("../lib/embeddings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/embeddings")>()),
  embedTexts: async (texts: string[]) => embedder.embed(texts),
  requireEmbeddingKey: () => "test-key",
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Only the scheduler's timer is faked, so a scheduled refresh stays pending
// and the test runs it by hand.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  embedder.calls.length = 0;
  embedder.state.failing = false;
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { schools: 2, scholarsPerSchool: 2, parentsPerSchool: 0 });
  const home = world.schools[0];
  const scholar = home.scholars[0];
  return { t, world, home, scholar, asScholar: await world.as.scholar(scholar) };
}

async function insertChat(
  t: T,
  scholar: WorldScholar,
  fields: Partial<Doc<"sessions">>,
  turns: { role: "user" | "assistant"; content: string }[] = [],
): Promise<Id<"sessions">> {
  return await t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholar.id,
      title: "A chat",
      isArchived: false,
      institutionId: scholar.institutionId,
      ...fields,
    });
    for (const turn of turns) {
      await ctx.db.insert("messages", { sessionId, flagged: false, ...turn });
    }
    return sessionId;
  });
}

/** A wonder the kid asked (seed + its chat), answered once. */
async function wonder(
  t: T,
  scholar: WorldScholar,
  question: string,
  chat: Partial<Doc<"sessions">> = {},
) {
  const seedId = await t.run((ctx) =>
    ctx.db.insert("seeds", {
      scholarId: scholar.id,
      origin: "wonder",
      status: "active",
      suggestionType: "frontier",
      topic: question,
      rationale: "",
      askedOn: { surface: "quests" },
    }),
  );
  const sessionId = await insertChat(t, scholar, { seedId, ...chat }, [
    { role: "user", content: question },
    { role: "assistant", content: `Here is an answer about ${question.toLowerCase()}` },
  ]);
  return { seedId, sessionId };
}

/** An older seed (a suggestion) and its chat, with the kid's turns. */
async function legacySeed(
  t: T,
  scholar: WorldScholar,
  topic: string,
  kidTurns: string[],
  chat: Partial<Doc<"sessions">> = {},
) {
  const seedId = await t.run((ctx) =>
    ctx.db.insert("seeds", {
      scholarId: scholar.id,
      origin: "ai",
      status: "active",
      suggestionType: "frontier",
      topic,
      rationale: "A teacher-private note that never reaches the kid.",
    }),
  );
  const sessionId = await insertChat(t, scholar, { seedId, ...chat }, [
    { role: "user", content: "<start>" },
    ...kidTurns.map((content) => ({ role: "user" as const, content })),
  ]);
  return { seedId, sessionId };
}

/** One of the kid's own Quests, optionally with a chat they wrote in. */
async function quest(
  t: T,
  scholar: WorldScholar,
  title: string,
  opts: {
    approval?: Doc<"units">["questApproval"];
    wrote?: boolean;
    unit?: Partial<Doc<"units">>;
    chat?: Partial<Doc<"sessions">>;
  } = {},
) {
  const unitId = await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId: scholar.id,
      institutionId: scholar.institutionId,
      title,
      isActive: true,
      authorScholarId: scholar.id,
      authorRole: "author",
      ...(opts.approval ? { questApproval: opts.approval } : {}),
      ...opts.unit,
    }),
  );
  if (opts.wrote) {
    await insertChat(t, scholar, { unitId, ...opts.chat }, [
      { role: "user", content: `I want to build ${title}` },
    ]);
  }
  return unitId;
}

async function refresh(t: T, scholar: WorldScholar) {
  return await t.action(internal.skyStars.refreshForScholar, { scholarId: scholar.id });
}

async function pendingRefreshes(t: T) {
  const jobs = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter(
    (job) => job.name.includes("refreshForScholar") && job.state.kind === "pending",
  );
}

describe("the refresh and forSelf", () => {
  test("lays out a kid's wonders and Quests, with each drawer and tap target", async () => {
    const { t, home, scholar, asScholar } = await setup();
    const bats = await wonder(t, scholar, "How do bats find bugs in the dark?");
    await wonder(t, scholar, "Why do cats eyes glow at night?");
    const old = await legacySeed(t, scholar, "Volcano lava", ["is lava hotter than fire"]);
    const custom = await quest(t, scholar, "MY VOLCANO GAME", { wrote: true });
    const echo = await quest(t, scholar, "Echo game", {
      approval: {
        state: "approved",
        kind: "app",
        revision: 1,
        advisorId: home.teacher.id,
        fromSessionId: bats.sessionId,
        shownAt: 1_700_000_000_000,
      },
      unit: { mission: { text: "Show how bats hear where things are", setAt: 1 } },
      wrote: true,
    });

    const result = await refresh(t, scholar);
    expect(result).toMatchObject({ added: 5, embedded: 5, placed: 5, layout: "first" });

    const stars = await asScholar.query(api.skyStars.forSelf, {});
    expect(stars).toHaveLength(5);
    const byLabel = new Map(stars.map((s) => [s.label, s]));
    expect([...byLabel.keys()].sort()).toEqual([
      "Echo game",
      "How do bats find bugs in the dark?",
      "My volcano game",
      "Volcano lava",
      "Why do cats eyes glow at night?",
    ]);

    const batStar = byLabel.get("How do bats find bugs in the dark?")!;
    expect(batStar).toMatchObject({
      kind: "wonder",
      bright: false,
      sessionId: bats.sessionId,
      unitId: null,
      quest: null,
      wonder: { askedOn: "quests" },
    });
    expect(batStar.wonder!.replyExcerpt).toMatch(/answer/);

    const oldStar = byLabel.get("Volcano lava")!;
    expect(oldStar).toMatchObject({ kind: "wonder", sessionId: old.sessionId });
    expect(oldStar.wonder!.askedOn).toBeNull();

    const echoStar = byLabel.get("Echo game")!;
    expect(echoStar).toMatchObject({
      kind: "quest",
      bright: true,
      unitId: echo,
      sessionId: null,
      trailFromStarId: batStar.id,
      quest: {
        kind: "app",
        mission: "Show how bats hear where things are",
        advisorName: home.teacher.name,
        shownAt: 1_700_000_000_000,
      },
    });
    expect(byLabel.get("My volcano game")).toMatchObject({
      kind: "quest",
      bright: false,
      unitId: custom,
      trailFromStarId: null,
      quest: { kind: null, advisorName: null, shownAt: null },
    });

    // Positions are numbers, nearby are other visible stars, at most three.
    const ids = new Set(stars.map((s) => s.id));
    for (const star of stars) {
      expect(Number.isFinite(star.x) && Number.isFinite(star.y)).toBe(true);
      expect(star.nearby.length).toBeLessThanOrEqual(3);
      expect(star.nearby.every((id) => ids.has(id) && id !== star.id)).toBe(true);
    }
  });

  test("own stars only, at the kid's current school", async () => {
    const { t, world, home, scholar, asScholar } = await setup();
    const classmate = home.scholars[1];
    const away = world.schools[1];
    await wonder(t, scholar, "Do fish sleep?");
    await wonder(t, classmate, "Why is the ocean salty?");
    // Stamped with another school: a Quest and a chat. Unstamped: passes.
    await quest(t, scholar, "Robot dog", { wrote: true, unit: { institutionId: away.id } });
    await legacySeed(t, scholar, "Tides", ["why does the sea move"], {
      institutionId: away.id,
    });
    await quest(t, scholar, "Lava lamp", { wrote: true, unit: { institutionId: undefined } });

    await refresh(t, scholar);
    await refresh(t, { ...classmate });

    const labels = (await asScholar.query(api.skyStars.forSelf, {})).map((s) => s.label);
    expect(labels.sort()).toEqual(["Do fish sleep?", "Lava lamp"]);

    const asClassmate = await world.as.scholar(classmate);
    const theirs = (await asClassmate.query(api.skyStars.forSelf, {})).map((s) => s.label);
    expect(theirs).toEqual(["Why is the ocean salty?"]);

    // Staff get no stars of their own.
    const asTeacher = await world.as.staffOf(home);
    expect(await asTeacher.query(api.skyStars.forSelf, {})).toEqual([]);
  });

  test("teacher-archived and test-drive chats are left out", async () => {
    const { t, scholar, asScholar } = await setup();
    await legacySeed(t, scholar, "Archived seed", ["a turn"], { teacherArchivedAt: 1 });
    await legacySeed(t, scholar, "Rehearsal seed", ["a turn"], { isTestDrive: true });
    await legacySeed(t, scholar, "Never answered", []);
    await quest(t, scholar, "Rehearsal quest", { wrote: true, chat: { isTestDrive: true } });
    const kept = await wonder(t, scholar, "Why do owls hoot?");

    await refresh(t, scholar);
    expect((await asScholar.query(api.skyStars.forSelf, {})).map((s) => s.label)).toEqual([
      "Why do owls hoot?",
    ]);

    // A chat archived after its star was placed: the star drops out of the
    // read and keeps its row.
    await t.run((ctx) => ctx.db.patch(kept.sessionId, { teacherArchivedAt: 2 }));
    expect(await asScholar.query(api.skyStars.forSelf, {})).toEqual([]);
    const rows = await t.run((ctx) => ctx.db.query("skyStars").collect());
    expect(rows.filter((row) => row.seedId === kept.seedId)).toHaveLength(1);
  });

  test("a waiting or declined proposal and an unstarted offer are not stars", async () => {
    const { t, home, scholar, asScholar } = await setup();
    const base = { kind: "app" as const, revision: 1 };
    // Each with a chat the kid wrote in, which still earns nothing.
    await quest(t, scholar, "Waiting one", {
      approval: { ...base, state: "waiting", scholarWords: "a plan", proposedAt: 1 },
      wrote: true,
    });
    await quest(t, scholar, "Declined one", {
      approval: { ...base, state: "declined", scholarWords: "a plan", proposedAt: 1 },
      wrote: true,
    });
    await quest(t, scholar, "Offered one", {
      approval: { ...base, state: "offered", offeredBy: home.teacher.id, advisorId: home.teacher.id },
      wrote: true,
    });
    await quest(t, scholar, "Approved, not written in", {
      approval: { ...base, state: "approved", advisorId: home.teacher.id },
    });
    await quest(t, scholar, "Archived quest", { wrote: true, unit: { isActive: false } });
    await quest(t, scholar, "Approved and written in", {
      approval: { ...base, state: "approved", advisorId: home.teacher.id },
      wrote: true,
    });

    await refresh(t, scholar);
    expect((await asScholar.query(api.skyStars.forSelf, {})).map((s) => s.label)).toEqual([
      "Approved and written in",
    ]);
  });

  test("an older Quest's badge makes it bright; a mash title is hidden", async () => {
    const { t, scholar, asScholar } = await setup();
    const unitId = await quest(t, scholar, "Rocket science", { wrote: false });
    await t.run((ctx) =>
      ctx.db.insert("scholarUnitBadges", {
        scholarId: scholar.id,
        unitId,
        earnedAt: 1_700_000_000_000,
        badgeSnapshot: { title: "Rocket science", icon: "🚀" },
      }),
    );
    await quest(t, scholar, "asdfghjkl", { wrote: true });

    await refresh(t, scholar);
    const stars = await asScholar.query(api.skyStars.forSelf, {});
    expect(stars).toHaveLength(1);
    expect(stars[0]).toMatchObject({
      label: "Rocket science",
      bright: true,
      quest: { shownAt: 1_700_000_000_000, badge: { icon: "🚀", imageUrl: null } },
    });
    // The mash keeps a hidden row and is never embedded.
    const rows = await t.run((ctx) => ctx.db.query("skyStars").collect());
    expect(rows.find((row) => row.label === "asdfghjkl")?.hidden).toBe(true);
    expect(embedder.calls.flat()).not.toContain("asdfghjkl");
  });

  test("idempotent; a new star is placed without moving the old ones", async () => {
    const { t, scholar, asScholar } = await setup();
    await wonder(t, scholar, "How far away is the moon?");
    await wonder(t, scholar, "Why does the moon change shape?");
    await wonder(t, scholar, "Do fish get thirsty?");
    await refresh(t, scholar);
    const before = await asScholar.query(api.skyStars.forSelf, {});

    expect(await refresh(t, scholar)).toEqual({
      added: 0,
      embedded: 0,
      placed: 0,
      layout: "none",
    });

    await wonder(t, scholar, "What is the moon made of?");
    expect(await refresh(t, scholar)).toMatchObject({ added: 1, placed: 1, layout: "new" });
    const after = await asScholar.query(api.skyStars.forSelf, {});
    expect(after).toHaveLength(4);
    for (const star of before) {
      const same = after.find((s) => s.id === star.id)!;
      expect({ x: same.x, y: same.y }).toEqual({ x: star.x, y: star.y });
    }
  });

  test("the read never touches a vector", async () => {
    const { t, scholar } = await setup();
    await wonder(t, scholar, "Why is the sky blue?");
    await quest(t, scholar, "Sunset painter", { wrote: true });
    await refresh(t, scholar);
    expect(await t.run((ctx) => ctx.db.query("skyStarEmbeddings").collect())).toHaveLength(2);

    const tables = await t.run(async (ctx) => {
      const touched: string[] = [];
      const db = new Proxy(ctx.db, {
        get(target, prop, receiver) {
          if (prop === "query") {
            return (table: string) => {
              touched.push(table);
              return target.query(table as never);
            };
          }
          if (prop === "get") {
            return async (id: string) => {
              for (const table of ["skyStarEmbeddings", "skyStars", "seeds", "units"]) {
                if (target.normalizeId(table as never, id)) touched.push(table);
              }
              return target.get(id as never);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      const user = (await ctx.db.get(scholar.id))!;
      const stars = await skyForScholar({ ...ctx, db } as unknown as QueryCtx, user);
      return { touched, count: stars.length };
    });
    expect(tables.count).toBe(2);
    expect(tables.touched).toContain("skyStars");
    expect(tables.touched).not.toContain("skyStarEmbeddings");
  });
});

describe("the triggers", () => {
  test("asking wonders adds their rows and schedules one refresh for the kid", async () => {
    const { t, scholar, asScholar } = await setup();
    await asScholar.mutation(api.wonders.ask, { question: "Why do zebras have stripes?" });
    await asScholar.mutation(api.wonders.ask, { question: "Can a zebra swim?" });

    const rows = await t.run((ctx) => ctx.db.query("skyStars").collect());
    expect(rows.map((row) => row.label)).toEqual([
      "Why do zebras have stripes?",
      "Can a zebra swim?",
    ]);
    const jobs = await pendingRefreshes(t);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].args[0]).toEqual({ scholarId: scholar.id });

    // The run places both; nothing else is pending after it.
    await refresh(t, scholar);
    expect(await asScholar.query(api.skyStars.forSelf, {})).toHaveLength(2);
  });

  test("the kid's turns through sendMessage: a seed chat and their own Quest earn stars once", async () => {
    const { t, home, scholar, asScholar } = await setup();
    const { sessionId } = await legacySeed(t, scholar, "Tornadoes", []);
    const unitId = await quest(t, scholar, "Storm chaser game");
    const questChat = await insertChat(t, scholar, { unitId });
    // A teacher's unit: the kid's turns there earn nothing.
    const lesson = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: home.teacher.id,
        institutionId: home.id,
        title: "Fractions",
        isActive: true,
      }),
    );
    const lessonChat = await insertChat(t, scholar, { unitId: lesson });
    const send = (chat: Id<"sessions">, message: string) =>
      asScholar.mutation(api.sessions.sendMessage, {
        sessionId: chat,
        message,
        inputModality: "typed",
      });

    await send(sessionId, "<start>");
    expect(await t.run((ctx) => ctx.db.query("skyStars").collect())).toHaveLength(0);
    await send(sessionId, "how do tornadoes start");
    await send(sessionId, "and how fast are they");
    await send(questChat, "I want the clouds to spin");
    await send(lessonChat, "is a half bigger than a third");

    const rows = await t.run((ctx) => ctx.db.query("skyStars").collect());
    expect(rows.map((row) => row.label)).toEqual(["Tornadoes", "Storm chaser game"]);
    expect(await pendingRefreshes(t)).toHaveLength(1);
  });

  test("a staff member's turn earns the kid nothing", async () => {
    const { t, world, home, scholar } = await setup();
    const { sessionId } = await legacySeed(t, scholar, "Glaciers", []);
    const asTeacher = await world.as.staffOf(home);
    await asTeacher.mutation(api.sessions.sendMessage, {
      sessionId,
      message: "Try asking how glaciers move.",
      inputModality: "typed",
    });
    expect(await t.run((ctx) => ctx.db.query("skyStars").collect())).toHaveLength(0);
  });

  test("once the star exists a turn reads one row, and a plain chat or teacher's unit none", async () => {
    const { t, home, scholar } = await setup();
    const { sessionId: seedChat } = await legacySeed(t, scholar, "Comets", []);
    const plainChat = await insertChat(t, scholar, {});
    const lesson = await t.run((ctx) =>
      ctx.db.insert("units", {
        teacherId: home.teacher.id,
        institutionId: home.id,
        title: "Fractions",
        isActive: true,
      }),
    );
    const lessonChat = await insertChat(t, scholar, { unitId: lesson });

    /** The database reads one turn's hook makes. */
    const readsFor = (chat: Id<"sessions">) =>
      t.run(async (ctx) => {
        let reads = 0;
        const db = new Proxy(ctx.db, {
          get(target, prop) {
            const value = Reflect.get(target, prop);
            if (prop === "get" || prop === "query") {
              return (...args: unknown[]) => {
                reads++;
                return (value as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const session = (await ctx.db.get(chat))!;
        const sender = (await ctx.db.get(scholar.id))!;
        const unit = session.unitId ? await ctx.db.get(session.unitId) : null;
        await noteSkyTurn({ ...ctx, db } as typeof ctx, {
          session,
          sender,
          unit,
          turn: { content: "a question of mine", inputModality: "typed" },
        });
        return reads;
      });

    expect(await readsFor(plainChat)).toBe(0);
    expect(await readsFor(lessonChat)).toBe(0);
    await readsFor(seedChat); // the first turn adds the star
    expect(await t.run((ctx) => ctx.db.query("skyStars").collect())).toHaveLength(1);
    expect(await readsFor(seedChat)).toBe(1); // waiting, not stale
    await refresh(t, scholar);
    expect(await readsFor(seedChat)).toBe(1); // placed
  });

  test("a chat where staff wrote first still counts once the kid writes", async () => {
    const { t, scholar, asScholar } = await setup();
    const { seedId } = await legacySeed(t, scholar, "Northern lights", []);
    const chat = await t.run((ctx) =>
      ctx.db
        .query("sessions")
        .withIndex("by_user_seed", (q) => q.eq("userId", scholar.id).eq("seedId", seedId))
        .first(),
    );
    await t.run(async (ctx) => {
      for (let i = 0; i < 9; i++) {
        await ctx.db.insert("messages", {
          sessionId: chat!._id,
          role: "user",
          content: `A teacher's prompt ${i + 1}`,
          byStaff: true,
          flagged: false,
        });
      }
      await ctx.db.insert("messages", {
        sessionId: chat!._id,
        role: "user",
        content: "why are they green",
        flagged: false,
      });
    });

    await refresh(t, scholar);
    expect((await asScholar.query(api.skyStars.forSelf, {})).map((s) => s.label)).toEqual([
      "Northern lights",
    ]);
  });

  test("a run that died is replaced once, however many triggers follow", async () => {
    const { t, scholar } = await setup();
    const { seedId } = await wonder(t, scholar, "Why do cats purr?");
    const other = await wonder(t, scholar, "Do dogs dream?");
    // A waiting star whose run was scheduled long ago and never placed it.
    const starId = await t.run((ctx) =>
      ctx.db.insert("skyStars", {
        scholarId: scholar.id,
        seedId,
        label: "Why do cats purr?",
        queuedAt: Date.now() - SKY_REFRESH_STALE_MS - 1,
      }),
    );

    const trigger = (source: { seedId: Id<"seeds"> }) =>
      t.run((ctx) => noteSkyStar(ctx, scholar.id, source));
    await trigger({ seedId });
    await trigger({ seedId });
    await trigger({ seedId: other.seedId });

    expect(await pendingRefreshes(t)).toHaveLength(1);
    const renewed = await t.run((ctx) => ctx.db.get(starId));
    expect(Date.now() - renewed!.queuedAt!).toBeLessThan(SKY_REFRESH_STALE_MS);
  });

  test("refreshIsDue: due unless a waiting row had a run scheduled within the window", () => {
    const now = 10 * SKY_REFRESH_STALE_MS;
    const recent = now - 1000;
    const old = now - SKY_REFRESH_STALE_MS - 1;
    expect(refreshIsDue([], now)).toBe(true);
    expect(refreshIsDue([{ queuedAt: recent }], now)).toBe(false);
    expect(refreshIsDue([{ queuedAt: recent, x: 1 }], now)).toBe(true);
    expect(refreshIsDue([{ queuedAt: recent, hidden: true }], now)).toBe(true);
    expect(refreshIsDue([{ queuedAt: old }], now)).toBe(true);
    // A waiting row nobody scheduled a run for never counts as one pending.
    expect(refreshIsDue([{}], now)).toBe(true);
    expect(refreshIsDue([{ queuedAt: old }, {}, {}], now)).toBe(true);
    expect(refreshIsDue([{ queuedAt: old }, { queuedAt: recent }], now)).toBe(false);
  });

  test("new wonders every few minutes after a run died still recover within the window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const start = Date.UTC(2026, 10, 16, 15, 0, 0);
    vi.setSystemTime(start);
    const { t, scholar } = await setup();
    // A run was scheduled for this star at `start` and died.
    const first = await wonder(t, scholar, "Why do cats purr?");
    await t.run((ctx) => noteSkyStar(ctx, scholar.id, { seedId: first.seedId }));
    const jobs = await pendingRefreshes(t);
    expect(jobs).toHaveLength(1);
    await t.run((ctx) => ctx.scheduler.cancel(jobs[0]._id));

    // A new wonder every three minutes: each waits on the run that died until
    // the window closes, then one replacement is scheduled.
    const questions = ["Do dogs dream?", "Why do owls hoot?", "Can fish hear?", "Do ants sleep?"];
    const pendingAfter: number[] = [];
    for (const [i, question] of questions.entries()) {
      vi.setSystemTime(start + (i + 1) * 3 * 60_000);
      const next = await wonder(t, scholar, question);
      await t.run((ctx) => noteSkyStar(ctx, scholar.id, { seedId: next.seedId }));
      pendingAfter.push((await pendingRefreshes(t)).length);
    }
    // 3, 6 and 9 minutes: the dead run still counts; 12 minutes: replaced.
    expect(pendingAfter).toEqual([0, 0, 0, 1]);

    const rows = await t.run((ctx) => ctx.db.query("skyStars").collect());
    const queued = rows.filter((row) => row.queuedAt !== undefined).map((row) => row.label);
    // Only the rows a run was scheduled for carry the mark.
    expect(queued.sort()).toEqual(["Do ants sleep?", "Why do cats purr?"]);
  });

  test("a scheduling failure leaves the row unqueued, so the next trigger schedules", async () => {
    const { t, scholar } = await setup();
    const first = await wonder(t, scholar, "Why is snow white?");
    const second = await wonder(t, scholar, "How cold is space?");
    await t.run((ctx) =>
      runSkyHook("a test", () =>
        noteSkyStar(
          {
            ...ctx,
            scheduler: {
              ...ctx.scheduler,
              runAfter: async () => {
                throw new Error("the scheduler is down");
              },
            },
          } as typeof ctx,
          scholar.id,
          { seedId: first.seedId },
        ),
      ),
    );
    const [row] = await t.run((ctx) => ctx.db.query("skyStars").collect());
    expect(row.label).toBe("Why is snow white?");
    expect(row.queuedAt).toBeUndefined();
    expect(await pendingRefreshes(t)).toHaveLength(0);

    // The next trigger, for another source or for the same one, schedules.
    await t.run((ctx) => noteSkyStar(ctx, scholar.id, { seedId: second.seedId }));
    expect(await pendingRefreshes(t)).toHaveLength(1);
    await t.run((ctx) => noteSkyStar(ctx, scholar.id, { seedId: first.seedId }));
    expect(await pendingRefreshes(t)).toHaveLength(1);
  });
});

describe("a refresh that outlives a deletion", () => {
  test("sources read, the scholar deleted, then the writes: nothing comes back", async () => {
    const { t, world, scholar } = await setup();
    await wonder(t, scholar, "Why do volcanoes erupt?");
    await quest(t, scholar, "Lava lamp", { wrote: true });
    const sources = await t.query(internal.skyStars.sourcesForRefresh, {
      scholarId: scholar.id,
    });
    expect(sources).toHaveLength(2);

    await t.run((ctx) => deleteUserCore(ctx, scholar.id, world.schools[0].admin.id));
    expect(await t.run((ctx) => ctx.db.get(scholar.id))).toBeNull();

    expect(
      await t.mutation(internal.skyStars.addStars, { scholarId: scholar.id, sources: sources! }),
    ).toBe(0);
    expect(
      await t.mutation(internal.skyStars.storePositions, {
        scholarId: scholar.id,
        placedIds: [],
        positions: [],
        attempt: 0,
      }),
    ).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("skyStars").collect())).toEqual([]);
    expect(await pendingRefreshes(t)).toHaveLength(0);
  });

  test("a source deleted mid-run gets no row, vector or position; the others do", async () => {
    const { t, scholar } = await setup();
    const kept = await wonder(t, scholar, "Why do volcanoes erupt?");
    const gone = await quest(t, scholar, "Lava lamp", { wrote: true });
    const sources = await t.query(internal.skyStars.sourcesForRefresh, {
      scholarId: scholar.id,
    });
    await t.run((ctx) => ctx.db.delete(gone));

    expect(
      await t.mutation(internal.skyStars.addStars, { scholarId: scholar.id, sources: sources! }),
    ).toBe(1);
    const [row] = await t.run((ctx) => ctx.db.query("skyStars").collect());
    expect(row.seedId).toBe(kept.seedId);

    // The kept star's seed is deleted before its vector and position land.
    await t.run((ctx) => ctx.db.delete(kept.seedId));
    await t.mutation(internal.skyStars.storeEmbeddings, {
      rows: [{ starId: row._id, vector: [1, 0] }],
    });
    expect(await t.run((ctx) => ctx.db.query("skyStarEmbeddings").collect())).toEqual([]);
    expect(
      await t.mutation(internal.skyStars.storePositions, {
        scholarId: scholar.id,
        placedIds: [],
        positions: [{ starId: row._id, x: 0, y: 0 }],
        attempt: 0,
      }),
    ).toBe(0);
    expect((await t.run((ctx) => ctx.db.get(row._id)))?.x).toBeUndefined();
    // A row whose source is gone waits for nothing: no run is scheduled for it.
    expect(await pendingRefreshes(t)).toHaveLength(0);
  });
});

describe("a run's own retries and overlapping runs", () => {
  test("a run failing near the window's end renews its mark: a trigger after it schedules nothing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const start = Date.UTC(2026, 10, 16, 15, 0, 0);
    vi.setSystemTime(start);
    const { t, scholar } = await setup();
    const first = await wonder(t, scholar, "Why do cats purr?");
    await t.run((ctx) => noteSkyStar(ctx, scholar.id, { seedId: first.seedId }));
    const [scheduled] = await pendingRefreshes(t);
    await t.run((ctx) => ctx.scheduler.cancel(scheduled._id)); // it runs now, by hand

    // The run fails at 9m30s; its retry is due a minute later.
    vi.setSystemTime(start + 9.5 * 60_000);
    embedder.state.failing = true;
    await expect(refresh(t, scholar)).rejects.toThrow("embeddings are down");
    const retries = await pendingRefreshes(t);
    expect(retries).toHaveLength(1);
    expect(retries[0].args[0]).toEqual({ scholarId: scholar.id, attempt: 1 });

    // A trigger at 10m01s: past the first mark, inside the renewed one.
    vi.setSystemTime(start + 10 * 60_000 + 1000);
    const next = await wonder(t, scholar, "Do dogs dream?");
    await t.run((ctx) => noteSkyStar(ctx, scholar.id, { seedId: next.seedId }));
    expect(await pendingRefreshes(t)).toHaveLength(1);
  });

  test("overlapping runs can't place a star twice or move a placed one", async () => {
    const { t, scholar } = await setup();
    const a = await wonder(t, scholar, "Why is the sea salty?");
    const b = await wonder(t, scholar, "Why are waves foamy?");
    const [starA, starB] = await t.run(async (ctx) => [
      await ctx.db.insert("skyStars", {
        scholarId: scholar.id,
        seedId: a.seedId,
        label: "Why is the sea salty?",
      }),
      await ctx.db.insert("skyStars", {
        scholarId: scholar.id,
        seedId: b.seedId,
        label: "Why are waves foamy?",
      }),
    ]);
    const store = (placedIds: Id<"skyStars">[], x: number) =>
      t.mutation(internal.skyStars.storePositions, {
        scholarId: scholar.id,
        placedIds,
        positions: [
          { starId: starA, x, y: 0 },
          { starId: starB, x, y: 5 },
        ],
        attempt: 0,
      });

    // Two runs placed the same empty sky; the first to write wins.
    expect(await store([], 1)).toBe(2);
    expect(await store([], 99)).toBe(0);
    // Even a run whose snapshot matches never moves a placed star.
    expect(await store([starA, starB], 42)).toBe(0);
    const rows = await t.run((ctx) => ctx.db.query("skyStars").collect());
    expect(rows.map((row) => [row.x, row.y])).toEqual([
      [1, 0],
      [1, 5],
    ]);
  });
});
