import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { api } from "../_generated/api";
import { makeAssignmentTools } from "../lib/assignmentTools";
import { schoolDayEndAt } from "../lib/schoolDays";
import { makeWorld } from "./factories/world";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * `give` case 4: an app or a link in front of a group right now. It shows up
 * now only, and finishes "in that class" (the group's current bell block, or
 * the day's last bell), "for a while" (minutes), or "open until" a later
 * day. get_schedule lists it with a
 * pushId, and clear_activity with that pushId ends it.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
// Tuesday 2026-11-10 in Honolulu (UTC-10, no DST).
const TUESDAY = "2026-11-10";
const hst = (dayKey: string, hhmm: string) =>
  Date.parse(`${dayKey}T${hhmm}:00.000-10:00`);

beforeEach(() => {
  // Only the clock is faked; convex-test's own timers keep running.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(hst(TUESDAY, "09:30"));
});

afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

/** A school with a teacher, the Honu group (one scholar) holding a 09:00–10:15
 *  Humanities block on Tuesdays, and the Scratch app. A second school has its
 *  own teacher and group. */
async function seedWorld(t: T) {
  const institutionId = await seedTestInstitution(t, {
    slug: "give-app-home",
    isPrimary: true,
  });
  const otherInstitutionId = await seedTestInstitution(t, {
    slug: "give-app-other",
  });
  await t.run(async (ctx) => {
    await ctx.db.patch(institutionId, { timeZone: TIME_ZONE });
    await ctx.db.patch(otherInstitutionId, { timeZone: TIME_ZONE });
  });
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    name: "Leilani Teacher",
  });
  const otherTeacher = await seedStaffWithMembership(t, {
    institutionId: otherInstitutionId,
    name: "Noe Elsewhere",
  });
  const scholar = await seedScholarInInstitution(t, {
    institutionId,
    name: "Kaimana Example",
  });
  const otherScholar = await seedScholarInInstitution(t, {
    institutionId: otherInstitutionId,
    name: "Pua Elsewhere",
  });
  const ids = await t.run(async (ctx) => {
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: hst("2026-08-17", "00:00"),
      endsAt: hst("2026-12-18", "00:00"),
      status: "open",
      institutionId,
    });
    const groupId = await ctx.db.insert("scholarGroups", {
      teacherId: teacher,
      institutionId,
      name: "Honu",
      scholarIds: [scholar],
    });
    const otherGroupId = await ctx.db.insert("scholarGroups", {
      teacherId: otherTeacher,
      institutionId: otherInstitutionId,
      name: "Manta",
      scholarIds: [otherScholar],
    });
    const blockId = await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "blockA",
      label: "Block A",
      startLocal: "09:00",
      endLocal: "10:15",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
      kind: "class",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId,
      groupId,
      weekday: 2, // Tuesday
      blockId,
      subject: "Humanities",
    });
    const appId = await ctx.db.insert("externalApps", {
      name: "Scratch",
      webUrl: "https://scratch.mit.edu/",
    });
    return { groupId, otherGroupId, appId };
  });
  return { institutionId, teacher, otherTeacher, scholar, ...ids };
}

function actionCtxFor(t: T): ActionCtx {
  return {
    runQuery: (ref: unknown, args: unknown) =>
      (t as unknown as { query: (r: unknown, a: unknown) => Promise<unknown> }).query(ref, args),
    runMutation: (ref: unknown, args: unknown) =>
      (t as unknown as { mutation: (r: unknown, a: unknown) => Promise<unknown> }).mutation(ref, args),
  } as unknown as ActionCtx;
}

async function toolsFor(
  t: T,
  callerUserId: Id<"users">,
  institutionScope?: string,
) {
  const tools = await makeAssignmentTools(actionCtxFor(t), () => {}, {
    role: "teacher",
    callerUserId,
    institutionScope,
  });
  return Object.fromEntries(tools.map((tool) => [tool.name, tool])) as Record<
    string,
    { run: (input: unknown) => Promise<string> }
  >;
}

async function allPushes(t: T) {
  return t.run((ctx) => ctx.db.query("pushes").collect());
}

