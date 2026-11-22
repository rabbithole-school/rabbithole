import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { readScholarDayUsage } from "../deviceActivity";
import {
  SCREEN_TIME_RECOMPUTE_DELAY_MS,
  SCREEN_TIME_STALE_MARK_MS,
} from "../lib/screenTimeDirty";
import { summarizeInstitutionDay } from "../screenTimeDays";
import { dayKeyForTimezone, shiftDayKey } from "../../shared/institutionDay";
import { STRETCH_KINDS } from "../../shared/screenTimeStretches";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HST = "Pacific/Honolulu";
const MINUTE = 60_000;
const DEVICE_ID = "fixture-ipad";

afterEach(() => {
  vi.useRealTimers();
});

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 60 * MINUTE }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

async function setUp() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const kestrel = await ctx.db.insert("institutions", {
      name: "Kestrel Academy",
      slug: "kestrel",
      kind: "school",
      timeZone: HST,
    });
    const heron = await ctx.db.insert("institutions", {
      name: "Heron School",
      slug: "heron",
      kind: "school",
      timeZone: HST,
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Avery Stone",
      username: "avery-stone",
      role: "scholar",
      institutionId: kestrel,
    });
    const heronScholarId = await ctx.db.insert("users", {
      name: "Hoku Makani",
      username: "hoku-makani",
      role: "scholar",
      institutionId: heron,
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Lehua Torres",
      username: "lehua-torres",
      role: "teacher",
      institutionId: kestrel,
    });
    await ctx.db.insert("memberships", {
      userId: teacherId,
      role: "teacher",
      institutionId: kestrel,
    });
    return { kestrel, heron, scholarId, heronScholarId, teacherId };
  });
  return { t, ...ids };
}

/** Twenty minutes on the BunnyPad, ending `endsAgoMs` before now. */
function twentyMinutes(endsAgoMs: number) {
  const end = Date.now() - endsAgoMs;
  const start = end - 20 * MINUTE;
  const events: { kind: "app_foreground" | "heartbeat" | "app_background"; clientAt: number }[] = [
    { kind: "app_foreground", clientAt: start },
  ];
  for (let at = start + MINUTE; at < end; at += MINUTE) {
    events.push({ kind: "heartbeat", clientAt: at });
  }
  events.push({ kind: "app_background", clientAt: end });
  return events;
}

const dirtyRows = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("screenTimeDirty").collect());
const summaryRows = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.query("screenTimeDays").collect());
const scheduled = (t: ReturnType<typeof convexTest>) =>
  t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

