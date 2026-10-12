import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { isApplicantOnlyParent } from "../lib/applicantParent";
import {
  seedScholarInInstitution,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: an applicant family gets a parent account stamped with the
// primary institution and no guardianship. The portal shows them only
// Admissions, and the guardian-only pages (health form, guardian forms) must
// refuse them server side, not just hide the links.

type T = ReturnType<typeof convexTest>;

async function seedPrimary(t: T) {
  return await seedTestInstitution(t, {
    name: "Primary School",
    slug: "primary",
    isPrimary: true,
  });
}

async function seedParent(
  t: T,
  options: {
    username: string;
    role?: Doc<"users">["role"];
    membershipInstitutionId?: Id<"institutions"> | null;
  },
) {
  return await t.run(async (ctx) => {
    const role = options.role ?? "parent";
    const userId = await ctx.db.insert("users", {
      name: `Test ${options.username}`,
      username: options.username,
      email: `${options.username}@example.com`,
      role,
    });
    if (options.membershipInstitutionId !== undefined) {
      await ctx.db.insert("memberships", {
        userId,
        role: "parent",
        ...(options.membershipInstitutionId
          ? { institutionId: options.membershipInstitutionId }
          : {}),
      });
    }
    return userId;
  });
}

async function linkGuardian(
  t: T,
  parentUserId: Id<"users">,
  scholarUserId: Id<"users">,
) {
  await t.run((ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId,
      scholarUserId,
      createdBy: parentUserId,
    }),
  );
}

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

function predicate(t: T, userId: Id<"users">) {
  return t.run((ctx) => isApplicantOnlyParent(ctx, userId));
}

describe("isApplicantOnlyParent", () => {
  test("true for a parent with a primary-institution membership and no guardianship", async () => {
    const t = convexTest(schema, modules);
    const primary = await seedPrimary(t);
    const applicant = await seedParent(t, {
      username: "applicant",
      membershipInstitutionId: primary,
    });
    expect(await predicate(t, applicant)).toBe(true);
  });

  test("false once a child is linked", async () => {
    const t = convexTest(schema, modules);
    const primary = await seedPrimary(t);
    const parent = await seedParent(t, {
      username: "enrolled",
      membershipInstitutionId: primary,
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId: primary,
    });
    await linkGuardian(t, parent, scholar);
    expect(await predicate(t, parent)).toBe(false);
  });

  test("false when the parent membership is unstamped or at another institution", async () => {
    const t = convexTest(schema, modules);
    await seedPrimary(t);
    const other = await seedTestInstitution(t, {
      name: "Other School",
      slug: "other",
    });
    const unstamped = await seedParent(t, {
      username: "unstamped",
      membershipInstitutionId: null,
    });
    const elsewhere = await seedParent(t, {
      username: "elsewhere",
      membershipInstitutionId: other,
    });
    const noMembership = await seedParent(t, { username: "bare" });
    expect(await predicate(t, unstamped)).toBe(false);
    expect(await predicate(t, elsewhere)).toBe(false);
    expect(await predicate(t, noMembership)).toBe(false);
  });

  test("false for a non-parent role, even with a primary parent membership", async () => {
    const t = convexTest(schema, modules);
    const primary = await seedPrimary(t);
    const teacher = await seedParent(t, {
      username: "teacher-hat",
      role: "teacher",
      membershipInstitutionId: primary,
    });
    expect(await predicate(t, teacher)).toBe(false);
  });

  test("false before a primary institution exists", async () => {
    const t = convexTest(schema, modules);
    const school = await seedTestInstitution(t, { slug: "not-primary" });
    const parent = await seedParent(t, {
      username: "early",
      membershipInstitutionId: school,
    });
    expect(await predicate(t, parent)).toBe(false);
  });
});

describe("parents.applicantContext", () => {
  test("reports applicant mode for the signed-in applicant only", async () => {
    const t = convexTest(schema, modules);
    const primary = await seedPrimary(t);
    const applicant = await seedParent(t, {
      username: "applicant",
      membershipInstitutionId: primary,
    });
    const enrolled = await seedParent(t, {
      username: "enrolled",
      membershipInstitutionId: primary,
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId: primary,
    });
    await linkGuardian(t, enrolled, scholar);

    const asApplicant = await withUser(t, applicant);
    const asEnrolled = await withUser(t, enrolled);
    expect(await asApplicant.query(api.parents.applicantContext, {})).toEqual({
      applicantOnly: true,
    });
    expect(await asEnrolled.query(api.parents.applicantContext, {})).toEqual({
      applicantOnly: false,
    });
  });
});

describe("guardian-only pages refuse applicant-only parents", () => {
  async function setup() {
    const t = convexTest(schema, modules);
    const primary = await seedPrimary(t);
    const applicant = await seedParent(t, {
      username: "applicant",
      membershipInstitutionId: primary,
    });
    const enrolled = await seedParent(t, {
      username: "enrolled",
      membershipInstitutionId: primary,
    });
    const scholar = await seedScholarInInstitution(t, {
      institutionId: primary,
    });
    await linkGuardian(t, enrolled, scholar);
    return {
      t,
      scholar,
      asApplicant: await withUser(t, applicant),
      asEnrolled: await withUser(t, enrolled),
    };
  }

  test("canOpenGuardianForms: applicant false, enrolled guardian true", async () => {
    const { asApplicant, asEnrolled } = await setup();
    // The old page gate let any parent role through.
    expect(await asApplicant.query(api.parents.hasParentContext, {})).toBe(true);
    expect(await asApplicant.query(api.parents.canOpenGuardianForms, {})).toBe(
      false,
    );
    expect(await asEnrolled.query(api.parents.canOpenGuardianForms, {})).toBe(
      true,
    );
  });

  test("the health form and guardian form reads deny an applicant", async () => {
    const { asApplicant, scholar } = await setup();
    expect(await asApplicant.query(api.parents.listMyChildren, {})).toEqual([]);
    await expect(
      asApplicant.query(api.scholarHealthRecords.getHealthRecord, {
        scholarId: scholar,
      }),
    ).rejects.toThrow();
  });
});
