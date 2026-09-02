import { describe, expect, test } from "vitest";

import { appendCanonicalJsonArrayByteLength } from "../../lib/simulator/chunkByteAccounting";
import { canonicalJson } from "../../lib/simulator/prompt";

describe("canonical tick-array byte accounting", () => {
  test("matches canonical JSON arrays with one bounded item serialization per tick", () => {
    const ticks = Array.from({ length: 100 }, (_, tick) => ({
      tick,
      label: tick % 2 === 0 ? "reef" : "🌊",
      values: [{ key: "longevity", value: tick }],
    }));
    const canonicalTicks = ticks.map(canonicalJson);
    let byteLength = 2; // canonicalJson([]) === "[]"
    const checkpoints = new Set([1, 2, 50, 100]);

    for (const [index, canonicalTick] of canonicalTicks.entries()) {
      byteLength = appendCanonicalJsonArrayByteLength(byteLength, canonicalTick);
      if (checkpoints.has(index + 1)) {
        expect(byteLength).toBe(
          new TextEncoder().encode(canonicalJson(ticks.slice(0, index + 1))).length,
        );
      }
    }

    expect(canonicalTicks).toHaveLength(100);
  });
});
