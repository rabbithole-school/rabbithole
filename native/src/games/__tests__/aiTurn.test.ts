import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_AI_TURN_TIMINGS,
  runAiTurn,
  type AiTurnPhase,
  type AiTurnScheduleFn,
} from "../../../vendor/games/aiTurn";

/**
 * The native Factor Game drives its opponent turn through the SHARED
 * `useAiTurn` hook, which wraps this vendored `runAiTurn` scheduler — so a move
 * is always paced through legible beats ("a beat + a visible move, never
 * instant") with the SAME timing constants as web. These tests pin the pacing
 * the native app ships: the phase order, the "choose before reveal, apply only
 * after the reveal beat" discipline, and the exact web-matched default timings.
 * A manually-steppable fake schedule proves the choreography without real
 * timers. (This is the native mirror of lib/manipulative/__tests__/aiTurn.test.)
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

describe("vendored runAiTurn — native AI-turn choreography", () => {
  test("ships the web-matched default timings (never instant)", () => {
    // The whole point of item 3: the AI move must be SLOW enough to see. Pin the
    // constants so a future vendor sync that shortened them would fail here.
    expect(DEFAULT_AI_TURN_TIMINGS.thinkingMs).toBe(650);
    expect(DEFAULT_AI_TURN_TIMINGS.revealingMs).toBe(550);
    expect(DEFAULT_AI_TURN_TIMINGS.settlingMs).toBe(500);
  });

  test("advances thinking → revealing → settling → idle with those timings", () => {
    const { schedule, flush } = fakeSchedule();
    const phases: AiTurnPhase[] = [];
    const chosen: (number | null)[] = [];
    const applied: number[] = [];

    runAiTurn<number>({
      chooseMove: () => 12,
      applyMove: (m) => applied.push(m),
      onPhaseChange: (p, m) => {
        phases.push(p);
        chosen.push(m);
      },
      schedule,
    });

    // "thinking" starts synchronously; nothing chosen or applied yet.
    expect(phases).toEqual(["thinking"]);
    expect(chosen).toEqual([null]);

    // thinking → revealing: the move is CHOSEN and highlighted, NOT yet applied.
    expect(flush()).toBe(650);
    expect(phases).toEqual(["thinking", "revealing"]);
    expect(chosen).toEqual([null, 12]);
    expect(applied).toEqual([]);

    // revealing → settling: NOW the real state mutation happens (once).
    expect(flush()).toBe(550);
    expect(phases).toEqual(["thinking", "revealing", "settling"]);
    expect(applied).toEqual([12]);

    // settling → idle: the turn hands back.
    expect(flush()).toBe(500);
    expect(phases).toEqual(["thinking", "revealing", "settling", "idle"]);
    expect(chosen.at(-1)).toBeNull();
  });

  test("applyMove never runs synchronously — the move is visible before it lands", () => {
    const { schedule, flush } = fakeSchedule();
    const applyMove = vi.fn();
    runAiTurn<number>({ chooseMove: () => 6, applyMove, onPhaseChange: () => {}, schedule });
    expect(applyMove).not.toHaveBeenCalled(); // still "thinking"
    flush();
    expect(applyMove).not.toHaveBeenCalled(); // "revealing" — highlighted, not applied
    flush();
    expect(applyMove).toHaveBeenCalledExactlyOnceWith(6); // only at "settling"
  });
});
