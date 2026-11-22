/**
 * The observer's ideas, written live (TRA-679): what a kid sees of them in
 * "Things to wonder about", what the observer reads back as its own pool,
 * and how the tutor's seed list labels them. The cap, dedupe and pinned rules
 * are in seedCap.test.ts and seedRefresh.test.ts.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { STARTER_IDEAS_LIMIT } from "../lib/questionQueue";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function makeUser(t: T, username: string, role: Doc<"users">["role"] = "scholar") {
  return await t.run((ctx) => ctx.db.insert("users", { name: username, username, role }));
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

/** The observer writing an idea, through the real write path. */
async function observerIdea(
  t: T,
  scholarId: Id<"users">,
  topic: string,
  scholarInvitation?: string,
) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("sessions", { userId: scholarId, title: "Observed", isArchived: false }),
  );
  return await t.mutation(internal.seeds.record, {
    scholarId,
    sessionId,
    topic,
    suggestionType: "frontier",
    rationale: `Teacher-only note about ${topic}`,
    scholarInvitation,
  });
}

async function teacherPin(t: T, scholarId: Id<"users">, teacherId: Id<"users">, topic: string) {
  return await t.run((ctx) =>
    ctx.db.insert("seeds", {
      scholarId,
      origin: "teacher",
      status: "active",
      suggestionType: "teacher_suggestion",
      topic,
      rationale: "Teacher-only note",
      scholarInvitation: `Want to explore ${topic}?`,
      teacherId,
    }),
  );
}

describe("Things to wonder about lists live observer ideas (TRA-679)", () => {
  test("a live idea with kid-readable text is a starter from Rabbithole; a null-text one is not", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "kid");
    const listed = await observerIdea(t, scholarId, "Tides", "Why does the sea come in twice a day?");
    // No scholarInvitation: its only text is the teacher-only rationale, so a
    // kid has nothing to read (seedScholarText is null).
    const noText = await observerIdea(t, scholarId, "Moon pull");

    const starters = await (await as(t, scholarId)).query(
      api.questionQueue.startersForSelf,
      {},
    );
    const ids = starters.map((row) => row.seedId);
    expect(ids).toContain(listed);
    expect(ids).not.toContain(noText);
    expect(starters.find((row) => row.seedId === listed)).toMatchObject({
      line: "Why does the sea come in twice a day?",
      source: "idea",
      detail: null,
    });
  });

  test("a few at most, newest first; pending ideas from before, and started ones, stay out", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "many");
    // An idea written before TRA-679 is still pending.
    const legacy = await t.run((ctx) =>
      ctx.db.insert("seeds", {
        scholarId,
        origin: "ai",
        status: "pending",
        suggestionType: "frontier",
        topic: "Old idea",
        rationale: "note",
        scholarInvitation: "An old question?",
      }),
    );
    const ideas: Id<"seeds">[] = [];
    for (let i = 0; i < STARTER_IDEAS_LIMIT + 2; i++) {
      ideas.push(await observerIdea(t, scholarId, `Idea ${i}`, `Question ${i}?`));
    }
    // The newest idea already has a chat: it is no longer something to ask.
    await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "Question",
        isArchived: false,
        seedId: ideas[ideas.length - 1],
      }),
    );

    const starters = await (await as(t, scholarId)).query(
      api.questionQueue.startersForSelf,
      {},
    );
    const ideaRows = starters.filter((row) => row.source === "idea");
    expect(ideaRows.map((row) => row.line)).toEqual(
      Array.from({ length: STARTER_IDEAS_LIMIT }, (_, i) => `Question ${STARTER_IDEAS_LIMIT - i}?`),
    );
    expect(starters.map((row) => row.seedId)).not.toContain(legacy);
  });
});

describe("the observer reads its own live ideas once, as its pool (TRA-679)", () => {
  test("its pool holds live and older pending ideas; its active-seed context holds everything else", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "observed");
    const teacherId = await makeUser(t, "teach", "teacher");
    const live = await observerIdea(t, scholarId, "Live idea", "A live question?");
    const pin = await teacherPin(t, scholarId, teacherId, "A pinned idea");

    const pool = await t.query(internal.seeds.pendingObserverByScholar, { scholarId });
    const active = await t.query(internal.seeds.activeByScholar, { scholarId });
    expect(pool.map((seed) => seed._id)).toEqual([live]);
    expect(active.map((seed) => seed._id)).toEqual([pin]);
  });
});

describe("the tutor's seed list (TRA-679)", () => {
  test("a live observer idea is never teacher-approved, and the list stays the same size", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await makeUser(t, "tutored");
    const teacherId = await makeUser(t, "pinner", "teacher");
    await observerIdea(t, scholarId, "Live idea", "A live question?");
    await teacherPin(t, scholarId, teacherId, "A pinned idea");
    const sessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", { userId: scholarId, title: "Chat", isArchived: false }),
    );

    const context = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    const seeds = context?.seeds ?? [];
    expect(seeds.find((seed) => seed.topic === "Live idea")?.approved).toBe(false);
    expect(seeds.find((seed) => seed.topic === "A pinned idea")?.approved).toBe(true);
    // Two live seeds in, two seeds listed: written live, the idea is listed
    // once, as it was when it was pending.
    expect(seeds).toHaveLength(2);
  });
});
