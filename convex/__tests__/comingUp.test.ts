import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Freeze "now" to a Monday so the horizon (next 5 open school days) is
// deterministic: next open school day is Tue 08-25, and the window rolls across
// the weekend into Mon 08-31.
const NOW = Date.parse("2026-08-24T12:00:00Z"); // Monday
const at = (dayKey: string, hour = 12) =>
  Date.parse(`${dayKey}T${String(hour).padStart(2, "0")}:00:00Z`);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

type ScheduleEntry = {
  activityId: Id<"activities">;
  mode: "classFocus" | "homework";
  setAt?: number;
  startsAt?: number;
  endsAt?: number;
  dueAt?: number;
};

async function seedWorld(
  t: ReturnType<typeof convexTest>,
  options: { timeZone?: string } = {},
) {
  const timeZone = options.timeZone ?? "UTC";
  return await t.run(async (ctx) => {
    const institutionId = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
      timeZone,
    });
    const scholarId = await ctx.db.insert("users", {
      name: "Lehua Torres",
      username: "lehua_torres",
      role: "scholar",
      institutionId,
    });
    const teacherId = await ctx.db.insert("users", {
      name: "Daniel Char",
      username: "daniel_char",
      role: "teacher",
    });
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: "Tide Pool Ecosystems",
      emoji: "\uD83D\uDC0B",
      isActive: true,
    });
    const lessonId = await ctx.db.insert("lessons", {
      unitId,
      title: "Lesson 1",
      order: 0,
    });
    return { institutionId, scholarId, teacherId, unitId, lessonId };
  });
}

async function makeActivity(
  t: ReturnType<typeof convexTest>,
  lessonId: Id<"lessons">,
  title: string,
): Promise<Id<"activities">> {
  return await t.run((ctx) =>
    ctx.db.insert("activities", {
      lessonId,
      title,
      kind: "online",
      systemPrompt: "...",
      order: 0,
    }),
  );
}

async function seedAssignment(
  t: ReturnType<typeof convexTest>,
  args: {
    teacherId: Id<"users">;
    scholarId: Id<"users">;
    unitId: Id<"units">;
    schedule: ScheduleEntry[];
  },
) {
  return await t.run((ctx) =>
    ctx.db.insert("assignments", {
      teacherId: args.teacherId,
      unitId: args.unitId,
      scholarIds: [args.scholarId],
      startedAt: NOW - 1000 * 60 * 60 * 24,
      activitySchedule: args.schedule,
    }),
  );
}

