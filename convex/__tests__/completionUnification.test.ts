// "One completion, one truth" — proves the completion surfaces agree.
//
// Week-2 pilot (a blind 5-day scholar sim) surfaced ledgers disagreeing: the
// completed quests re-surfaced as fresh "Suggested by your teacher" Start cards,
// and quest cards showed "1/3" despite full-mark payouts. Root shape: multiple
// completion projections (activityCompletions, seed/quest state, and session
// card state) derived "done" independently.
//
// These tests drive a real quest through BOTH completion paths (a rubric pass
// and the conversation-only mark_activity_complete tool) and assert the teacher
// quest card (units.listScholarAuthored), seed status, and scholar's "suggested
// quests" all agree afterwards. They also pin the deliberate boundary that an
// activity completion does not create a daily map-movement receipt.

import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

// ── Fixtures ─────────────────────────────────────────────────────────

async function seedUser(
  t: TC,
  role: "scholar" | "teacher" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: overrides.name ?? `Test ${role}`,
      username:
        overrides.username ?? `${role}-${Math.random().toString(36).slice(2, 8)}`,
      role,
    }),
  );
}

async function withUser(t: TC, userId: Id<"users">) {
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

type QuestShape = {
  /** conversation-only online activity (mark_activity_complete path) */
  conversation?: boolean;
  /** advanceRubric online activity (rubric-pass path) */
  advanceRubric?: boolean;
  /** stamp the launching session with the offer seed's id (a "started" quest) */
  stampSeedOnSession?: boolean;
  /** run the quest activity through a teacher assignment */
  assigned?: boolean;
  title?: string;
};

/**
 * A teacher-offered, scholar-authored quest: a unit with a badge + one online
 * activity, an `active` teacher offer seed pointing at it, and a launched
 * session. Mirrors units.createAndOfferQuestForScholar + createFromSeed.
 */
async function makeQuest(
  t: TC,
  teacherId: Id<"users">,
  scholarId: Id<"users">,
  shape: QuestShape = {},
) {
  return await t.run(async (ctx) => {
    const title = shape.title ?? "Secret Codes";
    const unitId = await ctx.db.insert("units", {
      teacherId: scholarId,
      title,
      emoji: "🔐",
      isActive: true,
      authorScholarId: scholarId,
      authorRole: "inspired",
      badgeOnCompletion: {
        title: `${title} — completed`,
        description: `Earned by completing every activity in "${title}".`,
        icon: "🏆",
      },
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson",
      order: 0,
    });
    const activityId = await ctx.db.insert("activities", {
      lessonId,
      title: `${title} — kickoff`,
      kind: "online",
      order: 0,
      systemPrompt: "Explore the topic with the scholar.",
      ...(shape.advanceRubric
        ? { advanceRubric: { criteria: [{ id: "a", label: "A" }] } }
        : {}),
    });
    const seedId = await ctx.db.insert("seeds", {
      scholarId,
      origin: "teacher",
      status: "active",
      topic: title,
      suggestionType: "teacher_suggestion",
      rationale: "A quest your teacher set up for you.",
      scholarInvitation: "Ready to crack some codes?",
      unitId,
      teacherId,
    });
    const assignmentId = shape.assigned
      ? await ctx.db.insert("assignments", {
          teacherId,
          unitId,
          scholarIds: [scholarId],
          startedAt: Date.now(),
          activitySchedule: [
            {
              activityId,
              mode: "classFocus",
              setAt: Date.now(),
            },
          ],
        })
      : undefined;
    const sessionId = await ctx.db.insert("sessions", {
      userId: scholarId,
      unitId,
      lessonId,
      activityId,
      title: "Session",
      isArchived: false,
      assignmentId,
      ...(shape.stampSeedOnSession ? { seedId } : {}),
    });
    return { unitId, lessonId, activityId, seedId, sessionId, assignmentId };
  });
}

async function addUserMessages(t: TC, sessionId: Id<"sessions">, n: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < n; i++) {
      await ctx.db.insert("messages", {
        sessionId,
        role: "user",
        content: `scholar turn ${i}`,
        flagged: false,
      });
    }
  });
}

async function completionRows(
  t: TC,
  scholarId: Id<"users">,
  activityId: Id<"activities">,
) {
  return await t.run(async (ctx) =>
    ctx.db
      .query("activityCompletions")
      .withIndex("by_scholar_activity", (q) =>
        q.eq("scholarId", scholarId).eq("activityId", activityId),
      )
      .collect(),
  );
}

const seedStatus = (t: TC, seedId: Id<"seeds">) =>
  t.run(async (ctx) => (await ctx.db.get(seedId))?.status);

