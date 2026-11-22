// The bell schedule is school-wide, so only a school's admins (and platform
// admins) change it (Andy, 2026-11-08). Teachers keep editing their groups'
// weekly classes. Covers the three public block mutations and the aide's
// internal variants, plus TRA-604: createBlock with no group must still check
// the term's school.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeWorld, type World } from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const ADMIN_ONLY = /Only a school admin can change the bell schedule/;
const FOREIGN = /forbidden/i;

async function setup() {
  const t = convexTest(schema, modules);
  const world = await makeWorld(t, { scholarsPerSchool: 1, parentsPerSchool: 0 });
  const [schoolA] = world.schools;
  const { periodId, blockId } = await t.run(async (ctx) => {
    const periodId = await ctx.db.insert("reportingPeriods", {
      label: "Fall 2026",
      startsAt: Date.now(),
      endsAt: Date.now() + 90 * 86_400_000,
      status: "open",
      institutionId: schoolA.id,
    });
    const blockId = await ctx.db.insert("scheduleBlocks", {
      periodId,
      key: "block-a",
      label: "Block A",
      startLocal: "08:30",
      endLocal: "09:40",
      weekdays: [1, 2, 3, 4, 5],
      order: 0,
    });
    return { periodId, blockId };
  });
  return { t, world, periodId, blockId };
}

type Caller = "teacher" | "schoolAdmin" | "platformAdmin" | "otherSchoolAdmin";

async function identityFor(world: World, who: Caller) {
  const [schoolA, schoolB] = world.schools;
  if (who === "teacher") return world.as.staffOf(schoolA, "teacher");
  if (who === "schoolAdmin") return world.as.staffOf(schoolA, "school_admin");
  if (who === "otherSchoolAdmin") return world.as.staffOf(schoolB, "school_admin");
  return world.as.platformAdmin();
}

function userIdFor(world: World, who: Caller): Id<"users"> {
  const [schoolA, schoolB] = world.schools;
  if (who === "teacher") return schoolA.teacher.id;
  if (who === "schoolAdmin") return schoolA.admin.id;
  if (who === "otherSchoolAdmin") return schoolB.admin.id;
  return world.platformAdmin!.id;
}

const EXPECT: Record<Caller, RegExp | null> = {
  teacher: ADMIN_ONLY,
  schoolAdmin: null,
  platformAdmin: null,
  otherSchoolAdmin: FOREIGN,
};

type Harness = ReturnType<typeof convexTest<typeof schema.tables>>;

async function blockCount(t: Harness, periodId: Id<"reportingPeriods">) {
  return t.run(async (ctx) =>
    (await ctx.db.query("scheduleBlocks").withIndex("by_period", (q) => q.eq("periodId", periodId)).collect()).length,
  );
}

describe.each<Caller>(["teacher", "schoolAdmin", "platformAdmin", "otherSchoolAdmin"])(
  "bell schedule as %s",
  (who) => {
    const refusal = EXPECT[who];

    test("createBlock (no group, TRA-604)", async () => {
      const { t, world, periodId } = await setup();
      const as = await identityFor(world, who);
      const call = as.mutation(api.masterSchedule.createBlock, {
        periodId,
        label: "Block F",
        startLocal: "15:00",
        endLocal: "15:45",
      });
      if (refusal) {
        await expect(call).rejects.toThrow(refusal);
        expect(await blockCount(t, periodId)).toBe(1);
      } else {
        await call;
        expect(await blockCount(t, periodId)).toBe(2);
      }
    });

    test("updateBlock", async () => {
      const { t, world, blockId } = await setup();
      const as = await identityFor(world, who);
      const call = as.mutation(api.masterSchedule.updateBlock, { blockId, label: "Renamed" });
      if (refusal) await expect(call).rejects.toThrow(refusal);
      else await call;
      const block = await t.run((ctx) => ctx.db.get(blockId));
      expect(block?.label).toBe(refusal ? "Block A" : "Renamed");
    });

    test("removeBlock", async () => {
      const { t, world, blockId } = await setup();
      const as = await identityFor(world, who);
      const call = as.mutation(api.masterSchedule.removeBlock, { blockId });
      if (refusal) await expect(call).rejects.toThrow(refusal);
      else await call;
      expect(Boolean(await t.run((ctx) => ctx.db.get(blockId)))).toBe(Boolean(refusal));
    });

    test("aide create / update / remove", async () => {
      const { t, world, periodId, blockId } = await setup();
      const callerUserId = userIdFor(world, who);
      const create = t.mutation(internal.masterSchedule.aideCreateBlock, {
        callerUserId,
        periodId,
        label: "Block F",
        startLocal: "15:00",
        endLocal: "15:45",
      });
      const update = () =>
        t.mutation(internal.masterSchedule.aideUpdateBlock, { callerUserId, blockId, label: "Renamed" });
      const remove = () =>
        t.mutation(internal.masterSchedule.aideRemoveBlock, { callerUserId, blockId });
      if (refusal) {
        await expect(create).rejects.toThrow(refusal);
        await expect(update()).rejects.toThrow(refusal);
        await expect(remove()).rejects.toThrow(refusal);
        expect(await blockCount(t, periodId)).toBe(1);
      } else {
        await create;
        await update();
        await remove();
        expect(await blockCount(t, periodId)).toBe(1); // one added, one removed
      }
    });
  },
);

