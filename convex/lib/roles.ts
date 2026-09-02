export const ROLES = {
  SCHOLAR: "scholar",
  TEACHER: "teacher",
  // ── Admin, split into two explicit concepts ──────────────────────────
  // `platform_admin` = global Rabbithole operator (all institutions,
  // platform settings, user/role admin, integrations). `school_admin` =
  // institution leader (everything inside ONE institution, never platform-
  // wide).
  PLATFORM_ADMIN: "platform_admin",
  SCHOOL_ADMIN: "school_admin",
  CURRICULUM_DESIGNER: "curriculum_designer",
  // Base institution staff role. Specific authority is granted through
  // staffCapabilityGrants (school:operations for scholar-admin, health:manage
  // for health records, etc.). The previous role-based access has been fully
  // retired in favor of this role + explicit grants.
  STAFF: "staff",
  // External guardian who sees ONLY their own linked children's
  // non-sensitive learning data. NOT staff (see STAFF_ROLES). Linked to
  // scholars via the `guardianships` table; gated by `requireGuardianOf`.
  PARENT: "parent",
  // Older-than-grade-band learner (staff dogfooding, adult/lifelong students):
  // scholar-equivalent learning access, no school ties. See Avery in dev seed.
  LIFELONG_LEARNER: "lifelong_learner",
} as const;

export type Role = typeof ROLES[keyof typeof ROLES];

/**
 * "Platform admin" roles — the global Rabbithole operator. Grants
 * cross-institution scholar access + platform powers (user/role admin,
 * integrations, platform settings). Use `isPlatformAdminRole` for any gate
 * that must stay global-only.
 */
export const PLATFORM_ADMIN_ROLES: readonly Role[] = [ROLES.PLATFORM_ADMIN];

export function isPlatformAdminRole(role: Role | undefined | null): boolean {
  return !!role && PLATFORM_ADMIN_ROLES.includes(role);
}

/**
 * "School admin" roles — an institution leader (Head of School / Principal /
 * Director in the UI; the permission is the capability `school_admin`). Has
 * all institution-admin power INSIDE one institution only; never platform-
 * wide. Institution-scoped like teachers and operations staff — a `school_admin`
 * membership always carries an `institutionId`.
 */
export const SCHOOL_ADMIN_ROLES: readonly Role[] = [ROLES.SCHOOL_ADMIN];

export function isSchoolAdminRole(role: Role | undefined | null): boolean {
  return !!role && SCHOOL_ADMIN_ROLES.includes(role);
}

/**
 * A GLOBAL role whose standing is never derived from one institution — a
 * platform admin, a curriculum designer, or a lifelong learner. Such a user is
 * neither swept by an institution DELETE (convex/lib/cascade.ts) nor blocked by
 * an institution SUSPENSION (convex/lib/access.ts), even if they also hold an
 * institution-scoped membership. Excludes `parent` (guardianship-derived) and
 * the institution roles (scholar / teacher / staff / school_admin). Lives
 * here (a leaf module) so both the delete and suspension paths share one source
 * of truth without importing each other.
 */
export function isGloballyPrivilegedRole(
  role: string | undefined | null,
): boolean {
  return (
    role === ROLES.PLATFORM_ADMIN ||
    role === ROLES.CURRICULUM_DESIGNER ||
    role === ROLES.LIFELONG_LEARNER
  );
}

/**
 * Membership rows only carry global standing when they are unscoped. A
 * curriculum_designer membership tied to one institution is a supplemental
 * capability inside that school, not an escape from suspension or deletion.
 */
export function isGloballyPrivilegedMembership(
  membership: {
    role: string | undefined | null;
    institutionId?: unknown;
  },
): boolean {
  return (
    membership.institutionId === undefined &&
    isGloballyPrivilegedRole(membership.role)
  );
}

/**
 * "Staff" roles — everyone with elevated access. These are the roles
 * required to sign in with a passkey (passwordless); scholars keep the
 * username + password flow.
 */
export const STAFF_ROLES: readonly Role[] = [
  ROLES.TEACHER,
  ROLES.PLATFORM_ADMIN,
  ROLES.SCHOOL_ADMIN,
  ROLES.CURRICULUM_DESIGNER,
  ROLES.STAFF,
];

