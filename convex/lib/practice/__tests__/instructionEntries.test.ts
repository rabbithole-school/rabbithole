import { describe, expect, it, test } from "vitest";
import {
  INSTRUCTION_REOFFER_CAP,
  instructionOfferId,
  isInstructionSuppressed,
  selectRunLaunchpad,
  questionFrameWritesFor,
  strandInstructionKey,
  nodeInstructionKey,
  advanceQuestionFrame,
  compactMoveAtoms,
  frameMoveFor,
  hasTeachingStep,
  type InstructionAtom,
  type InstructionEventLike,
  type RunItemLike,
} from "../instructionEntries";

// Why this file: the Launchpad SELECTOR and fire-once lifecycle rules are the
// safety core of instructional segments v1 — "≤1/day", "re-offer a skip at most
// N times but never a viewed/dismissed one", and "domain-scoped keys never
// collide". They are pure (no ctx/db) precisely so these invariants are pinned
// here, independent of the Convex query/mutations that load the rows.

describe("strandInstructionKey", () => {
  test("is domain-scoped so identically-named strands never collide", () => {
    const a = strandInstructionKey("whole-number-arithmetic", "operations");
    const b = strandInstructionKey("fraction-arithmetic", "operations");
    expect(a).toBe("strand:whole-number-arithmetic:operations");
    expect(a).not.toBe(b);
  });
});

describe("instructionOfferId", () => {
  test("binds an offer to one scholar + key", () => {
    expect(instructionOfferId("sch1", "strand:d:s")).toBe("sch1:strand:d:s");
  });
});

describe("isInstructionSuppressed", () => {
  test("a missing row is never suppressed", () => {
    expect(isInstructionSuppressed(undefined)).toBe(false);
    expect(isInstructionSuppressed(null)).toBe(false);
  });

  test("a skip-only (try) row under the cap stays eligible — one skip never buries it", () => {
    const ev: InstructionEventLike = { key: "k", shownAt: 1, initialChoice: "try", offerCount: 1 };
    expect(isInstructionSuppressed(ev)).toBe(false);
  });

  test("viewing, completing, or dismissing permanently suppresses", () => {
    expect(isInstructionSuppressed({ key: "k", viewedAt: 1 })).toBe(true);
    expect(isInstructionSuppressed({ key: "k", completedAt: 1 })).toBe(true);
    expect(isInstructionSuppressed({ key: "k", dismissedAt: 1 })).toBe(true);
  });

  test("re-offer cap suppresses a chronically-skipped Launchpad", () => {
    const ev: InstructionEventLike = { key: "k", shownAt: 1, initialChoice: "try", offerCount: INSTRUCTION_REOFFER_CAP };
    expect(isInstructionSuppressed(ev)).toBe(true);
    expect(isInstructionSuppressed({ ...ev, offerCount: INSTRUCTION_REOFFER_CAP - 1 })).toBe(false);
  });
});

// ── selectRunLaunchpad — the run-anchored selector (P1) ────────────────────
//
// The defect P1 replaced: the strand was chosen by walking the domain graph in
// node order while the queue picked its own frontier, and the client mounted
// the winner at idx === 0 (reproduced 18/18 configurations, 2026-07-24).
// Selecting FROM the served items makes that unrepresentable.
//
// 2026-10-10: the frame is NODE grain only, and an item is framed only when an
// on-topic move exists — its own teaching step, else node content. Strand
// content is never a move (the "45¢ in nickels and dimes" → "4 × 3 eggs" bug).

const item = (over: Partial<RunItemLike> & { skillKey: string }): RunItemLike => ({
  domain: "d",
  lane: "new",
  strand: "s",
  hasTeachingStep: true,
  ...over,
});

const always = () => true;
const never = () => false;
/** The scholar has drilled these nodes (a real attempt) and nothing else. */
const attempted = (...keys: string[]) => (skillKey: string) => keys.includes(skillKey);

