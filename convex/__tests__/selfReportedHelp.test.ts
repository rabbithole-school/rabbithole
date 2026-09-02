import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isFluent, SCAFFOLDED_SOURCE } from "../lib/practice/scheduler";
import { canonicalItemIdentity, makeItemId } from "../lib/practice/session";
import { generateItem } from "../lib/practice/templates";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DOMAIN = "whole-number-arithmetic";
const SKILL = "subtract_2digit_regroup";
const ITEM_ID = makeItemId(SKILL, 12_345);

async function seedScholar(t: ReturnType<typeof convexTest>, username: string) {
  return t.run((ctx) =>
    ctx.db.insert("users", { name: username, username, role: "scholar" }),
  );
}

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

function correctAnswer() {
  const item = generateItem(SKILL, 12_345);
  if (!item || item.answer.type !== "integer") throw new Error("expected integer fixture");
  return String(item.answer.value);
}

async function masteryFor(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  const rows = await t.run(async (ctx) => ctx.db.query("practiceMastery").collect());
  return (
    rows.find((row) => row.scholarId === scholarId && row.skillKey === SKILL) ?? null
  );
}

describe("reportHelpUsed", () => {
  test("marks an admitted correct answer assisted, withdraws fluency, and serves one bare fresh item", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t, "help_happy");
    const scholar = await withUser(t, scholarId);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: SKILL,
        domain: DOMAIN,
        repetition: 2,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 1_000,
        lastAttemptAt: Date.now() - 1_000,
        frontier: false,
        source: "practice",
        updatedAt: Date.now() - 1_000,
      }),
    );

    const verdict = await scholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswer(),
    });
    expect(verdict.correct).toBe(true);
    expect(verdict.attemptId).toBeDefined();
    const before = await masteryFor(t, scholarId);
    expect(before).not.toBeNull();
    expect(isFluent(before!)).toBe(true);

    const result = await scholar.mutation(api.practiceSkills.reportHelpUsed, {
      scholarId,
      attemptId: verdict.attemptId!,
      seed: 88,
    });
    expect(result.recorded).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ skillKey: SKILL });
    expect(result.items[0]).not.toHaveProperty("workedSteps");
    // The whole point of the retry is an UNAIDED shot: a fade level or a
    // pre-shaped answer format would hand back part of the help just admitted.
    expect(result.items[0]).not.toHaveProperty("scaffoldLevel");
    expect(result.items[0]).not.toHaveProperty("answerFormat");
    expect(canonicalItemIdentity(result.items[0].itemId)).not.toBe(
      canonicalItemIdentity(ITEM_ID),
    );

    const attempt = await t.run((ctx) => ctx.db.get(verdict.attemptId!));
    expect(attempt).toMatchObject({ selfReportedHelp: true, scaffolded: true });
    const after = await masteryFor(t, scholarId);
    expect(after).not.toBeNull();
    expect(after!.source).toBe(SCAFFOLDED_SOURCE);
    expect(after!.repetition).toBe(before!.repetition);
    expect(isFluent(after!)).toBe(false);
  });

  test("is idempotent and only offers the fresh item on the first admission", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t, "help_idempotent");
    const scholar = await withUser(t, scholarId);
    const verdict = await scholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswer(),
    });

    const first = await scholar.mutation(api.practiceSkills.reportHelpUsed, {
      scholarId,
      attemptId: verdict.attemptId!,
      seed: 89,
    });
    const second = await scholar.mutation(api.practiceSkills.reportHelpUsed, {
      scholarId,
      attemptId: verdict.attemptId!,
      seed: 90,
    });
    expect(first).toMatchObject({ recorded: true });
    expect(first.items).toHaveLength(1);
    expect(second).toEqual({ recorded: true, items: [] });
  });

  test("refuses ineligible admissions without mutating attempts or mastery", async () => {
    const cases = [
      { name: "miss", fields: { correct: false } },
      { name: "retry", fields: { correct: true, retry: true } },
      { name: "dont know", fields: { correct: true, explanationReason: "dont_know" as const } },
      { name: "stale", fields: { correct: true, createdAt: Date.now() - 30 * 60 * 1000 - 1 } },
    ];

    for (const entry of cases) {
      const t = convexTest(schema, modules);
      const scholarId = await seedScholar(t, `help_refusal_${entry.name}`);
      const scholar = await withUser(t, scholarId);
      const attemptId = await t.run((ctx) =>
        ctx.db.insert("practiceAttempts", {
          scholarId,
          nodeKey: SKILL,
          itemId: ITEM_ID,
          domain: DOMAIN,
          createdAt: Date.now(),
          ...entry.fields,
        }),
      );
      const result = await scholar.mutation(api.practiceSkills.reportHelpUsed, {
        scholarId,
        attemptId,
        seed: 91,
      });
      expect(result).toEqual({ recorded: false, items: [] });
      const attempt = await t.run((ctx) => ctx.db.get(attemptId));
      expect(attempt?.selfReportedHelp).toBeUndefined();
      expect(attempt?.scaffolded).toBeUndefined();
      expect(await masteryFor(t, scholarId)).toBeNull();
    }
  });

  test("refuses a different scholar's attempt without mutating it", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "help_owner");
    const otherScholarId = await seedScholar(t, "help_other");
    const scholar = await withUser(t, scholarId);
    const attemptId = await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId: otherScholarId,
        nodeKey: SKILL,
        itemId: ITEM_ID,
        correct: true,
        domain: DOMAIN,
        createdAt: Date.now(),
      }),
    );

    expect(
      await scholar.mutation(api.practiceSkills.reportHelpUsed, {
        scholarId,
        attemptId,
        seed: 92,
      }),
    ).toEqual({ recorded: false, items: [] });
    const attempt = await t.run((ctx) => ctx.db.get(attemptId));
    expect(attempt?.selfReportedHelp).toBeUndefined();
    expect(attempt?.scaffolded).toBeUndefined();
  });

  test("still records the admission but serves nothing outside the scholar's Practice scope", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t, "help_scoped");
    const scholar = await withUser(t, scholarId);
    const verdict = await scholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswer(),
    });
    expect(verdict.attemptId).toBeDefined();

    // The plan narrows AFTER the answer was recorded — the case a stale attempt
    // creates. Owning up must not become a doorway back into a domain the
    // scholar is no longer meant to be practising.
    await t.run((ctx) =>
      ctx.db.insert("scholarMathPlans", {
        scholarId,
        practiceScope: { kind: "limited", domains: [{ domain: "fractions" }] },
        updatedBy: scholarId,
        updatedAt: Date.now(),
      }),
    );

    const result = await scholar.mutation(api.practiceSkills.reportHelpUsed, {
      scholarId,
      attemptId: verdict.attemptId!,
      seed: 93,
    });
    // The honesty record and the fluency correction are unconditional; only the
    // retry is scope-gated.
    expect(result.recorded).toBe(true);
    expect(result.items).toEqual([]);
    const attempt = await t.run((ctx) => ctx.db.get(verdict.attemptId!));
    expect(attempt).toMatchObject({ selfReportedHelp: true, scaffolded: true });
  });
});