describe("give an app or a link (case 4)", () => {
  test("an app by name to a group, in that class: live until the bell block ends", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = JSON.parse(
      await tools.give.run({
        appName: "scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "inClass",
      }),
    );
    expect(result).toMatchObject({ ok: true, live: true, title: "Scratch" });
    const [push] = await allPushes(t);
    expect(push._id).toBe(result.pushId);
    expect(push.target).toEqual({ kind: "app", externalAppId: w.appId });
    expect(push.audience).toEqual({ kind: "group", groupId: w.groupId });
    expect(push.timing).toEqual({ kind: "focus" });
    expect(push.endsAt).toBe(hst(TUESDAY, "10:15"));
    expect(push.afterEnd).toBe("fade");
  });

  test("an app open until a later day ends with that school day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = JSON.parse(
      await tools.give.run({
        appName: "Scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "openUntil:2026-11-12",
      }),
    );
    expect(result.ok).toBe(true);
    const [push] = await allPushes(t);
    expect(push.timing).toEqual({ kind: "openUntil" }); // TRA-726
    expect(push.endsAt).toBe(schoolDayEndAt("2026-11-12", TIME_ZONE));
    expect(push.afterEnd).toBe("fade");
  });

  test("a link with no audience goes to the whole school, open until a later day", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = JSON.parse(
      await tools.give.run({
        url: "https://video.test/reef",
        title: "Reef film",
        media: "video",
        note: "Watch the first ten minutes",
        startsNow: true,
        finish: "openUntil:2026-11-11",
      }),
    );
    expect(result.ok).toBe(true);
    const schoolName = await t.run(
      async (ctx) => (await ctx.db.get(w.institutionId))!.name,
    );
    expect(result.audience).toBe(`Every enrolled scholar at ${schoolName}`);
    const [push] = await allPushes(t);
    expect(push.target).toEqual({
      kind: "link",
      url: "https://video.test/reef",
      title: "Reef film",
      media: "video",
    });
    expect(push.audience).toEqual({ kind: "institution" });
    expect(push.institutionId).toBe(w.institutionId);
    expect(push.note).toBe("Watch the first ten minutes");
    expect(push.timing).toEqual({ kind: "openUntil" }); // TRA-726
    expect(push.endsAt).toBe(schoolDayEndAt("2026-11-11", TIME_ZONE));
    expect(push.afterEnd).toBe("fade");
  });

  test("in that class with no class meeting ends at the last bell, and is refused after it or with no classes", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    // An afternoon block on the school's grid, with Honu's Science in it:
    // the last bell is 14:45 for the school and for Honu.
    await t.run(async (ctx) => {
      const morning = (await ctx.db.query("scheduleBlocks").collect())[0];
      const afternoon = await ctx.db.insert("scheduleBlocks", {
        periodId: morning.periodId,
        key: "blockB",
        label: "Block B",
        startLocal: "13:00",
        endLocal: "14:45",
        weekdays: [1, 2, 3, 4, 5],
        order: 1,
        kind: "class",
      });
      await ctx.db.insert("schedulePlacements", {
        periodId: morning.periodId,
        groupId: w.groupId,
        weekday: 2,
        blockId: afternoon,
        subject: "Science",
      });
    });
    // A group whose scholar is in no group with a bell schedule.
    const loneScholar = await seedScholarInInstitution(t, {
      institutionId: w.institutionId,
      name: "Makana Example",
    });
    await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: w.teacher,
        institutionId: w.institutionId,
        name: "Ohana",
        scholarIds: [loneScholar],
      }),
    );
    const tools = await toolsFor(t, w.teacher);
    const lastBell = hst(TUESDAY, "14:45");

    // 09:30, the whole school: no one class, so the school's last bell.
    const wholeSchool = JSON.parse(
      await tools.give.run({
        url: "https://video.test/reef",
        title: "Reef film",
        startsNow: true,
        finish: "inClass",
      }),
    );
    expect(wholeSchool.ok).toBe(true);
    expect(wholeSchool.finish).toMatch(/until the last bell, 2:45/);
    // 10:30, Honu between classes: its last bell.
    vi.setSystemTime(hst(TUESDAY, "10:30"));
    const between = JSON.parse(
      await tools.give.run({
        appName: "Scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "inClass",
      }),
    );
    expect(between.ok).toBe(true);
    const pushes = await allPushes(t);
    expect(pushes.map((p) => [p.endsAt, p.afterEnd])).toEqual([
      [lastBell, "fade"],
      [lastBell, "fade"],
    ]);

    // A group with no classes: refused, with the other choices.
    const noBell = await tools.give.run({
      appName: "Scratch",
      groupName: "Ohana",
      startsNow: true,
      finish: "inClass",
    });
    expect(noBell).toMatch(/no classes today.*for a while, or open until/);
    // 17:20, after the last bell: refused.
    vi.setSystemTime(hst(TUESDAY, "17:20"));
    const afterSchool = await tools.give.run({
      appName: "Scratch",
      groupName: "Honu",
      startsNow: true,
      finish: "inClass",
    });
    expect(afterSchool).toMatch(/last bell has rung.*for a while, or open until/);
    expect(await allPushes(t)).toHaveLength(2);
  });

  test("for a while ends that many minutes from now, up to 90", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = JSON.parse(
      await tools.give.run({
        url: "https://kahoot.test/lunch",
        title: "Lunch Kahoot",
        startsNow: true,
        finish: "forAWhile:20",
      }),
    );
    expect(result.ok).toBe(true);
    const [push] = await allPushes(t);
    expect(push.timing).toEqual({ kind: "focus" });
    expect(push.endsAt).toBe(hst(TUESDAY, "09:50"));
    expect(push.afterEnd).toBe("fade");

    const tooLong = await tools.give.run({
      appName: "Scratch",
      groupName: "Honu",
      startsNow: true,
      finish: "forAWhile:120",
    });
    expect(tooLong).toMatch(/up to 90 minutes/);
    expect(await allPushes(t)).toHaveLength(1);
  });

  test("for a while is for an app or a link only; work has a finish", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const result = await tools.give.run({
      unitTitle: "Anything",
      groupName: "Honu",
      startsNow: true,
      finish: "forAWhile:20",
    });
    expect(result).toMatch(/isn't one of/);
  });

  test("in the passing period, in that class means the class starting within ten minutes", async () => {
    const t = convexTest(schema, modules);
    vi.setSystemTime(hst(TUESDAY, "08:52"));
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = JSON.parse(
      await tools.give.run({
        appName: "Scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "inClass",
      }),
    );
    expect(result.ok).toBe(true);
    const [push] = await allPushes(t);
    expect(push.timing).toEqual({ kind: "focus" });
    expect(push.endsAt).toBe(hst(TUESDAY, "10:15"));
    expect(push.afterEnd).toBe("fade");
  });

  test("in that class links the give to the class whose meeting sets the end, during the class and in the passing period", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const classId = await t.run(async (ctx) => {
      const block = (await ctx.db.query("scheduleBlocks").collect())[0];
      return ctx.db.insert("classes", {
        institutionId: w.institutionId,
        periodId: block.periodId,
        groupId: w.groupId,
        subject: "Humanities",
        subjectKey: "humanities",
        meetings: [{ weekday: 2, blockId: block._id }],
      });
    });
    const tools = await toolsFor(t, w.teacher);
    const give = () =>
      tools.give.run({
        appName: "Scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "inClass",
      });

    // 08:52: nothing meets now; Humanities starts at 09:00 and sets the end.
    vi.setSystemTime(hst(TUESDAY, "08:52"));
    expect(JSON.parse(await give()).ok).toBe(true);
    // 09:30: during Humanities.
    vi.setSystemTime(hst(TUESDAY, "09:30"));
    expect(JSON.parse(await give()).ok).toBe(true);

    const pushes = await allPushes(t);
    expect(pushes).toHaveLength(2);
    for (const push of pushes) {
      expect(push.endsAt).toBe(hst(TUESDAY, "10:15"));
      expect(push.classId).toBe(classId);
      expect(push.dayKey).toBe(TUESDAY);
    }
  });

  test("for a while needs at least a minute", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const result = await tools.give.run({
      appName: "Scratch",
      groupName: "Honu",
      startsNow: true,
      finish: "forAWhile:0",
    });
    expect(result).toMatch(/at least 1/);
    expect(await allPushes(t)).toHaveLength(0);
  });

  test("open until more than two weeks out is refused", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = await tools.give.run({
      appName: "Scratch",
      groupName: "Honu",
      startsNow: true,
      finish: "openUntil:2026-11-25",
    });
    expect(result).toMatch(/grant the app/);
    expect(await allPushes(t)).toHaveLength(0);
    // Fourteen days out is still allowed.
    const ok = JSON.parse(
      await tools.give.run({
        appName: "Scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "openUntil:2026-11-24",
      }),
    );
    expect(ok.ok).toBe(true);
  });

  test("an empty scholarNames list is not the whole school", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = await tools.give.run({
      appName: "Scratch",
      scholarNames: [],
      startsNow: true,
      finish: "openUntil:2026-11-11",
    });
    expect(result).toMatch(/Nothing given/);
    expect(result).not.toMatch(/whole cohort/);
    expect(await allPushes(t)).toHaveLength(0);
  });

  test("refusals write nothing: a later start, a due date, end of unit, no finish, an unknown or ambiguous app", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const base = { appName: "Scratch", groupName: "Honu" };

    const later = await tools.give.run({
      ...base,
      startsAtMs: hst(TUESDAY, "13:00"),
      finish: "inClass",
    });
    expect(later).toMatch(/Nothing given/);
    const due = await tools.give.run({
      ...base,
      startsNow: true,
      finish: "2026-11-12",
    });
    expect(due).toMatch(/Nothing given/);
    const endOfUnit = await tools.give.run({
      ...base,
      startsNow: true,
      finish: "endOfUnit",
    });
    expect(endOfUnit).toMatch(/Nothing given/);
    const noFinish = await tools.give.run({ ...base, startsNow: true });
    expect(noFinish).toMatch(/^NOT GIVEN/);
    const unknown = await tools.give.run({
      appName: "Minecraft",
      groupName: "Honu",
      startsNow: true,
      finish: "inClass",
    });
    expect(unknown).toMatch(/Nothing given/);

    await t.run((ctx) =>
      ctx.db.insert("externalApps", {
        name: "Scratch",
        webUrl: "https://scratch.example/",
      }),
    );
    const ambiguous = await tools.give.run({
      ...base,
      startsNow: true,
      finish: "inClass",
    });
    expect(ambiguous).toMatch(/scratch\.mit\.edu.*scratch\.example|scratch\.example.*scratch\.mit\.edu/);

    expect(await allPushes(t)).toHaveLength(0);
  });

  test("another school's group is refused", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    const result = await tools.give.run({
      appName: "Scratch",
      groupName: "Manta",
      startsNow: true,
      finish: "inClass",
    });
    expect(result).toMatch(/another school|No scholar group/);
    expect(await allPushes(t)).toHaveLength(0);
  });
});

