import { convexTest } from "convex-test";
import { afterAll, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  UNRETURNED_EXTERNAL_LAUNCH_ESTIMATE_MS,
  msToMinutes,
} from "../../shared/deviceActivityRollup";
import {
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
    const { t, teacherId } = await setUp();
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
