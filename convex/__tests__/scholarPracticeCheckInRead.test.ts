// The GLANCE half of the check-in reader — the day-scoped summary that rides
// along with practice detail.
//
// The point of the day axis: a check-in in flight writes ONLY placement rows,
// so an aide reading mastery sees nothing and reports "no math activity". The
// point of scoping it to probes ANSWERED today (never `updatedAt`): the loop
// and the capping sweep both bump `updatedAt` with no scholar action behind it.

import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("scholar practice check-in glance", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("practice detail exposes today's live placement before any mastery exists", async () => {
    // Pin the clock: `now - 1_000` against a live clock lands on the PREVIOUS
    // institution day if the run happens to start in the first second after
    // midnight in Pacific/Honolulu, and the day-scoped counts below would flake.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00Z").getTime());
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const now = Date.now();
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Test school",
        slug: "test-school",
        kind: "school",
        timeZone: "Pacific/Honolulu",
      }),
    );
    const scholarId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Test Scholar",
        username: "test-scholar",
        role: "scholar",
        institutionId,
      }),
    );
    await t.run(async (ctx) => {
      await ctx.db.insert("practicePlacements", {
        scholarId,
        domain: "whole-number-arithmetic",
        status: "in_progress",
        probesAnswered: 2,
        probeLog: [
          {
            nodeKey: "count_to_10",
            strand: "count",
            outcome: "correct",
            at: now - 1_000,
          },
          {
            nodeKey: "add_within_5",
            strand: "count",
            outcome: "unknown",
            at: now,
          },
        ],
        updatedAt: now,
      });
      await ctx.db.insert("practicePlacements", {
        scholarId,
        domain: "fraction-arithmetic",
        status: "in_progress",
        probesAnswered: 1,
        probeLog: [
          {
            nodeKey: "unit_fraction",
            strand: "concept",
            outcome: "correct",
            at: now - 8 * 86_400_000,
          },
        ],
        // Clearing a stale served probe while ANOTHER domain advances rewrites
        // this row today. That is not check-in activity in this domain, and the
        // glance must not report it as such.
        updatedAt: now,
      });
    });

    const practice = await t.run((ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getScholarPractice, {
        scholarId,
      }),
    );

    expect(practice.checkIn).toMatchObject({
      mapProgress: "partial",
      probesAnsweredToday: 2,
      responsesToday: { correct: 1, incorrect: 0, unknown: 1 },
    });
    // Only the domain actually answered in today shows up — the row touched by
    // a sweep does not.
    expect(practice.checkIn?.domainsToday.map((d) => d.domain)).toEqual([
      "whole-number-arithmetic",
    ]);
    // …and its status word is the canonical one.
    expect(practice.checkIn?.domainsToday[0].status).toBe("in_flight");
    // The glance is live even though the mastery table is empty — the whole
    // reason this read exists.
    expect(practice.counts.totalPracticedSkills).toBe(0);

    // TWO CLOCKS, pinned. `mapProgress` and `heldProbeDomain` are LIFETIME
    // facts: the fraction-arithmetic run has been silent for eight days and
    // still counts toward the map. Only the day-scoped counts above may be
    // read as "is she working right now".
    expect(practice.checkIn?.mapProgress).toBe("partial");
    expect(practice.checkIn?.heldProbeDomain).toBeNull();
    expect(
      practice.checkIn?.domainsToday.some(
        (d) => d.domain === "fraction-arithmetic",
      ),
    ).toBe(false);
  });

  test("a scholar with no placement rows reads as not started with an empty day", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.practiceSkills.seedGraph, {});
    const scholarId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Quiet Scholar",
        username: "quiet-scholar",
        role: "scholar",
      }),
    );
    const practice = await t.run((ctx) =>
      ctx.runQuery(internal.curriculumAssistant.getScholarPractice, {
        scholarId,
      }),
    );
    expect(practice.checkIn).toMatchObject({
      mapProgress: "unmapped",
      probesAnsweredToday: 0,
      domainsToday: [],
      heldProbeDomain: null,
      lastProbeAt: null,
    });
  });
});