/** A valid, recent dayStart for the map receipt query. */
const DAY_START = Date.now() - 2 * 60 * 60 * 1000;

// One shared assertion: completion surfaces agree, while the map receipt remains
// reserved for durable practiceMastery transitions.
async function expectAllLedgersAgree(
  t: TC,
  {
    teacherId,
    scholarId,
    unitId,
    activityId,
    seedId,
  }: {
    teacherId: Id<"users">;
    scholarId: Id<"users">;
    unitId: Id<"units">;
    activityId: Id<"activities">;
    seedId: Id<"seeds">;
  },
) {
  const asScholar = await withUser(t, scholarId);
  const asTeacher = await withUser(t, teacherId);

  // 1. Canonical ledger: exactly one completion row.
  expect(await completionRows(t, scholarId, activityId)).toHaveLength(1);

  // 2. Home's daily receipt is not a completion ledger.
  const recap = await asScholar.query(api.dailyRecap.forScholar, {
    scholarId,
    dayStart: DAY_START,
  });
  expect(recap.finished).toEqual([]);
  expect(recap.hasAny).toBe(false);

  // 3. Seed / quest state: the offer seed is terminal (completed).
  expect(await seedStatus(t, seedId)).toBe("completed");

  // 4. Scholar home never re-suggests a finished quest.
  const suggested = await asScholar.query(api.seeds.suggestedQuestsForSelf, {});
  expect(suggested.some((q) => String(q.unitId) === String(unitId))).toBe(false);

  // 5. Teacher quest card agrees: fully done (online denominator) + badged.
  const quests = await asTeacher.query(api.units.listScholarAuthored, {});
  const row = quests.find((q) => String(q._id) === String(unitId));
  expect(row).toBeTruthy();
  expect(row!.onlineActivityCount).toBe(1);
  expect(row!.completedCount).toBe(1);
  expect(row!.completedCount).toBe(row!.onlineActivityCount);
  // A badge is earned → the canonical quest state is "finished" (the board's
  // "Badged" lane).
  expect(row!.state).toBe("finished");
}

// ── The core proof: both completion paths reconcile every ledger ──────

describe("one completion, one truth — completion surfaces agree", () => {
  test("rubric-pass completion: canonical row, quest card, and seed agree", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const q = await makeQuest(t, teacherId, scholarId, {
      advanceRubric: true,
      stampSeedOnSession: true,
    });

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId: q.sessionId,
        verdicts: [{ criterionId: "a", level: "full" as const }],
      }),
    );
    expect(res.passed).toBe(true);

    await expectAllLedgersAgree(t, {
      teacherId,
      scholarId,
      unitId: q.unitId,
      activityId: q.activityId,
      seedId: q.seedId,
    });
  });

  test("mark_activity_complete: canonical row, quest card, and seed agree", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const q = await makeQuest(t, teacherId, scholarId, {
      conversation: true,
      stampSeedOnSession: true,
    });
    await addUserMessages(t, q.sessionId, 2);

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.activityCompletions.markCompleteFromTool, {
        sessionId: q.sessionId,
        summary: "Cracked a Caesar cipher.",
      }),
    );
    expect(res).toMatchObject({ ok: true });

    await expectAllLedgersAgree(t, {
      teacherId,
      scholarId,
      unitId: q.unitId,
      activityId: q.activityId,
      seedId: q.seedId,
    });
  });

  test("assigned completion: canonical row, quest card, and seed agree", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const q = await makeQuest(t, teacherId, scholarId, {
      advanceRubric: true,
      stampSeedOnSession: true,
      assigned: true,
    });

    const res = await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId: q.sessionId,
        verdicts: [{ criterionId: "a", level: "full" as const }],
      }),
    );
    expect(res.passed).toBe(true);
    expect(await completionRows(t, scholarId, q.activityId)).toMatchObject([
      { assignmentId: q.assignmentId },
    ]);

    await expectAllLedgersAgree(t, {
      teacherId,
      scholarId,
      unitId: q.unitId,
      activityId: q.activityId,
      seedId: q.seedId,
    });
  });
});

// ── Never re-suggest a completed quest — even if the status flip lagged ──

