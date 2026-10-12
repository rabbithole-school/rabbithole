import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { MANAGED_NATIVE_APPS } from "../lib/managedNativeApps";
import { scheduleWeekStartMs } from "../../shared/scheduleWeek";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

// TRA-444 (Andy's ruling, 2026-09-28): the device console says when a
// block-scoped app opens instead of "no grant", and its default extra access
// ends on its own. These pin the console's two reads (the blocks that open an
// app to the device's scholar, the last day of access opened for them) and
// its actions (scholarApps.openForScholar and its expiry job). The agreement
// sweep (appAccessAgreement.explore.test.ts) checks that every reader honors
// the end; the sequence explorer checks that an iPad drops the app after it.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const _makeTestClient = () => convexTest(schema, modules);
type TestClient = ReturnType<typeof _makeTestClient>;

const TZ = "Pacific/Honolulu"; // no DST
const DAY = 24 * 60 * 60_000;
const hst = (local: string) => Date.parse(`${local}-10:00`);
const MONDAY_9AM = hst("2026-09-28T09:00:00");
const TUESDAY_MIDNIGHT = hst("2026-09-29T00:00:00");
const SPIKE = MANAGED_NATIVE_APPS["lego-spike"];

async function withUser(t: TestClient, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 30 * DAY }),
  );
  return t.withIdentity({ subject: `${userId}|${sessionId}`, issuer: "https://convex.dev" });
}

/** One school (Honolulu time): a teacher, a scholar in Robotics, a claimed
 *  iPad whose allowlist holds only its baseline, and LEGO SPIKE. */
async function seedWorld(t: TestClient) {
  const institutionId = await seedTestInstitution(t, { name: "Moli School", slug: "moli", isPrimary: true });
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    role: "teacher",
    name: "Sloane Kahale",
    username: "sloane-open",
  });
  const scholarId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Kai Kahale",
    username: "kai-open",
  });
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch(institutionId, { timeZone: TZ });
    const appId = await ctx.db.insert("externalApps", {
      name: "LEGO SPIKE",
      webUrl: "https://spike.example.com",
      nativeUrlScheme: SPIKE.nativeUrlScheme!,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Robotics",
      scholarIds: [scholarId],
    });
    const claimId = await ctx.db.insert("managedDeviceClaims", {
      institutionId,
      serial: "SERIAL-KAI-OPEN",
      scholarId,
      claimState: "claimed",
      createdBy: teacherId,
      createdAt: now,
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: 0,
      claimCount: 1,
      lastDeviceId: "ipad-kai-open",
      claimGeneration: 1,
    });
    await ctx.db.insert("pairedDevices", {
      institutionId,
      scholarId,
      deviceId: "ipad-kai-open",
      pairedAt: now,
      pairedBy: teacherId,
      managedDeviceClaimId: claimId,
    });
    // Provisioned, and projected at its baseline: nothing opens SPIKE yet.
    const baseline = ["com.apple.Preferences", "school.rabbithole.canary"];
    await ctx.db.insert("deviceAppUnlockBindings", {
      institutionId,
      managedDeviceClaimId: claimId,
      serial: "SERIAL-KAI-OPEN",
      simpleMdmProfileId: "profile-kai-open",
      baselineBundleIds: baseline,
      baselineProfileXml: "<plist />",
      profilePayloadIdentifier: "live.profile",
      profilePayloadUuid: "11111111-1111-1111-1111-111111111111",
      profileUuid: "22222222-2222-2222-2222-222222222222",
      configuredAt: now,
      configuredBy: teacherId,
    });
    await ctx.db.insert("deviceAppUnlockStates", {
      institutionId,
      managedDeviceClaimId: claimId,
      desiredState: "locked",
      desiredBundleIds: baseline,
      appliedBundleIds: baseline,
      updatedAt: now,
      requestedAt: now,
      requestedBy: teacherId,
    });
    return { appId, groupId, claimId };
  });
  return { institutionId, teacherId, scholarId, ...ids, asTeacher: await withUser(t, teacherId) };
}

type World = Awaited<ReturnType<typeof seedWorld>>;

