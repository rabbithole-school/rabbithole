import { describe, expect, it } from "vitest";

import {
  GAME_EVENT_KINDS,
  MAX_CHOICE_OPTIONS,
  MAX_EVENT_KEY_LEN,
  MAX_EVENT_TEXT_LEN,
  gameEventInputError,
  isGameEventKind,
  isHostEventKey,
  platformNotice,
} from "../contract";

describe("game event kinds", () => {
  it("exposes the closed union at runtime", () => {
    expect(GAME_EVENT_KINDS).toHaveLength(10);
    expect(isGameEventKind("model_revised")).toBe(true);
    expect(isGameEventKind("awarded_mastery")).toBe(false);
  });
});

describe("gameEventInputError", () => {
  const ok = { eventKey: "first_tap", payload: { kind: "choice_made", choice: "3" } };

  it("accepts a well-formed event", () => {
    expect(gameEventInputError(ok)).toBeNull();
  });

  it("rejects a non-object", () => {
    expect(gameEventInputError(null)).toMatch(/must be an object/);
    expect(gameEventInputError("nope")).toMatch(/must be an object/);
  });

  it("rejects a missing or oversized eventKey", () => {
    expect(gameEventInputError({ payload: ok.payload })).toMatch(/eventKey/);
    expect(
      gameEventInputError({ eventKey: "x".repeat(MAX_EVENT_KEY_LEN + 1), payload: ok.payload }),
    ).toMatch(/exceeds/);
  });

  it("rejects an unknown payload kind — the union is closed", () => {
    expect(
      gameEventInputError({ eventKey: "x", payload: { kind: "mastery_earned", skill: "a" } }),
    ).toMatch(/unknown event kind/);
  });

  it("rejects missing required payload fields", () => {
    expect(gameEventInputError({ eventKey: "x", payload: { kind: "phase_changed" } })).toMatch(
      /phase is required/,
    );
    expect(
      gameEventInputError({ eventKey: "x", payload: { kind: "model_revised", before: "a" } }),
    ).toMatch(/after is required/);
  });

  it("caps free text so a payload cannot become a prompt channel", () => {
    expect(
      gameEventInputError({
        eventKey: "x",
        payload: { kind: "scholar_explained", text: "a".repeat(MAX_EVENT_TEXT_LEN + 1) },
      }),
    ).toMatch(/exceeds/);
  });

  it("caps the option list on a choice", () => {
    expect(
      gameEventInputError({
        eventKey: "x",
        payload: {
          kind: "choice_made",
          choice: "1",
          among: Array.from({ length: MAX_CHOICE_OPTIONS + 1 }, (_, i) => String(i)),
        },
      }),
    ).toMatch(/exceeds/);
  });

  it("rejects a non-integer link seq", () => {
    expect(
      gameEventInputError({
        eventKey: "x",
        payload: { kind: "observation_recorded", value: "warmer", predictsSeq: 1.5 },
      }),
    ).toMatch(/predictsSeq must be an integer/);
  });

  it("allows optional fields to be omitted", () => {
    expect(gameEventInputError({ eventKey: "x", payload: { kind: "help_requested" } })).toBeNull();
    expect(
      gameEventInputError({ eventKey: "x", payload: { kind: "local_rule_result", passed: true } }),
    ).toBeNull();
  });
});

describe("host reservations", () => {
  it("recognises the reserved prefix", () => {
    expect(isHostEventKey("host.help")).toBe(true);
    expect(isHostEventKey("first_tap")).toBe(false);
  });
});

describe("platformNotice", () => {
  it("states the requirement plainly, with no fallback offer", () => {
    const notice = platformNotice("Warmer or Colder (toy)", "ipad");
    expect(notice).toBe("Warmer or Colder (toy) runs on your iPad.");
    expect(notice).not.toMatch(/instead|however|sorry|unfortunately/i);
  });
});
