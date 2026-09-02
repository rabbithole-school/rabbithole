/**
 * The native React seam over the vendored, framework-free choreography
 * scheduler `vendor/games/aiTurn.ts`. ANY game with an opponent turn drives it
 * through THIS hook instead of hand-rolling its own `setTimeout` chain, so an
 * automated move is always paced through legible beats ("a beat + a visible
 * move, never instant"), with the timing constants in
 * `DEFAULT_AI_TURN_TIMINGS` (650 / 550 / 500 ms).
 *
 * It lives beside the games rather than the manipulatives because, after the
 * Factor Game left `ManipulativeKind`, a game is the only thing that has an
 * opponent. The scheduler itself stays framework-free and vendored — its own
 * header calls the "never instant" rule a codebase-wide principle.
 *
 * `phase` advances idle → thinking → revealing → settling → idle every time
 * `active` flips true; the board renders differently per phase (a "thinking"
 * status, then `chosenMove` highlighted with a scale/glow pulse, then its
 * effects settling) and MUST stay non-interactive for the whole span (gate
 * input on your own turn flag AND `phase === "idle"`, same as web). An optional
 * `revealMove` lands the CHOICE into real state at the start of "revealing" (so
 * the picked cell claims a beat before its consequences land in `applyMove` at
 * "settling"); omit it for an atomic move. The effect that drives the
 * choreography is keyed ONLY on `active`; `chooseMove` / `revealMove` /
 * `applyMove` are read from refs so a state update mid-turn (which typically
 * flips `active` false as the move lands — an expected, self-caused transition)
 * never restarts or aborts the in-flight sequence.
 */
import { useEffect, useRef, useState } from "react";
import {
  runAiTurn,
  type AiTurnPhase,
  type AiTurnTimings,
} from "../../vendor/games/aiTurn";

export interface UseAiTurnOptions<Move> {
  /** True exactly when it's the AI's turn to move right now (and play isn't over). */
  active: boolean;
  chooseMove: () => Move | null;
  /** Optional: land the CHOICE into real state at the start of "revealing" (see vendored `aiTurn.ts`). */
  revealMove?: (move: Move) => void;
  applyMove: (move: Move) => void;
  timings?: Partial<AiTurnTimings>;
}

export interface UseAiTurnResult<Move> {
  phase: AiTurnPhase;
  /** The AI's chosen move, visible from "revealing" through "settling" — null otherwise. */
  chosenMove: Move | null;
}

export function useAiTurn<Move>({
  active,
  chooseMove,
  revealMove,
  applyMove,
  timings,
}: UseAiTurnOptions<Move>): UseAiTurnResult<Move> {
  const [phase, setPhase] = useState<AiTurnPhase>("idle");
  const [chosenMove, setChosenMove] = useState<Move | null>(null);

  // Keep the latest closures in refs, updated post-render (never during render)
  // so the choreography effect below only needs to key on `active`.
  const chooseMoveRef = useRef(chooseMove);
  const revealMoveRef = useRef(revealMove);
  const applyMoveRef = useRef(applyMove);
  const timingsRef = useRef(timings);
  useEffect(() => {
    chooseMoveRef.current = chooseMove;
    revealMoveRef.current = revealMove;
    applyMoveRef.current = applyMove;
    timingsRef.current = timings;
  });

  // A running turn's own `applyMove` typically flips `active` false partway
  // through — an EXPECTED, self-caused transition, not an abort request. So
  // starting and cancelling are split: this effect only STARTS a turn (guarded
  // by `runningRef` so it can't double-start), and a separate mount-only effect
  // cancels on true unmount.
  const runningRef = useRef(false);
  const cancelRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!active || runningRef.current) return;
    runningRef.current = true;
    cancelRef.current = runAiTurn<Move>({
      chooseMove: () => chooseMoveRef.current(),
      revealMove: (move) => revealMoveRef.current?.(move),
      applyMove: (move) => applyMoveRef.current(move),
      onPhaseChange: (p, m) => {
        setPhase(p);
        setChosenMove(m);
        if (p === "idle") runningRef.current = false;
      },
      timings: timingsRef.current,
    });
    // Deliberately keyed only on `active`.
  }, [active]);

  useEffect(() => {
    return () => cancelRef.current();
  }, []);

  return { phase, chosenMove };
}
