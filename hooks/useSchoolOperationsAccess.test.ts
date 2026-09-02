import { describe, expect, test } from "vitest";
import {
  hasOperationsAccessForInstitution,
  hasHealthAccessForInstitution,
} from "./useSchoolOperationsAccess";
import type { Id } from "@/convex/_generated/dataModel";

const moli = "institutions:moli" as Id<"institutions">;
const guests = "institutions:guests" as Id<"institutions">;

describe("hasOperationsAccessForInstitution", () => {
  test("uses the active institution for capability-based staff access", () => {
    const user = {
      role: "staff",
      schoolOperationsInstitutionIds: [moli],
      hasSchoolOperationsAccess: true,
    };

    expect(hasOperationsAccessForInstitution(user, moli)).toBe(true);
    expect(hasOperationsAccessForInstitution(user, guests)).toBe(false);
  });

  test("keeps teacher and admin authority role-implied", () => {
    expect(
      hasOperationsAccessForInstitution({ role: "teacher" }, guests),
    ).toBe(true);
    expect(
      hasOperationsAccessForInstitution({ role: "platform_admin" }, guests),
    ).toBe(true);
  });

  test("keeps staff operations authority capability-based", () => {
    expect(
      hasOperationsAccessForInstitution(
        {
          role: "staff",
          hasSchoolOperationsAccess: true,
          schoolOperationsInstitutionIds: [moli],
        },
        moli,
      ),
    ).toBe(true);
    expect(
      hasOperationsAccessForInstitution(
        { role: "staff", hasSchoolOperationsAccess: true },
        moli,
      ),
    ).toBe(false);
  });
});

describe("hasHealthAccessForInstitution", () => {
  test("uses the institution in view for capability-based staff access", () => {
    const user = { role: "staff", healthInstitutionIds: [moli] };
    expect(hasHealthAccessForInstitution(user, moli)).toBe(true);
    expect(hasHealthAccessForInstitution(user, guests)).toBe(false);
  });

  test("a school:operations staffer with NO health institutions is refused everywhere", () => {
    // The reported bug: scholar access via school:operations, but the health
    // set is empty, so no health surface should render for them.
    const opsStaff = { role: "staff", healthInstitutionIds: [] };
    expect(hasHealthAccessForInstitution(opsStaff, moli)).toBe(false);
    expect(hasHealthAccessForInstitution(opsStaff, guests)).toBe(false);
  });

  test("platform-admin 'all' grants health access at any institution", () => {
    const admin = { role: "platform_admin", healthInstitutionIds: "all" };
    expect(hasHealthAccessForInstitution(admin, moli)).toBe(true);
    expect(hasHealthAccessForInstitution(admin, guests)).toBe(true);
  });

  test("has NO blanket isTeacherRole shortcut — a teacher resolves against their own institution only", () => {
    // Distinct from the operations predicate: health authority is precisely the
    // server-computed set, so a teacher whose set is [moli] has NO health access
    // at guests (even though the operations predicate would grant it by role).
    const teacher = { role: "teacher", healthInstitutionIds: [moli] };
    expect(hasHealthAccessForInstitution(teacher, moli)).toBe(true);
    expect(hasHealthAccessForInstitution(teacher, guests)).toBe(false);
    // A base staffer with a health grant behaves the same way — scoped to the
    // institution(s) their server-computed set covers.
    const opsHealthStaff = { role: "staff", healthInstitutionIds: [moli] };
    expect(hasHealthAccessForInstitution(opsHealthStaff, moli)).toBe(true);
    expect(hasHealthAccessForInstitution(opsHealthStaff, guests)).toBe(false);
  });

  test("a null/loading user or a null institution is never granted access", () => {
    expect(hasHealthAccessForInstitution(null, moli)).toBe(false);
    expect(hasHealthAccessForInstitution(undefined, moli)).toBe(false);
    expect(
      hasHealthAccessForInstitution(
        { role: "staff", healthInstitutionIds: [moli] },
        null,
      ),
    ).toBe(false);
  });
});
