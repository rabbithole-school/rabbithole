import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { seedScholarInInstitution, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

function setup() {
  return convexTest(schema, modules);
}

/** A digest with `evidence` substantive events (as predictions) for the gates. */
function digestWithEvidence(evidence: number): string {
  return JSON.stringify({
    gameId: "factor-game",
    gameVersion: 1,
    eventCount: evidence,
    activeMs: 60_000,
    phases: [],
    predictions: Array.from({ length: evidence }, (_, i) => ({
      seq: i + 1,
      atActiveMs: i * 100,
      label: "Claimed a number",
      value: String(i),
    })),
    revisions: [],
    strategyInferences: [],
    localRuleResults: [],
    scholarExplanations: [],
    helpRequests: [],
    choices: [],
    outcomeClaim: null,
  });
}

/**
 * A completed gameSession, optionally with a stored digest and seeded nodes.
 * `nodeKey` seeds a "Proper factors" node the factor-game evidence plan maps
 * onto (so it becomes a candidate); `offListNodeKey` seeds a real but unrelated
 * node that is NOT a candidate.
 */
async function seedCompletedGame(
  t: ReturnType<typeof convexTest>,
  opts: {
    nodeKey?: string;
    offListNodeKey?: string;
    status?: "active" | "completed";
    digestEvidence?: number | null;
    username?: string;
  } = {},
): Promise<{ scholarId: Id<"users">; gameSessionId: Id<"gameSessions"> }> {
  const institutionId = await seedTestInstitution(t);
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    username: opts.username ?? "s1",
    name: "Scholar One",
  });
  const gameSessionId = await t.run(async (ctx) => {
    if (opts.nodeKey) {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: opts.nodeKey,
        label: "Proper factors",
        domain: "Mathematics",
      });
    }
    if (opts.offListNodeKey) {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: opts.offListNodeKey,
        label: "Photosynthesis in leaves",
        domain: "Biology",
      });
    }
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      title: "u",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "l", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "The Factor Game",
      kind: "game",
      game: { gameId: "factor-game" },
      order: 0,
    });
    const sessionId = await ctx.db.insert("gameSessions", {
      scholarId,
      activityId,
      gameId: "factor-game",
      gameVersion: 1,
      configJson: JSON.stringify({ boardSize: 30, firstTurn: "scholar" }),
      seed: "seed-1",
      lastSeq: 10,
      activeMs: 60_000,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: opts.status ?? "completed",
    });
    if (opts.digestEvidence != null) {
      await ctx.db.insert("gameSessionDigests", {
        sessionId,
        scholarId,
        activityId,
        gameId: "factor-game",
        builtAt: Date.now(),
        digestJson: digestWithEvidence(opts.digestEvidence),
      });
    }
    return sessionId;
  });
  return { scholarId, gameSessionId };
}

/** Insert another completed gameSession for an existing scholar. */
async function seedExtraGameSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
): Promise<Id<"gameSessions">> {
  return t.run(async (ctx) => {
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      title: "u",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", { unitId, title: "l", order: 0 });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: "The Factor Game",
      kind: "game",
      game: { gameId: "factor-game" },
      order: 0,
    });
    return ctx.db.insert("gameSessions", {
      scholarId,
      activityId,
      gameId: "factor-game",
      gameVersion: 1,
      configJson: "{}",
      seed: "s",
      lastSeq: 0,
      activeMs: 1_000,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "completed",
    });
  });
}

/** Directly insert a prior game-anchored observation, for the daily-cap gate. */
async function seedPriorGameObservation(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  gameSessionId: Id<"gameSessions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("masteryObservations", {
      scholarId,
      conceptLabel: `prior ${gameSessionId}`,
      domain: "Mathematics",
      observedAt: Date.now(),
      gameSessionId,
      transcriptExcerpt: "x",
      masteryLevel: 2,
      confidenceScore: 0.4,
      evidenceSummary: "prior",
      evidenceType: "indirect_inference",
      attemptContext: "game_session",
      studentInitiated: true,
      isSuperseded: false,
    }),
  );
}

/** Fill the scholar's daily cap with 3 distinct OTHER observed game sessions. */
async function fillDailyCap(t: ReturnType<typeof convexTest>, scholarId: Id<"users">) {
  for (let i = 0; i < 3; i++) {
    const other = await seedExtraGameSession(t, scholarId);
    await seedPriorGameObservation(t, scholarId, other);
  }
}

const obs = (over: Record<string, unknown> = {}) => ({
  conceptLabel: "weighing a number against its factors",
  domain: "Mathematics",
  masteryLevel: 2,
  confidenceScore: 0.4,
  evidenceType: "indirect_inference",
  evidenceSummary: "Chose 18 and noticed it handed over many factors.",
  transcriptExcerpt: 'They predicted: "18"',
  ...over,
});

