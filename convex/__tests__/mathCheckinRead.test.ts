// The TRANSCRIPT half of the check-in reader: every answered probe in order,
// each with its question reconstructed where it still can be.
//
// The load-bearing assertions here are (a) the per-domain status words come out
// of the canonical domain-map derivation, not a local re-read of
// `practicePlacements.status`, and (b) a question that can no longer be rebuilt
// reports itself unavailable rather than being fabricated.

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { makeItemId } from "../lib/practice/session";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("getScholarMathCheckIn", () => {
  test("reports the map, probe chronology, reconstructed template questions, and the held probe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00Z").getTime());
    try {
      const t = convexTest(schema, modules);
      await t.mutation(internal.practiceSkills.seedGraph, {});
      const scholar = await t.run((ctx) =>
        ctx.db.insert("users", {
          name: "Test Scholar",
          username: "checkin-reader",
          role: "scholar",
        }),
      );
      const first = makeItemId("count_to_10", 7);
      const held = makeItemId("count_to_10", 9);
      await t.run(async (ctx) => {
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain: "whole-number-arithmetic",
          status: "complete",
          probesAnswered: 1,
          probeLog: [
            {
              nodeKey: "count_to_10",
              strand: "count",
              outcome: "correct",
              at: Date.now() - 100,
              answerRaw: "10",
              itemId: first,
            },
          ],
          frontierByStrand: [{ strand: "count", frontierKey: "add_within_5" }],
          updatedAt: Date.now() - 100,
        });
        await ctx.db.insert("practicePlacements", {
          scholarId: scholar,
          domain: "fraction-arithmetic",
          status: "in_progress",
          probesAnswered: 1,
          probeLog: [
            {
              nodeKey: "unit_fraction",
              strand: "concept",
              outcome: "unknown",
              at: Date.now(),
              itemId: makeItemId("unit_fraction", 11),
            },
          ],
          servedProbe: {
            nodeKey: "count_to_10",
            strand: "count",
            itemId: held,
            seed: 9,
          },
          updatedAt: Date.now(),
        });
      });

      const result = await t.run((ctx) =>
        ctx.runQuery(internal.curriculumAssistant.getScholarMathCheckIn, {
          scholarId: scholar,
        }),
      );

      // One domain converged, another still open ⇒ the map isn't finished, so
      // the headline is "in progress" — projected from the canonical statuses.
      expect(result.mapProgress).toBe("partial");
      expect(result.map.allMapped).toBe(false);
      expect(result.map.mappedCount).toBeGreaterThanOrEqual(1);
      expect(result.map.eligibleCount).toBeGreaterThanOrEqual(
        result.map.mappedCount,
      );

      // The per-domain word is the canonical one, not "complete"/"in_progress".
      const byDomain = Object.fromEntries(
        result.domains.map((d) => [d.domain, d.status]),
      );
      expect(byDomain["whole-number-arithmetic"]).toBe("converged");
      expect(byDomain["fraction-arithmetic"]).toBe("in_flight");

      expect(result.totals).toMatchObject({
        probesAnswered: 2,
        domainsStarted: 2,
      });
      expect(result.probes.map((probe) => probe.itemId)).toEqual([
        first,
        makeItemId("unit_fraction", 11),
      ]);
      expect(result.probes[0]).toMatchObject({
        question: "regenerated",
        stem: expect.any(String),
        submittedAnswer: "10",
        outcome: "correct",
        correct: true,
      });
      expect(result.probes[1]).toMatchObject({
        outcome: "unknown",
        correct: false,
      });
      expect(result.currentProbe).toMatchObject({
        itemId: held,
        question: "regenerated",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("reports no placement rows as not started, and never fabricates an unknown item", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Test Scholar",
        username: "checkin-empty",
        role: "scholar",
      }),
    );
    const generatedItem = await t.run((ctx) =>
      ctx.db.insert("practiceItems", {
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        stem: "How many dots are shown?",
        answerType: "integer",
        answerCanonical: "5",
        source: "generated",
        verifiedAt: Date.now(),
      }),
    );

    const empty = await t.run((ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getScholarMathCheckIn, {
        scholarId: scholar,
      }),
    );
    expect(empty).toMatchObject({
      mapProgress: "unmapped",
      totals: { probesAnswered: 0, domainsStarted: 0 },
    });
    expect(empty.map.mappedCount).toBe(0);

    await t.run((ctx) =>
      ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        status: "complete",
        probesAnswered: 2,
        probeLog: [
          {
            nodeKey: "count_to_10",
            strand: "count",
            outcome: "correct",
            at: Date.now() - 1,
            itemId: `gen#${generatedItem}`,
          },
          {
            nodeKey: "count_to_10",
            strand: "count",
            outcome: "incorrect",
            at: Date.now(),
            itemId: "legacy-item",
          },
        ],
        updatedAt: Date.now(),
      }),
    );

    const legacy = await t.run((ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getScholarMathCheckIn, {
        scholarId: scholar,
      }),
    );
    // A stored `gen#` item still resolves to its real stem…
    expect(legacy.probes[0]).toMatchObject({
      question: "available",
      stem: "How many dots are shown?",
      correct: true,
    });
    // …and an id nothing can rebuild admits the gap instead of inventing one.
    expect(legacy.probes[1]).toMatchObject({
      question: "unavailable",
      stem: null,
      correct: false,
    });
  });

  test("a scholar with mastery but no converged run reads as shadow placed, not mapped", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Shadow Scholar",
        username: "checkin-shadow",
        role: "scholar",
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("practiceMastery", {
        scholarId: scholar,
        skillKey: "count_to_10",
        domain: "whole-number-arithmetic",
        repetition: 2,
        halfLifeDays: 4,
        lastPracticedAt: Date.now(),
        frontier: false,
        source: "practice",
        updatedAt: Date.now(),
      }),
    );

    const result = await t.run((ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getScholarMathCheckIn, {
        scholarId: scholar,
      }),
    );
    // Mastery alone is NOT a drawn map — this is the exact hole
    // domainMapStatus closed, and the reader inherits the ruling for free.
    expect(result.mapProgress).toBe("unmapped");
    expect(result.map.mappedCount).toBe(0);
  });

  test("a stale held probe on a CONVERGED domain is ignored — only a servable domain holds the live probe", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Interrupted Scholar",
        username: "checkin-held",
        role: "scholar",
      }),
    );
    const stale = makeItemId("count_to_10", 4);
    const live = makeItemId("unit_fraction", 3);
    await t.run(async (ctx) => {
      // CONVERGED, but an abandoned single-domain placement left a probe on it.
      // It sorts FIRST in PRACTICE_DOMAINS and has the freshest `updatedAt`, so
      // any registry-order-only or recency-only pick would report it — and the
      // scholar's app never will, because the engine refuses to re-serve a
      // mapped domain.
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: "whole-number-arithmetic",
        status: "complete",
        probesAnswered: 1,
        probeLog: [
          {
            nodeKey: "count_to_10",
            strand: "count",
            outcome: "correct",
            at: Date.now() - 5_000,
            itemId: makeItemId("count_to_10", 2),
          },
        ],
        servedProbe: {
          nodeKey: "count_to_10",
          strand: "count",
          itemId: stale,
          seed: 4,
        },
        updatedAt: Date.now(),
      });
      // Still in flight (an answered probe outranks the grade gate), so this is
      // the one domain that may actually serve.
      await ctx.db.insert("practicePlacements", {
        scholarId: scholar,
        domain: "fraction-arithmetic",
        status: "in_progress",
        probesAnswered: 1,
        probeLog: [
          {
            nodeKey: "unit_fraction",
            strand: "concept",
            outcome: "incorrect",
            at: Date.now() - 1_000,
            itemId: makeItemId("unit_fraction", 5),
          },
        ],
        servedProbe: {
          nodeKey: "unit_fraction",
          strand: "concept",
          itemId: live,
          seed: 3,
        },
        updatedAt: Date.now() - 60_000,
      });
    });

    const result = await t.run((ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getScholarMathCheckIn, {
        scholarId: scholar,
      }),
    );
    expect(result.currentProbe).toMatchObject({
      domain: "fraction-arithmetic",
      itemId: live,
    });
    // The stale row is not hidden — it is just not called "current".
    const wna = result.domains.find(
      (d) => d.domain === "whole-number-arithmetic",
    )!;
    expect(wna.status).toBe("converged");
    expect(wna.hasCurrentProbe).toBe(true);
  });

  test("refuses a non-scholar id", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const teacher = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Teacher",
        username: "checkin-teacher",
        role: "teacher",
      }),
    );
    await expect(
      t.run((ctx) =>
        ctx.runQuery(internal.curriculumAssistant.getScholarMathCheckIn, {
          scholarId: teacher,
        }),
      ),
    ).rejects.toThrow(/Scholar not found/);
  });
});
