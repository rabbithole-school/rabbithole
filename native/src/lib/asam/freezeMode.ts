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

/**
 * The wall-clock end of a freeze in the iPad's own timezone: "10:45 AM" today,
 * "Tuesday at 10:45 AM" on a later day. A freeze is under a week, so the
 * weekday is unambiguous.
 */
export function formatThawTime(
  frozenUntil: number,
  now: number = Date.now(),
): string {
  const end = new Date(frozenUntil);
  const time = end.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  if (end.toDateString() === new Date(now).toDateString()) return time;
  return `${end.toLocaleDateString([], { weekday: "long" })} at ${time}`;
}

/** Who set the freeze. Older servers omit it; treat that as the school. */
export type FrozenBy = "family" | "school" | null | undefined;

/**
 * The overlay's words. A family freeze tells the scholar to ask their parent;
 * the school wording covers "school" and a missing value (an older server).
 */
export function freezeCopy(frozenBy: FrozenBy, until: string) {
  const family = frozenBy === "family";
  const ask = family ? "Ask your parent." : "Ask a teacher to unfreeze it.";
  return {
    title: `This BunnyPad is frozen until ${until}`,
    body: ask,
    label: `This BunnyPad is frozen until ${until}. ${family ? "Ask your parent to unfreeze it." : ask}`,
  };
}
