import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld } from "./factories/world";
import { grantInstitutionMembership } from "./institutionTestHelpers";

/**
 * TRA-406: reporting periods are per school. A staffer's picker must only offer
 * their own school's terms (plus legacy unscoped ones), and a report can't be
 * filed against another school's term.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const DAY = 24 * 3_600_000;

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { schools: 2, scholarsPerSchool: 1, parentsPerSchool: 0 });
  const [a, b] = world.schools;
  const ids = await t.run(async (ctx) => {
    const now = Date.now();
    const period = (label: string, institutionId?: Id<"institutions">, status: "writing" | "closed" = "writing") =>
      ctx.db.insert("reportingPeriods", {
        label,
        startsAt: now - 10 * DAY,
        endsAt: now + 10 * DAY,
        status,
        ...(institutionId ? { institutionId } : {}),
      });
    // B's term is inserted first, so an unscoped "first writing period" lands on it.
    const bPeriod = await period("B term", b.id);
    const aPeriod = await period("A term", a.id);
    const globalPeriod = await period("Legacy term", undefined, "closed");
    return { aPeriod, bPeriod, globalPeriod };
  });
  return { t, world, a, b, ...ids };
}

const labels = (rows: { label: string }[]) => rows.map((r) => r.label).sort();

describe("reporting periods are scoped to the caller's school", () => {
  test("no scope means the home school: school A never sees B's term", async () => {
    const { world, a } = await setup();
    const asA = await world.as.staffOf(a);
    expect(labels(await asA.query(api.reportingPeriods.list, {}))).toEqual(["A term", "Legacy term"]);
    expect((await asA.query(api.reportingPeriods.current, {}))?.label).toBe("A term");
  });

  test('"all" covers only schools the caller belongs to', async () => {
    const { world, a } = await setup();
    const asA = await world.as.staffOf(a);
    expect(labels(await asA.query(api.reportingPeriods.list, { scope: "all" }))).toEqual([
      "A term",
      "Legacy term",
    ]);
  });

  test("a two-school teacher scoped to one school sees only that school", async () => {
    const { t, world, a, b } = await setup();
    await grantInstitutionMembership(t, b.teacher.id, a.id);
    const asBTeacher = await world.as.staffOf(b);
    expect(labels(await asBTeacher.query(api.reportingPeriods.list, { scope: b.slug }))).toEqual([
      "B term",
      "Legacy term",
    ]);
    expect((await asBTeacher.query(api.reportingPeriods.current, { scope: b.slug }))?.label).toBe("B term");
  });

  test('a platform admin\'s "all" sees every school', async () => {
    const { world } = await setup();
    const asAdmin = await world.as.platformAdmin();
    expect(labels(await asAdmin.query(api.reportingPeriods.list, { scope: "all" }))).toEqual([
      "A term",
      "B term",
      "Legacy term",
    ]);
  });
});

describe("reports can't be filed against another school's term", () => {
  test("course narratives and Whole Child refuse a foreign period", async () => {
    const { world, a, aPeriod, bPeriod } = await setup();
    const asA = await world.as.staffOf(a);
    const scholarId = a.scholars[0].id;

    await expect(
      asA.mutation(api.courseNarratives.open, { scholarId, periodId: bPeriod, subject: "Science" }),
    ).rejects.toThrow(/different school/);
    await expect(
      asA.mutation(api.wholeChildNarratives.open, { scholarId, periodId: bPeriod }),
    ).rejects.toThrow(/different school/);

    await expect(
      asA.mutation(api.courseNarratives.open, { scholarId, periodId: aPeriod, subject: "Science" }),
    ).resolves.toBeTruthy();
    await expect(
      asA.mutation(api.wholeChildNarratives.open, { scholarId, periodId: aPeriod }),
    ).resolves.toBeTruthy();
  });
});

describe("the rest of the period surface honours the school boundary", () => {
  test("bot tools pick the scholar's own school's term", async () => {
    const { t, a, b } = await setup();
    const forA = await t.run((ctx) =>
      ctx.runQuery(internal.reportingPeriods.currentInternal, { scholarId: a.scholars[0].id }),
    );
    const forB = await t.run((ctx) =>
      ctx.runQuery(internal.reportingPeriods.currentInternal, { scholarId: b.scholars[0].id }),
    );
    expect(forA?.label).toBe("A term");
    expect(forB?.label).toBe("B term");
  });

  test("bot and observation writers refuse a foreign term", async () => {
    const { t, world, a, bPeriod } = await setup();
    const scholarId = a.scholars[0].id;
    await expect(
      t.run((ctx) =>
        ctx.runMutation(internal.courseNarratives.openInternal, {
          scholarId, teacherId: a.teacher.id, periodId: bPeriod, subject: "Science",
        }),
      ),
    ).rejects.toThrow(/different school/);
    const asA = await world.as.staffOf(a);
    await expect(
      asA.mutation(api.wholeChild.add, {
        scholarId, periodId: bPeriod, category: "execFunction", note: "Plans ahead",
      }),
    ).rejects.toThrow(/different school/);
  });

  test("a shared legacy term lists only the caller's own scholars", async () => {
    const { world, a, b, globalPeriod } = await setup();
    const asA = await world.as.staffOf(a);
    const asB = await world.as.staffOf(b);
    await asA.mutation(api.wholeChildNarratives.open, { scholarId: a.scholars[0].id, periodId: globalPeriod });
    await asB.mutation(api.wholeChildNarratives.open, { scholarId: b.scholars[0].id, periodId: globalPeriod });
    const rows = await asA.query(api.wholeChildNarratives.listForPeriod, { periodId: globalPeriod });
    expect(rows.map((r) => r.scholarId)).toEqual([a.scholars[0].id]);
  });

  test("another school's period can't be read, changed or deleted", async () => {
    const { world, a, bPeriod } = await setup();
    const asA = await world.as.staffOf(a);
    await expect(asA.query(api.reportingPeriods.get, { periodId: bPeriod })).rejects.toThrow(/not found/);
    await expect(
      asA.mutation(api.reportingPeriods.update, { periodId: bPeriod, status: "closed" }),
    ).rejects.toThrow(/not found/);
    await expect(asA.mutation(api.reportingPeriods.remove, { periodId: bPeriod })).rejects.toThrow(/not found/);
  });

  test("a new period is stamped with the caller's school, never a stranger's", async () => {
    const { t, world, a, b } = await setup();
    const asA = await world.as.staffOf(a);
    const now = Date.now();
    const base = { label: "New term", startsAt: now, endsAt: now + 30 * DAY };
    // A slug for a school A doesn't belong to isn't honoured: the lens falls back to A.
    const created = await asA.mutation(api.reportingPeriods.create, { ...base, scope: b.slug });
    expect(created?.institutionId).toBe(a.id);
    await expect(
      asA.mutation(api.reportingPeriods.create, { ...base, institutionId: b.id }),
    ).rejects.toThrow(/your own school/);
    const periods = await t.run((ctx) => ctx.db.query("reportingPeriods").collect());
    expect(periods.filter((p) => p.institutionId === b.id)).toHaveLength(1);
  });
});
