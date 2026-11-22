import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import { makeWorld } from "./factories/world";
import { dayStartForDayKey } from "../../shared/institutionDay";

// institutions.currentDayForScholar carries the school's closures for the
// Now tab's "This week's homework" card (TRA-581): the scholar's own school,
// from two weeks back on, and never another school's.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";
const NOW = dayStartForDayKey("2026-11-09", TIME_ZONE) + 15 * 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("institutions.currentDayForScholar closures", () => {
  test("returns the scholar's own school's closures from two weeks back on", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [schoolA, schoolB] = world.schools;
    await t.run(async (ctx) => {
      for (const school of world.schools) {
        await ctx.db.patch(school.id, { timeZone: TIME_ZONE });
      }
      const closure = (
        institutionId: typeof schoolA.id,
        startDayKey: string,
        endDayKey: string,
        label: string,
      ) =>
        ctx.db.insert("schoolClosures", {
          institutionId,
          startDayKey,
          endDayKey,
          label,
          kind: "holiday",
        });
      await closure(schoolA.id, "2026-11-11", "2026-11-11", "Veterans Day");
      await closure(schoolA.id, "2026-10-12", "2026-10-16", "Fall Break");
      await closure(schoolA.id, "2026-11-30", "2026-11-28", "Backwards row");
      await closure(schoolB.id, "2026-11-13", "2026-11-13", "Other school's day");
    });

    const asScholar = await world.as.scholar(schoolA.scholars[0]);
    const day = await asScholar.query(api.institutions.currentDayForScholar, {});
    expect(day.dayKey).toBe("2026-11-09");
    expect(day.closures).toEqual([
      { startDayKey: "2026-11-11", endDayKey: "2026-11-11", label: "Veterans Day" },
    ]);

    // A teacher can't read another school's scholar through this.
    const asOtherTeacher = await world.as.staffOf(schoolB);
    await expect(
      asOtherTeacher.query(api.institutions.currentDayForScholar, {
        scholarId: schoolA.scholars[0].id,
      }),
    ).rejects.toThrow();
  });
});