async function spikeRow(t: TestClient, w: World) {
  return await t.run((ctx) =>
    ctx.db
      .query("scholarApps")
      .withIndex("by_scholar_app", (q) => q.eq("scholarId", w.scholarId).eq("appId", w.appId))
      .unique(),
  );
}

async function consoleRow(w: World) {
  const devices = await w.asTeacher.query(api.managedDeviceClaims.listManagedDevices, {});
  const device = devices.find((d) => d._id === w.claimId)!;
  return { device, spike: device.appAccess.find((row) => row.key === "lego-spike")! };
}

async function scheduledExpiries(t: TestClient) {
  return (await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())).filter(
    (job) => job.name.includes("expireDirectGrant") && job.state.kind === "pending",
  );
}

beforeEach(() => {
  // Every timer faked, so the expiry job and the projector's nudge run only
  // when a test runs them.
  vi.useFakeTimers();
  vi.setSystemTime(MONDAY_9AM);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openForScholar — opened access ends on its own", () => {
  test("opens through the end of today by default, and schedules its end", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const result = await w.asTeacher.mutation(api.scholarApps.openForScholar, {
      scholarId: w.scholarId,
      appId: w.appId,
    });
    expect(result).toMatchObject({ throughDay: "2026-09-28", expiresAt: TUESDAY_MIDNIGHT });
    expect(await spikeRow(t, w)).toMatchObject({
      enabled: true,
      source: "manual",
      addedBy: w.teacherId,
      expiresAt: TUESDAY_MIDNIGHT,
    });
    const jobs = await scheduledExpiries(t);
    expect(jobs.map((job) => [job.scheduledTime, job.args[0]])).toEqual([
      [TUESDAY_MIDNIGHT, { scholarAppId: result.scholarAppId, expiresAt: TUESDAY_MIDNIGHT }],
    ]);
  });

  test("opening again extends a shorter add, schedules the new end, and never shortens", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const target = { scholarId: w.scholarId, appId: w.appId };
    const FRIDAY_END = hst("2026-10-03T00:00:00");
    await w.asTeacher.mutation(api.scholarApps.openForScholar, target);
    const later = await w.asTeacher.mutation(api.scholarApps.openForScholar, {
      ...target,
      throughDay: "2026-10-02",
    });
    expect(later).toMatchObject({ throughDay: "2026-10-02", expiresAt: FRIDAY_END });
    expect((await spikeRow(t, w))?.expiresAt).toBe(FRIDAY_END);
    expect((await scheduledExpiries(t)).map((job) => job.scheduledTime)).toEqual([
      TUESDAY_MIDNIGHT,
      FRIDAY_END,
    ]);

    // Asking for less leaves it, and answers with the day it already runs to.
    const shorter = await w.asTeacher.mutation(api.scholarApps.openForScholar, target);
    expect(shorter).toMatchObject({ throughDay: "2026-10-02", expiresAt: FRIDAY_END });
    expect((await spikeRow(t, w))?.expiresAt).toBe(FRIDAY_END);
    expect(await scheduledExpiries(t)).toHaveLength(2);

    // A standing add is never cut down to a day.
    await w.asTeacher.mutation(api.scholarApps.addToScholar, target);
    expect(await w.asTeacher.mutation(api.scholarApps.openForScholar, target)).toMatchObject({
      throughDay: null,
      expiresAt: null,
    });
    expect((await spikeRow(t, w))?.expiresAt).toBeUndefined();
  });

  test("a caller that doesn't manage ends keeps a live one: the aide's enable can't make a day standing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.scholarApps.openForScholar, { scholarId: w.scholarId, appId: w.appId });
    const enable = () =>
      t.mutation(internal.scholarApps.aideSetScholarAccess, {
        callerUserId: w.teacherId,
        appName: "LEGO SPIKE",
        scholarQuery: "kai-open",
        enabled: true,
      });
    await enable();
    expect(await spikeRow(t, w)).toMatchObject({ enabled: true, expiresAt: TUESDAY_MIDNIGHT });

    // Past the end, before the expiry job has run: enabling gives the app
    // again, as the standing add it would be had the row already gone.
    vi.setSystemTime(TUESDAY_MIDNIGHT);
    await enable();
    const row = await spikeRow(t, w);
    expect(row?.enabled).toBe(true);
    expect(row?.expiresAt).toBeUndefined();
  });

  test("today is the scholar's school's day, not the server's or the staffer's", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await t.run((ctx) => ctx.db.patch(w.institutionId, { timeZone: "America/New_York" }));
    // 22:00 on Monday in New York is already Tuesday in UTC.
    vi.setSystemTime(Date.parse("2026-09-28T22:00:00-04:00"));
    const result = await w.asTeacher.mutation(api.scholarApps.openForScholar, {
      scholarId: w.scholarId,
      appId: w.appId,
    });
    expect(result.throughDay).toBe("2026-09-28");
    expect(result.expiresAt).toBe(Date.parse("2026-09-29T00:00:00-04:00"));
  });

  test("the standing add takes the end off, and the launch gates stop at the end", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asScholar = await withUser(t, w.scholarId);
    const tile = async () =>
      (await asScholar.query(api.scholarApps.listForLauncher, { now: Date.now() })).some(
        (row) => row.appId === w.appId,
      );
    await w.asTeacher.mutation(api.scholarApps.openForScholar, { scholarId: w.scholarId, appId: w.appId });
    expect(await tile()).toBe(true);
    await asScholar.mutation(api.webActivitySessions.start, { appId: w.appId });

    // At midnight the add grants nothing, before its expiry job has run.
    vi.setSystemTime(TUESDAY_MIDNIGHT);
    expect(await spikeRow(t, w)).not.toBeNull();
    expect(await tile()).toBe(false);
    await expect(asScholar.mutation(api.webActivitySessions.start, { appId: w.appId })).rejects.toThrow();

    // "Allow at all hours" re-grants with no end.
    await w.asTeacher.mutation(api.scholarApps.addToScholar, { scholarId: w.scholarId, appId: w.appId });
    expect((await spikeRow(t, w))?.expiresAt).toBeUndefined();
    expect(await tile()).toBe(true);
  });

  test("refuses a past day, a malformed day, an archived app, and another school's staffer", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const target = { scholarId: w.scholarId, appId: w.appId };
    await expect(
      w.asTeacher.mutation(api.scholarApps.openForScholar, { ...target, throughDay: "2026-09-27" }),
    ).rejects.toThrow(/Pick today or a later day/);
    await expect(
      w.asTeacher.mutation(api.scholarApps.openForScholar, { ...target, throughDay: "2026-09-31" }),
    ).rejects.toThrow(/Pick a valid day/);

    const otherSchool = await seedTestInstitution(t, { name: "Kaimana School", slug: "kaimana" });
    const outsider = await seedStaffWithMembership(t, {
      institutionId: otherSchool,
      role: "teacher",
      name: "Lehua Torres",
      username: "lehua-open",
    });
    await expect(
      (await withUser(t, outsider)).mutation(api.scholarApps.openForScholar, target),
    ).rejects.toThrow();

    await t.run((ctx) => ctx.db.patch(w.appId, { archived: true }));
    await expect(w.asTeacher.mutation(api.scholarApps.openForScholar, target)).rejects.toThrow(
      /no longer in the catalog/,
    );
    expect(await spikeRow(t, w)).toBeNull();
  });
});

