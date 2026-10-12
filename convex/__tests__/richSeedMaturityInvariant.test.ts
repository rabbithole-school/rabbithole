import { describe, expect, it } from "vitest";
import { units } from "../seed/rich/curriculum";
import { variants } from "../seed/rich/sims";
import { REHEARSE_PASS_FITNESS } from "../lib/unitMaturity";

/**
 * Fraction Sense is the rich seed's one intentionally DEBRIEFED unit — the
 * fixture that demonstrates a fully matured maturity rail. `computeUnitMaturity`
 * clears the Rehearsed rung only when EVERY online activity in the unit has a
 * passing rehearsal variant, so adding one un-rehearsed online activity
 * anywhere in the unit silently drops it to `assigned` and quietly guts the
 * fixture. That is not hypothetical: it happened while adding a photo
 * deliverable fixture, and only an adversarial review caught it — no test did.
 *
 * This guards the invariant the seed already states in prose
 * (`sims.ts`: "A passing variant here is what lets the unit clear the
 * Rehearsed rung (every online activity must pass)").
 */
describe("rich seed — Fraction Sense stays a debriefed exemplar", () => {
  it("every online activity in u.fractions has a passing rehearsal variant", () => {
    const fractions = units.find((unit) => unit.key === "u.fractions");
    expect(fractions, "u.fractions missing from the rich seed").toBeDefined();

    const onlineKeys = (fractions!.lessons ?? [])
      .flatMap((lesson) => lesson.activities ?? [])
      .filter((activity) => activity.kind === "online")
      .map((activity) => activity.key);
    expect(onlineKeys.length).toBeGreaterThan(0);

    const passingKeys = new Set(
      variants
        .filter((variant) => {
          const fitness = (
            variant.aggregateScores as { fitness?: number } | undefined
          )?.fitness;
          return typeof fitness === "number" && fitness >= REHEARSE_PASS_FITNESS;
        })
        .map((variant) => variant.activityKey),
    );

    const unrehearsed = onlineKeys.filter((key) => !passingKeys.has(key));
    expect(
      unrehearsed,
      `these online activities have no passing variant, so u.fractions drops ` +
        `out of debriefed (${passingKeys.size} passing of ${onlineKeys.length} ` +
        `online). Either give them one, or put the activity in a unit that ` +
        `makes no maturity claim.`,
    ).toEqual([]);
  });
});
