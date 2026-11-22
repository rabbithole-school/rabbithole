import { describe, expect, it, test } from "vitest";
import {
  segmentBeatLabel,
  segmentBeatVisibleForKind,
  mappingHeaderLabel,
} from "./practiceSegments";

describe("segmentBeatLabel", () => {
  it("names every kind, including the one that used to fall through", () => {
    expect(segmentBeatLabel("manipulative", true)).toBe("Build it");
    expect(segmentBeatLabel("choice", true)).toBe("Your pick");
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
    // work, and silent as the only segment.
    expect(segmentBeatVisibleForKind(2, "fact_sprint")).toBe(true);
    expect(segmentBeatVisibleForKind(1, "fact_sprint")).toBe(false);
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
