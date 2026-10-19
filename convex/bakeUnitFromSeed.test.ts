import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import {
  buildBakeInstruction,
  isBuildFirstPath,
  isBuildPath,
  orderLearnBeforeBuild,
  parseBakeStageMarker,
  type BakeSpec,
} from "./bakeUnitFromSeed";

function spec(topic: string): BakeSpec {
  return {
    scholarId: "scholar" as Id<"users">,
    scholarRole: "scholar",
    unitId: "unit" as Id<"units">,
    topic,
    domain: "Physics",
    rationale: "A verified invitation.",
    connectionTo: "Echoes in the school gym.",
    readingLevel: "Grade 5",
    path: null,
  };
}

describe("buildBakeInstruction", () => {
  test("injects a private derive-then-name anchor for a curated pilot topic", () => {
    const instruction = buildBakeInstruction(spec("The room that ate speech"));

    expect(instruction).toContain("Verified discovery anchor");
  });

  test("leaves uncatalogued topics on the existing generic bake path", () => {
    const instruction = buildBakeInstruction(spec("Why leaves change color"));

    expect(instruction).not.toContain("Verified discovery anchor");
    expect(instruction).toContain(
      'STAY ON THE SCHOLAR\'S ACTUAL QUESTION.',
    );
  });
});

describe("parseBakeStageMarker", () => {
  test("extracts and strips a valid private stage marker", () => {
    expect(
      parseBakeStageMarker(
        "[bake-stage:capture] Requires a real comparison table.",
      ),
    ).toEqual({
      stage: "capture",
      notes: "Requires a real comparison table.",
    });
  });

  test("rejects missing, unknown, and marker-only notes", () => {
    expect(parseBakeStageMarker("Requires a real comparison table.")).toBeNull();
    expect(parseBakeStageMarker("[bake-stage:watch] Explain a video.")).toBeNull();
    expect(parseBakeStageMarker("[bake-stage:commit]")).toBeNull();
    expect(parseBakeStageMarker("[bake-stage:build] Runs once.")?.stage).toBe("build");
  });
});

describe("build-path bake (TRA-519 B4)", () => {
  test("a build path asks for exactly 4 activities ending in an app build", () => {
    const instruction = buildBakeInstruction({
      ...spec("Why do bridges sag?"),
      path: {
        title: "Build a simulation",
        blurb: "Figure it out, then build it.",
        shape: "build",
      },
    });
    expect(instruction).toContain("EXACTLY 4 activities");
    expect(instruction).toContain('kind:"app"');
    expect(instruction).toContain("The mechanism runs once with default settings.");
    expect(instruction).toContain("NEVER for the app activity");
  });

  test("the same title without the shape is an ordinary bake", () => {
    const instruction = buildBakeInstruction({
      ...spec("Why do bridges sag?"),
      path: { title: "Build a simulation", blurb: "Figure it out, then build it." },
    });
    expect(instruction).toContain("3-4 ONLINE activities");
    expect(instruction).not.toContain('kind:"app"');
    expect(isBuildPath({ title: "Build a simulation", blurb: "x" })).toBe(false);
  });
});

describe("build-first bake", () => {
  test("a buildFirst path asks for exactly one app activity and no learning step", () => {
    const instruction = buildBakeInstruction({
      ...spec("A game called Canine rotation where a noodly dog teaches angles"),
      path: { title: "Build it", blurb: "Build the thing you described.", shape: "buildFirst" },
    });
    expect(instruction).toContain("EXACTLY ONE activity");
    expect(instruction).toContain('kind:"app"');
    expect(instruction).toContain("[bake-stage:build]");
    expect(instruction).not.toContain("STAY ON THE SCHOLAR'S ACTUAL QUESTION");
    expect(isBuildFirstPath({ title: "Build it", blurb: "x", shape: "buildFirst" })).toBe(true);
    expect(isBuildPath({ title: "Build it", blurb: "x", shape: "buildFirst" })).toBe(false);
  });
});

describe("orderLearnBeforeBuild (TRA-519 B6)", () => {
  const learn = (id: string) => ({
    _id: id,
    kind: "online",
    deliverable: { kind: "text" },
  });
  const app = (id: string) => ({
    _id: id,
    kind: "online",
    appActivity: true,
    deliverable: { kind: "artifact" },
  });
  const ids = (xs: Array<{ _id: string }>) => xs.map((x) => x._id);

  test("an app activity ahead of the first learning step moves right after it", () => {
    expect(ids(orderLearnBeforeBuild([app("a"), learn("b"), learn("c")]))).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  test("a legacy vibecode row counts as an app; relative order is kept", () => {
    const legacy = { _id: "v", kind: "vibecode" };
    expect(
      ids(orderLearnBeforeBuild([legacy, app("a"), learn("b"), learn("c")])),
    ).toEqual(["b", "v", "a", "c"]);
  });

  test("an already-valid order and a unit with no learning step are untouched", () => {
    expect(ids(orderLearnBeforeBuild([learn("a"), app("b")]))).toEqual(["a", "b"]);
    expect(ids(orderLearnBeforeBuild([app("a"), app("b")]))).toEqual(["a", "b"]);
  });
});
