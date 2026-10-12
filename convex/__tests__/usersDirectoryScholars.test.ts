import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { readScholarRoster } from "../lib/scholarReads";
import {
  makeScholar,
  makeWorld,
} from "./factories/world";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

describe("users.listDirectoryScholars", () => {
  test("returns only directory identity and credential fields", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const scholar = school.scholars[0];
    await t.run(async (ctx) => {
      await ctx.db.patch(scholar.id, {
        name: "Kai Kealoha",
        username: "kai",
        image: "https://example.com/kai.png",
        email: "kai@example.com",
        phone: "555-0100",
        address: "1 Fictional Way",
        readingLevel: "advanced",
        dateOfBirth: "2015-01-01",
        enrollmentStanding: "program_guest",
      });
      await ctx.db.insert("authAccounts", {
        userId: scholar.id,
        provider: "password",
        providerAccountId: "kai@local",
      });
    });

    const directory = await (await world.as.staffOf(school)).query(
      api.users.listDirectoryScholars,
      {},
    );

    expect(directory).toEqual([
      {
        _id: scholar.id,
        name: "Kai Kealoha",
        image: "https://example.com/kai.png",
        username: "kai",
        enrollmentStanding: "program_guest",
        hasCredential: true,
      },
    ]);
    expect(Object.keys(directory[0]).sort()).toEqual([
      "_id",
      "enrollmentStanding",
      "hasCredential",
      "image",
      "name",
      "username",
    ]);
  });

  test("honors a multi-membership caller's requested school and falls back on invalid or non-member scopes", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 3,
      scholarsPerSchool: 0,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const [moli, kona, guests] = world.schools;
    await t.run(async (ctx) => {
      await ctx.db.patch(moli.id, { name: "Moli School", slug: "moli" });
      await ctx.db.patch(kona.id, { name: "Kona Learning", slug: "kona" });
      await ctx.db.patch(guests.id, {
        name: "Guests School",
        slug: "guests",
      });
      await ctx.db.insert("memberships", {
        userId: moli.teacher.id,
        role: "teacher",
        institutionId: kona.id,
      });
    });
    await makeScholar(t, moli, {
      name: "Moli Scholar",
      username: "moli-scholar",
    });
    await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Unassigned Scholar",
        username: "unassigned-scholar",
        role: "scholar",
      }),
    );
    await makeScholar(t, kona, {
      name: "Kona Scholar",
      username: "kona-scholar",
    });
    await makeScholar(t, guests, {
      name: "Guest Scholar",
      username: "guest-scholar",
    });
    const asTeacher = await world.as.staffOf(moli);

    expect(
      (await asTeacher.query(api.users.listDirectoryScholars, {
        institutionScope: "kona",
      })).map((scholar) => scholar.username),
    ).toEqual(["kona-scholar"]);
    expect(
      (await asTeacher.query(api.users.listDirectoryScholars, {
        institutionScope: "guests",
      })).map((scholar) => scholar.username),
    ).toEqual(["moli-scholar", "unassigned-scholar"]);
    expect(
      (await asTeacher.query(api.users.listDirectoryScholars, {
        institutionScope: "not-a-school",
      })).map((scholar) => scholar.username),
    ).toEqual(["moli-scholar", "unassigned-scholar"]);
  });

  test("rejects non-scholar-admin roles", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 1,
      parentsPerSchool: 1,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    for (const [role, username] of [
      ["scholar", "kai"],
      ["parent", "avery"],
      ["curriculum_designer", "hoku"],
      ["lifelong_learner", "noa"],
    ] as const) {
      const asUser =
        role === "scholar"
          ? await world.as.scholar(school.scholars[0])
          : role === "parent"
            ? await world.as.parent(school.parents[0])
            : await (async () => {
                const userId = await t.run((ctx) =>
                  ctx.db.insert("users", {
                    name: `Fixture ${username}`,
                    username,
                    role,
                  }),
                );
                const sessionId = await t.run((ctx) =>
                  ctx.db.insert("authSessions", {
                    userId,
                    expirationTime: Date.now() + 3_600_000,
                  }),
                );
                return t.withIdentity({
                  subject: `${userId}|${sessionId}`,
                  issuer: "https://convex.dev",
                });
              })();
      await expect(
        asUser.query(api.users.listDirectoryScholars, {}),
      ).rejects.toThrow("Forbidden");
    }
  });

  test("lets a platform admin choose one school, with global visibility only for all", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 2,
      scholarsPerSchool: 0,
      parentsPerSchool: 0,
    });
    const [moli, kona] = world.schools;
    await t.run(async (ctx) => {
      await ctx.db.patch(moli.id, { name: "Moli School", slug: "moli" });
      await ctx.db.patch(kona.id, { name: "Kona Learning", slug: "kona" });
    });
    await makeScholar(t, moli, {
      name: "Moli Scholar",
      username: "moli-scholar",
    });
    await makeScholar(t, kona, {
      name: "Kona Scholar",
      username: "kona-scholar",
    });
    const asAdmin = await world.as.platformAdmin();

    expect(
      (await asAdmin.query(api.users.listDirectoryScholars, {
        institutionScope: "kona",
      })).map((scholar) => scholar.username),
    ).toEqual(["kona-scholar"]);
    expect(
      (await asAdmin.query(api.users.listDirectoryScholars, {
        institutionScope: "all",
      }))
        .map((scholar) => scholar.username)
        .sort(),
    ).toEqual(["kona-scholar", "moli-scholar"]);
  });
});

describe("readScholarRoster", () => {
  test("ignores missing and non-scholar allowed ids, while the unrestricted path returns every scholar", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, {
      schools: 1,
      scholarsPerSchool: 2,
      parentsPerSchool: 0,
      includePlatformAdmin: false,
    });
    const school = world.schools[0];
    const firstScholar = school.scholars[0].id;
    const secondScholar = school.scholars[1].id;
    const staffId = school.teacher.id;
    const removedScholar = await makeScholar(t, school, {
      name: "Removed Fixture",
      username: "removed-fixture",
    });
    const missingScholarId = await t.run(async (ctx) => {
      await ctx.db.delete(removedScholar.id);
      return removedScholar.id;
    });

    const allowedRoster = await t.run((ctx) =>
      readScholarRoster(
        ctx as unknown as QueryCtx,
        new Set([firstScholar, staffId, missingScholarId as Id<"users">]),
      ),
    );
    const unrestrictedRoster = await t.run((ctx) =>
      readScholarRoster(ctx as unknown as QueryCtx, null),
    );

    expect(allowedRoster.scholars.map((scholar) => scholar.id)).toEqual([
      firstScholar,
    ]);
    expect(
      unrestrictedRoster.scholars.map((scholar) => scholar.id).sort(),
    ).toEqual([firstScholar, secondScholar].sort());
  });
});
