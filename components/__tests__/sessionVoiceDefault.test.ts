import { describe, expect, test } from "vitest";
import { resolveVoiceHydration } from "../sessionVoiceDefault";

// Run the effect the way SessionInterface does: thread `appliedFor` through
// successive passes and report whether voice was switched ON on each pass.
function run(
  steps: { preReader: boolean; stored: boolean }[],
  sessionId = "s1",
) {
  let appliedFor: string | null = null;
  return steps.map((s) => {
    const r = resolveVoiceHydration({
      isPreReaderSession: s.preReader,
      sessionId,
      appliedFor,
      storedOn: s.stored,
    });
    appliedFor = r.appliedFor;
    return r.on;
  });
}

describe("resolveVoiceHydration", () => {
  test("a stored off does not override the pre-reader ON default", () => {
    expect(run([{ preReader: true, stored: false }])).toEqual([true]);
  });

  test("a non-pre-reader still hydrates a stored on, and not a stored off", () => {
    expect(run([{ preReader: false, stored: true }])).toEqual([true]);
    expect(run([{ preReader: false, stored: false }])).toEqual([false]);
  });

  test("a persisted on cannot resurrect a session-local off after listener -> reader -> listener", () => {
    // Pass 1 applies the listener default; the scholar then toggles off (state
    // outside this helper). Passes 2 and 3 must not turn voice back on.
    expect(
      run([
        { preReader: true, stored: true },
        { preReader: false, stored: true },
        { preReader: true, stored: true },
      ]),
    ).toEqual([true, false, false]);
  });

  test("the default re-applies in a different session", () => {
    let appliedFor: string | null = null;
    const first = resolveVoiceHydration({
      isPreReaderSession: true,
      sessionId: "s1",
      appliedFor,
      storedOn: false,
    });
    appliedFor = first.appliedFor;
    const second = resolveVoiceHydration({
      isPreReaderSession: true,
      sessionId: "s2",
      appliedFor,
      storedOn: false,
    });
    expect(second).toEqual({ on: true, appliedFor: "s2" });
  });
});
