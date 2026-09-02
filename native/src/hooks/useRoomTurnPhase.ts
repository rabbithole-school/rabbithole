/**
 * useRoomTurnPhase (native) — the RN twin of web hooks/useRoomTurnPhase.ts.
 * "The turn, not the bell": a coarse 30s poll, never a ticking countdown —
 * re-derives which of the three soft phases (withClass / windingDown /
 * turned) a class-focus push is in, from the device's own wall clock against
 * the already-returned `endsAt`. Backed by the vendored pure policy in
 * ../../vendor/shared/roomTurn.ts (Lane 1 owns the source at shared/roomTurn.ts).
 */
import { useEffect, useState } from "react";
import { roomTurnPhase, type RoomTurnPhase } from "../../vendor/shared/roomTurn";

const CHECK_INTERVAL_MS = 30_000;

export function useRoomTurnPhase(
  endsAt: number | null | undefined,
): RoomTurnPhase {
  const [phase, setPhase] = useState<RoomTurnPhase>(() =>
    roomTurnPhase(Date.now(), endsAt),
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refreshes the clock-derived phase immediately when the authoritative end time changes.
    setPhase(roomTurnPhase(Date.now(), endsAt));
    if (endsAt == null) return;
    const interval = setInterval(() => {
      setPhase(roomTurnPhase(Date.now(), endsAt));
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [endsAt]);

  return phase;
}
