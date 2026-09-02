import { describe, expect, it } from "vitest";

import type { EvidencePlan } from "../catalog";
import type { GameActor, GameEvent, GameEventPayload } from "../contract";
import { buildGameSessionDigest } from "../digest";
import { renderDigestForModel } from "../promptContext";

const PLAN: EvidencePlan = {
  guess: { label: "Prediction", tutorRole: "prediction" },
  feedback: { label: "Observation", tutorRole: "contrast" },
  revise: { label: "Revision", tutorRole: "turning-point" },
  choice: { label: "Choice", tutorRole: "context" },
  strategy: { label: "Approach", tutorRole: "strategy" },
  rule: { label: "Rule result", tutorRole: "context" },
  explanation: { label: "Explanation", tutorRole: "context" },
  "host.help": { label: "Help", tutorRole: "context" },
  done: { label: "Round ended", tutorRole: "ignore" },
};

let seq = 0;

function event(
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

function render(events: GameEvent[], maxLines?: number): string {
  const digest = buildGameSessionDigest({
    gameId: "toy-warmer-colder",
    gameVersion: 1,
    totalActiveMs: 10_000,
    events,
    plan: PLAN,
  });
  return renderDigestForModel(digest, maxLines === undefined ? undefined : { maxLines });
}

describe("renderDigestForModel", () => {
  it("orders evidence by seq across digest collections", () => {
    seq = 0;
    const output = render([
      event("choice", { kind: "choice_made", choice: "tile 3" }, 1_000),
      event("explanation", { kind: "scholar_explained", text: "It felt closer" }, 2_000),
      event("strategy", { kind: "strategy_inferred", strategy: "testing the middle" }, 3_000),
      event("rule", { kind: "local_rule_result", passed: false, detail: "The tiles differ" }, 4_000),
      event("host.help", { kind: "help_requested" }, 5_000),
    ]);

    expect(output.split("\n")).toEqual([
      "tile 3",
      'In their own words: "It felt closer"',
      "testing the middle (the game's guess, not a fact)",
      "The tiles differ",
      "They asked for a hint here.",
    ]);
  });

  it("pairs a prediction with what the scholar then saw", () => {
    seq = 0;
    const prediction = event(
      "guess",
      { kind: "prediction_recorded", value: "the left half" },
      1_000,
    );
    const observation = event(
      "feedback",
      { kind: "observation_recorded", value: "warmer", predictsSeq: prediction.seq },
      2_000,
    );

    expect(render([prediction, observation])).toBe(
      'They predicted: "the left half" — then saw: "warmer"',
    );
  });

  it("renders revisions with an arrow and their trigger", () => {
    seq = 0;
    const observation = event(
      "feedback",
      { kind: "observation_recorded", value: "colder" },
      1_000,
    );
    const revision = event(
      "revise",
      {
        kind: "model_revised",
        before: "look left",
        after: "look right",
        triggeredBySeq: observation.seq,
      },
      2_000,
    );

    expect(render([observation, revision])).toBe(
      'They changed their thinking: "look left" → "look right" (right after: colder)',
    );
  });

  it("labels an opponent choice without attributing it to the scholar", () => {
    seq = 0;
    expect(
      render([
        event("choice", { kind: "choice_made", choice: "claimed 12" }, 1_000, "opponent"),
      ]),
    ).toBe("[opponent] claimed 12");
  });

  it("labels a system choice without attributing it to the game", () => {
    seq = 0;
    expect(
      render([
        event("choice", { kind: "choice_made", choice: "opened round" }, 1_000, "system"),
      ]),
    ).toBe("[system] opened round");
  });

  it("keeps the newest lines and reports truncation", () => {
    seq = 0;
    const output = render(
      [
        event("choice", { kind: "choice_made", choice: "first" }, 1_000),
        event("choice", { kind: "choice_made", choice: "second" }, 2_000),
        event("choice", { kind: "choice_made", choice: "third" }, 3_000),
        event("choice", { kind: "choice_made", choice: "fourth" }, 4_000),
      ],
      2,
    );

    expect(output.split("\n")).toEqual([
      "(… earlier play omitted — 2 lines)",
      "third",
      "fourth",
    ]);
  });

  it("uses a sentinel for a round with no model-facing evidence", () => {
    seq = 0;
    expect(render([])).toBe("(They've just started — no moves recorded yet.)");
  });

  it("labels the game's reported outcome as a claim", () => {
    seq = 0;
    expect(
      render([event("done", { kind: "outcome_claimed", outcomeKey: "found" }, 1_000)]),
    ).toBe('The game reports the round ended: "found" (the game\'s claim).');
  });

  it("never adds judgment language to the rendered fixtures", () => {
    seq = 0;
    const output = render([
      event("guess", { kind: "prediction_recorded", value: "left" }, 1_000),
      event("explanation", { kind: "scholar_explained", text: "The clue changed" }, 2_000),
      event("strategy", { kind: "strategy_inferred", strategy: "checking edges" }, 3_000),
      event("done", { kind: "outcome_claimed", outcomeKey: "finished" }, 4_000),
    ]).toLowerCase();

    for (const forbidden of ["correct", "score", "mastery"]) {
      expect(output).not.toContain(forbidden);
    }
  });
});
