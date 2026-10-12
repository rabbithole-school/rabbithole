import { describe, expect, it } from "vitest";
import {
  appendMappingSegment,
  initialQueueState,
  queueReducer,
  selectCurrentItem,
  selectHasChallengeOffer,
  selectHasStretchOffer,
  selectIsInChallenge,
  selectIsInStretch,
  selectItems,
  selectProgress,
  selectTotal,
  type PracticeQueueState,
  type QueueAction,
  type Segment,
} from "./sessionMachine";

type TestItem = { itemId: string; skillKey: string; lane?: string };

function item(itemId: string, skillKey = "skill-a"): TestItem {
  return { itemId, skillKey };
}

function loaded(
  overrides: Partial<{
    items: TestItem[];
    segments: Segment[];
    mappingProgressOffset: number;
    mappedDomainLabel: string | null;
    challengeItems: TestItem[];
    stretchItems: TestItem[];
  }> = {},
): QueueAction<TestItem> {
  return {
    type: "loaded",
    items: overrides.items ?? [item("a1"), item("a2"), item("a3")],
    segments: overrides.segments ?? [{ kind: "core_drill", count: 3 }],
    mappingProgressOffset: overrides.mappingProgressOffset ?? 0,
    mappedDomainLabel: overrides.mappedDomainLabel ?? null,
    challengeItems: overrides.challengeItems ?? [],
    stretchItems: overrides.stretchItems ?? [],
  };
}

/** Sum of a run-length segments list — must equal `items.length` on the wire
 *  (the invariant `shared/practiceSegments.ts` documents). */
function segmentsSum(segments: Segment[]): number {
  return segments.reduce((sum, s) => sum + s.count, 0);
}

describe("initialQueueState", () => {
  it("mirrors the original useState initializers", () => {
    expect(initialQueueState<TestItem>()).toEqual({
      items: null,
      segments: [],
      mappingProgressOffset: 0,
      mappedDomainLabel: null,
      challengeItems: [],
      inChallenge: false,
      stretchItems: [],
      inStretch: false,
      stretchCracked: false,
    });
  });
});

describe("queueReducer — reset", () => {
  it("clears the run to nothing-loaded and drops any in-progress tail", () => {
    const state: PracticeQueueState<TestItem> = {
      items: [item("a1")],
      segments: [{ kind: "core_drill", count: 1 }],
      mappingProgressOffset: 4,
      mappedDomainLabel: "Fractions",
      challengeItems: [item("c1")],
      inChallenge: true,
      stretchItems: [item("s1")],
      inStretch: true,
      stretchCracked: true,
    };
    const next = queueReducer(state, { type: "reset" });
    expect(next.items).toBeNull();
    expect(next.segments).toEqual([]);
    expect(next.mappingProgressOffset).toBe(0);
    expect(next.mappedDomainLabel).toBeNull();
    expect(next.inChallenge).toBe(false);
    expect(next.inStretch).toBe(false);
    expect(next.stretchCracked).toBe(false);
  });

  it("does NOT clear challengeItems/stretchItems (parity with the original resetHostRun, which never called setChallengeItems/setStretchItems)", () => {
    const state: PracticeQueueState<TestItem> = {
      ...initialQueueState<TestItem>(),
      challengeItems: [item("c1")],
      stretchItems: [item("s1")],
    };
    const next = queueReducer(state, { type: "reset" });
    expect(next.challengeItems).toEqual([item("c1")]);
    expect(next.stretchItems).toEqual([item("s1")]);
  });
});

