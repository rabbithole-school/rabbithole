import { describe, expect, test } from "vitest";
import {
  isTeacherRole,
  isStaffRole,
  isScholarAdminRole,
  isCurriculumRole,
  isPlatformAdminRole,
  isSchoolAdminRole,
  canUsePassword,
  PASSKEY_ROLES,
  ROLES,
} from "../roles";

/**
 * Pure-function coverage for the role predicates. These mirror the server's
 * require* gates; their boundaries matter for what each role can see/do after
 * the admin split (platform_admin vs school_admin).
 */
describe("isTeacherRole", () => {
  test("true for teacher + both admin roles", () => {
    expect(isTeacherRole(ROLES.TEACHER)).toBe(true);
    expect(isTeacherRole(ROLES.SCHOOL_ADMIN)).toBe(true);
    expect(isTeacherRole(ROLES.PLATFORM_ADMIN)).toBe(true);
  });

  test("false for curriculum_designer, staff, scholar, parent", () => {
    expect(isTeacherRole(ROLES.CURRICULUM_DESIGNER)).toBe(false);
    expect(isTeacherRole(ROLES.STAFF)).toBe(false);
    expect(isTeacherRole(ROLES.SCHOLAR)).toBe(false);
    expect(isTeacherRole(ROLES.PARENT)).toBe(false);
  });

  test("false for a still-loading user (undefined/null)", () => {
    expect(isTeacherRole(undefined)).toBe(false);
    expect(isTeacherRole(null)).toBe(false);
  });

  test("teacher roles are a strict subset of staff roles", () => {
    // Every teacher-role is staff, but not vice-versa (designer/staff
    // are staff without being teachers).
    expect(isStaffRole(ROLES.TEACHER)).toBe(true);
    expect(isStaffRole(ROLES.CURRICULUM_DESIGNER)).toBe(true);
    expect(isTeacherRole(ROLES.CURRICULUM_DESIGNER)).toBe(false);
  });
});

describe("isPlatformAdminRole", () => {
  test("true for platform_admin only", () => {
    expect(isPlatformAdminRole(ROLES.PLATFORM_ADMIN)).toBe(true);
  });

  test("false for school_admin (NOT platform power) and everyone else", () => {
    expect(isPlatformAdminRole(ROLES.SCHOOL_ADMIN)).toBe(false);
    expect(isPlatformAdminRole(ROLES.TEACHER)).toBe(false);
    expect(isPlatformAdminRole(ROLES.STAFF)).toBe(false);
    expect(isPlatformAdminRole(ROLES.CURRICULUM_DESIGNER)).toBe(false);
    expect(isPlatformAdminRole(ROLES.SCHOLAR)).toBe(false);
    expect(isPlatformAdminRole(ROLES.PARENT)).toBe(false);
    expect(isPlatformAdminRole(undefined)).toBe(false);
  });
});

describe("isSchoolAdminRole", () => {
  test("true for school_admin only", () => {
    expect(isSchoolAdminRole(ROLES.SCHOOL_ADMIN)).toBe(true);
  });

  test("false for platform_admin and everyone else", () => {
    expect(isSchoolAdminRole(ROLES.PLATFORM_ADMIN)).toBe(false);
    expect(isSchoolAdminRole(ROLES.TEACHER)).toBe(false);
    expect(isSchoolAdminRole(undefined)).toBe(false);
  });
});

describe("isScholarAdminRole", () => {
  test("includes teacher, school_admin, and platform_admin", () => {
    expect(isScholarAdminRole(ROLES.TEACHER)).toBe(true);
    expect(isScholarAdminRole(ROLES.SCHOOL_ADMIN)).toBe(true);
    expect(isScholarAdminRole(ROLES.PLATFORM_ADMIN)).toBe(true);
  });

  // Base `staff` is deliberately EXCLUDED here — the retired `registrar` role
  // used to appear in this list, but its scholar-admin power is now granted
  // through the `school:operations` capability grant, checked separately by
  // `requireScholarAdmin` (not by this role-only predicate).
  test("excludes curriculum_designer, staff (capability-gated separately), scholar, parent", () => {
    expect(isScholarAdminRole(ROLES.CURRICULUM_DESIGNER)).toBe(false);
    expect(isScholarAdminRole(ROLES.STAFF)).toBe(false);
    expect(isScholarAdminRole(ROLES.SCHOLAR)).toBe(false);
    expect(isScholarAdminRole(ROLES.PARENT)).toBe(false);
  });
});

describe("isCurriculumRole", () => {
  test("includes teacher, curriculum_designer, school_admin, and platform_admin", () => {
    expect(isCurriculumRole(ROLES.TEACHER)).toBe(true);
    expect(isCurriculumRole(ROLES.CURRICULUM_DESIGNER)).toBe(true);
    expect(isCurriculumRole(ROLES.SCHOOL_ADMIN)).toBe(true);
    expect(isCurriculumRole(ROLES.PLATFORM_ADMIN)).toBe(true);
  });

  test("excludes staff, scholar, parent", () => {
    expect(isCurriculumRole(ROLES.STAFF)).toBe(false);
    expect(isCurriculumRole(ROLES.SCHOLAR)).toBe(false);
    expect(isCurriculumRole(ROLES.PARENT)).toBe(false);
  });
});

/**
 * The passkey-retires-password rule. `blockPasswordIfPasskeyEnrolled` and the
 * profile modal both go through `canUsePassword`, so these assertions are the
 * contract for both: the UI must never offer a password the server refuses,
 * and must never withhold one someone still needs.
 *
 * The profile modal previously derived this from `isCurriculumRole`, which put
 * staff (registrar, at the time) and parents in the scholar branch — telling
 * them "your password always works too" while the server was retiring it out
 * from under them.
 */
describe("canUsePassword", () => {
  test.each(PASSKEY_ROLES)(
    "%s loses password login once a passkey is enrolled",
    (role) => {
      expect(canUsePassword(role, false)).toBe(true);
      expect(canUsePassword(role, true)).toBe(false);
    },
  );

  test.each([ROLES.SCHOLAR, ROLES.LIFELONG_LEARNER])(
    "%s keeps password login — their passkey is additive, so no lockout",
    (role) => {
      expect(canUsePassword(role, false)).toBe(true);
      expect(canUsePassword(role, true)).toBe(true);
    },
  );

  test("staff and parents are covered — the roles the old gate misread", () => {
    expect(canUsePassword(ROLES.STAFF, true)).toBe(false);
    expect(canUsePassword(ROLES.PARENT, true)).toBe(false);
  });

  test("an unknown or missing role keeps its password rather than being locked out", () => {
    expect(canUsePassword(undefined, true)).toBe(true);
    expect(canUsePassword(null, true)).toBe(true);
  });
});
