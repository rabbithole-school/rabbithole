import { describe, it, expect } from "vitest";
import {
  buildFactSprint,
  MIN_FACT_SPRINT_ITEMS,
  MAX_FACT_SPRINT_ITEMS,
  MIN_SEEN_FOR_SPRINT,
  type SprintFamily,
  type SprintFactRow,
} from "../factSprint";
import { LATENCY_FLUENT_TOLERANCE } from "../scheduler";
import { factKeyFromOperands } from "../../../../shared/factKey";
import {
  FACT_MIN_LATENCY_SAMPLES,
  type FactFluencyStats,
} from "../factFluency";
import { parseItemId } from "../session";
import { generateItem } from "../templates";

const MUL789: SprintFamily = {
  skillKey: "mult_facts_7_8_9",
  label: "× 7–9",
  domain: "math",
};

// Facts that live in the mult_facts_7_8_9 generator space (see the probe in
// the summary — all reachable by a bounded seed search).
const WEAK_MUL = ["mul:7x8", "mul:8x9", "mul:7x9", "mul:6x8", "mul:6x9", "mul:8x8"];

function row(
  factKey: string,
  stats: Partial<FactFluencyStats>,
  skillKey = MUL789.skillKey,
): SprintFactRow {
  return {
    factKey,
    skillKey,
    stats: { seenCount: 6, correctCount: 6, ...stats },
  };
}

/** An effortful fact: reliably attempted but often wrong (accuracy < 0.67). */
const effortful = (factKey: string) => row(factKey, { seenCount: 6, correctCount: 2 });
/** A practicing fact: reliably correct but no speed read (baseline undefined
 *  caps at practicing regardless of latency). */
const practicing = (factKey: string) => row(factKey, { seenCount: 6, correctCount: 6 });

function build(
  factRows: SprintFactRow[],
  opts: {
    families?: SprintFamily[];
    baseline?: number;
    served?: string[];
    seed?: number;
    maxItems?: number;
  } = {},
) {
  return buildFactSprint({
    families: opts.families ?? [MUL789],
    factRows,
    baseline: opts.baseline,
    alreadyServedFactKeys: new Set(opts.served ?? []),
    seed: opts.seed ?? 12345,
    maxItems: opts.maxItems,
  });
}

describe("buildFactSprint — dormancy (no false positives)", () => {
  it("returns [] when there are no fact rows", () => {
    expect(build([])).toEqual([]);
  });

  it("returns [] when there are no active families", () => {
    expect(build([effortful("mul:7x8"), effortful("mul:8x9")], { families: [] })).toEqual([]);
  });

  it("returns [] when every eligible fact is already strong", () => {
    // Strong = fluent/automatic: needs a real baseline + fast, accurate samples.
    const baseline = 2000;
    const fast = baseline * 0.4; // well under the fluent band
    const strong = (fk: string): SprintFactRow =>
      row(fk, {
        seenCount: 10,
        correctCount: 10,
        latencySamplesMs: [fast, fast, fast, fast],
        latencyMedianMs: fast,
      });
    expect(
      build([strong("mul:7x8"), strong("mul:8x9"), strong("mul:7x9")], { baseline }),
    ).toEqual([]);
  });

  it("returns [] when only one weak fact is eligible (below the min beat size)", () => {
    expect(build([effortful("mul:7x8"), practicing("mul:8x9")], { served: ["mul:8x9"] }))
      .toEqual([]);
  });

  it("ignores facts below the min-seen threshold", () => {
    const barely = (fk: string) =>
      row(fk, { seenCount: MIN_SEEN_FOR_SPRINT - 1, correctCount: 0 });
    expect(build([barely("mul:7x8"), barely("mul:8x9"), barely("mul:7x9")])).toEqual([]);
  });

  it("ignores fact rows from a family not in the run", () => {
    const foreign = row("add:3+4", { seenCount: 6, correctCount: 1 }, "add_within_10");
    expect(build([foreign, foreign])).toEqual([]);
  });
});

