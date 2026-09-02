import { createElement, useRef } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A Reanimated shared value records the RAW argument it was set to, so a test
// can tell an animated set (a withTiming descriptor) from an instant one (a
// plain number) — which is the whole distinction the hook is making.
type Anim = { __timing: number; duration?: number };
type Box = { get: () => number | Anim; set: (next: number | Anim) => void };

const { keyboardMock, platform, listeners, boxes } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  return {
    listeners,
    boxes: [] as Array<{ get: () => unknown; set: (next: unknown) => void }>,
    platform: { OS: "ios" as "ios" | "android" },
    keyboardMock: {
      metrics: vi.fn<() => { height: number } | undefined>(() => undefined),
      addListener: (name: string, fn: (event?: unknown) => void) => {
        const existing = listeners.get(name) ?? [];
        listeners.set(name, [...existing, fn]);
        return {
          remove: () =>
            listeners.set(
              name,
              (listeners.get(name) ?? []).filter((f) => f !== fn),
            ),
        };
      },
    },
  };
});

vi.mock("react-native", () => ({ Keyboard: keyboardMock, Platform: platform }));
vi.mock("react-native-reanimated", () => ({
  // A shared value survives re-renders and mutating it never re-renders, so the
  // stand-in has to be ref-backed and readable out of band — reading it off the
  // animated style would only ever show the value as of the last render.
  useSharedValue: (initial: number) => {
    const ref = useRef<Box | null>(null);
    if (!ref.current) {
      let current: number | Anim = initial;
      ref.current = {
        get: () => current,
        set: (next) => {
          current = next;
        },
      };
      boxes.push(ref.current);
    }
    return ref.current;
  },
  useAnimatedStyle: (fn: () => unknown) => fn(),
  withTiming: (to: number, config?: { duration?: number }): Anim => ({
    __timing: to,
    duration: config?.duration,
  }),
}));

import { useKeyboardInset } from "../useKeyboardInset";

/** Render the hook once and keep a live handle on its inset. */
function renderHook() {
  const Probe = () => {
    useKeyboardInset();
    return null;
  };
  act(() => {
    create(createElement(Probe));
  });
  const inset = boxes[boxes.length - 1];
  return { inset: () => inset.get() };
}

function emit(name: string, event?: unknown) {
  act(() => {
    for (const fn of listeners.get(name) ?? []) fn(event);
  });
}

describe("useKeyboardInset", () => {
  beforeEach(() => {
    platform.OS = "ios";
    keyboardMock.metrics.mockReturnValue(undefined);
  });
  afterEach(() => {
    listeners.clear();
    boxes.length = 0;
    vi.clearAllMocks();
  });

  it("starts at zero when no keyboard is showing", () => {
    const hook = renderHook();
    expect(hook.inset()).toBe(0);
  });

  // The reason the seed exists: DeliverablePanel mounts on rotation into the
  // landscape two-pane layout, which a scholar can do mid-sentence. No keyboard
  // event follows that mount, so a hook that started at 0 would stay at 0 and
  // render the panel full-height behind the keyboard.
  it("seeds the inset from live metrics when it mounts under an open keyboard", () => {
    keyboardMock.metrics.mockReturnValue({ height: 422 });
    const hook = renderHook();
    expect(hook.inset()).toBe(422);
  });

  it("tracks the iOS will-events with the system's own animation duration", () => {
    const hook = renderHook();
    emit("keyboardWillShow", { endCoordinates: { height: 422 }, duration: 383 });
    expect(hook.inset()).toEqual({ __timing: 422, duration: 383 });
    emit("keyboardWillHide", { duration: 383 });
    expect(hook.inset()).toEqual({ __timing: 0, duration: 383 });
  });

  it("animates with a default duration when iOS reports none", () => {
    const hook = renderHook();
    emit("keyboardWillShow", { endCoordinates: { height: 422 }, duration: 0 });
    expect(hook.inset()).toEqual({ __timing: 422, duration: undefined });
  });

  // keyboardDidHide always lands, including on paths that never deliver a
  // matching willHide — this is what guarantees the inset cannot outlive the
  // keyboard.
  it("collapses on keyboardDidHide even without a preceding willHide", () => {
    keyboardMock.metrics.mockReturnValue({ height: 422 });
    const hook = renderHook();
    emit("keyboardDidHide");
    expect(hook.inset()).toBe(0);
  });

  describe("on Android", () => {
    beforeEach(() => {
      platform.OS = "android";
    });

    it("settles the did-events instantly instead of animating", () => {
      const hook = renderHook();
      emit("keyboardDidShow", { endCoordinates: { height: 300 } });
      expect(hook.inset()).toBe(300);
      emit("keyboardDidHide");
      expect(hook.inset()).toBe(0);
    });

    it("ignores the iOS will-events it never subscribes to", () => {
      const hook = renderHook();
      emit("keyboardWillShow", { endCoordinates: { height: 300 }, duration: 383 });
      expect(hook.inset()).toBe(0);
    });
  });
});