describe("queueReducer — loaded", () => {
  it("installs every field from the payload wholesale", () => {
    const state = initialQueueState<TestItem>();
    const next = queueReducer(
      state,
      loaded({
        items: [item("m1"), item("m2")],
        segments: [{ kind: "mapping", count: 2 }],
        mappingProgressOffset: 6,
        mappedDomainLabel: "Geometry",
        challengeItems: [item("c1")],
        stretchItems: [item("s1")],
      }),
    );
    expect(next.items).toEqual([item("m1"), item("m2")]);
    expect(next.segments).toEqual([{ kind: "mapping", count: 2 }]);
    expect(next.mappingProgressOffset).toBe(6);
    expect(next.mappedDomainLabel).toBe("Geometry");
    expect(next.challengeItems).toEqual([item("c1")]);
    expect(next.stretchItems).toEqual([item("s1")]);
  });

  it("leaves inChallenge/inStretch/stretchCracked untouched (only `reset` and the tail-acceptance actions touch those)", () => {
    const state: PracticeQueueState<TestItem> = {
      ...initialQueueState<TestItem>(),
      inChallenge: true,
      inStretch: true,
      stretchCracked: true,
    };
    const next = queueReducer(state, loaded());
    expect(next.inChallenge).toBe(true);
    expect(next.inStretch).toBe(true);
    expect(next.stretchCracked).toBe(true);
  });

  it("a restored resume snapshot always clears the offered tails, matching restoreHostSnapshot", () => {
    const state: PracticeQueueState<TestItem> = {
      ...initialQueueState<TestItem>(),
      challengeItems: [item("stale-challenge")],
      stretchItems: [item("stale-stretch")],
    };
    const next = queueReducer(state, loaded({ challengeItems: [], stretchItems: [] }));
    expect(next.challengeItems).toEqual([]);
    expect(next.stretchItems).toEqual([]);
  });
});

describe("appendMappingSegment", () => {
  it("is a no-op for a non-positive count", () => {
    const prev: Segment[] = [{ kind: "core_drill", count: 2 }];
    expect(appendMappingSegment(prev, 0)).toBe(prev);
    expect(appendMappingSegment(prev, -1)).toBe(prev);
  });

  it("appends a fresh mapping segment when the list is empty", () => {
    expect(appendMappingSegment([], 3)).toEqual([{ kind: "mapping", count: 3 }]);
  });

  it("appends a fresh mapping segment when the run does not already end in one", () => {
    const prev: Segment[] = [{ kind: "core_drill", count: 2 }];
    expect(appendMappingSegment(prev, 3)).toEqual([
      { kind: "core_drill", count: 2 },
      { kind: "mapping", count: 3 },
    ]);
  });

  it("grows the trailing mapping segment for a seamless continuation", () => {
    const prev: Segment[] = [
      { kind: "core_drill", count: 2 },
      { kind: "mapping", count: 4 },
    ];
    expect(appendMappingSegment(prev, 3)).toEqual([
      { kind: "core_drill", count: 2 },
      { kind: "mapping", count: 7 },
    ]);
  });
});

describe("queueReducer — mappingBatchAppended", () => {
  it("appends items in encounter order and grows the trailing mapping segment", () => {
    let state = queueReducer(
      initialQueueState<TestItem>(),
      loaded({
        items: [item("map1"), item("map2")],
        segments: [{ kind: "mapping", count: 2 }],
      }),
    );
    state = queueReducer(state, {
      type: "mappingBatchAppended",
      added: [item("map3"), item("map4")],
    });
    expect(state.items).toEqual([item("map1"), item("map2"), item("map3"), item("map4")]);
    expect(state.segments).toEqual([{ kind: "mapping", count: 4 }]);
    expect(segmentsSum(state.segments)).toBe(state.items!.length);
  });

  it("is a no-op before the first load (items still null)", () => {
    const state = initialQueueState<TestItem>();
    const next = queueReducer(state, {
      type: "mappingBatchAppended",
      added: [item("map1")],
    });
    expect(next).toBe(state);
  });

  it("is a no-op when nothing was added", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const next = queueReducer(state, { type: "mappingBatchAppended", added: [] });
    expect(next).toBe(state);
  });

  it("can recompose across multiple batches, still summing to items.length", () => {
    let state = queueReducer(
      initialQueueState<TestItem>(),
      loaded({ items: [item("map1")], segments: [{ kind: "mapping", count: 1 }] }),
    );
    state = queueReducer(state, { type: "mappingBatchAppended", added: [item("map2")] });
    state = queueReducer(state, { type: "mappingBatchAppended", added: [item("map3"), item("map4")] });
    expect(state.items?.map((it) => it.itemId)).toEqual(["map1", "map2", "map3", "map4"]);
    expect(state.segments).toEqual([{ kind: "mapping", count: 4 }]);
    expect(segmentsSum(state.segments)).toBe(state.items!.length);
  });
});

