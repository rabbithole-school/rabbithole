import { describe, expect, it, test } from "vitest";
import {
  INSTRUCTION_REOFFER_CAP,
  instructionOfferId,
  isInstructionSuppressed,
  selectRunLaunchpad,
  strandInstructionKey,
  nodeInstructionKey,
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
// The defect this replaces: the strand was chosen by walking the domain graph
// in node order while the queue picked its own frontier, and the client mounted
// the winner at idx === 0. The two selectors routinely disagreed, so a scholar
// could be offered a doorway into a strand the run never served (reproduced
// 18/18 configurations, 2026-07-24). Selecting FROM the served items makes that
// unrepresentable — the strand IS the strand of items[at].

const item = (over: Partial<RunItemLike> & { skillKey: string }): RunItemLike => ({
  domain: "d",
  lane: "new",
  ...over,
});

const always = () => true;
const never = () => false;

describe("selectRunLaunchpad", () => {
  const base = {
    hasMasteryInStrand: never,
    hasContent: always,
    eventByKey: new Map<string, InstructionEventLike>(),
    dayBucket: "2026-07-24",
  };

  test("REGRESSION (§3): the chosen strand is always present in the run", () => {
    // The old selector could return a strand with no item in the run at all.
    // Here the run serves reviews in `concept` then frontier work in
    // `comparison`; `equivalence` (which the old graph-order pick preferred)
    // appears nowhere. The only answer this function can give is a strand it
    // read off an actual item.
    const items = [
      item({ skillKey: "c1", strand: "concept", lane: "review" }),
      item({ skillKey: "c2", strand: "concept", lane: "review" }),
      item({ skillKey: "m1", strand: "comparison" }),
      item({ skillKey: "m2", strand: "comparison" }),
    ];
    const got = selectRunLaunchpad({ ...base, items });
    expect(got).not.toBeNull();
    expect(got!.strand).toBe("comparison");
    // The invariant, stated as an assertion rather than trusted:
    expect(items.map((i) => i.strand)).toContain(got!.strand);
    expect(items[got!.at].strand).toBe(got!.strand);
  });

  test("anchors `at` to the first item of the strand, not to zero", () => {
    const items = [
      item({ skillKey: "c1", strand: "concept", lane: "review" }),
      item({ skillKey: "c2", strand: "concept", lane: "review" }),
      item({ skillKey: "m1", strand: "comparison" }),
    ];
    expect(selectRunLaunchpad({ ...base, items })!.at).toBe(2);
  });

  test("never opens on a review — a review is not new territory", () => {
    const items = [item({ skillKey: "c1", strand: "concept", lane: "review" })];
    expect(selectRunLaunchpad({ ...base, items })).toBeNull();
  });

  test("never opens on a mapping probe or an optional challenge/stretch tail", () => {
    for (const lane of ["mapping", "challenge", "stretch"]) {
      const items = [item({ skillKey: "x", strand: "s", lane })];
      expect(selectRunLaunchpad({ ...base, items })).toBeNull();
    }
  });

  test("skips a strand the scholar already has mastery in (expertise reversal)", () => {
    const items = [
      item({ skillKey: "a", strand: "known" }),
      item({ skillKey: "b", strand: "fresh" }),
    ];
    const got = selectRunLaunchpad({
      ...base,
      items,
      hasMasteryInStrand: (_d, strand) => strand === "known",
    });
    expect(got!.strand).toBe("fresh");
    expect(got!.at).toBe(1);
  });

  test("skips a strand with no passed content rather than showing an empty card", () => {
    const items = [
      item({ skillKey: "a", strand: "uncontented" }),
      item({ skillKey: "b", strand: "contented" }),
    ];
    const got = selectRunLaunchpad({
      ...base,
      items,
      hasContent: (_d, strand) => strand === "contented",
    });
    expect(got!.strand).toBe("contented");
  });

  test("skips an unstranded item (no strand-level Launchpad in v1)", () => {
    expect(
      selectRunLaunchpad({ ...base, items: [item({ skillKey: "a", strand: undefined })] }),
    ).toBeNull();
  });

  test("honours the ≤1/day cap", () => {
    const eventByKey = new Map<string, InstructionEventLike>([
      ["strand:other:thing", { key: "strand:other:thing", shownAt: 1, lastShownDayBucket: "2026-07-24" }],
    ]);
    expect(
      selectRunLaunchpad({ ...base, eventByKey, items: [item({ skillKey: "a", strand: "s" })] }),
    ).toBeNull();
  });

  test("honours fire-once suppression and falls through to the next strand", () => {
    const key = strandInstructionKey("d", "seen");
    const eventByKey = new Map<string, InstructionEventLike>([
      [key, { key, viewedAt: 123 }],
    ]);
    const items = [item({ skillKey: "a", strand: "seen" }), item({ skillKey: "b", strand: "next" })];
    const got = selectRunLaunchpad({ ...base, eventByKey, items });
    expect(got!.strand).toBe("next");
  });

  test("domain-scopes the key so same-named strands across domains never collide", () => {
    const got = selectRunLaunchpad({
      ...base,
      items: [item({ skillKey: "a", strand: "ratio", domain: "fraction-arithmetic" })],
    });
    expect(got!.key).toBe("strand:fraction-arithmetic:ratio");
  });

  test("returns null for an empty run", () => {
    expect(selectRunLaunchpad({ ...base, items: [] })).toBeNull();
  });
});

describe("selectRunLaunchpad — the <=1/day governor is scoped to OTHER keys", () => {
  const items = [
    { skillKey: "s1", domain: "math", strand: "fractions", lane: "new" as const },
  ];
  const base = {
    items,
    hasMasteryInStrand: () => false,
    hasContent: () => true,
    dayBucket: "2026-07-24",
  };

  it("keeps offering THIS key after its own impression claim (no self-retraction)", () => {
    // The card claims `shownAt` for its own key on mount. If that retracted the
    // offer, the card would yank itself off-screen mid-decision.
    const key = strandInstructionKey("math", "fractions");
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([
        [key, { key, shownAt: 1, lastShownDayBucket: "2026-07-24", offerCount: 1 }],
      ]),
    });
    expect(out?.key).toBe(key);
  });

  it("still suppresses when a DIFFERENT strand was shown today", () => {
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([
        [
          strandInstructionKey("math", "ratio"),
          { key: strandInstructionKey("math", "ratio"), shownAt: 1, lastShownDayBucket: "2026-07-24", offerCount: 1 },
        ],
      ]),
    });
    expect(out).toBeNull();
  });

  it("re-offers tomorrow after a different strand was shown yesterday", () => {
    const out = selectRunLaunchpad({
      ...base,
      eventByKey: new Map([
        [
          strandInstructionKey("math", "ratio"),
          { key: strandInstructionKey("math", "ratio"), shownAt: 1, lastShownDayBucket: "2026-07-23", offerCount: 1 },
        ],
      ]),
    });
    expect(out?.key).toBe(strandInstructionKey("math", "fractions"));
  });

  it("retracts once the scholar actually engages with it", () => {
    const key = strandInstructionKey("math", "fractions");
    for (const engaged of [{ viewedAt: 2 }, { completedAt: 2 }, { dismissedAt: 2 }]) {
      const out = selectRunLaunchpad({
        ...base,
        eventByKey: new Map([
          [key, { key, shownAt: 1, lastShownDayBucket: "2026-07-24", offerCount: 1, ...engaged }],
        ]),
      });
      expect(out).toBeNull();
    }
  });
});

