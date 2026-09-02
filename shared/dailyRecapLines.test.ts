import { describe, expect, it } from "vitest";
import { buildRecapLines, type RecapLinesInput } from "./dailyRecapLines";

function recap(over: Partial<RecapLinesInput>): RecapLinesInput {
  return {
    practiced: [],
    practicedCount: 0,
    yoursNow: [],
    newOnMap: [],
    revealed: [],
    finished: [],
    ...over,
  };
}

describe("buildRecapLines", () => {
  it("emits one node per row with every Fluent node first", () => {
    const lines = buildRecapLines(
      recap({
        practiced: ["Adding within 20"],
        practicedCount: 1,
        yoursNow: ["Subtracting within 20", "Adding within 20"],
        newOnMap: ["Multiplication facts", "Fraction sense"],
        finished: ["Aquaponics QUEST"],
      }),
    );

    expect(lines).toEqual([
      {
        key: "yoursNow:Subtracting within 20",
        label: "Fluent",
        text: "Subtracting within 20",
        mastery: "fluent",
      },
      {
        key: "yoursNow:Adding within 20",
        label: "Fluent",
        text: "Adding within 20",
        mastery: "fluent",
      },
      {
        key: "newOnMap:Multiplication facts",
        label: "Your frontier moved",
        text: "Multiplication facts",
        mastery: "frontier",
      },
      {
        key: "newOnMap:Fraction sense",
        label: "Your frontier moved",
        text: "Fraction sense",
        mastery: "frontier",
      },
    ]);
  });

  it("shows an exact duplicate only once, as Fluent", () => {
    expect(
      buildRecapLines(
        recap({
          yoursNow: ["Factor pairs"],
          newOnMap: ["Factor pairs", "Prime numbers"],
        }),
      ),
    ).toEqual([
      {
        key: "yoursNow:Factor pairs",
        label: "Fluent",
        text: "Factor pairs",
        mastery: "fluent",
      },
      {
        key: "newOnMap:Prime numbers",
        label: "Your frontier moved",
        text: "Prime numbers",
        mastery: "frontier",
      },
    ]);
  });

  it("ignores practice and completion compatibility buckets", () => {
    expect(
      buildRecapLines(
        recap({
          practiced: ["Adding within 20"],
          practicedCount: 1,
          finished: ["Aquaponics QUEST"],
        }),
      ),
    ).toEqual([]);
  });

  it("skips empty map buckets without changing the remaining label", () => {
    expect(buildRecapLines(recap({ newOnMap: ["Fraction sense"] }))).toEqual([
      {
        key: "newOnMap:Fraction sense",
        label: "Your frontier moved",
        text: "Fraction sense",
        mastery: "frontier",
      },
    ]);
  });

  it("adds revealed nodes after the fluent and frontier lines", () => {
    expect(
      buildRecapLines(
        recap({
          yoursNow: ["Adding within 20"],
          newOnMap: ["Multiplication facts"],
          revealed: ["Area models", "Prime numbers"],
        }),
      ),
    ).toEqual([
      {
        key: "yoursNow:Adding within 20",
        label: "Fluent",
        text: "Adding within 20",
        mastery: "fluent",
      },
      {
        key: "newOnMap:Multiplication facts",
        label: "Your frontier moved",
        text: "Multiplication facts",
        mastery: "frontier",
      },
      {
        key: "revealed:Area models",
        label: "Added to your Math Skills Tree",
        text: "Area models",
        mastery: "revealed",
      },
      {
        key: "revealed:Prime numbers",
        label: "Added to your Math Skills Tree",
        text: "Prime numbers",
        mastery: "revealed",
      },
    ]);
  });

  it("drops a reveal already shown as Fluent or frontier", () => {
    expect(
      buildRecapLines(
        recap({
          yoursNow: ["Factor pairs"],
          newOnMap: ["Prime numbers"],
          revealed: ["Factor pairs", "Prime numbers", "Area models"],
        }),
      ),
    ).toEqual([
      {
        key: "yoursNow:Factor pairs",
        label: "Fluent",
        text: "Factor pairs",
        mastery: "fluent",
      },
      {
        key: "newOnMap:Prime numbers",
        label: "Your frontier moved",
        text: "Prime numbers",
        mastery: "frontier",
      },
      {
        key: "revealed:Area models",
        label: "Added to your Math Skills Tree",
        text: "Area models",
        mastery: "revealed",
      },
    ]);
  });

  it("renders reveals on a day with no fluency or frontier movement", () => {
    expect(buildRecapLines(recap({ revealed: ["Area models"] }))).toEqual([
      {
        key: "revealed:Area models",
        label: "Added to your Math Skills Tree",
        text: "Area models",
        mastery: "revealed",
      },
    ]);
  });
});
