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

/**
 * Coverage for `sessions.sessionForUnit`'s remote-mode arg
 * (`userId`). The query backs the `/scholar/unit/[unitId]` route;
 * with `?remote=<scholarId>` a teacher needs to resolve the *scholar's*
 * session for the unit, not their own.
 *
 * Authorization mirrors `projects.list`: only teachers/admins can
 * pass `userId`; scholars get their own row regardless.
 */

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: "scholar" | "teacher" | "platform_admin",
  name: string,
  username: string,
) {
  if (role === "platform_admin") return t.run((ctx) => ctx.db.insert("users", { role, name, username }));
  const institutionId = await seedTestInstitution(t);
  return role === "scholar"
    ? seedScholarInInstitution(t, { institutionId, name, username })
    : seedStaffWithMembership(t, { institutionId, name, username });
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

describe("sessions.sessionForUnit — remote-mode userId arg", () => {
  test("teacher passing userId resolves the named scholar's session", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const scholarId = await seedUser(t, "scholar", "S", "s");

    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId,
        title: "Unit",
        isActive: true,
      }),
    );

    const scholarProjectId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "scholar's project",
        unitId,
        isArchived: false,
      }),
    );

    // Teacher has no project for this unit themselves; without userId
    // they'd resolve to null. With userId pointing at the scholar,
    // they should see the scholar's project.
    const asTeacher = await withUser(t, teacherId);

    const ownResult = await asTeacher.query(api.sessions.sessionForUnit, {
      unitId,
    });
    expect(ownResult.sessionId).toBe(null);

    const remoteResult = await asTeacher.query(
      api.sessions.sessionForUnit,
      { unitId, userId: scholarId },
    );
    expect(remoteResult.sessionId).toBe(scholarProjectId);
  });

  test("scholar passing userId is ignored — only their own project resolves", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const scholarA = await seedUser(t, "scholar", "A", "a");
    const scholarB = await seedUser(t, "scholar", "B", "b");

    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", {
        teacherId,
        title: "Unit",
        isActive: true,
      }),
    );

    const aProjectId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarA,
        title: "A's project",
        unitId,
        isArchived: false,
      }),
    );
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarB,
        title: "B's project",
        unitId,
        isArchived: false,
      }),
    );

    const asA = await withUser(t, scholarA);
    // A attempts to look up B's project; should silently get back A's.
    const result = await asA.query(api.sessions.sessionForUnit, {
      unitId,
      userId: scholarB,
    });
    expect(result.sessionId).toBe(aProjectId);
  });

  test("test-drive projects are excluded even in remote mode", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "T", "t");
    const scholarId = await seedUser(t, "scholar", "S", "s");

    const unitId = await t.run(async (ctx) =>
      ctx.db.insert("units", { teacherId, title: "Unit", isActive: true }),
    );

    // Scholar has a real project + (hypothetically) a test-drive
    // project for the same unit. Filtering should keep test-drive out.
    await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "drive",
        unitId,
        isArchived: false,
        isTestDrive: true,
      }),
    );
    const realId = await t.run(async (ctx) =>
      ctx.db.insert("sessions", {
        userId: scholarId,
        title: "real",
        unitId,
        isArchived: false,
      }),
    );

    const asTeacher = await withUser(t, teacherId);
    const result = await asTeacher.query(api.sessions.sessionForUnit, {
      unitId,
      userId: scholarId,
    });
    expect(result.sessionId).toBe(realId);
  });
});
