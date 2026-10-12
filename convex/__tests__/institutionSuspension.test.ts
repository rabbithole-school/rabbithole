import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import {
  curatableInstitutionIds,
  evaluateInstitutionSuspension,
  isBlockedBySuspension,
} from "../lib/access";
import { hasSurvivingMembership } from "../lib/cascade";
import { INSTITUTION_SUSPENDED_MESSAGE } from "../lib/access";
import { makeWorld } from "./factories/world";

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

/** moli (primary) + kona (non-primary) + an admin + one scholar per school +
 *  a teacher with memberships at BOTH schools. */
async function seedWorld(t: T) {
  const world = await makeWorld(t, {
    schools: 2,
    scholarsPerSchool: 1,
    parentsPerSchool: 0,
  });
  const [moli, kona] = world.schools;
  await t.run((ctx) =>
    ctx.db.insert("memberships", {
      userId: moli.teacher.id,
      role: "teacher",
      institutionId: kona.id,
    }),
  );

  return {
    world,
    moli,
    kona,
    admin: world.platformAdmin!,
    konaScholar: kona.scholars[0],
    moliScholar: moli.scholars[0],
    dualTeacher: moli.teacher,
  };
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
    const { world, moli } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();
    await expect(
      asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
        institutionId: moli.id,
      }),
    ).rejects.toThrow(/primary institution cannot be disabled/i);
    expect(await isDisabled(t, moli.id)).toBe(false);
  });

  test("only a platform admin may suspend (a teacher is refused)", async () => {
    const t = convexTest(schema, modules);
    const { world, kona } = await seedWorld(t);
    const asTeacher = await world.as.staffOf(world.schools[0]);
    await expect(
      asTeacher.mutation(api.institutionLifecycle.disableInstitution, {
        institutionId: kona.id,
      }),
    ).rejects.toThrow(/platform-admin/i);
    expect(await isDisabled(t, kona.id)).toBe(false);
  });

  test("disabling blocks a member's authed reads AND writes", async () => {
    const t = convexTest(schema, modules);
    const { world, kona, konaScholar } = await seedWorld(t);
    const asScholar = await world.as.scholar(konaScholar);

    // Before: the Kona scholar can read + write their own prefs.
    await expect(
      asScholar.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();

    // Suspend Kona as the platform admin.
    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
      reason: "billing paused",
    });
    expect(await isDisabled(t, kona.id)).toBe(true);

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
    const { world, kona } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    // The admin's own authed reads keep working — they must inspect + re-enable.
    await expect(
      asAdmin.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();
  });

  test("a member of a suspended AND an active school keeps full access to the active one", async () => {
    const t = convexTest(schema, modules);
    const { world, kona } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    // Lehua teaches at both Moli (active) and Kona (suspended) → not blocked.
    const asTeacher = await world.as.staffOf(world.schools[0]);
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
    const { world, kona, moliScholar } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    const asMoli = await world.as.scholar(moliScholar);
    await expect(
      asMoli.query(api.notifications.getMyPrefs, {}),
    ).resolves.toBeDefined();
  });

  test("re-enabling fully restores access", async () => {
    const t = convexTest(schema, modules);
    const { world, kona, konaScholar } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();
    const asScholar = await world.as.scholar(konaScholar);

    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    await expect(
      asScholar.query(api.notifications.getMyPrefs, {}),
    ).rejects.toThrow(INSTITUTION_SUSPENDED_MESSAGE);

    await asAdmin.mutation(api.institutionLifecycle.enableInstitution, {
      institutionId: kona.id,
    });
    expect(await isDisabled(t, kona.id)).toBe(false);

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
    const { world, kona } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();

    const count = async () =>
      await t.run(async (ctx) => ({
        users: (await ctx.db.query("users").collect()).length,
        memberships: (await ctx.db.query("memberships").collect()).length,
        institutions: (await ctx.db.query("institutions").collect()).length,
      }));

    const before = await count();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    await asAdmin.mutation(api.institutionLifecycle.enableInstitution, {
      institutionId: kona.id,
    });
    const after = await count();
    expect(after).toEqual(before);
  });

  test("disable + enable are idempotent", async () => {
    const t = convexTest(schema, modules);
    const { world, kona } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();

    const first = await asAdmin.mutation(
      api.institutionLifecycle.disableInstitution,
      { institutionId: kona.id },
    );
    expect(first.alreadyDisabled).toBe(false);
    const second = await asAdmin.mutation(
      api.institutionLifecycle.disableInstitution,
      { institutionId: kona.id },
    );
    expect(second.alreadyDisabled).toBe(true);
    // The marker timestamp did not move on the second (no-op) call.
    expect(second.disabledAt).toBe(first.disabledAt);

    const en1 = await asAdmin.mutation(
      api.institutionLifecycle.enableInstitution,
      { institutionId: kona.id },
    );
    expect(en1.alreadyEnabled).toBe(false);
    const en2 = await asAdmin.mutation(
      api.institutionLifecycle.enableInstitution,
      { institutionId: kona.id },
    );
    expect(en2.alreadyEnabled).toBe(true);
  });

  test("suspension is audited into the global auditLog", async () => {
    const t = convexTest(schema, modules);
    const { world, kona } = await seedWorld(t);
    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    await asAdmin.mutation(api.institutionLifecycle.enableInstitution, {
      institutionId: kona.id,
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

describe("institution curation scope", () => {
  async function curationScope(t: T, userId: Id<"users">) {
    return await t.run(async (ctx) => {
      const user = (await ctx.db.get(userId))!;
      const scope = await curatableInstitutionIds(ctx, user);
      return scope === "all" ? scope : Array.from(scope).sort();
    });
  }

  test("a teacher at an active AND a suspended school curates only the active one", async () => {
    const t = convexTest(schema, modules);
    const { world, moli, kona, dualTeacher } = await seedWorld(t);
    expect(await curationScope(t, dualTeacher.id)).toEqual(
      [moli.id, kona.id].sort(),
    );

    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    // Still a working user (Moli is active) — but no longer a curator of the
    // paused school's spaces, equipment, or app audiences.
    expect(await curationScope(t, dualTeacher.id)).toEqual([moli.id]);

    await asAdmin.mutation(api.institutionLifecycle.enableInstitution, {
      institutionId: kona.id,
    });
    expect(await curationScope(t, dualTeacher.id)).toEqual(
      [moli.id, kona.id].sort(),
    );
  });

  test("an unscoped lifelong_learner membership does not make a teacher a curator of every school", async () => {
    const t = convexTest(schema, modules);
    const { kona } = await seedWorld(t);
    await t.run((ctx) =>
      ctx.db.insert("memberships", {
        userId: kona.teacher.id,
        role: "lifelong_learner",
      }),
    );
    expect(await curationScope(t, kona.teacher.id)).toEqual([kona.id]);
  });
});

describe("unit visibility when a staffer's only school is suspended", () => {
  test("an empty lens from suspension is not a membership-less fallback to the primary school", async () => {
    const t = convexTest(schema, modules);
    const { world, moli, kona } = await seedWorld(t);
    // Kona's teacher also holds an institution-less parent membership, which
    // keeps them past the suspension block (a usable context).
    await t.run(async (ctx) => {
      await ctx.db.insert("memberships", { userId: kona.teacher.id, role: "parent" });
      await ctx.db.insert("units", {
        teacherId: moli.teacher.id,
        institutionId: moli.id,
        title: "Primary school unit",
        isActive: true,
      });
    });
    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    const asKonaTeacher = await world.as.staffOf(kona);
    const units = await asKonaTeacher.query(api.units.list, {});
    expect(units.map((u: { title: string }) => u.title)).not.toContain(
      "Primary school unit",
    );
  });

  test("a teacher whose only standing is a staff grant at the suspended school gets no fallback either", async () => {
    const t = convexTest(schema, modules);
    const { world, moli, kona } = await seedWorld(t);
    // Kona's teacher keeps users.role teacher, but their Kona membership is a
    // plain `staff` one backed by a curriculum:edit grant. Grants are filtered
    // to live schools, so after the suspension the grant alone no longer
    // shows standing there.
    await t.run(async (ctx) => {
      const konaMemberships = await ctx.db
        .query("memberships")
        .withIndex("by_user", (q) => q.eq("userId", kona.teacher.id))
        .collect();
      for (const membership of konaMemberships) {
        if (membership.institutionId === kona.id) {
          await ctx.db.patch(membership._id, { role: "staff" });
        }
      }
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: kona.teacher.id,
        institutionId: kona.id,
        capability: "curriculum:edit",
        grantedBy: kona.teacher.id,
        grantedAt: Date.now(),
      });
      await ctx.db.insert("memberships", { userId: kona.teacher.id, role: "parent" });
      await ctx.db.insert("units", {
        teacherId: moli.teacher.id,
        institutionId: moli.id,
        title: "Primary school unit",
        isActive: true,
      });
    });
    const asAdmin = await world.as.platformAdmin();
    await asAdmin.mutation(api.institutionLifecycle.disableInstitution, {
      institutionId: kona.id,
    });
    const asKonaTeacher = await world.as.staffOf(kona);
    const units = await asKonaTeacher.query(api.units.list, {});
    expect(units.map((u: { title: string }) => u.title)).not.toContain(
      "Primary school unit",
    );
  });
});
