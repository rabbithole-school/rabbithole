/**
 * Integration coverage for the ART lane's terrain tile wiring into the web
 * isometric SimulatorViewport (renders the REAL component in jsdom, same harness
 * as SimulatorViewport.pointer.test.ts — no React Testing Library, just
 * react-dom/client + jsdom).
 *
 * Two things this guards:
 *  1. Every ecosystemGrid terrain kind resolves to a catalog-owned shared SVG
 *     surface fill. The grid geometry itself is always deterministic, so
 *     independently framed images cannot create seams between neighbors.
 *  2. A large board contains no raster floor images: the continuous terrain
 *     path remains SVG geometry regardless of grid size.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";

import { system } from "@/lib/theme";
import type {
  EcosystemGridSimulatorSpec,
  PublicGoodsSimulatorSpec,
  SimulatorSceneCellV1,
  SimulatorSceneEntityV1,
  SimulatorSceneV1,
} from "@/lib/simulator/contract";
import { MEADOW_ECOSYSTEM_DEMO_SPEC } from "@/lib/simulator/ecosystemBiomeDemos";
import { ECOSYSTEM_LANDSCAPE_BANDS } from "@/lib/simulator/ecosystemLandscape";
import { ECOSYSTEM_BIOMES } from "@/lib/simulator/ecosystemTerrainTiles";
import { initialTerrainPreviewScene } from "@/lib/simulator/scene";
import { ECOSYSTEM_GRID } from "@/lib/simulator/templates/ecosystemGrid";
import { SimulatorViewport } from "../SimulatorViewport";

let root: Root | null = null;
let container: HTMLElement | null = null;

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

function renderViewport(spec: EcosystemGridSimulatorSpec | PublicGoodsSimulatorSpec, liveScene: SimulatorSceneV1) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(SimulatorViewport, {
          spec,
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
          onSelectAutomaton: () => {},
          selectedAutomatonId: null,
          speciesIcons: {},
          runLabel: "no run",
          personalDelta: null,
        }),
      }),
    );
  });
  return container!.querySelector('svg[aria-label^="Simulator viewport"]') as SVGSVGElement;
}

function ecosystemSpec(
  width: number,
  height: number,
  biome?: EcosystemGridSimulatorSpec["config"]["biome"],
): EcosystemGridSimulatorSpec {
  return {
    version: 1,
    templateId: "ecosystemGrid",
    templateVersion: ECOSYSTEM_GRID.version,
    config: {
      width,
      height,
      boundary: "bounded",
      ...(biome ? { biome } : {}),
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

/** A scene exercising every terrain kind the tile library styles, at fixed,
 *  easy-to-reason-about positions, plus a resource cell (default floor). */
function terrainRichScene(width: number, height: number): SimulatorSceneV1 {
  const cells: SimulatorSceneCellV1[] = [
    { x: 1, y: 1, kind: "shelter", intensity: 1 },
    { x: 2, y: 1, kind: "current_north", intensity: 1 },
    { x: 3, y: 1, kind: "current_south", intensity: 1 },
    { x: 4, y: 1, kind: "current_east", intensity: 1 },
    { x: 5, y: 1, kind: "current_west", intensity: 1 },
    { x: 6, y: 1, kind: "shallows", intensity: 1 },
    { x: 7, y: 1, kind: "resource", intensity: 0.9 },
  ];
  return {
    protocolVersion: 1,
    templateId: "ecosystemGrid",
    tick: 3,
    viewport: { width, height, boundary: "bounded" },
    entities: [{ id: "swimmer-1", kind: "automaton", x: 0, y: 0, layer: 0, label: "Fish" }],
    cells,
  };
}

function topFaceColor(tileGroup: Element): string | null {
  const faces = tileGroup.querySelectorAll("polygon");
  return faces[faces.length - 1]?.getAttribute("fill") ?? null;
}

