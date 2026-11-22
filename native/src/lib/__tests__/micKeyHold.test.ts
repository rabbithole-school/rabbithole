import { beforeEach, describe, expect, test } from "vitest";

import {
  HOLD_TO_TALK_MS,
  micKeyReleased,
  micKeyStartedTake,
} from "../micKeyHold";

function target(state = "recording") {
  const calls: string[] = [];
  return {
    calls,
    state,
    confirm: () => calls.push("confirm"),
  };
}

// How voice targets behave: every read is a fresh snapshot.
function snapshots(states: string[]) {
  const calls: string[] = [];
  let i = 0;
  const read = () => ({
    state: states[Math.min(i++, states.length - 1)],
    confirm: () => calls.push("confirm"),
  });
  return { calls, read };
}

beforeEach(() => {
  // Clear any press a previous test left behind.
  micKeyReleased(0);
});

describe("mic key hold-to-talk", () => {
  test("a press held past the threshold sends on release", () => {
    const t = target();
    micKeyStartedTake(() => t, 1_000);
    expect(micKeyReleased(1_000 + HOLD_TO_TALK_MS)).toBe(true);
    expect(t.calls).toEqual(["confirm"]);
  });

  test("a quick tap leaves the take recording for the next press", () => {
    const t = target();
    micKeyStartedTake(() => t, 1_000);
    expect(micKeyReleased(1_000 + HOLD_TO_TALK_MS - 1)).toBe(false);
    expect(t.calls).toEqual([]);
  });

  test("a release counts once", () => {
    const t = target();
    micKeyStartedTake(() => t, 0);
    micKeyReleased(5_000);
    expect(micKeyReleased(6_000)).toBe(false);
    expect(t.calls).toEqual(["confirm"]);
  });

  test("reads the target at release, so a take that became 'recording' sends", () => {
    // The press saw "idle" (the take hadn't started); the release must not
    // reuse that snapshot.
    const { calls, read } = snapshots(["recording"]);
    micKeyStartedTake(read, 0);
    expect(micKeyReleased(HOLD_TO_TALK_MS * 2)).toBe(true);
    expect(calls).toEqual(["confirm"]);
  });

  test("a screen that went away before the release gets nothing", () => {
    micKeyStartedTake(() => undefined, 0);
    expect(micKeyReleased(HOLD_TO_TALK_MS * 2)).toBe(false);
  });

  test("a release with no press started by the key does nothing", () => {
    expect(micKeyReleased(10_000)).toBe(false);
  });

  test("a release while still starting up sends what the mic has", () => {
    const t = target("connecting");
    micKeyStartedTake(() => t, 0);
    expect(micKeyReleased(HOLD_TO_TALK_MS)).toBe(true);
    expect(t.calls).toEqual(["confirm"]);
  });

  test("a take already cancelled during the hold is not sent", () => {
    const t = target("idle");
    micKeyStartedTake(() => t, 0);
    expect(micKeyReleased(HOLD_TO_TALK_MS * 3)).toBe(false);
    expect(t.calls).toEqual([]);
  });
});
