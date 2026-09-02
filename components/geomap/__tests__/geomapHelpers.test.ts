import { describe, it, expect } from "vitest";
import { baseStyle, baseLabel } from "../baseStyles";
import { buildPaintLayers, tintHex, sublayerId, TINT_HEX } from "../paintPresets";
import { pathStyleForPreset } from "@/lib/geomap/geo";
import type { GeoBase, PaintPreset } from "@/lib/geomap/types";

describe("baseStyles", () => {
  it("maps every closed base to a mapbox:// style URL", () => {
    const bases: GeoBase[] = ["satellite", "terrain", "political", "politicalUnlabeled"];
    for (const b of bases) {
      const s = baseStyle(b);
      expect(s.styleUrl.startsWith("mapbox://styles/mapbox/")).toBe(true);
      expect(baseLabel(b)).toBeTruthy();
    }
  });

  it("only politicalUnlabeled hides symbol layers, and it reuses the political style", () => {
    expect(baseStyle("politicalUnlabeled").hideSymbols).toBe(true);
    expect(baseStyle("political").hideSymbols).toBe(false);
    expect(baseStyle("politicalUnlabeled").styleUrl).toBe(baseStyle("political").styleUrl);
  });

  it("satellite/terrain use their documented styles", () => {
    expect(baseStyle("satellite").styleUrl).toBe("mapbox://styles/mapbox/satellite-streets-v12");
    expect(baseStyle("terrain").styleUrl).toBe("mapbox://styles/mapbox/outdoors-v12");
    expect(baseStyle("political").styleUrl).toBe("mapbox://styles/mapbox/light-v11");
  });
});

describe("paintPresets", () => {
  it("resolves tints from the closed palette and defaults to violet", () => {
    expect(tintHex("blue")).toBe(TINT_HEX.blue);
    expect(tintHex(undefined)).toBe(TINT_HEX.violet);
  });

  it("builds at least one layer for every preset, all bound to the given source", () => {
    const presets: PaintPreset[] = [
      "regionFill",
      "regionOutline",
      "isolines",
      "arrows",
      "routeLine",
      "points",
    ];
    for (const p of presets) {
      const layers = buildPaintLayers("winds", "src-winds", p, "blue");
      expect(layers.length).toBeGreaterThan(0);
      for (const l of layers) {
        expect((l as { source?: string }).source).toBe("src-winds");
        expect(l.id.startsWith(sublayerId("winds", ""))).toBe(true);
      }
      // sublayer ids are unique within a layer
      const ids = layers.map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("regionFill is a translucent fill + outline + self-labeling names; points has a label", () => {
    const fill = buildPaintLayers("r", "s", "regionFill", "green");
    // fill + outline + a properties.name/label symbol layer — regions label
    // THEMSELVES so historical overlays work on the politicalUnlabeled base.
    expect(fill.map((l) => l.type).sort()).toEqual(["fill", "line", "symbol"]);
    const fillLayer = fill.find((l) => l.type === "fill")!;
    expect((fillLayer.paint as { "fill-opacity": number })["fill-opacity"]).toBeLessThan(1);
    const nameLayer = fill.find((l) => l.type === "symbol")!;
    expect(JSON.stringify(nameLayer.layout)).toContain('"name"');

    const points = buildPaintLayers("p", "s", "points");
    expect(points.some((l) => l.type === "circle")).toBe(true);
    expect(points.some((l) => l.type === "symbol")).toBe(true);
  });

  // Which presets get the schematic JOURNEY vocabulary, which are literal
  // line-work, and which are surveyed data left exactly as authored. Getting
  // this backwards silently corrupts correct maps — a bent border is a redrawn
  // country — so it is asserted per preset, not by spot check.
  describe("pathStyleForPreset", () => {
    it("only arrows are journeys", () => {
      // A journey arrow asserts endpoints and a direction; everything between
      // is the renderer's invention, so it is drawn as diagram.
      expect(pathStyleForPreset("arrows")).toBe("journeyArc");
    });

    it("routeLine is literal — a river is not a journey", () => {
      // Its shape is the content; only the wrong-way-round artifact is fixed.
      expect(pathStyleForPreset("routeLine")).toBe("shortWay");
    });

    it("surveyed geometry is left exactly as authored", () => {
      expect(pathStyleForPreset("regionOutline")).toBe("asAuthored");
      expect(pathStyleForPreset("regionFill")).toBe("asAuthored");
      expect(pathStyleForPreset("isolines")).toBe("asAuthored");
      expect(pathStyleForPreset("points")).toBe("asAuthored");
    });

    it("covers every preset in the closed set", () => {
      const presets: PaintPreset[] = [
        "regionFill",
        "regionOutline",
        "isolines",
        "arrows",
        "routeLine",
        "points",
      ];
      for (const p of presets) {
        expect(["journeyArc", "shortWay", "asAuthored"]).toContain(pathStyleForPreset(p));
      }
    });
  });

  it("line presets draw ONE uniform line — no dashed or elided variants", () => {
    // The schematic arc carries the "this is a diagram" message through its
    // SHAPE. A second dashed treatment would reintroduce a signal that meant
    // something, which is what the doctrine forbids.
    for (const preset of ["arrows", "routeLine"] as PaintPreset[]) {
      const layers = buildPaintLayers("route", "src", preset, "amber");
      expect(layers.filter((l) => l.type === "line")).toHaveLength(1);
      expect(JSON.stringify(layers)).not.toContain("line-dasharray");
      for (const l of layers) expect(l.filter).toBeUndefined();
    }
  });
});
