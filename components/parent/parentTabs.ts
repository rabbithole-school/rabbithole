// Every tab the portal knows how to render. Their components + content blocks
// are kept wired up; which ones are actually reachable is a separate list.
export const PARENT_KNOWN_TABS = [
  "progress",
  "portfolio",
  "messages",
  "records",
  "math",
  "calendar",
] as const;

// The always-visible tabs. Progress remains hidden until it is ready.
export const PARENT_VISIBLE_TABS = [
  "records",
  "portfolio",
  "math",
  "calendar",
  "messages",
] as const;

export type ParentKnownTab = (typeof PARENT_KNOWN_TABS)[number];
export type ParentVisibleTab = (typeof PARENT_VISIBLE_TABS)[number];
export type ParentTab = ParentKnownTab | "admissions" | "settings";

// Which family is looking. `family` is an enrolled family. `program_guest` is
// an Extended Education visiting student's family. `applicant` is a family
// that has applied but has no enrolled child linked yet: they see only their
// child's application (server-derived; see parents.applicantContext).
export type ParentPortalMode = "family" | "program_guest" | "applicant";

export function parentPortalMode({
  applicantOnly,
  programGuest,
}: {
  applicantOnly: boolean;
  programGuest: boolean;
}): ParentPortalMode {
  if (applicantOnly) return "applicant";
  return programGuest ? "program_guest" : "family";
}

// Nav label overrides — most tabs display their capitalized slug ("Records"),
// but "math" reads better as the full "Math Skills" (parity with the teacher
// subtab). The URL slug stays "math".
export const PARENT_TAB_LABELS: Partial<Record<ParentTab, string>> = {
  math: "Math Skills",
  admissions: "Admissions",
};

// A program guest (Extended Education visiting student) has no school record,
// so most tabs stay hidden — but their family does see the work and the
// teacher's resources from the programs the child is actually part of, so
// Portfolio is reachable for them too. An applicant family sees only
// Admissions: nothing else in the portal belongs to them yet. An enrolled
// family sees Admissions last, to apply for a sibling and follow that
// application.
export function parentVisibleTabs(
  mode: ParentPortalMode = "family",
): ParentTab[] {
  if (mode === "applicant") return ["admissions"];
  if (mode === "program_guest") return ["records", "portfolio", "messages"];
  return [...PARENT_VISIBLE_TABS, "admissions"];
}

export function parentTabFromPath(
  pathname: string,
  mode: ParentPortalMode = "family",
): ParentTab {
  const segment = pathname.split("/")[2];
  const visible = parentVisibleTabs(mode);
  return visible.includes(segment as ParentTab)
    ? (segment as ParentTab)
    : visible[0];
}

// Session storage key: set while the portal is in applicant mode, so a
// session that expires anywhere in the portal still returns the family to
// the school-branded sign-in (useCurrentUser is null by then, and the
// applicant check can no longer run).
export const APPLICANT_PORTAL_MARKER = "rh:parent-applicant-portal";

/**
 * Where a signed-out visitor to the parent portal signs back in. The
 * Admissions tab exists only for applicant families, and they sign in on
 * `/admissions/sign-in` (school-branded email link), never the generic
 * `/sign-in`. `applicantSeen` covers the rest of the portal for a browser
 * that last showed applicant mode. `?next=` brings them back.
 */
export function parentSignInHref(
  currentPath: string,
  applicantSeen = false,
): string {
  const pathname = currentPath.split(/[?#]/)[0];
  const onAdmissions =
    pathname === "/parent/admissions" ||
    pathname.startsWith("/parent/admissions/");
  const base =
    applicantSeen || onAdmissions ? "/admissions/sign-in" : "/sign-in";
  return `${base}?next=${encodeURIComponent(currentPath)}`;
}