describe("queueReducer — itemAppended / lastItemWithdrawn (help-used retry)", () => {
  it("appends a retry item after the served run", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const next = queueReducer(state, { type: "itemAppended", item: item("retry1") });
    expect(next.items).toEqual([item("a1"), item("a2"), item("a3"), item("retry1")]);
  });

  it("is a no-op before the first load", () => {
    const state = initialQueueState<TestItem>();
    const next = queueReducer(state, { type: "itemAppended", item: item("retry1") });
    expect(next).toBe(state);
  });

  it("withdraws exactly the last item, restoring the pre-append queue", () => {
    let state = queueReducer(initialQueueState<TestItem>(), loaded());
    const before = state.items;
    state = queueReducer(state, { type: "itemAppended", item: item("retry1") });
    state = queueReducer(state, { type: "lastItemWithdrawn" });
    expect(state.items).toEqual(before);
  });

  it("lastItemWithdrawn is a no-op before the first load or on an empty queue", () => {
    const empty = initialQueueState<TestItem>();
    expect(queueReducer(empty, { type: "lastItemWithdrawn" })).toBe(empty);

    const loadedEmpty = queueReducer(empty, loaded({ items: [] }));
    expect(queueReducer(loadedEmpty, { type: "lastItemWithdrawn" })).toBe(loadedEmpty);
  });
});

describe("queueReducer — itemReplacedAt (mapping confirm swap / fresh variant)", () => {
  it("replaces only the item at the given index, preserving order", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const confirm = item("confirm1");
    const next = queueReducer(state, { type: "itemReplacedAt", index: 1, item: confirm });
    expect(next.items).toEqual([item("a1"), confirm, item("a3")]);
  });

  it("is a no-op before the first load", () => {
    const state = initialQueueState<TestItem>();
    const next = queueReducer(state, { type: "itemReplacedAt", index: 0, item: item("x") });
    expect(next).toBe(state);
  });

  it("out-of-range index changes nothing (map never matches)", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const next = queueReducer(state, { type: "itemReplacedAt", index: 99, item: item("x") });
    expect(next.items).toEqual(state.items);
  });
});

describe("queueReducer — singleItemInstalled (breaker repair/fresh/easy install)", () => {
  it("swaps the whole queue for exactly one item and drops segments", () => {
    const state = queueReducer(
      initialQueueState<TestItem>(),
      loaded({ segments: [{ kind: "core_drill", count: 3 }] }),
    );
    const next = queueReducer(state, { type: "singleItemInstalled", item: item("breaker1") });
    expect(next.items).toEqual([item("breaker1")]);
    expect(next.segments).toEqual([]);
  });

  it("works even before any load (a persisted breaker trigger-item restore after a relaunch)", () => {
    const state = initialQueueState<TestItem>();
    const next = queueReducer(state, { type: "singleItemInstalled", item: item("restored1") });
    expect(next.items).toEqual([item("restored1")]);
    expect(next.segments).toEqual([]);
  });
});

describe("queueReducer — challengeAccepted", () => {
  it("swaps the challenge tail in as the run, clears the offer, marks inChallenge, drops segments", () => {
    const state = queueReducer(
      initialQueueState<TestItem>(),
      loaded({
        challengeItems: [item("ch1"), item("ch2")],
        segments: [{ kind: "core_drill", count: 3 }],
      }),
    );
    const next = queueReducer(state, { type: "challengeAccepted" });
    expect(next.items).toEqual([item("ch1"), item("ch2")]);
    expect(next.challengeItems).toEqual([]);
    expect(next.inChallenge).toBe(true);
    expect(next.segments).toEqual([]);
  });

  it("is a no-op when nothing was offered", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const next = queueReducer(state, { type: "challengeAccepted" });
    expect(next).toBe(state);
  });

  it("leaves stretchItems/inStretch untouched — challenge and stretch tails are independent", () => {
    const state = queueReducer(
      initialQueueState<TestItem>(),
      loaded({
        challengeItems: [item("ch1")],
        stretchItems: [item("st1")],
      }),
    );
    const next = queueReducer(state, { type: "challengeAccepted" });
    expect(next.stretchItems).toEqual([item("st1")]);
    expect(next.inStretch).toBe(false);
  });
});