describe("gameObserver.applyGameObservations", () => {
  test("anchors rows on the game session; honors a candidate nodeKey, drops off-list and unknown ones", async () => {
    const t = setup();
    const { scholarId, gameSessionId } = await seedCompletedGame(t, {
      nodeKey: "proper_factors",
      offListNodeKey: "photosynthesis",
    });

    const { written } = await t.mutation(internal.gameObserver.applyGameObservations, {
      gameSessionId,
      // Only proper_factors was offered as a candidate this session.
      candidateNodeKeys: ["proper_factors"],
      observations: [
        obs({ nodeKey: "proper_factors" }),
        // A real node, but never offered — must be dropped (fix #3).
        obs({ conceptLabel: "off-list valid node", nodeKey: "photosynthesis" }),
        // Not a real node at all.
        obs({ conceptLabel: "made-up node", nodeKey: "does_not_exist" }),
      ],
    });
    expect(written).toBe(3);

    const rows = await t.run((ctx) =>
      ctx.db
        .query("masteryObservations")
        .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
        .collect(),
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.gameSessionId).toBe(gameSessionId);
      expect(row.sessionId).toBeUndefined();
      expect(row.attemptContext).toBe("game_session");
      expect(row.studentInitiated).toBe(true);
    }
    const known = rows.find((r) => r.conceptLabel.startsWith("weighing"));
    const offList = rows.find((r) => r.conceptLabel === "off-list valid node");
    const unknown = rows.find((r) => r.conceptLabel === "made-up node");
    expect(known?.nodeKey).toBe("proper_factors");
    expect(offList?.nodeKey).toBeUndefined();
    expect(unknown?.nodeKey).toBeUndefined();
  });

  test("dedupe: a second apply on an already-observed session writes nothing", async () => {
    const t = setup();
    const { gameSessionId } = await seedCompletedGame(t);

    const first = await t.mutation(internal.gameObserver.applyGameObservations, {
      gameSessionId,
      candidateNodeKeys: [],
      observations: [obs()],
    });
    expect(first.written).toBe(1);

    const second = await t.mutation(internal.gameObserver.applyGameObservations, {
      gameSessionId,
      candidateNodeKeys: [],
      observations: [obs({ conceptLabel: "another concept" })],
    });
    expect(second.written).toBe(0);

    const rows = await t.run((ctx) => ctx.db.query("masteryObservations").collect());
    expect(rows).toHaveLength(1);
  });

  test("caps the number of observations minted from one round", async () => {
    const t = setup();
    const { gameSessionId } = await seedCompletedGame(t);

    const { written } = await t.mutation(internal.gameObserver.applyGameObservations, {
      gameSessionId,
      candidateNodeKeys: [],
      observations: [
        obs({ conceptLabel: "a" }),
        obs({ conceptLabel: "b" }),
        obs({ conceptLabel: "c" }),
        obs({ conceptLabel: "d" }),
        obs({ conceptLabel: "e" }),
      ],
    });
    expect(written).toBe(3);

    const rows = await t.run((ctx) => ctx.db.query("masteryObservations").collect());
    expect(rows).toHaveLength(3);
  });

  test("skips an empty conceptLabel and clamps mastery/confidence into range", async () => {
    const t = setup();
    const { gameSessionId } = await seedCompletedGame(t);

    const { written } = await t.mutation(internal.gameObserver.applyGameObservations, {
      gameSessionId,
      candidateNodeKeys: [],
      observations: [
        obs({ conceptLabel: "   " }),
        obs({ conceptLabel: "real", masteryLevel: 99, confidenceScore: 4 }),
      ],
    });
    expect(written).toBe(1);

    const [row] = await t.run((ctx) => ctx.db.query("masteryObservations").collect());
    expect(row.masteryLevel).toBe(5);
    expect(row.confidenceScore).toBe(1);
  });

  test("write-time daily cap: refuses when the scholar is already at the cap", async () => {
    const t = setup();
    const { scholarId, gameSessionId } = await seedCompletedGame(t);
    // Three OTHER game sessions already observed today → at the cap of 3.
    await fillDailyCap(t, scholarId);

    const { written } = await t.mutation(internal.gameObserver.applyGameObservations, {
      gameSessionId,
      candidateNodeKeys: [],
      observations: [obs()],
    });
    expect(written).toBe(0);
  });
});

describe("gameObserver.getGameObserveContext gates", () => {
  test("skips a non-completed session", async () => {
    const t = setup();
    const { gameSessionId } = await seedCompletedGame(t, {
      status: "active",
      digestEvidence: 6,
    });
    const ctx = await t.query(internal.gameObserver.getGameObserveContext, { gameSessionId });
    expect(ctx.kind).toBe("skip");
    if (ctx.kind === "skip") expect(ctx.reason).toContain("active");
  });

  test("skips when the session was already observed (dedupe)", async () => {
    const t = setup();
    const { scholarId, gameSessionId } = await seedCompletedGame(t, { digestEvidence: 6 });
    await seedPriorGameObservation(t, scholarId, gameSessionId);
    const ctx = await t.query(internal.gameObserver.getGameObserveContext, { gameSessionId });
    expect(ctx).toEqual({ kind: "skip", reason: "already observed" });
  });

  test("skips a round below the min-evidence floor", async () => {
    const t = setup();
    const { gameSessionId } = await seedCompletedGame(t, { digestEvidence: 2 });
    const ctx = await t.query(internal.gameObserver.getGameObserveContext, { gameSessionId });
    expect(ctx).toEqual({ kind: "skip", reason: "too short" });
  });

  test("skips when the per-scholar daily cap is reached", async () => {
    const t = setup();
    const { scholarId, gameSessionId } = await seedCompletedGame(t, { digestEvidence: 6 });
    await fillDailyCap(t, scholarId);
    const ctx = await t.query(internal.gameObserver.getGameObserveContext, { gameSessionId });
    expect(ctx).toEqual({ kind: "skip", reason: "daily cap reached" });
  });

  test("passes every gate on a fresh, long-enough completed session", async () => {
    const t = setup();
    const { gameSessionId } = await seedCompletedGame(t, {
      nodeKey: "proper_factors",
      digestEvidence: 6,
    });
    const ctx = await t.query(internal.gameObserver.getGameObserveContext, { gameSessionId });
    expect(ctx.kind).toBe("assess");
    if (ctx.kind === "assess") {
      // The factor-game evidence plan maps a concept onto the seeded node.
      expect(ctx.candidates.map((c) => c.nodeKey)).toContain("proper_factors");
    }
  });
});
