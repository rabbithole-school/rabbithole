"use client";

import { useEffect, useState } from "react";
import { roomTurnPhase, type RoomTurnPhase } from "@/shared/roomTurn";

// "The turn, not the bell": a coarse 30s poll, NEVER a ticking countdown —
// re-derives which of the three soft phases (withClass / windingDown /
// turned) a class-focus push is in, purely from the client's own wall clock
// against the already-returned `endsAt`. No new server state, no visible
// number ever counts down.
const CHECK_INTERVAL_MS = 30_000;

export function useRoomTurnPhase(
  endsAt: number | null | undefined,
): RoomTurnPhase {
  const [phase, setPhase] = useState<RoomTurnPhase>(() =>
    roomTurnPhase(Date.now(), endsAt),
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Recompute immediately when the external end time changes, before the real-clock interval's next tick.
    setPhase(roomTurnPhase(Date.now(), endsAt));
    if (endsAt == null) return;
    const interval = setInterval(() => {
      setPhase(roomTurnPhase(Date.now(), endsAt));
    }, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [endsAt]);

  return phase;
}
