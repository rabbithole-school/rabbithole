"use client";

import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { isStaffRole, isTeacherRole, type Role } from "@/convex/lib/roles";
import type { Id } from "@/convex/_generated/dataModel";

// Institution-scoped staff-capability access, resolved against the institution
// currently in view (?inst). Two capabilities share ONE resolution primitive
// (`useInstitutionScopedCapability`) rather than two near-duplicate hook files:
//   • school operations (`useSchoolOperationsAccess`)
//   • health management (`useHealthManagementAccess`)
// The only real difference is the per-institution predicate each passes in — and
// that difference (operations grants teachers/admins by role; health does NOT)
// is kept explicit in the two `has*AccessForInstitution` predicates below.

type OperationsUser = {
  role?: string | null;
  hasSchoolOperationsAccess?: boolean;
  schoolOperationsInstitutionIds?: Id<"institutions">[] | string;
} | null | undefined;

type HealthUser = {
  role?: string | null;
  healthInstitutionIds?: Id<"institutions">[] | string;
} | null | undefined;

export type ClientStaffRole = Role;

export function isClientStaffRole(
  role: string | null | undefined,
): role is ClientStaffRole {
  return role === "staff" || isStaffRole(role as Role | undefined);
}

/**
 * Resolves the school-operations capability against the school currently in
 * view. Teachers and admins retain their role-implied authority; every other
 * staff role, including legacy operations staff, relies on the capability returned by
 * `currentUser`.
 */
export function hasOperationsAccessForInstitution(
  user: OperationsUser,
  institutionId: Id<"institutions"> | null | undefined,
): boolean {
  if (!user) return false;
  if (isTeacherRole(user.role as Role | undefined)) return true;

  const scoped = user.schoolOperationsInstitutionIds;
  if (scoped === "all") return true;
  if (Array.isArray(scoped)) {
    return !!institutionId && scoped.includes(institutionId);
  }
  return false;
}

/**
 * Whether `user` may read/manage health data for a SPECIFIC institution — the
 * one in view. Health records are a SEPARATE capability from school operations
 * (a robotics instructor may run a program — school:operations — and still have
 * no health:manage). Unlike the operations predicate, this has NO blanket
 * `isTeacherRole → true` shortcut: `currentUser.healthInstitutionIds` is already
 * the server's computed set (teacher / school_admin / operations staff get their
 * membership institutions; base staff need an explicit health:manage grant), so
 * keying purely off it is both correct AND institution-precise.
 */
export function hasHealthAccessForInstitution(
  user: HealthUser,
  institutionId: Id<"institutions"> | null | undefined,
): boolean {
  if (!user) return false;
  const scoped = user.healthInstitutionIds;
  if (scoped === "all") return true;
  if (Array.isArray(scoped)) {
    return !!institutionId && scoped.includes(institutionId);
  }
  return false;
}

/**
 * The shared resolution primitive: resolve a per-institution capability
 * predicate against the institution in view. TRI-STATE — `granted` is
 * `undefined` until the active institution resolves, so callers must treat
 * unknown as "not yet" and NOT act on it (the load-window trap).
 */
function useInstitutionScopedCapability(
  resolve: (institutionId: Id<"institutions"> | null | undefined) => boolean,
  enabled = true,
) {
  const { activeInstitution, ...institution } = useActiveInstitution(enabled);
  return {
    ...institution,
    activeInstitution,
    granted:
      activeInstitution === undefined
        ? undefined
        : resolve(activeInstitution?.institutionId),
  };
}

export function useSchoolOperationsAccess(
  user: OperationsUser,
  enabled = true,
) {
  const { granted, ...rest } = useInstitutionScopedCapability(
    (institutionId) => hasOperationsAccessForInstitution(user, institutionId),
    enabled,
  );
  return { ...rest, hasSchoolOperationsAccess: granted };
}

export function useHealthManagementAccess(user: HealthUser, enabled = true) {
  const { granted, ...rest } = useInstitutionScopedCapability(
    (institutionId) => hasHealthAccessForInstitution(user, institutionId),
    enabled,
  );
  return { ...rest, hasHealthManagementAccess: granted };
}
