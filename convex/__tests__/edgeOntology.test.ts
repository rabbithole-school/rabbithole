import { describe, expect, test } from "vitest";
import {
  ASSOCIATIVE_KINDS,
  DEPENDENCY_KINDS,
  INFERENCE_KINDS,
  isDurableEdge,
  methodOf,
  relationOf,
} from "../../shared/edgeOntology";

describe("edgeOntology", () => {
  test("classifies every kind written by backend edge writers", () => {
    const writerKinds = [
      "buildsOn",
      "buildsTowards",
      "requires",
      "bridge",
      "explicit",
      "nn",
      "implies",
    ];
    expect(
      new Set([...DEPENDENCY_KINDS, ...ASSOCIATIVE_KINDS, ...INFERENCE_KINDS]),
    ).toEqual(new Set(writerKinds));
    expect(writerKinds.map((kind) => relationOf(kind))).toEqual([
      "dependency",
      "dependency",
      "dependency",
      "bridge",
      "bridge",
      "bridge",
      // inference-only, but directional → renders as a dependency
      "dependency",
    ]);
  });

  test("throws on unknown edge kinds", () => {
    expect(() => relationOf("bogus")).toThrow(/Unknown knowledge edge kind/);
    expect(() => methodOf({ kind: "bogus" })).toThrow(/Unknown knowledge edge kind/);
  });

  test("defaults legacy methods by kind", () => {
    expect(methodOf({ kind: "buildsOn" })).toBe("curated");
    expect(methodOf({ kind: "buildsTowards" })).toBe("curated");
    expect(methodOf({ kind: "requires" })).toBe("curated");
    expect(methodOf({ kind: "bridge" })).toBe("embedding");
    expect(methodOf({ kind: "explicit" })).toBe("observed");
    expect(methodOf({ kind: "nn" })).toBe("nn");
    expect(methodOf({ kind: "nn", method: "generated" })).toBe("generated");
    expect(methodOf({ kind: "implies" })).toBe("curated");
  });

  test("durable edge truth table", () => {
    expect(isDurableEdge({ method: "curated" })).toBe(true);
    expect(isDurableEdge({ method: "generated" })).toBe(true);
    expect(isDurableEdge({ method: "embedding", story: { hook: "x" } })).toBe(true);
    expect(isDurableEdge({ method: "embedding" })).toBe(false);
    expect(isDurableEdge({ method: "nn" })).toBe(false);
    expect(isDurableEdge({ method: "observed" })).toBe(false);
    expect(isDurableEdge({})).toBe(false);
  });
});