describe("expireDirectGrant — the end, in the table", () => {
  test("removes the row at its end, marks the iPad for its next projection, and records who opened it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { scholarAppId } = await w.asTeacher.mutation(api.scholarApps.openForScholar, {
      scholarId: w.scholarId,
      appId: w.appId,
    });
    // As if the projector has already carried the add to the iPad.
    const unlockState = await t.run(async (ctx) =>
      (await ctx.db.query("deviceAppUnlockStates").collect()).find(
        (state) => state.managedDeviceClaimId === w.claimId,
      ),
    );
    await t.run((ctx) => ctx.db.patch(unlockState!._id, { projectionDueAt: TUESDAY_MIDNIGHT + DAY }));
    vi.setSystemTime(TUESDAY_MIDNIGHT);
    await t.mutation(internal.scholarApps.expireDirectGrant, { scholarAppId, expiresAt: TUESDAY_MIDNIGHT });
    expect(await spikeRow(t, w)).toBeNull();
    // Not left for the five-minute sweep: the iPad is due now.
    expect((await t.run((ctx) => ctx.db.get(unlockState!._id)))?.projectionDueAt).toBe(0);
    const audits = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_action", (q) => q.eq("action", "app-grant.scholar-unassigned"))
        .collect(),
    );
    expect(audits.map((a) => [a.actorUserId, JSON.parse(a.detail ?? "{}").via])).toEqual([
      [w.teacherId, "expiry"],
    ]);
  });

  test("does nothing once the add was re-opened to a later day or made standing", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const target = { scholarId: w.scholarId, appId: w.appId };
    const { scholarAppId } = await w.asTeacher.mutation(api.scholarApps.openForScholar, target);
    await w.asTeacher.mutation(api.scholarApps.openForScholar, { ...target, throughDay: "2026-09-29" });
    vi.setSystemTime(TUESDAY_MIDNIGHT);
    await t.mutation(internal.scholarApps.expireDirectGrant, { scholarAppId, expiresAt: TUESDAY_MIDNIGHT });
    expect((await spikeRow(t, w))?.expiresAt).toBe(hst("2026-09-30T00:00:00"));

    await w.asTeacher.mutation(api.scholarApps.addToScholar, target);
    vi.setSystemTime(hst("2026-09-30T00:00:00"));
    await t.mutation(internal.scholarApps.expireDirectGrant, {
      scholarAppId,
      expiresAt: hst("2026-09-30T00:00:00"),
    });
    expect(await spikeRow(t, w)).toMatchObject({ enabled: true, source: "manual" });
  });

  test("a call before the end puts itself back on the clock", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { scholarAppId } = await w.asTeacher.mutation(api.scholarApps.openForScholar, {
      scholarId: w.scholarId,
      appId: w.appId,
    });
    await t.mutation(internal.scholarApps.expireDirectGrant, { scholarAppId, expiresAt: TUESDAY_MIDNIGHT });
    expect(await spikeRow(t, w)).not.toBeNull();
    expect((await scheduledExpiries(t)).map((job) => job.scheduledTime)).toEqual([
      TUESDAY_MIDNIGHT,
      TUESDAY_MIDNIGHT,
    ]);
  });

  test("keeps a saved login parked when a live group grant still covers the scholar", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const { scholarAppId } = await w.asTeacher.mutation(api.scholarApps.openForScholar, {
      scholarId: w.scholarId,
      appId: w.appId,
    });
    await w.asTeacher.mutation(api.scholarApps.setCredentials, {
      scholarId: w.scholarId,
      appId: w.appId,
      username: "kai-spike",
    });
    await w.asTeacher.mutation(api.appAudiences.assignToAudience, {
      appId: w.appId,
      audienceKind: "group",
      audienceId: String(w.groupId),
    });
    vi.setSystemTime(TUESDAY_MIDNIGHT);
    await t.mutation(internal.scholarApps.expireDirectGrant, { scholarAppId, expiresAt: TUESDAY_MIDNIGHT });
    const row = await spikeRow(t, w);
    expect(row).toMatchObject({ source: "grant", loginUsername: "kai-spike" });
    expect(row?.expiresAt).toBeUndefined();
  });
});

