import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";
import { ensureDevInstitutions } from "../seed/institutions";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

/**
 * The Rounds anchor has to be CONFIGURABLE, not just readable.
 *
 * `lib/roundsCadence.test.ts` proves the arithmetic. This proves the anchor a
 * school actually stores reaches the board: without a writer the whole feature
 * would ship inert, every school silently pinned to the Monday 00:00 fallback,
 * and nothing would error to say so.
 *
 * Nothing here asserts a weekday is special. Thursday 15:00 appears only as
 * the value a fixture school happens to configure.
 */

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

/** Hawaii keeps one offset all year (UTC-10), so these are exact. */
const HST_OFFSET_MS = 10 * 60 * 60 * 1000;
const hstInstant = (iso: string, minutes: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) + minutes * 60_000 + HST_OFFSET_MS;
};

async function seedWorld(
  t: ReturnType<typeof convexTest>,
  options: { slug?: string; name?: string } = {},
) {
  const institutionId = await seedTestInstitution(t, {
    slug: options.slug ?? "fixture-school",
    name: options.name ?? "Fixture School",
    isPrimary: options.slug === undefined,
  });
  const admin = await seedStaffWithMembership(t, {
    institutionId,
    role: "school_admin",
    name: "Admin",
  });
  const scholar = await seedScholarInInstitution(t, {
    institutionId,
    name: "Ada",
    username: `ada-${options.slug ?? "fixture-school"}`,
  });
  const periodId = await t.run(async (ctx) =>
    ctx.db.insert("reportingPeriods", {
      label: "Current",
      startsAt: Date.now() - 30 * 86_400_000,
      endsAt: Date.now() + 30 * 86_400_000,
      status: "writing",
      institutionId,
    }),
  );
  return { institutionId, admin, scholar, periodId };
}

