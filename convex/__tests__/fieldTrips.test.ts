import { convexTest, type TestConvex } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { classMeetingForGive, syncClassesForGroupPeriod } from "../lib/classLink";
import {
  GiveQuestionError,
  resolveGiveWindow,
  upcomingBellBlocks,
} from "../lib/giveWindow";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

/**
 * Field trips (TRA-601): a trip is its own record, and a class meeting of a
 * going group that overlaps the trip window doesn't meet that day. Pins:
 *   - classMeetingForGive links no give to a meeting a trip cancels, and only
 *     for the going group, an overlapping window, and a live trip;
 *   - the give window offers no cancelled block and asks the teacher instead
 *     of ending "in that class" during a trip;
 *   - the scholar's Home read names the trip and drops the blocks it covers;
 *   - staff writes stay inside one school.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
// Tuesday 2026-11-17 in Honolulu (UTC-10, no DST).
const TUESDAY = "2026-11-17";
const hst = (dayKey: string, hhmm: string) =>
  Date.parse(`${dayKey}T${hhmm}:00.000-10:00`);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(hst(TUESDAY, "08:00"));
});

afterEach(() => {
  vi.useRealTimers();
});

type T = TestConvex<typeof schema>;

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** One school with a teacher, a scholar in the Honu group, a second group,
 *  and Humanities meeting Tuesdays 09:00–10:15 plus Science 13:00–14:00. */
async function seedSchool(t: T, slug = "fixture-school") {
  const institutionId = await seedTestInstitution(t, { slug, name: `School ${slug}` });
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: TIME_ZONE }));
  const teacher = await seedStaffWithMembership(t, {
    institutionId,
    name: "Sloane Kahale",
    username: `teacher-${slug}`,
  });
  const scholar = await seedScholarInInstitution(t, {
    institutionId,
    name: "Hoku Makani",
    username: `scholar-${slug}`,
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
      teacherId: teacher,
      institutionId,
      name: "Manu",
      scholarIds: [],
    });
    const morning = await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "blockA",
      label: "Block A",
      startLocal: "09:00",
      endLocal: "10:15",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
      kind: "class",
    });
    const afternoon = await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "blockC",
      label: "Block C",
      startLocal: "13:00",
      endLocal: "14:00",
      weekdays: [1, 2, 3, 4, 5],
      order: 2,
      kind: "class",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId, groupId, weekday: 2, blockId: morning, subject: "Humanities",
    });
    await ctx.db.insert("schedulePlacements", {
      periodId, groupId, weekday: 2, blockId: afternoon, subject: "Science",
    });
    await syncClassesForGroupPeriod(ctx, periodId, groupId);
    return { periodId, groupId, otherGroupId };
  });
  return { institutionId, teacher, scholar, ...ids };
}

async function addTrip(
  t: T,
  school: Awaited<ReturnType<typeof seedSchool>>,
  overrides: Partial<{
    groupIds: Id<"scholarGroups">[];
    startLocal: string;
    endLocal: string;
    canceledAt: number;
  }> = {},
) {
  return t.run((ctx) =>
    ctx.db.insert("fieldTrips", {
      institutionId: school.institutionId,
      groupIds: [school.groupId],
      dayKey: TUESDAY,
      startLocal: "09:30",
      endLocal: "12:00",
      destination: "Kualoa Ranch",
      createdBy: school.teacher,
      updatedAt: Date.now(),
      ...overrides,
    }),
  );
}

function meetingAt(t: T, school: Awaited<ReturnType<typeof seedSchool>>, hhmm: string) {
  return t.run((ctx) =>
    classMeetingForGive(ctx, {
      institutionId: school.institutionId,
      groupIds: [school.groupId],
      at: hst(TUESDAY, hhmm),
      timeZone: TIME_ZONE,
    }),
  );
}

