/**
 * Which part of a long chat thread to draw.
 *
 * A builder session can run to hundreds of turns. One free-play civilization
 * game reached 560 drawn messages (1,741 rows in all) by 2026-11-14, and
 * opening its Chat drew every bubble at once, which held the screen for about
 * ten seconds. The query itself returned in under a second; drawing was the
 * cost. So a thread draws only its newest page when it opens, and one older
 * page at a time as the reader scrolls toward the top.
 *
 * The window is held by the key of the oldest message drawn (the "pin"), not
 * by a count from the end. A count would slide as new turns arrive at the
 * bottom, dropping a message off the top while someone reads above the end.
 *
 * Web: components/vibecode/VibecodeWorkshop.tsx. Native (vendored):
 * native/src/components/vibecode/VibecodeScreen.tsx.
 */

/** Messages drawn when a thread opens, and how many each reveal adds. */
export const THREAD_PAGE_SIZE = 20;

/**
 * How near the top (CSS px on web, points on native) the reader scrolls
 * before the next older page is drawn: early enough that it is there by the
 * time they reach it.
 */
export const THREAD_LOAD_EARLIER_DISTANCE = 300;

/**
 * The oldest message drawn, keyed by the thread it belongs to (`scope`), so a
 * switch to another thread (Edit to Play) starts that one at its newest page.
 */
export type ThreadWindowPin = { scope: string; key: string } | null;

export type ThreadWindow = {
  /** Index of the oldest item drawn; everything from here to the end is drawn. */
  start: number;
  /**
   * The pin to hold. It is the SAME object as the one passed in when nothing
   * moved, so a caller can store it whenever it differs without looping.
   */
  pin: ThreadWindowPin;
};

/**
 * Resolve the window for `items` (oldest first). A pin for this scope whose
 * message is still present holds the window where it is. Otherwise (no pin
 * yet, another thread's pin, or the pinned message is gone) the window opens
 * on the newest `pageSize` items and pins there.
 */
export function resolveThreadWindow<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  pin: ThreadWindowPin,
  scope: string,
  pageSize: number = THREAD_PAGE_SIZE,
): ThreadWindow {
  if (pin && pin.scope === scope) {
    const index = items.findIndex((item) => keyOf(item) === pin.key);
    if (index >= 0) return { start: index, pin };
  }
  const start = Math.max(0, items.length - pageSize);
  const first = items[start];
  return {
    start,
    pin: first === undefined ? null : { scope, key: keyOf(first) },
  };
}

/** The pin that draws one more page above `start`. */
export function earlierThreadPin<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  start: number,
  scope: string,
  pageSize: number = THREAD_PAGE_SIZE,
): ThreadWindowPin {
  const first = items[Math.max(0, start - pageSize)];
  return first === undefined ? null : { scope, key: keyOf(first) };
}
