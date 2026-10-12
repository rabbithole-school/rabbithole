/**
 * `sessions.getWithMessages` → `session.isPreReader` (TRA-492): the voice-mode
 * decision both clients key on must follow the SAME effective reading level the
 * tutor prompt uses — a per-session override wins over the scholar's saved
 * level, in both directions.
 */
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

async function flagFor(
  t: ReturnType<typeof convexTest>,
  viewerId: Id<"users">,
  session: Partial<Doc<"sessions">> & { userId: Id<"users"> },
) {
  const id = await t.run((ctx) =>
    ctx.db.insert("sessions", { title: "Session", isArchived: false, ...session }),
  );
  const res = await (await withUser(t, viewerId)).query(
    api.sessions.getWithMessages,
    { id },
  );
  return res.session.isPreReader;
}

describe("getWithMessages session.isPreReader", () => {
  test("follows the scholar's saved level when there is no override", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const kid = await seedScholarInInstitution(t, {
      institutionId,
      name: "Kai Pre",
      username: "kai_pre",
    });
    const older = await seedScholarInInstitution(t, {
      institutionId,
      name: "Noa Older",
      username: "noa_older",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(kid, { readingLevel: "pre-reader" });
      await ctx.db.patch(older, { readingLevel: "3" });
    });
    expect(await flagFor(t, kid, { userId: kid })).toBe(true);
    expect(await flagFor(t, older, { userId: older })).toBe(false);
  });

  test("a per-session override wins in both directions", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const kid = await seedScholarInInstitution(t, {
      institutionId,
      name: "Kai Pre",
      username: "kai_pre",
    });
    await t.run((ctx) => ctx.db.patch(kid, { readingLevel: "pre-reader" }));
    expect(
      await flagFor(t, kid, { userId: kid, readingLevelOverride: "2" }),
    ).toBe(false);

    // A teacher rehearsing their own session with a pre-reader override gets
    // voice mode, though the teacher's own record has no reading level.
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Test Teacher",
      username: "test_teacher",
    });
    expect(
      await flagFor(t, teacher, {
        userId: teacher,
        isTestDrive: true,
        readingLevelOverride: "pre-reader",
      }),
    ).toBe(true);
    expect(
      await flagFor(t, teacher, { userId: teacher, isTestDrive: true }),
    ).toBe(false);
  });

  test("view-as a real scholar follows THAT scholar's level (and an override still wins)", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const kid = await seedScholarInInstitution(t, {
      institutionId,
      name: "Kai Pre",
      username: "kai_pre",
    });
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Test Teacher",
      username: "test_teacher",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(kid, { readingLevel: "pre-reader" });
      await ctx.db.patch(teacher, { readingLevel: "5" });
    });
    expect(
      await flagFor(t, teacher, {
        userId: teacher,
        isTestDrive: true,
        testDriveAsScholarId: kid,
      }),
    ).toBe(true);
    expect(
      await flagFor(t, teacher, {
        userId: teacher,
        isTestDrive: true,
        testDriveAsScholarId: kid,
        readingLevelOverride: "2",
      }),
    ).toBe(false);
  });

  test("a synthetic view ignores the owner's stored level; an override beats the synthetic level", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Test Teacher",
      username: "test_teacher",
    });
    // The rehearsing teacher's OWN record says pre-reader — a synthetic view
    // must not read it.
    await t.run((ctx) => ctx.db.patch(teacher, { readingLevel: "pre-reader" }));
    expect(
      await flagFor(t, teacher, {
        userId: teacher,
        isTestDrive: true,
        testDriveSyntheticReadingLevel: "3",
      }),
    ).toBe(false);
    expect(
      await flagFor(t, teacher, {
        userId: teacher,
        isTestDrive: true,
        testDriveSyntheticReadingLevel: "3",
        readingLevelOverride: "pre-reader",
      }),
    ).toBe(true);
    expect(
      await flagFor(t, teacher, {
        userId: teacher,
        isTestDrive: true,
        testDriveSyntheticReadingLevel: "pre-reader",
        readingLevelOverride: "2",
      }),
    ).toBe(false);
  });

  test("a synthetic view-as pre-reader rehearsal counts", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Test Teacher",
      username: "test_teacher",
    });
    expect(
      await flagFor(t, teacher, {
        userId: teacher,
        isTestDrive: true,
        testDriveSyntheticReadingLevel: "pre-reader",
      }),
    ).toBe(true);
  });
});
