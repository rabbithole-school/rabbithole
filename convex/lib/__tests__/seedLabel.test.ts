import { describe, expect, test } from "vitest";
import { cleanSeedLabel } from "../seedLabel";

describe("cleanSeedLabel", () => {
  test("keeps the star-label head and drops arrow-connector tails", () => {
    expect(
      cleanSeedLabel("Counting by 2s → odd, even, and how computers count (binary)"),
    ).toBe("Counting by 2s");
    expect(
      cleanSeedLabel("Skip-counting   ->   rhythm, beats, and time signatures in music"),
    ).toBe("Skip-counting");
    expect(
      cleanSeedLabel("Sharing fairly ➜ fractions (what if it doesn't come out even?)"),
    ).toBe("Sharing fairly");
    expect(
      cleanSeedLabel("Times tables —> hidden patterns (why the 9s digits always add to 9)"),
    ).toBe("Times tables");
  });

  test("passes through labels without arrow connectors", () => {
    expect(cleanSeedLabel("Vampire-bat reciprocity")).toBe("Vampire-bat reciprocity");
  });
});
