import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  initialPlaceValue,
  isSolved,
  placeValueShift,
  placeValueSolved,
  placeValueTotal,
} from "../logic";
import { assertGradableManipulative, isGradableManipulative } from "../authoring";
import type { PlaceValueSpec } from "../types";

/**
 * Pure-logic tests for the `placeValue` manipulative (lib/manipulative). Locks
 * the two self-check shapes both ways — the intended solution passes and the
 * mount state does NOT — plus the ×10/÷10 shift move, the canonical-digit
 * guard (a regrouped total is rejected), and the authoring gradability gate.
 */

const buildSpec = (over: Partial<PlaceValueSpec> = {}): PlaceValueSpec => ({
  kind: "placeValue",
  id: "pv-test",
  mode: "buildNumber",
  concept: "Place value",
  prompt: "Build the number.",
  places: [100, 10, 1],
  goal: { type: "buildValue", value: 437 },
  ...over,
});

const shiftSpec = (over: Partial<PlaceValueSpec> = {}): PlaceValueSpec => ({
  kind: "placeValue",
  id: "pv-shift",
  mode: "placeShift",
  concept: "Powers of ten",
  prompt: "Shift it.",
  places: [100, 10, 1],
  start: [0, 0, 5],
  goal: { type: "shiftTo", value: 50 },
  ...over,
});

describe("placeValueTotal", () => {
  it("weights each column by its place value", () => {
    expect(placeValueTotal(buildSpec(), [4, 3, 7])).toBe(437);
    expect(placeValueTotal(buildSpec({ places: [10, 1] }), [4, 7])).toBe(47);
    expect(placeValueTotal(buildSpec(), [0, 0, 0])).toBe(0);
  });
});

describe("placeValueSolved — buildNumber / expandedForm (buildValue)", () => {
  it("is solved by the canonical decomposition of the target", () => {
    const spec = buildSpec();
    expect(placeValueSolved(spec, { counts: [4, 3, 7] })).toBe(true);
    expect(isSolved(spec, { counts: [4, 3, 7] })).toBe(true);
  });

  it("is NOT solved on the initial (empty) mount state", () => {
    const spec = buildSpec();
    expect(placeValueSolved(spec, initialPlaceValue(spec))).toBe(false);
    expect(initialPlaceValue(spec).counts).toEqual([0, 0, 0]);
  });

  it("rejects a REGROUPED total (3 hundreds, 13 tens, 7 ones = 437 but not canonical)", () => {
    // Same total, non-standard build — the standard-form skill requires single
    // digits per place, so this must fail even though it sums to 437.
    expect(placeValueSolved(buildSpec(), { counts: [3, 13, 7] })).toBe(false);
  });

  it("rejects a wrong total and a mismatched-length state", () => {
    const spec = buildSpec();
    expect(placeValueSolved(spec, { counts: [4, 3, 8] })).toBe(false);
    expect(placeValueSolved(spec, { counts: [4, 3] })).toBe(false);
    expect(placeValueSolved(spec, { counts: [4, 3, 7, 1] })).toBe(false);
  });

  it("honors an explicit maxPerPlace as the canonical cap", () => {
    const spec = buildSpec({ maxPerPlace: 9 });
    expect(placeValueSolved(spec, { counts: [4, 3, 7] })).toBe(true);
  });

  it("grades expandedForm with the same buildValue predicate", () => {
    const spec = buildSpec({ mode: "expandedForm", goal: { type: "buildValue", value: 347 } });
    expect(placeValueSolved(spec, initialPlaceValue(spec))).toBe(false);
    expect(placeValueSolved(spec, { counts: [3, 4, 7] })).toBe(true);
  });
});

