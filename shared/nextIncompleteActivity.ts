/**
 * NEXT INCOMPLETE ACTIVITY — the ONE cross-surface rule for the in-session
 * "Continue" / "Up next" CTA: which activity comes NEXT, forward-only.
 *
 * Why this file exists: both frontends computed the in-session "next activity"
 * with a wrap-around fallback — when everything AFTER the current activity was
 * complete, they fell back to the first incomplete activity ANYWHERE in the
 * unit, scanning from the beginning. In production a scholar finished the LAST
 * beat of the 3-beat Welcome sequence while beat 1 was still incomplete; the
 * CTA said "Up next" / "Continue" and silently navigated him BACKWARD into his
 * old beat-1 session — he thought the sequence had restarted. (See the
 * welcome-continue-bug investigation.)
 *
 * THE INVARIANT: "Continue" / "Up next" must NEVER navigate backward. This
 * helper only ever returns an item strictly AFTER `currentIndex`. When every
 * later activity is done it returns `null`, even if an EARLIER activity is
 * still incomplete — routing a scholar back to an earlier hole is the Home
 * surface's job (the onboarding pin in `convex/scholarPlate.ts` already names
 * and resumes the earliest incomplete beat). At end-of-unit with an earlier
 * hole, the session hands off to Home.
 *
 * Both the web `components/SessionActivityNav.tsx` nav and the native
 * `native/src/hooks/useUnitProgress.ts` hook derive their forward "next" here,
 * so the two surfaces cannot drift. Imports nothing, so it resolves standalone
 * under Metro when vendored (native/scripts/sync-vendor.js).
 */

/**
 * The first item AFTER `currentIndex` for which `isCompleted` is false, or
 * `null` when none remains.
 *
 * Forward-only: scans `ordered[currentIndex + 1 ..]` and NEVER returns an item
 * at or before `currentIndex` (when `currentIndex >= 0`). When `currentIndex`
 * is negative (the current activity is not in the list), the whole list is
 * scanned from the beginning.
 */
export function pickNextIncompleteAfter<T>(
  ordered: readonly T[],
  currentIndex: number,
  isCompleted: (t: T) => boolean,
): T | null {
  const start = currentIndex >= 0 ? currentIndex + 1 : 0;
  for (let i = start; i < ordered.length; i++) {
    if (!isCompleted(ordered[i])) return ordered[i];
  }
  return null;
}
