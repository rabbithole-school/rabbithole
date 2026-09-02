import { describe, expect, it } from "vitest";

import type { EvidencePlan } from "../catalog";
import { effectiveEvidencePlan } from "../catalog";
import type { GameActor, GameEvent, GameEventPayload } from "../contract";
import { buildGameSessionDigest } from "../digest";

const PLAN: EvidencePlan = {
  phase: { label: "Phase", tutorRole: "ignore" },
  guess: { label: "Guessed a half", tutorRole: "prediction" },
  feedback: { label: "Saw the signal", tutorRole: "contrast" },
  revise: { label: "Changed their mind", tutorRole: "turning-point" },
  tap: { label: "Probed a tile", tutorRole: "context" },
  strategy: { label: "Approach", tutorRole: "strategy" },
  rule: { label: "Local rule", tutorRole: "ignore" },
  said: { label: "Explained", tutorRole: "context" },
  done: { label: "Round over", tutorRole: "ignore" },
  "host.help": { label: "Asked for help", tutorRole: "context" },
};

let seq = 0;
function ev(
  eventKey: string,
  payload: GameEventPayload,
  atActiveMs: number,
  actor?: GameActor,
): GameEvent {
  seq += 1;
  return {
    eventKey,
    payload,
    atActiveMs,
    seq,
    receivedAt: 1_700_000_000_000 + seq,
    ...(actor ? { actor } : {}),
  };
}

function build(events: GameEvent[], totalActiveMs = 10_000, plan: EvidencePlan = PLAN) {
  return buildGameSessionDigest({
    gameId: "toy-warmer-colder",
    gameVersion: 1,
    totalActiveMs,
    events,
    plan,
  });
}

