import { describe, expect, it } from "vitest";
import {
  bandPressure,
  calibrationTable,
  computeParamHealthMetrics,
  deriveWindowSignal,
  gapEscapes,
  GAP_ESCAPE_MIN_N,
  recommendParamChange,
  renderParamHealthSection,
  reviewShare,
  reviewSuccessByDomain,
  wilsonInterval,
  xInTen,
  type AttemptRow,
  type ParamHealthMetrics,
  type PreviousRecommendation,
  type WindowSignal,
} from "../practice/paramHealth";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_END = Date.UTC(2026, 6, 4, 12, 0, 0);
const WINDOW_START = WINDOW_END - 28 * DAY_MS;

// Same guardrail the digest tests use — nothing competitive/gamified.
const BANNED_FRAMING =
  /\b(ranking?|leaderboards?|behind|ahead|xp|points?|streaks?|better than|worse than)\b/i;

function attempt(over: Partial<AttemptRow>): AttemptRow {
  return {
    scholarId: "s1",
    nodeKey: "add-within-10",
    correct: true,
    lane: "review",
    createdAt: WINDOW_END - DAY_MS,
    ...over,
  };
}

/** n review attempts in a domain with `successes` correct. */
function reviewRows(
  n: number,
  successes: number,
  over: Partial<AttemptRow> = {},
): AttemptRow[] {
  return Array.from({ length: n }, (_, i) =>
    attempt({ lane: "review", correct: i < successes, ...over }),
  );
}

describe("wilsonInterval", () => {
  it("returns [0,1] for n=0 (no data cannot exclude anything)", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });

  it("brackets the point estimate and tightens with n", () => {
    const small = wilsonInterval(9, 10);
    const big = wilsonInterval(90, 100);
    expect(small.low).toBeLessThan(0.9);
    expect(small.high).toBeGreaterThan(0.9);
    // More data → tighter interval around the same 0.9 proportion.
    expect(big.high - big.low).toBeLessThan(small.high - small.low);
  });

  it("stays within [0,1]", () => {
    const w = wilsonInterval(100, 100);
    expect(w.low).toBeGreaterThanOrEqual(0);
    expect(w.high).toBeLessThanOrEqual(1);
  });
});

describe("calibrationTable", () => {
  it("buckets predicted retention into the 4 bands with correct boundaries", () => {
    const rows: AttemptRow[] = [
      attempt({ predictedRetention: 0.5 }), // <0.60
      attempt({ predictedRetention: 0.6 }), // 0.60–0.75 (lower edge inclusive)
      attempt({ predictedRetention: 0.74 }), // 0.60–0.75
      attempt({ predictedRetention: 0.75 }), // 0.75–0.90 (edge to next)
      attempt({ predictedRetention: 0.9 }), // ≥0.90 (edge to top)
    ];
    const table = calibrationTable(rows);
    expect(table.map((b) => b.n)).toEqual([1, 2, 1, 1]);
    expect(table.map((b) => b.label)).toEqual([
      "<0.60",
      "0.60–0.75",
      "0.75–0.90",
      "≥0.90",
    ]);
  });

  it("only counts review + confirmation lanes with a predicted retention", () => {
    const rows: AttemptRow[] = [
      attempt({ lane: "review", predictedRetention: 0.7 }),
      attempt({ lane: "confirmation", predictedRetention: 0.7 }),
      attempt({ lane: "frontier", predictedRetention: 0.7 }), // excluded (lane)
      attempt({ lane: "review", predictedRetention: undefined }), // excluded (no R)
    ];
    const bucket = calibrationTable(rows)[1]; // 0.60–0.75
    expect(bucket.n).toBe(2);
  });

  it("computes observed rate, mean predicted and a Wilson CI per bucket", () => {
    const rows = [
      ...Array.from({ length: 8 }, () =>
        attempt({ predictedRetention: 0.7, correct: true }),
      ),
      ...Array.from({ length: 2 }, () =>
        attempt({ predictedRetention: 0.7, correct: false }),
      ),
    ];
    const bucket = calibrationTable(rows)[1];
    expect(bucket.n).toBe(10);
    expect(bucket.successes).toBe(8);
    expect(bucket.observedRate).toBeCloseTo(0.8, 5);
    expect(bucket.meanPredicted).toBeCloseTo(0.7, 5);
    expect(bucket.wilson.low).toBeLessThan(0.8);
    expect(bucket.wilson.high).toBeGreaterThan(0.8);
  });
});

