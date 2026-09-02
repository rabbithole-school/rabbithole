/**
 * Lane D — geoLocate manipulative kind: dispatch, delegation, generator, and
 * the client-facing redaction. Pure-Vitest (no DOM); the pin-REPLACEMENT UI
 * lives in the React renderer, but its invariant ("one pin for a single-answer
 * task, last pin wins") is exercised here at the `isSolved` layer, which is
 * what the server actually re-runs.
 */
import { describe, expect, it } from "vitest";

import { geoLocateSolved, initialGeoLocate, isSolved, goalText, describeState } from "../logic";
import type { GeoLocateState } from "../logic";
import { gradeManipulativeSubmission, redactManipulativeSpecForClient } from "../grade";
import { isChallenge, type GeoLocateSpec, type ManipulativeSpec } from "../types";
import { makeLocateItem, GAZETTEER, getGazetteerEntry } from "../../geomap/registry/data/gazetteer";
import { haversineKm } from "../../geomap/geo";
import type { GeoJsonFeatureCollection, ScholarPin } from "../../geomap/types";

const pin = (lngLat: [number, number], id = "p"): ScholarPin => ({ id, lngLat });
const stateOf = (...pins: ScholarPin[]): GeoLocateState => ({ pins });

describe("gazetteer", () => {
  it("has ~60 targets covering capitals, DC, oceans, Honolulu, and the 8 islands", () => {
    expect(GAZETTEER.length).toBeGreaterThanOrEqual(60);
    const capitals = GAZETTEER.filter((e) => e.kind === "capital");
    expect(capitals.length).toBe(51); // 50 state capitals + Washington, DC
    expect(GAZETTEER.filter((e) => e.kind === "ocean").length).toBe(5);
    expect(GAZETTEER.filter((e) => e.kind === "island").length).toBe(8);
    expect(getGazetteerEntry("city-honolulu")?.kind).toBe("city");
  });

  it("carries honest, in-range coordinates and per-kind tolerances", () => {
    for (const e of GAZETTEER) {
      const [lng, lat] = e.lngLat;
      expect(lng).toBeGreaterThanOrEqual(-180);
      expect(lng).toBeLessThanOrEqual(180);
      expect(lat).toBeGreaterThanOrEqual(-90);
      expect(lat).toBeLessThanOrEqual(90);
      expect(e.suggestedToleranceKm).toBeGreaterThan(0);
    }
    // Sanity-anchor a couple of well-known coordinates.
    const dc = getGazetteerEntry("washington-dc")!;
    expect(haversineKm(dc.lngLat, [-77.037, 38.907])).toBeLessThan(5);
    const oahu = getGazetteerEntry("island-oahu")!;
    expect(haversineKm(oahu.lngLat, [-157.98, 21.46])).toBeLessThan(5);
    // Tolerance ladder: capitals tighter than oceans, islands tightest-ish.
    expect(getGazetteerEntry("capital-hi")!.suggestedToleranceKm).toBe(120);
    expect(getGazetteerEntry("ocean-pacific")!.suggestedToleranceKm).toBe(1500);
    expect(getGazetteerEntry("island-maui")!.suggestedToleranceKm).toBe(60);
  });

  it("makeLocateItem is deterministic and never leaks the answer into the prompt", () => {
    const a = makeLocateItem("capital-hi");
    const b = makeLocateItem("capital-hi");
    expect(a).toEqual(b);
    expect(a.kind).toBe("geoLocate");
    expect(a.map.task.kind).toBe("locate");
    // The prompt names the PLACE (the question), never coordinates.
    expect(a.map.task.prompt).toContain("Honolulu");
    expect(a.map.task.prompt).not.toMatch(/-?\d+\.\d/);
    // The task target is the real gazetteer coordinate.
    if (a.map.task.kind === "locate") {
      expect(a.map.task.target).toEqual(getGazetteerEntry("capital-hi")!.lngLat);
    }
  });

  it("makeLocateItem honors overrides and throws on an unknown id", () => {
    const item = makeLocateItem("island-oahu", { toleranceKm: 15, id: "custom-1" });
    expect(item.id).toBe("custom-1");
    if (item.map.task.kind === "locate") expect(item.map.task.toleranceKm).toBe(15);
    expect(() => makeLocateItem("nope-not-real")).toThrow(/unknown gazetteer id/);
  });
});

