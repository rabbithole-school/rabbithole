import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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

describe("rubricTelegraphing fixtures", () => {
  for (const id of ["fair-test-rubric-telegraph", "persuasive-essay-rubric-telegraph"]) {
    it(`${id} is shaped for --mode regenerate and targets rubricTelegraphing`, () => {
      const fixture = load(id);

      expect(fixture.scoringTarget).toContain("rubricTelegraphing");

      expect(fixture.anchor).not.toBeNull();
      expect(fixture.anchor?.activityTitle).toBeTruthy();

      expect(fixture.turns.length).toBeGreaterThanOrEqual(3);
      expect(fixture.turns.at(-1)?.role).toBe("user");
    });
  }
});