describe("reviewSuccessByDomain", () => {
  it("splits by domain and verdicts against the healthy band", () => {
    const rows = [
      ...reviewRows(100, 85, { domain: "whole-number-arithmetic" }), // within
      ...reviewRows(100, 96, { domain: "fractions" }), // above
      ...reviewRows(100, 60, { domain: "geometry" }), // below
      ...reviewRows(5, 5, { domain: "measurement" }), // insufficient (n<20)
    ];
    const byDomain = reviewSuccessByDomain(rows);
    const verdict = (d: string) =>
      byDomain.find((x) => x.domain === d)!.verdict;
    expect(verdict("whole-number-arithmetic")).toBe("within");
    expect(verdict("fractions")).toBe("above");
    expect(verdict("geometry")).toBe("below");
    expect(verdict("measurement")).toBe("insufficient");
  });

  it("ignores non-review lanes", () => {
    const rows = [
      ...reviewRows(20, 18, { domain: "d" }),
      attempt({ lane: "frontier", domain: "d", correct: false }),
    ];
    expect(reviewSuccessByDomain(rows)[0].n).toBe(20);
  });
});

describe("reviewShare", () => {
  it("is review-lane over all lane-tagged served items", () => {
    const rows = [
      ...reviewRows(4, 4),
      attempt({ lane: "frontier" }),
      attempt({ lane: "confirmation" }),
      attempt({ lane: "challenge" }),
      attempt({ lane: undefined }), // excluded from denominator
    ];
    const rs = reviewShare(rows);
    expect(rs.reviewCount).toBe(4);
    expect(rs.servedCount).toBe(7);
    expect(rs.share).toBeCloseTo(4 / 7, 5);
  });

  it("is 0 with no served items", () => {
    expect(reviewShare([]).share).toBe(0);
  });
});

describe("bandPressure", () => {
  it("counts challenge uptake, success and distinct nodes/scholars", () => {
    const rows = [
      attempt({ lane: "challenge", correct: true, nodeKey: "a", scholarId: "s1" }),
      attempt({ lane: "challenge", correct: true, nodeKey: "b", scholarId: "s1" }),
      attempt({ lane: "challenge", correct: false, nodeKey: "a", scholarId: "s2" }),
      attempt({ lane: "review", correct: true }), // ignored
    ];
    const bp = bandPressure(rows);
    expect(bp.challengeAttempts).toBe(3);
    expect(bp.challengeCorrect).toBe(2);
    expect(bp.challengeSuccessRate).toBeCloseTo(2 / 3, 5);
    expect(bp.distinctChallengeNodes).toBe(2);
    expect(bp.distinctChallengeScholars).toBe(2);
  });
});