// ── selectRunLaunchpad — the NODE doorway (§4.1, Phase 2) ──────────────────
//
// A node doorway is the SAME positioned-sibling mechanics as the strand
// doorway, but keyed to a specific node when the scholar has zero mastery on
// THAT node — narrower than "zero mastery anywhere in the strand", which is
// exactly what lets a hard node re-open instruction inside an otherwise
// partly-known (or already-dismissed) strand. It shares the ≤1/day governor
// and the re-offer cap with the strand grain (one `eventByKey` map, one
// `nodeInstructionKey`/`strandInstructionKey` key space) rather than adding a
// second set of rules.
describe("selectRunLaunchpad — the NODE doorway (§4.1)", () => {
  const dayBucket = "2026-07-24";
  const noEvents = new Map<string, InstructionEventLike>();

  test("omitting hasMasteryOnNode/hasNodeContent disables the node doorway entirely (strand-only, byte-identical to pre-§4.1)", () => {
    const items = [item({ skillKey: "n1", strand: "known" })];
    const out = selectRunLaunchpad({
      items,
      hasMasteryInStrand: always, // the strand IS mastered — no strand doorway
      hasContent: never, // and no strand content either
      eventByKey: noEvents,
      dayBucket,
    });
    expect(out).toBeNull();
  });

  test("fires a node doorway when the strand has mastery but THIS node doesn't, and node content exists", () => {
    const items = [item({ skillKey: "hard_node", strand: "known" })];
    const out = selectRunLaunchpad({
      items,
      hasMasteryInStrand: always, // the strand as a whole is no longer new
      hasContent: never, // no strand-level content either
      hasMasteryOnNode: never, // but THIS node is zero-mastery
      hasNodeContent: always,
      eventByKey: noEvents,
      dayBucket,
    });
    expect(out).not.toBeNull();
    expect(out).toMatchObject({ level: "node", nodeKey: "hard_node", strand: "known" });
    expect(out!.key).toBe(nodeInstructionKey("hard_node"));
  });

  test("never fires a node doorway when the scholar already has mastery on that node", () => {
    const items = [item({ skillKey: "known_node", strand: "known" })];
    const out = selectRunLaunchpad({
      items,
      hasMasteryInStrand: always,
      hasContent: never,
      hasMasteryOnNode: always, // the node itself is already mastered
      hasNodeContent: always,
      eventByKey: noEvents,
      dayBucket,
    });
    expect(out).toBeNull();
  });

  test("never fires a node doorway when the node has no PASSED node-grain content", () => {
    const items = [item({ skillKey: "uncontented_node", strand: "known" })];
    const out = selectRunLaunchpad({
      items,
      hasMasteryInStrand: always,
      hasContent: never,
      hasMasteryOnNode: never,
      hasNodeContent: never, // no node-grain content stored/passed
      eventByKey: noEvents,
      dayBucket,
    });
    expect(out).toBeNull();
  });

  describe("precedence: STRAND wins over NODE at the same item (§4.1 decision c)", () => {
    test("when both a strand and a node doorway are eligible on the SAME item, the strand doorway is returned", () => {
      const items = [item({ skillKey: "n1", strand: "fresh" })];
      const out = selectRunLaunchpad({
        items,
        hasMasteryInStrand: never, // strand IS eligible (whole strand new)
        hasContent: always,
        hasMasteryOnNode: never, // node is ALSO eligible
        hasNodeContent: always,
        eventByKey: noEvents,
        dayBucket,
      });
      expect(out).toMatchObject({ level: "strand", strand: "fresh" });
      expect(out!.key).toBe(strandInstructionKey("d", "fresh"));
    });

    test("a suppressed strand doorway falls through to a still-eligible node doorway on the SAME item, not skipped to the next item", () => {
      const strandKey = strandInstructionKey("d", "seen");
      const items = [
        item({ skillKey: "hard_node", strand: "seen" }),
        item({ skillKey: "n2", strand: "next" }),
      ];
      const out = selectRunLaunchpad({
        items,
        hasMasteryInStrand: never,
        hasContent: always, // strand HAS content...
        hasMasteryOnNode: never,
        hasNodeContent: always,
        // ...but the strand doorway was already dismissed (permanently
        // suppressed) — the node doorway on the SAME item still fires,
        // rather than the selector moving on to the "next" strand.
        eventByKey: new Map([[strandKey, { key: strandKey, dismissedAt: 1 }]]),
        dayBucket,
      });
      expect(out).toMatchObject({ level: "node", nodeKey: "hard_node", strand: "seen" });
      expect(out!.at).toBe(0);
    });

    test("a strand doorway suppressed at item 0 with NO node fallback moves on to the next item's strand doorway", () => {
      const strandKey = strandInstructionKey("d", "seen");
      const items = [
        item({ skillKey: "a", strand: "seen" }),
        item({ skillKey: "b", strand: "next" }),
      ];
      const out = selectRunLaunchpad({
        items,
        hasMasteryInStrand: never,
        hasContent: always,
        // No node doorway support at all (undefined) — matches strand-only
        // callers exactly as before §4.1.
        eventByKey: new Map([[strandKey, { key: strandKey, dismissedAt: 1 }]]),
        dayBucket,
      });
      expect(out).toMatchObject({ level: "strand", strand: "next" });
    });
  });

  describe("governor sharing across key kinds (§4.1 decision b — extend, don't add)", () => {
    test("a NODE key shown today blocks a DIFFERENT item's STRAND doorway (shared ≤1/day)", () => {
      const nodeKey = nodeInstructionKey("other_node");
      const items = [item({ skillKey: "n1", strand: "fresh" })];
      const out = selectRunLaunchpad({
        items,
        hasMasteryInStrand: never,
        hasContent: always,
        eventByKey: new Map([
          [nodeKey, { key: nodeKey, shownAt: 1, lastShownDayBucket: dayBucket, offerCount: 1 }],
        ]),
        dayBucket,
      });
      expect(out).toBeNull();
    });

    test("a STRAND key shown today blocks a DIFFERENT item's NODE doorway (shared ≤1/day)", () => {
      const strandKey = strandInstructionKey("math", "other-strand");
      const items = [item({ skillKey: "hard_node", strand: "known" })];
      const out = selectRunLaunchpad({
        items,
        hasMasteryInStrand: always,
        hasContent: never,
        hasMasteryOnNode: never,
        hasNodeContent: always,
        eventByKey: new Map([
          [strandKey, { key: strandKey, shownAt: 1, lastShownDayBucket: dayBucket, offerCount: 1 }],
        ]),
        dayBucket,
      });
      expect(out).toBeNull();
    });

    test("a node doorway keeps offering ITSELF after its own impression claim (no self-retraction, same as strand)", () => {
      const key = nodeInstructionKey("hard_node");
      const items = [item({ skillKey: "hard_node", strand: "known" })];
      const out = selectRunLaunchpad({
        items,
        hasMasteryInStrand: always,
        hasContent: never,
        hasMasteryOnNode: never,
        hasNodeContent: always,
        eventByKey: new Map([[key, { key, shownAt: 1, lastShownDayBucket: dayBucket, offerCount: 1 }]]),
        dayBucket,
      });
      expect(out?.key).toBe(key);
    });

    test("a node doorway's own re-offer cap (offerCount<=3) suppresses it exactly like a strand's", () => {
      const key = nodeInstructionKey("hard_node");
      const items = [item({ skillKey: "hard_node", strand: "known" })];
      const out = selectRunLaunchpad({
        items,
        hasMasteryInStrand: always,
        hasContent: never,
        hasMasteryOnNode: never,
        hasNodeContent: always,
        eventByKey: new Map([
          [key, { key, shownAt: 1, initialChoice: "try", offerCount: INSTRUCTION_REOFFER_CAP }],
        ]),
        dayBucket,
      });
      expect(out).toBeNull();
    });
  });
});
