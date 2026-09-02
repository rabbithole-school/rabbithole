import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  evaluateInstitutionSuspension,
  isBlockedBySuspension,
} from "../lib/access";
import { hasSurvivingMembership } from "../lib/cascade";
import { INSTITUTION_SUSPENDED_MESSAGE } from "../lib/access";

// Why this file: institution suspension (temporary disable/enable) is the
// REVERSIBLE sibling of cascade-delete. These tests pin the whole model: the
// primary institution can never be suspended, only a platform admin may
// suspend, "suspended" blocks a member's authed reads AND writes at the ONE
// requireUser chokepoint, a platform admin always passes, a user who also
// belongs to an active institution keeps working there (the multi-institution
// edge), re-enabling fully restores access, and NEITHER operation deletes any
// data.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

async function withUser(t: T, userId: Id<"users">) {
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

/** moli (primary) + kona (non-primary) + an admin + one scholar per school +
 *  a teacher with memberships at BOTH schools. */
async function seedWorld(t: T) {
  return await t.run(async (ctx) => {
    const moli = await ctx.db.insert("institutions", {
      name: "Moli School",
      slug: "moli",
      kind: "school",
      isPrimary: true,
    });
    const kona = await ctx.db.insert("institutions", {
      name: "Kona Tutoring",
      slug: "kona-tutoring",
      kind: "school",
    });

    const admin = await ctx.db.insert("users", {
      name: "Avery Admin",
      username: "avery",
      role: "platform_admin",
    });
    await ctx.db.insert("memberships", { userId: admin, role: "platform_admin" });

    const konaScholar = await ctx.db.insert("users", {
      name: "Noe",
      username: "noe_tutoring",
      role: "scholar",
      institutionId: kona,
    });
    await ctx.db.insert("memberships", {
      userId: konaScholar,
      role: "scholar",
      institutionId: kona,
    });

    const moliScholar = await ctx.db.insert("users", {
      name: "Leilani",
      username: "leilani",
      role: "scholar",
      institutionId: moli,
    });
    await ctx.db.insert("memberships", {
      userId: moliScholar,
      role: "scholar",
      institutionId: moli,
    });

    // Teacher at BOTH Moli and Kona (the multi-institution edge). Home = Moli.
    const dualTeacher = await ctx.db.insert("users", {
      name: "Lehua",
      username: "lehua",
      role: "teacher",
      institutionId: moli,
    });
    await ctx.db.insert("memberships", {
      userId: dualTeacher,
      role: "teacher",
      institutionId: moli,
    });
    await ctx.db.insert("memberships", {
      userId: dualTeacher,
      role: "teacher",
      institutionId: kona,
    });

    return { moli, kona, admin, konaScholar, moliScholar, dualTeacher };
  });
}

async function isDisabled(t: T, institutionId: Id<"institutions">) {
  return await t.run(async (ctx) => {
    const inst = await ctx.db.get(institutionId);
    return inst?.disabledAt !== undefined;
  });
}

describe("institution suspension — disable/enable", () => {
  test("the PRIMARY institution can never be suspended", async () => {
    const t = convexTest(schema, modules);
    const { moli, admin } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);
    await expect(
      asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
        institutionId: moli,
      }),
    ).rejects.toThrow(/primary institution cannot be disabled/i);
    expect(await isDisabled(t, moli)).toBe(false);
  });

  test("only a platform admin may suspend (a teacher is refused)", async () => {
    const t = convexTest(schema, modules);
    const { kona, dualTeacher } = await seedWorld(t);
    const asTeacher = await withUser(t, dualTeacher);
    await expect(
      asTeacher.mutation(api.institutionLifecycle.disableInstitution, {
        institutionId: kona,
      }),
    ).rejects.toThrow(/platform-admin/i);
    expect(await isDisabled(t, kona)).toBe(false);
  });

  test("disabling blocks a member's authed reads AND writes", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin, konaScholar } = await seedWorld(t);
    const asScholar = await withUser(t, konaScholar);

    // Before: the Kona scholar can read + write their own prefs.
    await expect(
      asScholar.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();

    // Suspend Kona as the platform admin.
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona,
      reason: "billing paused",
    });
    expect(await isDisabled(t, kona)).toBe(true);

    // After: every authed read AND write is refused with the paused message.
    await expect(
      asScholar.query(api.notifications.getMyPrefs, {}),
    ).rejects.toThrow(INSTITUTION_SUSPENDED_MESSAGE);
    await expect(
      asScholar.mutation(api.notifications.updateMyPrefs, {
        emailEnabled: false,
      }),
    ).rejects.toThrow(INSTITUTION_SUSPENDED_MESSAGE);
  });

  test("a platform admin still gets through while a school is suspended", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona,
    });
    // The admin's own authed reads keep working — they must inspect + re-enable.
    await expect(
      asAdmin.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();
  });

  test("a member of a suspended AND an active school keeps full access to the active one", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin, dualTeacher } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona,
    });
    // Lehua teaches at both Moli (active) and Kona (suspended) → not blocked.
    const asTeacher = await withUser(t, dualTeacher);
    await expect(
      asTeacher.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();
    await expect(
      asTeacher.mutation(api.notifications.updateMyPrefs, {
        emailEnabled: true,
      }),
    ).resolves.not.toThrow();
  });

  test("a member of a DIFFERENT active school is unaffected", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin, moliScholar } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona,
    });
    const asMoli = await withUser(t, moliScholar);
    await expect(
      asMoli.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();
  });

  test("re-enabling fully restores access", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin, konaScholar } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);
    const asScholar = await withUser(t, konaScholar);

    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona,
    });
    await expect(
      asScholar.query(api.notifications.getMyPrefs, {}),
    ).rejects.toThrow(INSTITUTION_SUSPENDED_MESSAGE);

    await asAdmin.mutation(api.institutionLifecycle.enableInstitution, {
      institutionId: kona,
    });
    expect(await isDisabled(t, kona)).toBe(false);

    // Access returns for reads AND writes.
    await expect(
      asScholar.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();
    await expect(
      asScholar.mutation(api.notifications.updateMyPrefs, {
        emailEnabled: true,
      }),
    ).resolves.not.toThrow();
  });

  test("neither disable nor enable deletes any data", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);

    const count = async () =>
      await t.run(async (ctx) => ({
        users: (await ctx.db.query("users").collect()).length,
        memberships: (await ctx.db.query("memberships").collect()).length,
        institutions: (await ctx.db.query("institutions").collect()).length,
      }));

    const before = await count();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona,
    });
    await asAdmin.mutation(api.institutionLifecycle.enableInstitution, {
      institutionId: kona,
    });
    const after = await count();
    expect(after).toEqual(before);
  });

  test("disable + enable are idempotent", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);

    const first = await asAdmin.mutation(
      api.institutionLifecycle.disableInstitution,
      { institutionId: kona },
    );
    expect(first.alreadyDisabled).toBe(false);
    const second = await asAdmin.mutation(
      api.institutionLifecycle.disableInstitution,
      { institutionId: kona },
    );
    expect(second.alreadyDisabled).toBe(true);
    // The marker timestamp did not move on the second (no-op) call.
    expect(second.disabledAt).toBe(first.disabledAt);

    const en1 = await asAdmin.mutation(
      api.institutionLifecycle.enableInstitution,
      { institutionId: kona },
    );
    expect(en1.alreadyEnabled).toBe(false);
    const en2 = await asAdmin.mutation(
      api.institutionLifecycle.enableInstitution,
      { institutionId: kona },
    );
    expect(en2.alreadyEnabled).toBe(true);
  });

  test("suspension is audited into the global auditLog", async () => {
    const t = convexTest(schema, modules);
    const { kona, admin } = await seedWorld(t);
    const asAdmin = await withUser(t, admin);
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona,
    });
    await asAdmin.mutation(api.institutionLifecycle.enableInstitution, {
      institutionId: kona,
    });
    const actions = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).map((r) => r.action),
    );
    expect(actions).toContain("institution.disable");
    expect(actions).toContain("institution.enable");
  });
});

