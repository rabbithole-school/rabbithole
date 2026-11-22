// `recentlyCrossed` in readScholarPractice (TRA-618): a skill is a recent
// fluency crossing when it is green NOW and its `becameFluentAt` stamp falls in
// the last 14 days. `updatedAt` moves on every practice touch, so reading it as
// the crossing time turned spaced reviews of long-held skills into "just hit
// fluency" claims for parents.

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 86_400_000;
const NOW = new Date("2026-11-09T20:00:00Z").getTime();

type MasteryFixture = {
  skillKey: string;
  domain: string;
  updatedAt: number;
  becameFluentAt?: number;
  halfLifeDays?: number;
  lastPracticedAt?: number;
};

/** One fictional scholar plus a mastery row (and its node) per fixture, inserted
 *  in order. Defaults make each row demonstrated-fluent and NOT due, so it is
 *  green under the composite gate unless a fixture overrides retention. */
async function seedScholarWithMastery(
  t: ReturnType<typeof convexTest>,
  rows: MasteryFixture[],
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const scholarId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: "test-scholar",
      role: "scholar",
    });
    for (const row of rows) {
      await ctx.db.insert("knowledgeNodes", {
        nodeKey: row.skillKey,
        label: row.skillKey.replaceAll("_", " "),
        domain: row.domain,
      });
      await ctx.db.insert("practiceMastery", {
        scholarId,
        skillKey: row.skillKey,
        domain: row.domain,
        repetition: 3,
        halfLifeDays: row.halfLifeDays ?? 365,
        lastPracticedAt: row.lastPracticedAt ?? NOW - 60 * 60 * 1000,
        frontier: false,
        source: "practice",
        updatedAt: row.updatedAt,
        ...(row.becameFluentAt !== undefined
          ? { becameFluentAt: row.becameFluentAt }
          : {}),
      });
    }
    return scholarId;
  });
}

async function readPractice(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
) {
  return await t.query(internal.curriculumAssistant.getScholarPractice, {
    scholarId,
  });
}

describe("readScholarPractice recentlyCrossed", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("a review this morning of a skill fluent for months is NOT a recent crossing", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholarWithMastery(t, [
      {
        skillKey: "subtract_two_digit",
        domain: "alpha-test",
        becameFluentAt: NOW - 100 * DAY,
        updatedAt: NOW - 2 * 60 * 60 * 1000,
      },
    ]);

    const practice = await readPractice(t, scholarId);

    expect(practice.recentlyCrossed).toEqual([]);
    expect(practice.counts.recentlyCrossedCount).toBe(0);
    // Still green: it shows up in the strand's fluent tally, just not as new.
    expect(practice.strandPlacement[0]?.fluentCount).toBe(1);
  });

  test("a fresh becameFluentAt is listed, stamped with that crossing time", async () => {
    const t = convexTest(schema, modules);
    const becameFluentAt = NOW - 3 * DAY;
    const scholarId = await seedScholarWithMastery(t, [
      {
        skillKey: "add_within_20",
        domain: "alpha-test",
        becameFluentAt,
        // Practiced again since crossing: crossedAt must not follow updatedAt.
        updatedAt: NOW - 60 * 60 * 1000,
      },
    ]);

    const practice = await readPractice(t, scholarId);

    expect(practice.recentlyCrossed).toEqual([
      {
        nodeKey: "add_within_20",
        label: "add within 20",
        domain: "alpha-test",
        crossedAt: becameFluentAt,
      },
    ]);
    expect(practice.counts.recentlyCrossedCount).toBe(1);
  });

  test("a fluent row with no becameFluentAt stamp is not listed (crossing date unknown)", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholarWithMastery(t, [
      {
        skillKey: "count_to_100",
        domain: "alpha-test",
        updatedAt: NOW - 60 * 60 * 1000,
      },
    ]);

    const practice = await readPractice(t, scholarId);

    expect(practice.recentlyCrossed).toEqual([]);
    expect(practice.counts.recentlyCrossedCount).toBe(0);
  });

  test("a recent crossing that is no longer green (due for review) is not listed", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholarWithMastery(t, [
      {
        skillKey: "skip_count_by_5",
        domain: "alpha-test",
        becameFluentAt: NOW - 5 * DAY,
        updatedAt: NOW - 5 * DAY,
        // Short half-life, last ticked 5 days ago: retention is far below the
        // due threshold, so the composite isFluent gate says "not green now".
        halfLifeDays: 0.5,
        lastPracticedAt: NOW - 5 * DAY,
      },
    ]);

    const practice = await readPractice(t, scholarId);

    expect(practice.recentlyCrossed).toEqual([]);
  });

  test("lists newest crossing first, across domains, regardless of updatedAt", async () => {
    const t = convexTest(schema, modules);
    // Inserted older-crossing first and in a separate domain, so the per-domain
    // loop alone would emit it first. Its updatedAt is also the freshest, so an
    // updatedAt sort would put it first too.
    const scholarId = await seedScholarWithMastery(t, [
      {
        skillKey: "older_crossing",
        domain: "alpha-test",
        becameFluentAt: NOW - 10 * DAY,
        updatedAt: NOW - 60 * 1000,
      },
      {
        skillKey: "newest_crossing",
        domain: "beta-test",
        becameFluentAt: NOW - 1 * DAY,
        updatedAt: NOW - 1 * DAY,
      },
      {
        skillKey: "middle_crossing",
        domain: "alpha-test",
        becameFluentAt: NOW - 6 * DAY,
        updatedAt: NOW - 6 * DAY,
      },
      // Outside the 14-day window: excluded, so it can't affect the order.
      {
        skillKey: "outside_window",
        domain: "beta-test",
        becameFluentAt: NOW - 15 * DAY,
        updatedAt: NOW - 60 * 1000,
      },
    ]);

    const practice = await readPractice(t, scholarId);

    expect(practice.recentlyCrossed.map((c) => c.nodeKey)).toEqual([
      "newest_crossing",
      "middle_crossing",
      "older_crossing",
    ]);
    expect(practice.recentlyCrossed.map((c) => c.crossedAt)).toEqual([
      NOW - 1 * DAY,
      NOW - 6 * DAY,
      NOW - 10 * DAY,
    ]);
    expect(practice.counts.recentlyCrossedCount).toBe(3);
  });
});
