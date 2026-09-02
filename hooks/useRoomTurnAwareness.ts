"use client";

import { useEffect, useState } from "react";
import {
  INITIAL_ROOM_TURN_MEMORY,
  nextRoomTurnMemory,
  shouldShowTurnBanner,
  turnBannerLabel,
  type RoomTurnPhase,
} from "@/shared/roomTurn";

/**
 * The "at the turn" awareness — item 3 of "the turn, not the bell": the
 * choice, not the cliff. Thin React adapter over the pure state machine in
 * shared/roomTurn.ts (see there for the full policy + tests — including why
 * the memory's `turned` flag is sticky rather than re-derived from `matched`
 * on every check). Once shown, this does NOT auto-dismiss — "a kid in flow
 * may keep working" — it's the caller's job to stop rendering it (e.g. the
 * scholar clicks "Done here").
 */
export function useRoomTurnAwareness(
  isFocusMatch: boolean,
  phase: RoomTurnPhase,
  label: string | null,
  endsAt: number | null,
): { showTurnBanner: boolean; turnLabel: string | null } {
  const [memory, setMemory] = useState(INITIAL_ROOM_TURN_MEMORY);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Transition memory is intentionally retained so a shown turn banner remains visible after focus changes.
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
