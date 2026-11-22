import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld } from "./factories/world";
import { instantForLocalMinutes } from "../../shared/institutionDay";
import { nextWeeklyOccurrence, repeatDaysText } from "../scheduledFreezes";
import "../deviceLock";
import "../scheduledFreezes";

// Why this file: a family's planned BunnyPad freezes (convex/scheduledFreezes.ts)
// — "6 to 7pm tonight", "every weeknight", "until 5:33pm" — and the parent
// portal's freeze card. Each plan becomes an ordinary freezeUntil at its
// start, under the same rules as a freeze the parent asks for now.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const HST = "Pacific/Honolulu";
// Tuesday 17 Nov 2026; Saturday is the 21st, Monday the 23rd.
const at = (day: string, h: number, m = 0) =>
  instantForLocalMinutes(day, h * 60 + m, HST);

afterEach(() => {
  vi.useRealTimers();
});

async function setup(nowMs: number) {
  vi.useFakeTimers();
  vi.setSystemTime(nowMs);
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { schools: 1 });
  const [school] = world.schools;
  const parent = school.parents[0];
  const child = parent.children[0];
  const deviceId = await t.run((ctx) =>
    ctx.db.insert("pairedDevices", {
      deviceId: "ipad-test",
      deviceLabel: "iPad test",
      scholarId: child.id,
      institutionId: school.id,
      pairedAt: Date.now(),
      pairedBy: school.teacher.id,
    }),
  );
  const asParent = await world.as.parent(parent);
  const freezeUntil = async () =>
    (await t.run((ctx) => ctx.db.get(deviceId)))?.freezeUntil;
  const plans = () => t.run((ctx) => ctx.db.query("scheduledFreezes").collect());
  // Move the clock to `ms` and run whatever comes due.
  const advanceTo = async (ms: number) => {
    vi.advanceTimersByTime(ms - Date.now());
    await t.finishInProgressScheduledFunctions();
  };
  return { t, world, school, parent, child, deviceId, asParent, freezeUntil, plans, advanceTo };
}

