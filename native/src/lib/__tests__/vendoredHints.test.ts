import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hintForSkill } from "../../../vendor/shared/mathPracticeHints";

// The "Stuck? Hint" text MUST be identical on web and iPad — it's the same
// middle help step in the same help ladder, and a scholar who sees one wording
// on a laptop and another on the iPad is being taught two different strategies.
//
// Native can't import repo-root lib/ directly (metro never crawls outside the
// project root), so it consumes a vendored copy refreshed by
// `npm run sync:vendor`. Nothing forces that refresh, so this pins the copy to
// its source: if lib/mathPracticeHints.ts changes and the vendor copy isn't
// re-synced, this fails instead of the two surfaces quietly drifting apart.
const repoRoot = path.resolve(__dirname, "../../../..");

describe("vendored math practice hints", () => {
  it("is byte-identical to the lib/ source web and convex use", () => {
    const source = readFileSync(path.join(repoRoot, "lib/mathPracticeHints.ts"), "utf8");
    const vendored = readFileSync(
      path.join(repoRoot, "native/vendor/shared/mathPracticeHints.ts"),
      "utf8",
    );
    expect(vendored).toBe(source);
  });

  it("returns a strategy nudge for a fraction skill", () => {
    const hint = hintForSkill("add_subtract_unlike");
    expect(hint).toBeTruthy();
    // A hint must never hand over an answer — it points at the METHOD.
    expect(hint.toLowerCase()).toContain("denominator");
  });

  it("falls back to a general nudge for an unknown skill key", () => {
    expect(hintForSkill("not_a_real_skill_key_xyz")).toBeTruthy();
  });
});
