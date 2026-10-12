import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { ROLES } from "../lib/roles";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// A DUAL-ROLE account teaches at one school and learns at another — the shape a
// visiting teacher gets after a demo evening (staff at their own school, a
// learner in the host community). `users.institutionId` is the SCHOLAR
// projection, so it names the school they LEARN at. Unit authoring must follow
// the STAFF MEMBERSHIP instead, or the teacher's own curriculum is filed into
// the other tenant.

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
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

describe("unit author institution for a dual-role teacher/learner", () => {
  test("stamps the school they TEACH at, not the one they learn at", async () => {
    const t = convexTest(schema, modules);

    const { teachesAt, learnsAt, userId } = await t.run(async (ctx) => {
      const teachesAt = await ctx.db.insert("institutions", {
        name: "Teaches Here School",
        slug: "teaches-here",
        kind: "school",
        isPrimary: false,
      });
      const learnsAt = await ctx.db.insert("institutions", {
        name: "Learns Here Community",
        slug: "learns-here",
        kind: "community",
        isPrimary: false,
      });
      await ctx.db.insert("institutions", {
        name: "Primary School",
        slug: "primary-school",
        kind: "school",
        isPrimary: true,
      });

      // Born as a learner in the host community (so the scholar projection
      // points there), later made staff at their own school.
      const userId = await ctx.db.insert("users", {
        name: "Visiting Teacher",
        username: "visiting_teacher",
        role: ROLES.TEACHER,
        institutionId: learnsAt,
      });
      await ctx.db.insert("memberships", {
        userId,
        role: ROLES.TEACHER,
        institutionId: teachesAt,
      });
      await ctx.db.insert("memberships", {
        userId,
        role: ROLES.SCHOLAR,
        institutionId: learnsAt,
      });
      return { teachesAt, learnsAt, userId };
    });

    const asTeacher = await withUser(t, userId);
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "A unit for my own school",
    });

    const unit = await t.run(async (ctx) => await ctx.db.get(unitId));
    expect(unit?.institutionId).toBe(teachesAt);
    expect(unit?.institutionId).not.toBe(learnsAt);
  });

  test("legacy staff with no membership still fall back to users.institutionId", async () => {
    const t = convexTest(schema, modules);

    const { legacySchool, userId } = await t.run(async (ctx) => {
      const legacySchool = await ctx.db.insert("institutions", {
        name: "Legacy School",
        slug: "legacy-school",
        kind: "school",
        isPrimary: false,
      });
      await ctx.db.insert("institutions", {
        name: "Primary School",
        slug: "primary-school",
        kind: "school",
        isPrimary: true,
      });
      const userId = await ctx.db.insert("users", {
        name: "Never Backfilled",
        username: "never_backfilled",
        role: ROLES.TEACHER,
        institutionId: legacySchool,
      });
      return { legacySchool, userId };
    });

    const asTeacher = await withUser(t, userId);
    const unitId = await asTeacher.mutation(api.units.create, {
      title: "Legacy staff unit",
    });

    const unit = await t.run(async (ctx) => await ctx.db.get(unitId));
    expect(unit?.institutionId).toBe(legacySchool);
  });
});