test("a teacher still edits their group's weekly classes", async () => {
  const { t, world, periodId, blockId } = await setup();
  const [schoolA] = world.schools;
  const groupId = await t.run((ctx) =>
    ctx.db.insert("scholarGroups", {
      teacherId: schoolA.teacher.id,
      institutionId: schoolA.id,
      name: "Honu",
      scholarIds: [schoolA.scholars[0].id],
    }),
  );
  const asTeacher = await world.as.staffOf(schoolA, "teacher");
  const placementId = await asTeacher.mutation(api.masterSchedule.placeClass, {
    periodId,
    groupId,
    subject: "Humanities",
    weekday: 1,
    blockId,
  });
  await asTeacher.mutation(api.masterSchedule.movePlacement, { placementId, weekday: 2, blockId });
  expect((await t.run((ctx) => ctx.db.get(placementId)))?.weekday).toBe(2);
});

describe("canEditBellSchedule matches the block mutations", () => {
  test.each<[Caller, boolean]>([
    ["teacher", false],
    ["schoolAdmin", true],
    ["platformAdmin", true],
    ["otherSchoolAdmin", false],
  ])("%s → %s, and never throws", async (who, expected) => {
    const { world, periodId } = await setup();
    const as = await identityFor(world, who);
    expect(await as.query(api.masterSchedule.canEditBellSchedule, { periodId })).toBe(expected);
  });
});

describe("legacy school admins (no staff membership) follow curatableInstitutionIds", () => {
  async function legacyAdmin(t: Harness, memberships: { role: string; institutionId?: Id<"institutions"> }[]) {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Mahina Reyes",
        username: `mahina-${Math.random().toString(36).slice(2)}`,
        role: "school_admin",
      });
      for (const m of memberships) {
        await ctx.db.insert("memberships", { userId, role: m.role as never, institutionId: m.institutionId });
      }
      const sessionId = await ctx.db.insert("authSessions", {
        userId,
        expirationTime: Date.now() + 60 * 60 * 1000,
      });
      return { userId, sessionId };
    });
  }

  test("a school admin whose only scoped membership is a parent one leads the primary school", async () => {
    const { t, world, blockId, periodId } = await setup();
    const [primary] = world.schools; // index 0 is primary
    expect(primary.isPrimary).toBe(true);
    const ids = await legacyAdmin(t, [{ role: "parent", institutionId: primary.id }]);
    const as = t.withIdentity({ subject: `${ids.userId}|${ids.sessionId}`, issuer: "https://convex.dev" });
    expect(await as.query(api.masterSchedule.canEditBellSchedule, { periodId })).toBe(true);
    await as.mutation(api.masterSchedule.updateBlock, { blockId, label: "Legacy rename" });
    expect((await t.run((ctx) => ctx.db.get(blockId)))?.label).toBe("Legacy rename");
  });

  test("a school_admin by role who only TEACHES at the school is not its leader", async () => {
    const { t, world, blockId, periodId } = await setup();
    const [primary] = world.schools;
    const ids = await legacyAdmin(t, [{ role: "teacher", institutionId: primary.id }]);
    const as = t.withIdentity({ subject: `${ids.userId}|${ids.sessionId}`, issuer: "https://convex.dev" });
    expect(await as.query(api.masterSchedule.canEditBellSchedule, { periodId })).toBe(false);
    await expect(
      as.mutation(api.masterSchedule.updateBlock, { blockId, label: "Nope" }),
    ).rejects.toThrow(ADMIN_ONLY);
  });
});

describe("standing comes from the membership at the term's school, not users.role", () => {
  async function withMembership(
    t: Harness,
    userId: Id<"users">,
    role: "teacher" | "school_admin",
    institutionId: Id<"institutions">,
  ) {
    await t.run((ctx) => ctx.db.insert("memberships", { userId, role, institutionId }));
  }

  test("school B's admin who also teaches at A is read-only and refused on A's term", async () => {
    const { t, world, periodId, blockId } = await setup();
    const [schoolA, schoolB] = world.schools;
    await withMembership(t, schoolB.admin.id, "teacher", schoolA.id);
    const asBAdmin = await world.as.staffOf(schoolB, "school_admin");
    expect(await asBAdmin.query(api.masterSchedule.canEditBellSchedule, { periodId })).toBe(false);
    await expect(
      asBAdmin.mutation(api.masterSchedule.updateBlock, { blockId, label: "B's rename" }),
    ).rejects.toThrow(ADMIN_ONLY);
    await expect(
      asBAdmin.mutation(api.masterSchedule.createBlock, {
        periodId,
        label: "B's block",
        startLocal: "15:00",
        endLocal: "15:45",
      }),
    ).rejects.toThrow(ADMIN_ONLY);
    expect((await t.run((ctx) => ctx.db.get(blockId)))?.label).toBe("Block A");
  });

  test("a users.role=teacher with a school_admin membership at A can edit A's bell schedule", async () => {
    const { t, world, periodId, blockId } = await setup();
    const [schoolA] = world.schools;
    await withMembership(t, schoolA.teacher.id, "school_admin", schoolA.id);
    const asTeacher = await world.as.staffOf(schoolA, "teacher");
    expect(await asTeacher.query(api.masterSchedule.canEditBellSchedule, { periodId })).toBe(true);
    await asTeacher.mutation(api.masterSchedule.updateBlock, { blockId, label: "Leader rename" });
    expect((await t.run((ctx) => ctx.db.get(blockId)))?.label).toBe("Leader rename");
  });
});
