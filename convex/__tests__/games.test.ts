import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" = "scholar",
  username = "test-scholar",
) {
  const institutionId = await seedTestInstitution(t);
  return role === "teacher"
    ? seedStaffWithMembership(t, { institutionId, username, name: `Test ${role}` })
    : seedScholarInInstitution(t, { institutionId, username, name: `Test ${role}` });
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

async function seedGameActivity(
  t: ReturnType<typeof convexTest>,
  teacherId: Id<"users">,
  gameId = "toy-warmer-colder",
) {
  return t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Games unit",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Games lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "Warmer or colder",
      kind: "game",
      game: { gameId },
      order: 0,
    });
    return { unitId, lessonId, activityId };
  });
}

function setup() {
  return convexTest(schema, modules);
}

describe("games — session lifecycle", () => {
  test("start creates a session with a server-generated seed", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const started = await asScholar.mutation(api.games.start, { activityId });
    expect(started.gameId).toBe("toy-warmer-colder");
    expect(started.lastSeq).toBe(0);
    expect(started.seed.length).toBeGreaterThan(0);
    // The authored config is frozen onto the session at start, so a mid-round
    // teacher edit cannot reinterpret a finished round under different rules.
    expect(JSON.parse(started.configJson)).toEqual({ tiles: 8 });
  });

  test("start respects per-scholar activity targeting", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const targetedScholarId = await seedUser(t, "scholar", "s2");
    const { unitId, activityId } = await seedGameActivity(t, teacherId);
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId,
        unitId,
        scholarIds: [scholarId, targetedScholarId],
        startedAt: Date.now(),
        activitySchedule: [
          {
            activityId,
            mode: "classFocus",
            setAt: Date.now() - 60_000,
            scholarIds: [targetedScholarId],
          },
        ],
      }),
    );

    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.games.start, { activityId, assignmentId }),
    ).rejects.toThrow("Assignment does not include activity");
    expect(
      await t.run((ctx) => ctx.db.query("gameSessions").collect()),
    ).toHaveLength(0);

    const asTargetedScholar = await withUser(t, targetedScholarId);
    await expect(
      asTargetedScholar.mutation(api.games.start, {
        activityId,
        assignmentId,
      }),
    ).resolves.toMatchObject({ gameId: "toy-warmer-colder" });
  });

  test("starting again ABANDONS the old round and opens a fresh one", async () => {
    // A round is never resumed. What survives an interruption is the EVIDENCE,
    // and it already reached the server per move — so the interrupted session
    // is closed, digested and left in the record, and the scholar starts over.
    // This is deliberate: resume was the single largest source of defects in
    // the host's first pass, and the sharper hazard was never losing state, it
    // was resuming INTO the state that crashed you.
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const first = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.checkpoint, {
      sessionId: first.sessionId,
      events: [{ eventKey: "guess_half", payload: { kind: "prediction_recorded", value: "left" } }],
      atActiveMs: 1_200,
      expectedLastSeq: 0,
    });

    const second = await asScholar.mutation(api.games.start, { activityId });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.seed).not.toBe(first.seed);
    expect(second.lastSeq).toBe(0);

    await t.run(async (ctx) => {
      const old = (await ctx.db.get(first.sessionId))!;
      expect(old.status).toBe("abandoned");
      expect(old.endedAt).toBeTypeOf("number");
      // The evidence is not thrown away — it is digested where it stopped.
      const digest = await ctx.db
        .query("gameSessionDigests")
        .withIndex("by_session", (q) => q.eq("sessionId", first.sessionId))
        .first();
      expect(digest).toBeTruthy();
      expect(JSON.parse(digest!.digestJson).predictions).toHaveLength(1);
      // …and it grants no credit.
      expect(await ctx.db.query("activityCompletions").collect()).toHaveLength(0);
    });
  });

  test("abandon closes and digests the round, granting no completion", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);

    const started = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      events: [{ eventKey: "phase", payload: { kind: "phase_changed", phase: "predict" } }],
      atActiveMs: 800,
      expectedLastSeq: 0,
    });
    const { digestId } = await asScholar.mutation(api.games.abandon, {
      sessionId: started.sessionId,
    });
    expect(digestId).toBeTruthy();

    await t.run(async (ctx) => {
      expect((await ctx.db.get(started.sessionId))!.status).toBe("abandoned");
      expect(await ctx.db.query("activityCompletions").collect()).toHaveLength(0);
    });

    // Closed to further writes, exactly like a completed one.
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        events: [{ eventKey: "phase", payload: { kind: "phase_changed", phase: "probe1" } }],
        atActiveMs: 900,
        expectedLastSeq: 1,
      }),
    ).rejects.toThrow(/not active/i);
  });

  test("an unknown gameId is rejected rather than launched", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId, "not-a-real-game");
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.games.start, { activityId }),
    ).rejects.toThrow(/Unknown game/);
  });

  test("a non-game activity is rejected", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const activityId = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId,
        title: "u",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", { unitId, title: "l", order: 0 });
      return ctx.db.insert("activities", {
        lessonId,
        title: "a",
        kind: "online",
        order: 0,
      });
    });
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.mutation(api.games.start, { activityId }),
    ).rejects.toThrow(/Not a game activity/);
  });

  test("requires auth", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const { activityId } = await seedGameActivity(t, teacherId);
    await expect(t.mutation(api.games.start, { activityId })).rejects.toThrow();
  });

  test("a session belongs to its owner — another scholar cannot write to it", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const intruderId = await seedUser(t, "scholar", "s2");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const asIntruder = await withUser(t, intruderId);

    const started = await asScholar.mutation(api.games.start, { activityId });
    await expect(
      asIntruder.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        atActiveMs: 100,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow(/Forbidden/);
  });
});