describe("placeValueShift + placeShift solving", () => {
  it("×10 slides every digit one column up, filling ones with 0", () => {
    const spec = shiftSpec();
    expect(placeValueShift(spec, [0, 0, 5], "up")).toEqual([0, 5, 0]);
    expect(placeValueShift(spec, [0, 5, 0], "up")).toEqual([5, 0, 0]);
  });

  it("×10 is illegal when the top column would overflow", () => {
    const spec = shiftSpec();
    expect(placeValueShift(spec, [5, 0, 0], "up")).toBeNull();
  });

  it("÷10 slides down but is illegal when a ones digit would be lost", () => {
    const spec = shiftSpec();
    expect(placeValueShift(spec, [0, 5, 0], "down")).toEqual([0, 0, 5]);
    expect(placeValueShift(spec, [0, 0, 5], "down")).toBeNull();
  });

  it("is not pre-solved and is solved after the ×10 shift reaches the target", () => {
    const spec = shiftSpec();
    expect(placeValueSolved(spec, initialPlaceValue(spec))).toBe(false);
    const shifted = placeValueShift(spec, initialPlaceValue(spec).counts, "up")!;
    expect(placeValueSolved(spec, { counts: shifted })).toBe(true);
    expect(isSolved(spec, { counts: shifted })).toBe(true);
  });

  it("rejects a NON-RENDERABLE shiftTo state that hits the total off-column (finding 3)", () => {
    // "50 ones" ([0,0,50]) totals 50 for the "5 → 50" task, but the ×10/÷10
    // controls can never produce a multi-digit column — grade the canonical
    // single-digit decomposition, not the bare total.
    const spec = shiftSpec();
    expect(placeValueTotal(spec, [0, 0, 50])).toBe(50); // same total…
    expect(placeValueSolved(spec, { counts: [0, 0, 50] })).toBe(false); // …still rejected
    // The genuinely reachable "5 tens" configuration is the only pass.
    expect(placeValueSolved(spec, { counts: [0, 5, 0] })).toBe(true);
  });

  it("solves a ×100 (two-step) shift", () => {
    const spec = shiftSpec({
      places: [10000, 1000, 100, 10, 1],
      start: [0, 0, 0, 4, 3],
      goal: { type: "shiftTo", value: 4300 },
    });
    let counts = initialPlaceValue(spec).counts;
    expect(placeValueSolved(spec, { counts })).toBe(false);
    counts = placeValueShift(spec, counts, "up")!;
    expect(placeValueSolved(spec, { counts })).toBe(false); // only 430 so far
    counts = placeValueShift(spec, counts, "up")!;
    expect(placeValueSolved(spec, { counts })).toBe(true);
  });
});

describe("isGradableManipulative — placeValue gate", () => {
  it("accepts a well-formed buildValue and shiftTo spec", () => {
    expect(isGradableManipulative(buildSpec())).toBe(true);
    expect(isGradableManipulative(shiftSpec())).toBe(true);
    expect(() => assertGradableManipulative(buildSpec())).not.toThrow();
  });

  it("rejects a missing goal", () => {
    expect(isGradableManipulative(buildSpec({ goal: undefined }))).toBe(false);
  });

  // The chart never wraps, so the columns share the stage width instead of
  // dropping to a second row — which makes "how many places" a RENDERABILITY
  // question, not just a math one. Six fit the narrowest real stage (the 460px
  // web practice column); seven would clip.
  it("accepts six places but rejects seven — the non-wrapping chart's ceiling", () => {
    expect(
      isGradableManipulative(
        buildSpec({ places: [100000, 10000, 1000, 100, 10, 1], goal: { type: "buildValue", value: 534125 } }),
      ),
    ).toBe(true);
    expect(
      isGradableManipulative(
        buildSpec({
          places: [1000000, 100000, 10000, 1000, 100, 10, 1],
          goal: { type: "buildValue", value: 6534125 },
        }),
      ),
    ).toBe(false);
  });

  it("rejects non-power-of-ten / non-consecutive / non-descending columns", () => {
    expect(isGradableManipulative(buildSpec({ places: [100, 1] }))).toBe(false); // missing tens
    expect(isGradableManipulative(buildSpec({ places: [1, 10, 100] }))).toBe(false); // ascending
    expect(isGradableManipulative(buildSpec({ places: [50, 10, 1] }))).toBe(false); // not power of ten
  });

  it("rejects a target that can't fit the columns canonically", () => {
    // 1437 needs a thousands column the [100,10,1] spec doesn't have.
    expect(isGradableManipulative(buildSpec({ goal: { type: "buildValue", value: 1437 } }))).toBe(false);
  });

  it("rejects a pre-solved spec (target 0 on an empty build)", () => {
    expect(isGradableManipulative(buildSpec({ goal: { type: "buildValue", value: 0 } }))).toBe(false);
  });

  it("rejects an UNREACHABLE placeShift target (not start · 10^k)", () => {
    // 5 can reach 50/500 by ×10, never 60.
    expect(isGradableManipulative(shiftSpec({ goal: { type: "shiftTo", value: 60 } }))).toBe(false);
  });

  it("rejects a mode/goal combo the mode's controls cannot reach (finding 1)", () => {
    // placeShift has no steppers, so a buildValue goal is unreachable; the
    // build modes have no ×10/÷10, so a shiftTo goal is unreachable. Both must
    // be rejected at authoring time even though each is gradable on paper.
    expect(
      isGradableManipulative(shiftSpec({ goal: { type: "buildValue", value: 50 } })),
    ).toBe(false);
    expect(
      isGradableManipulative(buildSpec({ mode: "buildNumber", goal: { type: "shiftTo", value: 437 } })),
    ).toBe(false);
    expect(
      isGradableManipulative(buildSpec({ mode: "expandedForm", goal: { type: "shiftTo", value: 437 } })),
    ).toBe(false);
    // The legal pairings still pass.
    expect(isGradableManipulative(buildSpec({ mode: "buildNumber" }))).toBe(true);
    expect(isGradableManipulative(buildSpec({ mode: "expandedForm" }))).toBe(true);
    expect(isGradableManipulative(shiftSpec())).toBe(true);
    expect(() => assertGradableManipulative(shiftSpec({ goal: { type: "buildValue", value: 50 } }))).toThrow();
  });
});

