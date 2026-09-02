import { describe, expect, test } from "vitest";
import type { Id } from "./_generated/dataModel";
import {
  buildBakeInstruction,
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
    expect(instruction).toContain(
      "room volume relative to sound absorption",
    );
    expect(instruction).toContain("earned payoff, not the opening move");
    expect(instruction).toContain("phone voice recorder");
    expect(instruction).toContain("controlled blanket before-and-after result");
    expect(instruction).toContain(
      'auto deliverable with kind:"artifact"',
    );
    expect(instruction).toContain(
      "rank repeated recordings from longest to shortest",
    );
    expect(instruction).toContain(
      "never force a size pattern the evidence does not show",
    );
    expect(instruction).toContain(
      "Do not add an explainer video, slides, or another medium merely to look multimodal.",
    );
    expect(instruction).toContain(
      "Private steering — calibrate to it, don't read it back to the scholar.",
    );
    expect(instruction).toContain(
      "created in the exact learner-facing sequence they should appear",
    );
    expect(instruction).toContain(
      "[bake-stage:commit]",
    );
    expect(instruction).toContain(
      "runtime will also normalize this order from the private markers",
    );
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
  });
});
