import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { selSynthesisCandidatesAt } from "../selSynthesisCron";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// A Thursday, 09:00 HST (= 19:00 UTC) — inside the 6am–12pm batch window, one
// SEL meeting day. HST is UTC−10 with no DST.
const THURSDAY_MORNING = Date.parse("2026-08-27T19:00:00.000Z");

function school(over: Record<string, unknown>) {
  return {
    _id: "inst" as Id<"institutions">,
    kind: "school" as const,
    timeZone: "Pacific/Honolulu",
    ...over,
  } as Parameters<typeof selSynthesisCandidatesAt>[0][number];
}

const SEL_THU = { kind: "sel" as const, weekday: 4, minutes: 15 * 60 };
const ACADEMIC_TUE = { kind: "academic" as const, weekday: 2, minutes: 15 * 60 };

describe("selSynthesisCandidatesAt", () => {
  test("names the closing week and its window for a configured SEL morning", () => {
    const due = selSynthesisCandidatesAt(
      [school({ roundsCadences: [ACADEMIC_TUE, SEL_THU] })],
      THURSDAY_MORNING,
    );
    expect(due).toHaveLength(1);
    // In the meeting-day morning (before the 15:00 anchor) the current SEL week
    // is the one CLOSING at today's meeting — keyed to last Thursday.
    expect(due[0].weekKey).toBe("2026-08-20");
    expect(due[0].window.startMs).toBeLessThan(due[0].window.endMs);
    // The window ends at THIS Thursday's anchor (the meeting), a week long.
    expect(due[0].window.endMs - due[0].window.startMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test("is multi-tenant — every school with an explicit SEL cadence, no primary gate", () => {
    const a = school({ _id: "a" as Id<"institutions">, roundsCadences: [ACADEMIC_TUE, SEL_THU] });
    const b = school({ _id: "b" as Id<"institutions">, roundsCadences: [ACADEMIC_TUE, SEL_THU] });
    const due = selSynthesisCandidatesAt([a, b], THURSDAY_MORNING);
    expect(due.map((d) => String(d.institutionId)).sort()).toEqual(["a", "b"]);
  });

  test("skips a school with no explicit SEL cadence", () => {
    expect(
      selSynthesisCandidatesAt(
        [school({ roundsCadences: [ACADEMIC_TUE] })],
        THURSDAY_MORNING,
      ),
    ).toEqual([]);
    // A bare legacy academic anchor is not an SEL cadence either.
    expect(
      selSynthesisCandidatesAt(
        [school({ roundsAnchorWeekday: 2, roundsAnchorMinutes: 900 })],
        THURSDAY_MORNING,
      ),
    ).toEqual([]);
  });

  test("skips outside the local morning window, and on the wrong weekday", () => {
    // 14:00 HST Thursday = 00:00 UTC Friday — past the noon cutoff.
    const afternoon = Date.parse("2026-08-28T00:00:00.000Z");
    expect(
      selSynthesisCandidatesAt([school({ roundsCadences: [SEL_THU] })], afternoon),
    ).toEqual([]);
    // A Wednesday morning is not the SEL meeting day.
    const wednesday = Date.parse("2026-08-26T19:00:00.000Z");
    expect(
      selSynthesisCandidatesAt([school({ roundsCadences: [SEL_THU] })], wednesday),
    ).toEqual([]);
  });

  test("skips suspended schools and guest institutions", () => {
    expect(
      selSynthesisCandidatesAt(
        [school({ roundsCadences: [SEL_THU], disabledAt: 1 })],
        THURSDAY_MORNING,
      ),
    ).toEqual([]);
    expect(
      selSynthesisCandidatesAt(
        [school({ kind: "guest", roundsCadences: [SEL_THU] })],
        THURSDAY_MORNING,
      ),
    ).toEqual([]);
  });
});

describe("SEL synthesis run dedupe", () => {
  test("claims a (institution, week) once, and re-claims a different week", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", { slug: "moli", kind: "school", name: "Moli" }),
    );

    const first = await t.mutation(internal.selSynthesisCron.claimRun, {
      institutionId,
      weekKey: "2026-08-20",
    });
    expect(first).toBe(true);

    // A second claim before completion is refused (the lease holds).
    const again = await t.mutation(internal.selSynthesisCron.claimRun, {
      institutionId,
      weekKey: "2026-08-20",
    });
    expect(again).toBe(false);

    // A clean run completes.
    const settled = await t.mutation(internal.selSynthesisCron.settleRun, {
      institutionId,
      weekKey: "2026-08-20",
      failedCount: 0,
    });
    expect(settled).toEqual({ retrying: false });

    // Still refused after completion — never regenerates the same week.
    const afterDone = await t.mutation(internal.selSynthesisCron.claimRun, {
      institutionId,
      weekKey: "2026-08-20",
    });
    expect(afterDone).toBe(false);

    // A different week is a fresh claim.
    const nextWeek = await t.mutation(internal.selSynthesisCron.claimRun, {
      institutionId,
      weekKey: "2026-08-27",
    });
    expect(nextWeek).toBe(true);
  });

  test("a partial failure leaves the run claimable so the next tick retries", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", { slug: "moli", kind: "school", name: "Moli" }),
    );

    // Attempt 1 claims, then settles with failures — not complete, retryable.
    expect(
      await t.mutation(internal.selSynthesisCron.claimRun, {
        institutionId,
        weekKey: "2026-08-20",
      }),
    ).toBe(true);
    const firstSettle = await t.mutation(internal.selSynthesisCron.settleRun, {
      institutionId,
      weekKey: "2026-08-20",
      failedCount: 3,
    });
    expect(firstSettle).toEqual({ retrying: true });

    const row = await t.run((ctx) =>
      ctx.db
        .query("selSynthesisRuns")
        .withIndex("by_institution_week", (q) =>
          q.eq("institutionId", institutionId).eq("weekKey", "2026-08-20"),
        )
        .unique(),
    );
    expect(row?.completedAt).toBeUndefined();
    expect(row?.lastFailedCount).toBe(3);
    expect(row?.attemptCount).toBe(1);

    // The very next tick re-claims (the lease was rewound), a second attempt.
    const retryClaim = await t.mutation(internal.selSynthesisCron.claimRun, {
      institutionId,
      weekKey: "2026-08-20",
    });
    expect(retryClaim).toBe(true);
    const afterRetryClaim = await t.run((ctx) =>
      ctx.db
        .query("selSynthesisRuns")
        .withIndex("by_institution_week", (q) =>
          q.eq("institutionId", institutionId).eq("weekKey", "2026-08-20"),
        )
        .unique(),
    );
    expect(afterRetryClaim?.attemptCount).toBe(2);
  });

  test("stops retrying after three failed attempts, completing with the failure count", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", { slug: "moli", kind: "school", name: "Moli" }),
    );

    // Three claim → fail cycles. The first two stay retryable; the third caps out.
    for (const attempt of [1, 2, 3]) {
      expect(
        await t.mutation(internal.selSynthesisCron.claimRun, {
          institutionId,
          weekKey: "2026-08-20",
        }),
      ).toBe(true);
      const settled = await t.mutation(internal.selSynthesisCron.settleRun, {
        institutionId,
        weekKey: "2026-08-20",
        failedCount: 2,
      });
      expect(settled).toEqual({ retrying: attempt < 3 });
    }

    // Capped out: completed with the failure tally recorded, and never re-claimed.
    const row = await t.run((ctx) =>
      ctx.db
        .query("selSynthesisRuns")
        .withIndex("by_institution_week", (q) =>
          q.eq("institutionId", institutionId).eq("weekKey", "2026-08-20"),
        )
        .unique(),
    );
    expect(row?.completedAt).toBeDefined();
    expect(row?.lastFailedCount).toBe(2);
    expect(row?.attemptCount).toBe(3);
    expect(
      await t.mutation(internal.selSynthesisCron.claimRun, {
        institutionId,
        weekKey: "2026-08-20",
      }),
    ).toBe(false);
  });
});