describe("web SimulatorViewport draws continuous terrain (ecosystemGrid)", () => {
  it("renders the authored terrain-only scene before the first run", () => {
    const spec = ecosystemSpec(4, 3, "meadow");
    spec.config.initialResourceDensity = 1;
    spec.config.terrain = {
      shelter: [{ x: 0, y: 0 }],
      current: [],
      shallows: [],
      predatorSlotIds: [],
    };
    spec.config.landscape = {
      version: 1,
      seed: "first-ever-viewport",
      regionCount: 3,
      roughness: 0.4,
      lowlandCoverage: 0.25,
      highlandCoverage: 0.25,
    };

    const preview = initialTerrainPreviewScene(spec);
    expect(preview?.entities).toEqual([]);

    const svg = renderViewport(spec, preview!);
    expect(svg.getAttribute("aria-label")).toBe(
      "Simulator viewport — authored terrain and resources before the first run",
    );
    expect(svg.querySelector('g[data-world-cell-kind="shelter"]')).not.toBeNull();
    expect(svg.querySelectorAll('g[data-world-cell-kind="resource"]').length).toBeGreaterThan(0);
    expect(svg.querySelectorAll("[data-ecosystem-landscape-band]").length).toBe(12);
  });

  it("uses catalog-owned SVG surface colors, never independently framed floor art", () => {
    const svg = renderViewport(ecosystemSpec(8, 8), terrainRichScene(8, 8));
    const kindToExpectedColor: Record<string, string> = {
      shelter: "#173E47",
      current_north: "#2563A8",
      current_south: "#2563A8",
      current_east: "#2563A8",
      current_west: "#2563A8",
      shallows: "#9ADFE2",
      resource: "#3192AC",
    };
    for (const [kind, color] of Object.entries(kindToExpectedColor)) {
      const tileGroup = svg.querySelector(`g[data-world-cell-kind="${kind}"]`);
      expect(tileGroup, `no tile group rendered for cell kind "${kind}"`).not.toBeNull();
      expect(topFaceColor(tileGroup!)).toBe(color);
    }

    // A bare cell receives the reef floor surface, not a checkerboard or raster.
    const bareTiles = [...svg.querySelectorAll("g")].filter(
      (g) => !g.hasAttribute("data-world-cell-kind") && g.querySelectorAll("polygon").length === 3,
    );
    expect(bareTiles.length).toBeGreaterThan(0);
    expect(topFaceColor(bareTiles[0])).toBe("#3192AC");
    expect(svg.querySelectorAll("image")).toHaveLength(0);
    expect(svg.querySelectorAll("use")).toHaveLength(0);
  });

  it("renders the meadow fixture with a seam-free land palette", () => {
    const svg = renderViewport(
      {
        ...MEADOW_ECOSYSTEM_DEMO_SPEC,
        config: {
          ...MEADOW_ECOSYSTEM_DEMO_SPEC.config,
          width: 8,
          height: 8,
          landscape: undefined,
        },
      },
      terrainRichScene(8, 8),
    );
    const kindToExpectedColor: Record<string, string> = {
      shelter: "#234B2C",
      current_north: "#C77B30",
      current_south: "#C77B30",
      current_east: "#C77B30",
      current_west: "#C77B30",
      shallows: "#3A9FC0",
      resource: "#76A84C",
    };
    for (const [kind, color] of Object.entries(kindToExpectedColor)) {
      const tileGroup = svg.querySelector(`g[data-world-cell-kind="${kind}"]`);
      expect(tileGroup).not.toBeNull();
      expect(topFaceColor(tileGroup!)).toBe(color);
    }
    expect(svg.querySelectorAll("image")).toHaveLength(0);
    expect(svg.querySelector("rect")?.getAttribute("fill")).toBe("#F7FEE7");
    expect(svg.querySelector('path[stroke="#D9FFFF"]')).toBeNull();
    expect(svg.querySelectorAll('circle[fill="#3F2815"]').length).toBeGreaterThan(0);
  });

  it("renders seeded relief in existing faces while physics terrain keeps precedence", () => {
    const spec: EcosystemGridSimulatorSpec = {
      ...MEADOW_ECOSYSTEM_DEMO_SPEC,
      config: {
        ...MEADOW_ECOSYSTEM_DEMO_SPEC.config,
        width: 8,
        height: 8,
        landscape: {
          version: 1,
          seed: "viewport-landscape-proof",
          regionCount: 5,
          roughness: 0.4,
          lowlandCoverage: 0.25,
          highlandCoverage: 0.25,
        },
      },
    };
    const svg = renderViewport(spec, terrainRichScene(8, 8));
    const renderedBands = new Set(
      [...svg.querySelectorAll("[data-ecosystem-landscape-band]")]
        .map((group) => group.getAttribute("data-ecosystem-landscape-band"))
        .filter(Boolean),
    );
    expect(renderedBands).toEqual(new Set(ECOSYSTEM_LANDSCAPE_BANDS));
    expect(
      svg.querySelectorAll("[data-ecosystem-landscape-vector]").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      svg.querySelectorAll("[data-ecosystem-landscape-vector]").length,
    ).toBeLessThanOrEqual(8);
    expect(
      svg
        .querySelector('[data-ecosystem-landscape-vector="relief-shadow"]')
        ?.getAttribute("stroke"),
    ).not.toBe(ECOSYSTEM_BIOMES.meadow.rendering.physicsOutlineColor);
    const scenicTile = [...svg.querySelectorAll("g[data-ecosystem-landscape-band]")].find(
      (group) => !group.hasAttribute("data-ecosystem-physics-terrain"),
    );
    expect(scenicTile).toBeDefined();
    const scenicBand = scenicTile!.getAttribute(
      "data-ecosystem-landscape-band",
    ) as (typeof ECOSYSTEM_LANDSCAPE_BANDS)[number];
    const scenicFaces = scenicTile!.querySelectorAll("polygon");
    expect(scenicFaces[0].getAttribute("fill")).toBe(
      ECOSYSTEM_BIOMES.meadow.rendering.landscapeWalls[scenicBand].left,
    );
    expect(scenicFaces[1].getAttribute("fill")).toBe(
      ECOSYSTEM_BIOMES.meadow.rendering.landscapeWalls[scenicBand].right,
    );

    const shelter = svg.querySelector('g[data-world-cell-kind="shelter"]');
    expect(shelter).not.toBeNull();
    expect(topFaceColor(shelter!)).toBe(
      ECOSYSTEM_BIOMES.meadow.rendering.surface.shelter,
    );
    expect(shelter!.getAttribute("data-ecosystem-physics-terrain")).toBe("true");
    const shelterFaces = shelter!.querySelectorAll("polygon");
    expect(shelterFaces[shelterFaces.length - 1].getAttribute("stroke")).toBe(
      ECOSYSTEM_BIOMES.meadow.rendering.physicsOutlineColor,
    );
    expect(
      ECOSYSTEM_LANDSCAPE_BANDS.some(
        (band) =>
          ECOSYSTEM_BIOMES.meadow.rendering.surface.landscape[band] ===
          topFaceColor(shelter!),
      ),
    ).toBe(false);
  });

  it("keeps an unrecognized cell kind on the neutral fallback (future templates)", () => {
    const spec = ecosystemSpec(4, 4);
    const scene: SimulatorSceneV1 = {
      protocolVersion: 1,
      templateId: "ecosystemGrid",
      tick: 1,
      viewport: { width: 4, height: 4, boundary: "bounded" },
      entities: [],
      cells: [{ x: 1, y: 1, kind: "a-future-template-kind", intensity: 1 }],
    };
    const svg = renderViewport(spec, scene);
    const tileGroup = svg.querySelector('g[data-world-cell-kind="a-future-template-kind"]');
    expect(tileGroup).not.toBeNull();
    expect(tileGroup!.querySelector("use")).toBeNull();
    const fallbackPolygon = tileGroup!.querySelectorAll("polygon");
    // wall polygons (x2) + the flat neutral-gray floor polygon
    expect(fallbackPolygon.length).toBe(3);
    const floorPolygon = fallbackPolygon[fallbackPolygon.length - 1];
    expect(floorPolygon.getAttribute("fill")).toBe("#64748B");
  });
});

