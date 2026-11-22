import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { makeActivity, makeLesson, makeUnit, makeWorld } from "./factories/world";
import { dayStartForDayKey } from "../../shared/institutionDay";
import { homeworkDueStatus } from "../../shared/homeworkWeek";
import { insertAssignmentWithSchedule } from "./scheduleFixtures";

// assignments.homeworkForMe hands each row the closures of its own due week
// (TRA-581), so the session header can say "due this week" on a holiday
// Thursday without a second subscription.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
// Monday, Nov 9 2026, 3pm in Honolulu.
const NOW = dayStartForDayKey("2026-11-09", TIME_ZONE) + 15 * 60 * 60_000;
const dueOn = (dayKey: string) =>
  dayStartForDayKey(dayKey, TIME_ZONE) + (24 * 60 - 1) * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("assignments.homeworkForMe dueWeekClosures", () => {
  test("each row carries only its due week's closures, from its own school", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [school, otherSchool] = world.schools;
    const scholar = school.scholars[0];
    await t.run(async (ctx) => {
      for (const s of world.schools) await ctx.db.patch(s.id, { timeZone: TIME_ZONE });
      const closure = (
        institutionId: typeof school.id,
        dayKey: string,
        label: string,
      ) =>
        ctx.db.insert("schoolClosures", {
          institutionId,
          startDayKey: dayKey,
          endDayKey: dayKey,
          label,
          kind: "holiday",
        });
      await closure(school.id, "2026-11-13", "Staff day");
      await closure(school.id, "2026-11-26", "Thanksgiving Day");
      await closure(otherSchool.id, "2026-11-12", "Other school's day");
    });

    const unitId = await makeUnit(t, school.teacher, school, { subject: "Science" });
    const lessonId = await makeLesson(t, unitId);
    const thursday = await makeActivity(t, lessonId, {
      title: "Moon journal",
      kind: "online",
      order: 0,
      systemPrompt: "...",
    });
    const nextWeek = await makeActivity(t, lessonId, {
      title: "Build a sundial",
      kind: "online",
      order: 1,
      systemPrompt: "...",
    });
    await t.run((ctx) =>
      insertAssignmentWithSchedule(ctx, {
        teacherId: school.teacher.id,
        unitId,
        scholarIds: [scholar.id],
        startedAt: NOW - 86_400_000,
        activitySchedule: [
          {
            activityId: thursday,
            mode: "homework" as const,
            setAt: NOW - 86_400_000,
            dueAt: dueOn("2026-11-12"),
          },
          {
            activityId: nextWeek,
            mode: "homework" as const,
            setAt: NOW - 86_400_000,
            dueAt: dueOn("2026-11-20"),
          },
        ],
      }),
    );

    const rows = await (await world.as.scholar(scholar)).query(
      api.assignments.homeworkForMe,
      {},
    );
    const byActivity = new Map(rows.map((row) => [row.activityId, row]));
    const thursdayRow = byActivity.get(thursday)!;
    expect(thursdayRow.dueWeekClosures).toEqual([
      { startDayKey: "2026-11-13", endDayKey: "2026-11-13", label: "Staff day" },
    ]);
    expect(byActivity.get(nextWeek)!.dueWeekClosures).toEqual([]);

    // The header phrase this feeds: the holiday Friday makes Thursday the
    // week's last school day.
    expect(
      homeworkDueStatus(
        thursdayRow.dueAt,
        NOW,
        thursdayRow.timeZone,
        thursdayRow.dueWeekClosures,
      )?.phrase,
    ).toBe("due this week");
  });
});
