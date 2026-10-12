import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("scholar Math-plan parity wiring", () => {
  it("vendors scope projection and recesses out-of-scope map territory", () => {
    expect(read("native/vendor/shared/mathPlanScope.ts")).toBe(read("shared/mathPlanScope.ts"));
    expect(read("components/map/MapTreeCanvas.tsx")).toContain("outOfScope");
    expect(read("components/map/MapTreeCanvas.tsx")).toContain('transform="rotate(-45deg)"');
    expect(read("native/src/components/tree/TreeMapNative.tsx")).toContain("scopeAllowsStrand");
  });
});
