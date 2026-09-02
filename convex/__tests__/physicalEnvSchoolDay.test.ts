import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { localWeekdayAndTime } from "../lib/metaBlocks";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: the tutor's physical inventory (rooms + gear) is soft-gated to
// the scholar's SCHOOL DAY — off-hours, `getSessionContext` skips the equipment
// read so the PHYSICAL ENVIRONMENT section and the suggest_physical_task tool are
// not offered. Each positive all-day case stabilizes `Date.now()` and the
// fixture timezone together: with an all-days block the gear IS present; with
// the block removed / never-matching / the period not active, the gear is
// ABSENT. Same fixtures, minus the schedule.
// A test-drive session bypasses the gate entirely.

// HST = UTC-10 year-round; the institution timezone drives the "today" the
// predicate evaluates in.
const HONOLULU_TZ = "Pacific/Honolulu";

/**
 * The all-day fixture is half-open at 23:59, its latest valid end time. Keep
 * the real school timezone except for that excluded minute.
 */
function allDayFixtureTimeZone(nowMs = Date.now()): string {
  return localWeekdayAndTime(nowMs, HONOLULU_TZ).hhmm === "23:59"
    ? "Pacific/Pago_Pago"
    : HONOLULU_TZ;
}

/** Build the shared fixtures: institution, scholar, space, one suggestable+active
 * item of gear, and a reporting period. Returns the ids so each scenario can add
 * (or omit) a scheduleBlock and a session. */
async function seedWorld(
  t: ReturnType<typeof convexTest>,
  periodStatus: "open" | "closed" = "open",
) {
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli",
      slug: "moli",
      kind: "school" as const,
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Kai",
      username: "kai",
      role: "scholar" as const,
      institutionId,
    });
    const spaceId = await ctx.db.insert("spaces", {
      institutionId,
      name: "Music Room",
      kind: "music" as const,
      isActive: true,
    });
    await ctx.db.insert("equipment", {
      institutionId,
      spaceId,
      name: "Hand bells",
      tutorSuggestable: true,
      supervision: "none" as const,
      isActive: true,
    });
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Term",
      startsAt: 0,
      endsAt: Number.MAX_SAFE_INTEGER,
      status: periodStatus,
      institutionId,
    });
    return { institutionId, scholarId, spaceId, periodId };
  });
}

/** An all-days bell block (every ISO weekday, [00:00, 23:59)). Positive cases
 * stabilize the instant so it is never evaluated at this half-open end minute. */
async function seedAllDayBlock(
  t: ReturnType<typeof convexTest>,
  periodId: Id<"reportingPeriods">,
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "allday",
      label: "All Day",
      startLocal: "00:00",
      endLocal: "23:59",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      order: 0,
    });
  });
}

async function seedSession(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
  opts: { isTestDrive?: boolean } = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("sessions", {
      userId: scholarId,
      title: "Exploring sound",
      isArchived: false,
      ...(opts.isTestDrive ? { isTestDrive: true } : {}),
    }),
  );
}

async function withAllDayFixtureClock<T>(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  query: () => Promise<T>,
): Promise<T> {
  const nowMs = Date.now();
  await t.run(async (ctx) => {
    await ctx.db.patch(institutionId, {
      timeZone: allDayFixtureTimeZone(nowMs),
    });
  });
  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    return await query();
  } finally {
    nowSpy.mockRestore();
  }
}

