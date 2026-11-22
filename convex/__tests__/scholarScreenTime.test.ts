// get_scholar_screen_time: the staff assistant's read of the device-activity
// rollup (deviceActivity.dailyUsageForAide + lib/screenTimeTools.ts). The
// rollup's own arithmetic is covered in deviceActivity.test.ts; this file
// covers what the assistant path adds: its gate (scholar admins only, teacher
// standing per scholar, the institution boundary), the in/outside-school split
// as the model reads it, and the per-scholar fan-out for a group.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { getFunctionName } from "convex/server";
import { averageTotals, makeScreenTimeTools } from "../lib/screenTimeTools";
import { recomputeScholarDay } from "../screenTimeDays";
import { ROLES } from "../lib/roles";
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

const TIME_ZONE = "Pacific/Honolulu";
const TUESDAY = "2026-09-08";
const SATURDAY = shiftDayKey(TUESDAY, 4);
const local = (dayKey: string, minuteOfDay: number) =>
  instantForLocalMinutes(dayKey, minuteOfDay, TIME_ZONE);

type T = ReturnType<typeof convexTest>;

async function seedInstitution(t: T, slug: string) {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: slug,
      slug,
      kind: "school",
      timeZone: TIME_ZONE,
    }),
  );
}

async function seedUser(
  t: T,
  role: "scholar" | "teacher" | "parent" | "staff",
  name: string,
  institutionId: Id<"institutions">,
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username: name.toLowerCase().replace(/\s+/g, "-"),
      role,
      institutionId,
    }),
  );
  if (role === "teacher") {
    await t.run((ctx) =>
      ctx.db.insert("memberships", { userId, role: "teacher", institutionId }),
    );
  }
  return userId;
}

/** Rabbithole on screen from `from` to `to` (minutes of the local day). */
async function foreground(
  t: T,
  scholarId: Id<"users">,
  institutionId: Id<"institutions">,
  dayKey: string,
  from: number,
  to: number,
) {
  await t.run(async (ctx) => {
    const insert = (
      kind: "app_foreground" | "heartbeat" | "app_background",
      minute: number,
    ) => {
      const clientAt = local(dayKey, minute);
      return ctx.db.insert("deviceActivityEvents", {
        userId: scholarId,
        institutionId,
        deviceId: "screen-time-tool-test",
        kind,
        clientAt,
        receivedAt: clientAt,
        dayKey: dayKeyForTimezone(clientAt, TIME_ZONE),
        context: "unknown",
      });
    };
    await insert("app_foreground", from);
    for (let minute = from + 1; minute < to; minute += 1) {
      await insert("heartbeat", minute);
    }
    await insert("app_background", to);
  });
}

async function setUp() {
  const t = convexTest(schema, modules);
  const moli = await seedInstitution(t, "moli");
  const kai = await seedInstitution(t, "kai");
  const teacherId = await seedUser(t, "teacher", "Avery Stone", moli);
  const hokuId = await seedUser(t, "scholar", "Hoku Makani", moli);
  const lehuaId = await seedUser(t, "scholar", "Lehua Torres", moli);
  const testId = await seedUser(t, "scholar", "Test Scholar", moli);
  const otherSchoolId = await seedUser(t, "scholar", "Kale Ridge", kai);
  // Hoku: 14:30–15:30 Tuesday (half in, half after the 15:00 bell), plus
  // 20 minutes on Saturday (all outside school).
  await foreground(t, hokuId, moli, TUESDAY, 14 * 60 + 30, 15 * 60 + 30);
  await foreground(t, hokuId, moli, SATURDAY, 10 * 60, 10 * 60 + 20);
  // Lehua: 10 minutes in school. The test account: hours of evening use that
  // must not move the group average.
  await foreground(t, lehuaId, moli, TUESDAY, 9 * 60, 9 * 60 + 10);
  await foreground(t, testId, moli, TUESDAY, 18 * 60, 21 * 60);
  await foreground(t, otherSchoolId, kai, TUESDAY, 9 * 60, 10 * 60);
  await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId: moli,
      name: "Seals",
      scholarIds: [hokuId, lehuaId, testId],
    }),
  );
  return { t, moli, kai, teacherId, hokuId, lehuaId, testId, otherSchoolId };
}

