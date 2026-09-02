import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

// Why this file: previewAccessibleScholars is the verification tool for the
// institution access boundary (convex/lib/access.ts) — an admin uses it to
// confirm what a user (e.g. a multi-context teacher) can see per context and
// which context is the default. Pin the two load-bearing behaviors:
// per-context roster + default flag.

describe("accessPreview.previewAccessibleScholars", () => {
  test("reports per-context accessible scholars and flags the default context", async () => {
    const t = convexTest(schema, modules);

    let teacherId!: Id<"users">;
    await t.run(async (ctx) => {
      const instA = await ctx.db.insert("institutions", {
        name: "Alpha School",
        slug: "alpha",
        kind: "school",
        isPrimary: true,
      });
      const instB = await ctx.db.insert("institutions", {
        name: "Beta Tutoring",
        slug: "beta",
        kind: "school",
      });
      teacherId = await ctx.db.insert("users", {
        name: "Teacher",
        username: "teacher1",
        role: "teacher",
      });
      // 2 scholars in Alpha, 1 in Beta — visibility keys off users.institutionId.
      await ctx.db.insert("users", { name: "A2", username: "a2", role: "scholar", institutionId: instA });
      await ctx.db.insert("users", { name: "A1", username: "a1", role: "scholar", institutionId: instA });
      await ctx.db.insert("users", { name: "B1", username: "b1", role: "scholar", institutionId: instB });
      // A distractor scholar in neither institution must NOT appear.
      await ctx.db.insert("users", { name: "Orphan", username: "orphan", role: "scholar" });
      // Alpha membership inserted first → the default (oldest institution-scoped).
      await ctx.db.insert("memberships", { userId: teacherId, role: "teacher", institutionId: instA });
      await ctx.db.insert("memberships", { userId: teacherId, role: "teacher", institutionId: instB });
    });

    const res = await t.query(
      internal.accessPreview.previewAccessibleScholars,
      { userId: teacherId },
    );

    expect(res.user.username).toBe("teacher1");
    expect(res.contexts.length).toBe(2);

    const alpha = res.contexts.find((c) => c.institution?.slug === "alpha")!;
    const beta = res.contexts.find((c) => c.institution?.slug === "beta")!;

    expect(alpha.scholarCount).toBe(2);
    expect(beta.scholarCount).toBe(1);
    // Sorted by username, and the orphan (no institution) is excluded.
    expect(alpha.scholars.map((s) => s.username)).toEqual(["a1", "a2"]);
    expect(beta.scholars.map((s) => s.username)).toEqual(["b1"]);

    // Default = the oldest institution-scoped membership = Alpha.
    expect(alpha.isDefault).toBe(true);
    expect(beta.isDefault).toBe(false);
    expect(res.defaultMembershipId).toBe(alpha.membershipId);
  });

  test("resolves a user by username too", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const inst = await ctx.db.insert("institutions", {
        name: "Solo",
        slug: "solo",
        kind: "school",
      });
      const uid = await ctx.db.insert("users", {
        name: "Only",
        username: "only-teacher",
        role: "teacher",
      });
      await ctx.db.insert("memberships", { userId: uid, role: "teacher", institutionId: inst });
      await ctx.db.insert("users", { name: "S", username: "s", role: "scholar", institutionId: inst });
    });

    const res = await t.query(
      internal.accessPreview.previewAccessibleScholars,
      { username: "only-teacher" },
    );
    expect(res.user.username).toBe("only-teacher");
    expect(res.contexts.length).toBe(1);
    expect(res.contexts[0].scholarCount).toBe(1);
    expect(res.contexts[0].isDefault).toBe(true);
  });
});