describe("web SimulatorViewport terrain geometry (perf shape)", () => {
  it("keeps a large board as shared SVG geometry with no raster floor image decodes", () => {
    const width = 60;
    const height = 40;
    const cells: SimulatorSceneCellV1[] = [
      { x: 0, y: 0, kind: "shelter", intensity: 1 },
      { x: 1, y: 0, kind: "shelter", intensity: 1 },
      { x: 2, y: 0, kind: "shallows", intensity: 1 },
      { x: 3, y: 0, kind: "current_north", intensity: 1 },
    ];
    const scene: SimulatorSceneV1 = {
      protocolVersion: 1,
      templateId: "ecosystemGrid",
      tick: 1,
      viewport: { width, height, boundary: "bounded" },
      entities: [],
      cells,
    };
    const spec = ecosystemSpec(width, height);
    spec.config.landscape = {
      version: 1,
      seed: "large-board-shape",
      regionCount: 8,
      roughness: 0.45,
      lowlandCoverage: 0.25,
      highlandCoverage: 0.25,
    };
    const svg = renderViewport(spec, scene);

    expect(svg.querySelectorAll("image")).toHaveLength(0);
    expect(svg.querySelectorAll("use")).toHaveLength(0);
    expect(svg.querySelectorAll("[data-ecosystem-landscape-vector]")).toHaveLength(8);
    // Exactly three contiguous faces per grid cell: left wall, right wall, top.
    const tileGroups = [...svg.querySelectorAll("g")].filter(
      (group) => group.querySelectorAll(":scope > polygon").length === 3,
    );
    expect(tileGroups).toHaveLength(width * height);
  });
});

