import { describe, expect, test } from "vitest";

import {
  domainFogLabel,
  domainFogState,
  type DomainFogState,
  type DomainMapStatusLike,
} from "./domainFog";

// ─────────────────────────────────────────────────────────────────────────
// Fog-of-war classification (Surface 3): ONE added visual state, no new
// per-node vocabulary and no second fog label. A domain band renders hazy
// ("uncharted") until its placement CONVERGES, at which point it resolves back
// to normal dots — and an ineligible domain is never this module's concern.
// Pure + framework-free so web (MapTreeCanvas.tsx) and native
// (TreeMapNative.tsx) classify a band IDENTICALLY.
// ─────────────────────────────────────────────────────────────────────────

const ALL_STATUSES: DomainMapStatusLike[] = [
  "converged",
  "in_flight",
  "shadow_placed",
  "queued",
  "available",
  "ineligible",
];

describe("domainFogState — the band's fog classification", () => {
  test("a converged domain is never fogged (renders exactly as today)", () => {
    expect(domainFogState("converged")).toBeNull();
  });

  test("an ineligible domain is never this module's concern", () => {
    expect(domainFogState("ineligible")).toBeNull();
  });

  test("every non-converged eligible status shares the ONE fogged state", () => {
    // Founder decision 4: "ONE added visual state, not a badge vocabulary."
    // An in-flight run must NOT get its own second label — that would be a
    // second vocabulary member on a surface the ruling wants kept to one.
    expect(domainFogState("in_flight")).toBe("uncharted");
    expect(domainFogState("available")).toBe("uncharted");
    expect(domainFogState("queued")).toBe("uncharted");
    expect(domainFogState("shadow_placed")).toBe("uncharted");
  });

  test("the fog vocabulary has exactly two outcomes across the whole union", () => {
    const seen = new Set(ALL_STATUSES.map((s) => domainFogState(s)));
    expect(seen).toEqual(new Set<DomainFogState>(["uncharted", null]));
  });
});

describe("domainFogLabel — the painted label", () => {
  test("the one fogged state paints the one label", () => {
    expect(domainFogLabel("uncharted")).toBe("uncharted");
    expect(domainFogLabel(null)).toBeNull();
  });

  test("a non-fogged band never paints a label", () => {
    expect(domainFogLabel(domainFogState("converged"))).toBeNull();
    expect(domainFogLabel(domainFogState("ineligible"))).toBeNull();
  });
});
