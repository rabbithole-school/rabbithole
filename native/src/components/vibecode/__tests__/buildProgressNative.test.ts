import { describe, expect, it } from "vitest";

import { formatElapsed } from "../buildProgressFormat";

// The build-stage reducer itself is covered by shared/buildStage.test.ts; the
// only NEW pure logic on native is the m:ss elapsed clock, whose edge cases
// (padding, minute rollover, negative clamp) drive the parity claim that the
// card, chat line, and overlay pill all read one clock.
describe("formatElapsed", () => {
  it("renders m:ss with a zero-padded seconds field", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(5_000)).toBe("0:05");
    expect(formatElapsed(9_000)).toBe("0:09");
    expect(formatElapsed(59_000)).toBe("0:59");
  });

  it("rolls whole minutes over at 60 seconds", () => {
    expect(formatElapsed(60_000)).toBe("1:00");
    expect(formatElapsed(90_000)).toBe("1:30");
    expect(formatElapsed(3_599_000)).toBe("59:59");
  });

  it("floors sub-second remainders instead of rounding up", () => {
    expect(formatElapsed(1_999)).toBe("0:01");
    expect(formatElapsed(999)).toBe("0:00");
  });

  it("clamps a negative elapsed (clock skew) to 0:00", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});
