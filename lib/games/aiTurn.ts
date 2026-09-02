/**
 * Pure, framework-free scheduler that CHOREOGRAPHS an AI/opponent turn so a
 * scholar can actually see what happened — this is a durable, codebase-wide
 * principle, not a Factor-Game-only fix: any game with an AI turn must pace
 * it through legible beats, never resolve it instantly in one state update.
 *
 * Every AI turn advances through the same four phases:
 *
 *   idle → thinking → revealing → settling → idle
 *
 *   • thinking  — the opponent "is thinking…"; nothing has been chosen yet.
 *   • revealing — the chosen move is now known (`chosenMove`); the optional
 *                 `revealMove` has just landed the CHOICE ITSELF in real state
 *                 (the picked cell now visibly claims) — but the move's
 *                 downstream consequences have NOT landed yet.
 *   • settling  — `applyMove` has just run (real state now reflects the move's
 *                 CONSEQUENCES too); this beat is the window for the fan-out /
 *                 claim animation to visibly stagger in before the turn hands
 *                 back. So the cause (the pick) always precedes its effect.
 *
 * The two apply hooks split a move across those two beats so a scholar sees the
 * CAUSE before the CONSEQUENCE: `revealMove` (optional) lands the choice at the
 * start of "revealing"; `applyMove` lands the fallout at the start of
 * "settling". A game whose move is atomic (nothing to stagger) simply omits
 * `revealMove` and does everything in `applyMove` — then the pick is only a
 * highlight during "revealing", exactly as before this hook grew two stages.
 *
 * The scheduler owns ONLY timing + phase sequencing — it knows nothing about
 * board geometry, what a "move" looks like, or how effects render (generic in
 * `Move`). The caller supplies `chooseMove` (pure), the two apply hooks (the
 * real state mutations), and reacts to phase/`chosenMove` changes to render the
 * board. `components/manipulative/useAiTurn.ts` is the thin React wrapper any
 * AI-turn game component uses directly (Factor Game today; Nim or a future
 * opponent-turn game reuses the SAME hook, not a bespoke timer).
 *
 * `schedule` is injectable (defaults to `setTimeout`/`clearTimeout`) so the
 * choreography itself is unit-testable without real timers or a DOM — see
 * `__tests__/aiTurn.test.ts`.
 */

export type AiTurnPhase = "idle" | "thinking" | "revealing" | "settling";

export interface AiTurnTimings {
  /** How long to show "thinking" before a move is even chosen. */
  thinkingMs: number;
  /** How long the chosen move stays highlighted before its effects land. */
  revealingMs: number;
  /** How long the applied move's effects get to visibly settle/stagger in. */
  settlingMs: number;
}

/** Tuned to feel deliberate on an iPad without dragging — adjust here, not per-game. */
export const DEFAULT_AI_TURN_TIMINGS: AiTurnTimings = {
  thinkingMs: 650,
  revealingMs: 550,
  settlingMs: 500,
};

/** A cancelable timer primitive — swap for a fake in tests. */
export type AiTurnScheduleFn = (callback: () => void, ms: number) => () => void;

export function defaultSchedule(callback: () => void, ms: number): () => void {
  const id = setTimeout(callback, ms);
  return () => clearTimeout(id);
}

export interface RunAiTurnOptions<Move> {
  /** Pure: choose the AI's move from current state. Called once, after the "thinking" beat. */
  chooseMove: () => Move | null;
  /**
   * Optional: land the CHOICE ITSELF into real state — called once, at the
   * START of "revealing" (right after the move is chosen). Use it to make the
   * picked cell visibly claim a beat before its consequences fan out. Omit it
   * for an atomic move (then the whole move lands in `applyMove` at "settling").
   */
  revealMove?: (move: Move) => void;
  /** The move's CONSEQUENCES land here — called once, at the start of "settling". */
  applyMove: (move: Move) => void;
  /** Fired on every phase transition (including the final return to "idle"). */
  onPhaseChange: (phase: AiTurnPhase, chosenMove: Move | null) => void;
  timings?: Partial<AiTurnTimings>;
  schedule?: AiTurnScheduleFn;
}

/**
 * Starts one choreographed AI turn. Returns a `cancel` function — call it if
 * the turn needs to be abandoned early (e.g. the component unmounts, or
 * `active` flips back to false from outside). Safe to call `cancel` more than
 * once and after the turn has already finished.
 */
export function runAiTurn<Move>({
  chooseMove,
  revealMove,
  applyMove,
  onPhaseChange,
  timings,
  schedule = defaultSchedule,
}: RunAiTurnOptions<Move>): () => void {
  const t: AiTurnTimings = { ...DEFAULT_AI_TURN_TIMINGS, ...timings };
  let cancelled = false;
  let cancelPending: (() => void) | null = null;

  const cancel = () => {
    cancelled = true;
    cancelPending?.();
    cancelPending = null;
  };

  onPhaseChange("thinking", null);
  cancelPending = schedule(() => {
    if (cancelled) return;
    const move = chooseMove();
    if (move == null) {
      // Nothing legal for the AI to do — shouldn't normally happen (a
      // terminal board has no legal move for anyone, by any game's own
      // rules), but bail cleanly rather than hang mid-choreography.
      onPhaseChange("idle", null);
      return;
    }
    // The CHOICE lands in real state now (start of "revealing"), so the picked
    // cell visibly claims before its consequences fan out at "settling".
    revealMove?.(move);
    onPhaseChange("revealing", move);
    cancelPending = schedule(() => {
      if (cancelled) return;
      applyMove(move);
      onPhaseChange("settling", move);
      cancelPending = schedule(() => {
        if (cancelled) return;
        onPhaseChange("idle", null);
      }, t.settlingMs);
    }, t.revealingMs);
  }, t.thinkingMs);

  return cancel;
}