describe("isBlockedBySuspension (pure edge logic)", () => {
  const A = "inst_a" as Id<"institutions">;
  const B = "inst_b" as Id<"institutions">;
  const suspendedA = new Set<Id<"institutions">>([A]);

  test("no suspended institutions → never blocked", () => {
    expect(
      isBlockedBySuspension(
        { role: "scholar", institutionId: A },
        [{ role: "scholar", institutionId: A }],
        new Set(),
      ),
    ).toBe(false);
  });

  test("a scholar whose only school is suspended → blocked", () => {
    expect(
      isBlockedBySuspension(
        { role: "scholar", institutionId: A },
        [{ role: "scholar", institutionId: A }],
        suspendedA,
      ),
    ).toBe(true);
  });

  test("a member with an ACTIVE-school membership → not blocked", () => {
    expect(
      isBlockedBySuspension(
        { role: "teacher", institutionId: B },
        [
          { role: "teacher", institutionId: A },
          { role: "teacher", institutionId: B },
        ],
        suspendedA,
      ),
    ).toBe(false);
  });

  test("a platform admin is never blocked", () => {
    expect(
      isBlockedBySuspension(
        { role: "platform_admin", institutionId: undefined },
        [{ role: "platform_admin", institutionId: undefined }],
        suspendedA,
      ),
    ).toBe(false);
  });

  test("an institution-scoped curriculum capability does not bypass suspension", () => {
    expect(
      isBlockedBySuspension(
        { role: "staff", institutionId: A },
        [
          { role: "staff", institutionId: A },
          { role: "curriculum_designer", institutionId: A },
        ],
        suspendedA,
      ),
    ).toBe(true);
  });

  test("an unscoped globally privileged membership still bypasses suspension", () => {
    expect(
      isBlockedBySuspension(
        { role: "staff", institutionId: A },
        [{ role: "curriculum_designer", institutionId: undefined }],
        suspendedA,
      ),
    ).toBe(false);
  });

  test("a parent (no institution membership) is not blocked", () => {
    expect(
      isBlockedBySuspension(
        { role: "parent", institutionId: undefined },
        [{ role: "parent", institutionId: undefined }],
        suspendedA,
      ),
    ).toBe(false);
  });

  test("a user with no ties at all is not blocked", () => {
    expect(
      isBlockedBySuspension(
        { role: "scholar", institutionId: undefined },
        [],
        suspendedA,
      ),
    ).toBe(false);
  });
});

