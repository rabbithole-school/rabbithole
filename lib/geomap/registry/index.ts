/**
 * The GeoMap dataset registry — every overlay/region dataset a spec may
 * reference by key. THE governance surface (plan §4): all data is checked in,
 * reviewable, and carries source + license + accuracy notes. A spec referencing
 * a key not in here fails validation; nothing streams from an author-supplied
 * URL, ever.
 *
 * Adding a dataset = add a file under data/ exporting a RegistryEntry, then
 * register it in ENTRIES below. Keep individual datasets deliberately
 * simplified (these are pedagogy maps, not survey products) and say so in
 * `notes`.
 */
import type { GeoJsonFeatureCollection } from "../types";

export interface RegistryEntry {
  /** Stable key specs reference (for example, an overlay id). */
  id: string;
  /** Kid-facing default label (specs may override per-layer). */
  label: string;
  /**
   * overlay — renderable layer data; region — polygonal data usable as a
   * `region` GeoTask target (must be Polygon/MultiPolygon features).
   */
  kind: "overlay" | "region";
  /** Where the data came from (hand-authored, derived-from-X, …). */
  source: string;
  /** License of the underlying data ("original work" for hand-authored). */
  license: string;
  /** Accuracy/simplification honesty — shown in teacher-facing catalogs. */
  notes: string;
  data: GeoJsonFeatureCollection;
}

import { oahuWindPatterns } from "./data/oahuWindPatterns";
import { oahuRainfall } from "./data/oahu-rainfall";
import { europe1914 } from "./data/europe-1914";
import { ww1BlocsEntente } from "./data/ww1-blocs-entente";
import { ww1BlocsAlliance } from "./data/ww1-blocs-alliance";
import { europeToday } from "./data/europe-today";
import { regionUsa } from "./data/region-usa";
import { europe1938 } from "./data/europe-1938";
import { europe1815 } from "./data/europe-1815";
import { mediterranean200 } from "./data/mediterranean-200";
import { pacific1880 } from "./data/pacific-1880";
import { northAmerica1783 } from "./data/north-america-1783";
import { oahuMoku } from "./data/oahu-moku";
import { oahuAhupuaa } from "./data/oahu-ahupuaa";

/** The registry. Order is presentation order in any teacher-facing catalog. */
const ENTRIES: RegistryEntry[] = [
  oahuWindPatterns,
  oahuRainfall,
  europe1914,
  ww1BlocsEntente,
  ww1BlocsAlliance,
  europeToday,
  regionUsa,
  europe1938,
  europe1815,
  mediterranean200,
  pacific1880,
  northAmerica1783,
  oahuMoku,
  oahuAhupuaa,
];

const byId = new Map(ENTRIES.map((e) => [e.id, e]));

if (byId.size !== ENTRIES.length) {
  // Duplicate keys are an authoring error — fail at module load, like the
  // practice graph's global nodeKey uniqueness check.
  throw new Error("geomap registry: duplicate entry id");
}

/** The key set validateSpec checks membership against. */
export function registryKeys(): ReadonlySet<string> {
  return new Set(byId.keys());
}

export function resolveRegistryEntry(id: string): RegistryEntry | undefined {
  return byId.get(id);
}

/** RegionResolver for grade.ts (region tasks only resolve `kind: "region"`). */
export function resolveRegion(id: string): GeoJsonFeatureCollection | undefined {
  const e = byId.get(id);
  return e?.kind === "region" ? e.data : undefined;
}

export function listRegistryEntries(): ReadonlyArray<RegistryEntry> {
  return ENTRIES;
}
