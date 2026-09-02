import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./MathSkillsDomainRail.tsx", import.meta.url)),
  "utf8",
);

describe("MathSkillsDomainRail synthetic Fast math entry", () => {
  it("uses a sentinel rather than pretending Fast math is a practice domain", () => {
    expect(source).toContain('FAST_MATH_DOMAIN = "__fast_math__"');
    expect(source).toContain("isSyntheticMathSkillsDomain");
  });

  it("groups Fast math with All domains above the real domain list", () => {
    const allDomains = source.indexOf('data-testid="domain-rail-all-domains"');
    const fastMath = source.indexOf('data-testid="domain-rail-fast-math"');
    const realDomains = source.indexOf("domains.map");
    expect(allDomains).toBeGreaterThan(-1);
    expect(fastMath).toBeGreaterThan(allDomains);
    expect(realDomains).toBeGreaterThan(fastMath);
    expect(source).toContain("Fact families · 0–100% automatic");
  });
});
