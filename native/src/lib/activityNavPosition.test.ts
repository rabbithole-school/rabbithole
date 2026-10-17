import { describe, expect, test } from "vitest";
import { parseActivityNavPosition } from "./activityNavPosition";

describe("parseActivityNavPosition (steady ← / → arrival)", () => {
  test("reads the position a tap passed", () => {
    expect(parseActivityNavPosition("2", "4")).toEqual({ position: 2, total: 4 });
  });
  test("ignores missing, malformed or out-of-range params", () => {
    expect(parseActivityNavPosition(undefined, undefined)).toBeNull();
    expect(parseActivityNavPosition("x", "4")).toBeNull();
    expect(parseActivityNavPosition("5", "4")).toBeNull();
    expect(parseActivityNavPosition("1", "1")).toBeNull();
  });
});
