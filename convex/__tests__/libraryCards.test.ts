import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = "scholar" | "teacher" | "platform_admin" | "parent";

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      institutionId,
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function linkGuardian(
  t: ReturnType<typeof convexTest>,
  parentUserId: Id<"users">,
  scholarUserId: Id<"users">,
  createdBy: Id<"users">,
) {
  await t.run((ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId,
      scholarUserId,
      createdBy,
    }),
  );
}

describe("guardian-managed library cards", () => {
  test("program guests do not inherit school library-card management", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "guest");
    const parent = await seedUser(t, "parent", "parent");
    await t.run((ctx) =>
      ctx.db.patch(scholar, { enrollmentStanding: "program_guest" }),
    );
    await linkGuardian(t, parent, scholar, admin);
    const asParent = await withUser(t, parent);
    await expect(
      asParent.query(api.libraryCards.getStatus, { scholarId: scholar }),
    ).rejects.toThrow(/Extended Education scholars/i);
  });

  test("owner guardian adds a card and every guardian sees only masked status", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar");
    const parentA = await seedUser(t, "parent", "parent-a");
    const parentB = await seedUser(t, "parent", "parent-b");
    await linkGuardian(t, parentA, scholar, admin);
    await linkGuardian(t, parentB, scholar, admin);

    const asParentA = await withUser(t, parentA);
    const saved = await asParentA.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "  TEST-CARD-7890 ",
      pin: " 0042 ",
      expectedRevision: 0,
    });
    expect(saved).toEqual({
      onFile: true,
      maskedCardNumber: "•••• 7890",
      pinSaved: true,
      revision: 1,
    });
    expect(JSON.stringify(saved)).not.toContain("TEST-CARD");
    expect(JSON.stringify(saved)).not.toContain("0042");

    const asParentB = await withUser(t, parentB);
    const secondGuardianStatus = await asParentB.query(
      api.libraryCards.getStatus,
      { scholarId: scholar },
    );
    expect(secondGuardianStatus).toEqual(saved);
    expect(JSON.stringify(secondGuardianStatus)).not.toContain("0042");
  });

  test("second guardian explicitly replaces both credentials without reading the PIN", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar");
    const parentA = await seedUser(t, "parent", "parent-a");
    const parentB = await seedUser(t, "parent", "parent-b");
    await linkGuardian(t, parentA, scholar, admin);
    await linkGuardian(t, parentB, scholar, admin);
    const asParentA = await withUser(t, parentA);
    await asParentA.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "OLD-CARD-1111",
      pin: "old-pin",
      expectedRevision: 0,
    });

    const asParentB = await withUser(t, parentB);
    await asParentB.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "NEW-CARD-2222",
      pin: "new-pin",
      expectedRevision: 1,
    });
    const stored = await t.run((ctx) => ctx.db.get(scholar));
    expect(stored?.libraryCredential).toEqual({
      id: "NEW-CARD-2222",
      password: "new-pin",
    });
    expect(stored?.libraryCredentialRevision).toBe(2);
    const status = await asParentA.query(api.libraryCards.getStatus, {
      scholarId: scholar,
    });
    expect(status.maskedCardNumber).toBe("•••• 2222");
    expect(JSON.stringify(status)).not.toContain("new-pin");
  });

  test("rejects stale replacements and removals without changing the current credential", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar");
    const parent = await seedUser(t, "parent", "parent");
    await linkGuardian(t, parent, scholar, admin);
    const asParent = await withUser(t, parent);
    await asParent.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "CARD-1111",
      pin: "pin-one",
      expectedRevision: 0,
    });
    await asParent.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "CARD-2222",
      pin: "pin-two",
      expectedRevision: 1,
    });

    await expect(
      asParent.mutation(api.libraryCards.replace, {
        scholarId: scholar,
        cardNumber: "STALE-3333",
        pin: "stale-pin",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/another authorized guardian/i);
    await expect(
      asParent.mutation(api.libraryCards.remove, {
        scholarId: scholar,
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/another authorized guardian/i);
    expect(
      (await t.run((ctx) => ctx.db.get(scholar)))?.libraryCredential,
    ).toMatchObject({ id: "CARD-2222", password: "pin-two" });
  });

  test("keeps revisions monotonic across remove and re-add cycles", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar");
    const parentA = await seedUser(t, "parent", "parent-a");
    const parentB = await seedUser(t, "parent", "parent-b");
    await linkGuardian(t, parentA, scholar, admin);
    await linkGuardian(t, parentB, scholar, admin);
    const asParentA = await withUser(t, parentA);
    const asParentB = await withUser(t, parentB);

    await asParentA.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "CARD-1111",
      pin: "pin-one",
      expectedRevision: 0,
    });
    await asParentA.mutation(api.libraryCards.remove, {
      scholarId: scholar,
      expectedRevision: 1,
    });
    await asParentB.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "CARD-3333",
      pin: "pin-three",
      expectedRevision: 2,
    });

    await expect(
      asParentA.mutation(api.libraryCards.replace, {
        scholarId: scholar,
        cardNumber: "STALE-2222",
        pin: "stale-pin",
        expectedRevision: 1,
      }),
    ).rejects.toThrow(/another authorized guardian/i);
    const stored = await t.run((ctx) => ctx.db.get(scholar));
    expect(stored?.libraryCredential).toEqual({
      id: "CARD-3333",
      password: "pin-three",
    });
    expect(stored?.libraryCredentialRevision).toBe(3);
  });

  test("removes through the existing undefined credential semantics", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar");
    const parent = await seedUser(t, "parent", "parent");
    await linkGuardian(t, parent, scholar, admin);
    const asParent = await withUser(t, parent);
    await asParent.mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "CARD-1111",
      pin: "pin",
      expectedRevision: 0,
    });
    expect(
      await asParent.mutation(api.libraryCards.remove, {
        scholarId: scholar,
        expectedRevision: 1,
      }),
    ).toEqual({
      onFile: false,
      maskedCardNumber: null,
      pinSaved: false,
      revision: 2,
    });
    const removedScholar = await t.run((ctx) => ctx.db.get(scholar));
    expect(removedScholar?.libraryCredential).toBeUndefined();
    expect(removedScholar?.libraryCredentialRevision).toBe(2);
  });

  test("denies unrelated guardians, unrelated staff, scholars, and unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    const scholar = await seedUser(t, "scholar", "scholar");
    const unrelatedParent = await seedUser(t, "parent", "parent");
    const teacher = await seedUser(t, "teacher", "teacher");
    for (const userId of [unrelatedParent, teacher, scholar]) {
      const caller = await withUser(t, userId);
      await expect(
        caller.query(api.libraryCards.getStatus, { scholarId: scholar }),
      ).rejects.toThrow(/not a guardian/i);
      await expect(
        caller.mutation(api.libraryCards.replace, {
          scholarId: scholar,
          cardNumber: "CARD",
          pin: "PIN",
          expectedRevision: 0,
        }),
      ).rejects.toThrow(/not a guardian/i);
    }
    await expect(
      t.query(api.libraryCards.getStatus, { scholarId: scholar }),
    ).rejects.toThrow(/not authenticated/i);
  });

  test("guardian authority is explicit across institutions and staff guardians remain role-agnostic", async () => {
    const t = convexTest(schema, modules);
    const schoolA = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "School A",
        slug: "school-a",
        kind: "school",
      }),
    );
    const schoolB = await t.run((ctx) =>
      ctx.db.insert("institutions", {
        name: "School B",
        slug: "school-b",
        kind: "school",
      }),
    );
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar", schoolA);
    const staffGuardian = await seedUser(t, "teacher", "staff-parent", schoolB);
    const unrelatedStaff = await seedUser(t, "teacher", "teacher", schoolA);
    await linkGuardian(t, staffGuardian, scholar, admin);

    const asStaffGuardian = await withUser(t, staffGuardian);
    await expect(
      asStaffGuardian.mutation(api.libraryCards.replace, {
        scholarId: scholar,
        cardNumber: "CROSS-SCHOOL-4444",
        pin: "pin",
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ maskedCardNumber: "•••• 4444" });

    const asUnrelatedStaff = await withUser(t, unrelatedStaff);
    await expect(
      asUnrelatedStaff.query(api.libraryCards.getStatus, {
        scholarId: scholar,
      }),
    ).rejects.toThrow(/not a guardian/i);
  });

  test("validates conservatively without requiring a guessed numeric format", async () => {
    const t = convexTest(schema, modules);
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar");
    const parent = await seedUser(t, "parent", "parent");
    await linkGuardian(t, parent, scholar, admin);
    const asParent = await withUser(t, parent);
    await expect(
      asParent.mutation(api.libraryCards.replace, {
        scholarId: scholar,
        cardNumber: " ",
        pin: "1234",
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/enter the library card number/i);
    await expect(
      asParent.mutation(api.libraryCards.replace, {
        scholarId: scholar,
        cardNumber: "ALPHA-HYPHEN-CARD",
        pin: " ",
        expectedRevision: 0,
      }),
    ).rejects.toThrow(/enter the library card PIN/i);
    await expect(
      asParent.mutation(api.libraryCards.replace, {
        scholarId: scholar,
        cardNumber: "ALPHA-HYPHEN-CARD",
        pin: "AB-12",
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ onFile: true });
  });

  test("parent-entered credentials feed the existing owner-only library app consumer", async () => {
    const t = convexTest(schema, modules);
    const appId = await t.mutation(internal.externalApps.seedPressReader, {});
    const admin = await seedUser(t, "platform_admin", "admin");
    const scholar = await seedUser(t, "scholar", "scholar");
    const parent = await seedUser(t, "parent", "parent");
    await linkGuardian(t, parent, scholar, admin);
    await t.run((ctx) =>
      ctx.db.insert("scholarApps", {
        scholarId: scholar,
        appId,
        enabled: true,
        source: "manual",
      }),
    );
    await (await withUser(t, parent)).mutation(api.libraryCards.replace, {
      scholarId: scholar,
      cardNumber: "DOWNSTREAM-5555",
      pin: "downstream-pin",
      expectedRevision: 0,
    });

    const asScholar = await withUser(t, scholar);
    const credentials = await asScholar.query(
      api.scholarApps.credentialsForApp,
      { appId },
    );
    expect(credentials).toMatchObject({
      username: "DOWNSTREAM-5555",
      password: "downstream-pin",
      loginFlow: "pressReaderLibraryCard",
    });
    const currentUser = await asScholar.query(api.users.currentUser, {});
    expect(currentUser).not.toHaveProperty("libraryCredential");
    expect(JSON.stringify(currentUser)).not.toContain("DOWNSTREAM-5555");
    expect(JSON.stringify(currentUser)).not.toContain("downstream-pin");
    const parentStatus = await (await withUser(t, parent)).query(
      api.libraryCards.getStatus,
      { scholarId: scholar },
    );
    expect(JSON.stringify(parentStatus)).not.toContain("downstream-pin");
    expect(JSON.stringify(parentStatus)).not.toContain("DOWNSTREAM");
  });
});