describe("gapEscapes", () => {
  it("counts a correct review then a miss on the same node within 14d", () => {
    const rows = [
      attempt({
        nodeKey: "n1",
        lane: "review",
        correct: true,
        createdAt: WINDOW_END - 10 * DAY_MS,
      }),
      attempt({
        nodeKey: "n1",
        lane: "frontier",
        correct: false,
        createdAt: WINDOW_END - 3 * DAY_MS,
      }),
    ];
    expect(gapEscapes(rows).n).toBe(1);
  });

  it("does not count a miss outside the 14-day window", () => {
    const rows = [
      attempt({
        nodeKey: "n1",
        lane: "review",
        correct: true,
        createdAt: WINDOW_END - 20 * DAY_MS,
      }),
      attempt({
        nodeKey: "n1",
        correct: false,
        createdAt: WINDOW_END - 3 * DAY_MS, // 17 days later
      }),
    ];
    expect(gapEscapes(rows).n).toBe(0);
  });

  it("counts one escape per (scholar, node), not per flap", () => {
    const rows = [
      attempt({ scholarId: "s1", nodeKey: "n1", lane: "review", correct: true, createdAt: WINDOW_END - 12 * DAY_MS }),
      attempt({ scholarId: "s1", nodeKey: "n1", correct: false, createdAt: WINDOW_END - 10 * DAY_MS }),
      attempt({ scholarId: "s1", nodeKey: "n1", correct: false, createdAt: WINDOW_END - 8 * DAY_MS }),
    ];
    expect(gapEscapes(rows).n).toBe(1);
  });

  it("separates scholars on the same node", () => {
    const rows = [
      attempt({ scholarId: "s1", nodeKey: "n1", lane: "review", correct: true, createdAt: WINDOW_END - 12 * DAY_MS }),
      attempt({ scholarId: "s1", nodeKey: "n1", correct: false, createdAt: WINDOW_END - 10 * DAY_MS }),
      attempt({ scholarId: "s2", nodeKey: "n1", lane: "review", correct: true, createdAt: WINDOW_END - 12 * DAY_MS }),
      attempt({ scholarId: "s2", nodeKey: "n1", correct: false, createdAt: WINDOW_END - 10 * DAY_MS }),
    ];
    expect(gapEscapes(rows).n).toBe(2);
  });

  it("is not readable below the minimum n", () => {
    const rows: AttemptRow[] = [];
    for (let i = 0; i < GAP_ESCAPE_MIN_N - 1; i++) {
      rows.push(
        attempt({ scholarId: `s${i}`, nodeKey: "n1", lane: "review", correct: true, createdAt: WINDOW_END - 12 * DAY_MS }),
        attempt({ scholarId: `s${i}`, nodeKey: "n1", correct: false, createdAt: WINDOW_END - 10 * DAY_MS }),
      );
    }
    const ge = gapEscapes(rows);
    expect(ge.n).toBe(GAP_ESCAPE_MIN_N - 1);
    expect(ge.readable).toBe(false);
  });
});

describe("deriveWindowSignal", () => {
  it("raises when the CI is wholly above the band (kids remember better)", () => {
    const rows = reviewRows(200, 190); // 95%, tight CI above 0.90
    const signal = deriveWindowSignal(computeParamHealthMetrics(rows), 2.3);
    expect(signal.direction).toBe("raise");
    expect(signal.ciExcludesBand).toBe(true);
    expect(signal.proposedValue).toBe(2.6);
  });

  it("lowers when the CI is wholly below the band (reviews too late)", () => {
    const rows = reviewRows(200, 130); // 65%, CI below 0.80
    const signal = deriveWindowSignal(computeParamHealthMetrics(rows), 2.3);
    expect(signal.direction).toBe("lower");
    expect(signal.ciExcludesBand).toBe(true);
    expect(signal.proposedValue).toBe(2.0);
  });

  it("is a lean (not actionable) when the point is out of band but the CI overlaps", () => {
    const rows = reviewRows(10, 10); // 100% but tiny n → CI overlaps band
    const signal = deriveWindowSignal(computeParamHealthMetrics(rows), 2.3);
    expect(signal.direction).toBe("raise");
    expect(signal.ciExcludesBand).toBe(false);
  });

  it("is none inside the healthy band", () => {
    const rows = reviewRows(200, 170); // 85%
    const signal = deriveWindowSignal(computeParamHealthMetrics(rows), 2.3);
    expect(signal.direction).toBe("none");
    expect(signal.ciExcludesBand).toBe(false);
  });

  it("never proposes a growth multiplier at or below 1", () => {
    const rows = reviewRows(500, 250); // 50%, strongly below
    const signal = deriveWindowSignal(computeParamHealthMetrics(rows), 1.2);
    expect(signal.proposedValue).toBeGreaterThan(1);
  });
});

