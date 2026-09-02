/**
 * Regression test for the pointer TAP → select defect (2026-07-29 ship-day
 * finding, reworked substantially by PR #1780). Renders the REAL
 * `SimulatorViewport` component in jsdom (no React Testing Library — not a repo
 * dependency; this uses only react-dom/client + jsdom, both already deps) and
 * dispatches the actual DOM event sequence a browser produces for a tap
 * (pointerdown → pointerup, no synthesized click needed since the entity's
 * `onClick` fires from the browser's own click synthesis — jsdom does NOT
 * auto-synthesize click from pointer events, so this test dispatches the
 * `click` explicitly too, matching real click-after-pointerup ordering) and
 * for a drag-then-release (pointerdown → pointermove past the pan threshold →
 * pointerup → click), asserting a drag must NOT also select.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

import { system } from "@/lib/theme";
import type { EcosystemGridSimulatorSpec, SimulatorSceneV1 } from "@/lib/simulator/contract";
import { SimulatorViewport } from "../SimulatorViewport";

function spec(): EcosystemGridSimulatorSpec {
  return {
    version: 1,
    templateId: "ecosystemGrid",
    templateVersion: 1,
    config: {
      width: 8,
      height: 8,
      boundary: "bounded",
      initialResourceDensity: 0.3,
      resourceRegrowthPerTick: 0.02,
      corpseDecayTicks: 5,
      baseMetabolicCost: 1,
      reproductionEnergyThreshold: 10,
      maxAutomata: 12,
      environmentalNoise: { enabled: false, amplitude: 0 },
    },
    criterion: { kind: "measured", metricKey: "longevity", direction: "maximize" },
    speciesSlots: [],
    tickBudget: { iterationTicks: 20, seasonTicks: 60, absoluteMaxTicks: 120 },
    interpreter: { kind: "llm", role: "AUTOMATON" },
    microWorld: false,
  };
}

function scene(): SimulatorSceneV1 {
  return {
    protocolVersion: 1,
    templateId: "ecosystemGrid",
    tick: 3,
    viewport: { width: 8, height: 8, boundary: "bounded" },
    entities: [{ id: "swimmer-1", kind: "automaton", x: 2, y: 2, layer: 0, label: "Fish" }],
    cells: [],
  };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

// react-dom/client only recognizes act() when this flag is set (normally done
// by a testing library's setup file — there isn't one for web component tests
// in this repo, hence setting it here rather than adding a new dependency).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
});

function renderViewport(
  onSelectAutomaton: (id: string) => void,
  liveScene: SimulatorSceneV1 = scene(),
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(SimulatorViewport, {
          spec: spec(),
          frame: null,
          liveScene,
          isLiveHead: true,
          run: null,
          tick: 3,
          maxTick: 3,
          moreComing: false,
          playing: false,
          onScrub: () => {},
          onTogglePlay: () => {},
          onSelectAutomaton,
          selectedAutomatonId: null,
          speciesIcons: {},
          runLabel: "no run",
          personalDelta: null,
        }),
      }),
    );
  });
  const automaton = container.querySelector('[role="button"][aria-label*="Fish"]');
  if (!automaton) throw new Error("automaton entity not rendered");
  return automaton as SVGElement;
}

/** Dispatches the real browser sequence for a gesture: pointerdown, an
 * optional pointermove (drag), pointerup, then click — mirroring the actual
 * event order a click-vs-drag threshold implementation must handle (click
 * always fires AFTER pointerup in a real browser). */
function tap(entity: SVGElement, opts: { dx?: number; dy?: number } = {}) {
  const startX = 100;
  const startY = 100;
  const dx = opts.dx ?? 0;
  const dy = opts.dy ?? 0;
  act(() => {
    entity.dispatchEvent(new MouseEvent("pointerdown", { clientX: startX, clientY: startY, bubbles: true }));
  });
  if (dx !== 0 || dy !== 0) {
    act(() => {
      entity.dispatchEvent(
        new MouseEvent("pointermove", { clientX: startX + dx, clientY: startY + dy, bubbles: true }),
      );
    });
  }
  act(() => {
    entity.dispatchEvent(new MouseEvent("pointerup", { clientX: startX + dx, clientY: startY + dy, bubbles: true }));
  });
  act(() => {
    entity.dispatchEvent(new MouseEvent("click", { clientX: startX + dx, clientY: startY + dy, bubbles: true }));
  });
}

