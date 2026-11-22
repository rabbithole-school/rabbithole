import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { READ_ONLY_ACCOUNT_ERROR } from "../lib/auth";
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

  test("applyCommandToRows itself rejects a timed command with no minutes (the internal backstop, bypassing setRabbitholeLock/setFromAgent's own validation)", async () => {
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
    // call, same as the outer setRabbitholeLock/setFromAgent validation does.
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

    const result = await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: teacherId,
      source: "slack" as const,
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
      t.mutation(internal.deviceLock.setFromAgent, {
        callerUserId: teacherId,
        source: "slack" as const,
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

    const listed = await t.query(internal.deviceLock.listForAgent, {
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

    const listed = await t.query(internal.deviceLock.listForAgent, {
      callerUserId: teacherId,
      search: "Kai",
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.devices.map((device) => device.pairedDeviceId)).toEqual([
        first,
      ]);
    }

    const updated = await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: teacherId,
      source: "slack" as const,
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

    const result = await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: teacherA,
      source: "slack" as const,
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

  test("listForAgent tags an Extended Education scholar's row (annotate, never filter)", async () => {
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

    const listed = await t.query(internal.deviceLock.listForAgent, {
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

describe("Freeze Mode", () => {
  async function seedOne(t: TestHarness, slug = "moli") {
    const institutionId = await seedInstitution(t, slug);
    const teacherId = await seedUser(t, "teacher", institutionId, `${slug} teacher`);
    const scholarId = await seedUser(t, "scholar", institutionId, `${slug} Kai`);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      `ipad-${slug}`,
    );
    return { institutionId, teacherId, scholarId, pairedDeviceId };
  }

  test("freezing arms the lock, stamps the end, schedules a thaw, and reaches the device read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T20:00:00.000Z"));
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedOne(t);
    // Start disarmed, so the freeze has to arm it.
    await t.run((ctx) =>
      ctx.db.patch(pairedDeviceId, {
        rabbitholeLockDesiredState: "disarmed",
        rabbitholeLockDisarmMode: "until_further_notice",
      }),
    );

    const result = await (await withUser(t, teacherId)).mutation(
      api.deviceLock.setFreezeMode,
      { pairedDeviceId, frozen: true, minutes: 30 },
    );
    const end = Date.parse("2026-10-17T20:30:00.000Z");
    expect(result).toEqual({ changed: true, frozenUntil: end });

    const row = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    expect(row).toMatchObject({
      freezeUntil: end,
      rabbitholeLockDesiredState: "armed",
    });
    expect(row!.rabbitholeLockDisarmMode).toBeUndefined();
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.map((job) => job.name)).toEqual(["deviceLock:thawFreeze"]);
    expect(jobs[0].args[0]).toMatchObject({
      pairedDeviceId,
      expectedFreezeUntil: end,
    });

    expect(
      await t.query(api.deviceLock.stateForDevice, { deviceId: "ipad-moli" }),
    ).toMatchObject({ desiredState: "armed", frozenUntil: end });

    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "device.freeze.start"))
        .collect(),
    );
    expect(audits).toHaveLength(1);
  });

  test("the thaw job clears only the freeze it was scheduled for", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedOne(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 15,
    });
    const first = (await t.run((ctx) => ctx.db.get(pairedDeviceId)))!.freezeUntil!;
    // Re-freezing replaces the end time; the first job is now stale.
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 60,
    });
    const second = (await t.run((ctx) => ctx.db.get(pairedDeviceId)))!.freezeUntil!;
    expect(second).toBeGreaterThan(first);

    expect(
      await t.mutation(internal.deviceLock.thawFreeze, {
        pairedDeviceId,
        expectedFreezeUntil: first,
      }),
    ).toEqual({ thawed: false });
    expect((await t.run((ctx) => ctx.db.get(pairedDeviceId)))!.freezeUntil).toBe(second);

    expect(
      await t.mutation(internal.deviceLock.thawFreeze, {
        pairedDeviceId,
        expectedFreezeUntil: second,
      }),
    ).toEqual({ thawed: true });
    const row = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    expect(row!.freezeUntil).toBeUndefined();
    // Thawing leaves the lock armed (absent = armed).
    expect(row!.rabbitholeLockDesiredState ?? "armed").toBe("armed");
  });

  test("a re-freeze can shorten a freeze, not only lengthen it", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedOne(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 480,
    });
    const long = (await t.run((ctx) => ctx.db.get(pairedDeviceId)))!.freezeUntil!;
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 5,
    });
    const short = (await t.run((ctx) => ctx.db.get(pairedDeviceId)))!.freezeUntil!;
    expect(long - short).toBeGreaterThan(470 * 60_000);
    // The long freeze's thaw job is stale and must not clear the short one.
    expect(
      await t.mutation(internal.deviceLock.thawFreeze, {
        pairedDeviceId,
        expectedFreezeUntil: long,
      }),
    ).toEqual({ thawed: false });
  });

  test("unfreeze clears the freeze, and a stale thaw afterwards is a no-op", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedOne(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 15,
    });
    const end = (await t.run((ctx) => ctx.db.get(pairedDeviceId)))!.freezeUntil!;
    expect(
      await asTeacher.mutation(api.deviceLock.setFreezeMode, {
        pairedDeviceId,
        frozen: false,
      }),
    ).toEqual({ changed: true, frozenUntil: null });
    expect(
      await t.mutation(internal.deviceLock.thawFreeze, {
        pairedDeviceId,
        expectedFreezeUntil: end,
      }),
    ).toEqual({ thawed: false });
    // Unfreezing an unfrozen iPad changes nothing.
    expect(
      await asTeacher.mutation(api.deviceLock.setFreezeMode, {
        pairedDeviceId,
        frozen: false,
      }),
    ).toEqual({ changed: false, frozenUntil: null });
  });

  test("a frozen iPad cannot be disarmed — on the web or through an agent", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedOne(t);
    const asTeacher = await withUser(t, teacherId);
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 15,
    });
    await expect(
      asTeacher.mutation(api.deviceLock.setRabbitholeLock, {
        pairedDeviceId,
        state: "disarmed",
        disarmMode: "until_midnight",
      }),
    ).rejects.toThrow(/Freeze Mode/);
    const viaAgent = await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: teacherId,
      source: "slack" as const,
      pairedDeviceIds: [pairedDeviceId],
      state: "disarmed",
    });
    expect(viaAgent.ok).toBe(false);
    expect(viaAgent.message).toMatch(/Freeze Mode/);
    expect(
      await t.query(api.deviceLock.stateForDevice, { deviceId: "ipad-moli" }),
    ).toMatchObject({ desiredState: "armed" });
  });

  test("an agent can freeze to an exact end up to 96 hours away", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, pairedDeviceId } = await seedOne(t);
    const freeze = (args: { minutes?: number; untilMs?: number }) =>
      t.mutation(internal.deviceLock.freezeFromAgent, {
        callerUserId: teacherId,
        source: "slack" as const,
        pairedDeviceIds: [pairedDeviceId],
        frozen: true,
        ...args,
      });
    const now = Date.now();
    const hour = 3_600_000;

    const atCap = now + 96 * hour;
    const frozen = await freeze({ untilMs: atCap });
    expect(frozen.ok).toBe(true);
    expect(frozen.message).toContain("1 iPad frozen until ");
    expect((await t.run((ctx) => ctx.db.get(pairedDeviceId)))?.freezeUntil).toBe(
      atCap,
    );

    for (const untilMs of [now + 96 * hour + 60_000, now + 60_000, now - hour, atCap + 0.5]) {
      const refused = await freeze({ untilMs });
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/between 5 minutes and 96 hours/);
    }
    expect(await freeze({ minutes: 60, untilMs: now + hour })).toMatchObject({
      ok: false,
      message: expect.stringMatching(/not both/),
    });
    expect((await t.run((ctx) => ctx.db.get(pairedDeviceId)))?.freezeUntil).toBe(
      atCap,
    );
  });

  test("rejects out-of-range minutes and devices outside the caller's school", async () => {
    const t = convexTest(schema, modules);
    const a = await seedOne(t, "school-a");
    const b = await seedOne(t, "school-b");
    const asTeacherA = await withUser(t, a.teacherId);
    for (const minutes of [undefined, 4, 5761, 12.5]) {
      await expect(
        asTeacherA.mutation(api.deviceLock.setFreezeMode, {
          pairedDeviceId: a.pairedDeviceId,
          frozen: true,
          minutes,
        }),
      ).rejects.toThrow(/between 5 and 5760/);
    }
    await expect(
      asTeacherA.mutation(api.deviceLock.setFreezeMode, {
        pairedDeviceId: b.pairedDeviceId,
        frozen: true,
        minutes: 15,
      }),
    ).rejects.toThrow(/Forbidden/);
    const mixed = await t.mutation(internal.deviceLock.freezeFromAgent, {
      callerUserId: a.teacherId,
      source: "mcp" as const,
      pairedDeviceIds: [a.pairedDeviceId, b.pairedDeviceId],
      frozen: true,
      minutes: 15,
    });
    expect(mixed.ok).toBe(false);
    const rows = await t.run((ctx) => ctx.db.query("pairedDevices").collect());
    expect(rows.every((row) => row.freezeUntil === undefined)).toBe(true);
  });

  test("the agent path freezes a batch, lists frozenUntil, and unfreezes", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const kai = await seedUser(t, "scholar", institutionId, "Kai");
    const lani = await seedUser(t, "scholar", institutionId, "Lani");
    const first = await seedDevice(t, institutionId, kai, teacherId, "ipad-kai");
    const second = await seedDevice(t, institutionId, lani, teacherId, "ipad-lani");

    const frozen = await t.mutation(internal.deviceLock.freezeFromAgent, {
      callerUserId: teacherId,
      source: "slack" as const,
      pairedDeviceIds: [first, second],
      frozen: true,
      minutes: 20,
    });
    expect(frozen).toMatchObject({ ok: true, changedCount: 2 });
    expect(frozen.message).toMatch(/2 iPads frozen until /);

    const badMinutes = await t.mutation(internal.deviceLock.freezeFromAgent, {
      callerUserId: teacherId,
      source: "slack" as const,
      pairedDeviceIds: [first],
      frozen: true,
    });
    expect(badMinutes.ok).toBe(false);

    const listed = await t.query(internal.deviceLock.listForAgent, {
      callerUserId: teacherId,
    });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.devices.every((device) => typeof device.frozenUntil === "number")).toBe(true);
    }

    const thawed = await t.mutation(internal.deviceLock.freezeFromAgent, {
      callerUserId: teacherId,
      source: "slack" as const,
      pairedDeviceIds: [first],
      frozen: false,
    });
    expect(thawed).toMatchObject({ ok: true, changedCount: 1, message: "1 iPad unfrozen." });
  });
});

