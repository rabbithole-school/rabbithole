import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_AI_TURN_TIMINGS,
  runAiTurn,
  type AiTurnPhase,
  type AiTurnScheduleFn,
} from "../aiTurn";

/**
 * A deterministic, manually-steppable fake for `AiTurnScheduleFn` — instead
 * of real timers, `schedule()` just records `[callback, ms]` and `flush()`
 * runs the single pending callback (there is ever only one in-flight timer
 * in this scheduler, since each phase only schedules the next after the
 * previous fires). This proves the CHOREOGRAPHY itself — phase order +
 * timing values passed — without a DOM or fake-timer flakiness.
 */
function fakeSchedule() {
  const pending: Array<{ callback: () => void; ms: number; cancelled: boolean }> = [];
  const schedule: AiTurnScheduleFn = (callback, ms) => {
    const entry = { callback, ms, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const flush = () => {
    const entry = pending.shift();
    if (!entry) throw new Error("no pending timer to flush");
    if (!entry.cancelled) entry.callback();
    return entry.ms;
  };
  return { schedule, flush, pending };
}

describe("runAiTurn — the shared AI-turn choreography scheduler", () => {
  test("advances thinking → revealing → settling → idle, in that order, with the tuned default timings", () => {
    const { schedule, flush } = fakeSchedule();
    const phases: AiTurnPhase[] = [];
    const chosenMoves: (number | null)[] = [];
    const applied: number[] = [];

    runAiTurn<number>({
      chooseMove: () => 12,
      applyMove: (m) => applied.push(m),
      onPhaseChange: (phase, move) => {
        phases.push(phase);
        chosenMoves.push(move);
      },
      schedule,
    });

    // Starts "thinking" synchronously, before any timer fires.
    expect(phases).toEqual(["thinking"]);
    expect(chosenMoves).toEqual([null]);

    // thinking → revealing: the move is chosen and revealed, but NOT yet applied.
    let ms = flush();
    expect(ms).toBe(DEFAULT_AI_TURN_TIMINGS.thinkingMs);
    expect(phases).toEqual(["thinking", "revealing"]);
    expect(chosenMoves).toEqual([null, 12]);
    expect(applied).toEqual([]); // effects have NOT landed yet — still just a highlight

    // revealing → settling: NOW the real state mutation happens.
    ms = flush();
    expect(ms).toBe(DEFAULT_AI_TURN_TIMINGS.revealingMs);
    expect(phases).toEqual(["thinking", "revealing", "settling"]);
    expect(applied).toEqual([12]); // applied exactly once, at the start of "settling"

    // settling → idle: the turn hands back.
    ms = flush();
    expect(ms).toBe(DEFAULT_AI_TURN_TIMINGS.settlingMs);
    expect(phases).toEqual(["thinking", "revealing", "settling", "idle"]);
    expect(chosenMoves.at(-1)).toBeNull();
  });

  test("never resolves instantly — chooseMove/applyMove only run after their respective delays, not synchronously", () => {
    const { schedule, flush } = fakeSchedule();
    const chooseMove = vi.fn(() => 6);
    const applyMove = vi.fn();

    runAiTurn<number>({ chooseMove, applyMove, onPhaseChange: () => {}, schedule });
    expect(chooseMove).not.toHaveBeenCalled();
    expect(applyMove).not.toHaveBeenCalled();

    flush(); // thinking → revealing
    expect(chooseMove).toHaveBeenCalledTimes(1);
    expect(applyMove).not.toHaveBeenCalled();

    flush(); // revealing → settling
    expect(applyMove).toHaveBeenCalledExactlyOnceWith(6);
  });

  test("splits a move across two beats — revealMove lands the CHOICE at the start of 'revealing', applyMove lands the CONSEQUENCES at 'settling'", () => {
    const { schedule, flush } = fakeSchedule();
    // One ordered log proves the cause (revealMove) is seen before the
    // consequence (applyMove), and that each fires as its phase begins.
    const events: string[] = [];

    runAiTurn<number>({
      chooseMove: () => 7,
      revealMove: (m) => events.push(`reveal:${m}`),
      applyMove: (m) => events.push(`apply:${m}`),
      onPhaseChange: (p) => events.push(`phase:${p}`),
      schedule,
    });

    expect(events).toEqual(["phase:thinking"]);

    flush(); // thinking → revealing: the CHOICE lands, THEN the phase flips
    expect(events).toEqual(["phase:thinking", "reveal:7", "phase:revealing"]);

    flush(); // revealing → settling: the CONSEQUENCES land as the phase flips
    expect(events).toEqual([
      "phase:thinking",
      "reveal:7",
      "phase:revealing",
      "apply:7",
      "phase:settling",
    ]);

    flush(); // settling → idle
    expect(events.at(-1)).toBe("phase:idle");
  });

  test("revealMove is optional — an atomic move (no revealMove) still lands wholly in applyMove at 'settling'", () => {
    const { schedule, flush } = fakeSchedule();
    const applyMove = vi.fn();
    runAiTurn<number>({ chooseMove: () => 3, applyMove, onPhaseChange: () => {}, schedule });
    flush(); // thinking → revealing
    expect(applyMove).not.toHaveBeenCalled();
    flush(); // revealing → settling
    expect(applyMove).toHaveBeenCalledExactlyOnceWith(3);
  });

  test("custom timings override the defaults", () => {
    const { schedule, flush } = fakeSchedule();
    runAiTurn<number>({
      chooseMove: () => 1,
      applyMove: () => {},
      onPhaseChange: () => {},
      timings: { thinkingMs: 10, revealingMs: 20, settlingMs: 30 },
      schedule,
    });
    expect(flush()).toBe(10);
    expect(flush()).toBe(20);
    expect(flush()).toBe(30);
  });

  test("a null move (nothing legal for the AI) bails to idle without ever revealing or applying", () => {
    const { schedule, flush } = fakeSchedule();
    const phases: AiTurnPhase[] = [];
    const revealMove = vi.fn();
    const applyMove = vi.fn();
    runAiTurn<number>({
      chooseMove: () => null,
      revealMove,
      applyMove,
      onPhaseChange: (p) => phases.push(p),
      schedule,
    });
    flush(); // thinking → chooseMove() returns null
    expect(phases).toEqual(["thinking", "idle"]);
    expect(revealMove).not.toHaveBeenCalled();
    expect(applyMove).not.toHaveBeenCalled();
  });

  test("cancel() stops the choreography before its next beat fires", () => {
    const { schedule, pending } = fakeSchedule();
    const phases: AiTurnPhase[] = [];
    const cancel = runAiTurn<number>({
      chooseMove: () => 9,
      applyMove: () => {},
      onPhaseChange: (p) => phases.push(p),
      schedule,
    });
    cancel();
    // The pending "thinking → revealing" timer is marked cancelled; running it does nothing.
    const entry = pending.shift();
    expect(entry?.cancelled).toBe(true);
    entry?.callback(); // even if something ran it anyway, cancellation must suppress the phase change
    expect(phases).toEqual(["thinking"]);
  });
});
