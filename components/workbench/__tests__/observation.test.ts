import { describe, expect, it } from "vitest";

import { isNeutralLabel } from "../viewport";
import {
  biomassWord,
  describeAction,
  describeObservation,
  directionPhrase,
  distancePhrase,
} from "../observation";

describe("observation prose is readable + honest (QB walkthrough W2)", () => {
  it("names compass directions from the grid's sign convention", () => {
    // dx>0 east, dx<0 west, dy>0 south, dy<0 north (y increases downward).
    expect(directionPhrase(0, 0)).toBe("here");
    expect(directionPhrase(0, -2)).toBe("north");
    expect(directionPhrase(0, 3)).toBe("south");
    expect(directionPhrase(2, 0)).toBe("east");
    expect(directionPhrase(-1, 0)).toBe("west");
    expect(directionPhrase(1, -1)).toBe("north-east");
    expect(directionPhrase(-1, 1)).toBe("south-west");
  });

  it("phrases distance with tile pluralization", () => {
    expect(distancePhrase(0, 0, 0)).toBe("here");
    expect(distancePhrase(0, 1, 1)).toBe("1 tile south");
    expect(distancePhrase(2, 2, 4)).toBe("4 tiles south-east");
  });

  it("reads algae fullness off biomass, not a raw number", () => {
    expect(biomassWord(9)).toBe("thick");
    expect(biomassWord(5)).toBe("medium");
    expect(biomassWord(1)).toBe("thin");
  });

  it("turns a raw observation into short prose lines a nine-year-old can read", () => {
    const observation = JSON.stringify({
      self: { energy: 9.743224, hidden: false, x: 3, y: 3 },
      vision: {
        resources: [
          { x: 3, y: 3, dx: 0, dy: 0, distance: 0, biomass: 8 },
          { x: 3, y: 4, dx: 0, dy: 1, distance: 1, biomass: 2 },
        ],
        automata: [{ id: "shark-1", slotId: "predator", dx: 3, dy: -1, distance: 4, energy: 12, hidden: false }],
        boundary: ["east"],
      },
    });
    const lines = describeObservation(observation, { predator: "shark" });
    expect(lines).toContain("your energy: 9.7");
    expect(lines).toContain("walls: east");
    expect(lines).toContain("algae patch here (thick)");
    expect(lines).toContain("algae 1 tile south (thin)");
    expect(lines).toContain("shark 4 tiles north-east");
    // No raw JSON leaks into the prose, and it stays neutral.
    expect(lines.join(" ")).not.toContain("{");
    for (const line of lines) expect(isNeutralLabel(line)).toBe(true);
  });

  it("uses a friendly fallback when the observation carries no other species label", () => {
    const observation = JSON.stringify({
      self: { energy: 4, hidden: true },
      touch: { automata: [{ id: "x", slotId: "unknown", dx: 0, dy: 0, distance: 0 }] },
    });
    const lines = describeObservation(observation);
    expect(lines).toContain("you are hidden");
    expect(lines.some((line) => line.startsWith("another creature"))).toBe(true);
  });

  it("reports exact wall distance instead of making a centered creature look boxed in", () => {
    const observation = JSON.stringify({
      self: { x: 2, y: 2 },
      vision: {
        boundary: [
          { side: "north", distance: 2 },
          { side: "east", distance: 2 },
          { side: "south", distance: 2 },
          { side: "west", distance: 2 },
        ],
      },
    });
    expect(describeObservation(observation)).toContain(
      "walls: 2 tiles north, 2 tiles east, 2 tiles south, 2 tiles west",
    );
  });

  it("returns no lines for an empty or unparseable observation", () => {
    expect(describeObservation(undefined)).toEqual([]);
    expect(describeObservation("not json")).toEqual([]);
    expect(describeObservation(JSON.stringify({ self: {} }))).toEqual([]);
  });

  it("describes each action as one neutral, dignified line", () => {
    expect(describeAction(JSON.stringify({ kind: "move", to: { x: 2, y: 5 } }))).toBe("moved to cell (2, 5)");
    expect(describeAction(JSON.stringify({ kind: "graze", at: { x: 1, y: 1 } }))).toBe("grazed the algae here");
    expect(describeAction(JSON.stringify({ kind: "eat", targetId: "prey-9" }))).toBe("ate a nearby creature");
    expect(describeAction(JSON.stringify({ kind: "rest" }))).toBe("rested to save energy");
    expect(describeAction(JSON.stringify({ kind: "reproduce" }))).toBe("split into two");
    expect(describeAction(JSON.stringify({ kind: "hide" }))).toBe("hid");
    expect(describeAction(JSON.stringify({ kind: "noop" }))).toBe("did nothing this day");
    expect(describeAction(undefined, "noop")).toBe("did nothing this day");
    // Every action line stays neutral (no diagnosis of the scholar).
    for (const kind of ["move", "graze", "eat", "rest", "reproduce", "hide", "noop"]) {
      expect(isNeutralLabel(describeAction(JSON.stringify({ kind })))).toBe(true);
    }
  });
});
