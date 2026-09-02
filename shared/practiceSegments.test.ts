import { describe, expect, it, test } from "vitest";
import {
  segmentBeatLabel,
  segmentBeatVisibleForKind,
  mappingHeaderLabel,
  withLaunchpadSegment,
  withLaunchpadRow,
  type Segment,
} from "./practiceSegments";

/** Graded item count — the launchpad is ungraded and never counted. */
const gradedCount = (segs: Segment[]) =>
  segs.filter((s) => s.kind !== "launchpad").reduce((n, s) => n + s.count, 0);

describe("segmentBeatLabel", () => {
  it("names every kind, including the one that used to fall through", () => {
    expect(segmentBeatLabel("manipulative", true)).toBe("Build it");
    expect(segmentBeatLabel("choice", true)).toBe("Your pick");
    expect(segmentBeatLabel("launchpad", true)).toBe("First look");
    // "stretch" existed on the server but NEITHER client declared it, so it
    // silently rendered the core_drill label. It has its own words now.
    expect(segmentBeatLabel("stretch", true)).toBe("Go deeper");
    expect(segmentBeatLabel("fact_sprint", true)).toBe("Fast math");
    expect(segmentBeatLabel("fact_sprint", false)).toBe("Fast math");
    expect(segmentBeatLabel("core_drill", true)).toBe("Warm-up");
    expect(segmentBeatLabel("core_drill", false)).toBe("Keep going");
  });
});

describe("segmentBeatVisibleForKind", () => {
  it("keeps the existing gate for ordinary kinds", () => {
    expect(segmentBeatVisibleForKind(1, "core_drill")).toBe(false);
    expect(segmentBeatVisibleForKind(2, "core_drill")).toBe(true);
    expect(segmentBeatVisibleForKind(3, "mapping")).toBe(false);
  });

  it("announces a fact_sprint beat like an ordinary multi-segment beat", () => {
    // A "Fast math" block is a normal announced beat when it seams with other
    // work, and (like any non-launchpad kind) silent as the only segment.
    expect(segmentBeatVisibleForKind(2, "fact_sprint")).toBe(true);
    expect(segmentBeatVisibleForKind(1, "fact_sprint")).toBe(false);
  });

  it("always announces a launchpad, even as the only segment", () => {
    expect(segmentBeatVisibleForKind(1, "launchpad")).toBe(true);
  });
});

describe("withLaunchpadSegment", () => {
  const base: Segment[] = [
    { kind: "core_drill", count: 3 },
    { kind: "choice", count: 5 },
  ];

  it("is a no-op when there is no launchpad", () => {
    expect(withLaunchpadSegment(base, undefined)).toEqual(base);
  });

  it("splices at a segment boundary without disturbing the runs", () => {
    expect(withLaunchpadSegment(base, 3)).toEqual([
      { kind: "core_drill", count: 3 },
      { kind: "launchpad", count: 1 },
      { kind: "choice", count: 5 },
    ]);
  });

  it("splices at the very front", () => {
    expect(withLaunchpadSegment(base, 0)).toEqual([
      { kind: "launchpad", count: 1 },
      { kind: "core_drill", count: 3 },
      { kind: "choice", count: 5 },
    ]);
  });

  it("splits a run when the launchpad lands inside it", () => {
    expect(withLaunchpadSegment(base, 1)).toEqual([
      { kind: "core_drill", count: 1 },
      { kind: "launchpad", count: 1 },
      { kind: "core_drill", count: 2 },
      { kind: "choice", count: 5 },
    ]);
  });

  it("appends when the launchpad sits just past the last item", () => {
    expect(withLaunchpadSegment(base, 8)).toEqual([...base, { kind: "launchpad", count: 1 }]);
  });

  it("leaves the list untouched when `at` is out of range", () => {
    // A stale snapshot must never corrupt the grouping.
    expect(withLaunchpadSegment(base, 99)).toEqual(base);
    expect(withLaunchpadSegment(base, -1)).toEqual(base);
  });

  it("preserves the graded-item count for every insertion point", () => {
    // The invariant that keeps `segmentStartIdx` honest: inserting an UNGRADED
    // beat must never change how many graded items the segments describe.
    for (let at = 0; at <= 8; at++) {
      expect(gradedCount(withLaunchpadSegment(base, at))).toBe(8);
    }
  });

  it("inserts exactly one launchpad segment, ever", () => {
    for (let at = 0; at <= 8; at++) {
      const got = withLaunchpadSegment(base, at).filter((s) => s.kind === "launchpad");
      expect(got.length).toBe(1);
    }
  });

  it("handles an empty segment list (a run with no items yet)", () => {
    expect(withLaunchpadSegment([], 0)).toEqual([{ kind: "launchpad", count: 1 }]);
    expect(withLaunchpadSegment([], 3)).toEqual([]);
  });
});

