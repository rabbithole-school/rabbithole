import { describe, expect, test } from "vitest";
import { remainingViewportHeight } from "../viewportShell";

describe("viewport shell height contract", () => {
  test("falls back to the full dynamic viewport until a banner is measured", () => {
    expect(remainingViewportHeight(Number.NaN)).toBe("100dvh");
  });

  test("subtracts the measured banner height without a hardcoded offset", () => {
    expect(remainingViewportHeight(52.1)).toBe("calc(100dvh - 53px)");
    expect(remainingViewportHeight(-1)).toBe("calc(100dvh - 0px)");
  });
});