describe("buildGameSessionDigest", () => {
  it("is empty but well-formed for a session with no events", () => {
    const digest = build([], 0);
    expect(digest.eventCount).toBe(0);
    expect(digest.phases).toEqual([]);
    expect(digest.outcomeClaim).toBeNull();
  });

  it("never lets a host lifecycle marker open a phase", () => {
    // Regression, found on device, and the reason resume was later dropped
    // entirely: `host.resumed` carried a `phase_changed` payload, so it opened
    // a phase of its own — burying the game's real phases (a round reopened 8
    // times showed 8 "resumed" phases) and stealing their time (`revise`
    // reported 21s of a 103s stretch). Resume is gone, so this input can no
    // longer be produced; the guard stays so re-introducing a host phase
    // marker degrades to a dropped event rather than to corrupted timings.
    seq = 0;
    const digest = build(
      [
        ev("phase", { kind: "phase_changed", phase: "revise" }, 1_000),
        ev("host.whatever", { kind: "phase_changed", phase: "resumed" }, 3_000),
        ev("phase", { kind: "phase_changed", phase: "done" }, 9_000),
      ],
      10_000,
    );

    expect(digest.phases).toEqual([
      // `revise` keeps the whole 8s it was actually open for.
      { phase: "revise", enteredAtActiveMs: 1_000, durationMs: 8_000 },
      { phase: "done", enteredAtActiveMs: 9_000, durationMs: 1_000 },
    ]);
  });

  it("never attributes an opponent's move to the scholar", () => {
    // The reason `actor` exists. A game with a bot opponent logs the bot's
    // turns through the same channel as the child's; without this split every
    // downstream reading — the digest, a teacher's review, anything a tutor is
    // later told — would present the machine's reasoning as the kid's.
    seq = 0;
    const digest = build([
      ev("said", { kind: "scholar_explained", text: "I think it's even" }, 1_000),
      ev("said", { kind: "scholar_explained", text: "computed line" }, 2_000, "opponent"),
      ev("guess", { kind: "prediction_recorded", value: "12" }, 3_000, "opponent"),
      ev("plan", { kind: "strategy_inferred", strategy: "greedy" }, 4_000, "opponent"),
      // A choice IS kept — the board the scholar faced is unreadable without
      // the moves made against them — but it is tagged with who made it.
      ev("pick", { kind: "choice_made", choice: "18" }, 5_000, "opponent"),
    ]);

    expect(digest.scholarExplanations.map((n) => n.detail)).toEqual(["I think it's even"]);
    expect(digest.predictions).toEqual([]);
    expect(digest.strategyInferences).toEqual([]);
    expect(digest.choices).toHaveLength(1);
    expect(digest.choices[0].actor).toBe("opponent");
  });

  it("computes per-phase active time, closing the last phase at session end", () => {
    seq = 0;
    const digest = build(
      [
        ev("phase", { kind: "phase_changed", phase: "predict" }, 0),
        ev("phase", { kind: "phase_changed", phase: "probe" }, 4_000),
        ev("phase", { kind: "phase_changed", phase: "commit" }, 7_500),
      ],
      12_000,
    );
    expect(digest.phases).toEqual([
      { phase: "predict", enteredAtActiveMs: 0, durationMs: 4_000 },
      { phase: "probe", enteredAtActiveMs: 4_000, durationMs: 3_500 },
      { phase: "commit", enteredAtActiveMs: 7_500, durationMs: 4_500 },
    ]);
  });

  it("pairs an explicitly linked observation with its prediction", () => {
    seq = 0;
    const prediction = ev("guess", { kind: "prediction_recorded", value: "left" }, 1_000);
    const observation = ev(
      "feedback",
      { kind: "observation_recorded", value: "colder", predictsSeq: prediction.seq },
      3_000,
    );
    const digest = build([prediction, observation]);
    expect(digest.predictions).toHaveLength(1);
    expect(digest.predictions[0].outcome?.value).toBe("colder");
  });

  it("pairs chronologically when the game does not say", () => {
    seq = 0;
    const digest = build([
      ev("guess", { kind: "prediction_recorded", value: "left" }, 1_000),
      ev("guess", { kind: "prediction_recorded", value: "right" }, 2_000),
      ev("feedback", { kind: "observation_recorded", value: "colder" }, 3_000),
      ev("feedback", { kind: "observation_recorded", value: "warmer" }, 4_000),
    ]);
    expect(digest.predictions.map((p) => [p.value, p.outcome?.value])).toEqual([
      ["left", "colder"],
      ["right", "warmer"],
    ]);
  });

  it("never pairs an observation that came before the prediction", () => {
    seq = 0;
    const digest = build([
      ev("feedback", { kind: "observation_recorded", value: "warmer" }, 500),
      ev("guess", { kind: "prediction_recorded", value: "left" }, 1_000),
    ]);
    expect(digest.predictions[0].outcome).toBeUndefined();
  });

  it("prefers an explicit link over the chronological fallback", () => {
    seq = 0;
    const first = ev("guess", { kind: "prediction_recorded", value: "left" }, 1_000);
    const second = ev("guess", { kind: "prediction_recorded", value: "right" }, 2_000);
    const linked = ev(
      "feedback",
      { kind: "observation_recorded", value: "linked", predictsSeq: second.seq },
      3_000,
    );
    const loose = ev("feedback", { kind: "observation_recorded", value: "loose" }, 4_000);
    const digest = build([first, second, linked, loose]);
    expect(digest.predictions.find((p) => p.value === "right")?.outcome?.value).toBe("linked");
    expect(digest.predictions.find((p) => p.value === "left")?.outcome?.value).toBe("loose");
  });

  it("resolves a revision's trigger event", () => {
    seq = 0;
    const feedback = ev("feedback", { kind: "observation_recorded", value: "colder" }, 2_000);
    const revision = ev(
      "revise",
      { kind: "model_revised", before: "left", after: "right", triggeredBySeq: feedback.seq },
      2_500,
    );
    const digest = build([feedback, revision]);
    expect(digest.revisions[0].triggeredBy).toEqual({
      seq: feedback.seq,
      label: "Saw the signal",
      summary: "colder",
    });
  });

  it("drops a dangling trigger reference instead of throwing", () => {
    seq = 0;
    const digest = build([
      ev("revise", { kind: "model_revised", before: "a", after: "b", triggeredBySeq: 999 }, 1_000),
    ]);
    expect(digest.revisions).toHaveLength(1);
    expect(digest.revisions[0].triggeredBy).toBeUndefined();
  });

  it("honours tutorRole ignore for narration, but still computes structure", () => {
    seq = 0;
    const digest = build([
      ev("rule", { kind: "local_rule_result", passed: true, detail: "adjacent" }, 1_000),
      ev("phase", { kind: "phase_changed", phase: "probe" }, 1_100),
      ev("done", { kind: "outcome_claimed", outcomeKey: "found" }, 5_000),
    ]);
    // filed as `ignore` → excluded from the narrative lists…
    expect(digest.localRuleResults).toEqual([]);
    // …but phases and the outcome claim are the frame, so they always compute.
    expect(digest.phases).toHaveLength(1);
    expect(digest.outcomeClaim?.outcomeKey).toBe("found");
  });

  it("records the outcome as a CLAIM with no verdict anywhere in the digest", () => {
    seq = 0;
    const digest = build([ev("done", { kind: "outcome_claimed", outcomeKey: "missed" }, 9_000)]);
    expect(digest.outcomeClaim).toEqual({ seq: 1, atActiveMs: 9_000, outcomeKey: "missed" });
    const serialized = JSON.stringify(digest);
    for (const forbidden of ["score", "mastery", "correct", "passed", "grade", "streak"]) {
      expect(serialized).not.toContain(`"${forbidden}"`);
    }
  });

  it("labels an unplanned eventKey with the raw key rather than dropping the event", () => {
    seq = 0;
    const digest = build([ev("mystery", { kind: "choice_made", choice: "7" }, 1_000)]);
    expect(digest.choices).toEqual([
      {
        seq: 1,
        atActiveMs: 1_000,
        label: "mystery",
        detail: "7",
        tutorRole: "context",
        concept: undefined,
        actor: "scholar",
      },
    ]);
  });

  it("surfaces a host-emitted help request", () => {
    seq = 0;
    const digest = build([ev("host.help", { kind: "help_requested" }, 3_300)]);
    expect(digest.helpRequests).toHaveLength(1);
    expect(digest.helpRequests[0].detail).toBe("asked for help");
  });

  it("is deterministic and order-independent (the server re-derives, always)", () => {
    seq = 0;
    const events = [
      ev("guess", { kind: "prediction_recorded", value: "left" }, 1_000),
      ev("feedback", { kind: "observation_recorded", value: "warmer" }, 2_000),
      ev("done", { kind: "outcome_claimed", outcomeKey: "found" }, 3_000),
    ];
    const inOrder = build(events);
    const shuffled = build([events[2], events[0], events[1]]);
    expect(shuffled).toEqual(inOrder);
    expect(build(events)).toEqual(inOrder);
  });

  it("works against the real catalog plan", () => {
    seq = 0;
    const plan = effectiveEvidencePlan("toy-warmer-colder")!;
    const digest = build(
      [
        ev("phase", { kind: "phase_changed", phase: "predict" }, 0),
        ev("guess_half", { kind: "prediction_recorded", value: "left" }, 900),
        ev("first_tap", { kind: "choice_made", choice: "2", among: ["0", "1", "2", "3"] }, 1_800),
        ev("feedback_shown", { kind: "observation_recorded", value: "colder" }, 2_100),
        ev("half_revised", { kind: "model_revised", before: "left", after: "right" }, 2_600),
        ev("second_tap", { kind: "choice_made", choice: "6" }, 3_400),
        ev("round_ended", { kind: "outcome_claimed", outcomeKey: "found" }, 3_600),
      ],
      4_000,
      plan,
    );
    expect(digest.predictions[0].outcome?.value).toBe("colder");
    expect(digest.revisions[0].after).toBe("right");
    expect(digest.choices.map((c) => c.detail)).toEqual(["2 (of 4)", "6"]);
    expect(digest.outcomeClaim?.outcomeKey).toBe("found");
  });
});