describe("the debounced recompute", () => {
  test("a busy iPad marks its day once and schedules one recompute", async () => {
    vi.useFakeTimers();
    const { t, scholarId } = await setUp();
    const asScholar = await asUser(t, scholarId);
    // Three batches inside the debounce window.
    for (const endsAgo of [40 * MINUTE, 30 * MINUTE, 25 * MINUTE]) {
      await asScholar.mutation(api.deviceActivity.record, {
        deviceId: DEVICE_ID,
        events: twentyMinutes(endsAgo).slice(0, 5),
      });
    }
    expect(await dirtyRows(t)).toHaveLength(1);
    const pending = (await scheduled(t)).filter(
      (job) => job.name.includes("screenTimeDays") && job.state.kind === "pending",
    );
    expect(pending).toHaveLength(1);
    expect(pending[0].scheduledTime - pending[0]._creationTime).toBeGreaterThanOrEqual(
      SCREEN_TIME_RECOMPUTE_DELAY_MS - 1_000,
    );
    expect(await summaryRows(t)).toHaveLength(0);
  });

  test("the recompute writes the live read model's row, then a new batch marks the day again", async () => {
    vi.useFakeTimers();
    const { t, scholarId, kestrel } = await setUp();
    const asScholar = await asUser(t, scholarId);
    await asScholar.mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: twentyMinutes(30 * MINUTE),
    });
    vi.advanceTimersByTime(SCREEN_TIME_RECOMPUTE_DELAY_MS + 1_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await dirtyRows(t)).toHaveLength(0);
    const [row] = await summaryRows(t);
    expect(row.scholarId).toBe(scholarId);
    expect(row.institutionId).toBe(kestrel);
    const dayKey = row.dayKey;
    const live = await t.run(async (ctx) =>
      readScholarDayUsage(
        ctx,
        {
          institutionIds: [kestrel],
          scholarIds: [scholarId],
          roster: async () => [scholarId],
          scholarAllowed: () => true,
          playInstitutionAllowed: (id) => id === kestrel,
          primaryInstitutionId: undefined,
          fallbackInstitutionId: kestrel,
        },
        dayKey,
        dayKey,
        { timeline: true, timelineDetails: false },
      ),
    );
    expect(row.usage.measuredMinutes).toBe(live[0].measuredMinutes);
    expect(row.usage.measuredMinutes).toBeGreaterThan(0);
    // The kinds are the strip's classifier, split at the bell, and add up to
    // the measured minutes.
    const kindTotal = STRETCH_KINDS.reduce(
      (sum, kind) => sum + row.kinds.inSchool[kind] + row.kinds.outside[kind],
      0,
    );
    expect(kindTotal).toBeCloseTo(live[0].timeline!.totalMinutes, 0);

    await asScholar.mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [{ kind: "heartbeat", clientAt: Date.now() - MINUTE }],
    });
    expect(await dirtyRows(t)).toHaveLength(1);
  });

  test("a recompute of a day with no usage removes its row", async () => {
    const { t, scholarId, kestrel } = await setUp();
    const dayKey = dayKeyForTimezone(Date.now(), HST);
    await t.run((ctx) =>
      ctx.db.insert("screenTimeDays", {
        scholarId,
        institutionId: kestrel,
        dayKey,
        usage: {
          foregroundMinutes: 5,
          apps: [],
          unattributedBackgroundMinutes: 0,
          measuredMinutes: 5,
          estimatedMinutes: 0,
          estimatedIntervals: 0,
          byContext: {},
          eventCount: 3,
          outsideSchool: { measuredMinutes: 0, estimatedMinutes: 0, foregroundMinutes: 0 },
          builder: { onScreenMinutes: 0, activeMinutes: 0 },
          webActivityMinutes: 0,
          otherRabbitholeMinutes: 5,
          schoolDay: true,
        },
        kinds: {
          inSchool: { launched_app: 0, web: 0, building: 0, playing: 0, practice: 0, chat: 0, rabbithole: 5 },
          outside: { launched_app: 0, web: 0, building: 0, playing: 0, practice: 0, chat: 0, rabbithole: 0 },
        },
        computedAt: Date.now(),
      }),
    );
    expect(
      await t.mutation(internal.screenTimeDays.recompute, {
        scholarId,
        dayKey,
        institutionId: kestrel,
      }),
    ).toBe("deleted");
    expect(await summaryRows(t)).toHaveLength(0);
  });
});

