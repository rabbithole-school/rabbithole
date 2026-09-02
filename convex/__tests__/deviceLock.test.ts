import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import {
  applyCommandToRows,
  resolveManagedSerialsForRows,
} from "../deviceLock";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TestHarness = ReturnType<typeof convexTest>;
type StaffRole = "teacher" | "staff" | "school_admin";

async function seedInstitution(
  t: TestHarness,
  slug: string,
  timeZone = "Pacific/Honolulu",
) {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: slug,
      slug,
      kind: "school" as const,
      timeZone,
    }),
  );
}

async function seedUser(
  t: TestHarness,
  role: StaffRole | "scholar",
  institutionId?: Id<"institutions">,
  name = `Test ${role}`,
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username: name.toLowerCase().replaceAll(" ", "-"),
      role,
      ...(role === "scholar" && institutionId ? { institutionId } : {}),
    }),
  );
  if (role !== "scholar" && institutionId) {
    await t.run((ctx) =>
      ctx.db.insert("memberships", { userId, role, institutionId }),
    );
  }
  return userId;
}

async function newSession(t: TestHarness, userId: Id<"users">) {
  return await t.run((ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    };
    return ctx.db.insert("authSessions", session);
  });
}

async function withUser(t: TestHarness, userId: Id<"users">) {
  const sessionId = await newSession(t, userId);
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedDevice(
  t: TestHarness,
  institutionId: Id<"institutions">,
  scholarId: Id<"users">,
  pairedBy: Id<"users">,
  deviceId: string,
) {
  return await t.run((ctx) =>
    ctx.db.insert("pairedDevices", {
      deviceId,
      deviceLabel: `iPad ${deviceId}`,
      scholarId,
      institutionId,
      pairedAt: Date.now(),
      pairedBy,
    }),
  );
}

async function seedManagedClaim(
  t: TestHarness,
  institutionId: Id<"institutions">,
  createdBy: Id<"users">,
  serial: string,
  lastDeviceId: string,
) {
  const now = Date.now();
  return await t.run((ctx) =>
    ctx.db.insert("managedDeviceClaims", {
      institutionId,
      serial,
      claimState: "claimed",
      createdBy,
      createdAt: now,
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: 0,
      claimCount: 1,
      lastDeviceId,
    }),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Rabbithole Lock state", () => {
  test("paired devices default to armed and unknown device ids fail closed", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId, "Kai");
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-default",
    );

    expect(
      await t.query(api.deviceLock.stateForDevice, {
        deviceId: "not-a-paired-device",
      }),
    ).toBeNull();
    expect(
      await t.query(api.deviceLock.stateForDevice, {
        deviceId: "ipad-default",
      }),
    ).toMatchObject({
      pairedDeviceId,
      desiredState: "armed",
    });
  });

  test("staff can control only devices in their active institution", async () => {
    const t = convexTest(schema, modules);
    const institutionA = await seedInstitution(t, "school-a");
    const institutionB = await seedInstitution(t, "school-b");
    const teacherA = await seedUser(t, "teacher", institutionA);
    const teacherB = await seedUser(t, "teacher", institutionB);
    const scholarA = await seedUser(t, "scholar", institutionA, "Scholar A");
    const scholarB = await seedUser(t, "scholar", institutionB, "Scholar B");
    const deviceA = await seedDevice(
      t,
      institutionA,
      scholarA,
      teacherA,
      "ipad-a",
    );
    const deviceB = await seedDevice(
      t,
      institutionB,
      scholarB,
      teacherB,
      "ipad-b",
    );
    const asTeacherA = await withUser(t, teacherA);

    await expect(
      asTeacherA.query(api.deviceLock.getDeviceSettings, {
        pairedDeviceId: deviceB,
      }),
    ).rejects.toThrow();
    await expect(
      asTeacherA.mutation(api.deviceLock.setRabbitholeLock, {
        pairedDeviceId: deviceB,
        state: "disarmed",
        disarmMode: "until_further_notice",
      }),
    ).rejects.toThrow();

    await asTeacherA.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId: deviceA,
      state: "disarmed",
      disarmMode: "until_further_notice",
    });
    expect(await t.run((ctx) => ctx.db.get(deviceA))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "until_further_notice",
    });
    expect((await t.run((ctx) => ctx.db.get(deviceB)))?.rabbitholeLockDesiredState)
      .toBeUndefined();
  });

  test("until-midnight uses the device school's timezone and schedules re-arm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T20:00:00.000Z"));

    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(
      t,
      "moli",
      "Pacific/Honolulu",
    );
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const deviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-midnight",
    );

    await (await withUser(t, teacherId)).mutation(
      api.deviceLock.setRabbitholeLock,
      {
        pairedDeviceId: deviceId,
        state: "disarmed",
        disarmMode: "until_midnight",
      },
    );

    const expectedMidnight = Date.parse("2026-08-21T10:00:00.000Z");
    const row = await t.run((ctx) => ctx.db.get(deviceId));
    expect(row).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "until_midnight",
      rabbitholeLockDisarmExpiresAt: expectedMidnight,
    });
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("deviceLock:rearmAtMidnight");
    expect(jobs[0].args[0]).toMatchObject({
      pairedDeviceId: deviceId,
      expectedUpdatedAt: row!.rabbitholeLockUpdatedAt,
    });
  });

  test("stale acknowledgements are rejected and current iOS truth is recorded", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-ack",
    );
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "until_further_notice",
    });
    const desiredUpdatedAt = (
      await t.run((ctx) => ctx.db.get(pairedDeviceId))
    )!.rabbitholeLockUpdatedAt!;
    const asScholar = await withUser(t, scholarId);

    expect(
      await asScholar.mutation(api.deviceLock.reportAppliedState, {
        deviceId: "ipad-ack",
        desiredUpdatedAt: desiredUpdatedAt - 1,
        desiredState: "disarmed",
        inSingleAppMode: false,
      }),
    ).toEqual({ accepted: false });
    expect(
      await asScholar.mutation(api.deviceLock.reportAppliedState, {
        deviceId: "ipad-ack",
        desiredUpdatedAt,
        desiredState: "disarmed",
        inSingleAppMode: false,
      }),
    ).toEqual({ accepted: true });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockAppliedDesiredState: "disarmed",
      rabbitholeLockInSingleAppMode: false,
    });
  });

  test("one-time disarm is consumed once and stale consumers cannot re-arm a newer command", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-once",
    );
    await (await withUser(t, teacherId)).mutation(
      api.deviceLock.setRabbitholeLock,
      {
        pairedDeviceId,
        state: "disarmed",
        disarmMode: "one_time",
      },
    );
    const desiredUpdatedAt = (
      await t.run((ctx) => ctx.db.get(pairedDeviceId))
    )!.rabbitholeLockUpdatedAt!;

    expect(
      await t.mutation(api.deviceLock.consumeOneTimeDisarm, {
        deviceId: "ipad-once",
        expectedUpdatedAt: desiredUpdatedAt - 1,
      }),
    ).toEqual({ rearmed: false });
    expect(
      await t.mutation(api.deviceLock.consumeOneTimeDisarm, {
        deviceId: "ipad-once",
        expectedUpdatedAt: desiredUpdatedAt,
      }),
    ).toEqual({ rearmed: true });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "armed",
    });
  });
});