describe("a completed quest is never re-suggested", () => {
  test("suggestedQuestsForSelf drops a completed unit even if its seed is still 'active'", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const q = await makeQuest(t, teacherId, scholarId, { advanceRubric: true });
    // NOTE: not stamped on the session, so the "started-session" drop can't
    // hide the bug — the unit-complete projection is what must catch it.

    await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId: q.sessionId,
        verdicts: [{ criterionId: "a", level: "full" as const }],
      }),
    );

    // Simulate a lagged/failed status flip: force the seed back to "active".
    await t.run(async (ctx) => {
      await ctx.db.patch(q.seedId, { status: "active", completedAt: undefined });
    });
    expect(await seedStatus(t, q.seedId)).toBe("active");

    // The unit IS complete (canonical ledger), so it must NOT be re-suggested —
    // the defensive unit-complete projection catches the drift.
    const asScholar = await withUser(t, scholarId);
    const suggested = await asScholar.query(api.seeds.suggestedQuestsForSelf, {});
    expect(suggested.some((s) => String(s.unitId) === String(q.unitId))).toBe(
      false,
    );
  });

  test("an incomplete teacher-offered quest IS still suggested (no false suppression)", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const q = await makeQuest(t, teacherId, scholarId, { advanceRubric: true });

    const asScholar = await withUser(t, scholarId);
    const suggested = await asScholar.query(api.seeds.suggestedQuestsForSelf, {});
    expect(suggested.some((s) => String(s.unitId) === String(q.unitId))).toBe(
      true,
    );
  });
});

// ── Teacher pin/hide overlays survive an unrelated completion ─────────

describe("teacher pin/hide overlays are preserved", () => {
  test("completing one quest leaves a pinned (active) and a hidden (dismissed) seed untouched", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");

    // Quest A — the one that gets completed.
    const a = await makeQuest(t, teacherId, scholarId, {
      advanceRubric: true,
      title: "Quest A",
    });
    // Quest B — teacher-PINNED (active), never started/completed.
    const b = await makeQuest(t, teacherId, scholarId, {
      advanceRubric: true,
      title: "Quest B",
    });
    // Quest C — teacher-HIDDEN (dismissed).
    const c = await makeQuest(t, teacherId, scholarId, {
      advanceRubric: true,
      title: "Quest C",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(c.seedId, {
        status: "dismissed",
        dismissedReason: "not now",
      });
    });

    // Complete Quest A.
    await t.run(async (ctx) =>
      ctx.runMutation(internal.deliverables.applyAdvanceRubricScoreFromTool, {
        sessionId: a.sessionId,
        verdicts: [{ criterionId: "a", level: "full" as const }],
      }),
    );

    // A → completed; B pin preserved; C hide preserved.
    expect(await seedStatus(t, a.seedId)).toBe("completed");
    expect(await seedStatus(t, b.seedId)).toBe("active");
    expect(await seedStatus(t, c.seedId)).toBe("dismissed");

    // Suggested list shows the pinned B, hides the dismissed C and completed A.
    const asScholar = await withUser(t, scholarId);
    const suggested = await asScholar.query(api.seeds.suggestedQuestsForSelf, {});
    const suggestedUnitIds = new Set(suggested.map((s) => String(s.unitId)));
    expect(suggestedUnitIds.has(String(b.unitId))).toBe(true);
    expect(suggestedUnitIds.has(String(c.unitId))).toBe(false);
    expect(suggestedUnitIds.has(String(a.unitId))).toBe(false);
  });
});

// ── The manual markComplete path now fast-forwards the session step counter ──

describe("manual markComplete reconciles the session card state", () => {
  test("fast-forwards processState (the step counter) like the tool/rubric paths", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher");
    const scholarId = await seedUser(t, "scholar");
    const q = await makeQuest(t, teacherId, scholarId, {
      conversation: true,
    });

    // A mid-flight process pipeline the completion should carry to its end.
    await t.run(async (ctx) => {
      const processId = await ctx.db.insert("processes", {
        teacherId,
        title: "CRAFT",
        steps: [
          { key: "A", title: "Start" },
          { key: "B", title: "End" },
        ],
        isActive: true,
      });
      await ctx.db.insert("processState", {
        sessionId: q.sessionId,
        processId,
        currentStep: "A",
        steps: [
          { key: "A", status: "in_progress" },
          { key: "B", status: "not_started" },
        ],
      });
    });

    const asScholar = await withUser(t, scholarId);
    await asScholar.mutation(api.activityCompletions.markComplete, {
      activityId: q.activityId,
      sessionId: q.sessionId,
    });

    // Session card state + the step counter both advanced.
    const session = await t.run(async (ctx) => ctx.db.get(q.sessionId));
    expect(session?.activityCompletedAt).toBeTruthy();
    const state = await t.run(async (ctx) =>
      ctx.db
        .query("processState")
        .withIndex("by_session", (q2) => q2.eq("sessionId", q.sessionId))
        .first(),
    );
    expect(state?.currentStep).toBe("B");
    expect(state?.steps.every((s) => s.status === "completed")).toBe(true);
    // And the offer seed flipped to completed via the same single cascade.
    expect(await seedStatus(t, q.seedId)).toBe("completed");
  });
});
