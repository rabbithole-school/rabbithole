/**
 * Wonders (TRA-669): the "I wonder…" box's backend — asking, Today's wonders,
 * the starters feed, and the Sky-open event — plus the invariant that keeps a
 * wonder seed out of every older seed read (lib/seeds.ts `isWonderSeed`).
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { tutorStanceFor } from "../sessionHelpers";
import { plantBadgeFollowSeed, plantParkedIdeaSeed } from "../lib/seeds";
import { readScholarSeeds } from "../lib/scholarReads";
import { replyExcerpt, withoutFirstParagraph, wonderQuestion } from "../wonders";
import {
  DEFAULT_TIMEZONE,
  dayKeyForTimezone,
  shiftDayKey,
} from "../../shared/institutionDay";
import { resolveObserverOrigin } from "../lib/observerOrigin";

// Every story edge / seed topic gets a card question, so the queue's rows are
// tested independent of content coverage (as in questionQueue.test.ts).
const questionFixture = vi.hoisted(() => ({
  question: {
    prompt: "Which one wins?",
    choices: ["The first", "The second", "Neither", "Both"],
    answerIndex: 1,
    reveal: "The second one wins.",
  },
}));
vi.mock("../lib/practice/storyCardQuestions", () => ({
  storyCardQuestion: () => questionFixture.question,
}));
vi.mock("../lib/practice/seedCardQuestions", () => ({
  seedCardQuestion: () => questionFixture.question,
}));

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Only the scheduler's timer is faked, so a scheduled job stays pending and
// never runs after its test (see bakeUnitFromSeed.test.ts). The clock is real:
// convex-test stamps _creationTime from it, and "today" is read from it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function makeUser(
  t: T,
  username: string,
  role: Doc<"users">["role"] = "scholar",
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", { name: username, username, role }),
  );
}

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

function today() {
  return dayKeyForTimezone(Date.now(), DEFAULT_TIMEZONE);
}

async function insertSeed(
  t: T,
  scholarId: Id<"users">,
  fields: Partial<Doc<"seeds">> = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "teacher",
      status: "active",
      suggestionType: "teacher_suggestion",
      topic: "Tide pools",
      rationale: "Teacher-only note",
      scholarInvitation: "What lives in a tide pool?",
      ...fields,
    }),
  );
}

async function plantWonderRow(t: T, scholarId: Id<"users">, topic: string) {
  return await insertSeed(t, scholarId, {
    origin: "wonder",
    suggestionType: "frontier",
    topic,
    rationale: "",
    scholarInvitation: undefined,
  });
}

describe("wonderQuestion / replyExcerpt (pure)", () => {
  test("a question is trimmed, whitespace-collapsed and capped", () => {
    expect(wonderQuestion("  why is   the sea\nsalty?  ")).toBe(
      "why is the sea salty?",
    );
    expect(wonderQuestion("   ")).toBe("");
    expect(Array.from(wonderQuestion("🦉".repeat(600)))).toHaveLength(500);
  });

  test("a reply becomes one plain line, cut at a word", () => {
    expect(
      replyExcerpt(
        "**Saltwater fish** drink all the time.\n\n- Freshwater fish hardly ever do.\n<your-turn>Why?</your-turn>",
      ),
    ).toBe("Saltwater fish drink all the time. Freshwater fish hardly ever do. Why?");
    expect(replyExcerpt("3 < 5 and 7 > 2")).toBe("3 < 5 and 7 > 2");
    expect(replyExcerpt("```js\nx\n```")).toBeNull();
    const long = replyExcerpt(`${"word ".repeat(60)}end`);
    expect(long?.endsWith("…")).toBe(true);
    expect(Array.from(long ?? "").length).toBeLessThanOrEqual(161);
  });
});

describe("wonders.ask", () => {
  test("saves a wonder seed and opens a plain chat that never bakes", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "asker");
    const { seedId, sessionId } = await (await as(t, scholarId)).mutation(
      api.wonders.ask,
      { question: "  Why is the sky blue?  " },
    );

    const [seed, session, scheduled] = await t.run(async (ctx) => [
      await ctx.db.get(seedId),
      await ctx.db.get(sessionId),
      await ctx.db.system.query("_scheduled_functions").collect(),
    ] as const);
    expect(seed).toMatchObject({
      scholarId,
      origin: "wonder",
      status: "active",
      topic: "Why is the sky blue?",
      rationale: "",
    });
    expect(seed?.scholarInvitation).toBeUndefined();
    expect(session).toMatchObject({ userId: scholarId, seedId, isArchived: false });
    expect(session?.unitId).toBeUndefined();
    expect(session?.activityId).toBeUndefined();
    expect(session?.questBakeStatus).toBeUndefined();
    expect(scheduled.map((job) => job.name).join(" ")).not.toContain("bake");
  });

  test("the chat takes the answer-first stance, and the tutor's seed list never echoes a wonder", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "stance");
    const asScholar = await as(t, scholarId);
    await asScholar.mutation(api.wonders.ask, { question: "Do fish get thirsty?" });
    await insertSeed(t, scholarId);
    const { sessionId } = await asScholar.mutation(api.wonders.ask, {
      question: "Who invented zero?",
    });

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(context?.seedOriginContext?.topic).toBe("Who invented zero?");
    expect(
      tutorStanceFor({
        unitContext: context!.unitContext,
        lessonActivityContext: context!.lessonActivityContext,
        seedOriginContext: context!.seedOriginContext,
        builderStance: false,
        isWorkbench: false,
      }),
    ).toBe("answerFirst");
    // The other wonder is not a "seed to steer toward"; the real pin is.
    const listed = JSON.stringify(context?.seeds);
    expect(listed).not.toContain("Do fish get thirsty?");
    expect(listed).toContain("Tide pools");
    // The observer is told the scholar asked it, not that they picked a star.
    expect(resolveObserverOrigin(context!).kind).toBe("wonder");
  });

  test("the observer's origin tells a wonder from a Sky pick", () => {
    const seedId = "seed" as Id<"seeds">;
    expect(
      resolveObserverOrigin({ seedId, seedForOrigin: { origin: "wonder" } }).kind,
    ).toBe("wonder");
    expect(
      resolveObserverOrigin({ seedId, seedForOrigin: { origin: "ai" } }).kind,
    ).toBe("seed");
    expect(resolveObserverOrigin({ seedId }).kind).toBe("seed");
  });

  test("opening a wonder through createFromSeed lands on its own chat", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "reopen");
    const asScholar = await as(t, scholarId);
    const { seedId, sessionId } = await asScholar.mutation(api.wonders.ask, {
      question: "Why do cats purr?",
    });
    const again = await asScholar.mutation(api.sessions.createFromSeed, { seedId });
    expect(again.id).toBe(sessionId);
    const launch = await asScholar.query(api.seeds.getBakeLaunchInfo, { seedId });
    expect(launch?.isTopicSeed).toBe(false);
  });

  test("anyone but a scholar is refused, and an empty question is refused", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await makeUser(t, "teacher", "teacher");
    await expect(
      (await as(t, teacherId)).mutation(api.wonders.ask, { question: "Why?" }),
    ).rejects.toThrow(/Only a scholar/);
    const scholarId = await makeUser(t, "blank");
    await expect(
      (await as(t, scholarId)).mutation(api.wonders.ask, { question: "  \n " }),
    ).rejects.toThrow();
    const seeds = await t.run((ctx) => ctx.db.query("seeds").collect());
    expect(seeds).toHaveLength(0);
  });
});

describe("wonders.todayForSelf", () => {
  test("today's wonders, newest first, each with its chat and the opening of the first reply", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "today");
    const asScholar = await as(t, scholarId);
    const first = await asScholar.mutation(api.wonders.ask, {
      question: "Who invented zero?",
      askedOn: { surface: "quests" },
    });
    const second = await asScholar.mutation(api.wonders.ask, {
      question: "Do fish get thirsty?",
      askedOn: { surface: "prep" },
    });
    await t.run(async (ctx) => {
      // A dead empty placeholder, then the real reply.
      await ctx.db.insert("messages", {
        sessionId: first.sessionId,
        role: "assistant",
        content: "",
        streamId: "dead",
        flagged: false,
      });
      await ctx.db.insert("messages", {
        sessionId: first.sessionId,
        role: "assistant",
        content: "People in **India** first used it as a number.",
        flagged: false,
      });
      // Still streaming: not a reply yet.
      await ctx.db.insert("messages", {
        sessionId: second.sessionId,
        role: "assistant",
        content: "Saltwater fish",
        streamId: "live",
        flagged: false,
      });
    });
    // Not wonders: a teacher pin.
    await insertSeed(t, scholarId);

    const result = await asScholar.query(api.wonders.todayForSelf, {
      dayKey: today(),
    });
    expect(result.dayKey).toBe(today());
    expect(result.wonders).toEqual([
      {
        seedId: second.seedId,
        question: "Do fish get thirsty?",
        sessionId: second.sessionId,
        askedAt: expect.any(Number),
        askedOn: { surface: "prep" },
        replyExcerpt: null,
        reply: null,
      },
      {
        seedId: first.seedId,
        question: "Who invented zero?",
        sessionId: first.sessionId,
        askedAt: expect.any(Number),
        askedOn: { surface: "quests" },
        replyExcerpt: "People in India first used it as a number.",
        reply: null,
      },
    ]);
  });

  test("a wonder asked while building names its unit; one with no place says so", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "builder");
    const teacherId = await makeUser(t, "unit-teacher", "teacher");
    const { unitId, strangerUnitId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Angle croc",
        emoji: "🐊",
        isActive: true,
        authorScholarId: scholarId,
      });
      await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        title: "Angle croc",
        isArchived: false,
      });
      const strangerUnitId = await ctx.db.insert("units", {
        teacherId,
        title: "Someone else's unit",
        isActive: true,
      });
      return { unitId, strangerUnitId };
    });
    const asScholar = await as(t, scholarId);
    const built = await asScholar.mutation(api.wonders.ask, {
      question: "Why do crocodiles cry?",
      askedOn: { surface: "build", unitId },
    });
    await asScholar.mutation(api.wonders.ask, { question: "Is zero even?" });
    // A unit the scholar has no session in can't label a wonder.
    await expect(
      asScholar.mutation(api.wonders.ask, {
        question: "What's in here?",
        askedOn: { surface: "build", unitId: strangerUnitId },
      }),
    ).rejects.toThrow(/building in/);

    const seed = await t.run((ctx) => ctx.db.get(built.seedId));
    expect(seed?.askedOn).toEqual({ surface: "build", unitId });
    // The build unit is recorded only as where it was asked: the wonder is
    // never an offer of that unit.
    expect(seed?.unitId).toBeUndefined();

    const { wonders } = await asScholar.query(api.wonders.todayForSelf, {
      dayKey: today(),
    });
    expect(wonders.map((w) => [w.question, w.askedOn])).toEqual([
      ["Is zero even?", null],
      [
        "Why do crocodiles cry?",
        { surface: "build", unitId, unitTitle: "Angle croc" },
      ],
    ]);
  });

  test("another scholar's wonders never show, and a non-scholar gets nothing", async () => {
    const t = convexTest(schema, modules);
    const mine = await makeUser(t, "mine");
    const theirs = await makeUser(t, "theirs");
    await (await as(t, theirs)).mutation(api.wonders.ask, {
      question: "Why do owls hoot?",
    });
    const result = await (await as(t, mine)).query(api.wonders.todayForSelf, {
      dayKey: today(),
    });
    expect(result.wonders).toEqual([]);

    const teacherId = await makeUser(t, "teacher", "teacher");
    const staff = await (await as(t, teacherId)).query(api.wonders.todayForSelf, {
      dayKey: today(),
    });
    expect(staff.wonders).toEqual([]);
  });

  test("a session pointed at another school's unit can't label a wonder or leak its title", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "repointer");
    const teacherId = await makeUser(t, "far-teacher", "teacher");
    const foreignUnitId = await t.run(async (ctx) => {
      const otherSchool = await ctx.db.insert("institutions", {
        name: "Another school",
        slug: "another-school",
        kind: "school",
      });
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "Another school's secret unit",
        isActive: true,
        institutionId: otherSchool,
      });
      // What sessions.update({ id, unitId }) lets a scholar do to their own
      // session today: point it at any unit.
      await ctx.db.insert("sessions", {
        userId: scholarId,
        unitId,
        title: "Mine",
        isArchived: false,
      });
      return unitId;
    });
    const asScholar = await as(t, scholarId);
    await expect(
      asScholar.mutation(api.wonders.ask, {
        question: "What's in here?",
        askedOn: { surface: "build", unitId: foreignUnitId },
      }),
    ).rejects.toThrow(/Forbidden/);

    // A label recorded before access was lost is re-checked on every read.
    await t.run(async (ctx) => {
      const seedId = await ctx.db.insert("seeds", {
        scholarId,
        origin: "wonder",
        status: "active",
        suggestionType: "frontier",
        topic: "Older wonder",
        rationale: "",
        askedOn: { surface: "build", unitId: foreignUnitId },
      });
      await ctx.db.insert("sessions", {
        userId: scholarId,
        seedId,
        title: "Older wonder",
        isArchived: false,
      });
    });
    const { wonders } = await asScholar.query(api.wonders.todayForSelf, {
      dayKey: today(),
    });
    expect(wonders).toHaveLength(1);
    expect(wonders[0].askedOn).toEqual({
      surface: "build",
      unitId: foreignUnitId,
      unitTitle: null,
    });
    expect(JSON.stringify(wonders)).not.toContain("secret");
  });

  test("the range comes only from the requested day; a malformed key throws", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "skewed");
    const asScholar = await as(t, scholarId);
    await asScholar.mutation(api.wonders.ask, { question: "Why is ice slippery?" });
    // A device already past midnight asks for tomorrow: it gets tomorrow (empty
    // so far), never the server's today swapped in.
    const tomorrow = shiftDayKey(today(), 1);
    const ahead = await asScholar.query(api.wonders.todayForSelf, { dayKey: tomorrow });
    expect(ahead).toEqual({ dayKey: tomorrow, wonders: [] });
    const past = await asScholar.query(api.wonders.todayForSelf, {
      dayKey: "2001-01-01",
    });
    expect(past).toEqual({ dayKey: "2001-01-01", wonders: [] });
    for (const dayKey of ["today", "2026-02-30", "2026-1-5"]) {
      await expect(
        asScholar.query(api.wonders.todayForSelf, { dayKey }),
      ).rejects.toThrow(/Invalid day key/);
    }
  });
});

describe("questionQueue.startersForSelf", () => {
  async function seedStory(t: T, scholarId: Id<"users">) {
    return await t.run(async (ctx) => {
      if (
        !(await ctx.db
          .query("knowledgeNodes")
          .filter((q) => q.eq(q.field("nodeKey"), "prime_numbers"))
          .first())
      ) {
        await ctx.db.insert("knowledgeNodes", {
          nodeKey: "prime_numbers",
          label: "Prime numbers",
          domain: "math",
        });
      }
      await ctx.db.insert("knowledgeNodeEdges", {
        fromKey: "prime_numbers",
        toKey: "cicada_cycles",
        domain: "biology",
        kind: "bridge",
        method: "curated",
        story: {
          kind: "applies",
          hook: "Why do cicadas wait 13 or 17 years?",
          narrative: "Prime cycles dodge predators.",
          visualEmoji: "🦗",
          provenance: "registry",
        },
      });
      return await ctx.db.insert("seeds", {
        scholarId,
        origin: "story",
        status: "active",
        suggestionType: "leap",
        topic: "Cicada cycles",
        rationale: "Teacher-only story note",
        scholarInvitation: "Why do cicadas wait 13 or 17 years?",
        connectionTo: "Primes (label at mint)",
        storyFromKey: "prime_numbers",
        storyToKey: "cicada_cycles",
      });
    });
  }

  async function seedTeacherQuest(
    t: T,
    scholarId: Id<"users">,
    title: string,
    scholarInvitation?: string,
    opts: { attributed?: boolean } = {},
  ) {
    const teacherId = await makeUser(t, "Ms. Rivera", "teacher");
    return await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title,
        emoji: "🐚",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "Look", order: 0 });
      await ctx.db.insert("activities", {
        lessonId,
        title: "Find a crab",
        kind: "online",
        order: 0,
      });
      return await ctx.db.insert("seeds", {
        scholarId,
        ...(opts.attributed === false ? {} : { teacherId }),
        origin: "teacher",
        status: "active",
        suggestionType: "teacher_suggestion",
        topic: title,
        rationale: "Teacher-only pick note",
        ...(scholarInvitation ? { scholarInvitation } : {}),
        unitId,
      });
    });
  }

  test("the queue's rows as starters: line from seedScholarText, source by where it came from", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "starters");
    const story = await seedStory(t, scholarId);
    const idea = await insertSeed(t, scholarId, {
      origin: "ai-constellation",
      suggestionType: "cross_domain",
      topic: "Equal-temperament tuning",
      scholarInvitation: "A piano is tuned slightly wrong on purpose.",
    });
    const pick = await seedTeacherQuest(t, scholarId, "Tide pools", "You'd love the crabs.");
    const unattributedPick = await seedTeacherQuest(
      t,
      scholarId,
      "Kelp forests",
      "Kelp grows fast.",
      { attributed: false },
    );
    // A teacher with only a login username: no display name, so no detail.
    const loginOnly = await t.run((ctx) =>
      ctx.db.insert("users", { username: "rivera.login", role: "teacher" }),
    );
    const loginOnlyPick = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: loginOnly,
        title: "Sea stars",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "Look", order: 0 });
      await ctx.db.insert("activities", { lessonId, title: "Count arms", kind: "online", order: 0 });
      return await ctx.db.insert("seeds", {
        scholarId,
        teacherId: loginOnly,
        origin: "teacher",
        status: "active",
        suggestionType: "teacher_suggestion",
        topic: "Sea stars",
        rationale: "Teacher-only pick note",
        scholarInvitation: "Some sea stars have forty arms.",
        unitId,
      });
    });
    const loginOnlyQuestion = await insertSeed(t, scholarId, {
      origin: "teacher",
      teacherId: loginOnly,
      suggestionType: "cross_domain",
      topic: "Tide clocks",
      scholarInvitation: "The tide keeps a clock of its own.",
    });
    const coach = await makeUser(t, "Mr. Okafor", "teacher");
    const teacherQuestion = await insertSeed(t, scholarId, {
      origin: "teacher",
      teacherId: coach,
      suggestionType: "cross_domain",
      topic: "Bridge cables",
      scholarInvitation: "A bridge hangs from cables lighter than you'd guess.",
    });
    // Left out: a pick with no scholar text, a hidden observer idea, a wonder,
    // and another scholar's story.
    const silentPick = await seedTeacherQuest(t, scholarId, "Rock pools");
    const pendingIdea = await insertSeed(t, scholarId, {
      origin: "ai",
      status: "pending",
      suggestionType: "cross_domain",
      topic: "Hidden observer idea",
      scholarInvitation: "Hidden until it goes live.",
    });
    const wonder = await plantWonderRow(t, scholarId, "Why do bats hang upside down?");
    const otherScholar = await makeUser(t, "other");
    const othersStory = await seedStory(t, otherScholar);

    const rows = await (await as(t, scholarId)).query(
      api.questionQueue.startersForSelf,
      {},
    );
    const bySeed = new Map(rows.map((row) => [row.seedId, row]));
    // The skill's graph label, not the label stored when the Story was minted.
    expect(bySeed.get(story)).toMatchObject({
      source: "story",
      line: "Why do cicadas wait 13 or 17 years?",
      detail: { skillName: "Prime numbers" },
    });
    expect(bySeed.get(idea)).toMatchObject({
      source: "idea",
      line: "A piano is tuned slightly wrong on purpose.",
      detail: null,
    });
    expect(bySeed.get(pick)).toMatchObject({
      source: "teacher",
      line: "You'd love the crabs.",
      detail: { teacherName: "Ms. Rivera" },
    });
    // No teacher on record: the card's "Your teacher" copy is not a name.
    expect(bySeed.get(unattributedPick)).toMatchObject({
      source: "teacher",
      detail: null,
    });
    expect(bySeed.get(teacherQuestion)).toMatchObject({
      source: "teacher",
      detail: { teacherName: "Mr. Okafor" },
    });
    for (const id of [loginOnlyPick, loginOnlyQuestion]) {
      expect(bySeed.get(id)).toMatchObject({ source: "teacher", detail: null });
    }
    expect(JSON.stringify(rows)).not.toContain("rivera.login");
    for (const absent of [silentPick, pendingIdea, wonder, othersStory]) {
      expect(bySeed.has(absent)).toBe(false);
    }
    expect(JSON.stringify(rows)).not.toContain("Teacher-only");
  });

  test("a non-scholar gets no starters", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await makeUser(t, "teacher", "teacher");
    await insertSeed(t, teacherId, {
      origin: "ai-constellation",
      suggestionType: "cross_domain",
    });
    expect(
      await (await as(t, teacherId)).query(api.questionQueue.startersForSelf, {}),
    ).toEqual([]);
  });
});

describe("skyOpens.record", () => {
  test("one row per open, for the scholar only", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "sky");
    const asScholar = await as(t, scholarId);
    expect(await asScholar.mutation(api.skyOpens.record, {})).toEqual({ recorded: true });
    await asScholar.mutation(api.skyOpens.record, {});
    const teacherId = await makeUser(t, "teacher", "teacher");
    expect(
      await (await as(t, teacherId)).mutation(api.skyOpens.record, {}),
    ).toEqual({ recorded: false });

    const rows = await t.run((ctx) => ctx.db.query("skyOpens").collect());
    expect(rows.map((row) => row.scholarId)).toEqual([scholarId, scholarId]);
  });
});

describe("older seed reads leave wonders out", () => {
  test("the Sky, the seed list and the observer's seeds never return a wonder, even past the read bound", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "crowded");
    const pin = await insertSeed(t, scholarId, { topic: "A teacher's pin" });
    // More wonders than ACTIVE_SEED_READ_LIMIT (120), all newer than the pin.
    await t.run(async (ctx) => {
      for (let i = 0; i < 125; i++) {
        await ctx.db.insert("seeds", {
          scholarId,
          origin: "wonder",
          status: "active",
          suggestionType: "frontier",
          topic: `Wonder ${i}`,
          rationale: "",
        });
      }
    });
    const asScholar = await as(t, scholarId);

    const sky = await asScholar.query(api.seeds.skyForSelf, {});
    expect(sky.seeds.map((s) => s._id)).toEqual([pin]);

    const list = await asScholar.query(api.seeds.listByScholar, { scholarId });
    expect(list.map((s) => s._id)).toEqual([pin]);
    expect(list.some((s) => s.origin === "wonder")).toBe(false);

    const observer = await t.query(internal.seeds.activeByScholar, { scholarId });
    expect(observer.map((s) => s._id)).toEqual([pin]);

    // The aide, MCP and parent reads (readScholarSeeds) and the queue.
    const agentRead = await t.run((ctx) => readScholarSeeds(ctx, scholarId, "parent"));
    expect(agentRead.map((s) => s.topic)).toEqual(["A teacher's pin"]);
    const queue = await asScholar.query(api.questionQueue.forSelf, {});
    expect(JSON.stringify(queue)).not.toContain("Wonder ");
  });

  test("a badge trail or a parked idea with a wonder's exact words is its own seed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "trail");
    const wonder = await plantWonderRow(t, scholarId, "Robot arms");
    const kiteWonder = await plantWonderRow(t, scholarId, "Kite tails");
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", { userId: scholarId, title: "Build", isArchived: false }),
    );
    const [trail, parked] = await t.run(async (ctx) => [
      await plantBadgeFollowSeed(ctx, {
        scholarId,
        topic: "Robot arms",
        inspiredByName: "Scholar B",
        rationale: "Inspired by a classmate's badge.",
      }),
      await plantParkedIdeaSeed(ctx, {
        scholarId,
        idea: "Kite tails",
        activityTitle: "Build",
        sessionId,
      }),
    ] as const);
    expect(trail).toMatchObject({ alreadyFollowing: false });
    expect(trail.id).not.toBe(wonder);
    expect(parked).toMatchObject({ existed: false });
    expect(parked.id).not.toBe(kiteWonder);
  });
});

describe("wonders.recentForSelf (TRA-678)", () => {
  test("the newest wonders, newest first, with todayForSelf's rows", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "recent");
    const asScholar = await as(t, scholarId);
    const first = await asScholar.mutation(api.wonders.ask, {
      question: "Who invented zero?",
      askedOn: { surface: "quests" },
    });
    const second = await asScholar.mutation(api.wonders.ask, {
      question: "Do fish get thirsty?",
      askedOn: { surface: "prep" },
    });
    await t.run((ctx) =>
      ctx.db.insert("messages", {
        sessionId: first.sessionId,
        role: "assistant",
        content: "People in **India** first used it as a number.",
        flagged: false,
      }),
    );
    // Not wonders: a teacher pin. Not this scholar's: another kid's wonder.
    await insertSeed(t, scholarId);
    const otherId = await makeUser(t, "other");
    await (await as(t, otherId)).mutation(api.wonders.ask, {
      question: "Why do cats purr?",
    });

    const recent = await asScholar.query(api.wonders.recentForSelf, {});
    const todays = await asScholar.query(api.wonders.todayForSelf, {
      dayKey: today(),
    });
    // The same rows, in the same order, as Today's wonders.
    expect(recent).toEqual(todays.wonders);
    expect(recent.map((row) => row.seedId)).toEqual([second.seedId, first.seedId]);
    expect(recent[1]).toMatchObject({
      question: "Who invented zero?",
      askedOn: { surface: "quests" },
      replyExcerpt: "People in India first used it as a number.",
    });
  });

  test("a few at most, a wonder whose chat is gone is left out, and a non-scholar gets nothing", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "many");
    const asScholar = await as(t, scholarId);
    const asked: { seedId: Id<"seeds">; sessionId: Id<"sessions"> }[] = [];
    for (let i = 0; i < 12; i++) {
      asked.push(
        await asScholar.mutation(api.wonders.ask, { question: `Wonder ${i}` }),
      );
    }
    const recent = await asScholar.query(api.wonders.recentForSelf, {});
    expect(recent.map((row) => row.question)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Wonder ${11 - i}`),
    );

    await t.run((ctx) => ctx.db.delete(asked[11].sessionId));
    const afterDelete = await asScholar.query(api.wonders.recentForSelf, {});
    expect(afterDelete[0].question).toBe("Wonder 10");
    expect(afterDelete).toHaveLength(9);

    const teacherId = await makeUser(t, "teach", "teacher");
    expect(
      await (await as(t, teacherId)).query(api.wonders.recentForSelf, {}),
    ).toEqual([]);
  });
});

describe("a wonder's chat is never a Quest (TRA-678)", () => {
  async function wonderAndPinChats(t: T, scholarId: Id<"users">) {
    const asScholar = await as(t, scholarId);
    const wonder = await asScholar.mutation(api.wonders.ask, {
      question: "Do fish get thirsty?",
    });
    // The positive control: a unit-less chat a teacher's pin opened, which
    // Home lists as a Quest.
    const pinSeedId = await insertSeed(t, scholarId);
    const pinChatId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Tide pools",
        isArchived: false,
        seedId: pinSeedId,
      }),
    );
    return { asScholar, wonder, pinChatId };
  }

  test("Home's plate leaves the wonder's chat out and keeps a seed chat that is a Quest", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "plate");
    const { asScholar, wonder, pinChatId } = await wonderAndPinChats(t, scholarId);

    const plate = await asScholar.query(api.scholarPlate.activeForMe, {
      isLimit: 0,
    });
    const questIds = plate.rows
      .filter((row) => row.origin === "is")
      .map((row) => row.sessionId);
    expect(questIds).toEqual([pinChatId]);
    expect(plate.rows.map((row) => row.sessionId)).not.toContain(wonder.sessionId);
  });

  test("hundreds of old wonders with few chats: only the listed chats' seeds decide", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "history");
    // A long wonder history whose chats are gone: the plate starts from its
    // sessions, so none of these is read.
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert("seeds", {
          scholarId,
          origin: "wonder",
          status: "active",
          suggestionType: "frontier",
          topic: `Old wonder ${i}`,
          rationale: "",
        });
      }
    });
    const { asScholar, wonder, pinChatId } = await wonderAndPinChats(t, scholarId);
    // A chat pointed at ANOTHER scholar's wonder is not this kid's wonder.
    const otherId = await makeUser(t, "other-owner");
    const othersWonder = await plantWonderRow(t, otherId, "Why do cats purr?");
    const strayChatId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Why do cats purr?",
        isArchived: false,
        seedId: othersWonder,
      }),
    );

    const plate = await asScholar.query(api.scholarPlate.activeForMe, {
      isLimit: 0,
    });
    const questIds = plate.rows
      .filter((row) => row.origin === "is")
      .map((row) => row.sessionId);
    expect(new Set(questIds)).toEqual(new Set([pinChatId, strayChatId]));
    expect(questIds).not.toContain(wonder.sessionId);
    const stray = await asScholar.query(api.sessions.getWithMessages, {
      id: strayChatId,
    });
    expect(stray.session.isWonder).toBe(false);
  });

  test("Home's Archived list leaves out an archived wonder's chat", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "archived");
    const { asScholar, wonder, pinChatId } = await wonderAndPinChats(t, scholarId);
    await t.run(async (ctx) => {
      await ctx.db.patch(wonder.sessionId, { isArchived: true });
      await ctx.db.patch(pinChatId, { isArchived: true });
    });

    const finished = await asScholar.query(api.sessions.finishedForScholar, {});
    const ids = finished.map((row) => row._id);
    expect(ids).toContain(pinChatId);
    expect(ids).not.toContain(wonder.sessionId);
  });

  test("the chat screen's session says whether it is a wonder", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "header");
    const { asScholar, wonder, pinChatId } = await wonderAndPinChats(t, scholarId);

    const wonderChat = await asScholar.query(api.sessions.getWithMessages, {
      id: wonder.sessionId,
    });
    const pinChat = await asScholar.query(api.sessions.getWithMessages, {
      id: pinChatId,
    });
    expect(wonderChat.session.isWonder).toBe(true);
    expect(pinChat.session.isWonder).toBe(false);
  });
});

describe("a wonder row's preview skips the first-ever introduction", () => {
  // Made-up replies: an opening paragraph, then the answer.
  const opening = "Hi! I'm a computer helper, not a person.";
  const answer = "Saltwater fish drink all the time. Freshwater fish hardly ever do.";
  const twoParagraphs = `${opening}\n\n${answer}`;

  async function askWithReply(t: T, scholarId: Id<"users">, content: string) {
    const asScholar = await as(t, scholarId);
    const { seedId, sessionId } = await asScholar.mutation(api.wonders.ask, {
      question: "Do fish get thirsty?",
    });
    await t.run((ctx) =>
      ctx.db.insert("messages", { sessionId, role: "assistant", content, flagged: false }),
    );
    const todays = await asScholar.query(api.wonders.todayForSelf, { dayKey: today() });
    const recent = await asScholar.query(api.wonders.recentForSelf, {});
    return {
      today: todays.wonders.find((row) => row.seedId === seedId)?.replyExcerpt,
      recent: recent.find((row) => row.seedId === seedId)?.replyExcerpt,
    };
  }

  async function earlierSession(t: T, scholarId: Id<"users">, isTestDrive?: true) {
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "An earlier chat",
        isArchived: false,
        ...(isTestDrive ? { isTestDrive } : {}),
      }),
    );
  }

  test("drops the first paragraph only when another one follows (pure)", () => {
    expect(withoutFirstParagraph(twoParagraphs)).toBe(answer);
    expect(withoutFirstParagraph(`${opening}\n  \n${answer}\n\nMore.`)).toBe(
      `${answer}\n\nMore.`,
    );
    expect(withoutFirstParagraph(`${opening} ${answer}`)).toBe(`${opening} ${answer}`);
  });

  test("in a scholar's first-ever chat the preview starts at the answer; the chat keeps it all", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "first-timer");
    const excerpt = await askWithReply(t, scholarId, twoParagraphs);
    expect(excerpt.today).toBe(answer);
    expect(excerpt.recent).toBe(answer);
    const stored = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(stored.some((message) => message.content === twoParagraphs)).toBe(true);
  });

  test("an ordinary reply, after the scholar's first session, is unchanged", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "returning");
    await earlierSession(t, scholarId);
    const excerpt = await askWithReply(t, scholarId, twoParagraphs);
    expect(excerpt.today).toBe(`${opening} ${answer}`);
    expect(excerpt.recent).toBe(`${opening} ${answer}`);
  });

  test("an earlier test-drive session doesn't make a first chat ordinary", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "rehearsed");
    await earlierSession(t, scholarId, true);
    const excerpt = await askWithReply(t, scholarId, twoParagraphs);
    expect(excerpt.today).toBe(answer);
  });
});

describe("dismissing a wonder from Scholar's Prep (seeds.dismissForSelf)", () => {
  test("it leaves Today's wonders and Earlier; its chat stays", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "dismisser");
    const asScholar = await as(t, scholarId);
    const kept = await asScholar.mutation(api.wonders.ask, {
      question: "Why is the sky blue?",
    });
    const gone = await asScholar.mutation(api.wonders.ask, {
      question: "Never mind this one",
    });

    await asScholar.mutation(api.seeds.dismissForSelf, { seedId: gone.seedId });

    const todays = await asScholar.query(api.wonders.todayForSelf, {
      dayKey: today(),
    });
    const recent = await asScholar.query(api.wonders.recentForSelf, {});
    expect(todays.wonders.map((row) => row.seedId)).toEqual([kept.seedId]);
    expect(recent.map((row) => row.seedId)).toEqual([kept.seedId]);
    expect(await t.run((ctx) => ctx.db.get(gone.sessionId))).not.toBeNull();
  });

  test("dismissed wonders don't use up Earlier's read window", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "window");
    const asScholar = await as(t, scholarId);
    const asked: Id<"seeds">[] = [];
    for (let i = 0; i < 12; i++) {
      asked.push(
        (await asScholar.mutation(api.wonders.ask, { question: `Wonder ${i}` })).seedId,
      );
    }
    for (const seedId of asked.slice(2)) {
      await asScholar.mutation(api.seeds.dismissForSelf, { seedId });
    }
    const recent = await asScholar.query(api.wonders.recentForSelf, {});
    expect(recent.map((row) => row.question)).toEqual(["Wonder 1", "Wonder 0"]);
  });
});
