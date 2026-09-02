import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import {
  nextOpenSchoolDayEndAt,
  schoolDayEndAt,
} from "../lib/schoolDays";
import { dayStartForDayKey } from "../../shared/institutionDay";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const TIME_ZONE = "Pacific/Honolulu";

describe("nextOpenSchoolDayEndAt", () => {
  test("rolls Friday homework to Monday end of day", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli-school-days",
        kind: "school",
        timeZone: TIME_ZONE,
      }),
    );
    const fridayNoon = Date.parse("2026-08-21T22:00:00.000Z");

    const result = await t.run((ctx) =>
      nextOpenSchoolDayEndAt(ctx, institutionId, fridayNoon, TIME_ZONE),
    );

    expect(result).toEqual({
      dayKey: "2026-08-24",
      dueAt: schoolDayEndAt("2026-08-24", TIME_ZONE),
    });
    expect(result.dueAt).toBe(
      dayStartForDayKey("2026-08-25", TIME_ZONE) - 1,
    );
  });

  test("skips an institution closure after the weekend", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "Moli School",
        slug: "moli-school-closure",
        kind: "school",
        timeZone: TIME_ZONE,
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("schoolClosures", {
        institutionId,
        startDayKey: "2026-08-24",
        endDayKey: "2026-08-24",
        label: "Staff learning day",
        kind: "staffOnly",
      }),
    );

    const result = await t.run((ctx) =>
      nextOpenSchoolDayEndAt(
        ctx,
        institutionId,
        Date.parse("2026-08-21T22:00:00.000Z"),
        TIME_ZONE,
      ),
    );

    expect(result.dayKey).toBe("2026-08-25");
    expect(result.dueAt).toBe(
      dayStartForDayKey("2026-08-26", TIME_ZONE) - 1,
    );
  });
});
