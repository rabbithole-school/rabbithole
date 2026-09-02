/**
 * Username helpers shared by every account-creation path (server) and the
 * dialogs that feed them (client). Kept pure (no ctx) so they're unit-testable
 * without convex-test — see `convex/__tests__/username.test.ts`. Same shape as
 * `convex/lib/email.ts`.
 *
 * A username is load-bearing in two places at once, which is why it can't hold
 * arbitrary text:
 *  - **A URL path segment** — the scholar profile lives at
 *    `/teacher/scholars/<username>` (`scholarSlug` in `convex/lib/channels.ts`),
 *    and the href builders interpolate it raw. A space, `/`, `?`, `#` or `%`
 *    either re-parses the path into different segments or arrives
 *    percent-encoded and misses the lookup — the 404 this module exists to
 *    prevent.
 *  - **A login key** — the Password provider signs in against the synthetic
 *    address `<username>@local` (`components/AuthForm.tsx`,
 *    `native/src/components/SignIn.tsx`, `convex/enrollment.ts`), so the
 *    username is what a scholar actually types on an iPad. An `@` in the
 *    username collapses that address (`alice@school@local`), and
 *    `convex/auth.ts` recovers the username by stripping from the FIRST `@` —
 *    so `alice@school` would resolve as `alice`, a different account.
 *
 * Deliberately a small DENYLIST, not an allowlist: scholar names can carry
 * ʻokina and diacritics, and an ASCII-only rule would reject `kaʻiulani`.
 */

/** Characters that break the profile URL, its parsing, or the `@local` login key. */
const ILLEGAL = /[/\\?#%@]/;

/**
 * The reason `raw` can't be a username, as a sentence to show the operator —
 * or `null` when it's fine. Checked against the TRIMMED value, so surrounding
 * whitespace (an iPad keyboard's trailing space) is forgiven rather than
 * rejected; the callers store the trimmed form.
 */
export function usernameError(raw: string): string | null {
  const username = raw.trim();
  if (!username) return "Username is required";
  if (/\s/.test(username)) {
    return "Username can't contain spaces — use an underscore instead (e.g. first_last)";
  }
  if (ILLEGAL.test(username)) {
    return "Username can't contain @ / \\ ? # or % — use letters, numbers, dots, dashes or underscores";
  }
  return null;
}

/** Server-side gate: throw `usernameError`'s message, or return the trimmed username. */
export function assertValidUsername(raw: string): string {
  const problem = usernameError(raw);
  if (problem) throw new Error(problem);
  return raw.trim();
}

/**
 * The underscore form of a legacy username that already contains whitespace —
 * the shape `migrations.normalizeSpacedUsernames` converts to. Returns `""` for
 * a username that is nothing but whitespace (the caller skips those rather than
 * storing an empty login key).
 */
export function underscoreUsername(raw: string): string {
  return raw.trim().replace(/\s+/g, "_");
}

/** The synthetic address the Password provider keys its `authAccounts` row on. */
export function passwordAccountId(username: string): string {
  return `${username}@local`;
}