describe("Rabbithole Lock timed disarm", () => {
  test("sets state + expiry and schedules a timed re-arm job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T20:00:00.000Z"));

    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );

    await (await withUser(t, teacherId)).mutation(
      api.deviceLock.setRabbitholeLock,
      {
        pairedDeviceId,
        state: "disarmed",
        disarmMode: "timed",
        disarmMinutes: 90,
      },
    );

    const expectedExpiry = Date.parse("2026-08-20T21:30:00.000Z");
    const row = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    expect(row).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "timed",
      rabbitholeLockDisarmExpiresAt: expectedExpiry,
    });
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toContain("deviceLock:rearmTimed");
    expect(jobs[0].args[0]).toMatchObject({
      pairedDeviceId,
      expectedUpdatedAt: row!.rabbitholeLockUpdatedAt,
    });
  });

  test("extending the window moves the revision + expiry, and only the newest scheduled job re-arms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T20:00:00.000Z"));

    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );
    const asTeacher = await withUser(t, teacherId);

    // First timed disarm: 30 minutes from 20:00.
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 30,
    });
    const firstRow = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    const firstExpectedUpdatedAt = firstRow!.rabbitholeLockUpdatedAt!;
    const firstExpiresAt = firstRow!.rabbitholeLockDisarmExpiresAt!;
    expect(firstExpiresAt).toBe(Date.parse("2026-08-20T20:30:00.000Z"));

    // 5 minutes later, staff extends the window to 90 minutes from NOW —
    // this is the mid-flight "one more period" case, not a fresh disarm.
    vi.setSystemTime(new Date("2026-08-20T20:05:00.000Z"));
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 90,
    });
    const secondRow = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    const secondExpectedUpdatedAt = secondRow!.rabbitholeLockUpdatedAt!;
    const secondExpiresAt = secondRow!.rabbitholeLockDisarmExpiresAt!;

    // The revision and the deadline both moved forward with the extension.
    expect(secondExpectedUpdatedAt).toBeGreaterThan(firstExpectedUpdatedAt);
    expect(secondExpiresAt).toBe(Date.parse("2026-08-20T21:35:00.000Z"));
    expect(secondExpiresAt).not.toBe(firstExpiresAt);

    // Two re-arm jobs are now scheduled — one stale (from the first disarm),
    // one current (from the extension).
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toHaveLength(2);

    // The FIRST job's original 30-minute deadline arrives first and fires —
    // but its expectedUpdatedAt is now stale, so it must no-op rather than
    // re-arming an iPad staff just extended.
    expect(
      await t.mutation(internal.deviceLock.rearmTimed, {
        pairedDeviceId,
        expectedUpdatedAt: firstExpectedUpdatedAt,
      }),
    ).toEqual({ rearmed: false });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "timed",
      rabbitholeLockDisarmExpiresAt: secondExpiresAt,
    });

    // The SECOND job — the one matching the extension staff actually asked
    // for — re-arms normally when its own deadline arrives.
    expect(
      await t.mutation(internal.deviceLock.rearmTimed, {
        pairedDeviceId,
        expectedUpdatedAt: secondExpectedUpdatedAt,
      }),
    ).toEqual({ rearmed: true });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "armed",
    });
  });

  test("the re-arm job re-arms once its expected revision is still current", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );
    await (await withUser(t, teacherId)).mutation(
      api.deviceLock.setRabbitholeLock,
      {
        pairedDeviceId,
        state: "disarmed",
        disarmMode: "timed",
        disarmMinutes: 30,
      },
    );
    const expectedUpdatedAt = (
      await t.run((ctx) => ctx.db.get(pairedDeviceId))
    )!.rabbitholeLockUpdatedAt!;

    expect(
      await t.mutation(internal.deviceLock.rearmTimed, {
        pairedDeviceId,
        expectedUpdatedAt,
      }),
    ).toEqual({ rearmed: true });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "armed",
    });
  });

  test("the re-arm job is a no-op if staff already re-armed in the meantime", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 30,
    });
    const staleExpectedUpdatedAt = (
      await t.run((ctx) => ctx.db.get(pairedDeviceId))
    )!.rabbitholeLockUpdatedAt!;
    // Staff re-arms before the scheduled job fires.
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "armed",
    });

    expect(
      await t.mutation(internal.deviceLock.rearmTimed, {
        pairedDeviceId,
        expectedUpdatedAt: staleExpectedUpdatedAt,
      }),
    ).toEqual({ rearmed: false });
    // Still armed via the staff action, not double-processed.
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "armed",
    });
  });

  test("the re-arm job is a no-op if staff switched to a different disarm mode in the meantime", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 30,
    });
    const staleExpectedUpdatedAt = (
      await t.run((ctx) => ctx.db.get(pairedDeviceId))
    )!.rabbitholeLockUpdatedAt!;
    // Staff switches to "until further notice" before the timed job fires.
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "until_further_notice",
    });

    expect(
      await t.mutation(internal.deviceLock.rearmTimed, {
        pairedDeviceId,
        expectedUpdatedAt: staleExpectedUpdatedAt,
      }),
    ).toEqual({ rearmed: false });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "until_further_notice",
    });
  });

  test("rejects out-of-range or missing disarmMinutes before writing anything", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );
    const asTeacher = await withUser(t, teacherId);

    for (const disarmMinutes of [undefined, 4, 481, 30.5]) {
      await expect(
        asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
          pairedDeviceId,
          state: "disarmed",
          disarmMode: "timed",
          disarmMinutes,
        }),
      ).rejects.toThrow();
    }
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
  });

  test("applyCommandToRows itself rejects a timed command with no minutes (the internal backstop, bypassing setRabbitholeLock/setFromSlack's own validation)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );

    await expect(
      t.run(async (ctx) => {
        const row = await ctx.db.get(pairedDeviceId);
        return applyCommandToRows(
          ctx,
          [row!],
          teacherId,
          // disarmMinutes deliberately omitted — this is the "future caller
          // forgot validation" case the backstop exists to catch.
          { state: "disarmed", disarmMode: "timed" },
          "web",
        );
      }),
    ).rejects.toThrow();

    // No row was touched: the backstop throws before any db.patch/scheduler
    // call, same as the outer setRabbitholeLock/setFromSlack validation does.
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
    expect(
      await t.run((ctx) =>
        ctx.db.system.query("_scheduled_functions").collect(),
      ),
    ).toHaveLength(0);
  });

  test("accepts the boundary minutes (5 and 480)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );
    const asTeacher = await withUser(t, teacherId);

    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 5,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDisarmMode,
    ).toBe("timed");

    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "armed",
    });
    await asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
      pairedDeviceId,
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 480,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDisarmMode,
    ).toBe("timed");
  });

  test("the Slack path sets a timed disarm and reports the minutes", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );

    const result = await t.mutation(internal.deviceLock.setFromSlack, {
      callerUserId: teacherId,
      pairedDeviceIds: [pairedDeviceId],
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 45,
    });
    expect(result).toMatchObject({ ok: true, changedCount: 1 });
    if (result.ok) {
      expect(result.message).toContain("45 minutes");
    }
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "timed",
    });
  });

  test("the Slack path also rejects out-of-range disarmMinutes", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );

    await expect(
      t.mutation(internal.deviceLock.setFromSlack, {
        callerUserId: teacherId,
        pairedDeviceIds: [pairedDeviceId],
        state: "disarmed",
        disarmMode: "timed",
        disarmMinutes: 9000,
      }),
    ).rejects.toThrow();
    expect(
      (await t.run((ctx) => ctx.db.get(pairedDeviceId)))
        ?.rabbitholeLockDesiredState,
    ).toBeUndefined();
  });

  // Belt-and-suspenders for the native side: useAsamController.ts derives its
  // DeviceLockState type FROM this query's generated return type rather than
  // hand-rolling it, so a TypeScript signature change already fails a native
  // typecheck. This pins the runtime CONTENT of that same payload — both
  // fields the native status copy (asamDecision.ts's selectAsamLockStatus)
  // actually reads for "timed" — so a regression is caught here too even in
  // an environment where the native toolchain can't be exercised directly.
  test("stateForDevice's device-facing payload carries both disarmMode and disarmExpiresAt for a timed disarm", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      "ipad-timed",
    );

    await (await withUser(t, teacherId)).mutation(
      api.deviceLock.setRabbitholeLock,
      {
        pairedDeviceId,
        state: "disarmed",
        disarmMode: "timed",
        disarmMinutes: 45,
      },
    );

    const row = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    const devicePayload = await t.query(api.deviceLock.stateForDevice, {
      deviceId: "ipad-timed",
    });
    expect(devicePayload).toMatchObject({
      pairedDeviceId,
      desiredState: "disarmed",
      disarmMode: "timed",
      disarmExpiresAt: row!.rabbitholeLockDisarmExpiresAt,
    });
    expect(devicePayload?.disarmExpiresAt).toEqual(expect.any(Number));
  });
});

