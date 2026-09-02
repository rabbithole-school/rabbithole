import { describe, expect, test } from "vitest";
import {
  ATLAS_SOURCES,
  isAtlasSource,
  isSkySource,
  isTreeSource,
  isWorldSource,
} from "../../shared/knowledgeNodeSources";

describe("knowledge-node source classification", () => {
  test("atlas includes sky, tree, and world sources", () => {
    expect(ATLAS_SOURCES).toEqual([
      "standard",
      "seed",
      "mastery",
      "practice",
      "curated",
      "world",
    ]);
    for (const source of ATLAS_SOURCES) {
      expect(isAtlasSource(source)).toBe(true);
    }
    expect(isAtlasSource("unknown")).toBe(false);
  });

  test("lane predicates remain disjoint", () => {
    expect(isSkySource("mastery")).toBe(true);
    expect(isTreeSource("practice")).toBe(true);
    expect(isWorldSource("world")).toBe(true);
    expect(isSkySource("world")).toBe(false);
    expect(isTreeSource("world")).toBe(false);
  });
});