describe("selectRunLaunchpad", () => {
  const base = {
    hasAttemptOnNode: never,
    hasNodeContent: never,
    eventByKey: new Map<string, InstructionEventLike>(),
    dayBucket: "2026-07-24",
  };

  test("REGRESSION (§3): the framed item is always one the run serves", () => {
    const items = [
      item({ skillKey: "c1", strand: "concept", lane: "review" }),
      item({ skillKey: "c2", strand: "concept", lane: "review" }),
      item({ skillKey: "m1", strand: "comparison" }),
    ];
    const got = selectRunLaunchpad({ ...base, items, hasAttemptOnNode: attempted("c1", "c2") });
    expect(got).not.toBeNull();
    expect(items[got!.at].skillKey).toBe(got!.nodeKey);
    expect(items[got!.at].strand).toBe(got!.strand);
  });

  test("anchors `at` to the first never-attempted item, not to zero", () => {
    const items = [
      item({ skillKey: "c1", lane: "review" }),
      item({ skillKey: "c2", lane: "review" }),
      item({ skillKey: "m1" }),
    ];
    expect(selectRunLaunchpad({ ...base, items, hasAttemptOnNode: attempted("c1", "c2") })!.at).toBe(2);
  });

  test("never frames a review of a node the scholar has actually attempted", () => {
    const items = [item({ skillKey: "c1", lane: "review" })];
    expect(selectRunLaunchpad({ ...base, items, hasAttemptOnNode: attempted("c1") })).toBeNull();
  });

  test("a placement-credited but never-ATTEMPTED node counts as new, even served as a review", () => {
    const items = [item({ skillKey: "c1", lane: "review" })];
    expect(selectRunLaunchpad({ ...base, items })).toMatchObject({ at: 0, level: "node", nodeKey: "c1" });
  });

  test("the FIRST frameable item wins — at most one per run", () => {
    const items = [
      item({ skillKey: "c1", lane: "review" }),
      item({ skillKey: "f1" }),
      item({ skillKey: "g1" }),
    ];
    const got = selectRunLaunchpad({ ...base, items, hasAttemptOnNode: attempted("c1") });
    expect(got).toMatchObject({ at: 1, nodeKey: "f1" });
  });

  test("the cross-key daily governor can be turned off for the question framing", () => {
    const eventByKey = new Map<string, InstructionEventLike>([
      ["node:other", { key: "node:other", shownAt: 1, lastShownDayBucket: "2026-07-24" }],
    ]);
    const items = [item({ skillKey: "a" })];
    expect(selectRunLaunchpad({ ...base, eventByKey, items })).toBeNull();
    expect(selectRunLaunchpad({ ...base, eventByKey, items, dailyCap: false })).toMatchObject({ nodeKey: "a" });
  });

  test("never frames a mapping probe or an optional challenge/stretch tail", () => {
    for (const lane of ["mapping", "challenge", "stretch"]) {
      expect(selectRunLaunchpad({ ...base, items: [item({ skillKey: "x", lane })] })).toBeNull();
    }
  });

  test("skips an unstranded item", () => {
    expect(selectRunLaunchpad({ ...base, items: [item({ skillKey: "a", strand: undefined })] })).toBeNull();
  });

  test("honours fire-once suppression per node and falls through to the next item", () => {
    const key = nodeInstructionKey("seen");
    const eventByKey = new Map<string, InstructionEventLike>([[key, { key, viewedAt: 123 }]]);
    const items = [item({ skillKey: "seen" }), item({ skillKey: "next" })];
    expect(selectRunLaunchpad({ ...base, eventByKey, items })).toMatchObject({ at: 1, nodeKey: "next" });
  });

  test("the key is always the node key — never a strand key", () => {
    const got = selectRunLaunchpad({ ...base, items: [item({ skillKey: "a", domain: "fraction-arithmetic" })] });
    expect(got!.key).toBe(nodeInstructionKey("a"));
  });

  test("returns null for an empty run", () => {
    expect(selectRunLaunchpad({ ...base, items: [] })).toBeNull();
  });
});