describe("Rabbithole Lock Slack boundary", () => {
  test("indexes claims once per institution and preserves first-match serial resolution", async () => {
    const institutionA = "institutions:a" as Id<"institutions">;
    const institutionB = "institutions:b" as Id<"institutions">;
    const rows = [
      {
        _id: "pairedDevices:a-1" as Id<"pairedDevices">,
        institutionId: institutionA,
        deviceId: "ipad-a-1",
      },
      {
        _id: "pairedDevices:a-2" as Id<"pairedDevices">,
        institutionId: institutionA,
        deviceId: "ipad-a-2",
      },
      {
        _id: "pairedDevices:a-missing" as Id<"pairedDevices">,
        institutionId: institutionA,
        deviceId: "ipad-a-missing",
      },
      {
        _id: "pairedDevices:b-1" as Id<"pairedDevices">,
        institutionId: institutionB,
        deviceId: "ipad-b-1",
      },
    ];
    const loadClaimsForInstitution = vi.fn(async (institutionId: Id<"institutions">) =>
      institutionId === institutionA
        ? [
            { serial: "SERIAL-A-1", lastDeviceId: "ipad-a-1" },
            { serial: "SERIAL-A-1-DUPLICATE", lastDeviceId: "ipad-a-1" },
            { serial: "SERIAL-A-2", lastDeviceId: "ipad-a-2" },
          ]
        : [{ serial: "SERIAL-B-1", lastDeviceId: "ipad-b-1" }],
    );

    const serials = await resolveManagedSerialsForRows(
      rows,
      loadClaimsForInstitution,
    );

    expect(loadClaimsForInstitution).toHaveBeenCalledTimes(2);
    expect(loadClaimsForInstitution).toHaveBeenCalledWith(institutionA);
    expect(loadClaimsForInstitution).toHaveBeenCalledWith(institutionB);
    expect([...serials.entries()]).toEqual([
      [rows[0]._id, "SERIAL-A-1"],
      [rows[1]._id, "SERIAL-A-2"],
      [rows[2]._id, null],
      [rows[3]._id, "SERIAL-B-1"],
    ]);
  });

  test("lists correct serial payloads for devices across accessible institutions", async () => {
    const t = convexTest(schema, modules);
    const institutionA = await seedInstitution(t, "school-a");
    const institutionB = await seedInstitution(t, "school-b");
    const teacherId = await seedUser(t, "teacher", institutionA, "Lehua");
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        userId: teacherId,
        role: "teacher",
        institutionId: institutionB,
      }),
    );
    const scholarA1 = await seedUser(t, "scholar", institutionA, "Kai");
    const scholarA2 = await seedUser(t, "scholar", institutionA, "Lani");
    const scholarB = await seedUser(t, "scholar", institutionB, "Hoku");
    const deviceA1 = await seedDevice(
      t,
      institutionA,
      scholarA1,
      teacherId,
      "ipad-a-1",
    );
    const deviceA2 = await seedDevice(
      t,
      institutionA,
      scholarA2,
      teacherId,
      "ipad-a-2",
    );
    const deviceB = await seedDevice(
      t,
      institutionB,
      scholarB,
      teacherId,
      "ipad-b-1",
    );
    await Promise.all([
      seedManagedClaim(t, institutionA, teacherId, "SERIAL-A-1", "ipad-a-1"),
      seedManagedClaim(t, institutionA, teacherId, "SERIAL-A-2", "ipad-a-2"),
      seedManagedClaim(t, institutionB, teacherId, "SERIAL-B-1", "ipad-b-1"),
    ]);

    const listed = await t.query(internal.deviceLock.listForSlack, {
      callerUserId: teacherId,
    });

    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) {
      expect(
        new Map(
          listed.devices.map((device) => [
            device.pairedDeviceId,
            device.serial,
          ]),
        ),
      ).toEqual(
        new Map([
          [deviceA1, "SERIAL-A-1"],
          [deviceA2, "SERIAL-A-2"],
          [deviceB, "SERIAL-B-1"],
        ]),
      );
    }
  });

  test("lists and atomically updates multiple same-school devices", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const kai = await seedUser(t, "scholar", institutionId, "Kai");
    const lani = await seedUser(t, "scholar", institutionId, "Lani");
    const first = await seedDevice(
      t,
      institutionId,
      kai,
      teacherId,
      "ipad-kai",
    );
    const second = await seedDevice(
      t,
      institutionId,
      lani,
      teacherId,
      "ipad-lani",
    );

    const listed = await t.query(internal.deviceLock.listForSlack, {
      callerUserId: teacherId,
      search: "Kai",
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.devices.map((device) => device.pairedDeviceId)).toEqual([
        first,
      ]);
    }

    const updated = await t.mutation(internal.deviceLock.setFromSlack, {
      callerUserId: teacherId,
      pairedDeviceIds: [first, second],
      state: "disarmed",
      disarmMode: "until_further_notice",
    });
    expect(updated).toMatchObject({ ok: true, changedCount: 2 });
    const devices = await t.run((ctx) =>
      ctx.db.query("pairedDevices").collect(),
    );
    expect(
      devices.every(
        (device) =>
          device.rabbitholeLockDesiredState === "disarmed" &&
          device.rabbitholeLockDisarmMode === "until_further_notice",
      ),
    ).toBe(true);
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((query) =>
          query.eq(query.field("action"), "device.rabbithole-lock.disarm"),
        )
        .collect(),
    );
    expect(audits).toHaveLength(2);
  });

  test("rejects a mixed-tenant batch before changing any device", async () => {
    const t = convexTest(schema, modules);
    const institutionA = await seedInstitution(t, "school-a");
    const institutionB = await seedInstitution(t, "school-b");
    const teacherA = await seedUser(t, "teacher", institutionA);
    const teacherB = await seedUser(t, "teacher", institutionB);
    const scholarA = await seedUser(t, "scholar", institutionA);
    const scholarB = await seedUser(t, "scholar", institutionB);
    const first = await seedDevice(
      t,
      institutionA,
      scholarA,
      teacherA,
      "ipad-a",
    );
    const second = await seedDevice(
      t,
      institutionB,
      scholarB,
      teacherB,
      "ipad-b",
    );

    const result = await t.mutation(internal.deviceLock.setFromSlack, {
      callerUserId: teacherA,
      pairedDeviceIds: [first, second],
      state: "disarmed",
      disarmMode: "until_midnight",
    });
    expect(result.ok).toBe(false);
    const devices = await t.run((ctx) =>
      ctx.db.query("pairedDevices").collect(),
    );
    expect(
      devices.every(
        (device) => device.rabbitholeLockDesiredState === undefined,
      ),
    ).toBe(true);
  });

  test("listForSlack tags an Extended Education scholar's row (annotate, never filter)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const kai = await seedUser(t, "scholar", institutionId, "Kai");
    const riley = await seedUser(t, "scholar", institutionId, "Riley");
    await t.run((ctx) =>
      ctx.db.patch(riley, { enrollmentStanding: "program_guest" }),
    );
    await seedDevice(t, institutionId, kai, teacherId, "ipad-kai");
    await seedDevice(t, institutionId, riley, teacherId, "ipad-riley");

    const listed = await t.query(internal.deviceLock.listForSlack, {
      callerUserId: teacherId,
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      // Factual inventory: the guest's device is listed, not hidden…
      expect(listed.devices).toHaveLength(2);
      const kaiRow = listed.devices.find((d) => d.scholar === "Kai");
      const rileyRow = listed.devices.find((d) => d.scholar === "Riley");
      // …but carries the Extended Education tag; enrolled rows stay untagged.
      expect(rileyRow).toMatchObject({ extendedEducation: true });
      expect(kaiRow).not.toHaveProperty("extendedEducation");
    }
  });
});