describe("institution deletion membership scope", () => {
  const A = "inst_a" as Id<"institutions">;
  const userId = "user_sloane" as Id<"users">;
  const membership = (
    institutionId: Id<"institutions"> | undefined,
  ): Doc<"memberships"> =>
    ({
      _id: `membership_${institutionId ?? "global"}`,
      _creationTime: 0,
      userId,
      role: "curriculum_designer",
      institutionId,
    }) as Doc<"memberships">;

  test("institution-scoped curriculum capability does not survive its school deletion", () => {
    expect(hasSurvivingMembership([membership(A)], A)).toBe(false);
  });

  test("unscoped curriculum standing survives an institution deletion", () => {
    expect(hasSurvivingMembership([membership(undefined)], A)).toBe(true);
  });
});

describe("evaluateInstitutionSuspension fast paths", () => {
  const institutionId = "inst_kona" as Id<"institutions">;
  const userId = "user_avery" as Id<"users">;

  test.each([
    "platform_admin",
    "curriculum_designer",
    "lifelong_learner",
  ] as const)("%s avoids institution scans", async (role) => {
    const query = vi.fn(() => {
      throw new Error("Globally privileged roles must not query institutions");
    });
    const ctx = { db: { query } } as unknown as QueryCtx;

    await expect(
      evaluateInstitutionSuspension(ctx, {
        _id: userId,
        role,
        institutionId,
      }),
    ).resolves.toEqual({ blocked: false, institutionName: null });
    expect(query).not.toHaveBeenCalled();
  });

  test("an institution-scoped role remains blocked by its suspended school", async () => {
    const query = vi.fn((table: string) => {
      if (table === "institutions") {
        return {
          collect: async () => [
            {
              _id: institutionId,
              name: "Kona Tutoring",
              disabledAt: Date.now(),
            },
          ],
        };
      }
      if (table === "memberships") {
        return {
          withIndex: () => ({
            collect: async () => [
              { role: "school_admin", institutionId, userId },
            ],
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const ctx = { db: { query } } as unknown as QueryCtx;

    await expect(
      evaluateInstitutionSuspension(ctx, {
        _id: userId,
        role: "school_admin",
        institutionId,
      }),
    ).resolves.toEqual({
      blocked: true,
      institutionName: "Kona Tutoring",
    });
    expect(query).toHaveBeenCalledWith("institutions");
    expect(query).toHaveBeenCalledWith("memberships");
  });
});