describe("pure helpers", () => {
  test("names the days a parent would", () => {
    expect(repeatDaysText([1, 2, 3, 4, 5])).toBe("every weekday");
    expect(repeatDaysText([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(repeatDaysText([0, 6])).toBe("every Saturday and Sunday");
    expect(repeatDaysText([3, 1])).toBe("every Monday and Wednesday");
  });

  test("the next weekday occurrence skips the weekend and counts one under way", () => {
    const sat = at("2026-11-21", 12);
    expect(nextWeeklyOccurrence([1, 2, 3, 4, 5], 18 * 60, 19 * 60, sat, HST)).toEqual({
      startAt: at("2026-11-23", 18),
      endAt: at("2026-11-23", 19),
    });
    const tueMid = at("2026-11-17", 18, 30);
    expect(
      nextWeeklyOccurrence([1, 2, 3, 4, 5], 18 * 60, 19 * 60, tueMid, HST)?.startAt,
    ).toBe(at("2026-11-17", 18));
  });
});

describe("planned freezes", () => {
  test("\"6 to 7pm tonight\" freezes at 6 and is gone afterwards", async () => {
    const s = await setup(at("2026-11-17", 17));
    const { message } = await s.asParent.mutation(api.scheduledFreezes.addForScholar, {
      scholarId: s.child.id,
      startMinutes: 18 * 60,
      endMinutes: 19 * 60,
    });
    expect(message).toContain("will be frozen 6pm to 7pm on Tue, Nov 17");
    expect(await s.freezeUntil()).toBeUndefined();

    await s.advanceTo(at("2026-11-17", 18) + 1000);
    expect(await s.freezeUntil()).toBe(at("2026-11-17", 19));
    expect(await s.plans()).toEqual([]);
  });

  test("a window already under way freezes now, until its end", async () => {
    const s = await setup(at("2026-11-17", 18, 30));
    const { message } = await s.asParent.mutation(api.scheduledFreezes.addForScholar, {
      scholarId: s.child.id,
      startMinutes: 18 * 60,
      endMinutes: 19 * 60,
    });
    expect(message).toContain("is being frozen now until 7pm");
    await s.advanceTo(Date.now() + 10);
    expect(await s.freezeUntil()).toBe(at("2026-11-17", 19));
  });

  test("every weeknight rolls forward from Friday to Monday", async () => {
    const s = await setup(at("2026-11-20", 12)); // Friday noon
    const { message } = await s.asParent.mutation(api.scheduledFreezes.addForScholar, {
      scholarId: s.child.id,
      startMinutes: 18 * 60,
      endMinutes: 19 * 60,
      weekdays: [1, 2, 3, 4, 5],
    });
    expect(message).toContain("6pm to 7pm every weekday, starting Fri, Nov 20");

    await s.advanceTo(at("2026-11-20", 18) + 1000);
    expect(await s.freezeUntil()).toBe(at("2026-11-20", 19));
    const [plan] = await s.plans();
    expect(plan.nextStartAt).toBe(at("2026-11-23", 18));

    const card = await s.asParent.query(api.scheduledFreezes.forParentCard, {
      scholarId: s.child.id,
    });
    expect(card?.plans.map((p) => p.text)).toEqual(["6pm to 7pm every weekday"]);
  });

  test("a removed plan never fires", async () => {
    const s = await setup(at("2026-11-17", 17));
    await s.asParent.mutation(api.scheduledFreezes.addForScholar, {
      scholarId: s.child.id,
      startMinutes: 18 * 60,
      endMinutes: 19 * 60,
    });
    const [plan] = await s.plans();
    await s.asParent.mutation(api.scheduledFreezes.removeForScholar, {
      scheduledFreezeId: plan._id,
    });
    await s.advanceTo(at("2026-11-17", 18) + 1000);
    expect(await s.freezeUntil()).toBeUndefined();
  });

  test("a school freeze in force wins over a family's plan", async () => {
    const s = await setup(at("2026-11-17", 17));
    await s.asParent.mutation(api.scheduledFreezes.addForScholar, {
      scholarId: s.child.id,
      startMinutes: 18 * 60,
      endMinutes: 19 * 60,
    });
    const schoolEnd = at("2026-11-17", 18, 30);
    await s.t.run((ctx) =>
      ctx.db.patch(s.deviceId, {
        freezeUntil: schoolEnd,
        freezeUpdatedBy: s.school.teacher.id,
      }),
    );
    await s.advanceTo(at("2026-11-17", 18) + 1000);
    expect(await s.freezeUntil()).toBe(schoolEnd);
  });

  test("refuses windows a parent can't plan, and other families' children", async () => {
    const s = await setup(at("2026-11-17", 17));
    const add = (args: {
      scholarId: Id<"users">;
      startMinutes: number;
      endMinutes: number;
    }) => s.asParent.mutation(api.scheduledFreezes.addForScholar, args);
    await expect(
      add({ scholarId: s.child.id, startMinutes: 19 * 60, endMinutes: 18 * 60 }),
    ).rejects.toThrow(/same day/);
    await expect(
      add({ scholarId: s.child.id, startMinutes: 9 * 60, endMinutes: 18 * 60 }),
    ).rejects.toThrow(/8 hours/);
    const stranger = s.school.scholars.find((x) => x.id !== s.child.id)!;
    await expect(
      add({ scholarId: stranger.id, startMinutes: 18 * 60, endMinutes: 19 * 60 }),
    ).rejects.toThrow(/not a guardian/);
  });
});

describe("planned freezes and the school day", () => {
  // Block A runs 8:30 to 3pm on weekdays; Tuesday 17 Nov is a school day.
  async function seedBells(
    s: Awaited<ReturnType<typeof setup>>,
    closures: Array<{ startDayKey: string; endDayKey: string }> = [],
  ) {
    await s.t.run(async (ctx) => {
      const periodId = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: Date.parse("2026-08-01T00:00:00Z"),
        endsAt: Date.parse("2026-12-20T00:00:00Z"),
        status: "open",
        institutionId: s.school.id,
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
      for (const c of closures) {
        await ctx.db.insert("schoolClosures", {
          institutionId: s.school.id,
          ...c,
          label: "Closed",
          kind: "holiday",
        });
      }
    });
  }
  const plan = (s: Awaited<ReturnType<typeof setup>>, start: number, end: number) =>
    s.asParent.mutation(api.scheduledFreezes.addForScholar, {
      scholarId: s.child.id,
      startMinutes: start,
      endMinutes: end,
      weekdays: [1, 2, 3, 4, 5],
    });

  test("a morning plan ends at the first bell, with no 8-hour floor", async () => {
    const s = await setup(at("2026-11-17", 6));
    await seedBells(s);
    await plan(s, 7 * 60, 15 * 60);
    await s.advanceTo(at("2026-11-17", 7) + 1000);
    expect(await s.freezeUntil()).toBe(at("2026-11-17", 8, 30));
  });

  test("an occurrence during the school day is skipped, and the plan rolls on", async () => {
    const s = await setup(at("2026-11-17", 9));
    await seedBells(s);
    await plan(s, 10 * 60, 11 * 60);
    await s.advanceTo(at("2026-11-17", 10) + 1000);
    expect(await s.freezeUntil()).toBeUndefined();
    const [row] = await s.plans();
    expect(row.nextStartAt).toBe(at("2026-11-18", 10));
  });

  test("on a day off, the same plan freezes as asked", async () => {
    const s = await setup(at("2026-11-17", 9));
    await seedBells(s, [{ startDayKey: "2026-11-17", endDayKey: "2026-11-17" }]);
    await plan(s, 10 * 60, 11 * 60);
    await s.advanceTo(at("2026-11-17", 10) + 1000);
    expect(await s.freezeUntil()).toBe(at("2026-11-17", 11));
  });

  test("an impossible date is refused", async () => {
    const s = await setup(at("2026-11-17", 9));
    await expect(
      s.asParent.mutation(api.scheduledFreezes.addForScholar, {
        scholarId: s.child.id,
        startMinutes: 18 * 60,
        endMinutes: 19 * 60,
        dayKey: "2027-02-31",
      }),
    ).rejects.toThrow(/calendar date/);
  });
});

describe("freeze now", () => {
  test("\"until 5:33pm\" ends at 5:33 school time", async () => {
    const s = await setup(at("2026-11-17", 17));
    await s.asParent.mutation(api.scheduledFreezes.freezeNowForScholar, {
      scholarId: s.child.id,
      frozen: true,
      untilClockMinutes: 17 * 60 + 33,
    });
    expect(await s.freezeUntil()).toBe(at("2026-11-17", 17, 33));

    await s.asParent.mutation(api.scheduledFreezes.freezeNowForScholar, {
      scholarId: s.child.id,
      frozen: false,
    });
    expect(await s.freezeUntil()).toBeUndefined();
  });

  test("the aide's freeze takes an end time too", async () => {
    const s = await setup(at("2026-11-17", 17));
    const result = await s.t.mutation(internal.deviceLock.freezeFromGuardian, {
      guardianUserId: s.parent.id,
      scholarId: s.child.id,
      source: "parent_sms",
      frozen: true,
      untilClockMinutes: 17 * 60 + 33,
    });
    expect(result.ok).toBe(true);
    expect(await s.freezeUntil()).toBe(at("2026-11-17", 17, 33));
  });
});