const readForAide = (
  t: T,
  callerUserId: Id<"users">,
  scholarId: Id<"users">,
) =>
  t.query(internal.deviceActivity.dailyUsageForAide, {
    callerUserId,
    scholarId,
    startDayKey: TUESDAY,
    endDayKey: SATURDAY,
  });

describe("deviceActivity.dailyUsageForAide", () => {
  test("a teacher reads their scholar's days with the bell split on Rabbithole foreground", async () => {
    const { t, teacherId, hokuId } = await setUp();
    const result = await readForAide(t, teacherId, hokuId);
    expect(result.readable).toBe(true);
    const byDay = new Map(result.days.map((day) => [day.dayKey, day]));
    expect(byDay.get(TUESDAY)!.foregroundMinutes).toBe(60);
    expect(byDay.get(TUESDAY)!.outsideSchool.foregroundMinutes).toBe(30);
    expect(byDay.get(SATURDAY)!.foregroundMinutes).toBe(20);
    expect(byDay.get(SATURDAY)!.outsideSchool.foregroundMinutes).toBe(20);
  });

  test("another school's scholar is not readable, and no minutes come back", async () => {
    const { t, teacherId, otherSchoolId } = await setUp();
    const result = await readForAide(t, teacherId, otherSchoolId);
    expect(result).toMatchObject({ readable: false, days: [] });
  });

  test("parents and scholars are refused outright", async () => {
    const { t, moli, hokuId } = await setUp();
    const parentId = await seedUser(t, "parent", "Sloane Kahale", moli);
    await t.run((ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: hokuId,
        createdBy: parentId,
      }),
    );
    await expect(readForAide(t, parentId, hokuId)).rejects.toThrow(/Forbidden/);
    await expect(readForAide(t, hokuId, hokuId)).rejects.toThrow(/Forbidden/);
  });

  test("base staff without a teaching role are refused", async () => {
    const { t, moli, hokuId } = await setUp();
    const staffId = await seedUser(t, "staff", "Sloane Kahale", moli);
    await expect(readForAide(t, staffId, hokuId)).rejects.toThrow(/Forbidden/);
  });

  test("follows the selected institution lens, like the staff page", async () => {
    const { t, kai, moli, teacherId, otherSchoolId, hokuId } = await setUp();
    // The teacher also teaches at the second school.
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        userId: teacherId,
        role: "teacher",
        institutionId: kai,
      }),
    );
    const read = (scholarId: Id<"users">, institutionScope: string) =>
      t.query(internal.deviceActivity.dailyUsageForAide, {
        callerUserId: teacherId,
        scholarId,
        institutionScope,
        startDayKey: TUESDAY,
        endDayKey: TUESDAY,
      });
    const scoped = await read(otherSchoolId, String(kai));
    expect(scoped.readable).toBe(true);
    expect(scoped.days.map((day) => day.foregroundMinutes)).toEqual([60]);
    // A scholar outside the selected lens is "not readable", never zero.
    const outside = await read(hokuId, String(kai));
    expect(outside).toMatchObject({ readable: false, days: [] });
    expect((await read(hokuId, String(moli))).readable).toBe(true);
  });

  test("a platform admin's all-schools view does not reach a suspended school", async () => {
    const { t, kai, otherSchoolId } = await setUp();
    const adminId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Avery Stone",
        username: "avery-admin",
        role: "platform_admin",
      }),
    );
    const read = () =>
      t.query(internal.deviceActivity.dailyUsageForAide, {
        callerUserId: adminId,
        scholarId: otherSchoolId,
        institutionScope: "all",
        startDayKey: TUESDAY,
        endDayKey: TUESDAY,
      });
    expect((await read()).readable).toBe(true);
    await t.run((ctx) => ctx.db.patch(kai, { disabledAt: Date.now() }));
    expect(await read()).toMatchObject({ readable: false, days: [] });
  });

  test("defaults to the 14 days ending today", async () => {
    const { t, teacherId, hokuId } = await setUp();
    const result = await t.query(internal.deviceActivity.dailyUsageForAide, {
      callerUserId: teacherId,
      scholarId: hokuId,
    });
    const today = dayKeyForTimezone(Date.now(), TIME_ZONE);
    expect(result.endDayKey).toBe(today);
    expect(result.startDayKey).toBe(shiftDayKey(today, -13));
  });
});