describe("the nightly pass and the period read", () => {
  test("yesterday is covered only once its rows are written, and only once", async () => {
    vi.useFakeTimers();
    const { t, teacherId } = await setUp();
    const today = dayKeyForTimezone(Date.now(), HST);
    const yesterday = shiftDayKey(today, -1);
    const asTeacher = await asUser(t, teacherId);

    const first = await t.mutation(internal.screenTimeDays.finalizeYesterday, {});
    expect(first.map((day) => day.dayKey)).toEqual([yesterday, yesterday]);
    expect(first.every((day) => day.scholars === 1)).toBe(true);
    // Scheduled, not yet run: the day is not served from the summary yet.
    const coverage = () => t.run((ctx) => ctx.db.query("screenTimeDayCoverage").collect());
    expect(await coverage()).toHaveLength(0);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await coverage()).toHaveLength(2);
    expect(await t.mutation(internal.screenTimeDays.finalizeYesterday, {})).toEqual([]);

    // The schools were created today, so only today can need coverage: read
    // as if it were tomorrow, and today counts as a past day.
    const tomorrow = shiftDayKey(today, 1);
    const read = () =>
      asTeacher.query(api.screenTimeDays.periodUsage, {
        startDayKey: yesterday,
        endDayKey: today,
        todayDayKey: tomorrow,
      });
    expect((await read()).complete).toBe(false);
    await t.run(async (ctx) => {
      for (const school of await ctx.db.query("institutions").collect()) {
        await summarizeInstitutionDay(ctx, school._id, today);
      }
    });
    expect((await read()).complete).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await read()).complete).toBe(true);
  });

  test("a scholar on another school's paired iPad keeps that school's row through both passes", async () => {
    vi.useFakeTimers();
    const { t, heronScholarId, kestrel, heron, teacherId } = await setUp();
    // Hoku's school is Heron, but this iPad is paired to Kestrel.
    await t.run((ctx) =>
      ctx.db.insert("pairedDevices", {
        institutionId: kestrel,
        deviceId: DEVICE_ID,
        scholarId: heronScholarId,
        pairedAt: Date.now(),
        pairedBy: teacherId,
      }),
    );
    await (await asUser(t, heronScholarId)).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: twentyMinutes(30 * MINUTE),
    });
    vi.advanceTimersByTime(SCREEN_TIME_RECOMPUTE_DELAY_MS + 1_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const [row] = await summaryRows(t);
    expect(row.institutionId).toBe(kestrel);

    // Each school's own pass for that day leaves the Kestrel row alone.
    await t.run(async (ctx) => {
      await summarizeInstitutionDay(ctx, heron, row.dayKey);
      await summarizeInstitutionDay(ctx, kestrel, row.dayKey);
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const after = await summaryRows(t);
    expect(after.map((r) => r.institutionId)).toEqual([kestrel]);
    expect(after[0].usage.measuredMinutes).toBe(row.usage.measuredMinutes);
  });

  test("a mark whose recompute never ran is rescheduled once it is stale", async () => {
    vi.useFakeTimers();
    const { t, scholarId, kestrel } = await setUp();
    const dayKey = dayKeyForTimezone(Date.now(), HST);
    await t.run((ctx) =>
      ctx.db.insert("screenTimeDirty", {
        scholarId,
        dayKey,
        institutionId: kestrel,
        markedAt: Date.now() - SCREEN_TIME_STALE_MARK_MS - MINUTE,
      }),
    );
    await (await asUser(t, scholarId)).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [{ kind: "heartbeat", clientAt: Date.now() - MINUTE }],
    });
    const pending = (await scheduled(t)).filter(
      (job) => job.name.includes("screenTimeDays") && job.state.kind === "pending",
    );
    expect(pending).toHaveLength(1);
    expect(await dirtyRows(t)).toHaveLength(1);
  });

  test("a teacher reads only her own school's rows", async () => {
    vi.useFakeTimers();
    const { t, scholarId, heronScholarId, teacherId } = await setUp();
    for (const id of [scholarId, heronScholarId]) {
      await (await asUser(t, id)).mutation(api.deviceActivity.record, {
        deviceId: `${DEVICE_ID}-${id}`,
        events: twentyMinutes(30 * MINUTE),
      });
    }
    vi.advanceTimersByTime(SCREEN_TIME_RECOMPUTE_DELAY_MS + 1_000);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await summaryRows(t)).toHaveLength(2);

    const today = dayKeyForTimezone(Date.now(), HST);
    const { rows } = await (await asUser(t, teacherId)).query(
      api.screenTimeDays.periodUsage,
      { startDayKey: shiftDayKey(today, -1), endDayKey: today, todayDayKey: today },
    );
    expect(rows.map((row) => row.scholarId)).toEqual([scholarId]);
    expect(rows[0].scholarName).toBe("Avery Stone");
    expect(rows[0].measuredMinutes).toBeGreaterThan(0);
  });

  test("the backfill walks a school's days and skips covered ones", async () => {
    vi.useFakeTimers();
    const { t, kestrel } = await setUp();
    const today = dayKeyForTimezone(Date.now(), HST);
    const from = shiftDayKey(today, -3);
    const to = shiftDayKey(today, -1);
    await t.mutation(internal.screenTimeDays.backfill, {
      institutionId: kestrel,
      fromDayKey: from,
      toDayKey: to,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const covered = await t.run((ctx) => ctx.db.query("screenTimeDayCoverage").collect());
    expect(covered.map((row) => row.dayKey).sort()).toEqual([from, shiftDayKey(from, 1), to]);
    expect(
      await t.mutation(internal.screenTimeDays.backfill, {
        institutionId: kestrel,
        fromDayKey: from,
        toDayKey: to,
      }),
    ).toEqual({ done: true });
  });
});
