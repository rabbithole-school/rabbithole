// rosterPulseForScholarIds (scholars.ts) reads only the analyses inside its
// window and skips archived sessions in the index.
//
// It runs for every scholar on a roster (the school-wide "Lately" lens, Rounds,
// the Today inbox, the scholar Feed's engagement tile). It used to read every
// analysis of every session and filter by time afterwards, and a session gains
// an analysis on each observer run, so the read grew with every school day.
//
// convex-test stamps `_creationTime` with the real clock, so the seeded
// analyses can't be backdated; the window is placed after them instead (the
// same fixed past-week shape Rounds passes), which leaves all of them outside.
// `transactionLimits.documentsRead` throws once a transaction reads more than
// the limit, so seeding more analyses than the limit proves they are not read.
//
// Fictional names only.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import { rosterPulseForScholarIds } from "../scholars";
import { makeSession, makeWorld } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const READ_LIMIT = 50;
const HOUR_MS = 60 * 60 * 1000;

type T = ReturnType<typeof convexTest>;

async function seedAnalyses(t: T, sessionId: Id<"sessions">, count: number) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("analyses", {
        sessionId,
        engagementScore: 4,
        onTaskScore: 4,
        concernFlags: [],
        summary: `Observer run ${i}`,
      });
    }
  });
}

async function setup() {
  const t = convexTest({
    schema,
    modules,
    transactionLimits: { documentsRead: READ_LIMIT },
  });
  const world = await makeWorld(t, {
    schools: 1,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
    includePlatformAdmin: false,
  });
  const school = world.schools[0];
  const scholar = school.scholars[0];
  const live = await makeSession(t, scholar, {
    title: "Wave energy",
    institutionId: school.id,
  });
  const archived = await makeSession(t, scholar, {
    title: "Old kites",
    institutionId: school.id,
    isArchived: true,
  });
  return { t, scholar, live, archived };
}

describe("rosterPulseForScholarIds read bound", () => {
  test("the read limit is enforced inside t.run (control)", async () => {
    const { t, live } = await setup();
    await seedAnalyses(t, live, READ_LIMIT + 10);
    await expect(
      t.run((ctx) => ctx.db.query("analyses").collect()),
    ).rejects.toThrow(/too many documents/i);
  });

  test("analyses outside the window are not read", async () => {
    const { t, scholar, live } = await setup();
    await seedAnalyses(t, live, READ_LIMIT + 10);

    // A fixed window that starts after every seeded analysis.
    const start = Date.now() + HOUR_MS;
    const pulses = await t.run((ctx) =>
      rosterPulseForScholarIds(ctx, [scholar.id], start, start + 7 * 24 * HOUR_MS),
    );
    expect(pulses.every((p) => p.scholarId !== String(scholar.id))).toBe(true);
  });

  test("odd windows keep exactly what the old in-memory filter kept", async () => {
    const { t, scholar, live } = await setup();
    await seedAnalyses(t, live, 3);
    const later = Date.now() + HOUR_MS;
    // [since, until, does the old `!(t < since) && !(t >= until)` keep them]
    const cases: Array<[number, number, boolean]> = [
      [Number.NaN, Number.POSITIVE_INFINITY, true],
      [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, true],
      [0, Number.NaN, true],
      [0, later, true],
      [0, Number.NEGATIVE_INFINITY, false],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, false],
      [later, 0, false],
      [later, later, false],
    ];
    for (const [since, until, kept] of cases) {
      const pulses = await t.run((ctx) =>
        rosterPulseForScholarIds(ctx, [scholar.id], since, until),
      );
      const present = pulses.some((p) => p.scholarId === String(scholar.id));
      expect({ since, until, present }).toEqual({ since, until, present: kept });
    }
  });

  test("archived sessions are not read at all", async () => {
    const { t, scholar, live, archived } = await setup();
    await seedAnalyses(t, archived, 2);
    for (let i = 0; i < READ_LIMIT + 10; i++) {
      await makeSession(t, scholar, { title: `Archived ${i}`, isArchived: true });
    }
    await seedAnalyses(t, live, 3);

    const pulses = await t.run((ctx) =>
      rosterPulseForScholarIds(ctx, [scholar.id], 0),
    );
    const mine = pulses.find((p) => p.scholarId === String(scholar.id));
    expect(mine).toBeDefined();
  });
});