describe("comingUpForSelf", () => {
  test("boundary: homework due on the next open school day is excluded; due after is included", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, teacherId, unitId, lessonId } = await seedWorld(t);
    const tonight = await makeActivity(t, lessonId, "Due tomorrow (tonight owns)");
    const wed = await makeActivity(t, lessonId, "Tide-pool field notes");

    await seedAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      schedule: [
        // due Tue 08-25 = next open school day → tonight card owns it.
        { activityId: tonight, mode: "homework", setAt: NOW - 1000, dueAt: at("2026-08-25") },
        // due Wed 08-26 = after the next open school day → Coming up.
        { activityId: wed, mode: "homework", setAt: NOW - 1000, dueAt: at("2026-08-26") },
      ],
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.assignments.comingUpForSelf, {
      now: NOW,
      includeWebActivities: true,
    });

    expect(result.nextOpenSchoolDayKey).toBe("2026-08-25");
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].dayKey).toBe("2026-08-26");
    expect(result.groups[0].entries).toHaveLength(1);
    expect(result.groups[0].entries[0].kind).toBe("homework");
    expect(result.groups[0].entries[0].activityId).toBe(wed);
  });

  test("horizon spans the next 5 open school days across a weekend", async () => {
    const t = convexTest(schema, modules);
    const { scholarId } = await seedWorld(t);
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.assignments.comingUpForSelf, {
      now: NOW,
    });
    expect(result.horizonDayKeys).toEqual([
      "2026-08-25", // Tue
      "2026-08-26", // Wed
      "2026-08-27", // Thu
      "2026-08-28", // Fri
      "2026-08-31", // Mon — Sat/Sun skipped
    ]);
  });

  test("horizon rolls a calendar closure day out of the window", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, institutionId } = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: "2026-08-27", // Thu closed
        endDayKey: "2026-08-27",
        label: "Staff Development Day",
        kind: "staffOnly",
      }),
    );
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.assignments.comingUpForSelf, {
      now: NOW,
    });
    expect(result.horizonDayKeys).toEqual([
      "2026-08-25", // Tue
      "2026-08-26", // Wed
      "2026-08-28", // Fri — Thu closed, skipped
      "2026-08-31", // Mon
      "2026-09-01", // Tue — window extended to keep 5 open days
    ]);
  });

  test("planned previews require a committed startsAt", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, teacherId, unitId, lessonId } = await seedWorld(t);
    const committed = await makeActivity(t, lessonId, "Map story: why here?");
    const uncommitted = await makeActivity(t, lessonId, "Shelf work (no date)");

    await seedAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      schedule: [
        // planned (setAt null) with a committed startsAt Thu → preview.
        { activityId: committed, mode: "classFocus", startsAt: at("2026-08-27") },
        // planned but no startsAt → never a preview.
        { activityId: uncommitted, mode: "classFocus" },
      ],
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.assignments.comingUpForSelf, {
      now: NOW,
      includeWebActivities: true,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].dayKey).toBe("2026-08-27");
    expect(result.groups[0].entries).toHaveLength(1);
    const entry = result.groups[0].entries[0];
    expect(entry.kind).toBe("planned");
    expect(entry.activityId).toBe(committed);
  });

  test("groups multiple items by institution-local day", async () => {
    const t = convexTest(schema, modules);
    const { scholarId, teacherId, unitId, lessonId } = await seedWorld(t);
    const wedA = await makeActivity(t, lessonId, "Wed A");
    const wedB = await makeActivity(t, lessonId, "Wed B");
    const fri = await makeActivity(t, lessonId, "Fri");

    await seedAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      schedule: [
        { activityId: wedA, mode: "homework", setAt: NOW - 1000, dueAt: at("2026-08-26", 9) },
        { activityId: wedB, mode: "homework", setAt: NOW - 1000, dueAt: at("2026-08-26", 14) },
        { activityId: fri, mode: "homework", setAt: NOW - 1000, dueAt: at("2026-08-28") },
      ],
    });

    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.assignments.comingUpForSelf, {
      now: NOW,
      includeWebActivities: true,
    });

    expect(result.groups.map((g) => g.dayKey)).toEqual([
      "2026-08-26",
      "2026-08-28",
    ]);
    expect(result.groups[0].entries.map((e) => e.activityId)).toEqual([
      wedA,
      wedB,
    ]);
  });

  test("non-scholars get an empty lookahead", async () => {
    const t = convexTest(schema, modules);
    const { teacherId } = await seedWorld(t);
    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.assignments.comingUpForSelf, {
      now: NOW,
    });
    expect(result.groups).toEqual([]);
    expect(result.horizonDayKeys).toEqual([]);
    expect(result.nextOpenSchoolDayKey).toBeNull();
  });

  test("derives day + live-window from the client `now` in the INSTITUTION timezone (midnight + endsAt)", async () => {
    // A non-default institution timezone (Tokyo, UTC+9) far from the helper's
    // Pacific/Honolulu (UTC-10) default. The two `now` buckets below straddle
    // Tokyo-local midnight; the server must roll the horizon on the institution
    // clock, and drop a live entry once the passed `now` crosses its `endsAt`.
    const t = convexTest(schema, modules);
    const { scholarId, teacherId, unitId, lessonId } = await seedWorld(t, {
      timeZone: "Asia/Tokyo",
    });
    const hw = await makeActivity(t, lessonId, "Thursday homework");

    // now1 = Mon 2026-08-24 11:00 in Tokyo (= Sun 08-23 16:00 in Honolulu, so a
    // default-timezone bug would report Sunday). endsAt is still in the future.
    const now1 = Date.parse("2026-08-24T02:00:00Z");
    // now2 = Tue 2026-08-25 00:00 in Tokyo, 13h later — past `endsAt`.
    const now2 = Date.parse("2026-08-24T15:00:00Z");
    const endsAt = Date.parse("2026-08-24T10:00:00Z"); // between now1 and now2

    await seedAssignment(t, {
      teacherId,
      scholarId,
      unitId,
      schedule: [
        {
          activityId: hw,
          mode: "homework",
          setAt: now1 - 1000,
          endsAt,
          dueAt: at("2026-08-27"), // Thu — after the next open day at BOTH nows
        },
      ],
    });

    const asScholar = await withUser(t, scholarId);

    const before = await asScholar.query(api.assignments.comingUpForSelf, {
      now: now1,
      includeWebActivities: true,
    });
    // Institution-local Monday → next open school day is Tue 08-25 (NOT Mon
    // 08-24, which the Honolulu default would produce), and the still-live
    // homework shows on Thu.
    expect(before.dayKey).toBe("2026-08-24");
    expect(before.nextOpenSchoolDayKey).toBe("2026-08-25");
    expect(before.groups).toHaveLength(1);
    expect(before.groups[0].dayKey).toBe("2026-08-27");
    expect(before.groups[0].entries[0].activityId).toBe(hw);

    const after = await asScholar.query(api.assignments.comingUpForSelf, {
      now: now2,
      includeWebActivities: true,
    });
    // Crossed Tokyo midnight → the day rolled to Tue and the horizon shifted;
    // the homework's live window (`endsAt`) has elapsed, so it drops.
    expect(after.dayKey).toBe("2026-08-25");
    expect(after.nextOpenSchoolDayKey).toBe("2026-08-26");
    expect(after.groups).toEqual([]);
  });

  test("horizon jumps across a closure longer than 60 days", async () => {
    // Summer break: a single closure row spanning ~13 weeks. A bounded
    // calendar-offset scan (≤60 days) would return a partial/empty horizon; the
    // range-jumping search must skip straight to the reopening day.
    const t = convexTest(schema, modules);
    const { scholarId, institutionId } = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: "2026-08-25", // day after NOW (Mon 08-24)
        endDayKey: "2026-11-30", // ~97 days later — well beyond a 60-day scan
        label: "Summer Break",
        kind: "holiday",
      }),
    );
    const asScholar = await withUser(t, scholarId);
    const result = await asScholar.query(api.assignments.comingUpForSelf, {
      now: NOW,
    });
    // 2026-12-01 is a Tuesday; the next 5 open weekdays follow it.
    expect(result.horizonDayKeys).toEqual([
      "2026-12-01", // Tue (reopening)
      "2026-12-02", // Wed
      "2026-12-03", // Thu
      "2026-12-04", // Fri
      "2026-12-07", // Mon — weekend skipped
    ]);
    expect(result.nextOpenSchoolDayKey).toBe("2026-12-01");
  });
});
