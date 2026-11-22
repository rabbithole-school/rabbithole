import { convexTest } from "convex-test";
import { afterAll, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { readScholarDayUsage } from "../deviceActivity";
import type { Id } from "../_generated/dataModel";
import {
  UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
  msToMinutes,
} from "../../shared/deviceActivityRollup";
import { NO_ACTIVITY_DETAIL } from "../../shared/screenTimeStretches";
import {
  dayKeyForTimezone,
  instantForLocalMinutes,
  shiftDayKey,
} from "../../shared/institutionDay";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = "scholar" | "teacher" | "parent";

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
): Promise<Id<"institutions">> {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: slug,
      slug,
      kind: "school",
      timeZone: "Pacific/Honolulu",
    }),
  );
}

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  institutionId?: Id<"institutions">,
  overrides: { enrollmentStanding?: "enrolled" | "program_guest" } = {},
): Promise<Id<"users">> {
  const suffix = Math.random().toString(36).slice(2, 8);
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `${role} ${suffix}`,
      username: `${role}-${suffix}`,
      role,
      ...(institutionId ? { institutionId } : {}),
      ...overrides,
    }),
  );
}

async function asUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function grantMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  role: string,
  institutionId: Id<"institutions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("memberships", { userId, role, institutionId }),
  );
}

const DEVICE_ID = "device-activity-test-0001";
const TIME_ZONE = "Pacific/Honolulu";
const MINUTE = 60_000;
const SCHOOL_DAY_KEY = "2026-09-08";
/** 09:30 school-local — squarely inside a core school day. */
const SCHOOL_DAY_0930 = instantForLocalMinutes(
  SCHOOL_DAY_KEY,
  9 * 60 + 30,
  TIME_ZONE,
);

// Freeze server and fixture clocks together so Monday-morning filtering cannot race this test.
// TRA-267 tracks the gate failure caused by deriving fixture dates from the live clock.
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(SCHOOL_DAY_0930);
afterAll(() => vi.useRealTimers());

describe("deviceActivity.record", () => {
  test("stamps tenant, receivedAt, day key, and context on the server", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);

    const result = await (
      await asUser(t, scholarId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [
        { kind: "app_foreground", clientAt: SCHOOL_DAY_0930 },
        { kind: "heartbeat", clientAt: SCHOOL_DAY_0930 + MINUTE },
      ],
    });
    expect(result).toEqual({ recorded: 2, dropped: 0 });

    const rows = await t.run((ctx) =>
      ctx.db.query("deviceActivityEvents").collect(),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.userId).toBe(scholarId);
      expect(row.institutionId).toBe(institutionId);
      expect(row.deviceId).toBe(DEVICE_ID);
      expect(row.dayKey).toBe(SCHOOL_DAY_KEY);
      expect(row.context).toBe("core_day");
      expect(row.receivedAt).toBeGreaterThan(0);
    }
  });

  test("a program guest's minutes are tagged extended_ed", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const guestId = await seedUser(t, "scholar", institutionId, {
      enrollmentStanding: "program_guest",
    });

    await (
      await asUser(t, guestId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [{ kind: "app_foreground", clientAt: SCHOOL_DAY_0930 }],
    });

    const row = await t.run((ctx) =>
      ctx.db.query("deviceActivityEvents").first(),
    );
    expect(row?.context).toBe("extended_ed");
  });

  test("a school closure makes the same hour unknown, not core_day", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: SCHOOL_DAY_KEY,
        endDayKey: SCHOOL_DAY_KEY,
        label: "Statehood Day",
        kind: "holiday",
      }),
    );

    await (
      await asUser(t, scholarId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [{ kind: "app_foreground", clientAt: SCHOOL_DAY_0930 }],
    });

    const row = await t.run((ctx) =>
      ctx.db.query("deviceActivityEvents").first(),
    );
    expect(row?.context).toBe("unknown");
  });

  test("drops events whose client clock is implausible without failing the batch", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);
    const now = Date.now();

    const result = await (
      await asUser(t, scholarId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [
        { kind: "app_foreground", clientAt: now },
        { kind: "heartbeat", clientAt: now + 30 * 24 * 60 * 60 * 1000 },
        { kind: "heartbeat", clientAt: now - 400 * 24 * 60 * 60 * 1000 },
      ],
    });
    expect(result).toEqual({ recorded: 1, dropped: 2 });
  });

  test("requires authentication", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(api.deviceActivity.record, {
        deviceId: DEVICE_ID,
        events: [{ kind: "app_foreground", clientAt: SCHOOL_DAY_0930 }],
      }),
    ).rejects.toThrow();
  });
});

describe("deviceActivity.record — TRA-331 diagnostics", () => {
  test("accepts stuck-inactive and lock-change events with their fields", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);

    const result = await (
      await asUser(t, scholarId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [
        {
          kind: "app_stuck_inactive",
          clientAt: SCHOOL_DAY_0930,
          durationMs: 2 * MINUTE,
        },
        {
          kind: "app_stuck_inactive_end",
          clientAt: SCHOOL_DAY_0930 + 5 * MINUTE,
          durationMs: 5 * MINUTE,
        },
        {
          kind: "asam_exit",
          clientAt: SCHOOL_DAY_0930 + 6 * MINUTE,
          reason: "offline",
          ok: true,
        },
        {
          kind: "asam_enter",
          clientAt: SCHOOL_DAY_0930 + 7 * MINUTE,
          reason: "back_online",
          ok: false,
        },
      ],
    });
    expect(result).toEqual({ recorded: 4, dropped: 0 });

    const rows = await t.run((ctx) =>
      ctx.db.query("deviceActivityEvents").collect(),
    );
    const byKind = new Map(rows.map((row) => [row.kind, row]));
    expect(byKind.get("app_stuck_inactive")?.durationMs).toBe(2 * MINUTE);
    expect(byKind.get("app_stuck_inactive_end")?.durationMs).toBe(5 * MINUTE);
    expect(byKind.get("asam_exit")).toMatchObject({
      reason: "offline",
      ok: true,
      dayKey: SCHOOL_DAY_KEY,
      institutionId,
    });
    expect(byKind.get("asam_enter")).toMatchObject({
      reason: "back_online",
      ok: false,
    });
  });

  test("the clock-skew window applies to diagnostics too", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);

    const result = await (
      await asUser(t, scholarId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [
        {
          kind: "app_stuck_inactive",
          clientAt: SCHOOL_DAY_0930 + 2 * 60 * MINUTE,
          durationMs: 2 * MINUTE,
        },
      ],
    });
    expect(result).toEqual({ recorded: 0, dropped: 1 });
  });
});

