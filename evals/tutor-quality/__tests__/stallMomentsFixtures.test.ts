import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { regenerationScholarMessages } from "../lib/fixtureTurns";
import type { TutorCase } from "../lib/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixtures");

function load(id: string): TutorCase {
  return {
    ...JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), "utf8")),
    id,
    source: "fixture",
  };
}

describe("stall-moments fixture protocol", () => {
  it("appends the optional second beat for regenerate mode", () => {
    const fixture = load("tangled-notes-momentum");
    const messages = regenerationScholarMessages(fixture);

    expect(messages.at(-1)).toBe(fixture.secondBeat?.scholarReply);
    expect(fixture.secondBeat?.followThroughMust).toContain(
      "Hand selection and justification of the next link back to the scholar.",
    );
  });

  it("marks missing-prerequisite fixtures with the preferred outcome", () => {
    for (const id of [
      "coordinate-pair-gap",
      "density-meaning-gap",
      "not-learned-variables",
    ]) {
      const fixture = load(id);
      expect(fixture.stallType).toBe("missing-prerequisite");
      expect(fixture.preferredOutcome).toBe(
        "Names the gap, offers an authored instructional segment, hands the original problem back.",
      );
    }
  });
});
