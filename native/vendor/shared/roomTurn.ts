/**
 * "The turn, not the bell" — the pure policy behind every scholar/teacher-
 * facing surface that talks about a live class-focus push ending. The school
 * runs no bell schedule: a block "turning" (its `endsAt` passing, or a
 * teacher wrapping it early) is an INVITATION, never enforcement. Kept
 * framework-free so web, native, and tests share ONE tested source of copy +
 * timing — the SCHOLAR-facing parity mandate (CLAUDE.md) makes copy drift
 * between web and native a defect, so every string a kid sees is built here,
 * once, and both frontends just render it.
 *
 * Non-negotiables this file encodes:
 *   - No numeric countdown ever reaches a scholar's screen — phases are
 *     coarse (a 30s poll, not a ticking clock) and copy never says "in N
 *     minutes/seconds", only a soft "~h:mm" wall-clock instant or a plain
 *     "soon".
 *   - Nothing is yanked at `endsAt` — a class focus has NO mechanical effect on
 *     a scholar's screen at all (the hard gate was removed; see
 *     shared/focusLock.ts); their session and work are untouched throughout.
 *   - The "running long" + lingering-scholar awareness are TEACHER-only
 *     concepts — the "no ticking" rule is scoped to a kid's screen, not a
 *     teacher's dashboard.
 */

// ─── Phase derivation (scholar-facing) ─────────────────────────────────

export type RoomTurnPhase = "withClass" | "windingDown" | "turned";

/** The soft "find a good stopping point" window before the room turns. */
export const ROOM_TURN_WINDING_DOWN_MS = 3 * 60 * 1000;

/**
 * Which of the three phases a class-focus push is in, given the scholar's
 * own wall clock and the push's `endsAt` (or null/undefined for an
 * open-ended push, which never winds down or turns on its own — only an
 * explicit teacher "Wrap now" ends it, observed separately as a lock-lift).
 */
export function roomTurnPhase(
  nowMs: number,
  endsAt: number | null | undefined,
): RoomTurnPhase {
  if (endsAt == null) return "withClass";
  const remaining = endsAt - nowMs;
  if (remaining <= 0) return "turned";
  if (remaining <= ROOM_TURN_WINDING_DOWN_MS) return "windingDown";
  return "withClass";
}

/**
 * "10:25 AM"-style local wall-clock label for when a block wraps, in the
 * INSTITUTION's timezone (never the device's raw locale-guess) — a scholar
 * traveling, or a misconfigured device clock, must still see the SCHOOL's
 * turn time. Returns null for an unparseable timezone rather than throwing,
 * so a bad value degrades to "no time shown" instead of crashing a render.
 */
export function formatRoomTurnTime(
  endsAt: number,
  timeZone: string,
): string | null {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(endsAt));
  } catch {
    return null;
  }
}

// ─── Copy builders — the ONLY place these strings are written ──────────

/**
 * The plate's class-focus card, for the row that IS the live matching focus
 * (item 1 + item 2 of "the turn, not the bell"). Softens once winding down;
 * never mentions a number of minutes.
 */
export function classFocusPlateLine(
  phase: RoomTurnPhase,
  timeLabel: string | null,
): string {
  if (phase === "windingDown") {
    return timeLabel
      ? `The room's moving on soon (~${timeLabel}) — find a good stopping point.`
      : "The room's moving on soon — find a good stopping point.";
  }
  return timeLabel
    ? `With the class until the block wraps (~${timeLabel})`
    : "With the class right now";
}

/**
 * The "your class is elsewhere" banner (item 1) — shown when the scholar is
 * viewing a DIFFERENT session than the live class focus. Purely informational
 * since the hard focus gate was removed (shared/focusLock.ts): the session
 * stays fully usable, so the copy names where the room is and stops there —
 * it must never imply the scholar has to wait to send.
 */
export function focusMismatchBannerText(
  phase: RoomTurnPhase,
  focusName: string | null,
  timeLabel: string | null,
): string {
  const who = focusName ? `your class is with ${focusName}` : "your class is on something else";
  if (phase === "windingDown") {
    return timeLabel
      ? `Right now ${who} — the room moves on soon (~${timeLabel}).`
      : `Right now ${who} — the room moves on soon.`;
  }
  return timeLabel
    ? `Right now ${who}, until the block wraps (~${timeLabel}).`
    : `Right now ${who}.`;
}

/** The in-session "find a good stopping point" cue (item 2) — shown only
 *  while the scholar is INSIDE the matching focus session itself. Verbatim,
 *  no time — the design spec's exact soft phrase. */
export const WINDING_DOWN_BANNER_TEXT =
  "The room moves on soon — find a good stopping point.";

/** The in-session "at the turn" banner (item 3) — the choice, not the cliff. */
export const TURNED_BANNER_TEXT =
  "The room's moved on — head over when you're ready, or finish your thought first.";

// ─── "At the turn" awareness memory (scholar-facing state machine) ─────