describe("get_schedule and clear_activity see a live app give", () => {
  test("get_schedule lists it with a pushId; clear_activity with that pushId ends it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);
    const given = JSON.parse(
      await tools.give.run({
        appName: "Scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "inClass",
      }),
    );

    const schedule = JSON.parse(await tools.get_schedule.run({})) as Array<
      Record<string, unknown>
    >;
    expect(schedule).toEqual([
      expect.objectContaining({
        state: "live",
        pushId: given.pushId,
        title: "Scratch",
        audience: "Honu",
      }),
    ]);

    // Exactly one form: both or neither are refused, and nothing ends.
    expect(
      await tools.clear_activity.run({
        pushId: given.pushId,
        assignmentId: "x",
        activityId: "y",
      }),
    ).toMatch(/exactly one/);
    expect(await tools.clear_activity.run({})).toMatch(/exactly one/);
    expect((await allPushes(t))[0].clearedAt).toBeUndefined();

    const cleared = JSON.parse(
      await tools.clear_activity.run({ pushId: given.pushId }),
    );
    expect(cleared.ok).toBe(true);
    const [push] = await allPushes(t);
    expect(push.clearedAt).toBeDefined();
    expect(push.clearedReason).toBe("teacher");
    expect(JSON.parse(await tools.get_schedule.run({}))).toEqual([]);
  });

  test("another school's teacher can't see or end it", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const given = JSON.parse(
      await (await toolsFor(t, w.teacher)).give.run({
        appName: "Scratch",
        groupName: "Honu",
        startsNow: true,
        finish: "inClass",
      }),
    );
    const outsider = await toolsFor(t, w.otherTeacher);
    expect(JSON.parse(await outsider.get_schedule.run({}))).toEqual([]);
    expect(await outsider.clear_activity.run({ pushId: given.pushId })).toMatch(
      /another school/,
    );
    expect((await allPushes(t))[0].clearedAt).toBeUndefined();
  });

  test("a malformed or wrong-table pushId gets an answer, not a throw", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const tools = await toolsFor(t, w.teacher);

    expect(await tools.clear_activity.run({ pushId: "not-an-id" })).toMatch(
      /No live app or link/,
    );
    expect(await tools.clear_activity.run({ pushId: w.scholar })).toMatch(
      /No live app or link/,
    );
  });

  test("a teacher scoped to her second school gives, lists and ends it there", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { includePlatformAdmin: false });
    const [home, second] = world.schools;
    const teacher = home.teacher.id;
    await grantInstitutionMembership(t, teacher, second.id);
    const scoped = await toolsFor(t, teacher, second.slug);

    const given = JSON.parse(
      await scoped.give.run({
        url: "https://video.test/reef",
        title: "Reef film",
        startsNow: true,
        finish: "openUntil:2026-11-12",
      }),
    );
    expect(given.ok).toBe(true);
    expect(given.audience).toBe(`Every enrolled scholar at ${second.name}`);
    const [push] = await allPushes(t);
    expect(push.institutionId).toBe(second.id);

    // The home-school view doesn't list it; the second school's does.
    const unscoped = await toolsFor(t, teacher);
    expect(JSON.parse(await unscoped.get_schedule.run({}))).toEqual([]);
    expect(JSON.parse(await scoped.get_schedule.run({}))).toEqual([
      expect.objectContaining({ pushId: given.pushId, state: "live" }),
    ]);
    expect(
      JSON.parse(await scoped.clear_activity.run({ pushId: given.pushId })).ok,
    ).toBe(true);
    expect((await allPushes(t))[0].clearedAt).toBeDefined();
  });
});

