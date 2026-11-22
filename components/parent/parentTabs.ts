// Every tab the portal knows how to render. Their components + content blocks
// are kept wired up; which ones are actually reachable is a separate list.
export const PARENT_KNOWN_TABS = [
  "home",
  "progress",
  "portfolio",
  "reports",
  "messages",
  "records",
  "math",
  "homework",
  "calendar",
  "bunnypad",
] as const;

// The always-visible tabs, in nav order. Home is first, so the portal opens
// on it; Records is last, since families visit it a few times a year
// (Andy's call on the parent portal decision board, 2026-11-18). Progress
// remains hidden until it is ready.
export const PARENT_VISIBLE_TABS = [
  "home",
  "portfolio",
  // End-of-term reports a teacher published (TRA-728).
  "reports",
  "math",
  "homework",
  "calendar",
  "messages",
  "bunnypad",
  "records",
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
  bunnypad: "BunnyPad",
  admissions: "Admissions",
};

/** A tab's display name: its override, else the capitalized slug. Shared by
 *  the nav and the browser-tab title (app/parent/[[...tab]]/layout.tsx). */
export function parentTabLabel(tab: ParentTab): string {
  return PARENT_TAB_LABELS[tab] ?? `${tab[0].toUpperCase()}${tab.slice(1)}`;
}

// A program guest (Extended Education visiting student) has no school record,
// so most tabs stay hidden — but their family does see the work and the
// teacher's resources from the programs the child is actually part of, so
// Portfolio is reachable for them too. An applicant family sees only
// Admissions: nothing else in the portal belongs to them yet. An enrolled
// family reaches Admissions (to apply for a sibling and follow that
// application) from the account menu instead of the tab row, so the row fits
// a laptop with two children (parent portal decision board, 2026-11-18).
export function parentVisibleTabs(
  mode: ParentPortalMode = "family",
): ParentTab[] {
  if (mode === "applicant") return ["admissions"];
  if (mode === "program_guest") return ["records", "portfolio", "messages"];
  return [...PARENT_VISIBLE_TABS];
}

export function parentTabFromPath(
  pathname: string,
  mode: ParentPortalMode = "family",
): ParentTab {
  const segment = pathname.split("/")[2];
  const visible = parentVisibleTabs(mode);
  // Settings and Admissions are out of an enrolled family's tab row; the
  // account menu links to both.
  if ((segment === "settings" || segment === "admissions") && mode === "family") {
    return segment;
  }
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
