import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin" = "scholar",
  overrides: Partial<Doc<"users">> = {},
) {
  const name = overrides.name ?? (role === "scholar" ? "Test Scholar" : `Test ${role}`);
  const username = overrides.username ?? (role === "scholar" ? "testscholar" : `test${role}`);
  if (role === "platform_admin") return t.run((ctx) => ctx.db.insert("users", { name, username, role }));
  const institutionId = await seedTestInstitution(t);
  const userId = role === "scholar"
    ? await seedScholarInInstitution(t, { institutionId, name, username })
    : await seedStaffWithMembership(t, { institutionId, name, username });
  await t.run((ctx) => ctx.db.patch(userId, { readingLevel: overrides.readingLevel, image: overrides.image }));
  return userId;
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("teacherAffinities", () => {
  test("getMine returns empty arrays when no row exists", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const aff = await asTeacher.query(api.teacherAffinities.getMine, {});
    expect(aff).toEqual({ scholarIds: [], groupIds: [] });
  });

  test("toggleScholar adds then removes", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asTeacher = await withUser(t, teacher);

    const added = await asTeacher.mutation(api.teacherAffinities.toggleScholar, {
      scholarId: scholar,
    });
    expect(added).toBe(true);
    let aff = await asTeacher.query(api.teacherAffinities.getMine, {});
    expect(aff.scholarIds).toEqual([scholar]);

    const removed = await asTeacher.mutation(
      api.teacherAffinities.toggleScholar,
      { scholarId: scholar },
    );
    expect(removed).toBe(false);
    aff = await asTeacher.query(api.teacherAffinities.getMine, {});
    expect(aff.scholarIds).toEqual([]);
  });

  test("affinity is per-teacher: teacher B's marks don't show for teacher A", async () => {
    const t = convexTest(schema, modules);
    const teacherA = await seedUser(t, "teacher", { username: "ta" });
    const teacherB = await seedUser(t, "teacher", { username: "tb" });
    const scholar = await seedUser(t, "scholar", { username: "s1" });
    const asA = await withUser(t, teacherA);
    const asB = await withUser(t, teacherB);

    await asB.mutation(api.teacherAffinities.toggleScholar, {
      scholarId: scholar,
    });
    const affA = await asA.query(api.teacherAffinities.getMine, {});
    expect(affA.scholarIds).toEqual([]);
    const affB = await asB.query(api.teacherAffinities.getMine, {});
    expect(affB.scholarIds).toEqual([scholar]);
  });

  test("set replaces marks and dedupes; clear empties them", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const s1 = await seedUser(t, "scholar", { username: "s1" });
    const s2 = await seedUser(t, "scholar", { username: "s2" });
    const asTeacher = await withUser(t, teacher);
    const groupId = await asTeacher.mutation(api.scholarGroups.create, {
      name: "Geckos",
    });

    await asTeacher.mutation(api.teacherAffinities.set, {
      scholarIds: [s1, s1, s2],
      groupIds: [groupId],
    });
    let aff = await asTeacher.query(api.teacherAffinities.getMine, {});
    expect(aff.scholarIds.sort()).toEqual([s1, s2].sort());
    expect(aff.groupIds).toEqual([groupId]);

    await asTeacher.mutation(api.teacherAffinities.clear, {});
    aff = await asTeacher.query(api.teacherAffinities.getMine, {});
    expect(aff).toEqual({ scholarIds: [], groupIds: [] });
  });

  test("toggleGroup adds then removes a group affinity", async () => {
    const t = convexTest(schema, modules);
    const teacher = await seedUser(t, "teacher");
    const asTeacher = await withUser(t, teacher);
    const groupId = await asTeacher.mutation(api.scholarGroups.create, {
      name: "Geckos",
    });

    await asTeacher.mutation(api.teacherAffinities.toggleGroup, { groupId });
    let aff = await asTeacher.query(api.teacherAffinities.getMine, {});
    expect(aff.groupIds).toEqual([groupId]);

    await asTeacher.mutation(api.teacherAffinities.toggleGroup, { groupId });
    aff = await asTeacher.query(api.teacherAffinities.getMine, {});
    expect(aff.groupIds).toEqual([]);
  });

  test("scholar cannot read affinity (teacher-gated)", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar");
    const asScholar = await withUser(t, scholar);
    await expect(
      asScholar.query(api.teacherAffinities.getMine, {}),
    ).rejects.toThrow();
  });
});