// Why this suite: auditEnforcementReadiness is the prod backfill/integrity
// check for the scholar institution boundary. Any orphan scholar or
// institution-less staffer becomes a denial. Pin the two gap kinds and the
// `ready` roll-up.
describe("accessPreview.auditEnforcementReadiness", () => {
  test("reports orphan scholars + staffers missing an institution membership", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const inst = await ctx.db.insert("institutions", {
        name: "Alpha School",
        slug: "alpha",
        kind: "school",
        isPrimary: true,
      });
      // A well-configured scholar (has institution) — must NOT be reported.
      await ctx.db.insert("users", { name: "Rooted", username: "rooted", role: "scholar", institutionId: inst });
      // An orphan scholar (no institution) — MUST be reported.
      await ctx.db.insert("users", { name: "Orphan", username: "orphan", role: "scholar" });
      // A teacher WITH an institution membership — must NOT be reported.
      const okTeacher = await ctx.db.insert("users", { name: "OK Teacher", username: "ok-teacher", role: "teacher" });
      await ctx.db.insert("memberships", { userId: okTeacher, role: "teacher", institutionId: inst });
      // A teacher with NO membership at all — MUST be reported (blocking).
      await ctx.db.insert("users", { name: "Lost Teacher", username: "lost-teacher", role: "teacher" });
      // A staff member (operations-staff successor) WITH a membership but no institutionId — MUST be reported (blocking).
      const reg = await ctx.db.insert("users", { name: "Reg", username: "reg", role: "staff" });
      await ctx.db.insert("memberships", { userId: reg, role: "staff" });
      // A curriculum_designer with no membership — reported but NON-blocking.
      await ctx.db.insert("users", { name: "Des", username: "des", role: "curriculum_designer" });
      // A multi-hat user: users.role is parent, but holds a school_admin
      // membership with no institutionId — detected via the "OR memberships"
      // branch (not their legacy role).
      const multiHat = await ctx.db.insert("users", { name: "Multi", username: "multihat", role: "parent" });
      await ctx.db.insert("memberships", { userId: multiHat, role: "school_admin" });
      // platform_admin with no membership — must NOT be reported (global, excluded).
      await ctx.db.insert("users", { name: "Admin", username: "admin", role: "platform_admin" });
    });

    const res = await t.query(
      internal.accessPreview.auditEnforcementReadiness,
      {},
    );

    expect(res.totalScholars).toBe(2);
    expect(res.scholarsMissingInstitution.map((s) => s.username)).toEqual(["orphan"]);
    expect(res.scholarsMissingInstitutionCount).toBe(1);

    const flaggedStaff = res.staffersWithoutInstitutionMembership
      .map((s) => s.username)
      .sort();
    // lost-teacher, reg, des, multihat reported; ok-teacher + admin NOT.
    expect(flaggedStaff).toEqual(["des", "lost-teacher", "multihat", "reg"]);
    expect(res.staffersWithoutInstitutionMembership.find((s) => s.username === "reg")?.membershipCount).toBe(1);
    expect(res.staffersWithoutInstitutionMembership.find((s) => s.username === "lost-teacher")?.membershipCount).toBe(0);

    // Not ready: an orphan scholar + blocking (teacher/staff) staffers.
    expect(res.ready).toBe(false);
  });

  test("ready === true when the only staff gap is a benign curriculum_designer", async () => {
    const t = convexTest(schema, modules);
    await t.run(async (ctx) => {
      const inst = await ctx.db.insert("institutions", { name: "Solo", slug: "solo", kind: "school", isPrimary: true });
      await ctx.db.insert("users", { name: "S1", username: "s1", role: "scholar", institutionId: inst });
      const teacher = await ctx.db.insert("users", { name: "T", username: "t", role: "teacher" });
      await ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId: inst });
      // A curriculum_designer with no membership: reported but does NOT block.
      await ctx.db.insert("users", { name: "D", username: "d", role: "curriculum_designer" });
    });

    const res = await t.query(internal.accessPreview.auditEnforcementReadiness, {});
    expect(res.scholarsMissingInstitution).toEqual([]);
    // The designer still surfaces in the raw list…
    expect(res.staffersWithoutInstitutionMembership.map((s) => s.role)).toEqual(["curriculum_designer"]);
    // …but readiness is TRUE because the only gap is a benign designer.
    expect(res.ready).toBe(true);
  });
});