describe("games — evidence ingest", () => {
  async function startedSession() {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const started = await asScholar.mutation(api.games.start, { activityId });
    return { t, asScholar, started, activityId, scholarId };
  }

  test("stamps contiguous seq numbers a game cannot supply itself", async () => {
    const { t, asScholar, started } = await startedSession();
    const ack = await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      events: [
        { eventKey: "phase", payload: { kind: "phase_changed", phase: "predict" } },
        { eventKey: "guess_half", payload: { kind: "prediction_recorded", value: "left" } },
      ],
      atActiveMs: 800,
      expectedLastSeq: 0,
    });
    expect(ack.lastSeq).toBe(2);
    const rows = await t.run(async (ctx) => ctx.db.query("gameEvents").collect());
    expect(rows.map((r) => r.seq).sort()).toEqual([1, 2]);
    expect(rows.every((r) => r.receivedAt > 0)).toBe(true);
  });

  test("rejects an eventKey the server's plan does not declare", async () => {
    const { asScholar, started } = await startedSession();
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        events: [
          { eventKey: "smuggled", payload: { kind: "scholar_explained", text: "hi" } },
        ],
        atActiveMs: 100,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow(/Undeclared eventKey/);
  });

  test("rejects a payload kind outside the closed union", async () => {
    const { asScholar, started } = await startedSession();
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        events: [{ eventKey: "guess_half", payload: { kind: "mastery_earned" } }],
        atActiveMs: 100,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow(/unknown event kind/);
  });

  test("rejects a stale batch instead of double-appending a retry", async () => {
    const { asScholar, started } = await startedSession();
    await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      events: [{ eventKey: "first_tap", payload: { kind: "choice_made", choice: "2" } }],
      atActiveMs: 100,
      expectedLastSeq: 0,
    });
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        events: [{ eventKey: "first_tap", payload: { kind: "choice_made", choice: "2" } }],
        atActiveMs: 120,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow(/Stale checkpoint/);
  });

  test("a rejected batch writes nothing at all", async () => {
    const { t, asScholar, started } = await startedSession();
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        events: [
          { eventKey: "first_tap", payload: { kind: "choice_made", choice: "2" } },
          { eventKey: "nope", payload: { kind: "choice_made", choice: "3" } },
        ],
        atActiveMs: 100,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow();
    const rows = await t.run(async (ctx) => ctx.db.query("gameEvents").collect());
    expect(rows).toHaveLength(0);
  });

  test("host-reserved keys are accepted on the host channel", async () => {
    const { asScholar, started } = await startedSession();
    const ack = await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      hostEvents: [{ eventKey: "host.help", payload: { kind: "help_requested" } }],
      atActiveMs: 500,
      expectedLastSeq: 0,
    });
    expect(ack.lastSeq).toBe(1);
  });

  test("a GAME cannot forge a host event on its own channel", async () => {
    // "Stuck?" is host chrome precisely so a game can neither suppress nor
    // fake it. Without this the game-facing channel accepts `host.help` and a
    // game can manufacture help requests it never received.
    const { asScholar, started } = await startedSession();
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        events: [{ eventKey: "host.help", payload: { kind: "help_requested" } }],
        atActiveMs: 500,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow(/Reserved eventKey/);
  });

  test("rejects an unknown payload field rather than storing it verbatim", async () => {
    // The payload union is a compile-time fiction unless the runtime closes it:
    // `{kind:"choice_made", choice:"a", mastery:true}` used to validate and be
    // persisted exactly as written.
    const { asScholar, started } = await startedSession();
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        events: [
          {
            eventKey: "first_tap",
            payload: { kind: "choice_made", choice: "3", mastery: true },
          },
        ],
        atActiveMs: 100,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow(/unknown field "mastery"/);
  });

  test("records WHO acted, so a bot's move is never read as the scholar's", async () => {
    const { t, asScholar, started } = await startedSession();
    await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      events: [
        { eventKey: "first_tap", payload: { kind: "choice_made", choice: "3" } },
        {
          eventKey: "first_tap",
          payload: { kind: "choice_made", choice: "6" },
          actor: "opponent",
        },
      ],
      atActiveMs: 100,
      expectedLastSeq: 0,
    });
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("gameEvents")
        .withIndex("by_session_seq", (q) => q.eq("sessionId", started.sessionId))
        .collect();
      expect(rows.map((r) => r.actor)).toEqual(["scholar", "opponent"]);
    });
  });
});