describe("deviceActivity.dailyUsage", () => {
  async function seedDay(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    institutionId: Id<"institutions">,
    externalAppId: Id<"externalApps">,
  ) {
    const at = (minutes: number) => SCHOOL_DAY_0930 + minutes * MINUTE;
    const rows = [
      { kind: "app_foreground" as const, clientAt: at(0) },
      { kind: "heartbeat" as const, clientAt: at(1) },
      { kind: "heartbeat" as const, clientAt: at(2) },
      // Into an authorized app and back — 20 measured minutes.
      { kind: "external_launch" as const, clientAt: at(3), externalAppId },
      { kind: "external_return" as const, clientAt: at(23), externalAppId },
      { kind: "heartbeat" as const, clientAt: at(24) },
      // …and back in, but the iPad locks for the day. Capped, not attributed.
      { kind: "external_launch" as const, clientAt: at(25), externalAppId },
    ];
    await t.run(async (ctx) => {
      for (const row of rows) {
        await ctx.db.insert("deviceActivityEvents", {
          userId: scholarId,
          institutionId,
          deviceId: DEVICE_ID,
          kind: row.kind,
          externalAppId: row.externalAppId,
          clientAt: row.clientAt,
          receivedAt: row.clientAt,
          dayKey: SCHOOL_DAY_KEY,
          context: "core_day",
        });
      }
    });
  }

  async function setUp() {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const scholarId = await seedUser(t, "scholar", institutionId);
    const teacherId = await seedUser(t, "teacher", institutionId);
    await grantMembership(t, teacherId, "teacher", institutionId);
    const externalAppId = await t.run((ctx) =>
      ctx.db.insert("externalApps", {
        name: "LEGO SPIKE",
        webUrl: "https://example.test",
        nativeUrlScheme: "spike://",
      }),
    );
    await seedDay(t, scholarId, institutionId, externalAppId);
    return { t, institutionId, scholarId, teacherId, externalAppId };
  }

  test("reports measured and estimated minutes as separate numbers", async () => {
    const { t, scholarId, teacherId, externalAppId } = await setUp();

    const rows = await (
      await asUser(t, teacherId)
    ).query(api.deviceActivity.dailyUsage, {
      startDayKey: SCHOOL_DAY_KEY,
      endDayKey: SCHOOL_DAY_KEY,
    });

    expect(rows).toHaveLength(1);
    const day = rows[0];
    expect(day.scholarId).toBe(scholarId);
    expect(day.dayKey).toBe(SCHOOL_DAY_KEY);
    // 3 min before the first launch + 2 min between the return and the second.
    expect(day.foregroundMinutes).toBe(5);
    expect(day.apps).toHaveLength(1);
    expect(day.apps[0].externalAppId).toBe(externalAppId);
    expect(day.apps[0].measuredMinutes).toBe(20);
    expect(day.apps[0].estimatedMinutes).toBe(
      msToMinutes(UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS),
    );
    expect(day.apps[0].estimatedIntervals).toBe(1);
    // The two numbers are exposed side by side and never merged.
    expect(day.measuredMinutes).toBe(25);
    expect(day.estimatedMinutes).toBe(10);
    expect(day.estimatedIntervals).toBe(1);
    expect(day.byContext.core_day).toEqual({
      measuredMinutes: 25,
      estimatedMinutes: 10,
    });
    // School hours on a school day, and no app or web time: all of it is
    // ordinary Rabbithole foreground inside school.
    expect(day.outsideSchool).toEqual({ measuredMinutes: 0, estimatedMinutes: 0, foregroundMinutes: 0 });
    expect(day.builder).toEqual({ onScreenMinutes: 0, activeMinutes: 0 });
    expect(day.webActivityMinutes).toBe(0);
    expect(day.otherRabbitholeMinutes).toBe(5);
  });

  test("diagnostic rows leave every usage number unchanged", async () => {
    const { t, scholarId, teacherId } = await setUp();
    const asTeacher = await asUser(t, teacherId);
    const range = { startDayKey: SCHOOL_DAY_KEY, endDayKey: SCHOOL_DAY_KEY };
    const before = await asTeacher.query(api.deviceActivity.dailyUsage, range);

    // Interleave diagnostics inside the spans the roll-up books: between the
    // foreground and its first heartbeat, right after a launch, and after the
    // day's trailing launch.
    const at = (minutes: number) => SCHOOL_DAY_0930 + minutes * MINUTE;
    await (
      await asUser(t, scholarId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [
        { kind: "asam_exit", clientAt: at(0.5), reason: "offline", ok: true },
        { kind: "asam_enter", clientAt: at(3.5), reason: "armed", ok: true },
        { kind: "app_stuck_inactive", clientAt: at(26), durationMs: 2 * MINUTE },
        {
          kind: "app_stuck_inactive_end",
          clientAt: at(30),
          durationMs: 4 * MINUTE,
        },
      ],
    });

    expect(await asTeacher.query(api.deviceActivity.dailyUsage, range)).toEqual(
      before,
    );
  });

  test("a scholar-day with only diagnostic rows produces no usage row", async () => {
    const { t, institutionId, teacherId } = await setUp();
    const otherScholarId = await seedUser(t, "scholar", institutionId);
    await (
      await asUser(t, otherScholarId)
    ).mutation(api.deviceActivity.record, {
      deviceId: DEVICE_ID,
      events: [
        { kind: "app_stuck_inactive", clientAt: SCHOOL_DAY_0930, durationMs: 2 * MINUTE },
      ],
    });
    const rows = await (
      await asUser(t, teacherId)
    ).query(api.deviceActivity.dailyUsage, {
      startDayKey: SCHOOL_DAY_KEY,
      endDayKey: SCHOOL_DAY_KEY,
    });
    expect(rows.map((row) => row.scholarId)).not.toContain(otherScholarId);
    expect(rows).toHaveLength(1);
  });

  test("narrows to one scholar", async () => {
    const { t, institutionId, scholarId, teacherId, externalAppId } =
      await setUp();
    const otherScholarId = await seedUser(t, "scholar", institutionId);
    await seedDay(t, otherScholarId, institutionId, externalAppId);

    const asTeacher = await asUser(t, teacherId);
    expect(
      await asTeacher.query(api.deviceActivity.dailyUsage, {
        startDayKey: SCHOOL_DAY_KEY,
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).toHaveLength(2);
    const narrowed = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: SCHOOL_DAY_KEY,
      endDayKey: SCHOOL_DAY_KEY,
      scholarId,
    });
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0].scholarId).toBe(scholarId);
  });

  test("PARENTS CANNOT READ THIS", async () => {
    const { t, institutionId } = await setUp();
    const parentId = await seedUser(t, "parent", institutionId);
    await grantMembership(t, parentId, "parent", institutionId);
    await expect(
      (
        await asUser(t, parentId)
      ).query(api.deviceActivity.dailyUsage, {
        startDayKey: SCHOOL_DAY_KEY,
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).rejects.toThrow();
  });

  test("a scholar cannot read their own or anyone else's screen time", async () => {
    const { t, scholarId } = await setUp();
    await expect(
      (
        await asUser(t, scholarId)
      ).query(api.deviceActivity.dailyUsage, {
        startDayKey: SCHOOL_DAY_KEY,
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).rejects.toThrow();
  });

  test("a teacher at another school sees nothing", async () => {
    const { t } = await setUp();
    const otherInstitutionId = await seedInstitution(t, "kai");
    const outsiderId = await seedUser(t, "teacher", otherInstitutionId);
    await grantMembership(t, outsiderId, "teacher", otherInstitutionId);

    expect(
      await (
        await asUser(t, outsiderId)
      ).query(api.deviceActivity.dailyUsage, {
        startDayKey: SCHOOL_DAY_KEY,
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).toEqual([]);
  });

  test("rejects a malformed or oversized range", async () => {
    const { t, teacherId, scholarId } = await setUp();
    const asTeacher = await asUser(t, teacherId);
    await expect(
      asTeacher.query(api.deviceActivity.dailyUsage, {
        startDayKey: "14/09/2026",
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).rejects.toThrow(/YYYY-MM-DD/);
    await expect(
      asTeacher.query(api.deviceActivity.dailyUsage, {
        startDayKey: shiftDayKey(SCHOOL_DAY_KEY, 1),
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).rejects.toThrow(/after/);
    await expect(
      asTeacher.query(api.deviceActivity.dailyUsage, {
        startDayKey: shiftDayKey(SCHOOL_DAY_KEY, -60),
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).rejects.toThrow(/at most/);
    // A whole-school read is capped at 14 days; one scholar's at 31.
    await expect(
      asTeacher.query(api.deviceActivity.dailyUsage, {
        startDayKey: shiftDayKey(SCHOOL_DAY_KEY, -14),
        endDayKey: SCHOOL_DAY_KEY,
      }),
    ).rejects.toThrow(/at most 14 days/);
    await expect(
      asTeacher.query(api.deviceActivity.dailyUsage, {
        startDayKey: shiftDayKey(SCHOOL_DAY_KEY, -30),
        endDayKey: SCHOOL_DAY_KEY,
        scholarId,
      }),
    ).resolves.toEqual(expect.any(Array));
  });
});

describe("deviceActivity.dailyUsage — where the time went", () => {
  type StoredContext = "core_day" | "extended_ed" | "homework" | "unknown";
  type SeedEvent = {
    kind:
      | "app_foreground"
      | "app_background"
      | "heartbeat"
      | "external_launch"
      | "external_return";
    clientAt: number;
    context: StoredContext;
    externalAppId?: Id<"externalApps">;
  };

  const TUESDAY = SCHOOL_DAY_KEY; // 2026-09-08
  const WEDNESDAY = shiftDayKey(SCHOOL_DAY_KEY, 1);
  const SATURDAY = shiftDayKey(SCHOOL_DAY_KEY, 4);
  const CLOSED_MONDAY = shiftDayKey(SCHOOL_DAY_KEY, 6);

  /** An instant at a wall-clock minute on a school-local day. */
  const local = (dayKey: string, minuteOfDay: number) =>
    instantForLocalMinutes(dayKey, minuteOfDay, TIME_ZONE);

  /**
   * Foreground at `from`, a heartbeat every minute, backgrounded at `to`:
   * exactly `to - from` measured foreground minutes, all with one stored tag.
   */
  function foregroundStretch(
    dayKey: string,
    from: number,
    to: number,
    context: StoredContext,
  ): SeedEvent[] {
    const events: SeedEvent[] = [
      { kind: "app_foreground", clientAt: local(dayKey, from), context },
    ];
    for (let minute = from + 1; minute < to; minute += 1) {
      events.push({ kind: "heartbeat", clientAt: local(dayKey, minute), context });
    }
    events.push({ kind: "app_background", clientAt: local(dayKey, to), context });
    return events;
  }

  async function insertEvents(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    institutionId: Id<"institutions"> | undefined,
    events: SeedEvent[],
  ) {
    await t.run(async (ctx) => {
      for (const event of events) {
        await ctx.db.insert("deviceActivityEvents", {
          userId: scholarId,
          institutionId,
          deviceId: DEVICE_ID,
          kind: event.kind,
          externalAppId: event.externalAppId,
          clientAt: event.clientAt,
          receivedAt: event.clientAt,
          dayKey: dayKeyForTimezone(event.clientAt, TIME_ZONE),
          context: event.context,
        });
      }
    });
  }

  async function seedWebSession(
    t: ReturnType<typeof convexTest>,
    scholarId: Id<"users">,
    appId: Id<"externalApps">,
    startedAt: number,
    endedAt: number,
  ) {
    await t.run((ctx) =>
      ctx.db.insert("webActivitySessions", {
        scholarId,
        appId,
        startedAt,
        endedAt,
        lastHeartbeatAt: endedAt,
        screenshotIds: [],
      }),
    );
  }

  async function setUp() {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const otherInstitutionId = await seedInstitution(t, "kai");
    const scholarId = await seedUser(t, "scholar", institutionId);
    const teacherId = await seedUser(t, "teacher", institutionId);
    await grantMembership(t, teacherId, "teacher", institutionId);
    const { spikeId, epicId } = await t.run(async (ctx) => ({
      spikeId: await ctx.db.insert("externalApps", {
        name: "LEGO SPIKE",
        webUrl: "https://example.test",
        nativeUrlScheme: "spike://",
      }),
      epicId: await ctx.db.insert("externalApps", {
        name: "Epic",
        webUrl: "https://epic.example.test",
      }),
    }));
    const asTeacher = await asUser(t, teacherId);
    return {
      t,
      institutionId,
      otherInstitutionId,
      scholarId,
      asTeacher,
      spikeId,
      epicId,
    };
  }

  test("outside school is decided by the clock, not by the stored program tag", async () => {
    const { t, institutionId, scholarId, asTeacher, spikeId } = await setUp();
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: CLOSED_MONDAY,
        endDayKey: CLOSED_MONDAY,
        label: "Fall Break",
        kind: "holiday",
      }),
    );
    await insertEvents(t, scholarId, institutionId, [
      // Tuesday 09:30, tagged homework: school hours on a school day, so IN
      // school by the clock even though the program tag says homework.
      ...foregroundStretch(TUESDAY, 9 * 60 + 30, 9 * 60 + 33, "homework"),
      // Tuesday evening: two foreground minutes, then a launch that never
      // came back (a capped ten-minute estimate).
      { kind: "app_foreground", clientAt: local(TUESDAY, 19 * 60), context: "unknown" },
      { kind: "heartbeat", clientAt: local(TUESDAY, 19 * 60 + 1), context: "unknown" },
      {
        kind: "external_launch",
        clientAt: local(TUESDAY, 19 * 60 + 2),
        context: "unknown",
        externalAppId: spikeId,
      },
      // Saturday morning in extended ed: outside school hours by the clock.
      ...foregroundStretch(SATURDAY, 10 * 60, 10 * 60 + 4, "extended_ed"),
      // A closed Monday at 09:30: not an open school day.
      ...foregroundStretch(CLOSED_MONDAY, 9 * 60 + 30, 9 * 60 + 32, "unknown"),
    ]);

    const rows = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: CLOSED_MONDAY,
    });
    const byDay = new Map(rows.map((row) => [row.dayKey, row]));
    expect([...byDay.keys()]).toEqual([TUESDAY, SATURDAY, CLOSED_MONDAY]);

    const tuesday = byDay.get(TUESDAY)!;
    expect(tuesday.foregroundMinutes).toBe(5);
    expect(tuesday.estimatedMinutes).toBe(10);
    expect(tuesday.outsideSchool).toEqual({
      measuredMinutes: 2,
      estimatedMinutes: 10,
      foregroundMinutes: 2,
    });
    // The stored program tag is still reported, unchanged.
    expect(tuesday.byContext.homework).toEqual({ measuredMinutes: 3, estimatedMinutes: 0 });

    expect(byDay.get(SATURDAY)!.outsideSchool).toEqual({
      measuredMinutes: 4,
      estimatedMinutes: 0,
      foregroundMinutes: 4,
    });
    expect(byDay.get(SATURDAY)!.byContext.extended_ed).toEqual({
      measuredMinutes: 4,
      estimatedMinutes: 0,
    });
    expect(byDay.get(CLOSED_MONDAY)!.outsideSchool).toEqual({
      measuredMinutes: 2,
      estimatedMinutes: 0,
      foregroundMinutes: 2,
    });
  });

  test("splits foreground into the scholar's own app, web activities, and the rest", async () => {
    const { t, institutionId, otherInstitutionId, scholarId, asTeacher, epicId } =
      await setUp();
    // 45 minutes of Rabbithole foreground, 09:55 to 10:40.
    await insertEvents(
      t,
      scholarId,
      institutionId,
      foregroundStretch(TUESDAY, 9 * 60 + 55, 10 * 60 + 40, "core_day"),
    );
    const { builderSessionId, tutorSessionId } = await t.run(async (ctx) => {
      const builderSessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        institutionId,
        title: "Volcano builder",
        isArchived: false,
      });
      const tutorSessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        institutionId,
        title: "Fractions chat",
        isArchived: false,
      });
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId: builderSessionId,
        title: "Volcano",
        content: "<canvas></canvas>",
        lastEditedBy: "ai",
        type: "code",
        language: "html",
      });
      // The app on screen 10:00 to 10:30, closed at its last check-in.
      await ctx.db.insert("appPlaySessions", {
        userId: scholarId,
        institutionId,
        sessionId: builderSessionId,
        artifactId,
        surface: "native",
        startedAt: local(TUESDAY, 10 * 60),
        lastActiveAt: local(TUESDAY, 10 * 60 + 30),
        resumes: 0,
      });
      // A row stamped with another school stays out of this school's report.
      await ctx.db.insert("appPlaySessions", {
        userId: scholarId,
        institutionId: otherInstitutionId,
        sessionId: builderSessionId,
        artifactId,
        surface: "native",
        startedAt: local(TUESDAY, 11 * 60),
        lastActiveAt: local(TUESDAY, 11 * 60 + 20),
        endedAt: local(TUESDAY, 11 * 60 + 20),
        resumes: 0,
      });
      return { builderSessionId, tutorSessionId };
    });

    // Transcript rows, inserted in time order so their _creationTime is the
    // instant named (convex-test stamps it from the faked clock).
    const messageRows: {
      sessionId: Id<"sessions">;
      role: "user" | "assistant";
      at: number;
      byStaff?: true;
    }[] = [
      // Ask at 10:05, reply at 10:05:30 → 10:04 to 10:06:30 (2.5 min).
      { sessionId: builderSessionId, role: "user", at: local(TUESDAY, 10 * 60 + 5) },
      {
        sessionId: builderSessionId,
        role: "assistant",
        at: local(TUESDAY, 10 * 60 + 5) + 30_000,
      },
      // A turn in a DIFFERENT session never vouches for this app.
      { sessionId: tutorSessionId, role: "user", at: local(TUESDAY, 10 * 60 + 12) },
      // Ask at 10:20, reply at 10:21 → 10:19 to 10:22 (3 min).
      { sessionId: builderSessionId, role: "user", at: local(TUESDAY, 10 * 60 + 20) },
      { sessionId: builderSessionId, role: "assistant", at: local(TUESDAY, 10 * 60 + 21) },
      // A teacher typing in the scholar's session is not the scholar's turn.
      {
        sessionId: builderSessionId,
        role: "user",
        at: local(TUESDAY, 10 * 60 + 25),
        byStaff: true,
      },
      // Ask at 10:29:30 → its window is clipped where the app left the screen
      // at 10:30 (1.5 min).
      {
        sessionId: builderSessionId,
        role: "user",
        at: local(TUESDAY, 10 * 60 + 29) + 30_000,
      },
    ];
    for (const message of messageRows) {
      vi.setSystemTime(message.at);
      await t.run((ctx) =>
        ctx.db.insert("messages", {
          sessionId: message.sessionId,
          role: message.role,
          content: "fixture",
          flagged: false,
          ...(message.byStaff ? { byStaff: true } : {}),
        }),
      );
    }
    vi.setSystemTime(SCHOOL_DAY_0930);

    // An Epic web activity, 10:30 to 10:40.
    await seedWebSession(
      t,
      scholarId,
      epicId,
      local(TUESDAY, 10 * 60 + 30),
      local(TUESDAY, 10 * 60 + 40),
    );

    const rows = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: TUESDAY,
    });
    expect(rows).toHaveLength(1);
    const day = rows[0];
    expect(day.foregroundMinutes).toBe(45);
    // 2.5 + 3 + 1.5 with the provisional one-minute lead and trail.
    expect(day.builder).toEqual({ onScreenMinutes: 30, activeMinutes: 7 });
    expect(day.webActivityMinutes).toBe(10);
    expect(day.otherRabbitholeMinutes).toBe(5);
    expect(day.outsideSchool).toEqual({ measuredMinutes: 0, estimatedMinutes: 0, foregroundMinutes: 0 });
  });

  test("a reply ends at its last stream activity, tool rows don't stretch it, and laptop time stays out of the rest", async () => {
    const { t, institutionId, scholarId, asTeacher } = await setUp();
    // 45 minutes of Rabbithole foreground on the iPad, 09:55 to 10:40.
    await insertEvents(
      t,
      scholarId,
      institutionId,
      foregroundStretch(TUESDAY, 9 * 60 + 55, 10 * 60 + 40, "core_day"),
    );
    const sessionId = await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert("sessions", {
        userId: scholarId,
        institutionId,
        title: "Island game",
        isArchived: false,
      });
      const artifactId = await ctx.db.insert("artifacts", {
        sessionId,
        title: "Island",
        content: "<canvas></canvas>",
        lastEditedBy: "ai",
        type: "code",
        language: "html",
      });
      // On the iPad 10:00 to 10:30, then on a laptop 10:45 to 10:55, after
      // the iPad went to the background at 10:40.
      for (const [surface, from, to] of [
        ["native", 10 * 60, 10 * 60 + 30],
        ["web", 10 * 60 + 45, 10 * 60 + 55],
      ] as const) {
        await ctx.db.insert("appPlaySessions", {
          userId: scholarId,
          institutionId,
          sessionId,
          artifactId,
          surface,
          startedAt: local(TUESDAY, from),
          lastActiveAt: local(TUESDAY, to),
          endedAt: local(TUESDAY, to),
          resumes: 0,
        });
      }
      return sessionId;
    });
    const rows: {
      role: "user" | "assistant" | "tool";
      at: number;
      lastStreamActivityAt?: number;
    }[] = [
      // Ask at 10:05; the reply row is created at 10:05:10 and streams
      // until 10:07, so the window is 10:04 to 10:08 (4 min).
      { role: "user", at: local(TUESDAY, 10 * 60 + 5) },
      {
        role: "assistant",
        at: local(TUESDAY, 10 * 60 + 5) + 10_000,
        lastStreamActivityAt: local(TUESDAY, 10 * 60 + 7),
      },
      // A tool row at 10:09 is not read, so it can't stretch the window.
      { role: "tool", at: local(TUESDAY, 10 * 60 + 9) },
    ];
    for (const row of rows) {
      vi.setSystemTime(row.at);
      await t.run((ctx) =>
        ctx.db.insert("messages", {
          sessionId,
          role: row.role,
          content: "fixture",
          flagged: false,
          ...(row.lastStreamActivityAt
            ? { lastStreamActivityAt: row.lastStreamActivityAt }
            : {}),
        }),
      );
    }
    vi.setSystemTime(SCHOOL_DAY_0930);

    const [day] = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: TUESDAY,
    });
    expect(day.builder).toEqual({ onScreenMinutes: 40, activeMinutes: 4 });
    // Only the iPad's 30 builder minutes overlap its 45 foreground minutes.
    expect(day.otherRabbitholeMinutes).toBe(15);
  });

  test("a launched app that crosses the bell is split at the bell", async () => {
    const { t, institutionId, scholarId, asTeacher, spikeId } = await setUp();
    // Foreground 14:40, an app launched at 14:50 and returned at 17:00, then
    // a minute of Rabbithole. The default school day ends at 15:00.
    await insertEvents(t, scholarId, institutionId, [
      ...foregroundStretch(TUESDAY, 14 * 60 + 40, 14 * 60 + 50, "core_day").slice(0, -1),
      {
        kind: "external_launch",
        clientAt: local(TUESDAY, 14 * 60 + 50),
        context: "core_day",
        externalAppId: spikeId,
      },
      {
        kind: "external_return",
        clientAt: local(TUESDAY, 17 * 60),
        context: "unknown",
        externalAppId: spikeId,
      },
      { kind: "app_background", clientAt: local(TUESDAY, 17 * 60 + 1), context: "unknown" },
    ]);
    const [day] = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: TUESDAY,
    });
    // 10 + 130 + 1 measured; 120 of the app and the last minute are after 15:00.
    expect(day.measuredMinutes).toBe(141);
    // Only the last minute is Rabbithole itself; the 120 are the launched app.
    expect(day.outsideSchool).toEqual({
      measuredMinutes: 121,
      estimatedMinutes: 0,
      foregroundMinutes: 1,
    });
  });

  test("web or builder time that overlaps no iPad foreground takes nothing from the rest", async () => {
    const { t, institutionId, scholarId, asTeacher, epicId } = await setUp();
    // 45 iPad minutes, 09:55 to 10:40; a 40-minute web activity on a laptop
    // that evening overlaps none of it.
    await insertEvents(
      t,
      scholarId,
      institutionId,
      foregroundStretch(TUESDAY, 9 * 60 + 55, 10 * 60 + 40, "core_day"),
    );
    await seedWebSession(t, scholarId, epicId, local(TUESDAY, 19 * 60), local(TUESDAY, 19 * 60 + 40));
    const [day] = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: TUESDAY,
    });
    expect(day.webActivityMinutes).toBe(40);
    expect(day.otherRabbitholeMinutes).toBe(45);
  });

  test("the day timeline types each stretch by overlap, timings only", async () => {
    const { t, institutionId, scholarId, asTeacher, spikeId } = await setUp();
    // convex-test keeps _creationTime ascending from the fixture clock
    // (09:30), so the scenario runs after it.
    // Rabbithole on screen 10:00 to 10:40, LEGO SPIKE 10:40 to 10:50, then
    // Rabbithole again until 10:55.
    await insertEvents(t, scholarId, institutionId, [
      ...foregroundStretch(TUESDAY, 10 * 60, 10 * 60 + 40, "core_day").slice(0, -1),
      {
        kind: "external_launch",
        clientAt: local(TUESDAY, 10 * 60 + 40),
        context: "core_day",
        externalAppId: spikeId,
      },
      {
        kind: "external_return",
        clientAt: local(TUESDAY, 10 * 60 + 50),
        context: "core_day",
        externalAppId: spikeId,
      },
      ...foregroundStretch(TUESDAY, 10 * 60 + 51, 10 * 60 + 55, "core_day"),
    ]);
    const tutorSessionId = await t.run((ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        institutionId,
        title: "Fractions chat",
        isArchived: false,
        lastMessageAt: local(TUESDAY, 10 * 60 + 11),
      }),
    );
    // A tutor turn at 10:10, answered at 10:10:30 → chat 10:09 to 10:11:30.
    for (const [role, at] of [
      ["user", local(TUESDAY, 10 * 60 + 10)],
      ["assistant", local(TUESDAY, 10 * 60 + 10) + 30_000],
    ] as const) {
      vi.setSystemTime(at);
      await t.run((ctx) =>
        ctx.db.insert("messages", {
          sessionId: tutorSessionId,
          role,
          content: "fixture",
          flagged: false,
        }),
      );
    }
    vi.setSystemTime(SCHOOL_DAY_0930);
    // Two practice items answered at 10:30 and 10:31, a minute on each →
    // practice 10:29 to 10:31:30.
    await t.run(async (ctx) => {
      for (const minute of [30, 31]) {
        await ctx.db.insert("practiceAttempts", {
          scholarId,
          nodeKey: "nbt-place-value",
          correct: true,
          elapsedMs: MINUTE,
          createdAt: local(TUESDAY, 10 * 60 + minute),
        });
      }
    });

    const result = await asTeacher.query(api.deviceActivity.dayTimeline, {
      dayKey: TUESDAY,
    });
    expect(result.timeZone).toBe(TIME_ZONE);
    expect(result.scholars).toHaveLength(1);
    const timeline = result.scholars[0].timeline;
    expect(timeline).not.toBeNull();
    const at = (ms: number) => (ms - local(TUESDAY, 10 * 60)) / MINUTE;
    expect(
      timeline!.stretches.map((stretch) => [
        stretch.kind,
        at(stretch.start),
        at(stretch.end),
        stretch.detail ?? null,
      ]),
    ).toEqual([
      ["rabbithole", 0, 9, NO_ACTIVITY_DETAIL],
      // Titles only: the session's title and where it came from.
      ["chat", 9, 11.5, "Fractions chat · self-started"],
      ["rabbithole", 11.5, 29, NO_ACTIVITY_DETAIL],
      // No skill row in this fixture, so the label falls back to its key.
      ["practice", 29, 31.5, "nbt-place-value"],
      ["rabbithole", 31.5, 40, NO_ACTIVITY_DETAIL],
      ["launched_app", 40, 50, "LEGO SPIKE"],
      ["rabbithole", 50, 55, NO_ACTIVITY_DETAIL],
    ]);
    expect(timeline!.totalMinutes).toBe(55);
    expect(timeline!.minutesByKind).toMatchObject({
      chat: 2.5,
      practice: 2.5,
      launched_app: 10,
    });
    expect(timeline!.schoolHours).toHaveLength(1);
    // Nothing but timings leaves the query.
    expect(JSON.stringify(result)).not.toContain("fixture");
  });

  test("a web stretch never names another school's activity, class or teacher", async () => {
    const { t, institutionId, otherInstitutionId, scholarId, asTeacher, epicId } =
      await setUp();
    await insertEvents(
      t,
      scholarId,
      institutionId,
      foregroundStretch(TUESDAY, 10 * 60, 10 * 60 + 30, "core_day"),
    );
    const otherTeacherId = await seedUser(t, "teacher", otherInstitutionId);
    const { otherActivityId, otherAssignmentId } = await t.run(async (ctx) => {
      const unitId = await ctx.db.insert("units", {
        teacherId: otherTeacherId,
        institutionId: otherInstitutionId,
        title: "Other school unit",
        isActive: true,
      });
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: "Other school lesson",
        order: 0,
      });
      const otherActivityId = await ctx.db.insert("activities", {
        lessonId,
        title: "Other school reading",
        kind: "online",
        systemPrompt: "...",
        order: 0,
      });
      const otherAssignmentId = await ctx.db.insert("assignments", {
        teacherId: otherTeacherId,
        unitId,
        scholarIds: [scholarId],
        startedAt: local(TUESDAY, 8 * 60),
      });
      return { otherActivityId, otherAssignmentId };
    });
    await t.run((ctx) =>
      ctx.db.insert("webActivitySessions", {
        scholarId,
        appId: epicId,
        activityId: otherActivityId,
        assignmentId: otherAssignmentId,
        startedAt: local(TUESDAY, 10 * 60 + 5),
        endedAt: local(TUESDAY, 10 * 60 + 15),
        lastHeartbeatAt: local(TUESDAY, 10 * 60 + 15),
        screenshotIds: [],
      }),
    );

    const result = await asTeacher.query(api.deviceActivity.dayTimeline, {
      dayKey: TUESDAY,
    });
    const web = result.scholars[0].timeline!.stretches.find(
      (stretch) => stretch.kind === "web",
    );
    expect(web?.detail).toBe("Epic");
    expect(JSON.stringify(result)).not.toContain("Other school");
  });

  test("a timeline is one day at a time", async () => {
    const { t, scholarId } = await setUp();
    await expect(
      t.run((ctx) =>
        readScholarDayUsage(
          ctx,
          {
            institutionIds: [],
            scholarIds: [scholarId],
            roster: async () => [],
            scholarAllowed: () => true,
            playInstitutionAllowed: () => true,
            primaryInstitutionId: undefined,
            fallbackInstitutionId: undefined,
          },
          TUESDAY,
          WEDNESDAY,
          { timeline: true },
        ),
      ),
    ).rejects.toThrow("one day at a time");
  });

  test("a web-only day is a row, and another school's scholar never appears", async () => {
    const { t, institutionId, otherInstitutionId, asTeacher, epicId } = await setUp();
    const webOnlyScholarId = await seedUser(t, "scholar", institutionId);
    const otherSchoolScholarId = await seedUser(t, "scholar", otherInstitutionId);
    await seedWebSession(
      t,
      webOnlyScholarId,
      epicId,
      local(WEDNESDAY, 13 * 60),
      local(WEDNESDAY, 13 * 60 + 20),
    );
    await seedWebSession(
      t,
      otherSchoolScholarId,
      epicId,
      local(WEDNESDAY, 13 * 60),
      local(WEDNESDAY, 13 * 60 + 20),
    );

    const rows = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: WEDNESDAY,
    });
    expect(rows.map((row) => row.scholarId)).not.toContain(otherSchoolScholarId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scholarId: webOnlyScholarId,
      dayKey: WEDNESDAY,
      foregroundMinutes: 0,
      measuredMinutes: 0,
      estimatedMinutes: 0,
      eventCount: 0,
      byContext: {},
      apps: [],
      outsideSchool: { measuredMinutes: 0, estimatedMinutes: 0, foregroundMinutes: 0 },
      builder: { onScreenMinutes: 0, activeMinutes: 0 },
      webActivityMinutes: 20,
      otherRabbitholeMinutes: 0,
    });
  });

  test("one scholar reads their own index and still honors the lens", async () => {
    const { t, institutionId, otherInstitutionId, scholarId, asTeacher, epicId } =
      await setUp();
    const classmateId = await seedUser(t, "scholar", institutionId);
    await insertEvents(
      t,
      scholarId,
      institutionId,
      foregroundStretch(TUESDAY, 9 * 60 + 30, 9 * 60 + 40, "core_day"),
    );
    await insertEvents(
      t,
      classmateId,
      institutionId,
      foregroundStretch(TUESDAY, 9 * 60 + 30, 9 * 60 + 50, "core_day"),
    );
    // The same scholar's rows stamped with another school, or with no school,
    // are outside this lens and must not add minutes.
    await insertEvents(
      t,
      scholarId,
      otherInstitutionId,
      foregroundStretch(TUESDAY, 11 * 60, 11 * 60 + 5, "core_day"),
    );
    await insertEvents(
      t,
      scholarId,
      undefined,
      foregroundStretch(TUESDAY, 12 * 60, 12 * 60 + 5, "core_day"),
    );
    await seedWebSession(
      t,
      scholarId,
      epicId,
      local(WEDNESDAY, 13 * 60),
      local(WEDNESDAY, 13 * 60 + 15),
    );

    const range = { startDayKey: TUESDAY, endDayKey: WEDNESDAY };
    const everyone = await asTeacher.query(api.deviceActivity.dailyUsage, range);
    const narrowed = await asTeacher.query(api.deviceActivity.dailyUsage, {
      ...range,
      scholarId,
    });
    expect(narrowed.map((row) => [row.scholarId, row.dayKey])).toEqual([
      [scholarId, TUESDAY],
      [scholarId, WEDNESDAY],
    ]);
    expect(narrowed[0].foregroundMinutes).toBe(10);
    expect(narrowed[1].webActivityMinutes).toBe(15);
    // The one-scholar read agrees with the schoolwide one, row for row.
    expect(narrowed).toEqual(everyone.filter((row) => row.scholarId === scholarId));
    expect(everyone.map((row) => row.scholarId)).toContain(classmateId);
  });

  test("an unstamped app play is the primary school's, even after the scholar transfers (TRA-637)", async () => {
    const { t, institutionId: newSchoolId, asTeacher } = await setUp();
    const primaryId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "home",
        slug: "home",
        kind: "school",
        timeZone: TIME_ZONE,
        isPrimary: true,
      }),
    );
    const primaryTeacherId = await seedUser(t, "teacher", primaryId);
    await grantMembership(t, primaryTeacherId, "teacher", primaryId);
    const asPrimaryTeacher = await asUser(t, primaryTeacherId);

    /** iPad foreground stamped with the scholar's school, plus one unstamped
     * (legacy) app on screen 10:00 to 10:30. */
    async function seedUnstampedPlay(
      scholarId: Id<"users">,
      deviceInstitutionId: Id<"institutions">,
    ) {
      await insertEvents(
        t,
        scholarId,
        deviceInstitutionId,
        foregroundStretch(TUESDAY, 9 * 60 + 55, 10 * 60 + 40, "core_day"),
      );
      await t.run(async (ctx) => {
        const sessionId = await ctx.db.insert("sessions", {
          userId: scholarId,
          title: "Legacy builder",
          isArchived: false,
        });
        const artifactId = await ctx.db.insert("artifacts", {
          sessionId,
          title: "Legacy",
          content: "<canvas></canvas>",
          lastEditedBy: "ai",
          type: "code",
          language: "html",
        });
        await ctx.db.insert("appPlaySessions", {
          userId: scholarId,
          sessionId,
          artifactId,
          surface: "native",
          startedAt: local(TUESDAY, 10 * 60),
          lastActiveAt: local(TUESDAY, 10 * 60 + 30),
          endedAt: local(TUESDAY, 10 * 60 + 30),
          resumes: 0,
        });
      });
    }

    // A scholar who moved from the primary school to the new school: the
    // new school sees their iPad time but not the primary school's app play.
    const transferredId = await seedUser(t, "scholar", newSchoolId);
    await seedUnstampedPlay(transferredId, newSchoolId);
    const newSchoolRows = await asTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: TUESDAY,
      scholarId: transferredId,
    });
    expect(newSchoolRows).toHaveLength(1);
    expect(newSchoolRows[0].foregroundMinutes).toBe(45);
    expect(newSchoolRows[0].builder).toEqual({ onScreenMinutes: 0, activeMinutes: 0 });

    // A scholar still at the primary school keeps the same play, on the
    // School › Screen time page and in the Friday recap's scope alike.
    const stayedId = await seedUser(t, "scholar", primaryId);
    await seedUnstampedPlay(stayedId, primaryId);
    const primaryRows = await asPrimaryTeacher.query(api.deviceActivity.dailyUsage, {
      startDayKey: TUESDAY,
      endDayKey: TUESDAY,
      scholarId: stayedId,
    });
    expect(primaryRows).toHaveLength(1);
    expect(primaryRows[0].builder.onScreenMinutes).toBe(30);

    const recapScope = (schoolId: Id<"institutions">, scholarId: Id<"users">) => ({
      institutionIds: [schoolId],
      scholarIds: [scholarId],
      roster: async () => [scholarId],
      scholarAllowed: () => true,
      playInstitutionAllowed: (id: Id<"institutions">) => id === schoolId,
      primaryInstitutionId: primaryId,
      fallbackInstitutionId: schoolId,
    });
    const recapRows = await t.run(async (ctx) => ({
      primary: await readScholarDayUsage(ctx, recapScope(primaryId, stayedId), TUESDAY, TUESDAY),
      newSchool: await readScholarDayUsage(
        ctx,
        recapScope(newSchoolId, transferredId),
        TUESDAY,
        TUESDAY,
      ),
    }));
    expect(recapRows.primary[0].builder.onScreenMinutes).toBe(30);
    expect(recapRows.newSchool[0].builder.onScreenMinutes).toBe(0);
  });
});

describe("deviceActivityEvents kind vocabulary", () => {
  test("schema.ts's inline union matches the record path's shared validator", async () => {
    const { deviceActivityKindValidator } = await import(
      "../lib/deviceActivityValidators"
    );
    const literals = (union: { members: { value: unknown }[] }) =>
      union.members.map((member) => member.value).sort();
    const schemaKind = (
      schema.tables.deviceActivityEvents.validator as unknown as {
        fields: { kind: { members: { value: unknown }[] } };
      }
    ).fields.kind;
    expect(literals(schemaKind)).toEqual(
      literals(deviceActivityKindValidator),
    );
  });
});
