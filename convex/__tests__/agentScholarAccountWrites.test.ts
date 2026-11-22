import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type WorldSchool } from "./factories/world";
import {
  grantInstitutionMembership,
  grantStaffCapability,
  seedStaffWithMembership,
} from "./institutionTestHelpers";
// createScholarAs schedules onboarding.enrollScholar; pre-load it so the
// drain below doesn't spend its pump budget importing.
import "../onboarding";

/**
 * The agent tools `create_scholar_account` and `update_group_membership`
 * (convex/lib/scholarWriteTools.ts) have no Convex Auth identity: the surface
 * passes `callerUserId`, and these internal mutations re-check it. They share
 * their cores with the directory's Add scholar button and the group page.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedGroup(
  t: ReturnType<typeof convexTest>,
  school: WorldSchool,
  name: string,
  participation?: "enrolled_only" | "includes_program_guests",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId: school.teacher.id,
      institutionId: school.id,
      name,
      scholarIds: [],
      ...(participation ? { participation } : {}),
    }),
  );
}

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

async function groupMembers(
  t: ReturnType<typeof convexTest>,
  groupId: Id<"scholarGroups">,
) {
  return (await t.run(async (ctx) => ctx.db.get(groupId)))!.scholarIds;
}

describe("createScholarAsCaller", () => {
  test("a teacher creates a scholar in their own school", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const school = world.schools[0];

    const r = await t.mutation(internal.teacherAide.createScholarAsCaller, {
      callerUserId: school.teacher.id,
      name: "  Pua Visitor ",
      username: "puav",
    });
    await t.finishAllScheduledFunctions(() => {});

    expect(r.name).toBe("Pua Visitor");
    expect(r.username).toBe("puav");
    const user = await t.run(async (ctx) => ctx.db.get(r.scholarId));
    expect(user?.role).toBe("scholar");
    expect(user?.institutionId).toBe(school.id);
    const memberships = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", r.scholarId))
        .collect(),
    );
    expect(memberships.map((m) => m.institutionId)).toEqual([school.id]);
  });

  test("operations staff may create; a scholar and a read-only account may not", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const school = world.schools[0];

    const ok = await t.mutation(internal.teacherAide.createScholarAsCaller, {
      callerUserId: school.ops.id,
      name: "Pua Visitor",
    });
    expect(ok.username).toBeNull();

    await expect(
      t.mutation(internal.teacherAide.createScholarAsCaller, {
        callerUserId: school.scholars[0].id,
        name: "Someone",
      }),
    ).rejects.toThrow("Forbidden");

    await t.run(async (ctx) =>
      ctx.db.patch(school.teacher.id, { readOnly: true }),
    );
    await expect(
      t.mutation(internal.teacherAide.createScholarAsCaller, {
        callerUserId: school.teacher.id,
        name: "Someone",
      }),
    ).rejects.toThrow("read-only");
    await t.finishAllScheduledFunctions(() => {});
  });

  test("a teacher at a paused school is refused, never filed at the primary", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const paused = world.schools.find((s) => !s.isPrimary)!;
    await t.run(async (ctx) =>
      ctx.db.patch(paused.id, { disabledAt: Date.now() }),
    );
    const before = await t.run(async (ctx) =>
      ctx.db.query("users").collect(),
    );

    await expect(
      t.mutation(internal.teacherAide.createScholarAsCaller, {
        callerUserId: paused.teacher.id,
        name: "Pua Visitor",
      }),
    ).rejects.toThrow();

    const after = await t.run(async (ctx) => ctx.db.query("users").collect());
    expect(after.length).toBe(before.length);
  });

  test("files where the caller holds school:operations, the same school the Add scholar button picks", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const primary = world.schools.find((s) => s.isPrimary)!;
    const other = world.schools.find((s) => !s.isPrimary)!;
    // school:operations at the other school; only curriculum:edit at the
    // primary, which grants no account authority there.
    const staff = await seedStaffWithMembership(t, {
      institutionId: other.id,
      role: "staff",
    });
    await grantStaffCapability(t, staff, other.id, "school:operations");
    await grantInstitutionMembership(t, staff, primary.id, "staff");
    await grantStaffCapability(t, staff, primary.id, "curriculum:edit");

    const viaAgent = await t.mutation(
      internal.teacherAide.createScholarAsCaller,
      { callerUserId: staff, name: "Pua Visitor" },
    );
    const viaButton = await (await withUser(t, staff)).mutation(
      api.users.createScholar,
      { name: "Pua Visitor Two" },
    );
    await t.finishAllScheduledFunctions(() => {});

    const [a, b] = await t.run(async (ctx) =>
      Promise.all([
        ctx.db.get(viaAgent.scholarId),
        ctx.db.get(viaButton.userId),
      ]),
    );
    expect(a?.institutionId).toBe(other.id);
    expect(b?.institutionId).toBe(other.id);
  });

  test("refuses a taken username", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const school = world.schools[0];
    await expect(
      t.mutation(internal.teacherAide.createScholarAsCaller, {
        callerUserId: school.teacher.id,
        name: "Pua Visitor",
        username: school.scholars[0].username,
      }),
    ).rejects.toThrow("already taken");
  });
});

describe("setGroupMembershipAsCaller", () => {
  test("adds by group name, is idempotent, and removes", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const school = world.schools[0];
    const groupId = await seedGroup(t, school, "Seals", "enrolled_only");
    const scholarId = school.scholars[0].id;
    const args = {
      callerUserId: school.teacher.id,
      groupName: "seals",
      scholarId,
    };

    const added = await t.mutation(
      internal.teacherAide.setGroupMembershipAsCaller,
      { ...args, action: "add" },
    );
    expect(added).toEqual({ ok: true, groupName: "Seals", changed: true });
    expect(await groupMembers(t, groupId)).toEqual([scholarId]);

    const again = await t.mutation(
      internal.teacherAide.setGroupMembershipAsCaller,
      { ...args, action: "add" },
    );
    expect(again).toEqual({ ok: true, groupName: "Seals", changed: false });

    const removed = await t.mutation(
      internal.teacherAide.setGroupMembershipAsCaller,
      { ...args, action: "remove" },
    );
    expect(removed).toEqual({ ok: true, groupName: "Seals", changed: true });
    expect(await groupMembers(t, groupId)).toEqual([]);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("never resolves another school's group", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [mine, theirs] = world.schools;
    const otherGroup = await seedGroup(t, theirs, "Otters");

    const r = await t.mutation(internal.teacherAide.setGroupMembershipAsCaller, {
      callerUserId: mine.teacher.id,
      groupName: "Otters",
      scholarId: mine.scholars[0].id,
      action: "add",
    });
    expect(r.ok).toBe(false);
    expect(await groupMembers(t, otherGroup)).toEqual([]);
  });

  test("refuses another school's scholar", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [mine, theirs] = world.schools;
    const groupId = await seedGroup(t, mine, "Seals");

    // Thrown, so the whole mutation rolls back (the tool reports it).
    await expect(
      t.mutation(internal.teacherAide.setGroupMembershipAsCaller, {
        callerUserId: mine.teacher.id,
        groupName: "Seals",
        scholarId: theirs.scholars[0].id,
        action: "add",
      }),
    ).rejects.toThrow("Forbidden");
    expect(await groupMembers(t, groupId)).toEqual([]);
  });

  test("an ambiguous partial name changes nothing", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const school = world.schools[0];
    const a = await seedGroup(t, school, "Seals Math");
    const b = await seedGroup(t, school, "Seals Reading");

    const r = await t.mutation(internal.teacherAide.setGroupMembershipAsCaller, {
      callerUserId: school.teacher.id,
      groupName: "seals",
      scholarId: school.scholars[0].id,
      action: "add",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("more than one group");
    expect(await groupMembers(t, a)).toEqual([]);
    expect(await groupMembers(t, b)).toEqual([]);
  });

  test("a scholar caller is refused", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { schools: 1, parentsPerSchool: 0 });
    const school = world.schools[0];
    await seedGroup(t, school, "Seals");
    await expect(
      t.mutation(internal.teacherAide.setGroupMembershipAsCaller, {
        callerUserId: school.scholars[0].id,
        groupName: "Seals",
        scholarId: school.scholars[1].id,
        action: "add",
      }),
    ).rejects.toThrow("Forbidden");
  });
});

describe("moveScholarAsCaller", () => {
  test("a platform admin moves a scholar by school name; old-school groups drop them", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [from, to] = world.schools;
    const scholarId = from.scholars[0].id;
    const groupId = await seedGroup(t, from, "Seals");
    await t.run(async (ctx) => ctx.db.patch(groupId, { scholarIds: [scholarId] }));

    const r = await t.mutation(internal.institutions.moveScholarAsCaller, {
      callerUserId: world.platformAdmin!.id,
      scholarId,
      institutionName: to.name.toLowerCase(),
    });

    expect(r).toEqual({ ok: true, from: from.name, to: to.name, leftGroups: ["Seals"] });
    const scholar = await t.run(async (ctx) => ctx.db.get(scholarId));
    expect(scholar?.institutionId).toBe(to.id);
    const memberships = await t.run(async (ctx) =>
      ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", scholarId))
        .collect(),
    );
    expect(memberships.map((m) => m.institutionId)).toEqual([to.id]);
    expect(await groupMembers(t, groupId)).toEqual([]);
    await t.finishAllScheduledFunctions(() => {});
  });

  test("a school admin or teacher is refused, and nothing moves", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [from, to] = world.schools;
    const scholarId = from.scholars[0].id;
    for (const callerUserId of [from.admin.id, from.teacher.id]) {
      await expect(
        t.mutation(internal.institutions.moveScholarAsCaller, {
          callerUserId,
          scholarId,
          institutionName: to.name,
        }),
      ).rejects.toThrow("platform admin");
    }
    const scholar = await t.run(async (ctx) => ctx.db.get(scholarId));
    expect(scholar?.institutionId).toBe(from.id);
  });

  test("a read-only platform admin is refused", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [from, to] = world.schools;
    await t.run(async (ctx) =>
      ctx.db.patch(world.platformAdmin!.id, { readOnly: true }),
    );
    await expect(
      t.mutation(internal.institutions.moveScholarAsCaller, {
        callerUserId: world.platformAdmin!.id,
        scholarId: from.scholars[0].id,
        institutionName: to.name,
      }),
    ).rejects.toThrow("platform admin");
  });

  test("a partial name or a paused school changes nothing", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [from, to] = world.schools;
    const scholarId = from.scholars[0].id;
    const admin = world.platformAdmin!.id;

    const partial = await t.mutation(internal.institutions.moveScholarAsCaller, {
      callerUserId: admin,
      scholarId,
      institutionName: to.name.slice(0, 4),
    });
    expect(partial.ok).toBe(false);

    await t.run(async (ctx) => ctx.db.patch(to.id, { disabledAt: Date.now() }));
    const paused = await t.mutation(internal.institutions.moveScholarAsCaller, {
      callerUserId: admin,
      scholarId,
      institutionName: to.name,
    });
    expect(paused.ok).toBe(false);
    if (!paused.ok) expect(paused.message).toContain("paused");

    const scholar = await t.run(async (ctx) => ctx.db.get(scholarId));
    expect(scholar?.institutionId).toBe(from.id);
  });

  test("an unknown school, or the school they're already at, changes nothing", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, { parentsPerSchool: 0 });
    const [from] = world.schools;
    const scholarId = from.scholars[0].id;
    const admin = world.platformAdmin!.id;

    const unknown = await t.mutation(internal.institutions.moveScholarAsCaller, {
      callerUserId: admin,
      scholarId,
      institutionName: "Nowhere Academy",
    });
    expect(unknown.ok).toBe(false);

    const same = await t.mutation(internal.institutions.moveScholarAsCaller, {
      callerUserId: admin,
      scholarId,
      institutionName: from.name,
    });
    expect(same.ok).toBe(false);
    const scholar = await t.run(async (ctx) => ctx.db.get(scholarId));
    expect(scholar?.institutionId).toBe(from.id);
  });
});
