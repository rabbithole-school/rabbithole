// @vitest-environment jsdom
// The School shell must not flash from the narrow overlay form to the rail
// splitter on a hard load: the first client render already knows the width.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { system } from "@/lib/theme";
import { useWideEnoughForRail } from "../railBreakpoint";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function stubViewport(wide: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      // Every min-width query matches on a wide screen; none on a narrow one.
      matches: wide && /min-width/.test(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function renders(): boolean[] {
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useWideEnoughForRail());
    return null;
  }
  act(() => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, { value: system, children: createElement(Probe) }),
    );
  });
  return seen;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("useWideEnoughForRail", () => {
  it("is true on the first render of a wide screen, so the splitter never starts in the overlay form", () => {
    stubViewport(true);
    const seen = renders();
    expect(seen[0]).toBe(true);
    expect(seen.every(Boolean)).toBe(true);
  });

  it("is false on a narrow screen", () => {
    stubViewport(false);
    expect(renders().every((v) => v === false)).toBe(true);
  });
});