/**
 * Finding 2 — Done must be DISABLED at mount: the renderer must not emit runtime
 * state before a real interaction, or the frame (which enables Done as soon as
 * `state !== null`) would let a scholar commit an immediate, recordable miss
 * without touching the material. Native already waited (it emits only from its
 * interaction handlers); the web renderer used to emit in a mount `useEffect`.
 *
 * There is no DOM/React test harness in this repo (no jsdom / RTL /
 * react-test-renderer), and the task forbids adding one. This pins the exact
 * regression at the source level instead: BOTH renderers must have NO mount
 * emission (no `useEffect`) and route `onStateChange` through a single
 * interaction seam (the shared `commit` handler) — the same "emit only on
 * interaction" contract the wave-2 function-machine fix established.
 */
describe("placeValue renderers — no state emission at mount (Done disabled until interaction)", () => {
  const web = readFileSync("components/manipulative/kinds/PlaceValueManipulative.tsx", "utf8");
  const native = readFileSync("native/src/components/manipulatives/PlaceValue.native.tsx", "utf8");

  it("the web renderer has no mount useEffect (the old on-mount emit vector)", () => {
    expect(web).not.toMatch(/useEffect/);
  });

  // Left-to-right order across the place columns IS the base-ten idea, so a
  // wrapped chart (hundreds/tens on one row, ones orphaned below) doesn't just
  // look cramped — it destroys what the manipulative teaches. Both renderers
  // shipped with `wrap` and wrapped in EVERY container the app has, including
  // the frame's own max width. Source-level, for the no-DOM-harness reason above.
  it("neither renderer lets the place columns wrap", () => {
    expect(web).toMatch(/wrap="nowrap"[\s\S]*?spec\.places\.map/);
    expect(native).toMatch(/flexWrap: "nowrap"/);
    expect(native).not.toMatch(/flexWrap: "wrap"[\s\S]*?col:/);
  });

  it("both renderers emit onStateChange exactly once, from the shared commit seam", () => {
    for (const src of [web, native]) {
      const emits = src.match(/onStateChange\?\.\(/g) ?? [];
      expect(emits.length).toBe(1);
      // The single emit lives inside the `commit` handler, next to the
      // optimistic onSolvedChange — never in a mount effect.
      expect(src).toMatch(/const commit = \([\s\S]*?onSolvedChange\([\s\S]*?onStateChange\?\.\(/);
    }
  });
});