describe("classMeetingForGive", () => {
  test("links a give to the meeting with no trip", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    expect(await meetingAt(t, school, "09:10")).toMatchObject({ dayKey: TUESDAY });
  });

  test("a trip overlapping the meeting leaves it unlinked, even before the trip leaves", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    await addTrip(t, school);
    // 09:10 is before the 09:30 departure, but the 09:00–10:15 class overlaps
    // the trip, so it doesn't meet at all.
    expect(await meetingAt(t, school, "09:10")).toBeNull();
    // The afternoon class doesn't overlap: it still meets.
    expect(await meetingAt(t, school, "13:10")).toMatchObject({ dayKey: TUESDAY });
  });

  test("another group's trip and a canceled trip change nothing", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    await addTrip(t, school, { groupIds: [school.otherGroupId] });
    await addTrip(t, school, { canceledAt: Date.now() });
    expect(await meetingAt(t, school, "09:10")).toMatchObject({ dayKey: TUESDAY });
  });
});

describe("the give window", () => {
  test("offers no block a trip cancels", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    await addTrip(t, school);
    const blocks = await t.run((ctx) =>
      upcomingBellBlocks(ctx, {
        scholarIds: [school.scholar],
        institutionId: school.institutionId,
        timeZone: TIME_ZONE,
        nowMs: Date.now(),
        days: 0,
      }),
    );
    expect(blocks.map((b) => b.subject)).toEqual(["Science"]);
  });

  test('"in that class" during a trip asks instead of guessing an end', async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    await addTrip(t, school);
    for (const hhmm of ["09:10", "11:00"]) {
      await expect(
        t.run((ctx) =>
          resolveGiveWindow(ctx, {
            scholarIds: [school.scholar],
            timeZone: TIME_ZONE,
            startsAt: hst(TUESDAY, hhmm),
            finish: { kind: "inClass" },
          }),
        ),
      ).rejects.toThrow(GiveQuestionError);
    }
    // After the trip, the afternoon class ends the give as usual.
    const window = await t.run((ctx) =>
      resolveGiveWindow(ctx, {
        scholarIds: [school.scholar],
        timeZone: TIME_ZONE,
        startsAt: hst(TUESDAY, "13:10"),
        finish: { kind: "inClass" },
      }),
    );
    // The window also says its finish (TRA-726): in that class.
    expect(window).toEqual({ mode: "classFocus", endsAt: hst(TUESDAY, "14:00"), openUntilKind: false });
  });
});

describe("scholar Home", () => {
  test("names today's trip and drops the blocks it covers", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    const asScholar = await withUser(t, school.scholar);
    const before = await asScholar.query(api.masterSchedule.currentBlockForSelf, {
      dayKey: TUESDAY,
    });
    expect(before.trip).toBeNull();
    expect(before.blocks.map((b) => b.subject)).toEqual(["Humanities", "Science"]);

    await addTrip(t, school);
    const after = await asScholar.query(api.masterSchedule.currentBlockForSelf, {
      dayKey: TUESDAY,
    });
    expect(after.trip).toEqual({
      destination: "Kualoa Ranch",
      startLocal: "09:30",
      endLocal: "12:00",
    });
    expect(after.blocks.map((b) => b.subject)).toEqual(["Science"]);
  });
});