describe("selectRunLaunchpad — the move must be about the framed item", () => {
  const base = {
    hasAttemptOnNode: never,
    eventByKey: new Map<string, InstructionEventLike>(),
    dayBucket: "2026-10-10",
  };

  test("precedence: the item's own teaching step beats node content", () => {
    const got = selectRunLaunchpad({
      ...base,
      items: [item({ skillKey: "a", hasTeachingStep: true })],
      hasNodeContent: always,
    });
    expect(got).toMatchObject({ at: 0, move: "item_steps" });
  });

  test("precedence: node content is the move when the item has no step of its own", () => {
    const got = selectRunLaunchpad({
      ...base,
      items: [item({ skillKey: "a", hasTeachingStep: false })],
      hasNodeContent: (k) => k === "a",
    });
    expect(got).toMatchObject({ at: 0, move: "node_content", key: nodeInstructionKey("a") });
  });

  test("never frames off-topic: no step and no node content → the item is not framed, even with strand content", () => {
    // The 45¢ coins item: a manipulative with no worked steps, on a node with
    // no node content, inside a strand (mult-divide) that HAS content. There
    // is no way to ask the selector about strand content at all now — the
    // next frameable item wins instead.
    const items = [
      item({ skillKey: "skip_count_coins", strand: "mult-divide", hasTeachingStep: false }),
      item({ skillKey: "add_make_ten", strand: "add-subtract", hasTeachingStep: true }),
    ];
    const got = selectRunLaunchpad({ ...base, items, hasNodeContent: never });
    expect(got).toMatchObject({ at: 1, nodeKey: "add_make_ten", move: "item_steps" });
    expect(selectRunLaunchpad({ ...base, items: [items[0]], hasNodeContent: never })).toBeNull();
  });

  test("node content for a DIFFERENT node never frames this item", () => {
    const got = selectRunLaunchpad({
      ...base,
      items: [item({ skillKey: "a", hasTeachingStep: false })],
      hasNodeContent: (k) => k === "b",
    });
    expect(got).toBeNull();
  });

  test("frameMoveFor reports the same precedence the selector uses", () => {
    expect(frameMoveFor({ skillKey: "a", hasTeachingStep: true }, always)).toBe("item_steps");
    expect(frameMoveFor({ skillKey: "a", hasTeachingStep: false }, always)).toBe("node_content");
    expect(frameMoveFor({ skillKey: "a" }, never)).toBeNull();
  });
});

describe("hasTeachingStep — the shared 'has an interactive step' predicate", () => {
  test("a single-blank fade needs at least two worked steps", () => {
    expect(hasTeachingStep(undefined)).toBe(false);
    expect(hasTeachingStep([])).toBe(false);
    expect(hasTeachingStep([{ text: "only step" }])).toBe(false);
    expect(hasTeachingStep([{ text: "one" }, { text: "two" }])).toBe(true);
  });
});

describe("compactMoveAtoms — the inline move is text + worked example only", () => {
  const atoms: InstructionAtom[] = [
    { kind: "story_hook", hook: "h" },
    { kind: "micro_explain", text: "t" },
    { kind: "manipulative", spec: "{}" },
    {
      kind: "worked_example",
      strategyLabel: "s",
      steps: ["a", "b"],
      examplePrompt: "p",
      exampleAnswer: "1",
    },
    { kind: "try_it", strategyLabel: "s", steps: ["a", "b"], examplePrompt: "p", exampleAnswer: "1" },
    {
      kind: "video",
      provider: "youtube",
      videoId: "v",
      startSec: 0,
      endSec: 1,
      captionText: "c",
      sourceLabel: "l",
      sourceUrl: "u",
    },
  ];

  test("drops explorers, manipulatives, videos and story hooks; keeps order", () => {
    expect(compactMoveAtoms(atoms).map((a) => a.kind)).toEqual(["micro_explain", "worked_example"]);
  });

  test("content with neither text nor a worked example compacts to nothing (so it frames nothing)", () => {
    expect(compactMoveAtoms([{ kind: "manipulative", spec: "{}" }, { kind: "story_hook", hook: "h" }])).toEqual([]);
  });
});

