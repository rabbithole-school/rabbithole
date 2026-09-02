import { describe, expect, it } from "vitest";
import {
  mergeDomainQueues,
  roundRobin,
  type MergeableDomainQueue,
} from "./mixedQueue";

const WNA = "whole-number-arithmetic";
const FRAC = "fraction-arithmetic";
const PROB = "probability";

/** Build a per-domain queue from a compact spec. `retention` defaults spread
 *  the entries so ordering is deterministic. */
function q(
  domain: string,
  entries: { key: string; reason: "review" | "new"; retention?: number }[],
): MergeableDomainQueue {
  return {
    domain,
    entries: entries.map((e) => ({ key: e.key, reason: e.reason, retention: e.retention ?? 1 })),
  };
}

describe("roundRobin", () => {
  it("interleaves lists, preserving each list's internal order", () => {
    expect(roundRobin([["a1", "a2", "a3"], ["b1", "b2"]])).toEqual([
      "a1",
      "b1",
      "a2",
      "b2",
      "a3",
    ]);
  });

  it("handles empty and single lists", () => {
    expect(roundRobin([])).toEqual([]);
    expect(roundRobin([[], ["b1"]])).toEqual(["b1"]);
    expect(roundRobin([["a1", "a2"]])).toEqual(["a1", "a2"]);
  });
});

describe("mergeDomainQueues", () => {
  it("a single domain passes through unchanged (pre-mixed behavior)", () => {
    const only = q(WNA, [
      { key: "add_within_20", reason: "review" },
      { key: "count_to_10", reason: "new" },
    ]);
    const merged = mergeDomainQueues([only], 12);
    expect(merged).toEqual([
      { domain: WNA, key: "add_within_20" },
      { domain: WNA, key: "count_to_10" },
    ]);
  });

  it("due reviews win ahead of frontier work, ranked GLOBALLY most-decayed-first", () => {
    // WNA has the most-decayed review (retention 0.1); FRAC a fresher one (0.5).
    const wna = q(WNA, [{ key: "wna_review", reason: "review", retention: 0.1 }]);
    const frac = q(FRAC, [{ key: "frac_review", reason: "review", retention: 0.5 }]);
    const merged = mergeDomainQueues([wna, frac], 12);
    // No frontier work → all reviews, ordered by decay (lowest retention first).
    expect(merged.map((e) => e.key)).toEqual(["wna_review", "frac_review"]);
  });

  it("global review ranking ignores which domain a fading fact lives in", () => {
    const wna = q(WNA, [
      { key: "wna_fresh", reason: "review", retention: 0.9 },
      { key: "wna_stale", reason: "review", retention: 0.05 },
    ]);
    const frac = q(FRAC, [{ key: "frac_mid", reason: "review", retention: 0.4 }]);
    const merged = mergeDomainQueues([wna, frac], 12);
    expect(merged.map((e) => e.key)).toEqual(["wna_stale", "frac_mid", "wna_fresh"]);
  });

  it("frontier work round-robins across domains for balance", () => {
    const wna = q(WNA, [
      { key: "wna_a", reason: "new" },
      { key: "wna_b", reason: "new" },
    ]);
    const frac = q(FRAC, [
      { key: "frac_a", reason: "new" },
      { key: "frac_b", reason: "new" },
    ]);
    const merged = mergeDomainQueues([wna, frac], 12);
    // No reviews → pure round-robin: one from each domain, alternating.
    expect(merged.map((e) => e.key)).toEqual(["wna_a", "frac_a", "wna_b", "frac_b"]);
  });

  it("gives the preferred domain ×2 frontier weight without changing global review order", () => {
    const wna = q(WNA, [
      { key: "wna_review", reason: "review", retention: 0.1 },
      { key: "wna_a", reason: "new" },
      { key: "wna_b", reason: "new" },
    ]);
    const frac = q(FRAC, [
      { key: "frac_review", reason: "review", retention: 0.2 },
      { key: "frac_a", reason: "new" },
      { key: "frac_b", reason: "new" },
    ]);
    const merged = mergeDomainQueues([wna, frac], 6, {
      preferredDomain: FRAC,
    });
    expect(merged.map((entry) => entry.key)).toEqual([
      "wna_review",
      "frac_review",
      "wna_a",
      "frac_a",
      "frac_b",
      "wna_b",
    ]);
  });

  it("reserves a mix floor for frontier work so a session is never 100% review", () => {
    // 5 reviews across two domains + 1 frontier item; limit 4. The mix floor is
    // ceil(4/4)=1, so exactly one frontier slot is guaranteed even though reviews
    // could otherwise fill the whole session.
    const wna = q(WNA, [
      { key: "r1", reason: "review", retention: 0.1 },
      { key: "r2", reason: "review", retention: 0.2 },
      { key: "r3", reason: "review", retention: 0.3 },
      { key: "f1", reason: "new" },
    ]);
    const frac = q(FRAC, [
      { key: "r4", reason: "review", retention: 0.15 },
      { key: "r5", reason: "review", retention: 0.25 },
    ]);
    const merged = mergeDomainQueues([wna, frac], 4);
    expect(merged.length).toBe(4);
    // The one frontier item must be present (mix floor).
    expect(merged.some((e) => e.key === "f1")).toBe(true);
    // The three review slots are the most-decayed reviews, globally ranked.
    const reviewKeys = merged.filter((e) => e.key !== "f1").map((e) => e.key);
    expect(reviewKeys).toEqual(["r1", "r4", "r2"]);
  });

  it("caps output at `limit`", () => {
    const wna = q(
      WNA,
      Array.from({ length: 10 }, (_, i) => ({ key: `wna_${i}`, reason: "new" as const })),
    );
    const frac = q(
      FRAC,
      Array.from({ length: 10 }, (_, i) => ({ key: `frac_${i}`, reason: "new" as const })),
    );
    expect(mergeDomainQueues([wna, frac], 8).length).toBe(8);
  });

  it("dedups by domain+key so the same skill is never served twice", () => {
    const wna = q(WNA, [
      { key: "dup", reason: "review", retention: 0.1 },
      { key: "dup", reason: "review", retention: 0.1 },
    ]);
    const frac = q(FRAC, [{ key: "frac_x", reason: "new" }]);
    const merged = mergeDomainQueues([wna, frac], 12);
    const wnaDup = merged.filter((e) => e.domain === WNA && e.key === "dup");
    expect(wnaDup.length).toBe(1);
  });

  it("the SAME key in DIFFERENT domains is kept distinct (dedup is domain-scoped)", () => {
    const wna = q(WNA, [{ key: "shared_key", reason: "new" }]);
    const prob = q(PROB, [{ key: "shared_key", reason: "new" }]);
    const merged = mergeDomainQueues([wna, prob], 12);
    expect(merged).toEqual([
      { domain: WNA, key: "shared_key" },
      { domain: PROB, key: "shared_key" },
    ]);
  });

  it("backfills unused floor slots with leftover reviews", () => {
    // Reviews only, no frontier → floor is 0, reviewBudget = limit; all reviews
    // fill up to the limit in global decay order.
    const wna = q(WNA, [
      { key: "a", reason: "review", retention: 0.3 },
      { key: "b", reason: "review", retention: 0.1 },
    ]);
    const frac = q(FRAC, [{ key: "c", reason: "review", retention: 0.2 }]);
    const merged = mergeDomainQueues([wna, frac], 12);
    expect(merged.map((e) => e.key)).toEqual(["b", "c", "a"]);
  });
});
