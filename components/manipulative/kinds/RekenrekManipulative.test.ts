// @vitest-environment jsdom

import {
  act,
  createElement,
  Profiler,
  type ProfilerOnRenderCallback,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { RekenrekManipulative } from "./RekenrekManipulative";
import type { RekenrekSpec } from "@/lib/manipulative/types";

class ResizeObserverMock {
  private static observers = new Set<ResizeObserverMock>();
  static measuredWidth = 480;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe() {
    ResizeObserverMock.observers.add(this);
  }

  disconnect() {
    ResizeObserverMock.observers.delete(this);
  }

  static emit(width: number) {
    ResizeObserverMock.measuredWidth = width;
    for (const observer of [...ResizeObserverMock.observers]) {
      observer.callback(
        [{ contentRect: { width } } as ResizeObserverEntry],
        observer as unknown as ResizeObserver,
      );
    }
  }

  static reset() {
    ResizeObserverMock.observers.clear();
    ResizeObserverMock.measuredWidth = 480;
  }
}

const initialSpec: RekenrekSpec = {
  id: "rekenrek-render-stability",
  kind: "rekenrek",
  concept: "Number bonds",
  prompt: "Show three and five.",
  total: 8,
  startLeft: 3,
  goal: { type: "groupOf", value: 3 },
};

const fullyLeftSpec: RekenrekSpec = {
  ...initialSpec,
  id: "rekenrek-geometry-stability",
  startLeft: 8,
  goal: { type: "groupOf", value: 8 },
};

describe("RekenrekManipulative", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 0,
      height: 200,
      left: 0,
      right: ResizeObserverMock.measuredWidth,
      top: 0,
      width: ResizeObserverMock.measuredWidth,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    ResizeObserverMock.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(
    spec: RekenrekSpec,
    onSolvedChange: (solved: boolean) => void,
    onStateChange: (state: unknown) => void,
    onRender: ProfilerOnRenderCallback = () => {},
  ) {
    act(() => {
      root.render(
        createElement(
          Profiler,
          { id: "rekenrek", onRender },
          createElement(RekenrekManipulative, {
            spec,
            onSolvedChange,
            onStateChange,
          }),
        ),
      );
    });
  }

  test("settles across unchanged rerenders and resets for a new puzzle", () => {
    const onSolvedChange = vi.fn();
    const onStateChange = vi.fn();

    render(initialSpec, onSolvedChange, onStateChange);
    for (let i = 0; i < 8; i++) {
      render(initialSpec, onSolvedChange, onStateChange);
    }

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenLastCalledWith({ left: 3 });
    expect(container.querySelectorAll("[style*='border-radius: 50%']")).toHaveLength(8);

    render(
      {
        ...initialSpec,
        id: "rekenrek-render-stability-next",
        total: 12,
        startLeft: 7,
        goal: { type: "groupOf", value: 7 },
      },
      onSolvedChange,
      onStateChange,
    );

    expect(onStateChange).toHaveBeenCalledTimes(2);
    expect(onStateChange).toHaveBeenLastCalledWith({ left: 7 });
    expect(container.querySelectorAll("[style*='border-radius: 50%']")).toHaveLength(12);
  });

  test("does not add redundant commits when resize geometry converges without moving beads", () => {
    const onSolvedChange = vi.fn();
    const onStateChange = vi.fn();
    const onRender = vi.fn<ProfilerOnRenderCallback>();

    render(fullyLeftSpec, onSolvedChange, onStateChange, onRender);
    const before = Array.from(container.querySelectorAll("[style*='border-radius: 50%']"), (bead) =>
      bead.getAttribute("style"),
    );
    onRender.mockClear();

    // These measured preview widths change enough to update the stage, but stay
    // within one bead-size bucket. Because every bead is against the left stop,
    // its rest position is identical even as the unused right rail converges.
    act(() => ResizeObserverMock.emit(483));
    act(() => ResizeObserverMock.emit(486));

    expect(Array.from(container.querySelectorAll("[style*='border-radius: 50%']"), (bead) =>
      bead.getAttribute("style"),
    )).toEqual(before);
    expect(onRender).toHaveBeenCalledTimes(4);
  });
});
