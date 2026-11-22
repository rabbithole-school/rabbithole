import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RETRY_GAP_MS,
  SHOW_TIMEOUT_MS,
  useModalPresentationRetry,
} from "../useModalPresentationRetry";

type Result = ReturnType<typeof useModalPresentationRetry>;

function mount(requested: boolean) {
  const latest: { current: Result | null } = { current: null };
  function Probe({ requested }: { requested: boolean }) {
    latest.current = useModalPresentationRetry(requested);
    return null;
  }
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(createElement(Probe, { requested }));
  });
  return {
    result: () => latest.current!,
    rerender: (next: boolean) =>
      act(() => renderer.update(createElement(Probe, { requested: next }))),
  };
}

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useModalPresentationRetry", () => {
  it("leaves a modal that presents alone", () => {
    const { result } = mount(true);
    expect(result().visible).toBe(true);
    act(() => result().markShown());
    advance(SHOW_TIMEOUT_MS * 5);
    expect(result().visible).toBe(true);
  });

  it("takes a refused modal down, then tries again", () => {
    const { result } = mount(true);
    advance(SHOW_TIMEOUT_MS);
    // No onShow: iOS refused it, so the invisible host must go.
    expect(result().visible).toBe(false);
    advance(RETRY_GAP_MS);
    expect(result().visible).toBe(true);
  });

  it("keeps retrying while something stays in the way, and stops once shown", () => {
    const { result } = mount(true);
    for (let i = 0; i < 3; i++) {
      advance(SHOW_TIMEOUT_MS);
      expect(result().visible).toBe(false);
      advance(RETRY_GAP_MS);
      expect(result().visible).toBe(true);
    }
    act(() => result().markShown());
    advance(SHOW_TIMEOUT_MS * 5);
    expect(result().visible).toBe(true);
  });

  it("keeps a modal whose onShow arrives just after the hold began", () => {
    const { result } = mount(true);
    advance(SHOW_TIMEOUT_MS);
    expect(result().visible).toBe(false);
    act(() => result().markShown());
    expect(result().visible).toBe(true);
    advance(SHOW_TIMEOUT_MS * 5);
    expect(result().visible).toBe(true);
  });

  it("does nothing for a closed modal", () => {
    const { result } = mount(false);
    advance(SHOW_TIMEOUT_MS * 5);
    expect(result().visible).toBe(false);
  });

  it("starts over when a shown modal closes and reopens", () => {
    const { result, rerender } = mount(true);
    act(() => result().markShown());
    rerender(false);
    expect(result().visible).toBe(false);
    rerender(true);
    advance(SHOW_TIMEOUT_MS);
    // The earlier onShow doesn't count for this opening.
    expect(result().visible).toBe(false);
  });

  it("closing a held modal clears the hold", () => {
    const { result, rerender } = mount(true);
    advance(SHOW_TIMEOUT_MS);
    expect(result().visible).toBe(false);
    rerender(false);
    rerender(true);
    expect(result().visible).toBe(true);
  });
});