export function isStaffRole(role: Role | undefined | null): boolean {
  return !!role && STAFF_ROLES.includes(role);
}

/**
 * "Teacher" roles — the scholar/curriculum EXECUTION power: plain teachers,
 * plus the two admins (a platform/school admin can act as teaching staff).
 * The client-side mirror of the server's `requireTeacher` gate. Use it to
 * hide *execution* affordances (running assignments, live class progress)
 * from curriculum_designers, who reach the same curriculum surfaces but only
 * do *design*. Returns false for a still-loading user (undefined), so a
 * query/section guarded by it stays skipped until the role is known.
 */
export const TEACHER_ROLES: readonly Role[] = [
  ROLES.TEACHER,
  ROLES.SCHOOL_ADMIN,
  ROLES.PLATFORM_ADMIN,
];

export function isTeacherRole(role: Role | undefined | null): boolean {
  return !!role && TEACHER_ROLES.includes(role);
}

/**
 * "Curriculum" roles — may design/edit curriculum (units, personas,
 * perspectives, processes): teachers, both admins, and the dedicated
 * curriculum_designer. The server mirror is `requireCurriculumAccess`.
 */
export const CURRICULUM_ROLES: readonly Role[] = [
  ROLES.TEACHER,
  ROLES.SCHOOL_ADMIN,
  ROLES.PLATFORM_ADMIN,
  ROLES.CURRICULUM_DESIGNER,
];

export function isCurriculumRole(role: Role | undefined | null): boolean {
  return !!role && CURRICULUM_ROLES.includes(role);
}

/**
 * "Passwordless-primary" roles — accounts for whom a passkey *replaces* the
 * password: enrolling one retires password login (`blockPasswordIfPasskeyEnrolled`
 * in auth.ts), and they're the accounts an operator may issue a one-time
 * passkey enroll link for (enrollment.ts). A SUPERSET of `STAFF_ROLES` that
 * also includes parents.
 *
 * NOTE: this is NOT "who can use a passkey" (anyone can enroll one — it's not
 * role-gated) nor "who can use magic-link email" (that's capability-based now
 * — ANY account with an email is eligible; see `users.isMagicLinkEligible`).
 * Scholars are excluded here specifically so their passkeys/emails stay
 * ADDITIVE: a scholar's password always keeps working (no lockout risk for a
 * kid on a shared device).
 */
export const PASSKEY_ROLES: readonly Role[] = [...STAFF_ROLES, ROLES.PARENT];

export function isPasskeyRole(role: Role | undefined | null): boolean {
  return !!role && PASSKEY_ROLES.includes(role);
}

/**
 * Can this account still sign in with a password?
 *
 * The single source of truth for the passkey-retires-password rule. Both
 * `blockPasswordIfPasskeyEnrolled` (which enforces it at sign-in) and the
 * profile modal (which decides whether to offer "Change Password" and
 * whether to promise that the password keeps working) go through here, so
 * the UI cannot promise a password the server would refuse.
 */
export function canUsePassword(
  role: Role | undefined | null,
  hasPasskey: boolean,
): boolean {
  return !isPasskeyRole(role) || !hasPasskey;
}

/**
 * "Scholar admin" roles — can create and administer scholar accounts and
 * manage portfolios, but NOT sensitive documents / measurements /
 * assessments and NOT curriculum. Teachers and both admins have these
 * powers by role; base `staff` gains them through the `school:operations`
 * capability grant (checked separately in `requireScholarAdmin`), not here.
 * Used by `requireScholarAdmin` / `scholarAdminQuery|Mutation`.
 */
export const SCHOLAR_ADMIN_ROLES: readonly Role[] = [
  ROLES.TEACHER,
  ROLES.SCHOOL_ADMIN,
  ROLES.PLATFORM_ADMIN,
];

export function isScholarAdminRole(role: Role | undefined | null): boolean {
  return !!role && SCHOLAR_ADMIN_ROLES.includes(role);
}

/**
 * Non-teaching operations staff must keep the redaction boundary: school
 * operations never implies access to learning records.
 */
export function isNonTeachingOperationsRole(
  role: Role | undefined | null,
): boolean {
  return role === ROLES.STAFF;
}
