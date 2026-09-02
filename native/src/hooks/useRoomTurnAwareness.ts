/**
 * useRoomTurnAwareness (native) — the RN twin of web
 * hooks/useRoomTurnAwareness.ts. "The turn, not the bell" item 3: the
 * choice, not the cliff. Thin adapter over the pure state machine vendored
 * at ../../vendor/shared/roomTurn.ts (see there for the full policy + tests, including why
 * the memory's `turned` flag is sticky rather than re-derived from `matched`
 * on every check). Once shown, this does NOT auto-dismiss — "a kid in flow
 * may keep working" — it's the caller's job to stop rendering it (e.g. the
 * scholar taps "Done here").
 */
import { useEffect, useState } from "react";
import {
  INITIAL_ROOM_TURN_MEMORY,
  nextRoomTurnMemory,
  shouldShowTurnBanner,
  turnBannerLabel,
  type RoomTurnPhase,
} from "../../vendor/shared/roomTurn";

export function useRoomTurnAwareness(
  isFocusMatch: boolean,
  phase: RoomTurnPhase,
  label: string | null,
  endsAt: number | null,
): { showTurnBanner: boolean; turnLabel: string | null } {
  const [memory, setMemory] = useState(INITIAL_ROOM_TURN_MEMORY);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- advances the sticky turn-memory state machine when its external focus inputs transition.
    setMemory((prev) =>
      nextRoomTurnMemory(prev, {
        isFocusMatch,
        phase,
        label,
        endsAt,
        nowMs: Date.now(),
      }),
    );
  }, [isFocusMatch, phase, label, endsAt]);

  useEffect(() => {
    if (memory.turned || memory.endsAt == null) return;
    const timeout = setTimeout(() => {
      setMemory((prev) =>
        nextRoomTurnMemory(prev, {
          isFocusMatch,
          phase,
          label,
          endsAt,
          nowMs: Date.now(),
        }),
      );
    }, Math.max(0, memory.endsAt - Date.now()));
    return () => clearTimeout(timeout);
  }, [memory.endsAt, memory.turned, isFocusMatch, phase, label, endsAt]);

  return {
    showTurnBanner: shouldShowTurnBanner(memory),
    turnLabel: turnBannerLabel(memory),
  };
}