describe("selectRunLaunchpad — the <=1/day governor is scoped to OTHER keys", () => {
  const items = [item({ skillKey: "s1", domain: "math", strand: "fractions" })];
  const key = nodeInstructionKey("s1");
  const otherKey = nodeInstructionKey("r1");
  const base = {
    items,
    hasAttemptOnNode: never,
    hasNodeContent: never,
    dayBucket: "2026-07-24",
  };

  it("keeps offering THIS key after its own impression claim (no self-retraction)", () => {
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([[key, { key, shownAt: 1, lastShownDayBucket: "2026-07-24", offerCount: 1 }]]),
    });
    expect(out?.key).toBe(key);
  });

  it("still suppresses when a DIFFERENT key was shown today", () => {
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([[otherKey, { key: otherKey, shownAt: 1, lastShownDayBucket: "2026-07-24", offerCount: 1 }]]),
    });
    expect(out).toBeNull();
  });

  it("a legacy STRAND key shown today still counts for the governor", () => {
    const strandKey = strandInstructionKey("math", "ratio");
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([[strandKey, { key: strandKey, shownAt: 1, lastShownDayBucket: "2026-07-24", offerCount: 1 }]]),
    });
    expect(out).toBeNull();
  });

  it("re-offers tomorrow after a different key was shown yesterday", () => {
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([[otherKey, { key: otherKey, shownAt: 1, lastShownDayBucket: "2026-07-23", offerCount: 1 }]]),
    });
    expect(out?.key).toBe(key);
  });

  it("retracts once the scholar actually engages with it", () => {
    for (const engaged of [{ viewedAt: 2 }, { completedAt: 2 }, { dismissedAt: 2 }]) {
      const out = selectRunLaunchpad({
        ...base,
        eventByKey: new Map([[key, { key, shownAt: 1, lastShownDayBucket: "2026-07-24", offerCount: 1, ...engaged }]]),
      });
      expect(out).toBeNull();
    }
  });

  it("a node's own re-offer cap suppresses it", () => {
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([[key, { key, shownAt: 1, initialChoice: "try", offerCount: INSTRUCTION_REOFFER_CAP }]]),
    });
    expect(out).toBeNull();
  });
});

describe("advanceQuestionFrame — the shared frame stage machine", () => {
  const miss = { correct: false };
  const notYet = { correct: false, dontKnow: true };
  const right = { correct: true };

  test("right first time → nailed, for either move", () => {
    for (const move of ["item_steps", "node_content"] as const) {
      expect(advanceQuestionFrame("ask", "feedback", right, move)).toEqual({ stage: "nailed", events: ["answered"] });
    }
  });

  test("'Not yet' → move, for either move (its choice was recorded on tap)", () => {
    for (const move of ["item_steps", "node_content"] as const) {
      expect(advanceQuestionFrame("ask", "feedback", notYet, move)).toEqual({ stage: "move", events: ["moveShown"] });
    }
  });

  test("a miss shows node content, but hands an item-steps frame to the ordinary miss lane", () => {
    expect(advanceQuestionFrame("ask", "feedback", miss, "node_content")).toEqual({
      stage: "move",
      events: ["answered", "moveShown"],
    });
    expect(advanceQuestionFrame("ask", "feedback", miss, "item_steps")).toEqual({ stage: "done", events: ["answered"] });
  });

  test("back to answering after the move → after; the next verdict completes", () => {
    expect(advanceQuestionFrame("move", "answering", null, "node_content")).toEqual({ stage: "after", events: [] });
    expect(advanceQuestionFrame("after", "feedback", right, "node_content")).toEqual({
      stage: "done",
      events: ["answeredAfterMove"],
    });
  });

  test("no change while answering, or once nailed/done", () => {
    expect(advanceQuestionFrame("ask", "answering", null, "item_steps")).toBeNull();
    expect(advanceQuestionFrame("nailed", "feedback", right, "item_steps")).toBeNull();
    expect(advanceQuestionFrame("move", "feedback", notYet, "item_steps")).toBeNull();
  });
});

// ── questionFrameWritesFor — the framed item's telemetry plan ──────────────
// The framing writes the SAME instructionEvents lifecycle the doorway card did,
// so the denominator survives the redesign: shown → show|try → viewed →
// completed. A preview (teacher Rehearse) or a subject-less render writes nothing.
describe("questionFrameWritesFor", () => {
  const live = { scholarId: "sch1" };
  test("maps each framed-item moment to one lifecycle write", () => {
    expect(questionFrameWritesFor("frameShown", live)).toEqual([{ type: "claimShown" }]);
    expect(questionFrameWritesFor("notYet", live)).toEqual([{ type: "recordChoice", choice: "show" }]);
    expect(questionFrameWritesFor("answered", live)).toEqual([{ type: "recordChoice", choice: "try" }]);
    expect(questionFrameWritesFor("moveShown", live)).toEqual([{ type: "recordViewed" }]);
    expect(questionFrameWritesFor("answeredAfterMove", live)).toEqual([{ type: "recordCompleted" }]);
  });
  test("a preview or a subject-less render writes nothing", () => {
    for (const ev of ["frameShown", "notYet", "answered", "moveShown", "answeredAfterMove"] as const) {
      expect(questionFrameWritesFor(ev, { preview: true, scholarId: "sch1" })).toEqual([]);
      expect(questionFrameWritesFor(ev, { scholarId: null })).toEqual([]);
    }
  });
});
