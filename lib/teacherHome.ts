import { ROLES } from "@/convex/lib/roles";
import { withInstitutionScope } from "@/lib/institutionLinks";

/**
 * The default teacher surface a staff role lands on — their "home". Use this to
 * link a staff user straight to their home tab instead of bouncing through the
 * bare `/teacher` redirector (which only exists to resolve this for links that
 * don't know the role).
 */
export function teacherHomePath(
  role: string | undefined,
  hasSchoolOperationsAccess = false,
): string {
  return role === ROLES.CURRICULUM_DESIGNER
    ? "/teacher/curriculum"
    : role === ROLES.STAFF && hasSchoolOperationsAccess
      ? "/teacher/scholars"
      : role === ROLES.STAFF
        ? "/teacher/apps"
      : "/teacher";
}

/**
 * `teacherHomePath` carrying the active institution lens — what the logo in the
 * staff header links to. It resolves the role's home directly rather than
 * pointing at `/`, because `/` re-resolves the role client-side and forwards no
 * `?inst=`, so going home through it would silently drop the school in view.
 */
export function teacherHomeHref(
  role: string | undefined,
  scope: string | null | undefined,
  hasSchoolOperationsAccess = false,
): string {
  return withInstitutionScope(
    teacherHomePath(role, hasSchoolOperationsAccess),
    scope ?? "",
  );
}
