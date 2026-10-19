/**
 * Freeze Mode on the iPad — pure helpers for `FreezeModeOverlay`.
 *
 * The server sends the boundary (`frozenUntil`), never a verdict, and clears
 * it with a scheduled thaw. The device still compares it to its own clock so
 * an offline iPad thaws on time instead of waiting for a server write it
 * cannot receive.
 */

/** Is the iPad frozen at `now`? */
export function isFrozenAt(
  frozenUntil: number | null | undefined,
  now: number,
): frozenUntil is number {
  return typeof frozenUntil === "number" && frozenUntil > now;
}

/** Milliseconds until the freeze ends, or null when it is not active. */
export function msUntilThaw(
  frozenUntil: number | null | undefined,
  now: number,
): number | null {
  return isFrozenAt(frozenUntil, now) ? frozenUntil - now : null;
}

/** "10:45 AM" — the wall-clock end of a freeze in the iPad's own timezone. */
export function formatThawTime(frozenUntil: number): string {
  return new Date(frozenUntil).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}