async function signedIn(t: T, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 30 * 86_400_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("the web dialog's give (makeFocus + focusGiveChoices)", () => {
  test("the in-class hint and the write agree, for a group and for the whole school", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await signedIn(t, w.teacher);
    const nowMs = hst(TUESDAY, "09:30");

    const groupChoices = await asTeacher.query(api.pushes.focusGiveChoices, {
      groupId: w.groupId,
      nowMs,
    });
    expect(groupChoices).toMatchObject({
      inClass: { endsAt: hst(TUESDAY, "10:15"), blockLabel: "Humanities" },
    });
    const schoolChoices = await asTeacher.query(api.pushes.focusGiveChoices, {
      nowMs,
    });
    // The whole school shares no one class: the school's last bell.
    expect(schoolChoices).toMatchObject({
      inClass: { endsAt: hst(TUESDAY, "10:15"), blockLabel: null, lastBell: true },
    });
    // After the last bell, "in that class" is offered disabled, with the reason.
    const lateChoices = await asTeacher.query(api.pushes.focusGiveChoices, {
      nowMs: hst(TUESDAY, "17:20"),
    });
    expect(lateChoices).toMatchObject({
      inClass: { unavailable: expect.stringMatching(/last bell has rung/) },
    });

    await asTeacher.mutation(api.pushes.makeFocus, {
      groupId: w.groupId,
      target: { kind: "app", externalAppId: w.appId },
      finish: { kind: "inClass" },
    });
    await asTeacher.mutation(api.pushes.makeFocus, {
      target: { kind: "link", url: "https://video.test/reef", title: "Reef" },
      finish: { kind: "forAWhile", minutes: 30 },
    });
    await asTeacher.mutation(api.pushes.makeFocus, {
      groupId: w.groupId,
      target: { kind: "app", externalAppId: w.appId },
      finish: { kind: "openUntil", dayKey: "2026-11-12" },
    });
    const ends = (await allPushes(t)).map((p) => [p.endsAt, p.afterEnd]);
    expect(ends).toEqual([
      [hst(TUESDAY, "10:15"), "fade"],
      [hst(TUESDAY, "10:00"), "fade"],
      [schoolDayEndAt("2026-11-12", TIME_ZONE), "fade"],
    ]);
  });

  test("another school's group is refused, in the choices and the write", async () => {
    const t = convexTest(schema, modules);
    const w = await seedWorld(t);
    const asTeacher = await signedIn(t, w.teacher);

    expect(
      await asTeacher.query(api.pushes.focusGiveChoices, {
        groupId: w.otherGroupId,
        nowMs: hst(TUESDAY, "09:30"),
      }),
    ).toEqual({ refused: "That group belongs to another school." });
    await expect(
      asTeacher.mutation(api.pushes.makeFocus, {
        groupId: w.otherGroupId,
        target: { kind: "app", externalAppId: w.appId },
        finish: { kind: "inClass" },
      }),
    ).rejects.toThrow(/another school/);
    expect(await allPushes(t)).toHaveLength(0);
  });
});
