import { describe, expect, it } from "vitest";

import {
  GAME_CATALOG,
  GAME_IDS,
  HOST_EVIDENCE_PLAN,
  catalogEntryErrors,
  effectiveEvidencePlan,
  evidencePlanEntryError,
  getGame,
  isGameId,
} from "../catalog";
import { HOST_EVENT_KEYS, isHostEventKey } from "../contract";

describe("game catalog", () => {
  it("has an entry for every declared id, and no extras", () => {
    expect(Object.keys(GAME_CATALOG).sort()).toEqual([...GAME_IDS].sort());
    for (const gameId of GAME_IDS) {
      expect(GAME_CATALOG[gameId].gameId).toBe(gameId);
    }
  });

  it("every entry is structurally clean", () => {
    for (const gameId of GAME_IDS) {
      expect(catalogEntryErrors(GAME_CATALOG[gameId])).toEqual([]);
    }
  });

  it("declares every game as iPad-only (D-5 is policy, not per-game)", () => {
    for (const gameId of GAME_IDS) {
      expect(GAME_CATALOG[gameId].platform).toBe("ipad");
    }
  });

  it("no game shadows a reserved host. eventKey", () => {
    for (const gameId of GAME_IDS) {
      for (const eventKey of Object.keys(GAME_CATALOG[gameId].evidencePlan)) {
        expect(isHostEventKey(eventKey)).toBe(false);
      }
    }
  });

  it("merges the host plan into the effective plan", () => {
    const plan = effectiveEvidencePlan("toy-warmer-colder");
    expect(plan).not.toBeNull();
    expect(plan![HOST_EVENT_KEYS.help]).toEqual(HOST_EVIDENCE_PLAN[HOST_EVENT_KEYS.help]);
    expect(plan!.guess_half.tutorRole).toBe("prediction");
  });

  it("returns null for an unknown gameId rather than guessing", () => {
    expect(getGame("not-a-game")).toBeNull();
    expect(effectiveEvidencePlan("not-a-game")).toBeNull();
    expect(isGameId("not-a-game")).toBe(false);
  });
});

describe("evidencePlanEntryError", () => {
  it("accepts a well-formed entry", () => {
    expect(evidencePlanEntryError({ label: "Tapped", tutorRole: "context" })).toBeNull();
    expect(
      evidencePlanEntryError({ label: "Tapped", tutorRole: "strategy", concept: "search" }),
    ).toBeNull();
  });

  it("rejects an unknown tutorRole", () => {
    expect(evidencePlanEntryError({ label: "x", tutorRole: "graded" })).toMatch(/unknown tutorRole/);
  });

  // The point of the whole type: a plan entry is a filing label, and it must be
  // structurally incapable of carrying credit. D-3 lives here.
  it.each(["score", "points", "weight", "threshold", "credit", "mastery", "streak", "xp", "grade"])(
    "rejects the forbidden scoring field %s",
    (field) => {
      const error = evidencePlanEntryError({
        label: "x",
        tutorRole: "context",
        [field]: 1,
      });
      expect(error).toMatch(/forbidden scoring field/);
    },
  );

  it("rejects an unknown field rather than ignoring it", () => {
    expect(evidencePlanEntryError({ label: "x", tutorRole: "context", wat: 1 })).toMatch(
      /unknown field/,
    );
  });
});