describe("games — completion", () => {
  async function playAndComplete(t: ReturnType<typeof convexTest>) {
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId, unitId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const started = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      events: [
        { eventKey: "phase", payload: { kind: "phase_changed", phase: "predict" } },
        { eventKey: "guess_half", payload: { kind: "prediction_recorded", value: "left" } },
        {
          eventKey: "feedback_shown",
          payload: { kind: "observation_recorded", value: "colder" },
        },
      ],
      atActiveMs: 2_000,
      expectedLastSeq: 0,
    });
    const done = await asScholar.mutation(api.games.requestCompletion, {
      sessionId: started.sessionId,
      outcomeKey: "found",
      events: [
        { eventKey: "round_ended", payload: { kind: "outcome_claimed", outcomeKey: "found" } },
      ],
      atActiveMs: 3_000,
      expectedLastSeq: 3,
    });
    return { scholarId, activityId, unitId, started, done };
  }

  test("re-derives the digest server-side and records it once", async () => {
    const t = setup();
    const { done } = await playAndComplete(t);
    expect(done.digestId).not.toBeNull();
    const digests = await t.run(async (ctx) =>
      ctx.db.query("gameSessionDigests").collect(),
    );
    expect(digests).toHaveLength(1);
    const digest = JSON.parse(digests[0].digestJson);
    expect(digest.gameId).toBe("toy-warmer-colder");
    expect(digest.predictions[0].outcome.value).toBe("colder");
    expect(digest.outcomeClaim.outcomeKey).toBe("found");
    expect(digest.activeMs).toBe(3_000);
  });

  test("the digest never carries raw game state", async () => {
    const t = setup();
    await playAndComplete(t);
    const [digest] = await t.run(async (ctx) =>
      ctx.db.query("gameSessionDigests").collect(),
    );
    expect(digest.digestJson).not.toContain("secret");
  });

  // The SYNCHRONOUS completion path writes zero of all four tables directly.
  // Two legs are doctrine, two are a purity check on the sync path:
  //   • practiceMastery / practiceAttempts — ABSOLUTE (D-3): a game never mints
  //     SR credit. If someone wires a mastery/attempt writer into this path,
  //     this test is what fails.
  //   • masteryObservations / analyses — the game OBSERVER may write portrait
  //     observations, but only ASYNCHRONOUSLY, in the scheduled gameObserver
  //     pass (never inline here). This short round trips the observer's
  //     min-length gate (it skips before any write), so the count still holds —
  //     what the assertion pins is that the synchronous path itself stays pure.
  test("completion's synchronous path writes NO mastery, practice or analysis row", async () => {
    const t = setup();
    await playAndComplete(t);
    const counts = await t.run(async (ctx) => ({
      practiceMastery: (await ctx.db.query("practiceMastery").collect()).length,
      practiceAttempts: (await ctx.db.query("practiceAttempts").collect()).length,
      masteryObservations: (await ctx.db.query("masteryObservations").collect()).length,
      analyses: (await ctx.db.query("analyses").collect()).length,
    }));
    expect(counts).toEqual({
      practiceMastery: 0,
      practiceAttempts: 0,
      masteryObservations: 0,
      analyses: 0,
    });
  });

  test("completion writes exactly one activityCompletions row", async () => {
    const t = setup();
    const { done } = await playAndComplete(t);
    expect(done.completed).toBe(true);
    const completions = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(1);
  });

  test("a completed session is closed to further writes", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const started = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.requestCompletion, {
      sessionId: started.sessionId,
      outcomeKey: "found",
      atActiveMs: 1_000,
      expectedLastSeq: 0,
    });
    await expect(
      asScholar.mutation(api.games.checkpoint, {
        sessionId: started.sessionId,
        atActiveMs: 1_100,
        expectedLastSeq: 0,
      }),
    ).rejects.toThrow(/not active/);
  });

  test("a crash still keeps the evidence but records no completion", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const started = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      events: [
        { eventKey: "guess_half", payload: { kind: "prediction_recorded", value: "left" } },
      ],
      atActiveMs: 900,
      expectedLastSeq: 0,
    });
    const crashed = await asScholar.mutation(api.games.reportCrash, {
      sessionId: started.sessionId,
    });
    expect(crashed.digestId).not.toBeNull();
    const completions = await t.run(async (ctx) =>
      ctx.db.query("activityCompletions").collect(),
    );
    expect(completions).toHaveLength(0);
    const [digest] = await t.run(async (ctx) =>
      ctx.db.query("gameSessionDigests").collect(),
    );
    expect(JSON.parse(digest.digestJson).predictions).toHaveLength(1);
  });
});