describe("the device console — when the app opens, and until when", () => {
  /** Robotics' block E: 15:05–16:30, so its app window is 14:50–16:40. */
  async function seedSchedule(t: TestClient, w: World) {
    const now = Date.now();
    return await t.run(async (ctx) => {
      const term = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: now - 30 * DAY,
        endsAt: now + 90 * DAY,
        status: "open",
        institutionId: w.institutionId,
      });
      const lastTerm = await ctx.db.insert("reportingPeriods", {
        label: "Spring 2026",
        startsAt: now - 200 * DAY,
        endsAt: now - 100 * DAY,
        status: "closed",
        institutionId: w.institutionId,
      });
      const block = (periodId: Id<"reportingPeriods">) =>
        ctx.db.insert("scheduleBlocks", {
          periodId,
          key: "blockE",
          label: "Block E",
          startLocal: "15:05",
          endLocal: "16:30",
          weekdays: [1, 2, 3, 4, 5],
          order: 0,
          kind: "class",
        });
      const blockE = await block(term);
      const oldBlockE = await block(lastTerm);
      const makers = await ctx.db.insert("scholarGroups", {
        teacherId: w.teacherId,
        institutionId: w.institutionId,
        name: "Makers",
        scholarIds: [],
      });
      const place = (fields: {
        groupId?: Id<"scholarGroups">;
        weekday?: number;
        periodId?: Id<"reportingPeriods">;
        blockId?: Id<"scheduleBlocks">;
        teacher?: boolean;
        weekStartMs?: number;
      }) =>
        ctx.db.insert("schedulePlacements", {
          periodId: fields.periodId ?? term,
          groupId: fields.groupId ?? w.groupId,
          ...(fields.weekday === undefined ? {} : { weekday: fields.weekday, blockId: fields.blockId ?? blockE }),
          subject: "Robotics",
          ...(fields.teacher === false ? {} : { teacherId: w.teacherId }),
          externalAppId: w.appId,
          ...(fields.weekStartMs === undefined ? {} : { weekStartMs: fields.weekStartMs }),
        });
      const thisWeek = scheduleWeekStartMs(now, TZ);
      // What the materializer opens for Kai: Monday and Wednesday every week,
      // Friday this week only, and Tuesday's class with no teacher (TRA-450:
      // its push is credited to the group's creator).
      await place({ weekday: 1 });
      await place({ weekday: 3 });
      await place({ weekday: 5, weekStartMs: thisWeek });
      await place({ weekday: 2, teacher: false });
      // What it opens for nobody, or for someone else.
      await place({ weekday: 5, weekStartMs: thisWeek + 7 * DAY }); // next week
      await place({ weekday: 4, periodId: lastTerm, blockId: oldBlockE }); // last term
      await place({ weekday: 4, groupId: makers }); // a group Kai isn't in
      await place({}); // on the shelf
    });
  }

  test("names the blocks that open the app to the scholar this week, as the materializer opens them", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await seedSchedule(t, w);
    const { device, spike } = await consoleRow(w);
    expect(device.todayDayKey).toBe("2026-09-28");
    expect(spike.granted).toBe(false);
    expect(spike.blocker).toBe("grant");
    expect(spike.schedule).toEqual([
      { subject: "Robotics", block: "Block E", weekdays: [1, 2, 3, 5], opensLocal: "14:50", closesLocal: "16:40" },
    ]);
    expect(device.appAccess.find((row) => row.key === "google-sheets")?.schedule).toEqual([]);
  });

  test("leaves out a day this week the school is closed, as the materializer pushes nothing then", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await seedSchedule(t, w);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId: w.institutionId,
        startDayKey: "2026-09-28",
        endDayKey: "2026-09-28",
        label: "Staff development day",
        kind: "staffOnly",
      }),
    );
    expect((await consoleRow(w)).spike.schedule).toEqual([
      { subject: "Robotics", block: "Block E", weekdays: [2, 3, 5], opensLocal: "14:50", closesLocal: "16:40" },
    ]);
  });

  test("leaves out a block in another school's term, and keeps a legacy term of the iPad's school", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await seedSchedule(t, w);
    const kulaId = await seedTestInstitution(t, { name: "Kula School", slug: "kula" });
    await t.run(async (ctx) => {
      const now = Date.now();
      // A legacy unstamped group of Kai's (the primary school's, by the lens
      // rule), placed in Kula's term and in an unstamped term, which is also
      // the primary school's (the staff aide's `termBelongsTo`).
      const legacyGroupId = await ctx.db.insert("scholarGroups", {
        teacherId: w.teacherId,
        name: "Old Robotics",
        scholarIds: [w.scholarId],
      });
      for (const [institutionId, label] of [
        [kulaId, "Kula Block K"],
        [undefined, "Block L"],
      ] as const) {
        const periodId = await ctx.db.insert("reportingPeriods", {
          label: "Fall 2026",
          startsAt: now - 30 * DAY,
          endsAt: now + 90 * DAY,
          status: "open",
          ...(institutionId ? { institutionId } : {}),
        });
        const blockId = await ctx.db.insert("scheduleBlocks", {
          periodId,
          key: "block.legacy",
          label,
          startLocal: "13:00",
          endLocal: "14:00",
          weekdays: [4],
          order: 0,
          kind: "class",
        });
        await ctx.db.insert("schedulePlacements", {
          periodId,
          groupId: legacyGroupId,
          weekday: 4,
          blockId,
          subject: "Robotics",
          teacherId: w.teacherId,
          externalAppId: w.appId,
        });
      }
    });
    expect((await consoleRow(w)).spike.schedule).toEqual([
      { subject: "Robotics", block: "Block E", weekdays: [1, 2, 3, 5], opensLocal: "14:50", closesLocal: "16:40" },
      { subject: "Robotics", block: "Block L", weekdays: [4], opensLocal: "12:45", closesLocal: "14:10" },
    ]);
  });

  test("an iPad whose scholar has moved to another school names none of that school's blocks", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await seedSchedule(t, w);
    const kulaId = await seedTestInstitution(t, { name: "Kula School", slug: "kula" });
    await t.run(async (ctx) => {
      const now = Date.now();
      // Kai moves to Kula and joins its Robotics, whose SPIKE block is in
      // Kula's term. Moving a scholar leaves Moli's claim naming them.
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: now - 30 * DAY,
        endsAt: now + 90 * DAY,
        status: "open",
        institutionId: kulaId,
      });
      const blockId = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "block.kula",
        label: "Kula Block K",
        startLocal: "13:00",
        endLocal: "14:00",
        weekdays: [4],
        order: 0,
        kind: "class",
      });
      const groupId = await ctx.db.insert("scholarGroups", {
        teacherId: w.teacherId,
        institutionId: kulaId,
        name: "Kula Robotics",
        scholarIds: [w.scholarId],
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId,
        weekday: 4,
        blockId,
        subject: "Robotics",
        teacherId: w.teacherId,
        externalAppId: w.appId,
      });
      await ctx.db.patch(w.scholarId, { institutionId: kulaId });
    });
    expect((await consoleRow(w)).spike.schedule).toEqual([]);
  });

  test("says through when opened access runs, and nothing once it is standing or over", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const target = { scholarId: w.scholarId, appId: w.appId };
    await w.asTeacher.mutation(api.scholarApps.openForScholar, { ...target, throughDay: "2026-09-30" });
    expect((await consoleRow(w)).spike).toMatchObject({ granted: true, grantThroughDay: "2026-09-30" });

    // A group grant also covers Kai: no end to report.
    await w.asTeacher.mutation(api.appAudiences.assignToAudience, {
      appId: w.appId,
      audienceKind: "group",
      audienceId: String(w.groupId),
    });
    expect((await consoleRow(w)).spike).toMatchObject({ granted: true, grantThroughDay: null });
    await w.asTeacher.mutation(api.appAudiences.unassignAudience, {
      appId: w.appId,
      audienceKind: "group",
      audienceId: String(w.groupId),
    });

    // Past the end, before the expiry job: nothing granted, nothing to end.
    vi.setSystemTime(hst("2026-10-01T00:00:00"));
    expect((await consoleRow(w)).spike).toMatchObject({ granted: false, grantThroughDay: null });

    await w.asTeacher.mutation(api.scholarApps.addToScholar, target);
    expect((await consoleRow(w)).spike).toMatchObject({ granted: true, grantThroughDay: null });
  });

  test("the scholar's Apps panel shows the last day, and drops an add that has ended", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    await w.asTeacher.mutation(api.scholarApps.openForScholar, { scholarId: w.scholarId, appId: w.appId });
    const panel = () => w.asTeacher.query(api.scholarApps.listForScholar, { scholarId: w.scholarId });
    expect(await panel()).toMatchObject([{ appId: w.appId, direct: true, directThroughDay: "2026-09-28" }]);
    vi.setSystemTime(TUESDAY_MIDNIGHT);
    expect(await panel()).toEqual([]);
  });
});