describe("configuring the Rounds anchor", () => {
  test("a stored anchor moves the board's week window end to end", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const admin = await withUser(t, world.admin);

    // Before configuring: the historical Monday 00:00 week. This is the
    // back-compat path every existing stored weekKey was written under.
    const before = await admin.query(api.rounds.week, {
      periodId: world.periodId,
      weekKey: "2026-08-17",
    });
    expect(before.window.startMs).toBe(hstInstant("2026-08-17", 0));
    expect(before.window.endMs).toBe(hstInstant("2026-08-24", 0));

    const saved = await admin.mutation(api.institutions.setRoundsAnchor, {
      weekday: 4,
      minutes: 15 * 60,
    });
    expect(saved.roundsAnchor).toEqual({ weekday: 4, minutes: 900 });

    const stored = await t.run(async (ctx) => ctx.db.get(world.institutionId));
    expect(stored?.roundsAnchorWeekday).toBe(4);
    expect(stored?.roundsAnchorMinutes).toBe(900);

    // After: the week runs 15:00 on the anchor day to 15:00 seven days later.
    const after = await admin.query(api.rounds.week, {
      periodId: world.periodId,
      weekKey: "2026-08-20",
    });
    expect(after.window.startMs).toBe(hstInstant("2026-08-20", 15 * 60));
    expect(after.window.endMs).toBe(hstInstant("2026-08-27", 15 * 60));
    expect(after.window.endMs - after.window.startMs).toBe(7 * 86_400_000);

    // One minute before the anchor is still the previous week; one minute
    // after is the new one — the property the whole ritual turns on.
    expect(hstInstant("2026-08-20", 15 * 60 - 1)).toBeLessThan(
      after.window.startMs,
    );
    expect(hstInstant("2026-08-20", 15 * 60 + 1)).toBeGreaterThan(
      after.window.startMs,
    );

    // And the agenda now names the configured week, not a Monday.
    const agenda = await admin.query(api.rounds.agenda, {
      periodId: world.periodId,
      weekKey: "2026-08-20",
    });
    expect(agenda.weekKey).toBe("2026-08-20");
  });

  test("the same mutation configures a morning anchor on another day", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const admin = await withUser(t, world.admin);

    await admin.mutation(api.institutions.setRoundsAnchor, {
      weekday: 2,
      minutes: 9 * 60,
    });
    // 2026-08-18 is the anchor day of that week under a Tuesday anchor.
    const view = await admin.query(api.rounds.week, {
      periodId: world.periodId,
      weekKey: "2026-08-18",
    });
    expect(view.window.startMs).toBe(hstInstant("2026-08-18", 9 * 60));
    expect(view.window.endMs).toBe(hstInstant("2026-08-25", 9 * 60));
  });

  test("out-of-range anchors are rejected, never clamped", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const admin = await withUser(t, world.admin);

    for (const bad of [
      { weekday: 7, minutes: 900 },
      { weekday: -1, minutes: 900 },
      { weekday: 3.5, minutes: 900 },
      { weekday: 4, minutes: 1440 },
      { weekday: 4, minutes: -1 },
      { weekday: 4, minutes: 90.5 },
    ]) {
      await expect(
        admin.mutation(api.institutions.setRoundsAnchor, bad),
      ).rejects.toThrow(/Rounds anchor/);
    }

    // Nothing was written — a rejected anchor must not half-apply.
    const stored = await t.run(async (ctx) => ctx.db.get(world.institutionId));
    expect(stored?.roundsAnchorWeekday).toBeUndefined();
    expect(stored?.roundsAnchorMinutes).toBeUndefined();
  });

  test("one school cannot set another school's anchor", async () => {
    const t = convexTest(schema, modules);
    const home = await seedWorld(t);
    const other = await seedWorld(t, { slug: "other-school", name: "Other" });

    const otherAdmin = await withUser(t, other.admin);
    // Ask, by scope, to configure the school this admin does NOT lead. The
    // lens refuses to honor it and falls back to their own school.
    const saved = await otherAdmin.mutation(api.institutions.setRoundsAnchor, {
      weekday: 4,
      minutes: 15 * 60,
      scope: "fixture-school",
    });
    expect(saved._id).toBe(other.institutionId);

    const victim = await t.run(async (ctx) => ctx.db.get(home.institutionId));
    expect(victim?.roundsAnchorWeekday).toBeUndefined();
    expect(victim?.roundsAnchorMinutes).toBeUndefined();
  });

  test("the school settings read-back reports the anchor actually in force", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const admin = await withUser(t, world.admin);

    // Unconfigured reads as the fallback rather than a blank that hides it.
    const before = await admin.query(api.institutions.getMySchool, {});
    expect(before.roundsAnchor).toEqual({ weekday: 1, minutes: 0 });
    expect(before.roundsCadences).toEqual([
      { kind: "academic", weekday: 1, minutes: 0 },
    ]);

    await admin.mutation(api.institutions.setRoundsAnchor, {
      weekday: 4,
      minutes: 15 * 60,
    });
    const after = await admin.query(api.institutions.getMySchool, {});
    expect(after.roundsAnchor).toEqual({ weekday: 4, minutes: 900 });
  });

  test("stores both cadence kinds and refuses a missing SEL cadence clearly", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const admin = await withUser(t, world.admin);

    await admin.mutation(api.institutions.setRoundsCadences, {
      cadences: [
        { kind: "academic", weekday: 2, minutes: 900 },
        { kind: "sel", weekday: 4, minutes: 900 },
      ],
    });
    const configured = await admin.query(api.institutions.getMySchool, {});
    expect(configured.roundsCadences).toEqual([
      { kind: "academic", weekday: 2, minutes: 900 },
      { kind: "sel", weekday: 4, minutes: 900 },
    ]);
    const stored = await t.run((ctx) => ctx.db.get(world.institutionId));
    expect(stored?.roundsAnchorWeekday).toBe(2);
    expect(stored?.roundsAnchorMinutes).toBe(900);

    await admin.mutation(api.institutions.setRoundsCadences, {
      cadences: [{ kind: "academic", weekday: 2, minutes: 900 }],
    });
    const missingSel = await admin.query(api.rounds.agenda, {
      periodId: world.periodId,
      cadence: "sel",
    });
    expect(missingSel).toMatchObject({
      configured: false,
      cadenceKind: "sel",
      weekKey: "",
      meeting: null,
      entries: [],
    });
    await expect(
      admin.mutation(api.institutions.setRoundsCadences, {
        cadences: [
          { kind: "sel", weekday: 4, minutes: 900 },
          { kind: "sel", weekday: 5, minutes: 900 },
        ],
      }),
    ).rejects.toThrow(/at most one sel/);
    await expect(
      admin.mutation(api.institutions.setRoundsCadences, {
        cadences: [{ kind: "sel", weekday: 4, minutes: 900 }],
      }),
    ).rejects.toThrow(/one academic entry/);
  });
});

