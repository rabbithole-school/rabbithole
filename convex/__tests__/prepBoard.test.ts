import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { isWithinPrepWindow } from "../lib/metaBlocks";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
  weekdayForDayKey,
} from "../../shared/institutionDay";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 3_600_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${authSessionId}`,
    issuer: "https://convex.dev",
  });
}

function prevWeekday(dayKey: string) {
  let candidate = dayKey;
  do {
    candidate = shiftDayKey(candidate, -1);
  } while (
    weekdayForDayKey(candidate) === 0 ||
    weekdayForDayKey(candidate) === 6
  );
  return candidate;
}

function nextWeekday(dayKey: string) {
  let candidate = dayKey;
  do {
    candidate = shiftDayKey(candidate, 1);
  } while (
    weekdayForDayKey(candidate) === 0 ||
    weekdayForDayKey(candidate) === 6
  );
  return candidate;
}

function noonMs(dayKey: string) {
  return dayStartForDayKey(dayKey, TIME_ZONE) + 12 * 60 * 60_000;
}

// A fixed Wednesday noon (HST), so today/prev-open/next-open are all clean
// weekdays with no closures seeded (prev = Tue, next = Thu).
function wednesdayNow() {
  let key = dayKeyForTimezone(Date.parse("2026-06-17T22:00:00.000Z"), TIME_ZONE);
  while (weekdayForDayKey(key) !== 3) key = shiftDayKey(key, 1);
  return { now: noonMs(key), todayKey: key };
}

async function seedGroupWorld(t: ReturnType<typeof convexTest>) {
  const { now, todayKey } = wednesdayNow();
  const prevKey = prevWeekday(todayKey);
  const olderKey = prevWeekday(prevKey);
  const nextKey = nextWeekday(todayKey);

  const institutionId = await seedTestInstitution(t, {
    slug: "prep-board-school",
    isPrimary: true,
  });
  await t.run((ctx) => ctx.db.patch(institutionId, { timeZone: TIME_ZONE }));
  const teacherId = await seedStaffWithMembership(t, {
    institutionId,
    name: "Lehua Torres",
    username: "prep-teacher",
  });
  const leilaniId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Leilani Park",
    username: "prep-leilani",
  });
  const koaId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Koa De Mello",
    username: "prep-koa",
  });
  const emmaId = await seedScholarInInstitution(t, {
    institutionId,
    name: "Emma Higa",
    username: "prep-emma",
  });

  const unitId = await t.run((ctx) =>
    ctx.db.insert("units", {
      teacherId,
      institutionId,
      title: "Fraction sense",
      isActive: true,
    }),
  );
  const lessonId = await t.run((ctx) =>
    ctx.db.insert("lessons", { unitId, title: "Equivalence", order: 0 }),
  );
  const fractionsActivityId = await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId,
      title: "Fraction practice",
      kind: "online",
      order: 0,
    }),
  );
  const showActivityId = await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId,
      title: "Show that 1/2 = 2/4",
      kind: "online",
      order: 1,
    }),
  );
  const olderActivityId = await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId,
      title: "Old worksheet",
      kind: "online",
      order: 2,
    }),
  );

  // One assignment targeting Leilani + Koa, with three homework entries:
  //   fractions  → due the PRIOR open school day (Tue)  ← the last-night join
  //   show       → due the NEXT open school day (Thu)   ← assigned, not last-night
  //   old        → due two open days ago (Mon)          ← neither
  const assignmentId = await t.run((ctx) =>
    ctx.db.insert("assignments", {
      teacherId,
      unitId,
      scholarIds: [leilaniId, koaId],
      startedAt: now - 7 * 24 * 60 * 60_000,
      activitySchedule: [
        {
          activityId: fractionsActivityId,
          mode: "homework",
          setAt: now - 7 * 24 * 60 * 60_000,
          dueAt: noonMs(prevKey),
        },
        {
          activityId: showActivityId,
          mode: "homework",
          setAt: now - 7 * 24 * 60 * 60_000,
          dueAt: noonMs(nextKey),
        },
        {
          activityId: olderActivityId,
          mode: "homework",
          setAt: now - 7 * 24 * 60 * 60_000,
          dueAt: noonMs(olderKey),
        },
      ],
    }),
  );

  // Leilani finished the fractions homework; Koa did not.
  await t.run((ctx) =>
    ctx.db.insert("activityCompletions", {
      scholarId: leilaniId,
      activityId: fractionsActivityId,
      unitId,
      lessonId,
      assignmentId,
      completedAt: noonMs(prevKey) - 60_000,
    }),
  );

  // A note Leilani chose for tonight (direct insert keyed to today's dayKey).
  await t.run((ctx) =>
    ctx.db.insert("takeHomePlanItems", {
      scholarId: leilaniId,
      institutionId,
      dayKey: todayKey,
      kind: "note",
      text: "bring tide-pool photos",
    }),
  );

  const groupId = await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId,
      institutionId,
      name: "Honu",
      emoji: "🐢",
      scholarIds: [leilaniId, koaId, emmaId],
    }),
  );

  return {
    now,
    todayKey,
    prevKey,
    nextKey,
    institutionId,
    teacherId,
    leilaniId,
    koaId,
    emmaId,
    fractionsActivityId,
    showActivityId,
    groupId,
  };
}

describe("prep board read model", () => {
  test("forScholarAsTeacher returns the exact same plan as forSelf", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);
    const asScholar = await withUser(t, world.leilaniId);
    const asTeacher = await withUser(t, world.teacherId);

    const own = await asScholar.query(api.takeHomePlans.forSelf, {
      now: world.now,
    });
    const asRead = await asTeacher.query(
      api.takeHomePlans.forScholarAsTeacher,
      { scholarId: world.leilaniId, now: world.now },
    );

    // One computation, two auth gates — never a re-derivation.
    expect(asRead).toEqual(own);
    // And it's genuinely non-trivial: assigned homework + a chosen note.
    expect(own.assigned.length).toBeGreaterThan(0);
    expect(own.selected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "note", text: "bring tide-pool photos" }),
      ]),
    );
  });

  test("forGroupAsTeacher denies a teacher from another institution", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);

    const otherInstitutionId = await seedTestInstitution(t, {
      slug: "other-prep-school",
    });
    const otherTeacherId = await seedStaffWithMembership(t, {
      institutionId: otherInstitutionId,
      name: "Avery Stone",
      username: "other-prep-teacher",
    });
    const asOther = await withUser(t, otherTeacherId);

    await expect(
      asOther.query(api.takeHomePlans.forGroupAsTeacher, {
        groupId: world.groupId,
        now: world.now,
      }),
    ).rejects.toThrow(/forbidden/i);

    // The home teacher CAN read it.
    const asTeacher = await withUser(t, world.teacherId);
    const board = await asTeacher.query(api.takeHomePlans.forGroupAsTeacher, {
      groupId: world.groupId,
      now: world.now,
    });
    expect(board.scholars).toHaveLength(3);
    expect(board.group).toMatchObject({ name: "Honu" });
  });

  test("forGroupAsTeacher forbids an EMPTY foreign group (no roster to intersect)", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);

    // A group stamped with a DIFFERENT institution, with an empty roster. The
    // roster intersection is vacuously "not forbidden", so only the independent
    // group-institution check can stop the home teacher leaking its name/emoji.
    const foreignInstitutionId = await seedTestInstitution(t, {
      slug: "empty-foreign-school",
    });
    const foreignGroupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: world.teacherId,
        institutionId: foreignInstitutionId,
        name: "Foreign empty",
        scholarIds: [],
      }),
    );
    const asTeacher = await withUser(t, world.teacherId);

    await expect(
      asTeacher.query(api.takeHomePlans.forGroupAsTeacher, {
        groupId: foreignGroupId,
        now: world.now,
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("forGroupAsTeacher forbids a foreign group that contains an accessible scholar", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);

    // A group stamped with a DIFFERENT institution, but whose roster includes a
    // scholar the home teacher CAN read (Leilani). Roster intersection alone
    // would accept it; the group resource is still foreign and must be denied.
    const foreignInstitutionId = await seedTestInstitution(t, {
      slug: "overlap-foreign-school",
    });
    const foreignGroupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: world.teacherId,
        institutionId: foreignInstitutionId,
        name: "Foreign overlap",
        scholarIds: [world.leilaniId],
      }),
    );
    const asTeacher = await withUser(t, world.teacherId);

    await expect(
      asTeacher.query(api.takeHomePlans.forGroupAsTeacher, {
        groupId: foreignGroupId,
        now: world.now,
      }),
    ).rejects.toThrow(/forbidden/i);
  });

  test("empty-list flag is zero assigned + zero selected for the local dayKey", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);
    const asTeacher = await withUser(t, world.teacherId);

    const board = await asTeacher.query(api.takeHomePlans.forGroupAsTeacher, {
      groupId: world.groupId,
      now: world.now,
    });
    const byId = new Map(board.scholars.map((s) => [String(s.scholarId), s]));

    // Emma has no assignments and no plan items → neutral empty list.
    const emma = byId.get(String(world.emmaId))!;
    expect(emma.emptyList).toBe(true);
    expect(emma.assigned).toHaveLength(0);
    expect(emma.selected).toHaveLength(0);

    // Leilani has assigned homework (and a note) → not empty.
    const leilani = byId.get(String(world.leilaniId))!;
    expect(leilani.emptyList).toBe(false);
  });

  test("last-night join picks only prior-open-school-day dueAt homework, named done/not-done", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);
    const asTeacher = await withUser(t, world.teacherId);

    const board = await asTeacher.query(api.takeHomePlans.forGroupAsTeacher, {
      groupId: world.groupId,
      now: world.now,
    });
    const byId = new Map(board.scholars.map((s) => [String(s.scholarId), s]));

    // Only the fractions homework (due the prior open school day) is in the
    // last-night list — NOT the Thu-due or the Mon-due activity.
    const leilani = byId.get(String(world.leilaniId))!;
    expect(leilani.lastNight).toHaveLength(1);
    expect(leilani.lastNight[0]).toMatchObject({
      activityId: world.fractionsActivityId,
      label: "Fraction practice",
      done: true,
    });

    // Koa was assigned the same homework but did not finish it.
    const koa = byId.get(String(world.koaId))!;
    expect(koa.lastNight).toHaveLength(1);
    expect(koa.lastNight[0]).toMatchObject({
      activityId: world.fractionsActivityId,
      done: false,
    });

    // Emma had nothing due.
    const emma = byId.get(String(world.emmaId))!;
    expect(emma.lastNight).toHaveLength(0);
  });

  test("forVisibleScholarsAsTeacher composes the SAME rows as forGroupAsTeacher", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);
    const asTeacher = await withUser(t, world.teacherId);

    const group = await asTeacher.query(api.takeHomePlans.forGroupAsTeacher, {
      groupId: world.groupId,
      now: world.now,
    });
    const view = await asTeacher.query(
      api.takeHomePlans.forVisibleScholarsAsTeacher,
      {
        scholarIds: [world.leilaniId, world.koaId, world.emmaId],
        now: world.now,
      },
    );

    // One composition (buildTonightPlanRows), reachable by group or by roster —
    // never a re-derivation. Sorted by name in both, so they line up row-for-row.
    expect(view.scholars).toEqual(group.scholars);
  });

  test("forVisibleScholarsAsTeacher filters out a scholar the caller cannot access", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);

    // A scholar in a DIFFERENT institution the home teacher has no membership in.
    const otherInstitutionId = await seedTestInstitution(t, {
      slug: "visible-other-school",
    });
    const foreignScholarId = await seedScholarInInstitution(t, {
      institutionId: otherInstitutionId,
      name: "Outsider Scholar",
      username: "visible-outsider",
    });

    const asTeacher = await withUser(t, world.teacherId);
    const view = await asTeacher.query(
      api.takeHomePlans.forVisibleScholarsAsTeacher,
      {
        // The client may pass anything; the server re-gates per scholar.
        scholarIds: [world.leilaniId, foreignScholarId],
        now: world.now,
      },
    );

    const ids = view.scholars.map((s) => String(s.scholarId));
    expect(ids).toContain(String(world.leilaniId));
    expect(ids).not.toContain(String(foreignScholarId));
  });

  test("forVisibleScholarsAsTeacher spans institutions for a multi-institution staffer", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);

    // A SECOND institution + a scholar there. The home teacher is granted a
    // teacher membership in it too, so the per-scholar access gate legitimately
    // reaches across both — one subscription, cross-institution, bounded by the
    // roster the staffer can see.
    const secondInstitutionId = await seedTestInstitution(t, {
      slug: "second-prep-school",
    });
    const secondScholarId = await seedScholarInInstitution(t, {
      institutionId: secondInstitutionId,
      name: "Nalu Kaimana",
      username: "second-nalu",
    });
    await grantInstitutionMembership(t, world.teacherId, secondInstitutionId);

    const asTeacher = await withUser(t, world.teacherId);
    const view = await asTeacher.query(
      api.takeHomePlans.forVisibleScholarsAsTeacher,
      {
        scholarIds: [world.leilaniId, secondScholarId],
        now: world.now,
      },
    );

    const ids = view.scholars.map((s) => String(s.scholarId));
    expect(ids).toContain(String(world.leilaniId));
    expect(ids).toContain(String(secondScholarId));
  });

  test("forVisibleScholarsAsTeacher omits a legacy scholar with no institution (resolved-but-missing, not loading)", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);

    // A legacy scholar with NO institutionId — the primary lens still lists them
    // in the roster, but `canUserAccessScholar` denies a non-admin teacher for
    // an institution-less scholar. The read must silently drop that id (so the
    // card renders an honest "not available", never a permanent ellipsis) while
    // still returning the accessible scholar's row.
    const orphanId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Orphan Scholar",
        username: "prep-orphan",
        role: "scholar",
      }),
    );

    const asTeacher = await withUser(t, world.teacherId);
    const view = await asTeacher.query(
      api.takeHomePlans.forVisibleScholarsAsTeacher,
      { scholarIds: [world.leilaniId, orphanId], now: world.now },
    );

    const ids = view.scholars.map((s) => String(s.scholarId));
    expect(ids).toContain(String(world.leilaniId));
    expect(ids).not.toContain(String(orphanId));
  });

  test("the Today prep-window row appears only inside the prep window", async () => {
    const t = convexTest(schema, modules);
    const world = await seedGroupWorld(t);

    // The pod RUNS the ritual (participation entry) — but the window now comes
    // from the bell schedule (Move 5), so also seed the canonical prep block:
    // an active Term + a kind:"prep" scheduleBlock, Mon–Fri 14:30–15:00 HST.
    await t.run((ctx) =>
      ctx.db.patch(world.groupId, {
        dailyBlocks: [
          {
            key: "prepTime",
            label: "Prep Time",
            startLocal: "14:30",
            endLocal: "15:00",
            days: [1, 2, 3, 4, 5],
            timezone: TIME_ZONE,
          },
        ],
      }),
    );
    await t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Term",
        startsAt: 0,
        endsAt: Number.MAX_SAFE_INTEGER,
        status: "open",
        institutionId: world.institutionId,
      });
      await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "scholar-practice-lab",
        label: "Scholar’s Prep",
        startLocal: "14:30",
        endLocal: "15:00",
        weekdays: [1, 2, 3, 4, 5],
        order: 8,
        kind: "prep",
      });
    });

    const asTeacher = await withUser(t, world.teacherId);
    const today = await asTeacher.query(api.teacherToday.todayForTeacher, {});
    const prep = today.prepGroups.find(
      (g) => String(g.groupId) === String(world.groupId),
    );
    expect(prep).toBeDefined();
    expect(prep).toMatchObject({ name: "Honu", startLocal: "14:30" });

    // Inside the window (a Wednesday at 14:45 HST) the row shows; outside
    // (10:00 HST, and on a Sunday) it does not — the client owns this math.
    const inside = noonMs(world.todayKey) + 2 * 60 * 60_000 + 45 * 60_000; // 14:45
    const morning = noonMs(world.todayKey) - 2 * 60 * 60_000; // 10:00
    expect(isWithinPrepWindow(prep!, inside)).toBe(true);
    expect(isWithinPrepWindow(prep!, morning)).toBe(false);
  });
});