describe("Guardian freeze", () => {
  async function seedGuardian(
    t: TestHarness,
    scholarId: Id<"users">,
    createdBy: Id<"users">,
    name = "Test parent",
    role: "parent" | StaffRole = "parent",
    institutionId?: Id<"institutions">,
  ) {
    const guardianId =
      role === "parent"
        ? await t.run((ctx) =>
          ctx.db.insert("users", {
            name,
            username: name.toLowerCase().replaceAll(" ", "-"),
            role: "parent" as const,
          }),
        )
        : await seedUser(t, role, institutionId, name);
    await t.run((ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: guardianId,
        scholarUserId: scholarId,
        createdBy,
      }),
    );
    return guardianId;
  }

  async function seedFamily(t: TestHarness, slug = "moli") {
    const institutionId = await seedInstitution(t, slug);
    const teacherId = await seedUser(t, "teacher", institutionId, `${slug} teacher`);
    const scholarId = await seedUser(t, "scholar", institutionId, `${slug} Kai`);
    const pairedDeviceId = await seedDevice(
      t,
      institutionId,
      scholarId,
      teacherId,
      `ipad-${slug}`,
    );
    const parentId = await seedGuardian(t, scholarId, teacherId, `${slug} parent`);
    return { institutionId, teacherId, scholarId, pairedDeviceId, parentId };
  }

  const guardianFreeze = (
    t: TestHarness,
    guardianUserId: Id<"users">,
    scholarId: Id<"users">,
    frozen: boolean,
    minutes?: number,
  ) =>
    t.mutation(internal.deviceLock.freezeFromGuardian, {
      guardianUserId,
      scholarId,
      source: "parent_app" as const,
      frozen,
      ...(minutes === undefined ? {} : { minutes }),
    });

  test("a guardian freezes every paired row for their child, and the device reads family", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T20:00:00.000Z"));
    const t = convexTest(schema, modules);
    const { institutionId, teacherId, scholarId, pairedDeviceId, parentId } =
      await seedFamily(t);
    // A second binding for the same child (a re-paired iPad).
    const second = await seedDevice(t, institutionId, scholarId, teacherId, "ipad-moli-2");

    expect(
      await t.query(api.deviceLock.stateForDevice, { deviceId: "ipad-moli" }),
    ).toMatchObject({ frozenUntil: null, frozenBy: null });

    const result = await guardianFreeze(t, parentId, scholarId, true, 60);
    const end = Date.parse("2026-10-17T21:00:00.000Z");
    expect(result).toMatchObject({ ok: true, changedCount: 2, frozenUntil: end });
    expect(result.message).toMatch(
      /^moli Kai's 2 BunnyPads will be frozen until .+\. The freeze takes effect once they are connected\.$/,
    );

    for (const id of [pairedDeviceId, second]) {
      expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
        freezeUntil: end,
        freezeUpdatedBy: parentId,
      });
    }
    const device = await t.query(api.deviceLock.stateForDevice, {
      deviceId: "ipad-moli-2",
    });
    expect(device).toMatchObject({ frozenUntil: end, frozenBy: "family" });
    // Unauthenticated read: no person data rides along with the owner.
    expect(Object.keys(device!).sort()).toEqual(
      [
        "desiredState",
        "desiredUpdatedAt",
        "disarmExpiresAt",
        "disarmMode",
        "frozenBy",
        "frozenUntil",
        "pairedDeviceId",
        "settingsPath",
      ].sort(),
    );

    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "device.freeze.start"))
        .collect(),
    );
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.detail?.includes("via parent_app"))).toBe(true);

    const status = await t.query(internal.deviceLock.freezeStatusForGuardian, {
      guardianUserId: parentId,
    });
    expect(status.children).toHaveLength(1);
    expect(status.children[0]).toMatchObject({ scholarId, name: "moli Kai" });
    expect(status.children[0].devices).toHaveLength(2);
    expect(
      status.children[0].devices.every(
        (row) =>
          row.frozenUntil === end &&
          row.frozenBy === "family" &&
          row.setByYou &&
          typeof row.frozenUntilLabel === "string",
      ),
    ).toBe(true);

    const thawed = await guardianFreeze(t, parentId, scholarId, false);
    expect(thawed).toMatchObject({ ok: true, changedCount: 2, frozenUntil: null });
    expect(
      await t.query(api.deviceLock.stateForDevice, { deviceId: "ipad-moli" }),
    ).toMatchObject({ frozenUntil: null, frozenBy: null });
  });

  test("authorization is guardianship, not role: a staff member who is a guardian can freeze", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedInstitution(t, "moli");
    const teacherId = await seedUser(t, "teacher", institutionId);
    const scholarId = await seedUser(t, "scholar", institutionId, "Kai");
    await seedDevice(t, institutionId, scholarId, teacherId, "ipad-kai");
    const staffParent = await seedGuardian(
      t,
      scholarId,
      teacherId,
      "Staff parent",
      "school_admin",
      institutionId,
    );
    expect(await guardianFreeze(t, staffParent, scholarId, true, 30)).toMatchObject({
      ok: true,
      changedCount: 1,
    });
    expect(
      await t.query(api.deviceLock.stateForDevice, { deviceId: "ipad-kai" }),
    ).toMatchObject({ frozenBy: "family" });

    // ...and staff standing alone, without the guardianship, is not enough.
    const lani = await seedUser(t, "scholar", institutionId, "Lani");
    await seedDevice(t, institutionId, lani, teacherId, "ipad-lani");
    expect(await guardianFreeze(t, staffParent, lani, true, 30)).toMatchObject({
      ok: false,
      message: "You can only freeze your own child's BunnyPad.",
    });
  });

  test("a non-guardian is refused, and another institution's scholar is unreachable", async () => {
    const t = convexTest(schema, modules);
    const home = await seedFamily(t, "moli");
    const away = await seedFamily(t, "kona");
    // Same school, someone else's child.
    const lani = await seedUser(t, "scholar", home.institutionId, "Lani");
    await seedDevice(t, home.institutionId, lani, home.teacherId, "ipad-lani");

    for (const scholarId of [lani, away.scholarId]) {
      for (const frozen of [true, false]) {
        expect(
          await guardianFreeze(t, home.parentId, scholarId, frozen, frozen ? 30 : undefined),
        ).toEqual({
          ok: false,
          message: "You can only freeze your own child's BunnyPad.",
        });
      }
    }
    const rows = await t.run((ctx) => ctx.db.query("pairedDevices").collect());
    expect(rows.every((row) => row.freezeUntil === undefined)).toBe(true);

    // The status list names only the guardian's own child.
    const status = await t.query(internal.deviceLock.freezeStatusForGuardian, {
      guardianUserId: home.parentId,
    });
    expect(status.children.map((child) => child.scholarId)).toEqual([home.scholarId]);
  });

  test("a staff freeze can't be lifted or replaced by a parent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T20:00:00.000Z"));
    const t = convexTest(schema, modules);
    const { teacherId, scholarId, pairedDeviceId, parentId } = await seedFamily(t);
    await (await withUser(t, teacherId)).mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 90,
    });
    const end = Date.parse("2026-10-17T21:30:00.000Z");
    expect(
      await t.query(api.deviceLock.stateForDevice, { deviceId: "ipad-moli" }),
    ).toMatchObject({ frozenUntil: end, frozenBy: "school" });

    for (const [frozen, minutes] of [
      [false, undefined],
      [true, 30],
      [true, 240],
    ] as const) {
      const refused = await guardianFreeze(t, parentId, scholarId, frozen, minutes);
      expect(refused.ok).toBe(false);
      expect(refused.message).toMatch(/^The school froze moli Kai's BunnyPad until /);
      expect(refused.message).toMatch(/Only the school can change that freeze/);
    }
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      freezeUntil: end,
      freezeUpdatedBy: teacherId,
    });

    const status = await t.query(internal.deviceLock.freezeStatusForGuardian, {
      guardianUserId: parentId,
    });
    expect(status.children[0].devices[0]).toMatchObject({
      frozenUntil: end,
      frozenBy: "school",
      setByYou: false,
    });

    // Once the school's freeze has ended on the clock, it outranks no one,
    // even before its thaw job has run.
    vi.setSystemTime(end + 1);
    expect(await guardianFreeze(t, parentId, scholarId, true, 30)).toMatchObject({
      ok: true,
    });
  });

  test("one school-frozen row blocks the whole request", async () => {
    const t = convexTest(schema, modules);
    const { institutionId, teacherId, scholarId, pairedDeviceId, parentId } =
      await seedFamily(t);
    const second = await seedDevice(t, institutionId, scholarId, teacherId, "ipad-moli-2");
    await (await withUser(t, teacherId)).mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId: second,
      frozen: true,
      minutes: 60,
    });
    const refused = await guardianFreeze(t, parentId, scholarId, true, 30);
    expect(refused.ok).toBe(false);
    expect((await t.run((ctx) => ctx.db.get(pairedDeviceId)))?.freezeUntil).toBeUndefined();
  });

  test("staff override a parent's freeze, and their re-freeze becomes the school's", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId, pairedDeviceId, parentId } = await seedFamily(t);
    const asTeacher = await withUser(t, teacherId);

    await guardianFreeze(t, parentId, scholarId, true, 60);
    expect(
      await asTeacher.mutation(api.deviceLock.setFreezeMode, {
        pairedDeviceId,
        frozen: false,
      }),
    ).toEqual({ changed: true, frozenUntil: null });

    await guardianFreeze(t, parentId, scholarId, true, 60);
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: true,
      minutes: 15,
    });
    expect(
      await t.query(api.deviceLock.stateForDevice, { deviceId: "ipad-moli" }),
    ).toMatchObject({ frozenBy: "school" });
    expect((await guardianFreeze(t, parentId, scholarId, false)).ok).toBe(false);

    // The agent path overrides a family freeze too.
    await asTeacher.mutation(api.deviceLock.setFreezeMode, {
      pairedDeviceId,
      frozen: false,
    });
    await guardianFreeze(t, parentId, scholarId, true, 60);
    expect(
      await t.mutation(internal.deviceLock.freezeFromAgent, {
        callerUserId: teacherId,
        source: "slack" as const,
        pairedDeviceIds: [pairedDeviceId],
        frozen: false,
      }),
    ).toMatchObject({ ok: true, changedCount: 1 });
  });

  test("between two guardians, the latest request wins", async () => {
    const t = convexTest(schema, modules);
    const { teacherId, scholarId, pairedDeviceId, parentId } = await seedFamily(t);
    const otherParent = await seedGuardian(t, scholarId, teacherId, "Other parent");

    await guardianFreeze(t, parentId, scholarId, true, 60);
    const replaced = await guardianFreeze(t, otherParent, scholarId, true, 10);
    expect(replaced).toMatchObject({ ok: true, changedCount: 1 });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      freezeUpdatedBy: otherParent,
    });
    const status = await t.query(internal.deviceLock.freezeStatusForGuardian, {
      guardianUserId: parentId,
    });
    expect(status.children[0].devices[0]).toMatchObject({
      frozenBy: "family",
      setByYou: false,
    });

    expect(await guardianFreeze(t, parentId, scholarId, false)).toMatchObject({
      ok: true,
      changedCount: 1,
    });
  });

  test("family freezes are at least 5 minutes, up to 8 hours with no bell schedule, and an unpaired child is named", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T19:58:00.000Z")); // Mon 9:58am HST
    const t = convexTest(schema, modules);
    const { teacherId, scholarId, institutionId, parentId } = await seedFamily(t);
    for (const minutes of [undefined, 4, 481, 30.5]) {
      expect(await guardianFreeze(t, parentId, scholarId, true, minutes)).toEqual({
        ok: false,
        message:
          "A family freeze lasts at least 5 minutes, and right now it can run until Mon, Nov 16, 5:58 PM HST at the latest (480 minutes from now).",
      });
    }
    expect((await guardianFreeze(t, parentId, scholarId, true, 480)).ok).toBe(true);

    const lani = await seedUser(t, "scholar", institutionId, "Lani");
    await seedGuardian(t, lani, teacherId, "Lani parent");
    const laniParent = await t.run(async (ctx) =>
      (await ctx.db
        .query("guardianships")
        .withIndex("by_scholar", (q) => q.eq("scholarUserId", lani))
        .first())!.parentUserId,
    );
    expect(await guardianFreeze(t, laniParent, lani, true, 30)).toEqual({
      ok: false,
      message: "Lani doesn't have a BunnyPad paired yet.",
    });
  });

  async function seedBellSchedule(
    t: TestHarness,
    institutionId: Id<"institutions">,
    closures: Array<{ startDayKey: string; endDayKey: string }> = [],
  ) {
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.parse("2026-08-01T00:00:00Z"),
        endsAt: Date.parse("2026-12-20T00:00:00Z"),
        status: "open",
        institutionId,
      });
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "blockA",
        label: "Block A",
        startLocal: "08:30",
        endLocal: "15:00",
        weekdays: [1, 2, 3, 4, 5],
        order: 1,
      });
      // The virtual homework rail (start == end) is not a school-day start.
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "homework-due",
        label: "Homework due",
        startLocal: "08:00",
        endLocal: "08:00",
        weekdays: [1, 2, 3, 4, 5, 6, 7],
        order: 9999,
        kind: "homework",
      });
      for (const c of closures) {
        await ctx.db.insert("schoolClosures", {
          institutionId,
          ...c,
          label: "Closed",
          kind: "holiday",
        });
      }
    });
  }

  test("a family freeze can run until the next school day starts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T19:58:00.000Z")); // Mon 9:58am HST
    const t = convexTest(schema, modules);
    const { institutionId, scholarId, pairedDeviceId, parentId } = await seedFamily(t);
    await seedBellSchedule(t, institutionId);

    // 12 hours from mid-morning ends overnight, well before Tuesday 8:30am.
    expect(await guardianFreeze(t, parentId, scholarId, true, 720)).toMatchObject({
      ok: true,
    });
    // Tuesday 8:30am HST is 1352 minutes away; one more runs into school.
    expect((await guardianFreeze(t, parentId, scholarId, true, 1352)).ok).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      freezeUntil: Date.parse("2026-11-17T18:30:00.000Z"),
    });
    // The aide's clock is minute-truncated: 40 seconds later, "until 8:30am"
    // is still 1352 minutes, and the end is clamped to the first bell.
    await guardianFreeze(t, parentId, scholarId, false);
    vi.setSystemTime(new Date("2026-11-16T19:58:40.000Z"));
    expect((await guardianFreeze(t, parentId, scholarId, true, 1352)).ok).toBe(true);
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      freezeUntil: Date.parse("2026-11-17T18:30:00.000Z"),
    });
    vi.setSystemTime(new Date("2026-11-16T19:58:00.000Z"));
    expect(await guardianFreeze(t, parentId, scholarId, true, 1353)).toEqual({
      ok: false,
      message:
        "A family freeze lasts at least 5 minutes, and right now it can run until Tue, Nov 17, 8:30 AM HST at the latest (1352 minutes from now).",
    });
  });

  test("a weekend or closure extends the family window; an early-morning freeze keeps 8 hours", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const { institutionId, scholarId, parentId } = await seedFamily(t);
    // Tuesday Nov 17 is closed.
    await seedBellSchedule(t, institutionId, [
      { startDayKey: "2026-11-17", endDayKey: "2026-11-17" },
    ]);

    // Friday 6pm HST → Monday 8:30am HST is 3750 minutes.
    vi.setSystemTime(new Date("2026-11-14T04:00:00.000Z"));
    expect((await guardianFreeze(t, parentId, scholarId, true, 3750)).ok).toBe(true);
    expect((await guardianFreeze(t, parentId, scholarId, true, 3751)).ok).toBe(false);

    // Monday 10am HST, Tuesday closed → Wednesday 8:30am is 2790 minutes.
    vi.setSystemTime(new Date("2026-11-16T20:00:00.000Z"));
    expect((await guardianFreeze(t, parentId, scholarId, true, 2790)).ok).toBe(true);
    expect((await guardianFreeze(t, parentId, scholarId, true, 2791)).ok).toBe(false);

    // Wednesday 6am HST: school starts in 150 minutes, but 8 hours stays allowed.
    vi.setSystemTime(new Date("2026-11-18T16:00:00.000Z"));
    expect((await guardianFreeze(t, parentId, scholarId, true, 480)).ok).toBe(true);
    expect((await guardianFreeze(t, parentId, scholarId, true, 481)).ok).toBe(false);
  });

  // TRA-559: accepted for the Parent Freeze pilot (2026-11-01). A guardian
  // freeze goes through applyFreezeToRows, which arms the row, so it REPLACES
  // a teacher's active disarm; the disarm's scheduled re-arm then no-ops, and
  // the BunnyPad stays armed after the family freeze thaws. If a teacher
  // reports a lost disarm, revisit whether a guardian freeze should be refused
  // while a staff disarm is active — and change this test with it.
  test("a guardian freeze replaces a teacher's active disarm and its scheduled re-arm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T20:00:00.000Z"));
    const t = convexTest(schema, modules);
    const { teacherId, scholarId, pairedDeviceId, parentId } = await seedFamily(t);

    // The teacher disarms for 45 minutes; a re-arm job is scheduled.
    await t.mutation(internal.deviceLock.setFromAgent, {
      callerUserId: teacherId,
      source: "slack" as const,
      pairedDeviceIds: [pairedDeviceId],
      state: "disarmed",
      disarmMode: "timed",
      disarmMinutes: 45,
    });
    expect(await t.run((ctx) => ctx.db.get(pairedDeviceId))).toMatchObject({
      rabbitholeLockDesiredState: "disarmed",
      rabbitholeLockDisarmMode: "timed",
    });

    // Five minutes into the lesson, a parent freezes for five minutes.
    vi.setSystemTime(new Date("2026-10-17T20:05:00.000Z"));
    expect((await guardianFreeze(t, parentId, scholarId, true, 5)).ok).toBe(true);
    const frozen = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    expect(frozen).toMatchObject({
      rabbitholeLockDesiredState: "armed",
      freezeUpdatedBy: parentId,
    });
    expect(frozen!.rabbitholeLockDisarmMode).toBeUndefined();
    expect(frozen!.rabbitholeLockDisarmExpiresAt).toBeUndefined();

    // Run everything scheduled: the thaw at 20:10 and the teacher's stale
    // re-arm at 20:45, which finds the row moved on and no-ops.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const jobs = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.map((job) => [job.name, job.state.kind]).sort()).toEqual([
      ["deviceLock:rearmTimed", "success"],
      ["deviceLock:thawFreeze", "success"],
    ]);

    // Thawed, and still armed: the teacher's disarm does not come back.
    const after = await t.run((ctx) => ctx.db.get(pairedDeviceId));
    expect(after!.freezeUntil).toBeUndefined();
    expect(after).toMatchObject({ rabbitholeLockDesiredState: "armed" });
    expect(after!.rabbitholeLockDisarmMode).toBeUndefined();
  });

  test("a read-only guardian is refused before anything is written", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, pairedDeviceId, parentId } = await seedFamily(t);
    await t.run((ctx) => ctx.db.patch(parentId, { readOnly: true }));
    expect(await guardianFreeze(t, parentId, scholarId, true, 30)).toEqual({
      ok: false,
      message: READ_ONLY_ACCOUNT_ERROR,
    });
    expect((await t.run((ctx) => ctx.db.get(pairedDeviceId)))!.freezeUntil).toBeUndefined();
  });
});
