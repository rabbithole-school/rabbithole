import { describe, expect, test } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { makeListGeomapAssetsTool } from "../geomapAssetsTool";
import { assembleCurriculumTools } from "../aideTools";
import { assembleUnitDesignerTools } from "../unitDesignerTools";
import { ROLES } from "../roles";
import { listRegistryEntries } from "../../../lib/geomap/registry";
import { HISTORICAL_BASEMAPS } from "../../../lib/geomap/historicalBasemaps";

/**
 * `list_geomap_assets` is the STAFF-facing map-asset catalog (Curriculum Bot /
 * teacher aide / Slack bot). It's a pure read of the checked-in registry +
 * historical basemaps — no ctx, no scholar data — so we call its run() directly
 * to assert it surfaces every curated key WITH provenance, and assemble the two
 * staff toolsets to prove it lands on the intended surfaces (and never on
 * base operations staff, matching the other curriculum-read tools).
 */

const emit = () => {};

type GeomapResult = {
  datasets: Array<{
    id: string;
    label: string;
    kind: "overlay" | "region";
    source: string;
    license: string;
    notes: string;
  }>;
  eras: Array<{ key: string; label: string }>;
  usage: string;
};

async function runTool(input: { kind?: "overlay" | "region" } = {}) {
  const tool = await makeListGeomapAssetsTool(emit);
  const raw = await (
    tool as unknown as {
      run: (i: { kind?: "overlay" | "region" }) => Promise<string>;
    }
  ).run(input);
  return JSON.parse(raw) as GeomapResult;
}

describe("list_geomap_assets — result", () => {
  test("returns every registry dataset id (with kind + label)", async () => {
    const out = await runTool();
    const expected = listRegistryEntries().map((e) => e.id).sort();
    expect(out.datasets.map((d) => d.id).sort()).toEqual(expected);
    for (const e of listRegistryEntries()) {
      const row = out.datasets.find((d) => d.id === e.id)!;
      expect(row.label).toBe(e.label);
      expect(row.kind).toBe(e.kind);
    }
  });

  test("returns every historical era key (with label)", async () => {
    const out = await runTool();
    const expected = Object.keys(HISTORICAL_BASEMAPS).sort();
    expect(out.eras.map((e) => e.key).sort()).toEqual(expected);
    for (const [key, b] of Object.entries(HISTORICAL_BASEMAPS)) {
      expect(out.eras.find((e) => e.key === key)!.label).toBe(b.label);
    }
  });

  test("surfaces provenance fields (source, license, notes) for every dataset", async () => {
    const out = await runTool();
    expect(out.datasets.length).toBeGreaterThan(0);
    for (const d of out.datasets) {
      expect(typeof d.source).toBe("string");
      expect(d.source.length).toBeGreaterThan(0);
      expect(typeof d.license).toBe("string");
      expect(d.license.length).toBeGreaterThan(0);
      expect(typeof d.notes).toBe("string");
      expect(d.notes.length).toBeGreaterThan(0);
    }
  });

  test("includes one-line usage guidance naming show_map / layers / historicalBasemap", async () => {
    const out = await runTool();
    expect(out.usage).toContain("show_map");
    expect(out.usage).toContain("layers");
    expect(out.usage).toContain("historicalBasemap");
  });

  test("optional kind filter narrows datasets but keeps eras", async () => {
    const overlays = await runTool({ kind: "overlay" });
    expect(overlays.datasets.length).toBeGreaterThan(0);
    expect(overlays.datasets.every((d) => d.kind === "overlay")).toBe(true);

    const regions = await runTool({ kind: "region" });
    expect(regions.datasets.every((d) => d.kind === "region")).toBe(true);

    // Eras are a separate axis — always present regardless of the kind filter.
    expect(overlays.eras.map((e) => e.key).sort()).toEqual(
      Object.keys(HISTORICAL_BASEMAPS).sort(),
    );
  });
});

describe("list_geomap_assets — surface assembly", () => {
  const ctx = {
    runQuery: async () => false,
  } as unknown as ActionCtx;
  const caller = "u_caller" as Id<"users">;

  const aideNames = async (
    role: Parameters<typeof assembleCurriculumTools>[2]["role"],
  ) =>
    (
      await assembleCurriculumTools(ctx, emit, { role, callerUserId: caller })
    ).map((t) => t.name);

  const designerNames = async (
    role: Parameters<typeof assembleUnitDesignerTools>[2]["role"],
  ) =>
    (
      await assembleUnitDesignerTools(ctx, emit, {
        teacherId: caller,
        unitId: "unit_1" as Id<"units">,
        role,
      })
    ).map((t) => t.name);

  test("teacher aide gets it", async () => {
    expect(await aideNames(ROLES.TEACHER)).toContain("list_geomap_assets");
  });

  test("curriculum_designer gets it (scholar-agnostic curriculum design)", async () => {
    expect(await aideNames(ROLES.CURRICULUM_DESIGNER)).toContain(
      "list_geomap_assets",
    );
  });

  test("base operations staff does NOT get it (matches the other curriculum-read tools)", async () => {
    expect(await aideNames(ROLES.STAFF)).not.toContain(
      "list_geomap_assets",
    );
  });

  test("Curriculum Bot (unit designer) gets it", async () => {
    expect(await designerNames(ROLES.TEACHER)).toContain("list_geomap_assets");
    expect(await designerNames(ROLES.CURRICULUM_DESIGNER)).toContain(
      "list_geomap_assets",
    );
  });
});