describe("physical environment — gated to the school day", () => {
  test("present: an active period + an all-day schedule block → gear IS offered", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, scholarId, periodId } = await seedWorld(t);
    await seedAllDayBlock(t, periodId);
    const sessionId = await seedSession(t, scholarId);

    const ctxOut = await withAllDayFixtureClock(t, institutionId, () =>
      t.query(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    const gear = ctxOut?.physicalEnvironmentContext?.equipment ?? [];
    expect(gear.map((e) => e.name)).toEqual(["Hand bells"]);
    expect(
      ctxOut?.physicalEnvironmentContext?.spaces.map((s) => s.name),
    ).toEqual(["Music Room"]);
  });

  test("absent: no schedule block for the period → gear is NOT offered (fail closed)", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await seedWorld(t);
    // Same fixtures, but NO scheduleBlock at all.
    const sessionId = await seedSession(t, scholarId);

    const ctxOut = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(ctxOut?.physicalEnvironmentContext).toBeNull();
  });

  test("absent: a block with an empty weekday set never matches today → NOT offered", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, periodId } = await seedWorld(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "never",
        label: "Never",
        startLocal: "00:00",
        endLocal: "23:59",
        weekdays: [], // matches no ISO weekday → fail closed
        order: 0,
      });
    });
    const sessionId = await seedSession(t, scholarId);

    const ctxOut = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(ctxOut?.physicalEnvironmentContext).toBeNull();
  });

  test("absent: no ACTIVE reporting period (status closed) → NOT offered", async () => {
    const t = convexTest(schema, modules);
    // Period is "closed" → neither "writing" nor "open" → no active period.
    const { scholarId, periodId } = await seedWorld(t, "closed");
    await seedAllDayBlock(t, periodId); // a valid block, but the period isn't active
    const sessionId = await seedSession(t, scholarId);

    const ctxOut = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    expect(ctxOut?.physicalEnvironmentContext).toBeNull();
  });

  test("uses the earlier global active period before a later scoped period", async () => {
    const t = convexTest(schema, modules);
    const globalPeriodId = await t.run(async (ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Global first",
        startsAt: 0,
        endsAt: Number.MAX_SAFE_INTEGER,
        status: "open",
      }),
    );
    const { institutionId, scholarId } = await seedWorld(t);
    await seedAllDayBlock(t, globalPeriodId);
    // The scoped period is valid but has no block. Creation order must retain
    // the earlier global period rather than preferring the scoped one.
    const sessionId = await seedSession(t, scholarId);

    const ctxOut = await withAllDayFixtureClock(t, institutionId, () =>
      t.query(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut?.physicalEnvironmentContext?.equipment.map((e) => e.name)).toEqual([
      "Hand bells",
    ]);
  });

  test("uses the earlier scoped active period before a later global period", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, scholarId, periodId } = await seedWorld(t);
    await seedAllDayBlock(t, periodId);
    await t.run(async (ctx) => {
      await ctx.db.insert("reportingPeriods", {
        label: "Global later",
        startsAt: 0,
        endsAt: Number.MAX_SAFE_INTEGER,
        status: "open",
      });
    });
    const sessionId = await seedSession(t, scholarId);

    const ctxOut = await withAllDayFixtureClock(t, institutionId, () =>
      t.query(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut?.physicalEnvironmentContext?.equipment.map((e) => e.name)).toEqual([
      "Hand bells",
    ]);
  });

  test("prefers a writing period over an earlier open period", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, scholarId } = await seedWorld(t);
    const writingPeriodId = await t.run(async (ctx) =>
      ctx.db.insert("reportingPeriods", {
        label: "Writing now",
        startsAt: 0,
        endsAt: Number.MAX_SAFE_INTEGER,
        status: "writing",
        institutionId,
      }),
    );
    await seedAllDayBlock(t, writingPeriodId);
    const sessionId = await seedSession(t, scholarId);

    const ctxOut = await withAllDayFixtureClock(t, institutionId, () =>
      t.query(internal.sessionHelpers.getSessionContext, { sessionId }),
    );
    expect(ctxOut?.physicalEnvironmentContext?.equipment.map((e) => e.name)).toEqual([
      "Hand bells",
    ]);
  });

  test("test-drive bypass: a test-drive session with NO active schedule STILL offers gear", async () => {
    const t = convexTest(schema, modules);
    // Closed period + no block → off-hours by the data. A test drive bypasses so
    // a teacher can rehearse physical tasks at any hour. contextUserId resolves to
    // the session owner (the scholar here, who has the institution), and with no
    // synthetic fields set this is NOT a synthetic view, so the institution read
    // still runs.
    const { scholarId } = await seedWorld(t, "closed");
    const sessionId = await seedSession(t, scholarId, { isTestDrive: true });

    const ctxOut = await t.query(internal.sessionHelpers.getSessionContext, {
      sessionId,
    });
    const gear = ctxOut?.physicalEnvironmentContext?.equipment ?? [];
    expect(gear.map((e) => e.name)).toEqual(["Hand bells"]);
  });
});