describe("averageTotals", () => {
  test("the in-school and outside parts always add up to the average total", () => {
    const one = (inside: number, outside: number) => ({
      foregroundMinutes: inside + outside,
      inSchoolForegroundMinutes: inside,
      outsideSchoolForegroundMinutes: outside,
      webActivityMinutes: 0,
      builderOnScreenMinutes: 0,
      builderActiveMinutes: 0,
      appMeasuredMinutes: 0,
      appEstimatedMinutes: 0,
      daysWithActivity: 1,
    });
    const avg = averageTotals([one(0.1, 0), one(0, 0.1)])!;
    expect(
      avg.inSchoolForegroundMinutes + avg.outsideSchoolForegroundMinutes,
    ).toBeCloseTo(avg.foregroundMinutes);
    expect(averageTotals([])).toBeNull();
  });
});

describe("get_scholar_screen_time", () => {
  /** An action context whose queries run against the test backend. */
  const usageReads: string[] = [];
  const timelineReads: string[] = [];
  const actionCtx = (t: T) =>
    ({
      runQuery: (
        ref: Parameters<typeof getFunctionName>[0],
        args: { scholarId?: string; timeline?: boolean },
      ) => {
        if (getFunctionName(ref).endsWith(":dailyUsageForAide")) {
          usageReads.push(String(args.scholarId));
          if (args.timeline) timelineReads.push(String(args.scholarId));
        }
        return (
          t.query as unknown as (ref: unknown, args: unknown) => Promise<unknown>
        )(ref, args);
      },
    }) as unknown as ActionCtx;

  async function runTool(
    t: T,
    callerUserId: Id<"users">,
    input: Record<string, unknown>,
    allowedScholarIds?: Set<Id<"users">>,
  ) {
    const [tool] = await makeScreenTimeTools(actionCtx(t), () => {}, {
      role: ROLES.TEACHER,
      callerUserId,
      allowedScholarIds,
    });
    const raw = await (
      tool as unknown as { run: (input: unknown) => Promise<string> }
    ).run({ startDate: TUESDAY, endDate: SATURDAY, ...input });
    return JSON.parse(raw);
  }

  test("is offered to teacher-class roles only", async () => {
    const t = convexTest(schema, modules);
    const ctx = actionCtx(t);
    const caller = "u_caller" as Id<"users">;
    for (const role of [ROLES.TEACHER, ROLES.SCHOOL_ADMIN, ROLES.PLATFORM_ADMIN]) {
      expect(
        await makeScreenTimeTools(ctx, () => {}, { role, callerUserId: caller }),
      ).toHaveLength(1);
    }
    for (const role of [
      ROLES.PARENT,
      ROLES.SCHOLAR,
      ROLES.STAFF,
      ROLES.CURRICULUM_DESIGNER,
    ]) {
      expect(
        await makeScreenTimeTools(ctx, () => {}, { role, callerUserId: caller }),
      ).toEqual([]);
    }
  });

  test("one scholar: in-school and outside-school foreground per day and in total", async () => {
    const { t, teacherId } = await setUp();
    const out = await runTool(t, teacherId, { scholarNames: ["Hoku"] });
    expect(out.range).toEqual({ startDate: TUESDAY, endDate: SATURDAY });
    expect(out.scholars).toHaveLength(1);
    const [hoku] = out.scholars;
    expect(hoku.totals).toMatchObject({
      foregroundMinutes: 80,
      inSchoolForegroundMinutes: 30,
      outsideSchoolForegroundMinutes: 50,
      daysWithActivity: 2,
    });
    expect(hoku.days.map((day: { date: string }) => day.date)).toEqual([
      TUESDAY,
      SATURDAY,
    ]);
    expect(out.howToRead).toMatch(/NOT proof the scholar was engaged/);
  });

  test("a group fans out per scholar, honors exclusions, and averages the rest", async () => {
    const { t, teacherId, hokuId, lehuaId } = await setUp();
    usageReads.length = 0;
    const out = await runTool(t, teacherId, {
      scholarNames: ["Hoku"],
      groupName: "seals",
      excludeScholarNames: ["Test Scholar"],
    });
    expect(out.group.name).toBe("Seals");
    expect(out.group.excluded).toEqual(["Test Scholar"]);
    expect(out.group.scholarsInAverage).toBe(2);
    expect(out.group.namedScholarsInAverage).toEqual(["Hoku Makani"]);
    // (80 + 10) / 2 foreground; (30 + 10) / 2 in school.
    expect(out.group.averagePerScholar).toMatchObject({
      foregroundMinutes: 45,
      inSchoolForegroundMinutes: 20,
      outsideSchoolForegroundMinutes: 25,
    });
    // One read per distinct scholar: the named one is not read twice, and
    // the excluded test account is not read at all.
    expect([...usageReads].sort()).toEqual([String(hokuId), String(lehuaId)].sort());
    // Named scholars keep their days; group members come back as totals.
    expect(out.scholars.map((s: { scholar: string }) => s.scholar)).toEqual([
      "Hoku Makani",
    ]);
  });

  test("a group with no readable member reports no average rather than zeros", async () => {
    const { t, teacherId } = await setUp();
    const out = await runTool(t, teacherId, {
      groupName: "Seals",
      excludeScholarNames: ["Hoku", "Lehua", "Test"],
    });
    expect(out.group.scholarsInAverage).toBe(0);
    expect(out.group.averagePerScholar).toBeNull();
    expect(out.group.averageNote).toMatch(/no average/);
  });

  test("a name outside the caller's lens is not found, and another school's scholar is never read", async () => {
    const { t, teacherId, hokuId, lehuaId, otherSchoolId } = await setUp();
    const out = await runTool(
      t,
      teacherId,
      { scholarNames: ["Kale"] },
      new Set([hokuId, lehuaId]),
    );
    expect(out.notFound).toEqual(["Kale"]);
    expect(out.scholars).toEqual([]);
    // Even if a lens let the name through, the backing query refuses it.
    const direct = await readForAide(t, teacherId, otherSchoolId);
    expect(direct.readable).toBe(false);
  });

  /** Hoku had Epic open 14:40–14:50 inside the Tuesday foreground. */
  async function withEpic(t: T, hokuId: Id<"users">) {
    await t.run(async (ctx) => {
      const appId = await ctx.db.insert("externalApps", {
        name: "Epic",
        webUrl: "https://epic.example.test",
      });
      await ctx.db.insert("webActivitySessions", {
        scholarId: hokuId,
        appId,
        startedAt: local(TUESDAY, 14 * 60 + 40),
        endedAt: local(TUESDAY, 14 * 60 + 50),
        lastHeartbeatAt: local(TUESDAY, 14 * 60 + 50),
        screenshotIds: [],
      });
    });
  }

  test("a breakdown of one scholar's day: the Day view's stretches, labeled, in school-local time", async () => {
    const { t, teacherId, hokuId } = await setUp();
    await withEpic(t, hokuId);
    const out = await runTool(t, teacherId, {
      scholarNames: ["Hoku"],
      startDate: TUESDAY,
      endDate: TUESDAY,
    });
    const [day] = out.scholars[0].days;
    expect(day.date).toBe(TUESDAY);
    expect(day.timeline.stretches).toEqual([
      {
        start: "14:30",
        end: "14:40",
        minutes: 10,
        activityType: "Rest of Rabbithole",
        label: "Rabbithole, no activity open",
      },
      {
        start: "14:40",
        end: "14:50",
        minutes: 10,
        activityType: "Web activity",
        label: "Epic",
      },
      {
        start: "14:50",
        end: "15:30",
        minutes: 40,
        activityType: "Rest of Rabbithole",
        label: "Rabbithole, no activity open",
      },
    ]);
    expect(day.timeline.totalMinutes).toBe(60);
    expect(day.timeline.schoolHours.at(-1)).toMatch(/–15:00$/);
    // Split at the 15:00 bell, by what was on screen.
    expect(day.minutesByActivityType).toEqual({
      inSchool: { "Web activity": 10, "Rest of Rabbithole": 20 },
      outsideSchool: { "Rest of Rabbithole": 30 },
    });
    expect(out.howToRead).toMatch(/Gaps between stretches are not screen time/);
  });

  test("a one-day group read keeps members to totals: only named scholars read a timeline", async () => {
    const { t, teacherId, hokuId } = await setUp();
    timelineReads.length = 0;
    const out = await runTool(t, teacherId, {
      scholarNames: ["Hoku"],
      groupName: "Seals",
      startDate: TUESDAY,
      endDate: TUESDAY,
    });
    expect(timelineReads).toEqual([String(hokuId)]);
    expect(out.scholars).toHaveLength(1);
    expect(out.scholars[0].days[0].timeline).toBeDefined();
  });

  test("a multi-day read has no timeline, and takes each day's activity types from the summary", async () => {
    const { t, moli, teacherId, hokuId } = await setUp();
    await withEpic(t, hokuId);
    // Only Tuesday has been summarized.
    await t.run((ctx) => recomputeScholarDay(ctx, hokuId, TUESDAY, moli));
    const out = await runTool(t, teacherId, { scholarNames: ["Hoku"] });
    const byDate = new Map(
      out.scholars[0].days.map((day: { date: string }) => [day.date, day]),
    );
    const tuesday = byDate.get(TUESDAY) as Record<string, unknown>;
    expect(tuesday.timeline).toBeUndefined();
    expect(tuesday.minutesByActivityType).toEqual({
      inSchool: { "Web activity": 10, "Rest of Rabbithole": 20 },
      outsideSchool: { "Rest of Rabbithole": 30 },
    });
    const saturday = byDate.get(SATURDAY) as Record<string, unknown>;
    expect(saturday.minutesByActivityType).toBeUndefined();
  });
});

