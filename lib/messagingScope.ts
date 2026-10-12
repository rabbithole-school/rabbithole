/**
 * The school a page is showing, for the shell chrome (context switcher, nav
 * links). Everywhere else that is the generic institution lens. On Messages
 * the scholar-messaging queries take the REQUESTED `?inst=` verbatim (their
 * own server lens includes mentor-only schools the generic lens folds back
 * into the home school), so there the requested slug is the school in view —
 * the chrome must name that school, not the one the inbox isn't showing.
 * Returns null when the page has no messaging-specific school.
 */
export function messagingSchoolSlug(
  pathname: string | null | undefined,
  requestedScope: string,
): string | null {
  if (!pathname?.startsWith("/teacher/messages")) return null;
  if (!requestedScope || requestedScope === "all") return null;
  return requestedScope;
}