describe("buildFactSprint — selection", () => {
  it("targets the weak facts and marks them as a sprint block", () => {
    const rows = WEAK_MUL.slice(0, 3).map(effortful);
    const items = build(rows);
    expect(items.length).toBeGreaterThanOrEqual(MIN_FACT_SPRINT_ITEMS);
    expect(items.length).toBeLessThanOrEqual(3);
    for (const item of items) {
      expect(item.isFactSprint).toBe(true);
      expect(item.lane).toBe("new");
      expect(item.skillKey).toBe(MUL789.skillKey);
      // The regenerated operands must be exactly the fact the item claims.
      expect(item.factKey).toBeDefined();
      const parsed = parseItemId(item.itemId);
      const generated = parsed
        ? generateItem(parsed.skillKey, parsed.seed, parsed.form)
        : null;
      expect(generated?.variant).toBeDefined();
      expect(
        generated?.variant
          ? factKeyFromOperands(
              generated.variant.a,
              generated.variant.op,
              generated.variant.b,
            )
          : null,
      ).toBe(item.factKey);
      expect(WEAK_MUL).toContain(item.factKey);
      expect(item.stem).toMatch(/^\s*\d+\s*×\s*\d+\s*=/);
    }
    // No duplicate facts within one sprint.
    const keys = items.map((i) => i.factKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never serves more than the cap", () => {
    const rows = WEAK_MUL.map(effortful); // 6 weak facts
    const items = build(rows);
    expect(items.length).toBeLessThanOrEqual(MAX_FACT_SPRINT_ITEMS);
  });

  it("honors an explicit lower maxItems", () => {
    const rows = WEAK_MUL.map(effortful);
    const items = build(rows, { maxItems: 2 });
    expect(items.length).toBe(2);
  });

  it("excludes facts already on the board this run", () => {
    const rows = WEAK_MUL.slice(0, 4).map(effortful);
    const served = [WEAK_MUL[0], WEAK_MUL[1]];
    const items = build(rows, { served });
    for (const item of items) {
      expect(served).not.toContain(item.factKey);
    }
  });

  it("prefers effortful facts over practicing ones when capped", () => {
    const rows = [
      effortful("mul:7x8"),
      effortful("mul:8x9"),
      practicing("mul:7x9"),
      practicing("mul:6x8"),
    ];
    const items = build(rows, { maxItems: 2 });
    const keys = items.map((i) => i.factKey);
    expect(keys).toContain("mul:7x8");
    expect(keys).toContain("mul:8x9");
  });

  it("is deterministic in its seed", () => {
    const rows = WEAK_MUL.slice(0, 3).map(effortful);
    const a = build(rows, { seed: 999 }).map((i) => i.itemId);
    const b = build(rows, { seed: 999 }).map((i) => i.itemId);
    expect(a).toEqual(b);
  });

  it("stays dormant for practicing facts when the scholar has no baseline", () => {
    // Baseline-unknown caps reliable facts at practicing, but that is not a
    // weak-fact signal: the scholar may simply be new.
    const rows = WEAK_MUL.slice(0, 3).map(practicing);
    const items = build(rows, { baseline: undefined });
    expect(items).toEqual([]);
  });

  it("stays dormant with a known baseline but too few fast fact samples", () => {
    const baseline = 1000;
    const rows = WEAK_MUL.slice(0, 3).map((fk) =>
      row(fk, {
        seenCount: 2,
        correctCount: 2,
        latencySamplesMs: [500, 500],
        latencyMedianMs: 500,
      }),
    );
    expect(build(rows, { baseline })).toEqual([]);
  });

  it("activates for practicing facts when a known baseline shows they are slow", () => {
    const baseline = 1000;
    const slow = baseline * LATENCY_FLUENT_TOLERANCE * 2; // clearly outside fluent band
    const rows = WEAK_MUL.slice(0, 3).map((fk) =>
      row(fk, {
        seenCount: 8,
        correctCount: 8,
        latencySamplesMs: Array(FACT_MIN_LATENCY_SAMPLES).fill(slow),
        latencyMedianMs: slow,
      }),
    );
    const items = build(rows, { baseline });
    expect(items.length).toBeGreaterThanOrEqual(MIN_FACT_SPRINT_ITEMS);
  });
});
