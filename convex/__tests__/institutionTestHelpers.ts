import type { TestConvex } from "convex-test";
import schema from "../schema";
import type { Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";

type TestCtx = TestConvex<typeof schema>;
type InstitutionStaffRole = Extract<
  Role,
  "teacher" | "staff" | "school_admin" | "curriculum_designer"
>;
type StaffCapability =
  | "school:operations"
  | "health:manage"
  | "curriculum:edit"
  | "program:publish"
  | "captures:review";

// Keep the prefix stable but make each defaulted username unique, so seeding
// more than one fixture user without an explicit username can't collide on
// `by_username(...).unique()`.
let fixtureUsernameCounter = 0;
function nextFixtureUsername(prefix: string): string {
  fixtureUsernameCounter += 1;
  return `${prefix}-${fixtureUsernameCounter}`;
}

export async function seedTestInstitution(
  t: TestCtx,
  options: {
    name?: string;
    slug?: string;
    isPrimary?: boolean;
  } = {},
): Promise<Id<"institutions">> {
  const slug = options.slug ?? "fixture-school";
  return await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("institutions")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("institutions", {
      name: options.name ?? "Fixture School",
      slug,
      kind: "school",
      isPrimary: options.isPrimary,
    });
  });
}

export async function grantInstitutionMembership(
  t: TestCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  role: InstitutionStaffRole = "teacher",
): Promise<Id<"memberships">> {
  return await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_user_role", (q) =>
        q.eq("userId", userId).eq("role", role),
      )
      .filter((q) => q.eq(q.field("institutionId"), institutionId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("memberships", {
      userId,
      role,
      institutionId,
    });
  });
}

export async function seedStaffWithMembership(
  t: TestCtx,
  options: {
    institutionId: Id<"institutions">;
    role?: InstitutionStaffRole;
    name?: string;
    username?: string;
  },
): Promise<Id<"users">> {
  const role = options.role ?? "teacher";
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: options.name ?? `Fixture ${role}`,
      username: options.username ?? nextFixtureUsername(`fixture-${role}`),
      role,
    }),
  );
  await grantInstitutionMembership(t, userId, options.institutionId, role);
  return userId;
}

/**
 * Grant a staff capability to a user at an institution (test helper). Mirrors
 * the runtime `staffCapabilityGrants` shape. Idempotent enough for fixtures.
 */
export async function grantStaffCapability(
  t: TestCtx,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  capability: StaffCapability,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability,
      grantedBy: userId,
      grantedAt: Date.now(),
    });
  });
}

/**
 * Seed a base `staff` member with the `school:operations` capability — the
 * successor to the retired `registrar` role (scholar-admin access without
 * curriculum or sensitive learning data). Pass `health: true` to also grant
 * `health:manage` (health-record access), which registrar used to imply.
 */
export async function seedOperationsStaff(
  t: TestCtx,
  options: {
    institutionId: Id<"institutions">;
    name?: string;
    username?: string;
    health?: boolean;
  },
): Promise<Id<"users">> {
  const userId = await seedStaffWithMembership(t, {
    institutionId: options.institutionId,
    role: "staff",
    name: options.name,
    username: options.username,
  });
  await grantStaffCapability(t, userId, options.institutionId, "school:operations");
  if (options.health) {
    await grantStaffCapability(t, userId, options.institutionId, "health:manage");
  }
  return userId;
}

export async function seedScholarInInstitution(
  t: TestCtx,
  options: {
    institutionId: Id<"institutions">;
    name?: string;
    username?: string;
  },
): Promise<Id<"users">> {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: options.name ?? "Fixture Scholar",
      username: options.username ?? nextFixtureUsername("fixture-scholar"),
      role: "scholar",
      institutionId: options.institutionId,
    }),
  );
}

export async function grantStaffAccessToScholars(
  t: TestCtx,
  options: {
    staffUserId: Id<"users">;
    scholarIds: Id<"users">[];
    role?: InstitutionStaffRole;
    institutionId?: Id<"institutions">;
  },
): Promise<Id<"institutions">> {
  const scholarInstitutions = await t.run(async (ctx) => {
    const institutions = new Set<Id<"institutions">>();
    for (const scholarId of options.scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (!scholar || scholar.role !== "scholar") {
        throw new Error("Fixture scholar must reference a scholar user");
      }
      if (scholar.institutionId) institutions.add(scholar.institutionId);
    }
    return [...institutions];
  });
  if (scholarInstitutions.length > 1) {
    throw new Error("Fixture scholars span multiple institutions");
  }
  const institutionId =
    options.institutionId ??
    scholarInstitutions[0] ??
    (await seedTestInstitution(t));
  if (
    scholarInstitutions.length === 1 &&
    scholarInstitutions[0] !== institutionId
  ) {
    throw new Error("Fixture scholar belongs to a different institution");
  }
  await t.run(async (ctx) => {
    for (const scholarId of options.scholarIds) {
      const scholar = await ctx.db.get(scholarId);
      if (scholar && !scholar.institutionId) {
        await ctx.db.patch(scholarId, { institutionId });
      }
    }
  });
  await grantInstitutionMembership(
    t,
    options.staffUserId,
    institutionId,
    options.role,
  );
  return institutionId;
}
