/**
 * "Is this session still waiting for the quest it was launched into?"
 *
 * A Custom Quest / topic-seed launch creates the session and opens the tutor
 * IMMEDIATELY, while the Curriculum Bot designs the unit in the background
 * (convex/bakeUnitFromSeed.ts — "hide the latency"). The activity, with the
 * actual task in it, lands minutes later (see QUEST_BAKE_HOLD_CAP_MS for the
 * measured range) and is attached SILENTLY.
 *
 * That silence is what this module exists to stop. Before it, the tutor opened
 * an ad-lib "what got you interested in X?" greeting because no task existed
 * yet, then acquired the real task mid-conversation with an explicit prompt
 * instruction not to announce it. A scholar spent the first 2m22s of a session
 * asking "What do i do" and then "No no i what do i do NOW" into a conversation
 * that was structurally never going to answer. Holding the opening turn until
 * the task exists costs the same wall-clock and spends it honestly.
 *
 * FAIL-OPEN BY CONSTRUCTION. Every exit returns false, and false is exactly the
 * behavior that shipped before: the activity landed, the bake gave up, or the
 * wait ran past the cap because the bake action died without writing back. A
 * scholar can never be stranded on the waiting state by a backend that stopped
 * answering — the worst case is the old ad-lib open.
 *
 * The clock is passed IN, because a reactive Convex query reading `Date.now()`
 * would not re-run when the cap expired — so the caller owns the clock and the
 * timer that fires at the deadline. `useQuestBakeHold` is that caller for both
 * frontends; keep them on it rather than re-deriving, since a parity gap here
 * is a scholar-facing one.
 *
 * The anchor is `_creationTime`, which is a PROXY for when the bake started,
 * not the bake's own timestamp: the seed path stamps `questBakeStatus` in the
 * insert itself, but the Custom Quest path stamps it in a follow-on mutation a
 * moment later, and neither writes a bake-start time. The gap is sub-second
 * against a multi-minute cap, and it skews the safe way — the deadline lands
 * marginally EARLIER than a bake-anchored one, so the hold can only end too
 * soon (falling back to today's behavior), never run long. A future caller that
 * schedules a bake well after session creation would need a real timestamp
 * rather than this proxy.
 */
import { useEffect, useState } from "react";

/**
 * How long to wait for the bake before opening the session the old way.
 *
 * The cap is a backstop for an action that died without ever writing back, NOT
 * a target — the wait normally ends when the bake links, seconds after it
 * finishes. So it is set well clear of a slow-but-live bake: measured landings
 * run ~70s on prod and ~150s on a worktree dev deployment, and falling through
 * early is the failure that matters, because it drops the scholar back into
 * exactly the confusing ad-lib session this exists to prevent.
 */
export const QUEST_BAKE_HOLD_CAP_MS = 5 * 60_000;

/** The fields this decision reads. Structural, so both clients' session docs fit. */
export type QuestBakeHoldSession = {
  activityId?: unknown;
  questBakeStatus?: string | null;
  _creationTime?: number;
};

/**
 * True while the client should hold the session's opening tutor turn and show
 * the "building your quest" state instead.
 */
export function shouldHoldOpeningTurn(
  session: QuestBakeHoldSession | null | undefined,
  now: number,
): boolean {
  const deadline = questBakeHoldDeadline(session);
  return deadline !== null && now < deadline;
}

/**
 * When the hold expires, or null if this session is not holding at all.
 * Separate from the predicate so a caller can schedule a timer for exactly the
 * remaining wait instead of polling.
 */
export function questBakeHoldDeadline(
  session: QuestBakeHoldSession | null | undefined,
): number | null {
  if (!session) return null;
  // The activity landed — the real opener (the activity kickoff) takes over.
  if (session.activityId) return null;
  // Not pending: never baked, or the bake finished/failed and released the hold.
  if (session.questBakeStatus !== "pending") return null;
  const startedAt = session._creationTime;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  return startedAt + QUEST_BAKE_HOLD_CAP_MS;
}

/**
 * The hold as React state, with the timer that ends it at the cap.
 *
 * Without the timer the cap would only be noticed on the next unrelated
 * re-render, which for a session with no messages and a blocked composer may
 * never come — the fail-open would silently not fire.
 *
 * The state is WHICH deadline elapsed, not a boolean. The clock is the only
 * external system here, so a new deadline is un-expired by definition and
 * nothing has to reset state on the way in.
 */
export function useQuestBakeHold(
  session: QuestBakeHoldSession | null | undefined,
): boolean {
  const deadline = questBakeHoldDeadline(session);
  const [elapsedDeadline, setElapsedDeadline] = useState<number | null>(null);

  useEffect(() => {
    if (deadline === null) return;
    // Clamped rather than branched: an already-past deadline resolves on the
    // next tick instead of setting state synchronously during the effect.
    const timer = setTimeout(
      () => setElapsedDeadline(deadline),
      Math.max(0, deadline - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [deadline]);

  return deadline !== null && elapsedDeadline !== deadline;
}