describe("viewport pointer tap selects an automaton (dispatch item 3)", () => {
  it("selects on a plain pointerdown/pointerup/click with no movement", () => {
    const selected: string[] = [];
    const automaton = renderViewport((id) => selected.push(id));
    tap(automaton);
    expect(selected).toEqual(["swimmer-1"]);
  });

  it("selects on a tap with sub-threshold jitter (1-2px)", () => {
    const selected: string[] = [];
    const automaton = renderViewport((id) => selected.push(id));
    tap(automaton, { dx: 1, dy: 1 });
    expect(selected).toEqual(["swimmer-1"]);
  });

  it("selects the inverse-projected cell under horizontal letterboxing", () => {
    const selected: string[] = [];
    renderViewport((id) => selected.push(id));
    const svg = container?.querySelector('svg[aria-label^="Simulator viewport"]');
    const automaton = container?.querySelector('[data-world-entity-kind="automaton"]');
    if (!(svg instanceof SVGElement) || !(automaton instanceof SVGElement)) {
      throw new Error("isometric viewport geometry not rendered");
    }
    const viewBox = svg.getAttribute("viewBox")?.split(/\s+/).map(Number);
    const transform = automaton.getAttribute("transform")?.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
    if (!viewBox || viewBox.length !== 4 || !transform) throw new Error("isometric coordinates unavailable");
    const rect = {
      left: 40,
      top: 25,
      width: viewBox[2] * 3,
      height: viewBox[3] * 2,
    };
    const uniformScale = 2;
    const horizontalMargin = (rect.width - viewBox[2] * uniformScale) / 2;
    Object.defineProperty(svg, "getBoundingClientRect", {
      value: () => ({
        x: rect.left,
        y: rect.top,
        left: rect.left,
        top: rect.top,
        right: rect.left + rect.width,
        bottom: rect.top + rect.height,
        width: rect.width,
        height: rect.height,
        toJSON: () => ({}),
      }),
    });
    act(() => {
      svg.dispatchEvent(
        new MouseEvent("click", {
          clientX: rect.left + horizontalMargin + Number(transform[1]) * uniformScale,
          clientY: rect.top + Number(transform[2]) * uniformScale,
          bubbles: true,
        }),
      );
    });
    expect(selected).toEqual(["swimmer-1"]);
  });

  it("does NOT select when the gesture is a real pan drag (past the threshold)", () => {
    const selected: string[] = [];
    const automaton = renderViewport((id) => selected.push(id));
    tap(automaton, { dx: 30, dy: 0 });
    expect(selected).toEqual([]);
  });

  it("keyboard Enter selects an entity even after a prior real pan drag (review Finding 1)", () => {
    // A keyboard activation can never be a pointer drag, so it must not be
    // gated on the click path's consumedDrag() guard. Before the fix, the
    // guard's drag state was retained after pointerup (for the trailing
    // click to read) but never cleared before the NEXT gesture, so a
    // keyboard Enter dispatched with no intervening pointerdown would still
    // see `moved: true` and silently no-op.
    const selected: string[] = [];
    const automaton = renderViewport((id) => selected.push(id));
    // A real pan drag first — leaves the click-guard's drag state "consumed".
    tap(automaton, { dx: 30, dy: 0 });
    expect(selected).toEqual([]);
    // Now a keyboard activation with NO pointer events at all.
    act(() => {
      automaton.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(selected).toEqual(["swimmer-1"]);
  });

  it("renders unknown cell and entity kinds as neutral markers without crashing", () => {
    const unknownScene: SimulatorSceneV1 = {
      ...scene(),
      cells: [{ x: 4, y: 3, kind: "sibling-terrain", intensity: 0.7 }],
      entities: [
        ...scene().entities,
        { id: "choice-1", kind: "choice-token", x: 4, y: 3, layer: 4 },
      ],
    };
    renderViewport(() => {}, unknownScene);
    expect(container?.querySelector('[data-world-cell-kind="sibling-terrain"]')).not.toBeNull();
    expect(container?.querySelector('[data-world-entity-kind="choice-token"] polygon')).not.toBeNull();
  });
});