function signalFor(n: number, successes: number, growth = 2.3): {
  signal: WindowSignal;
  metrics: ParamHealthMetrics;
} {
  const metrics = computeParamHealthMetrics(reviewRows(n, successes));
  return { signal: deriveWindowSignal(metrics, growth), metrics };
}

describe("recommendParamChange — the two-window gate", () => {
  const window = { windowStart: WINDOW_START, windowEnd: WINDOW_END };

  it("does not fire on a healthy window", () => {
    const { signal, metrics } = signalFor(200, 170); // within band
    expect(recommendParamChange(signal, null, window, metrics)).toEqual({
      kind: "none",
    });
  });

  it("does not fire on a single qualifying window (pending only)", () => {
    const { signal, metrics } = signalFor(200, 190); // above band
    const decision = recommendParamChange(signal, null, window, metrics);
    expect(decision.kind).toBe("pending");
    if (decision.kind === "pending") {
      expect(decision.draft.evidence.consecutiveWindows).toBe(1);
      expect(decision.draft.firstFire).toBe(false);
    }
  });

  it("fires when a matching open row precedes it within the gap", () => {
    const { signal, metrics } = signalFor(200, 190);
    const previous: PreviousRecommendation = {
      windowEnd: WINDOW_END - 7 * DAY_MS,
      param: "HALFLIFE_GROWTH",
      status: "open",
      direction: "raise",
      consecutiveWindows: 1,
    };
    const decision = recommendParamChange(signal, previous, window, metrics);
    expect(decision.kind).toBe("fire");
    if (decision.kind === "fire") {
      expect(decision.draft.evidence.consecutiveWindows).toBe(2);
      expect(decision.draft.firstFire).toBe(true);
      expect(decision.draft.param).toBe("HALFLIFE_GROWTH");
      expect(decision.draft.proposedValue).toBe(2.6);
    }
  });

  it("does not re-mark firstFire once already sustained", () => {
    const { signal, metrics } = signalFor(200, 190);
    const previous: PreviousRecommendation = {
      windowEnd: WINDOW_END - 7 * DAY_MS,
      param: "HALFLIFE_GROWTH",
      status: "open",
      direction: "raise",
      consecutiveWindows: 2,
    };
    const decision = recommendParamChange(signal, previous, window, metrics);
    expect(decision.kind).toBe("fire");
    if (decision.kind === "fire") {
      expect(decision.draft.evidence.consecutiveWindows).toBe(3);
      expect(decision.draft.firstFire).toBe(false);
    }
  });

  it("does not fire when the previous window disagrees in direction", () => {
    const { signal, metrics } = signalFor(200, 190); // raise
    const previous: PreviousRecommendation = {
      windowEnd: WINDOW_END - 7 * DAY_MS,
      param: "HALFLIFE_GROWTH",
      status: "open",
      direction: "lower",
      consecutiveWindows: 1,
    };
    expect(recommendParamChange(signal, previous, window, metrics).kind).toBe(
      "pending",
    );
  });

  it("does not fire against a dismissed previous row (chain broken)", () => {
    const { signal, metrics } = signalFor(200, 190);
    const previous: PreviousRecommendation = {
      windowEnd: WINDOW_END - 7 * DAY_MS,
      param: "HALFLIFE_GROWTH",
      status: "dismissed",
      direction: "raise",
      consecutiveWindows: 1,
    };
    expect(recommendParamChange(signal, previous, window, metrics).kind).toBe(
      "pending",
    );
  });

  it("does not fire against a stale previous row (gap too large)", () => {
    const { signal, metrics } = signalFor(200, 190);
    const previous: PreviousRecommendation = {
      windowEnd: WINDOW_END - 90 * DAY_MS,
      param: "HALFLIFE_GROWTH",
      status: "open",
      direction: "raise",
      consecutiveWindows: 1,
    };
    expect(recommendParamChange(signal, previous, window, metrics).kind).toBe(
      "pending",
    );
  });
});

describe("xInTen", () => {
  it("renders the plan's phrasing", () => {
    expect(xInTen(0.88)).toBe("8.8");
    expect(xInTen(0.9)).toBe("9");
    expect(xInTen(0.54)).toBe("5.4");
    expect(xInTen(0.7)).toBe("7");
  });
});

