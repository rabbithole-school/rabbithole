import { describe, expect, test } from "vitest";

import type { AppAiTurnView } from "@/convex/appAi";
import {
  appCharacterNamesFrom,
  appContextText,
  interleaveAppAiTurns,
} from "./AppAiTurnRow";

const turn = (id: string, createdAt: number): AppAiTurnView =>
  ({
    _id: id,
    artifactId: "art1",
    kind: "exchange",
    status: "done",
    createdAt,
  }) as unknown as AppAiTurnView;

describe("interleaveAppAiTurns", () => {
  test("places each turn before the first newer message, keeping message order", () => {
    const messages = [
      { id: "m1", t: 10 },
      { id: "m2", t: 30 },
      // An optimistic row can carry a clock slightly behind its neighbour;
      // message order is the transcript's and must not change.
      { id: "m3", t: 25 },
    ];
    const merged = interleaveAppAiTurns(
      messages,
      [turn("a", 5), turn("b", 20), turn("c", 40)],
      (m) => m.t,
    );
    expect(
      merged.map((entry) =>
        entry.kind === "appAi" ? entry.turn._id : entry.item.id,
      ),
    ).toEqual(["a", "m1", "b", "m2", "m3", "c"]);
  });

  test("with no turns the list is just the messages", () => {
    const merged = interleaveAppAiTurns([{ t: 1 }], [], (m) => m.t);
    expect(merged).toEqual([{ kind: "message", item: { t: 1 } }]);
  });
});

describe("appCharacterNamesFrom", () => {
  test("names characters by the code artifact that hosts them", () => {
    expect(
      appCharacterNamesFrom([
        { _id: "a1", type: "code", appAi: { character: { name: "Widget" } } },
        { _id: "a2", type: "code", appAi: {} },
        { _id: "a3", type: "document" },
      ]),
    ).toEqual({ a1: "Widget" });
  });
});

describe("appContextText", () => {
  test("shows a flat context as its values in key order, no braces or keys for words", () => {
    expect(
      appContextText(JSON.stringify({ mode: "rule", part: "wiring", stage: 2 })),
    ).toBe("rule · wiring · stage 2");
    expect(appContextText(JSON.stringify({ solved: true }))).toBe("solved true");
  });

  test("shows nothing for a missing, malformed, or nested context", () => {
    expect(appContextText(undefined)).toBeNull();
    expect(appContextText("{not json")).toBeNull();
    expect(appContextText(JSON.stringify([1, 2]))).toBeNull();
    expect(appContextText(JSON.stringify({ nested: { a: 1 } }))).toBeNull();
  });
});