describe("web SimulatorViewport styles GAME-template round entities", () => {
  function publicGoodsSpec(): PublicGoodsSimulatorSpec {
    return {
      version: 1,
      templateId: "publicGoods",
      templateVersion: 1,
      config: {
        rounds: 20,
        endowmentPerRound: 10,
        multiplier: 1.6,
        noiseProbability: 0,
        maxAutomata: 6,
      },
      criterion: { kind: "measured", metricKey: "poolLastRound", direction: "maximize" },
      speciesSlots: [
        {
          slotId: "villager",
          label: "Villager",
          countMin: 3,
          countMax: 6,
          defaultCount: 3,
          senses: [{ senseId: "history" }],
        },
      ],
      tickBudget: { iterationTicks: 20, seasonTicks: 60, absoluteMaxTicks: 120 },
      interpreter: { kind: "llm", role: "AUTOMATON" },
      microWorld: false,
    };
  }

  function publicGoodsScene(): SimulatorSceneV1 {
    const pool: SimulatorSceneEntityV1 = {
      id: "pool",
      kind: "pool",
      x: 10,
      y: 10,
      layer: 1,
      label: "Pool",
      color: "#0369A1",
      size: 1.2,
    };
    const token: SimulatorSceneEntityV1 = {
      id: "token:p1",
      kind: "token:contribute",
      x: 10.4,
      y: 10,
      layer: 3,
      label: "Contribute",
      color: "#15803D",
      size: 0.3,
    };
    return {
      protocolVersion: 1,
      templateId: "publicGoods",
      tick: 4,
      viewport: { width: 21, height: 21, boundary: "bounded" },
      entities: [pool, token],
      cells: [{ x: 10, y: 10, kind: "public-pool", intensity: 0.4 }],
    };
  }

  it("gives the pool entity a real (non-diamond) rendering", () => {
    const svg = renderViewport(publicGoodsSpec(), publicGoodsScene());
    const poolGroup = svg.querySelector('g[data-world-entity-kind="pool"]');
    expect(poolGroup).not.toBeNull();
    // The generic "unknown kind" fallback is a <polygon> diamond; the pool
    // now gets its own circles/ellipse basin instead.
    expect(poolGroup!.querySelector("polygon")).toBeNull();
    expect(poolGroup!.querySelectorAll("circle").length).toBeGreaterThan(0);
    expect(poolGroup!.querySelector("ellipse")).not.toBeNull();
  });

  it("styles a round token as a labeled badge, not the generic diamond", () => {
    const globalTypography = document.createElement("style");
    globalTypography.textContent = "text { font-size: 16px; }";
    document.head.appendChild(globalTypography);
    try {
      const svg = renderViewport(publicGoodsSpec(), publicGoodsScene());
      const tokenGroup = svg.querySelector('g[data-world-entity-kind="token:contribute"]');
      expect(tokenGroup).not.toBeNull();
      expect(tokenGroup!.querySelector("polygon")).toBeNull();
      const text = tokenGroup!.querySelector("text");
      expect(text).not.toBeNull();
      expect(text!.textContent).toBe("C");
      expect(text!.style.fontSize).toBe("0.15525px");
      expect(getComputedStyle(text!).fontSize).toBe("0.15525px");
    } finally {
      globalTypography.remove();
    }
  });

  it("keeps non-ecosystem board cells on their established checkerboard", () => {
    const svg = renderViewport(publicGoodsSpec(), publicGoodsScene());
    const cell = svg.querySelector('g[data-world-cell-kind="public-pool"]');
    const polygons = cell?.querySelectorAll("polygon");
    expect(polygons).toHaveLength(3);
    expect(polygons![polygons!.length - 1].getAttribute("fill")).toBe("#1D88A0");
  });

  it("keeps a genuinely unrecognized entity kind on the neutral diamond fallback", () => {
    const spec = publicGoodsSpec();
    const scene: SimulatorSceneV1 = {
      protocolVersion: 1,
      templateId: "publicGoods",
      tick: 1,
      viewport: { width: 21, height: 21, boundary: "bounded" },
      entities: [
        { id: "mystery", kind: "a-future-game-kind", x: 5, y: 5, layer: 2, color: "#111827" },
      ],
      cells: [],
    };
    const svg = renderViewport(spec, scene);
    const group = svg.querySelector('g[data-world-entity-kind="a-future-game-kind"]');
    expect(group).not.toBeNull();
    expect(group!.querySelector("polygon")).not.toBeNull();
  });
});
