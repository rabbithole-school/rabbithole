// Where /tutor-key sends the person once the key is saved (TRA-536): the
// chat's "Add the key" link carries the chat's own path as `?next=`, and the
// page navigates there after a successful save. Anyone can craft that link,
// so only a same-origin relative path is honored; anything else falls back
// to the scholar home.

/** Where a missing or unusable `next` lands. */
export const TUTOR_KEY_DEFAULT_RETURN = "/scholar";

const PROBE_ORIGIN = "http://tutor-key.invalid";

/**
 * `raw` when it is a same-origin relative path (one leading "/", no scheme,
 * no backslashes, no control characters), else TUTOR_KEY_DEFAULT_RETURN.
 */
export function safeTutorKeyReturnPath(raw: unknown): string {
  if (typeof raw !== "string") return TUTOR_KEY_DEFAULT_RETURN;
  if (!raw.startsWith("/") || raw.startsWith("//")) return TUTOR_KEY_DEFAULT_RETURN;
  // Browsers read "\" as "/" and strip tabs/newlines, so "/\evil.com" and
  // "/\t/evil.com" would both become protocol-relative.
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return TUTOR_KEY_DEFAULT_RETURN;
  try {
    if (new URL(raw, PROBE_ORIGIN).origin !== PROBE_ORIGIN) {
      return TUTOR_KEY_DEFAULT_RETURN;
    }
  } catch {
    return TUTOR_KEY_DEFAULT_RETURN;
  }
  return raw;
}

/** The "Add the key" link: the key page, returning to `returnTo` after a save. */
export function tutorKeyHref(addKeyPath: string, returnTo: string): string {
  const next = safeTutorKeyReturnPath(returnTo);
  return `${addKeyPath}?next=${encodeURIComponent(next)}`;
}
