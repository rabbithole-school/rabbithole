/**
 * Email helpers shared by the magic-link auth path and the trusted
 * email-entry mutations. Kept pure (no ctx) so they're unit-testable
 * without convex-test — see `convex/__tests__/email.test.ts`.
 */

/**
 * Canonical form of an email address for storage + lookup: trimmed and
 * lowercased. We compare emails case-insensitively (RFC says the local
 * part *can* be case-sensitive, but no real mail provider treats it that
 * way, and Resend/Gmail/etc. fold case). Storing the normalized form lets
 * the exact-match `by_email` index do case-insensitive lookups for free.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Minimal structural email validation — one `@`, non-empty local part,
 * a dot in the domain. Deliberately permissive (the real proof an address
 * works is that the magic link gets clicked); this only catches obvious
 * typos / empty input before we store an address or try to send to it.
 */
export function isValidEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  if (!email || email.length > 320) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  const domain = email.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return false;
  }
  return !/\s/.test(email);
}
