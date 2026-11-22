import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { makeUnit, makeWorld } from "./factories/world";
import { seedStaffWithMembership } from "./institutionTestHelpers";

/**
 * Who may change an assignment (lib/assignmentAuthority.ts): its owner, a
 * platform admin, or a school admin at the assignment's school. Another
 * teacher, or a school admin elsewhere, still gets "Not your assignment".
 * The case behind it: adding a discovery-visit child to another teacher's
 * class before the visit.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t);
  const [home, other] = world.schools;
  const unitId = await makeUnit(t, home.teacher, home);
  const asOwner = await world.as.staffOf(home);
  const assignmentId = await asOwner.mutation(api.assignments.create, {
    unitId,
    scholarIds: [home.scholars[0].id],
  });
  return { t, world, home, other, unitId, assignmentId };
}

async function roster(
  t: Awaited<ReturnType<typeof setup>>["t"],
  assignmentId: Awaited<ReturnType<typeof setup>>["assignmentId"],
) {
  return await t.run(async (ctx) => (await ctx.db.get(assignmentId))!.scholarIds);
}

describe("assignment admin authority", () => {
  test("a school admin at the assignment's school can add a scholar, on the web and through the aide", async () => {
    const { t, world, home, unitId, assignmentId } = await setup();
    const asAdmin = await world.as.staffOf(home, "school_admin");

    await asAdmin.mutation(api.assignments.addScholars, {
      assignmentId,
      scholarIds: [home.scholars[1].id],
    });
    expect(await roster(t, assignmentId)).toEqual([
      home.scholars[0].id,
      home.scholars[1].id,
    ]);

    // The Run page and the unit page both open it for her.
    expect(await asAdmin.query(api.assignments.get, { assignmentId })).not.toBeNull();
    const runs = await asAdmin.query(api.assignments.listForUnit, { unitId });
    expect(runs.map((r) => r._id)).toContain(assignmentId);

    // The aide path: remove and re-add through the internal cores.
    await t.mutation(internal.assignments.aideSetScholars, {
      callerUserId: home.admin.id,
      assignmentId,
      scholarIds: [home.scholars[0].id],
    });
    const res = await t.mutation(internal.assignments.aideAddScholars, {
      callerUserId: home.admin.id,
      assignmentId,
      scholarIds: [home.scholars[1].id],
    });
    expect(res.rosterSize).toBe(2);
    expect(
      await t.query(internal.assignments.aideGetAssignment, {
        callerUserId: home.admin.id,
        assignmentId,
      }),
    ).not.toBeNull();
  });

  test("a platform admin can add a scholar to any school's assignment", async () => {
    const { t, world, home, assignmentId } = await setup();
    const asPlatform = await world.as.platformAdmin();
    await asPlatform.mutation(api.assignments.addScholars, {
      assignmentId,
      scholarIds: [home.scholars[1].id],
    });
    expect(await roster(t, assignmentId)).toHaveLength(2);
  });

  test("another teacher, or a school admin at a different school, is still refused", async () => {
    const { t, world, home, other, unitId, assignmentId } = await setup();

    const colleague = await seedStaffWithMembership(t, {
      institutionId: home.id,
      role: "teacher",
    });
    await expect(
      t.mutation(internal.assignments.aideAddScholars, {
        callerUserId: colleague,
        assignmentId,
        scholarIds: [home.scholars[1].id],
      }),
    ).rejects.toThrow(/Not your assignment/);

    const asOtherAdmin = await world.as.staffOf(other, "school_admin");
    await expect(
      asOtherAdmin.mutation(api.assignments.addScholars, {
        assignmentId,
        scholarIds: [home.scholars[1].id],
      }),
    ).rejects.toThrow(/Not your assignment/);
    await expect(
      t.mutation(internal.assignments.aideAddScholars, {
        callerUserId: other.admin.id,
        assignmentId,
        scholarIds: [home.scholars[1].id],
      }),
    ).rejects.toThrow(/Not your assignment/);
    expect(await asOtherAdmin.query(api.assignments.get, { assignmentId })).toBeNull();
    expect(
      await t.query(internal.assignments.aideGetAssignment, {
        callerUserId: other.admin.id,
        assignmentId,
      }),
    ).toBeNull();
    const runs = await asOtherAdmin.query(api.assignments.listForUnit, { unitId });
    expect(runs.map((r) => r._id)).not.toContain(assignmentId);

    expect(await roster(t, assignmentId)).toEqual([home.scholars[0].id]);
  });

  test("a run that mixes one school's unit with another school's scholars gives neither school's admin authority", async () => {
    const { t, world, home, other, unitId } = await setup();
    // Seeded directly: the shape a teacher at both schools could create.
    const mixed = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: home.teacher.id,
        unitId,
        scholarIds: [other.scholars[0].id],
        startedAt: Date.now(),
      }),
    );
    for (const school of [home, other]) {
      const asAdmin = await world.as.staffOf(school, "school_admin");
      expect(await asAdmin.query(api.assignments.get, { assignmentId: mixed })).toBeNull();
      await expect(
        t.mutation(internal.assignments.aideAddScholars, {
          callerUserId: school.admin.id,
          assignmentId: mixed,
          scholarIds: [school.scholars[1].id],
        }),
      ).rejects.toThrow(/Not your assignment/);
    }
  });
});
