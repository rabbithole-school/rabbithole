/**
 * Structural validation of the generated GeoMap registry data.
 *
 * WHY THIS EXISTS: the generated datasets in `registry/data/*.ts` hold their
 * geometry as `JSON.parse("…")` rather than a TypeScript array literal. That is
 * identical at runtime, but it makes the `: Feature[]` annotation an assertion
 * instead of a check — tsc no longer validates the data's shape (which is the
 * whole point: typechecking millions of coordinate literals cost ~80s of CI on
 * every run). These tests restore that guarantee at runtime, so a malformed
 * regeneration still fails the merge gate.
 *
 * Validation walks ~1.5M coordinates, so it collects problems into an array and
 * asserts once at the end rather than calling `expect()` per coordinate. Doing
 * this the naive way built ~1.5M chai assertion objects, which was slow enough
 * to blow the default 5s timeout under full-suite parallelism. The by-product
 * is better diagnostics: a bad regeneration reports every fault, not just the
 * first one.
 */
import { describe, expect, test } from "vitest";
import { listRegistryEntries, registryKeys, resolveRegion } from "../registry";

/** Cap the report so one systemically broken dataset can't emit 1.5M lines. */
const MAX_REPORTED = 20;

class Faults {
  readonly all: string[] = [];
  private truncated = false;

  add(where: string, message: string) {
    if (this.all.length >= MAX_REPORTED) {
      this.truncated = true;
      return;
    }
    this.all.push(`${where}: ${message}`);
  }

  get report(): string[] {
    return this.truncated ? [...this.all, `…and more (capped at ${MAX_REPORTED})`] : this.all;
  }
}

function checkPosition(pos: unknown, where: string, faults: Faults) {
  if (!Array.isArray(pos) || pos.length < 2) {
    faults.add(where, "position must be an array of [lng, lat]");
    return;
  }
  const [lng, lat] = pos as unknown[];
  if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    faults.add(where, `lng ${String(lng)} is not a finite number within [-180, 180]`);
  }
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    faults.add(where, `lat ${String(lat)} is not a finite number within [-90, 90]`);
  }
}

function checkLine(coords: unknown, where: string, faults: Faults) {
  if (!Array.isArray(coords)) {
    faults.add(where, "coordinates must be an array of positions");
    return;
  }
  coords.forEach((pos, i) => checkPosition(pos, `${where}[${i}]`, faults));
}

function checkRings(rings: unknown, where: string, faults: Faults) {
  if (!Array.isArray(rings)) {
    faults.add(where, "coordinates must be an array of linear rings");
    return;
  }
  rings.forEach((ring, i) => {
    const rw = `${where}[${i}]`;
    if (!Array.isArray(ring)) {
      faults.add(rw, "ring must be an array");
      return;
    }
    // A closed linear ring needs >= 4 positions, first === last.
    if (ring.length < 4) {
      faults.add(rw, `ring has ${ring.length} positions, needs >= 4`);
    }
    checkLine(ring, rw, faults);
    const first = ring[0] as number[] | undefined;
    const last = ring[ring.length - 1] as number[] | undefined;
    if (!first || !last || first[0] !== last[0] || first[1] !== last[1]) {
      faults.add(rw, "ring is not closed (first position must equal last)");
    }
  });
}

function checkGeometry(geometry: unknown, where: string, faults: Faults) {
  if (!geometry || typeof geometry !== "object") {
    faults.add(where, "geometry must be an object");
    return;
  }
  const g = geometry as { type?: unknown; coordinates?: unknown };
  switch (g.type) {
    case "Point":
      checkPosition(g.coordinates, `${where} Point`, faults);
      break;
    case "MultiPoint":
    case "LineString":
      checkLine(g.coordinates, `${where} ${g.type}`, faults);
      break;
    case "MultiLineString":
      if (!Array.isArray(g.coordinates)) {
        faults.add(where, "MultiLineString coordinates must be an array");
        break;
      }
      g.coordinates.forEach((line, i) =>
        checkLine(line, `${where} MultiLineString[${i}]`, faults),
      );
      break;
    case "Polygon":
      checkRings(g.coordinates, `${where} Polygon`, faults);
      break;
    case "MultiPolygon":
      if (!Array.isArray(g.coordinates)) {
        faults.add(where, "MultiPolygon coordinates must be an array");
        break;
      }
      g.coordinates.forEach((poly, i) =>
        checkRings(poly, `${where} MultiPolygon[${i}]`, faults),
      );
      break;
    default:
      faults.add(where, `unexpected geometry type ${JSON.stringify(g.type)}`);
  }
}

describe("generated registry data survives the JSON.parse round trip", () => {
  test("every entry exposes a well-formed FeatureCollection", () => {
    const entries = listRegistryEntries();
    expect(entries.length, "registry should not be empty").toBeGreaterThan(0);

    const faults = new Faults();
    for (const entry of entries) {
      const where = `entry ${JSON.stringify(entry.id)}`;
      if (typeof entry.id !== "string" || entry.id.length === 0) {
        faults.add(where, "id must be a non-empty string");
      }
      if (typeof entry.label !== "string" || entry.label.length === 0) {
        faults.add(where, "label must be a non-empty string");
      }
      if (entry.data?.type !== "FeatureCollection") {
        faults.add(where, `data.type is ${JSON.stringify(entry.data?.type)}, expected "FeatureCollection"`);
        continue;
      }
      if (!Array.isArray(entry.data.features) || entry.data.features.length === 0) {
        faults.add(where, "data.features must be a non-empty array");
        continue;
      }
      entry.data.features.forEach((f, i) => {
        const fw = `${where} feature[${i}]`;
        if (f?.type !== "Feature") {
          faults.add(fw, `type is ${JSON.stringify(f?.type)}, expected "Feature"`);
        }
        if (
          f?.properties === null ||
          Array.isArray(f?.properties) ||
          typeof f?.properties !== "object"
        ) {
          faults.add(fw, "properties must be a non-null object");
        }
        checkGeometry(f?.geometry, fw, faults);
      });
    }

    expect(faults.report).toEqual([]);
  });

  test("every region key resolves to the collection the registry advertises", () => {
    const entries = listRegistryEntries();
    const faults = new Faults();

    for (const key of registryKeys()) {
      const entry = entries.find((e) => e.id === key);
      if (!entry) {
        faults.add(`key ${JSON.stringify(key)}`, "advertised by registryKeys() but has no entry");
        continue;
      }
      if (entry.kind !== "region") continue;
      if (resolveRegion(key) !== entry.data) {
        faults.add(`region ${JSON.stringify(key)}`, "resolveRegion() did not return the entry's own data");
      }
    }

    expect(faults.report).toEqual([]);
  });
});
