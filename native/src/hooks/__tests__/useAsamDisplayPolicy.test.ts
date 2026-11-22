import { createElement, useEffect } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appState } = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    appState: {
      currentState: "active",
      listeners,
      addEventListener: (_type: string, fn: (state: string) => void) => {
        listeners.add(fn);
        return { remove: () => listeners.delete(fn) };
      },
    },
  };
});

vi.mock("react-native", () => ({ AppState: appState }));

import { ASAM_AWAKE_WINDOW_MS } from "@/lib/asam/displayPolicy";
import { useAsamDisplayPolicy } from "../useAsamDisplayPolicy";

type Policy = ReturnType<typeof useAsamDisplayPolicy>;
/** Every value the hook returned, captured in an effect so Probe stays pure —
 *  a one-render keep-awake flash is a real idle-timer toggle, so tests can
 *  assert on all of them, not just the settled one. */
const seen: { current: Policy | null; history: Policy[] } = {
  current: null,
  history: [],
};
let renderer: ReactTestRenderer;

function Probe({ inSam }: { inSam: boolean }) {
  const value = useAsamDisplayPolicy(inSam);
  useEffect(() => {
    seen.current = value;
    seen.history.push(value);
  });
  return null;
}

const latest = () => seen.current as Policy;

function mount(inSam: boolean) {
  act(() => {
    renderer = create(createElement(Probe, { inSam }));
  });
  // Let anything the hook deferred on mount run, so a deferred arm is seen.
  act(() => {
    vi.advanceTimersByTime(1);
  });
}

/** keepAwake on every render since `from` (an index into seen.history). */
const keepAwakeSince = (from: number) =>
  seen.history.slice(from).map((value) => value.keepAwake);

function setSam(inSam: boolean) {
  act(() => {
    renderer.update(createElement(Probe, { inSam }));
  });
}

function goTo(state: "active" | "inactive" | "background") {
  act(() => {
    appState.currentState = state;
    for (const fn of appState.listeners) fn(state);
  });
}

function touch() {
  act(() => latest().recordActivity());
}

function advance(ms: number) {
  act(() => {
    vi.setSystemTime(Date.now() + ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T15:00:00Z"));
  appState.currentState = "active";
  appState.listeners.clear();
  seen.current = null;
  seen.history = [];
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
});

describe("useAsamDisplayPolicy", () => {
  it("does not keep awake on entering Single App Mode without a touch", () => {
    mount(true);
    expect(keepAwakeSince(0)).not.toContain(true);
  });

  it("keeps awake after a touch", () => {
    mount(true);
    touch();
    expect(latest().keepAwake).toBe(true);
  });

  it("does not arm the window when the app becomes active", () => {
    mount(true);
    goTo("background");
    advance(10 * 60 * 1000);
    goTo("active");
    expect(latest().keepAwake).toBe(false);
  });

  it("does not revive an expired window on the next wake", () => {
    mount(true);
    touch();
    goTo("background");
    advance(ASAM_AWAKE_WINDOW_MS + 60_000);
    goTo("active");
    expect(latest().keepAwake).toBe(false);
  });

  // The folio case: closing it locks the iPad, and iOS often bounces the app
  // straight back to active. The window must not come back with it.
  it("ends the window when the iPad locks, even if iOS bounces straight back", () => {
    mount(true);
    touch();
    const from = seen.history.length;
    goTo("background");
    goTo("active");
    expect(keepAwakeSince(from)).not.toContain(true);
  });

  it("ends the window on a bounce that only reaches inactive", () => {
    mount(true);
    touch();
    const from = seen.history.length;
    goTo("inactive");
    goTo("active");
    expect(keepAwakeSince(from)).not.toContain(true);
  });

  it("re-arms on the first touch after the iPad wakes", () => {
    mount(true);
    touch();
    goTo("background");
    advance(60_000);
    goTo("active");
    touch();
    expect(latest().keepAwake).toBe(true);
  });

  it("lets the iPad sleep once the window runs out", () => {
    mount(true);
    touch();
    act(() => {
      vi.advanceTimersByTime(ASAM_AWAKE_WINDOW_MS + 1);
    });
    expect(latest().keepAwake).toBe(false);
  });

  it("does not revive an expired window when Single App Mode re-enters", () => {
    mount(true);
    touch();
    setSam(false);
    advance(ASAM_AWAKE_WINDOW_MS + 60_000);
    const from = seen.history.length;
    setSam(true);
    expect(keepAwakeSince(from)).not.toContain(true);
  });

  it("does not flash keep-awake when Single App Mode re-enters inside the window", () => {
    mount(true);
    touch();
    setSam(false);
    advance(60_000);
    const from = seen.history.length;
    setSam(true);
    expect(keepAwakeSince(from)).not.toContain(true);
  });

  it("does not flash keep-awake on a wake after the window expired", () => {
    mount(true);
    touch();
    goTo("background");
    advance(ASAM_AWAKE_WINDOW_MS + 60_000);
    const from = seen.history.length;
    goTo("active");
    expect(keepAwakeSince(from)).not.toContain(true);
  });
});
