import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { buildTutorSystemPrompt } from "../sessionStreamHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestInstance = ReturnType<typeof convexTest>;

async function seedUser(
  t: TestInstance,
  role: "scholar" | "teacher",
  username: string,
) {
  return t.run(async (ctx) =>
    ctx.db.insert("users", { name: username, username, role }),
  );
}

async function withUser(t: TestInstance, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
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

async function setupFixture() {
  const t = convexTest(schema, modules);
  const teacherId = await seedUser(t, "teacher", "teacher");
  const scholarId = await seedUser(t, "scholar", "scholar-one");
  const otherScholarId = await seedUser(t, "scholar", "scholar-two");

  const curriculum = await t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Games and debriefs",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Search strategies",
      order: 0,
    });
    const otherLessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Something else",
      order: 1,
    });
    const gameActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Find the hidden tile",
      kind: "game",
      game: { gameId: "toy-warmer-colder" },
      order: 0,
    });
    const debriefActivityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Talk through your strategy",
      kind: "online",
      systemPrompt: "Ask about the scholar's strategy.",
      order: 1,
    });
    const otherActivityId = await ctx.db.insert("activities", {
      lessonId: otherLessonId,
      title: "Different lesson conversation",
      kind: "online",
      order: 0,
    });
    return {
      unitId,
      lessonId,
      otherLessonId,
      gameActivityId,
      debriefActivityId,
      otherActivityId,
    };
  });

  async function createTutorSession(
    userId: Id<"users">,
    activityId: Id<"activities">,
    lessonId: Id<"lessons">,
  ) {
    return t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId,
        unitId: curriculum.unitId,
        lessonId,
        activityId,
        title: "Debrief",
        isArchived: false,
      }),
    );
  }

  return {
    t,
    teacherId,
    scholarId,
    otherScholarId,
    ...curriculum,
    sameLessonSessionId: await createTutorSession(
      scholarId,
      curriculum.debriefActivityId,
      curriculum.lessonId,
    ),
    otherLessonSessionId: await createTutorSession(
      scholarId,
      curriculum.otherActivityId,
      curriculum.otherLessonId,
    ),
    otherScholarSessionId: await createTutorSession(
      otherScholarId,
      curriculum.debriefActivityId,
      curriculum.lessonId,
    ),
  };
}

async function completeRound(
  t: TestInstance,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
  prediction: string,
  explanation: string,
  finalStateJson?: string,
) {
  const asScholar = await withUser(t, scholarId);
  const started = await asScholar.mutation(api.games.start, { activityId });
  await asScholar.mutation(api.games.checkpoint, {
    sessionId: started.sessionId,
    events: [
      {
        eventKey: "guess_half",
        payload: { kind: "prediction_recorded", value: prediction },
      },
      {
        eventKey: "first_tap",
        payload: { kind: "scholar_explained", text: explanation },
      },
    ],
    atActiveMs: 1_000,
    expectedLastSeq: 0,
  });
  const completed = await asScholar.mutation(api.games.requestCompletion, {
    sessionId: started.sessionId,
    outcomeKey: "found",
    atActiveMs: 2_000,
    expectedLastSeq: 2,
    finalStateJson,
  });
  if (!completed.digestId) throw new Error("Expected a completed-round digest");
  return completed.digestId;
}

async function promptFor(t: TestInstance, sessionId: Id<"sessions">) {
  const context = await t.query(internal.sessionHelpers.getSessionContext, {
    sessionId,
  });
  if (!context) throw new Error("Expected tutor session context");
  return buildTutorSystemPrompt(context);
}