describe("the dev seed configures the anchor", () => {
  test("the dev primary school gets both configured cadences, and a re-seed backfills them", async () => {
    const t = convexTest(schema, modules);

    const first = await t.run(async (ctx) => {
      const { moli } = await ensureDevInstitutions(ctx);
      return await ctx.db.get(moli);
    });
    expect(first?.roundsCadences).toEqual([
      { kind: "academic", weekday: 3, minutes: 900 },
      { kind: "sel", weekday: 5, minutes: 900 },
    ]);

    // An institution row written before the anchor existed must pick it up on
    // the next seed, or every already-provisioned worktree stays on Monday.
    await t.run(async (ctx) => {
      await ctx.db.patch(first!._id, {
        roundsCadences: undefined,
      });
    });
    const backfilled = await t.run(async (ctx) => {
      const { moli } = await ensureDevInstitutions(ctx);
      return await ctx.db.get(moli);
    });
    expect(backfilled?._id).toBe(first!._id);
    expect(backfilled?.roundsCadences).toEqual([
      { kind: "academic", weekday: 3, minutes: 900 },
      { kind: "sel", weekday: 5, minutes: 900 },
    ]);
  });

  test("a school that configured different cadences is not overwritten by a re-seed", async () => {
    const t = convexTest(schema, modules);
    const id = await t.run(async (ctx) => (await ensureDevInstitutions(ctx)).moli);
    await t.run(async (ctx) =>
      ctx.db.patch(id, {
        roundsCadences: [{ kind: "academic", weekday: 2, minutes: 540 }],
      }),
    );
    const after = await t.run(async (ctx) => {
      await ensureDevInstitutions(ctx);
      return await ctx.db.get(id);
    });
    expect(after?.roundsCadences).toEqual([
      { kind: "academic", weekday: 2, minutes: 540 },
    ]);
  });
});

describe("the operator (CLI) path", () => {
  test("names its school explicitly and refuses an unknown one", async () => {
    const t = convexTest(schema, modules);
    const home = await seedWorld(t);
    const other = await seedWorld(t, { slug: "other-school", name: "Other" });

    const saved = await t.mutation(internal.institutions.setRoundsAnchorForSlug, {
      slug: "other-school",
      weekday: 4,
      minutes: 15 * 60,
    });
    expect(saved.roundsAnchor).toEqual({ weekday: 4, minutes: 900 });

    const [changed, untouched] = await t.run(async (ctx) => [
      await ctx.db.get(other.institutionId),
      await ctx.db.get(home.institutionId),
    ]);
    expect(changed?.roundsAnchorWeekday).toBe(4);
    // Naming one school must never move another — including the primary.
    expect(untouched?.roundsAnchorWeekday).toBeUndefined();

    await expect(
      t.mutation(internal.institutions.setRoundsAnchorForSlug, {
        slug: "no-such-school",
        weekday: 4,
        minutes: 900,
      }),
    ).rejects.toThrow(/No institution with slug/);

    await expect(
      t.mutation(internal.institutions.setRoundsAnchorForSlug, {
        slug: "other-school",
        weekday: 4,
        minutes: 1440,
      }),
    ).rejects.toThrow(/Rounds anchor/);
  });

  test("sets a full cadence list for an explicitly named school", async () => {
    const t = convexTest(schema, modules);
    const world = await seedWorld(t);
    const saved = await t.mutation(
      internal.institutions.setRoundsCadencesForSlug,
      {
        slug: "fixture-school",
        cadences: [
          { kind: "academic", weekday: 2, minutes: 900 },
          { kind: "sel", weekday: 4, minutes: 900 },
        ],
      },
    );
    expect(saved.roundsCadences).toHaveLength(2);
    expect(
      (await t.run((ctx) => ctx.db.get(world.institutionId)))?.roundsCadences,
    ).toEqual(saved.roundsCadences);
    const stored = await t.run((ctx) => ctx.db.get(world.institutionId));
    expect(stored?.roundsAnchorWeekday).toBe(2);
    expect(stored?.roundsAnchorMinutes).toBe(900);
  });
});