describe("queueReducer — stretchAccepted", () => {
  it("swaps the stretch tail in as the run, clears the offer, marks inStretch, resets stretchCracked, drops segments", () => {
    const state: PracticeQueueState<TestItem> = {
      ...queueReducer(
        initialQueueState<TestItem>(),
        loaded({
          stretchItems: [item("st1"), item("st2")],
          segments: [{ kind: "core_drill", count: 3 }],
        }),
      ),
      stretchCracked: true, // a stale flag from an earlier stretch round this run
    };
    const next = queueReducer(state, { type: "stretchAccepted" });
    expect(next.items).toEqual([item("st1"), item("st2")]);
    expect(next.stretchItems).toEqual([]);
    expect(next.inStretch).toBe(true);
    expect(next.stretchCracked).toBe(false);
    expect(next.segments).toEqual([]);
  });

  it("is a no-op when nothing was offered", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const next = queueReducer(state, { type: "stretchAccepted" });
    expect(next).toBe(state);
  });
});

describe("queueReducer — stretchCracked", () => {
  it("sets stretchCracked true", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const next = queueReducer(state, { type: "stretchCracked" });
    expect(next.stretchCracked).toBe(true);
  });

  it("is idempotent — dispatching again on an already-cracked state returns the same reference", () => {
    let state = queueReducer(initialQueueState<TestItem>(), loaded());
    state = queueReducer(state, { type: "stretchCracked" });
    const next = queueReducer(state, { type: "stretchCracked" });
    expect(next).toBe(state);
  });
});

describe("queueReducer — mappedDomainLabelSet", () => {
  it("sets the label", () => {
    const state = queueReducer(initialQueueState<TestItem>(), loaded());
    const next = queueReducer(state, { type: "mappedDomainLabelSet", label: "Ratios" });
    expect(next.mappedDomainLabel).toBe("Ratios");
  });

  it("can clear the label back to null", () => {
    const state: PracticeQueueState<TestItem> = {
      ...queueReducer(initialQueueState<TestItem>(), loaded()),
      mappedDomainLabel: "Ratios",
    };
    const next = queueReducer(state, { type: "mappedDomainLabelSet", label: null });
    expect(next.mappedDomainLabel).toBeNull();
  });
});

describe("selectors", () => {
  const state = queueReducer(
    initialQueueState<TestItem>(),
    loaded({
      items: [item("a1"), item("a2"), item("a3")],
      challengeItems: [item("c1")],
      stretchItems: [item("s1")],
    }),
  );

  it("selectItems returns the queue (or null before the first load)", () => {
    expect(selectItems(state)).toEqual([item("a1"), item("a2"), item("a3")]);
    expect(selectItems(initialQueueState<TestItem>())).toBeNull();
  });

  it("selectTotal is 0 before the first load and the length once loaded", () => {
    expect(selectTotal(initialQueueState<TestItem>())).toBe(0);
    expect(selectTotal(state)).toBe(3);
  });

  it("selectCurrentItem reads by the caller-owned idx, including out-of-range", () => {
    expect(selectCurrentItem(state, 0)).toEqual(item("a1"));
    expect(selectCurrentItem(state, 2)).toEqual(item("a3"));
    expect(selectCurrentItem(state, 3)).toBeUndefined();
    expect(selectCurrentItem(initialQueueState<TestItem>(), 0)).toBeUndefined();
  });

  it("selectProgress pairs the caller-owned idx with the queue total", () => {
    expect(selectProgress(state, 1)).toEqual({ idx: 1, total: 3 });
  });

  it("selectIsInChallenge/selectIsInStretch read the acceptance flags", () => {
    expect(selectIsInChallenge(state)).toBe(false);
    expect(selectIsInStretch(state)).toBe(false);
    const inChallenge = queueReducer(state, { type: "challengeAccepted" });
    expect(selectIsInChallenge(inChallenge)).toBe(true);
  });

  it("selectHasChallengeOffer/selectHasStretchOffer read the offered tails", () => {
    expect(selectHasChallengeOffer(state)).toBe(true);
    expect(selectHasStretchOffer(state)).toBe(true);
    expect(selectHasChallengeOffer(initialQueueState<TestItem>())).toBe(false);
    expect(selectHasStretchOffer(initialQueueState<TestItem>())).toBe(false);
  });
});