/**
 * Whether we've announced the turn is STICKY on `turned`, not re-derived from
 * `matched` on every check — `isFocusMatch` and the client-derived `phase`
 * come from two independent hooks (a query result vs. a client-side clock),
 * so they don't always update in the same render: `isFocusMatch` can flip to
 * false a tick before `phase` catches up to reflect it (or vice versa). If
 * "should we show the banner" were re-derived from `matched` on every single
 * check, that harmless one-tick staleness would flip the banner on then
 * immediately back off. Storing `turned` as its own sticky field means once
 * we decide to show it, later checks with the SAME "not matched" reality
 * can't un-decide it — only a fresh live match resets it.
 */
export type RoomTurnMemory = {
  matched: boolean;
  label: string | null;
  turned: boolean;
  /** The last matching focus's scheduled end, if it had one. */
  endsAt: number | null;
  /** A scheduled focus lost its match before its known end. */
  scheduledTurnPending: boolean;
};

export const INITIAL_ROOM_TURN_MEMORY: RoomTurnMemory = {
  matched: false,
  label: null,
  turned: false,
  endsAt: null,
  scheduledTurnPending: false,
};

/**
 * The full observation needed to distinguish a scheduled focus naturally
 * ending from the scholar completing its activity while that focus continues.
 */
export type RoomTurnObservation = {
  isFocusMatch: boolean;
  phase: RoomTurnPhase;
  label: string | null;
  /** A scheduled end, or explicit null for an open-ended focus. */
  endsAt: number | null;
  nowMs: number;
};

/**
 * Advance the memory one check. Two independent triggers can set `turned`,
 * whichever fires first:
 *   - the client's own clock crosses `endsAt` while still (technically)
 *     matching server-side (`phase === "turned"`), or
 *   - the server has already confirmed the lock lifted (no longer matching)
 *     from an open-ended focus at any point after a check where we WERE
 *     matching — e.g. a teacher's "Wrap now", which has no client-derived
 *     "turned" phase of its own.
 *
 * A scheduled focus disappearing before its known `endsAt` is not a turn: a
 * completed activity can make it cease matching even while the room remains on
 * that scheduled focus. The observation carries the end instant so
 * this pure state machine can make that distinction without a threshold.
 * Once `turned`, it STAYS turned (no auto-dismiss — "a kid in flow may keep
 * working") until a fresh live match resets it (a new push, same or
 * different focus) — matching CLAUDE.md's "invitation, not enforcement".
 */
export function nextRoomTurnMemory(
  prev: RoomTurnMemory,
  observation: RoomTurnObservation,
): RoomTurnMemory {
  if (observation.isFocusMatch) {
    const scheduledTurnReached =
      observation.endsAt != null && observation.nowMs >= observation.endsAt;
    return {
      matched: true,
      label: observation.label,
      turned: observation.phase === "turned" || scheduledTurnReached,
      endsAt: observation.endsAt,
      // A fresh matching focus resets the prior focus's pending scheduled turn.
      scheduledTurnPending:
        observation.endsAt != null && !scheduledTurnReached,
    };
  }

  const scheduledTurnReached =
    prev.scheduledTurnPending &&
    prev.endsAt != null &&
    observation.nowMs >= prev.endsAt;
  const openEndedFocusWasLifted =
    prev.matched && !prev.scheduledTurnPending;
  return {
    matched: false,
    label: prev.label ?? observation.label,
    endsAt: prev.endsAt,
    scheduledTurnPending:
      prev.scheduledTurnPending && !scheduledTurnReached,
    turned:
      prev.turned ||
      scheduledTurnReached ||
      openEndedFocusWasLifted,
  };
}

/** Should the "the room's moved on" banner show right now? */
export function shouldShowTurnBanner(memory: RoomTurnMemory): boolean {
  return memory.turned;
}

/** The label to show in the turn banner — the live one if we're still
 *  (technically) matched, else the last remembered one. */
export function turnBannerLabel(memory: RoomTurnMemory): string | null {
  return memory.label;
}

// ─── Teacher-only awareness (never a scholar-screen concern) ───────────

/** A generous default "typical block" length — the same duration the push
 *  UI's own default class-focus window uses (60 min) — used ONLY to flag an
 *  open-ended (no `endsAt`) push that's been live a good while. */
export const TYPICAL_BLOCK_MS = 60 * 60 * 1000;

/**
 * Teacher-only "running long" signal for a live classFocus push: either it's
 * still visibly live despite its own planned `endsAt` having passed (a rare
 * scheduler-lag edge case, shown honestly rather than hidden), or it has no
 * planned end at all and has been live longer than a typical block. Never
 * shown to scholars — the "no ticking on a kid's screen" rule is scoped to
 * their surfaces, not a teacher's roster view.
 */
export function isClassFocusRunningLong(
  nowMs: number,
  setAt: number,
  endsAt: number | null | undefined,
): boolean {
  if (endsAt != null) return nowMs > endsAt;
  return nowMs - setAt > TYPICAL_BLOCK_MS;
}
