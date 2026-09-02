/**
 * Class-focus policy: the pure decisions behind the scholar-home "class focus"
 * signal. Kept framework-free so web, native, and tests share one policy with
 * no React/Chakra/React Native deps.
 *
 * ## The hard gate is OFF (2026-08-31)
 *
 * This file used to own a HARD gate — a live class focus made every other plate
 * card unstartable (`isLockedByFocus`), froze out-of-focus sessions read-only,
 * pinned the unit picker to the focused unit, and blocked Custom Quest
 * authoring. Teachers found that too rigid in practice, so the enforcement was
 * removed and the focus is now a SOFT signal only: it sorts the focused unit
 * first, names what the class is on, and drives "the turn, not the bell"
 * ambient copy. Nothing a scholar can reach is disabled by a class focus any
 * more.
 *
 * The "lock" vocabulary (`PlateFocusLock`, the `focusLock` prop threaded
 * through both plates) is deliberately kept for now: it is the same value on
 * the same wires, and keeping the names makes re-enabling the gate a clean
 * revert. Rename them once the gate has stayed off — TODO.html#class-focus-gate-followup.
 */

/** The live class-focus signal passed down to plate surfaces. `unitId` is the
 * focused unit; `label` names what the class is on right now. `endsAt` +
 * `timeZone` (both optional — not every caller has them) drive "the turn,
 * not the bell"'s soft "with the class until ~10:25" copy; omit them and a
 * caller just gets the timeless fallback line. Null = no live focus. */
export type PlateFocusLock = {
  unitId: string | null;
  label: string | null;
  endsAt?: number | null;
  timeZone?: string;
} | null;

/**
 * Pick the class-focus entry that should drive the plate's soft focus cues, or
 * null.
 *
 * Only a focus the scholar can start/continue SOLO (`soloStartableByMe`)
 * qualifies — a whole-class card-sort or share-back has no scholar-launched
 * surface, so naming it as "what you're on right now" would point a kid at
 * something they cannot open. Entries are already sorted most-recent-first by
 * `currentClassFocusForMe`, so this returns the most recent solo-startable
 * focus.
 */
export function pickLockingFocus<T extends { soloStartableByMe: boolean }>(
  entries: readonly T[] | undefined | null,
): T | null {
  return entries?.find((e) => e.soloStartableByMe) ?? null;
}

/**
 * Put the unit the class is on right now before the rest of the plate.
 *
 * This is a stable partition: focused-unit rows keep their existing order, as
 * do all remaining rows. It is the main surviving effect of a live class focus
 * — the class's work sorts to the top, and everything else stays startable
 * underneath it.
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
 * True while a scholar's Welcome quest is active but its first beat isn't
 * done yet (H1 fix, review/ftue-audit: "a new scholar gets two competing
 * first actions"). Gates the plate's "new exploration" actions (Custom Quest,
 * suggested quests + peer trails): a zero-history scholar shouldn't be nudged
 * into authoring/exploring before finishing even one beat of onboarding.
 * `onboarding` is the scholar-home onboarding pin (null/undefined once
 * Welcome is finished or was never assigned, in which case this is always
 * false); `completedCount` is that pin's own beat-completion count.
 *
 * This is the ONLY remaining gate on those actions — a live class focus no
 * longer blocks them (see the header).
 */
export function isWelcomeGated(
  onboarding: { completedCount: number } | null | undefined,
): boolean {
  return !!onboarding && onboarding.completedCount === 0;
}
