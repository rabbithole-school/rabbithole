/**
 * Focus-lock policy: the pure decisions behind the scholar-home/read-only
 * "class focus" wall. Kept framework-free so web, native, and tests share one
 * policy with no React/Chakra/React Native deps.
 */

/** The live class-focus lock passed down to plate surfaces. `unitId` is the
 * focused unit; `label` names what the class is on right now. `endsAt` +
 * `timeZone` (both optional — not every caller has them) drive "the turn,
 * not the bell"'s soft "with the class until ~10:25" copy; omit them and a
 * caller just gets the timeless fallback line. Null = no lock. */
export type PlateFocusLock = {
  unitId: string | null;
  label: string | null;
  endsAt?: number | null;
  timeZone?: string;
} | null;

/** A plate card's origin — how the work got onto the scholar's plate. */
export type PlateOrigin = "classFocus" | "homework" | "is";

/**
 * Pick the class-focus entry that should drive the read-only lock, or null.
 *
 * Only a focus the scholar can start/continue SOLO (`soloStartableByMe`) may
 * impose the wall. Entries are already sorted most-recent-first by
 * `currentClassFocusForMe`, so this returns the most recent solo-startable
 * focus. When no live focus is solo-startable, there is no hard lock.
 */
export function pickLockingFocus<T extends { soloStartableByMe: boolean }>(
  entries: readonly T[] | undefined | null,
): T | null {
  return entries?.find((e) => e.soloStartableByMe) ?? null;
}

/**
 * Put the unit that drives the focus lock before rows that are locked by it.
 *
 * This is a stable partition: focused-unit rows keep their existing order, as
 * do all remaining rows. Without it, a newer non-solo class activity can appear
 * above the solo activity named by "After you finish", visually reversing the
 * required sequence.
 */
export function prioritizeFocusedUnit<T extends { unitId?: string | null }>(
  items: readonly T[],
  focusLock: PlateFocusLock,
): T[] {
  if (!focusLock?.unitId) return [...items];
  const focused: T[] = [];
  const remaining: T[] = [];
  for (const item of items) {
    (String(item.unitId ?? "") === focusLock.unitId ? focused : remaining).push(
      item,
    );
  }
  return [...focused, ...remaining];
}

/**
 * A plate card is locked when a solo-startable class focus is live and the card
 * would open a session outside the focused unit.
 *
 * Homework-origin cards are exempt: homework is required, independently
 * scheduled work, not the "new exploration" the wall exists to defer.
 */
export function isLockedByFocus(
  focusLock: PlateFocusLock,
  rowUnitId: string | null | undefined,
  origin?: PlateOrigin,
): boolean {
  if (!focusLock?.unitId) return false;
  if (origin === "homework") return false;
  return String(rowUnitId ?? "") !== focusLock.unitId;
}

/**
 * True while a scholar's Welcome quest is active but its first beat isn't
 * done yet (H1 fix, review/ftue-audit: "a new scholar gets two competing
 * first actions"). Gates the SAME "new exploration" plate actions a live
 * class focus locks (Custom Quest, suggested quests + peer trails), for a
 * different reason: a zero-history scholar shouldn't be nudged into
 * authoring/exploring before finishing even one beat of onboarding.
 * `onboarding` is the scholar-home onboarding pin (null/undefined once
 * Welcome is finished or was never assigned, in which case this is always
 * false); `completedCount` is that pin's own beat-completion count.
 */
export function isWelcomeGated(
  onboarding: { completedCount: number } | null | undefined,
): boolean {
  return !!onboarding && onboarding.completedCount === 0;
}