describe("session game context", () => {
  test("same-lesson game evidence reaches the debrief tutor", async () => {
    const fixture = await setupFixture();
    await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "the left half",
      "I started near the middle",
    );

    const prompt = await promptFor(fixture.t, fixture.sameLessonSessionId);
    expect(prompt).toContain("Their recent game round");
    expect(prompt).toContain("Warmer or Colder (toy)");
    expect(prompt).toContain('They predicted: "the left half"');
  });

  test("a session in a different lesson receives no game section", async () => {
    const fixture = await setupFixture();
    await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "same scholar, other lesson",
      "This should stay in its lesson",
    );

    const prompt = await promptFor(fixture.t, fixture.otherLessonSessionId);
    expect(prompt).not.toContain("Their recent game round");
  });

  test("a different scholar in the same lesson receives no game section", async () => {
    const fixture = await setupFixture();
    await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "scholar one's prediction",
      "Only scholar one said this",
    );

    const prompt = await promptFor(fixture.t, fixture.otherScholarSessionId);
    expect(prompt).not.toContain("Their recent game round");
  });

  test("a synthetic Test Drive skips the scholar-keyed game digest read", async () => {
    const fixture = await setupFixture();
    await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "the owner's prediction",
      "This exists only to catch an accidental owner lookup",
    );
    const syntheticSessionId = await fixture.t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: fixture.scholarId,
        unitId: fixture.unitId,
        lessonId: fixture.lessonId,
        activityId: fixture.debriefActivityId,
        title: "Synthetic Test Drive",
        isArchived: false,
        isTestDrive: true,
        testDriveSyntheticName: "Synthetic Scholar",
      }),
    );

    const prompt = await promptFor(fixture.t, syntheticSessionId);
    expect(prompt).not.toContain("Their recent game round");
    expect(prompt).not.toContain("the owner's prediction");
  });

  test("two rounds of one activity contribute only the newest round once", async () => {
    const fixture = await setupFixture();
    const oldDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "old prediction",
      "old explanation",
    );
    const newDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "new prediction",
      "new explanation",
    );
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(oldDigestId, { builtAt: 1 });
      await ctx.db.patch(newDigestId, { builtAt: 2 });
    });

    const prompt = await promptFor(fixture.t, fixture.sameLessonSessionId);
    expect(prompt).not.toContain("old prediction");
    expect(prompt.split('They predicted: "new prediction"')).toHaveLength(2);
    expect(prompt.split("## Their recent game round")).toHaveLength(2);
  });

  test("a corrupt newest digest falls back to an older valid round for the activity", async () => {
    const fixture = await setupFixture();
    const oldDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "valid older prediction",
      "valid older explanation",
    );
    const newDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "new prediction that will be corrupted",
      "new explanation that will be corrupted",
    );
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(oldDigestId, { builtAt: 1 });
      await ctx.db.patch(newDigestId, { builtAt: 2, digestJson: "{" });
    });

    const prompt = await promptFor(fixture.t, fixture.sameLessonSessionId);
    expect(prompt).toContain('They predicted: "valid older prediction"');
    expect(prompt).not.toContain("new prediction that will be corrupted");
    expect(prompt.split("## Their recent game round")).toHaveLength(2);
  });

  test("an unexpected-shaped newest digest falls back to an older valid round", async () => {
    const fixture = await setupFixture();
    const oldDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "valid older prediction",
      "valid older explanation",
    );
    const newDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "new prediction with an invalid digest shape",
      "new explanation with an invalid digest shape",
    );
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(oldDigestId, { builtAt: 1 });
      await ctx.db.patch(newDigestId, { builtAt: 2, digestJson: "{}" });
    });

    const prompt = await promptFor(fixture.t, fixture.sameLessonSessionId);
    expect(prompt).toContain('They predicted: "valid older prediction"');
    expect(prompt).not.toContain("new prediction with an invalid digest shape");
    expect(prompt.split("## Their recent game round")).toHaveLength(2);
  });

  test("three distinct same-lesson activities contribute at most two rounds, newest first", async () => {
    const fixture = await setupFixture();
    const [middleActivityId, newestActivityId] = await fixture.t.run(
      async (ctx) =>
        Promise.all([
          ctx.db.insert("activities", {
            lessonId: fixture.lessonId,
            title: "Second hidden tile game",
            kind: "game",
            game: { gameId: "toy-warmer-colder" },
            order: 1,
          }),
          ctx.db.insert("activities", {
            lessonId: fixture.lessonId,
            title: "Third hidden tile game",
            kind: "game",
            game: { gameId: "toy-warmer-colder" },
            order: 2,
          }),
        ]),
    );
    const oldestDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "oldest distinct prediction",
      "oldest distinct explanation",
    );
    const middleDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      middleActivityId,
      "middle distinct prediction",
      "middle distinct explanation",
    );
    const newestDigestId = await completeRound(
      fixture.t,
      fixture.scholarId,
      newestActivityId,
      "newest distinct prediction",
      "newest distinct explanation",
    );
    await fixture.t.run(async (ctx) => {
      await ctx.db.patch(oldestDigestId, { builtAt: 1 });
      await ctx.db.patch(middleDigestId, { builtAt: 2 });
      await ctx.db.patch(newestDigestId, { builtAt: 3 });
    });

    const prompt = await promptFor(fixture.t, fixture.sameLessonSessionId);
    expect(prompt.split("## Their recent game round")).toHaveLength(3);
    expect(prompt).not.toContain("oldest distinct prediction");
    expect(prompt.indexOf("newest distinct prediction")).toBeLessThan(
      prompt.indexOf("middle distinct prediction"),
    );
  });

  test("the prompt never includes opaque final game state", async () => {
    const fixture = await setupFixture();
    await completeRound(
      fixture.t,
      fixture.scholarId,
      fixture.gameActivityId,
      "safe digest evidence",
      "The digest can include my words",
      JSON.stringify({ secret: "FINAL_STATE_MUST_STAY_OPAQUE" }),
    );

    const prompt = await promptFor(fixture.t, fixture.sameLessonSessionId);
    expect(prompt).toContain("safe digest evidence");
    expect(prompt).not.toContain("FINAL_STATE_MUST_STAY_OPAQUE");
  });
});
