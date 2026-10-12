// @vitest-environment jsdom
import { ChakraProvider } from "@chakra-ui/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { system } from "@/lib/theme";
import type { DistributeSpec } from "@/lib/manipulative/types";
import { Manipulative, type KindProps } from "./Manipulative";

vi.mock("./kinds/DistributeManipulative", async () => {
  const { createElement, useEffect } = await vi.importActual<typeof import("react")>("react");
  return {
    DistributeManipulative: ({ spec, onStateChange }: KindProps<DistributeSpec>) => {
      useEffect(() => {
        onStateChange?.({ column: spec.startColumn });
      }, [spec.startColumn, onStateChange]);
      return createElement("div", { "data-testid": "board" });
    },
  };
});

const spec: DistributeSpec = {
  kind: "distribute",
  id: "question-first",
  concept: "Distributive property",
  prompt: "Split the area model.",
  width: 13,
  height: 6,
  startColumn: 4,
  goal: { type: "splitAt", column: 10 },
};

describe("Manipulative question-first input", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent: () => false,
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(onCommit = vi.fn(), onInteractionStart = vi.fn()) {
    act(() => root.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra requires children in its props type.
      createElement(ChakraProvider, {
        value: system,
        children: createElement(Manipulative, { spec, onCommit, onInteractionStart }),
      }),
    ));
    return { onCommit, onInteractionStart };
  }

  function type(value: string) {
    const input = container.querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function done() {
    return [...container.querySelectorAll("button")].find((button) => button.textContent === "Done")!;
  }

  it("accepts a typed answer without a board gesture and reports interaction timing", () => {
    const { onCommit, onInteractionStart } = render();
    expect(container.textContent).toContain("What is 6 × 13?");
    expect(done().disabled).toBe(false);
    type("78");
    expect(onInteractionStart).toHaveBeenCalled();
    act(() => done().click());
    expect(JSON.parse(onCommit.mock.calls[0][0])).toEqual({ column: 4, value: 78 });
  });

  it("never re-arms the idle cue after typing is cleared", () => {
    render();
    expect(container.querySelector(".manip-idle-pulse")).not.toBeNull();
    type("78");
    type("");
    expect(container.querySelector(".manip-idle-pulse")).toBeNull();
  });

  it.each(["pointerdown", "keydown"])("ends the idle cue on the first %s anywhere in the card", (event) => {
    const { onInteractionStart } = render();
    act(() => container.querySelector("input")!.dispatchEvent(new Event(event, { bubbles: true })));
    expect(container.querySelector(".manip-idle-pulse")).toBeNull();
    expect(onInteractionStart).toHaveBeenCalled();
  });

  it("preserves a nonempty invalid answer instead of silently submitting only the board", () => {
    const { onCommit } = render();
    type("-");
    expect(container.querySelector("input")!.value).toBe("-");
    act(() => done().click());
    expect(JSON.parse(onCommit.mock.calls[0][0])).toEqual({ column: 4, value: null });
  });
});