describe("renderParamHealthSection", () => {
  const window = { windowStart: WINDOW_START, windowEnd: WINDOW_END };

  function section(rows: AttemptRow[], previous: PreviousRecommendation | null) {
    const metrics = computeParamHealthMetrics(rows);
    const signal = deriveWindowSignal(metrics, 2.3);
    const decision = recommendParamChange(signal, previous, window, metrics);
    return renderParamHealthSection({
      metrics,
      signal,
      decision,
      windowStart: WINDOW_START,
      windowEnd: WINDOW_END,
    });
  }

  it("HEALTHY: says a quiet week is the system working", () => {
    const { text, decision } = section(
      reviewRows(200, 170, { domain: "whole-number-arithmetic", predictedRetention: 0.85 }),
      null,
    );
    expect(decision.kind).toBe("none");
    expect(text).toContain("🩺 *Practice parameter health*");
    expect(text).toContain("No parameter change");
    expect(text).toContain("system working");
    expect(text).toContain("in the healthy band");
    expect(text).not.toMatch(BANNED_FRAMING);
  });

  it("RECOMMENDATION FIRED: proposes the memory-model change as an OPEN proposal", () => {
    const previous: PreviousRecommendation = {
      windowEnd: WINDOW_END - 7 * DAY_MS,
      param: "HALFLIFE_GROWTH",
      status: "open",
      direction: "raise",
      consecutiveWindows: 1,
    };
    const { text, decision } = section(
      reviewRows(214, 205, { domain: "whole-number-arithmetic", predictedRetention: 0.7 }),
      previous,
    );
    expect(decision.kind).toBe("fire");
    expect(text).toContain("📈 *Recommendation (memory-model):*");
    expect(text).toContain("`HALFLIFE_GROWTH` 2.3 → 2.6");
    expect(text).toContain("two consecutive windows");
    expect(text).toContain("never auto-applied");
    expect(text).toContain("retain more");
    expect(text).not.toMatch(BANNED_FRAMING);
  });

  it("DISCUSSION PROMPT: policy challenge prompt, explicitly not a recommendation", () => {
    const rows = [
      ...reviewRows(200, 170, { domain: "whole-number-arithmetic" }),
      ...Array.from({ length: 14 }, (_, i) =>
        attempt({ lane: "challenge", correct: i < 11, nodeKey: `c${i}`, scholarId: `s${i}` }),
      ),
    ];
    const { text } = section(rows, null);
    expect(text).toContain("⚖️ *Discussion prompt (policy — not a recommendation):*");
    expect(text).toContain("14 challenge items taken");
    expect(text).toContain("11 correct");
    expect(text).toContain("values call");
    expect(text).not.toMatch(BANNED_FRAMING);
  });

  it("NO-ACTION (wide interval): names the wide interval, not a failure", () => {
    // Point above band but small n → CI overlaps → lean, not actionable.
    const { text, decision } = section(reviewRows(10, 10, { predictedRetention: 0.7 }), null);
    expect(decision.kind).toBe("none");
    expect(text).toContain("No parameter change");
    expect(text).toContain("too wide to act on");
    expect(text).toContain("leans high");
    expect(text).not.toMatch(BANNED_FRAMING);
  });

  it("PENDING: one window trending, watching for a second", () => {
    const { text, decision } = section(reviewRows(200, 190, { predictedRetention: 0.7 }), null);
    expect(decision.kind).toBe("pending");
    expect(text).toContain("No action yet");
    expect(text).toContain("two windows running");
    expect(text).not.toMatch(BANNED_FRAMING);
  });

  it("empty window: reports no data without inventing signal", () => {
    const { text, decision } = section([], null);
    expect(decision.kind).toBe("none");
    expect(text).toContain("not enough review/confirmation attempts");
    expect(text).toContain("nothing to calibrate against");
    expect(text).not.toMatch(BANNED_FRAMING);
  });
});
