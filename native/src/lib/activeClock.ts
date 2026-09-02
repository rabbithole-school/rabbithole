// Active-time math for the native game host, extracted as a pure, injectable
// clock so it unit-tests without a renderer, an AppState, or a real wall clock.
//
// "Active time" is wall-clock since the round opened, MINUS any paused span. A
// round can be paused for more than one reason at once (the app went to the
// background AND the coach is open), so pauses are reference-counted: the clock
// is paused while ANY reason is held and accrues a paused span exactly once, no
// matter how many reasons overlap or in what order they release. `now` is always
// passed in (never read from `Date.now()` here) so the caller owns the clock and
// tests are deterministic.
//
// This mirrors the state machine GameHost previously held inline across five
// refs; behaviour is intended to be identical.

export type PauseReason = "background" | "coach";

export interface ActiveClock {
  /**
   * Begin measuring at `now`, resuming from a persisted `baseActiveMs` (the
   * active time the server already recorded for this round). Resets any prior
   * pause state. If `initiallyPaused` (the app is not foregrounded at open),
   * the clock starts paused under the "background" reason.
   */
  open(now: number, baseActiveMs: number, initiallyPaused: boolean): void;
  /**
   * Engage (`paused = true`) or release (`paused = false`) a named pause reason.
   * Reference-counted: engaging an already-held reason, or releasing one that
   * isn't held, is a no-op. A paused span is only opened when the FIRST reason
   * engages after open, and only closed (added to the running paused total) when
   * the LAST reason releases.
   */
  setPauseReason(reason: PauseReason, paused: boolean, now: number): void;
  /**
   * Active ms at `now`: `baseActiveMs` before the clock has opened, otherwise
   * `baseActiveMs + max(0, elapsed - paused)`. Never decreases below the base.
   */
  activeMs(now: number): number;
}

export function createActiveClock(): ActiveClock {
  // 0 until the round actually opens — there is nothing to measure before the
  // server has said hello, and reading a clock during render is impure.
  let openedAt = 0;
  // When the current paused span began, or null when running.
  let pausedAt: number | null = null;
  // Total closed (completed) paused time so far.
  let pausedMs = 0;
  // The reasons currently holding the pause open.
  const pauseReasons = new Set<PauseReason>();
  // Active time the server already had for this round when it opened.
  let baseActiveMs = 0;

  return {
    open(now, base, initiallyPaused) {
      baseActiveMs = base;
      openedAt = now;
      pausedAt = null;
      pausedMs = 0;
      pauseReasons.clear();
      if (initiallyPaused) {
        pauseReasons.add("background");
        pausedAt = now;
      }
    },

    setPauseReason(reason, paused, now) {
      if (paused) {
        if (pauseReasons.has(reason)) return;
        // Only start a paused span once the round is open; before open there is
        // no elapsed time to protect, and open() re-derives the pause state.
        if (pauseReasons.size === 0 && openedAt !== 0) {
          pausedAt = now;
        }
        pauseReasons.add(reason);
        return;
      }

      if (!pauseReasons.delete(reason)) return;
      if (pauseReasons.size === 0 && pausedAt !== null) {
        pausedMs += now - pausedAt;
        pausedAt = null;
      }
    },

    activeMs(now) {
      if (openedAt === 0) return baseActiveMs;
      const paused = pausedMs + (pausedAt === null ? 0 : now - pausedAt);
      return baseActiveMs + Math.max(0, now - openedAt - paused);
    },
  };
}