// ── Coverage migrated from components/practice/mappingSegmentBeat.test.ts when
// these predicates moved to their single cross-surface owner. ─────────────
// Segment-beat visibility: a beat header shows once per segment (see the JSX in
// components/practice/PracticeSession.tsx and native/src/app/practice.tsx) only
// when there's more than one segment AND the segment isn't `· mapping`. A mapping
// segment renders NO beat — its identity lives in the per-item header marker
// alone (founder amendment 2026-07-19 #2, superseding the earlier "reassurance
// once per mapping segment" ruling).
describe("segmentBeatVisibleForKind — mapping/ceremony rules", () => {
  test("a single-segment all-mapping run shows NO beat (founder amendment 2026-07-19 #2)", () => {
    // segments = [{ kind: "mapping", count: N }] → length 1, kind "mapping".
    expect(segmentBeatVisibleForKind(1, "mapping")).toBe(false);
  });

  test("a single-segment NON-mapping run shows no beat (nothing to announce)", () => {
    expect(segmentBeatVisibleForKind(1, "core_drill")).toBe(false);
    expect(segmentBeatVisibleForKind(1, "manipulative")).toBe(false);
    expect(segmentBeatVisibleForKind(1, undefined)).toBe(false);
  });

  test("a multi-segment run shows beats for non-mapping segments", () => {
    expect(segmentBeatVisibleForKind(3, "core_drill")).toBe(true);
    expect(segmentBeatVisibleForKind(2, "choice")).toBe(true);
  });

  test("a mapping segment renders no beat even inside a multi-segment run", () => {
    expect(segmentBeatVisibleForKind(2, "mapping")).toBe(false);
    expect(segmentBeatVisibleForKind(3, "mapping")).toBe(false);
  });
});

// Founder amendment (2026-07-19): ceremony HEADER, not ceremony block. The
// all-mapping "Math Check-In" run relabels its per-item mapping marker to
// `· math check-in` (a special case of mapping); blended runs keep `· mapping`.
// Locks the web chip label the drill renders (see the JSX in
// components/practice/PracticeSession.tsx); native mirrors the same swap in its
// uppercase eyebrow idiom.
describe("mappingHeaderLabel (founder amendment 2026-07-19)", () => {
  test("an all-mapping ceremony run reads `· math check-in`", () => {
    expect(mappingHeaderLabel(true)).toBe("· math check-in");
  });

  test("a blended run keeps `· mapping` on its mapping items", () => {
    expect(mappingHeaderLabel(false)).toBe("· mapping");
  });
});


// The HOME-PREVIEW twin of `withLaunchpadSegment`. Both surfaces render the
// playlist card from this one splice, so a doorway can't sit third on the web
// and first on iPad. The dot rule is the load-bearing part: the doorway is
// served BEFORE the item it introduces, so when it leads it must take the
// "next" dot and demote the skill behind it — otherwise the receipt states an
// order the run won't follow, which is the exact defect this closes.
describe("withLaunchpadRow (home preview)", () => {
  type Row = { key: string; kind: string; tag: string; queuedTag: string };
  // Every row carries BOTH captions, exactly as the cards build them: what it
  // reads now, and what it must read once something is inserted ahead of it.
  const rows = (...kinds: string[]): Row[] =>
    kinds.map((k, i) => ({
      key: `r${i}`,
      kind: k,
      tag: k === "next" ? "Next up" : k === "done" ? "Done this block" : "In your set",
      queuedTag: k === "done" ? "Done this block" : "In your set",
    }));
  const make = (kind: "next" | "queued"): Row => ({
    key: "launchpad",
    kind,
    tag: "First look",
    queuedTag: "First look",
  });

  test("leading the list, it takes the next dot and demotes the skill behind it", () => {
    const out = withLaunchpadRow(rows("next", "queued"), 0, make);
    expect(out.map((r) => [r.key, r.kind])).toEqual([
      ["launchpad", "next"],
      ["r0", "queued"],
      ["r1", "queued"],
    ]);
  });

  test("REGRESSION: the demoted row loses the `Next up` CAPTION, not just the dot", () => {
    // Rewriting only the dot leaves the receipt reading "First look · next" over
    // "<skill> · Next up" — two next things, the same contradiction this whole
    // change exists to remove, in different paint.
    const out = withLaunchpadRow(rows("next", "queued"), 0, make);
    expect(out.map((r) => r.tag)).toEqual(["First look", "In your set", "In your set"]);
  });

  test("a demoted DONE row keeps its own caption, not a queued one", () => {
    const out = withLaunchpadRow(rows("done", "next"), 1, make);
    expect(out.map((r) => [r.key, r.kind, r.tag])).toEqual([
      ["r0", "done", "Done this block"],
      ["launchpad", "next", "First look"],
      ["r1", "queued", "In your set"],
    ]);
  });

  test("mid-list it is queued and nothing else changes", () => {
    const out = withLaunchpadRow(rows("next", "queued", "queued"), 2, make);
    expect(out.map((r) => [r.key, r.kind, r.tag])).toEqual([
      ["r0", "next", "Next up"],
      ["r1", "queued", "In your set"],
      ["launchpad", "queued", "First look"],
      ["r2", "queued", "In your set"],
    ]);
  });

  test("behind only finished rows it still leads — a done row never holds `next`", () => {
    const out = withLaunchpadRow(rows("done", "next"), 1, make);
    expect(out.map((r) => [r.key, r.kind])).toEqual([
      ["r0", "done"],
      ["launchpad", "next"],
      ["r1", "queued"],
    ]);
  });

  test("an out-of-range index appends rather than dropping the beat", () => {
    const out = withLaunchpadRow(rows("next"), 99, make);
    expect(out.map((r) => r.key)).toEqual(["r0", "launchpad"]);
  });

  test("an empty list still yields the doorway, holding the next slot", () => {
    expect(withLaunchpadRow([] as Row[], 0, make).map((r) => [r.key, r.kind])).toEqual([
      ["launchpad", "next"],
    ]);
  });

  test("the input list is never mutated", () => {
    const input = rows("next", "queued");
    withLaunchpadRow(input, 0, make);
    expect(input.map((r) => [r.key, r.kind, r.tag])).toEqual([
      ["r0", "next", "Next up"],
      ["r1", "queued", "In your set"],
    ]);
  });
});
