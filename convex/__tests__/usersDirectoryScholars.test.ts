import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { readScholarRoster } from "../lib/scholarReads";
import {
  grantInstitutionMembership,
  seedScholarInInstitution,
  seedStaffWithMembership,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type TC = TestConvex<typeof schema>;

async function withUser(t: TC, userId: Id<"users">) {
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
}

describe("users.listDirectoryScholars", () => {
  test("returns only directory identity and credential fields", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t, {
      name: "Moli School",
      slug: "moli",
      isPrimary: true,
    });
    const teacher = await seedStaffWithMembership(t, {
      institutionId,
      name: "Lehua Torres",
      username: "lehua",
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId,
      name: "Kai Kealoha",
      username: "kai",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(scholar, {
        image: "https://example.com/kai.png",
        email: "kai@example.com",
        phone: "555-0100",
        address: "1 Fictional Way",
        readingLevel: "advanced",
        dateOfBirth: "2015-01-01",
        enrollmentStanding: "program_guest",
      });
      await ctx.db.insert("authAccounts", {
        userId: scholar,
        provider: "password",
        providerAccountId: "kai@local",
      });
    });

    const directory = await (await withUser(t, teacher)).query(
      api.users.listDirectoryScholars,
      {},
    );

    expect(directory).toEqual([
      {
        _id: scholar,
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
    const moli = await seedTestInstitution(t, {
      name: "Moli School",
      slug: "moli",
      isPrimary: true,
    });
    const kona = await seedTestInstitution(t, {
      name: "Kona Learning",
      slug: "kona",
    });
    const guests = await seedTestInstitution(t, {
      name: "Guests School",
      slug: "guests",
    });
    const teacher = await seedStaffWithMembership(t, {
      institutionId: moli,
      name: "Lehua Torres",
      username: "lehua",
    });
    await grantInstitutionMembership(t, teacher, kona);
    await seedScholarInInstitution(t, {
      institutionId: moli,
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
    await seedScholarInInstitution(t, {
      institutionId: kona,
      name: "Kona Scholar",
      username: "kona-scholar",
    });
    await seedScholarInInstitution(t, {
      institutionId: guests,
      name: "Guest Scholar",
      username: "guest-scholar",
    });
    const asTeacher = await withUser(t, teacher);

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
    for (const [role, username] of [
      ["scholar", "kai"],
      ["parent", "avery"],
      ["curriculum_designer", "hoku"],
      ["lifelong_learner", "noa"],
    ] as const) {
      const userId = await t.run((ctx) =>
        ctx.db.insert("users", {
          name: `Fixture ${username}`,
          username,
          role,
        }),
      );
      await expect(
        (await withUser(t, userId)).query(api.users.listDirectoryScholars, {}),
      ).rejects.toThrow("Forbidden");
    }
  });

  test("lets a platform admin choose one school, with global visibility only for all", async () => {
    const t = convexTest(schema, modules);
    const moli = await seedTestInstitution(t, {
      name: "Moli School",
      slug: "moli",
      isPrimary: true,
    });
    const kona = await seedTestInstitution(t, {
      name: "Kona Learning",
      slug: "kona",
    });
    const admin = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Avery Stone",
        username: "avery",
        role: "platform_admin",
      }),
    );
    await seedScholarInInstitution(t, {
      institutionId: moli,
      name: "Moli Scholar",
      username: "moli-scholar",
    });
    await seedScholarInInstitution(t, {
      institutionId: kona,
      name: "Kona Scholar",
      username: "kona-scholar",
    });
    const asAdmin = await withUser(t, admin);

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
    const firstScholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Kai Kealoha",
        username: "kai",
        role: "scholar",
      }),
    );
    const secondScholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Lani Kealoha",
        username: "lani",
        role: "scholar",
      }),
    );
    const staffId = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Lehua Torres",
        username: "lehua",
        role: "teacher",
      }),
    );
    const missingScholarId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("users", {
        name: "Removed Fixture",
        username: "removed-fixture",
        role: "scholar",
      });
      await ctx.db.delete(id);
      return id;
    });

    const allowedRoster = await t.run((ctx) =>
      readScholarRoster(
        ctx as unknown as QueryCtx,
        new Set([firstScholar, staffId, missingScholarId]),
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
