import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import {
  seedTestInstitution,
  seedScholarInInstitution,
} from "./institutionTestHelpers";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedTwoSchools(t: ReturnType<typeof convexTest>) {
  const primaryId = await seedTestInstitution(t, {
    name: "Moli School",
    slug: "moli",
    isPrimary: true,
  });
  const partnerId = await seedTestInstitution(t, {
    name: "Kula Guest School",
    slug: "kula",
  });

  await t.run(async (ctx) => {
    await ctx.db.patch(primaryId, { timeZone: "Pacific/Honolulu" });
    await ctx.db.patch(partnerId, { timeZone: "America/Denver" });
    // Institution-agnostic closure: applies to every school.
    await ctx.db.insert("schoolClosures", {
      startDayKey: "2026-08-21",
      endDayKey: "2026-08-21",
      label: "Statehood Day",
      kind: "holiday",
    });
    await ctx.db.insert("schoolClosures", {
      institutionId: primaryId,
      startDayKey: "2026-09-07",
      endDayKey: "2026-09-07",
      label: "Labor Day",
      kind: "holiday",
    });
    await ctx.db.insert("schoolClosures", {
      institutionId: primaryId,
      startDayKey: "2026-11-27",
      endDayKey: "2026-11-27",
      label: "Day After Thanksgiving",
      kind: "staffOnly",
    });
    await ctx.db.insert("schoolClosures", {
      institutionId: partnerId,
      startDayKey: "2026-10-12",
      endDayKey: "2026-10-12",
      label: "Kula founders day",
      kind: "holiday",
    });
  });

  return { primaryId, partnerId };
}

describe("public academic calendar", () => {
  test("no slug serves the primary school's own + global closures", async () => {
    const t = convexTest(schema, modules);
    await seedTwoSchools(t);

    const calendar = await t.query(
      internal.academicCalendar.publicCalendarEvents,
      {},
    );

    expect(calendar).not.toBeNull();
    expect(calendar!.calendarName).toBe("Moli School calendar");
    expect(calendar!.timeZone).toBe("Pacific/Honolulu");
    // Every title LEADS with "No School" so it reads correctly in a parent's
    // own calendar app, where none of this app's framing survives.
    expect(calendar!.events.map((event) => event.summary)).toEqual([
      "No School — Statehood Day",
      "No School — Labor Day",
      "No School — Day After Thanksgiving",
    ]);
    expect(calendar!.events[2]).toMatchObject({
      category: "School closure",
      description: "No school for scholars; faculty in-service.",
    });
  });

  test("each school gets its OWN feed — no cross-tenant bleed", async () => {
    const t = convexTest(schema, modules);
    await seedTwoSchools(t);

    const partner = await t.query(
      internal.academicCalendar.publicCalendarEvents,
      { slug: "kula" },
    );

    expect(partner).not.toBeNull();
    expect(partner!.calendarName).toBe("Kula Guest School calendar");
    // Its own time zone, not the primary school's.
    expect(partner!.timeZone).toBe("America/Denver");
    // Its own closure + the global one, and NEVER the primary school's.
    expect(partner!.events.map((event) => event.summary)).toEqual([
      "No School — Statehood Day",
      "No School — Kula founders day",
    ]);
  });

  test("an unknown school yields no feed instead of the primary's", async () => {
    const t = convexTest(schema, modules);
    await seedTwoSchools(t);

    expect(
      await t.query(internal.academicCalendar.publicCalendarEvents, {
        slug: "no-such-school",
      }),
    ).toBeNull();
  });

  test("a suspended school has no feed", async () => {
    const t = convexTest(schema, modules);
    const { partnerId } = await seedTwoSchools(t);
    await t.run(async (ctx) => {
      await ctx.db.patch(partnerId, { disabledAt: 1_754_000_000_000 });
    });

    expect(
      await t.query(internal.academicCalendar.publicCalendarEvents, {
        slug: "kula",
      }),
    ).toBeNull();
  });

  test("a malformed row is skipped, not allowed to corrupt the whole feed", async () => {
    const t = convexTest(schema, modules);
    const { primaryId } = await seedTwoSchools(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("schoolClosures", {
        institutionId: primaryId,
        startDayKey: "not-a-date",
        endDayKey: "not-a-date",
        label: "Corrupt row",
        kind: "holiday",
      });
      await ctx.db.insert("schoolClosures", {
        institutionId: primaryId,
        startDayKey: "2026-05-04",
        endDayKey: "2026-05-01", // ends before it starts
        label: "Inverted row",
        kind: "holiday",
      });
      // Well-SHAPED but not real days. These pass a bare YYYY-MM-DD regex:
      // JS silently rolls Feb 31 forward to Mar 3, and month 13 is NaN.
      await ctx.db.insert("schoolClosures", {
        institutionId: primaryId,
        startDayKey: "2026-02-31",
        endDayKey: "2026-02-31",
        label: "Impossible day",
        kind: "holiday",
      });
      await ctx.db.insert("schoolClosures", {
        institutionId: primaryId,
        startDayKey: "2026-13-01",
        endDayKey: "2026-13-01",
        label: "Impossible month",
        kind: "holiday",
      });
    });

    const calendar = await t.query(
      internal.academicCalendar.publicCalendarEvents,
      {},
    );

    const summaries = calendar!.events.map((event) => event.summary);
    expect(summaries).not.toContain("Corrupt row");
    expect(summaries).not.toContain("Inverted row");
    expect(summaries).not.toContain("Impossible day");
    expect(summaries).not.toContain("Impossible month");
    // The good rows still ship.
    expect(summaries).toContain("No School — Labor Day");
  });

  test("a label that already says 'no school' is not prefixed twice", async () => {
    const t = convexTest(schema, modules);
    const { primaryId } = await seedTwoSchools(t);
    await t.run(async (ctx) => {
      await ctx.db.insert("schoolClosures", {
        institutionId: primaryId,
        startDayKey: "2027-04-01",
        endDayKey: "2027-04-01",
        label: "No school — teacher work day",
        kind: "staffOnly",
      });
      // A label with nothing usable still names itself in a calendar app.
      await ctx.db.insert("schoolClosures", {
        institutionId: primaryId,
        startDayKey: "2027-04-02",
        endDayKey: "2027-04-02",
        label: "   ",
        kind: "holiday",
      });
    });

    const summaries = (await t.query(
      internal.academicCalendar.publicCalendarEvents,
      {},
    ))!.events.map((event) => event.summary);

    expect(summaries).toContain("No school — teacher work day");
    expect(summaries).toContain("No School");
    expect(
      summaries.filter((summary) => /No School — No school/i.test(summary)),
    ).toEqual([]);
  });

  test("a school with no closures yields an empty feed, not an error", async () => {
    const t = convexTest(schema, modules);
    await seedTestInstitution(t, {
      name: "Hoku School",
      slug: "hoku",
      isPrimary: true,
    });

    const calendar = await t.query(
      internal.academicCalendar.publicCalendarEvents,
      {},
    );

    expect(calendar).not.toBeNull();
    expect(calendar!.events).toEqual([]);
    // Falls back to the documented default when the school has no time zone.
    expect(calendar!.timeZone).toBe("Pacific/Honolulu");
  });

  test("the served /calendar.ics carries the No School titles", async () => {
    const t = convexTest(schema, modules);
    await seedTwoSchools(t);

    const response = await t.fetch("/calendar.ics", { method: "GET" });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/calendar; charset=utf-8",
    );
    expect(body).toContain("SUMMARY:No School — Labor Day");
    expect(body).not.toContain("SUMMARY:Labor Day");
  });
});