describe("dailyUsageForAide with a timeline", () => {
  const readDay = (
    t: T,
    callerUserId: Id<"users">,
    scholarId: Id<"users">,
    institutionScope?: string,
  ) =>
    t.query(internal.deviceActivity.dailyUsageForAide, {
      callerUserId,
      scholarId,
      startDayKey: TUESDAY,
      endDayKey: TUESDAY,
      timeline: true,
      ...(institutionScope ? { institutionScope } : {}),
    });

  test("parents and scholars are refused; another school's teacher gets no stretches", async () => {
    const { t, kai, moli, hokuId } = await setUp();
    const parentId = await seedUser(t, "parent", "Sloane Kahale", moli);
    await t.run((ctx) =>
      ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: hokuId,
        createdBy: parentId,
      }),
    );
    await expect(readDay(t, parentId, hokuId)).rejects.toThrow(/Forbidden/);
    await expect(readDay(t, hokuId, hokuId)).rejects.toThrow(/Forbidden/);
    const strangerId = await seedUser(t, "teacher", "Rowan Pike", kai);
    expect(await readDay(t, strangerId, hokuId)).toMatchObject({
      readable: false,
      days: [],
    });
  });

  test("a range longer than a day never reads a timeline", async () => {
    const { t, teacherId, hokuId } = await setUp();
    const result = await t.query(internal.deviceActivity.dailyUsageForAide, {
      callerUserId: teacherId,
      scholarId: hokuId,
      startDayKey: TUESDAY,
      endDayKey: SATURDAY,
      timeline: true,
    });
    expect(result.days.every((day) => day.timeline === undefined)).toBe(true);
  });
});
