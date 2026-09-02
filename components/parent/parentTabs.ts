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
export type ParentTab = ParentKnownTab | "settings";

// Nav label overrides — most tabs display their capitalized slug ("Records"),
// but "math" reads better as the full "Math Skills" (parity with the teacher
// subtab). The URL slug stays "math".
export const PARENT_TAB_LABELS: Partial<Record<ParentTab, string>> = {
  math: "Math Skills",
};

export function parentVisibleTabs(programGuest = false): ParentTab[] {
  return programGuest ? ["records", "messages"] : [...PARENT_VISIBLE_TABS];
}

export function parentTabFromPath(
  pathname: string,
  programGuest = false,
): ParentTab {
  const segment = pathname.split("/")[2];
  const visible = parentVisibleTabs(programGuest);
  return visible.includes(segment as ParentTab)
    ? (segment as ParentTab)
    : "records";
}
