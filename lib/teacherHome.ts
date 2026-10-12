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
  hasCurriculumAccess = false,
  mentorOnly = false,
): string {
  if (role === ROLES.CURRICULUM_DESIGNER) return "/teacher/curriculum";
  if (role === ROLES.STAFF) {
    // A mentor-only staffer's one surface is Messages (it opens on Scholars,
    // the only kind they can see).
    if (mentorOnly) return "/teacher/messages";
    // `staff` is the BASE institution role — it carries no authority of its
    // own, so a staffer's home is whichever section their capability grants
    // actually open. The order mirrors `teacherNavKeysForRole`'s staff branch
    // (its first key is this href), and a test asserts the two stay in step.
    if (hasSchoolOperationsAccess) return "/teacher/scholars";
    if (hasCurriculumAccess) return "/teacher/curriculum";
    // No grants (or health:manage only, which opens nothing under /teacher):
    // the school shell is their one working surface — it routes on to the
    // first section their grants allow, e.g. /school/health. Sending them to
    // a /teacher tab instead is what put a health staffer on an error page.
    return "/school";
  }
  return "/teacher";
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
  hasCurriculumAccess = false,
  mentorOnly = false,
): string {
  return withInstitutionScope(
    teacherHomePath(
      role,
      hasSchoolOperationsAccess,
      hasCurriculumAccess,
      mentorOnly,
    ),
    scope ?? "",
  );
}
