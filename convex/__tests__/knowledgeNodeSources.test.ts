import { describe, expect, test } from "vitest";
import {
  isSkySource,
  isTreeSource,
  isWorldSource,
} from "../../shared/knowledgeNodeSources";

describe("knowledge-node source classification", () => {
  test("lane predicates remain disjoint", () => {
    expect(isSkySource("mastery")).toBe(true);
    expect(isTreeSource("practice")).toBe(true);
    expect(isWorldSource("world")).toBe(true);
    expect(isSkySource("world")).toBe(false);
    expect(isTreeSource("world")).toBe(false);
  });
});
