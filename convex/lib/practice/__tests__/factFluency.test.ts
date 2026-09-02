import { describe, expect, it } from "vitest";
import {
  classifyFactState,
  factSpeedRead,
  nextFactFluencyFields,
} from "../factFluency";
import {
  LATENCY_SAMPLE_CAP,
  nextLatencyStats,
} from "../latencyStats";

describe("nextLatencyStats", () => {
  it("appends and recomputes the median", () => {
    const s = nextLatencyStats([1000, 2000], 3000);
    expect(s.latencySamplesMs).toEqual([1000, 2000, 3000]);
    expect(s.latencyMedianMs).toBe(2000);
  });
  it("caps the ring buffer at LATENCY_SAMPLE_CAP (oldest dropped)", () => {
    const full = Array.from({ length: LATENCY_SAMPLE_CAP }, (_, i) => (i + 1) * 100);
    const s = nextLatencyStats(full, 9999);
    expect(s.latencySamplesMs).toHaveLength(LATENCY_SAMPLE_CAP);
    expect(s.latencySamplesMs[0]).toBe(200); // 100 dropped
    expect(s.latencySamplesMs.at(-1)).toBe(9999);
  });
});

describe("classifyFactState", () => {
  const baseline = 2000; // ms

  it("is unseen with no attempts", () => {
    expect(classifyFactState(undefined, baseline)).toBe("unseen");
    expect(classifyFactState({ seenCount: 0, correctCount: 0 }, baseline)).toBe(
      "unseen",
    );
  });

  it("is effortful when accuracy is low", () => {
    expect(
      classifyFactState({ seenCount: 4, correctCount: 2 }, baseline),
    ).toBe("effortful");
  });

  it("is practicing when reliably correct but no speed read yet", () => {
    // Reliable accuracy, but fewer than the minimum timed samples.
    expect(
      classifyFactState(
        { seenCount: 5, correctCount: 5, latencySamplesMs: [1500], latencyMedianMs: 1500 },
        baseline,
      ),
    ).toBe("practicing");
  });

  it("never claims fast without a baseline (new scholar)", () => {
    expect(
      classifyFactState(
        {
          seenCount: 8,
          correctCount: 8,
          latencySamplesMs: [800, 800, 800, 800],
          latencyMedianMs: 800,
        },
        undefined,
      ),
    ).toBe("practicing");
  });

  it("is fluent when reliably correct AND fast for this scholar", () => {
    // median within fluent tolerance (baseline*1.5=3000) but above baseline.
    expect(
      classifyFactState(
        {
          seenCount: 10,
          correctCount: 9,
          latencySamplesMs: [2500, 2600, 2400, 2500],
          latencyMedianMs: 2500,
        },
        baseline,
      ),
    ).toBe("fluent");
  });

  it("is automatic when near-perfect AND at/under baseline", () => {
    expect(
      classifyFactState(
        {
          seenCount: 12,
          correctCount: 12,
          latencySamplesMs: [1200, 1300, 1100, 1200],
          latencyMedianMs: 1200,
        },
        baseline,
      ),
    ).toBe("automatic");
  });

  it("stays practicing when correct but slower than the fluent band", () => {
    expect(
      classifyFactState(
        {
          seenCount: 10,
          correctCount: 9,
          latencySamplesMs: [4000, 4200, 3900, 4100],
          latencyMedianMs: 4100,
        },
        baseline,
      ),
    ).toBe("practicing");
  });
});

describe("factSpeedRead", () => {
  const baseline = 2000;
  const fastStats = {
    seenCount: 3,
    correctCount: 3,
    latencySamplesMs: [800, 900, 1000],
    latencyMedianMs: 900,
  };

  it("requires both a scholar baseline and enough fact samples", () => {
    expect(factSpeedRead(fastStats, undefined)).toBeNull();
    expect(
      factSpeedRead(
        { ...fastStats, latencySamplesMs: [800, 900] },
        baseline,
      ),
    ).toBeNull();
    expect(factSpeedRead(fastStats, baseline)).toEqual({
      baselineMs: baseline,
      medianMs: 900,
    });
  });
});

describe("nextFactFluencyFields", () => {
  it("increments tallies and advances the correct-only latency buffer", () => {
    const f = nextFactFluencyFields(
      { seenCount: 2, correctCount: 1, latencySamplesMs: [1800] },
      {
        factKey: "mul:7x8",
        skillKey: "mult_facts_7_8_9",
        domain: "whole_number_arithmetic",
        correct: true,
        latencyMs: 1400,
        now: 5000,
      },
    );
    expect(f).not.toBeNull();
    expect(f!.seenCount).toBe(3);
    expect(f!.correctCount).toBe(2);
    expect(f!.latencySamplesMs).toEqual([1800, 1400]);
    expect(f!.lastCorrectAt).toBe(5000);
  });

  it("on a miss: bumps seen only, never touches latency or correct/fast stamps", () => {
    const f = nextFactFluencyFields(
      { seenCount: 3, correctCount: 3, latencySamplesMs: [1400], lastCorrectAt: 4000 },
      {
        factKey: "sub:15-8",
        skillKey: "subtract_within_20",
        domain: "whole_number_arithmetic",
        correct: false,
        latencyMs: 900,
        now: 6000,
      },
    );
    expect(f!.seenCount).toBe(4);
    expect(f!.correctCount).toBe(3);
    expect(f!.latencySamplesMs).toBeUndefined(); // untouched on a miss
    expect(f!.lastCorrectAt).toBeUndefined(); // not re-stamped
    expect(f!.lastSeenAt).toBe(6000);
  });

  it("a correct attempt records its latency without persisting a fast verdict", () => {
    const f = nextFactFluencyFields(null, {
      factKey: "add:6+9",
      skillKey: "add_within_20_regroup",
      domain: "whole_number_arithmetic",
      correct: true,
      latencyMs: 5000,
      now: 1,
    });
    expect(f!.seenCount).toBe(1);
    expect(f!.correctCount).toBe(1);
    expect(f!.latencySamplesMs).toEqual([5000]);
  });

  it("returns null for a malformed factKey", () => {
    expect(
      nextFactFluencyFields(null, {
        factKey: "garbage",
        skillKey: "x",
        domain: "d",
        correct: true,
        latencyMs: 1,
        now: 1,
      }),
    ).toBeNull();
  });
});