describe("geoLocate solved-check + dispatch", () => {
  const item = makeLocateItem("capital-hi"); // Honolulu, 120km tolerance
  const target = getGazetteerEntry("capital-hi")!.lngLat;

  it("is a challenge (always graded)", () => {
    expect(isChallenge(item)).toBe(true);
  });

  it("grades a pin within tolerance correct, one outside incorrect", () => {
    expect(geoLocateSolved(item, stateOf(pin(target)))).toBe(true);
    // ~500 km away (still Pacific, but well outside 120km): San Francisco-ish? use LA.
    expect(geoLocateSolved(item, stateOf(pin([-118.24, 34.05])))).toBe(false);
  });

  it("empty / garbage state never solves", () => {
    expect(geoLocateSolved(item, initialGeoLocate())).toBe(false);
    expect(geoLocateSolved(item, { pins: [] })).toBe(false);
    expect(geoLocateSolved(item, { pins: [{ id: "x", lngLat: [999, 999] as [number, number] }] })).toBe(
      false,
    );
  });

  it("LAST pin wins (mirrors the renderer's single-answer pin replacement)", () => {
    // A wrong pin followed by a correct one grades correct (last wins); the
    // reverse grades incorrect — the UI replaces rather than accumulates.
    expect(geoLocateSolved(item, stateOf(pin([-118.24, 34.05], "a"), pin(target, "b")))).toBe(true);
    expect(geoLocateSolved(item, stateOf(pin(target, "a"), pin([-118.24, 34.05], "b")))).toBe(false);
  });

  it("the top-level isSolved dispatches geoLocate through geoLocateSolved", () => {
    expect(isSolved(item, stateOf(pin(target)))).toBe(true);
    expect(isSolved(item as ManipulativeSpec, stateOf(pin([0, 0])))).toBe(false);
  });

  it("region tasks only green-light when a resolver is supplied", () => {
    const regionSpec: GeoLocateSpec = {
      kind: "geoLocate",
      id: "geo-region-1",
      concept: "Countries",
      prompt: "Tap inside the box.",
      map: {
        v: 1,
        id: "m",
        camera: { center: [0, 0], zoom: 2 },
        base: "political",
        task: { kind: "region", prompt: "Tap inside the box.", targetRegion: { registry: "unit-box" } },
      },
    };
    const region: GeoJsonFeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: {
            type: "Polygon",
            coordinates: [[[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]]],
          },
        },
      ],
    };
    const resolver = (key: string) => (key === "unit-box" ? region : undefined);
    const inside = stateOf(pin([0, 0]));
    const outside = stateOf(pin([5, 5]));
    // Without a resolver the region can never resolve → never solves.
    expect(geoLocateSolved(regionSpec, inside)).toBe(false);
    expect(isSolved(regionSpec, inside, resolver)).toBe(true);
    expect(isSolved(regionSpec, outside, resolver)).toBe(false);
  });

  it("goalText restates the question; describeState reports only pin count", () => {
    expect(goalText(item)).toBe(item.map.task.prompt);
    expect(describeState(item, JSON.stringify(stateOf()))).toMatch(/No pin/i);
    expect(describeState(item, JSON.stringify(stateOf(pin(target))))).toMatch(/One pin/i);
    expect(describeState(item, JSON.stringify(stateOf(pin([0, 0]), pin([1, 1]))))).toMatch(/2 pins/);
    // Never leaks the target coordinate.
    expect(describeState(item, JSON.stringify(stateOf(pin(target))))).not.toMatch(/-?15\d/);
  });
});

describe("gradeManipulativeSubmission — geoLocate end to end", () => {
  const item = makeLocateItem("island-oahu"); // 60km tolerance
  const specJson = JSON.stringify(item);
  const target = item.map.task.kind === "locate" ? item.map.task.target : [0, 0];

  it("correct pin passes, off pin fails, garbage never crashes or passes", () => {
    expect(gradeManipulativeSubmission(specJson, JSON.stringify({ pins: [pin(target as [number, number])] })).correct).toBe(
      true,
    );
    expect(gradeManipulativeSubmission(specJson, JSON.stringify({ pins: [pin([0, 0])] })).correct).toBe(false);
    expect(gradeManipulativeSubmission(specJson, "not json {").correct).toBe(false);
    expect(gradeManipulativeSubmission(specJson, JSON.stringify({ nonsense: true })).correct).toBe(false);
    expect(gradeManipulativeSubmission(null, JSON.stringify({ pins: [] })).correct).toBe(false);
  });
});

describe("redactManipulativeSpecForClient", () => {
  it("strips a geoLocate locate target but keeps the prompt + tolerance", () => {
    const item = makeLocateItem("capital-ca"); // Sacramento
    const redactedJson = redactManipulativeSpecForClient(JSON.stringify(item))!;
    const redacted = JSON.parse(redactedJson) as GeoLocateSpec;
    expect(redacted.kind).toBe("geoLocate");
    if (redacted.map.task.kind === "locate" && item.map.task.kind === "locate") {
      expect(redacted.map.task.target).toEqual([0, 0]);
      expect(redacted.map.task.target).not.toEqual(item.map.task.target);
      expect(redacted.map.task.prompt).toBe(item.map.task.prompt);
      expect(redacted.map.task.toleranceKm).toBe(item.map.task.toleranceKm);
    } else {
      throw new Error("expected locate tasks");
    }
  });

  it("leaves a non-geoLocate spec byte-for-byte unchanged, and passes null/garbage through", () => {
    const partition = JSON.stringify({
      kind: "partition",
      id: "p1",
      concept: "Halves",
      prompt: "Make one half.",
      discs: [{ parts: 4, shaded: 1 }],
      adjustable: ["parts", "shaded"],
      partsRange: [2, 12],
      goal: { type: "shadedFractionEquals", disc: 0, value: 0.5 },
    });
    expect(redactManipulativeSpecForClient(partition)).toBe(partition);
    expect(redactManipulativeSpecForClient(null)).toBeNull();
    expect(redactManipulativeSpecForClient(undefined)).toBeUndefined();
    expect(redactManipulativeSpecForClient("not json {")).toBe("not json {");
  });
});