describe("parent calendar read (upcomingForScholar)", () => {
  async function withUser(
    t: ReturnType<typeof convexTest>,
    userId: Id<"users">,
  ) {
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

  async function seedFamily(t: ReturnType<typeof convexTest>) {
    const { primaryId, partnerId } = await seedTwoSchools(t);
    const child = await seedScholarInInstitution(t, {
      institutionId: primaryId,
      name: "Oliver Stone",
      username: "oliver_stone",
    });
    const otherChild = await seedScholarInInstitution(t, {
      institutionId: partnerId,
      name: "Kai Kahale",
      username: "kai_kahale",
    });
    const parent = await t.run(async (ctx) => {
      const parentId = await ctx.db.insert("users", {
        name: "Avery Stone",
        username: "avery",
        role: "parent",
      });
      await ctx.db.insert("guardianships", {
        parentUserId: parentId,
        scholarUserId: child,
        createdBy: parentId,
      });
      return parentId;
    });
    return { parent, child, otherChild };
  }

  test("a guardian reads their own child's school calendar", async () => {
    const t = convexTest(schema, modules);
    const { parent, child } = await seedFamily(t);

    const calendar = await (
      await withUser(t, parent)
    ).query(api.academicCalendar.upcomingForScholar, { scholarId: child });

    expect(calendar).not.toBeNull();
    expect(calendar!.schoolName).toBe("Moli School");
    // The slug is what addresses the right feed — the whole point of the read.
    expect(calendar!.schoolSlug).toBe("moli");
    expect(calendar!.upcoming.map((c) => c.label)).toContain("Labor Day");
  });

  test("a guardian CANNOT read a child they are not linked to", async () => {
    const t = convexTest(schema, modules);
    const { parent, otherChild } = await seedFamily(t);

    await expect(
      (
        await withUser(t, parent)
      ).query(api.academicCalendar.upcomingForScholar, {
        scholarId: otherChild,
      }),
    ).rejects.toThrow(/Forbidden/);
  });

  test("past closures drop out; a break you are inside stays", async () => {
    const t = convexTest(schema, modules);
    const { parent, child } = await seedFamily(t);
    await t.run(async (ctx) => {
      const scholar = await ctx.db.get(child);
      await ctx.db.insert("schoolClosures", {
        institutionId: scholar!.institutionId,
        startDayKey: "1999-01-01",
        endDayKey: "1999-01-02",
        label: "Ancient history",
        kind: "holiday",
      });
      // Starts in the past, ends far in the future — still upcoming.
      await ctx.db.insert("schoolClosures", {
        institutionId: scholar!.institutionId,
        startDayKey: "1999-01-01",
        endDayKey: "2099-01-01",
        label: "The long break",
        kind: "holiday",
      });
    });

    const calendar = await (
      await withUser(t, parent)
    ).query(api.academicCalendar.upcomingForScholar, { scholarId: child });

    const labels = calendar!.upcoming.map((c) => c.label);
    expect(labels).not.toContain("Ancient history");
    expect(labels).toContain("The long break");
  });
});