describe("staff writes", () => {
  const fields = {
    dayKey: TUESDAY,
    startLocal: "09:00",
    endLocal: "12:00",
    destination: "Waimānalo Farms",
    notes: "Packed lunch",
  };

  test("a teacher adds, edits and cancels a trip at their school", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    const asTeacher = await withUser(t, school.teacher);
    const tripId = await asTeacher.mutation(api.fieldTrips.create, {
      ...fields,
      groupIds: [school.groupId],
    });
    let list = await asTeacher.query(api.fieldTrips.listForSchool, {});
    expect(list.trips).toHaveLength(1);
    expect(list.trips[0]).toMatchObject({ destination: "Waimānalo Farms", notes: "Packed lunch" });

    await asTeacher.mutation(api.fieldTrips.update, {
      tripId,
      ...fields,
      groupIds: [school.groupId, school.otherGroupId],
      notes: "",
    });
    list = await asTeacher.query(api.fieldTrips.listForSchool, {});
    expect(list.trips[0].groupIds).toHaveLength(2);
    expect(list.trips[0].notes).toBeNull();

    await asTeacher.mutation(api.fieldTrips.cancel, { tripId });
    list = await asTeacher.query(api.fieldTrips.listForSchool, {});
    expect(list.trips).toEqual([]);
  });

  test("refuses bad times and missing answers", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    const asTeacher = await withUser(t, school.teacher);
    const base = { ...fields, groupIds: [school.groupId] };
    await expect(
      asTeacher.mutation(api.fieldTrips.create, { ...base, endLocal: "08:00" }),
    ).rejects.toThrow("end after it starts");
    await expect(
      asTeacher.mutation(api.fieldTrips.create, { ...base, dayKey: "2026-02-31" }),
    ).rejects.toThrow("day of the trip");
    await expect(
      asTeacher.mutation(api.fieldTrips.create, { ...base, groupIds: [] }),
    ).rejects.toThrow("Which groups");
    await expect(
      asTeacher.mutation(api.fieldTrips.create, { ...base, destination: " " }),
    ).rejects.toThrow("Where");
  });

  test("never crosses schools", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSchool(t, "home-school");
    const other = await seedSchool(t, "other-school");
    const asHome = await withUser(t, home.teacher);
    const asOther = await withUser(t, other.teacher);

    // Another school's group can't go on this school's trip.
    await expect(
      asHome.mutation(api.fieldTrips.create, { ...fields, groupIds: [other.groupId] }),
    ).rejects.toThrow("isn't at this school");

    const tripId = await asHome.mutation(api.fieldTrips.create, {
      ...fields,
      groupIds: [home.groupId],
    });
    // The other school's teacher neither sees nor changes it.
    expect((await asOther.query(api.fieldTrips.listForSchool, {})).trips).toEqual([]);
    await expect(
      asOther.mutation(api.fieldTrips.update, { tripId, ...fields, groupIds: [other.groupId] }),
    ).rejects.toThrow("Forbidden");
    await expect(asOther.mutation(api.fieldTrips.cancel, { tripId })).rejects.toThrow("Forbidden");
    // And its scholars' classes are untouched by it.
    expect(await meetingAt(t, other, "09:10")).toMatchObject({ dayKey: TUESDAY });
  });

  test("a stored group that left the school drops out on save instead of blocking it", async () => {
    const t = convexTest(schema, modules);
    const home = await seedSchool(t, "home-school");
    const other = await seedSchool(t, "other-school");
    const asHome = await withUser(t, home.teacher);
    const tripId = await asHome.mutation(api.fieldTrips.create, {
      ...fields,
      groupIds: [home.groupId, home.otherGroupId],
    });
    // Manu moves to the other school after the trip was entered.
    await t.run((ctx) => ctx.db.patch(home.otherGroupId, { institutionId: other.institutionId }));

    // Saving with the stale group still listed drops it rather than refusing.
    await asHome.mutation(api.fieldTrips.update, {
      tripId,
      ...fields,
      groupIds: [home.groupId, home.otherGroupId],
    });
    expect(await t.run(async (ctx) => (await ctx.db.get(tripId))!.groupIds)).toEqual([home.groupId]);
    // A newly named group from another school is still refused.
    await expect(
      asHome.mutation(api.fieldTrips.update, {
        tripId,
        ...fields,
        groupIds: [home.groupId, other.groupId],
      }),
    ).rejects.toThrow("isn't at this school");
  });

  test("a scholar can't write trips", async () => {
    const t = convexTest(schema, modules);
    const school = await seedSchool(t);
    const asScholar = await withUser(t, school.scholar);
    await expect(
      asScholar.mutation(api.fieldTrips.create, { ...fields, groupIds: [school.groupId] }),
    ).rejects.toThrow();
  });
});
