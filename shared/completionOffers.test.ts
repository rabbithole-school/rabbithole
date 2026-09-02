import { describe, expect, it } from "vitest";
import {
  resolveCompletionOffers,
  type CompletionOfferCandidates,
} from "./completionOffers";

// A compact factory: only the fields a given test cares about are set (every
// other candidate field is left `undefined`, matching real caller behavior —
// the caller only sets a field once its own local eligibility check passes).
function candidates(
  overrides: Partial<CompletionOfferCandidates<string>> = {},
): CompletionOfferCandidates<string> {
  return { inContinuation: false, ...overrides };
}

describe("resolveCompletionOffers", () => {
  it("story-primary-once: a live story is the primary offer, alongside the ordinary alternatives", () => {
    const result = resolveCompletionOffers(
      candidates({ story: "cicada-story", tuneup: "tuneup-offer" }),
    );

    expect(result.phase).toBe("offer");
    expect(result.primary).toEqual({ kind: "story", payload: "cicada-story" });
    expect(result.alternatives).toEqual([
      { kind: "tuneup", payload: "tuneup-offer" },
    ]);
  });

  it("story-primary-once: once the caller stops passing `story` (settled), the phase drops to settled with no primary", () => {
    const withStory = resolveCompletionOffers(
      candidates({ story: "cicada-story", reprobe: "reprobe-offer" }),
    );
    expect(withStory.phase).toBe("offer");

    // The caller settles the story (reveal/save/dismiss) and re-resolves on
    // the SAME done-screen without passing `story` again.
    const afterSettle = resolveCompletionOffers(
      candidates({ reprobe: "reprobe-offer" }),
    );
    expect(afterSettle.phase).toBe("settled");
    expect(afterSettle.primary).toBeUndefined();
    expect(afterSettle.alternatives).toEqual([
      { kind: "reprobe", payload: "reprobe-offer" },
    ]);
  });

  it("bonus-run-settles-story: starting a bonus run (inContinuation) drops the story even if the caller forgot to clear it", () => {
    const beforeBonusRun = resolveCompletionOffers(
      candidates({ story: "cicada-story", challenge: "challenge-offer" }),
    );
    expect(beforeBonusRun.phase).toBe("offer");
    expect(beforeBonusRun.primary?.kind).toBe("story");

    // The scholar accepts the challenge offer — a bonus run starts. Even a
    // caller that (mistakenly) still passes the stale `story` candidate must
    // NOT see it resurface: the continuation branch drops it unconditionally.
    const duringBonusRun = resolveCompletionOffers({
      inContinuation: true,
      story: "cicada-story",
      challenge: "challenge-offer",
    });
    expect(duringBonusRun).toEqual({ phase: "active", alternatives: [] });
  });

  it("continuation-never-interrupted: an in-progress continuation suppresses every candidate, regardless of what else is eligible", () => {
    const result = resolveCompletionOffers({
      inContinuation: true,
      story: "cicada-story",
      reprobe: "reprobe-offer",
      tuneup: "tuneup-offer",
      challenge: "challenge-offer",
      moreOfPick: "more-offer",
    });

    expect(result).toEqual({ phase: "active", alternatives: [] });
  });

  it("ordering-stability: alternatives always follow reprobe > tuneup > challenge > moreOfPick, regardless of candidate-object key order", () => {
    const a = resolveCompletionOffers(
      candidates({ moreOfPick: "more", reprobe: "reprobe", challenge: "challenge" }),
    );
    const b = resolveCompletionOffers(
      candidates({ challenge: "challenge", reprobe: "reprobe", moreOfPick: "more" }),
    );

    const expected = [
      { kind: "reprobe", payload: "reprobe" },
      { kind: "challenge", payload: "challenge" },
      { kind: "moreOfPick", payload: "more" },
    ];
    expect(a.alternatives).toEqual(expected);
    expect(b.alternatives).toEqual(expected);
  });

  it("ordering-stability: all four alternatives in fixed order when all are eligible", () => {
    const result = resolveCompletionOffers(
      candidates({
        reprobe: "r",
        tuneup: "t",
        challenge: "c",
        moreOfPick: "m",
      }),
    );

    expect(result.alternatives.map((o) => o.kind)).toEqual([
      "reprobe",
      "tuneup",
      "challenge",
      "moreOfPick",
    ]);
  });

  it("settled: no story and no continuation → settled phase, no primary, ordinary alternatives", () => {
    const result = resolveCompletionOffers(candidates({ tuneup: "tuneup-offer" }));

    expect(result.phase).toBe("settled");
    expect(result.primary).toBeUndefined();
    expect(result.alternatives).toEqual([{ kind: "tuneup", payload: "tuneup-offer" }]);
  });

  it("settled: nothing eligible at all → settled phase with empty alternatives (exit is still always available to the caller)", () => {
    const result = resolveCompletionOffers(candidates());

    expect(result).toEqual({ phase: "settled", alternatives: [] });
  });

  it("stretch shares the challenge-tail slot and wins without changing the surrounding priority", () => {
    const result = resolveCompletionOffers(
      candidates({
        moreOfPick: "more",
        challenge: "challenge",
        stretch: "stretch",
        tuneup: "tuneup",
        reprobe: "reprobe",
      }),
    );

    expect(result.alternatives).toEqual([
      { kind: "reprobe", payload: "reprobe" },
      { kind: "tuneup", payload: "tuneup" },
      { kind: "stretch", payload: "stretch" },
      { kind: "moreOfPick", payload: "more" },
    ]);
  });

  it("stretch never displaces a live story primary", () => {
    const result = resolveCompletionOffers(
      candidates({
        story: "cicada-story",
        stretch: "stretch",
        challenge: "challenge",
      }),
    );

    expect(result.primary).toEqual({ kind: "story", payload: "cicada-story" });
    expect(result.alternatives).toEqual([{ kind: "stretch", payload: "stretch" }]);
  });

  it("a stretch continuation suppresses every offer candidate", () => {
    const result = resolveCompletionOffers({
      inContinuation: true,
      story: "cicada-story",
      stretch: "stretch",
      challenge: "challenge",
    });

    expect(result).toEqual({ phase: "active", alternatives: [] });
  });
});