describe("undoHelpUsed", () => {
  test("takes the admission back and restores the fluency it withdrew", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t, "undo_round_trip");
    const scholar = await withUser(t, scholarId);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: SKILL,
        domain: DOMAIN,
        repetition: 2,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 1_000,
        lastAttemptAt: Date.now() - 1_000,
        frontier: false,
        source: "practice",
        updatedAt: Date.now() - 1_000,
      }),
    );
    const verdict = await scholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswer(),
    });
    await scholar.mutation(api.practiceSkills.reportHelpUsed, {
      scholarId,
      attemptId: verdict.attemptId!,
      seed: 94,
    });
    expect((await masteryFor(t, scholarId))!.source).toBe(SCAFFOLDED_SOURCE);

    const undone = await scholar.mutation(api.practiceSkills.undoHelpUsed, {
      scholarId,
      attemptId: verdict.attemptId!,
    });
    expect(undone).toEqual({ undone: true });

    const attempt = await t.run((ctx) => ctx.db.get(verdict.attemptId!));
    expect(attempt?.selfReportedHelp).toBeUndefined();
    // The admission set `scaffolded` itself, so taking it back removes it.
    expect(attempt?.scaffolded).toBeUndefined();
    expect(attempt?.helpAdmissionUndo).toBeUndefined();
    const restored = await masteryFor(t, scholarId);
    expect(restored!.source).toBe("practice");
    expect(isFluent(restored!)).toBe(true);

    // A second undo has nothing left to reverse.
    expect(
      await scholar.mutation(api.practiceSkills.undoHelpUsed, {
        scholarId,
        attemptId: verdict.attemptId!,
      }),
    ).toEqual({ undone: false });
  });

  test("keeps a scaffold the SERVER detected, which was never the scholar's to take back", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t, "undo_server_scaffold");
    const scholar = await withUser(t, scholarId);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: SKILL,
        domain: DOMAIN,
        repetition: 2,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 1_000,
        lastAttemptAt: Date.now() - 1_000,
        frontier: false,
        source: "practice",
        updatedAt: Date.now() - 1_000,
      }),
    );
    const attemptId = await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SKILL,
        itemId: ITEM_ID,
        correct: true,
        // The server rendered worked steps with this item.
        scaffolded: true,
        domain: DOMAIN,
        createdAt: Date.now(),
      }),
    );
    await scholar.mutation(api.practiceSkills.reportHelpUsed, {
      scholarId,
      attemptId,
      seed: 95,
    });
    expect(
      await scholar.mutation(api.practiceSkills.undoHelpUsed, { scholarId, attemptId }),
    ).toEqual({ undone: true });

    const attempt = await t.run((ctx) => ctx.db.get(attemptId));
    expect(attempt?.selfReportedHelp).toBeUndefined();
    expect(attempt?.scaffolded).toBe(true);
    // The mastery demotion WAS this admission's doing, so that part rewinds.
    expect((await masteryFor(t, scholarId))!.source).toBe("practice");
  });

  test("leaves a mastery row that something else has since claimed", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await seedScholar(t, "undo_moved_on");
    const scholar = await withUser(t, scholarId);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: SKILL,
        domain: DOMAIN,
        repetition: 2,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 1_000,
        lastAttemptAt: Date.now() - 1_000,
        frontier: false,
        source: "practice",
        updatedAt: Date.now() - 1_000,
      }),
    );
    const verdict = await scholar.mutation(api.practiceSkills.submitAnswer, {
      scholarId,
      itemId: ITEM_ID,
      answer: correctAnswer(),
    });
    await scholar.mutation(api.practiceSkills.reportHelpUsed, {
      scholarId,
      attemptId: verdict.attemptId!,
      seed: 96,
    });
    // Stand in for the bare retry landing correctly before the un-press.
    const row = await masteryFor(t, scholarId);
    await t.run((ctx) => ctx.db.patch(row!._id, { source: "placement" }));

    expect(
      await scholar.mutation(api.practiceSkills.undoHelpUsed, {
        scholarId,
        attemptId: verdict.attemptId!,
      }),
    ).toEqual({ undone: true });
    expect((await masteryFor(t, scholarId))!.source).toBe("placement");
  });

  test("clears the flag only for an admission recorded before the undo record existed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "undo_legacy");
    const scholar = await withUser(t, scholarId);
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: SKILL,
        domain: DOMAIN,
        repetition: 2,
        halfLifeDays: 4,
        lastPracticedAt: Date.now() - 1_000,
        lastAttemptAt: Date.now() - 1_000,
        frontier: false,
        source: SCAFFOLDED_SOURCE,
        updatedAt: Date.now() - 1_000,
      }),
    );
    const attemptId = await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        scholarId,
        nodeKey: SKILL,
        itemId: ITEM_ID,
        correct: true,
        selfReportedHelp: true,
        scaffolded: true,
        domain: DOMAIN,
        createdAt: Date.now(),
      }),
    );

    expect(
      await scholar.mutation(api.practiceSkills.undoHelpUsed, { scholarId, attemptId }),
    ).toEqual({ undone: true });
    const attempt = await t.run((ctx) => ctx.db.get(attemptId));
    expect(attempt?.selfReportedHelp).toBeUndefined();
    // Nothing recorded what this admission changed, so nothing is guessed back:
    // "not yet fluent" is the safe direction to be wrong in.
    expect(attempt?.scaffolded).toBe(true);
    expect((await masteryFor(t, scholarId))!.source).toBe(SCAFFOLDED_SOURCE);
  });

  test("refuses an un-admitted, stale, or foreign attempt", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t, "undo_refusals");
    const otherScholarId = await seedScholar(t, "undo_refusals_other");
    const scholar = await withUser(t, scholarId);
    const base = {
      nodeKey: SKILL,
      itemId: ITEM_ID,
      correct: true,
      domain: DOMAIN,
    } as const;

    const neverAdmitted = await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", { ...base, scholarId, createdAt: Date.now() }),
    );
    const stale = await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        ...base,
        scholarId,
        selfReportedHelp: true,
        scaffolded: true,
        createdAt: Date.now() - 30 * 60 * 1000 - 1,
      }),
    );
    const foreign = await t.run((ctx) =>
      ctx.db.insert("practiceAttempts", {
        ...base,
        scholarId: otherScholarId,
        selfReportedHelp: true,
        scaffolded: true,
        createdAt: Date.now(),
      }),
    );

    for (const attemptId of [neverAdmitted, stale, foreign]) {
      expect(
        await scholar.mutation(api.practiceSkills.undoHelpUsed, { scholarId, attemptId }),
      ).toEqual({ undone: false });
    }
    // The two real admissions are untouched by the refusal.
    for (const attemptId of [stale, foreign]) {
      const attempt = await t.run((ctx) => ctx.db.get(attemptId));
      expect(attempt?.selfReportedHelp).toBe(true);
      expect(attempt?.scaffolded).toBe(true);
    }
  });
});