describe("games — reads", () => {
  test("handoff grounding is unavailable to another scholar", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const otherId = await seedUser(t, "scholar", "s2");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const started = await asScholar.mutation(api.games.start, { activityId });

    const context = await t.query(internal.games.handoffContext, {
      sessionId: started.sessionId,
      callerUserId: otherId,
    });

    expect(context).toBeNull();
  });

  test("handoff grounding renders same-round thinking for a live session", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const started = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.checkpoint, {
      sessionId: started.sessionId,
      events: [
        { eventKey: "phase", payload: { kind: "phase_changed", phase: "probe" } },
        {
          eventKey: "guess_half",
          payload: { kind: "prediction_recorded", value: "the left half" },
        },
        {
          eventKey: "first_tap",
          payload: { kind: "scholar_explained", text: "I started near the middle" },
        },
      ],
      atActiveMs: 1_500,
      expectedLastSeq: 0,
    });

    const context = await t.query(internal.games.handoffContext, {
      sessionId: started.sessionId,
      callerUserId: scholarId,
    });

    expect(context?.gameTitle).toBe("Warmer or Colder (toy)");
    expect(context?.currentPhase).toBe("probe");
    expect(context?.roundSoFar).toContain('They predicted: "the left half"');
    expect(context?.roundSoFar).toContain(
      'In their own words: "I started near the middle"',
    );
  });

  test("handoff grounding never reads the checkpointed final state", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.games.start, { activityId });
    const second = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.requestCompletion, {
      sessionId: second.sessionId,
      outcomeKey: "found",
      events: [
        {
          eventKey: "first_tap",
          payload: { kind: "scholar_explained", text: "I followed the warmer clue" },
        },
      ],
      atActiveMs: 1_200,
      expectedLastSeq: 0,
      finalStateJson: JSON.stringify({ secret: "FINAL_STATE_MUST_STAY_OPAQUE" }),
    });

    const context = await t.query(internal.games.handoffContext, {
      sessionId: second.sessionId,
      callerUserId: scholarId,
    });

    expect(context?.roundSoFar).toContain(
      'In their own words: "I followed the warmer clue"',
    );
    expect(context?.roundSoFar).not.toContain("FINAL_STATE_MUST_STAY_OPAQUE");
  });

  test("a teacher can review a scholar's sessions from a browser (reviewing is not playing)", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const scholarId = await seedUser(t, "scholar", "s1");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asScholar = await withUser(t, scholarId);
    const asTeacher = await withUser(t, teacherId);

    const started = await asScholar.mutation(api.games.start, { activityId });
    await asScholar.mutation(api.games.requestCompletion, {
      sessionId: started.sessionId,
      outcomeKey: "missed",
      events: [
        { eventKey: "round_ended", payload: { kind: "outcome_claimed", outcomeKey: "missed" } },
      ],
      atActiveMs: 4_200,
      expectedLastSeq: 0,
    });

    const rows = await asTeacher.query(api.games.listRecentForScholar, { scholarId });
    expect(rows).toHaveLength(1);
    expect(rows[0].gameTitle).toBe("Warmer or Colder (toy)");
    expect(rows[0].outcomeKey).toBe("missed");
    expect(rows[0].digest?.outcomeClaim?.outcomeKey).toBe("missed");
  });

  test("a scholar cannot read another scholar's sessions", async () => {
    const t = setup();
    const scholarId = await seedUser(t, "scholar", "s1");
    const otherId = await seedUser(t, "scholar", "s2");
    const asOther = await withUser(t, otherId);
    await expect(
      asOther.query(api.games.listRecentForScholar, { scholarId }),
    ).rejects.toThrow();
  });
});

describe("games — /practice-handoff route rejects a bad game session cleanly", () => {
  // The route resolves a game handoff by running internal.games.handoffContext
  // inside a `.catch(() => null)`. A malformed id fails that query's arg
  // validator and an unauthorized (but well-formed) id returns null; BOTH must
  // fall through to the shared clean 400 ("can't be talked through"), never a
  // 500 that would leak an internal failure or a not-yours session's existence.
  const postGameHandoff = (
    as: Awaited<ReturnType<typeof withUser>>,
    gameSessionId: string,
  ) =>
    as.fetch("/practice-handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        gameSessionId,
        messages: [{ role: "user", content: "help me talk this through" }],
      }),
    });

  test("a malformed gameSessionId is a 400, not a 500", async () => {
    const t = setup();
    const scholarId = await seedUser(t, "scholar", "s1");
    const asScholar = await withUser(t, scholarId);

    const res = await postGameHandoff(asScholar, "not-a-real-id");

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(await res.json()).toEqual({
      error: "This one can't be talked through — try another.",
    });
  });

  test("another scholar's real gameSessionId is a 400, not a 500 and not a leak", async () => {
    const t = setup();
    const teacherId = await seedUser(t, "teacher", "t1");
    const ownerId = await seedUser(t, "scholar", "owner");
    const intruderId = await seedUser(t, "scholar", "intruder");
    const { activityId } = await seedGameActivity(t, teacherId);
    const asOwner = await withUser(t, ownerId);
    const started = await asOwner.mutation(api.games.start, { activityId });

    const asIntruder = await withUser(t, intruderId);
    const res = await postGameHandoff(asIntruder, started.sessionId);

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(await res.json()).toEqual({
      error: "This one can't be talked through — try another.",
    });
  });
});
