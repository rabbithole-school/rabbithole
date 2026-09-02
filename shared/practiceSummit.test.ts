import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectSummitHandoff,
  selectMixedSummitHandoff,
  type SummitDomain,
} from "./practiceSummit";

// A compact factory for the domainsForScholar row shape.
function dom(
  domain: string,
  label: string,
  opts: { started?: boolean; provisionalCount?: number; accessComplete?: boolean; exhausted?: boolean } = {},
): SummitDomain {
  return {
    domain,
    label,
    discipline: "Mathematics",
    fluentCount: opts.exhausted ? 10 : opts.started ? 3 : 0,
    total: 10,
    started: opts.started ?? opts.exhausted ?? false,
    provisionalCount:
      opts.provisionalCount ?? (opts.accessComplete && !opts.exhausted ? 2 : 0),
    accessComplete: opts.accessComplete ?? opts.exhausted ?? false,
    exhausted: opts.exhausted ?? false,
  };
}

const WNA = "whole-number-arithmetic";
const FRAC = "fraction-arithmetic";
const PROB = "probability";

describe("selectSummitHandoff", () => {
  it("undefined domain resolves to the first-listed (the default)", () => {
    const domains = [dom(WNA, "Whole-number arithmetic"), dom(FRAC, "Fractions")];
    const sel = selectSummitHandoff(domains, undefined);
    expect(sel.effective).toBe(WNA);
    expect(sel.current?.domain).toBe(WNA);
  });

  it("isSummit is true only when the effective domain is exhausted", () => {
    const domains = [dom(PROB, "Probability", { exhausted: true }), dom(FRAC, "Fractions")];
    expect(selectSummitHandoff(domains, PROB).isSummit).toBe(true);
    expect(selectSummitHandoff(domains, FRAC).isSummit).toBe(false);
  });

  it("marks placement-only progress separately from a demonstrated summit", () => {
    const sel = selectSummitHandoff(
      [dom(PROB, "Probability", { accessComplete: true, provisionalCount: 3 })],
      PROB,
    );
    expect(sel.placedThrough).toBe(true);
    expect(sel.isSummit).toBe(false);
  });

  it("does not mark an all-demonstrated domain as merely placed through", () => {
    const sel = selectSummitHandoff(
      [dom(PROB, "Probability", { accessComplete: true, exhausted: true })],
      PROB,
    );
    expect(sel.isSummit).toBe(true);
    expect(sel.placedThrough).toBe(false);
    expect(sel.current?.provisionalCount).toBe(0);
  });

  it("does not invite a new primary domain after a summit", () => {
    const domains = [
      dom(PROB, "Probability", { exhausted: true }), // current (summit)
      dom(WNA, "Whole-number arithmetic"), // fresh
      dom(FRAC, "Fractions", { started: true }),
    ];
    const sel = selectSummitHandoff(domains, PROB);
    expect(sel.nextOpen).toBeNull();
    expect(sel.switchable.map((d) => d.domain)).toEqual([FRAC]);
  });

  it("nextOpen is null when every other domain is already a summit", () => {
    const domains = [
      dom(PROB, "Probability", { exhausted: true }),
      dom(FRAC, "Fractions", { exhausted: true }),
    ];
    const sel = selectSummitHandoff(domains, PROB);
    expect(sel.nextOpen).toBeNull();
  });

  it("switchable = other started domains + the next-open invite, never the current", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { started: true }), // current
      dom(FRAC, "Fractions", { exhausted: true }), // started (summited) → shown w/ ✓
      dom(PROB, "Probability"), // fresh; only non-exhausted other → nextOpen → shown
    ];
    const sel = selectSummitHandoff(domains, WNA);
    expect(sel.nextOpen?.domain).toBe(PROB);
    const slugs = sel.switchable.map((d) => d.domain).sort();
    expect(slugs).toEqual([FRAC, PROB].sort());
    // The current domain is never offered as a switch target.
    expect(sel.switchable.some((d) => d.domain === WNA)).toBe(false);
  });

  it("a fresh, unstarted non-next domain is NOT in the switcher", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { started: true }), // current
      dom(FRAC, "Fractions", { started: true }), // started → nextOpen + shown
      dom(PROB, "Probability"), // fresh, not next (FRAC is started) → hidden
    ];
    const sel = selectSummitHandoff(domains, WNA);
    expect(sel.nextOpen?.domain).toBe(FRAC);
    expect(sel.switchable.map((d) => d.domain)).toEqual([FRAC]);
  });

  it("handles an empty domain list without throwing", () => {
    const sel = selectSummitHandoff([], undefined);
    expect(sel.effective).toBeUndefined();
    expect(sel.current).toBeNull();
    expect(sel.nextOpen).toBeNull();
    expect(sel.switchable).toEqual([]);
    expect(sel.isSummit).toBe(false);
    expect(sel.placedThrough).toBe(false);
  });
});

describe("selectMixedSummitHandoff", () => {
  it("allExhausted only when EVERY blended domain is a summit", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { exhausted: true }),
      dom(FRAC, "Fractions", { exhausted: true }),
      dom(PROB, "Probability", { started: true }),
    ];
    // Blend fully summited.
    expect(selectMixedSummitHandoff(domains, [WNA, FRAC]).allExhausted).toBe(true);
    // Blend with one still-climbing domain is NOT a summit (a mere lull).
    expect(selectMixedSummitHandoff(domains, [WNA, PROB]).allExhausted).toBe(false);
  });

  it("marks a mixed blend placed through only before every domain is demonstrated", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { accessComplete: true }),
      dom(FRAC, "Fractions", { accessComplete: true }),
      dom(PROB, "Probability"),
    ];
    const sel = selectMixedSummitHandoff(domains, [WNA, FRAC]);
    expect(sel.allExhausted).toBe(false);
    expect(sel.allPlacedThrough).toBe(true);
  });

  it("keeps all-demonstrated mixed blends mutually exclusive with placed through", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { accessComplete: true, exhausted: true }),
      dom(FRAC, "Fractions", { accessComplete: true, exhausted: true }),
    ];
    const sel = selectMixedSummitHandoff(domains, [WNA, FRAC]);
    expect(sel.allExhausted).toBe(true);
    expect(sel.allPlacedThrough).toBe(false);
  });

  it("domainsInSet reflects only the blended domains, in domains order", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { started: true }),
      dom(FRAC, "Fractions", { started: true }),
      dom(PROB, "Probability", { started: true }),
    ];
    // Pass the set out of order — output follows the `domains` list order.
    const sel = selectMixedSummitHandoff(domains, [PROB, WNA]);
    expect(sel.domainsInSet.map((d) => d.domain)).toEqual([WNA, PROB]);
  });

  it("does not invite a new primary domain after a blended summit", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { exhausted: true }),
      dom(FRAC, "Fractions", { exhausted: true }),
      dom(PROB, "Probability"), // fresh, outside
      dom("integers", "Integers", { started: true }), // started, outside → preferred
    ];
    const sel = selectMixedSummitHandoff(domains, [WNA, FRAC]);
    expect(sel.nextOpen).toBeNull();
    expect(sel.switchable.map((d) => d.domain)).toEqual(["integers"]);
  });

  it("nextOpen is null when every outside domain is already a summit", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { exhausted: true }),
      dom(FRAC, "Fractions", { exhausted: true }),
      dom(PROB, "Probability", { exhausted: true }),
    ];
    const sel = selectMixedSummitHandoff(domains, [WNA, FRAC]);
    expect(sel.nextOpen).toBeNull();
  });

  it("switchable = outside started domains + the next-open invite, never in-blend", () => {
    const domains = [
      dom(WNA, "Whole-number arithmetic", { started: true }), // in blend
      dom(FRAC, "Fractions", { started: true }), // in blend
      dom(PROB, "Probability", { started: true }), // outside, started → shown
      dom("integers", "Integers"), // outside, fresh, not next → hidden
      dom("geometry", "Geometry", { exhausted: true }), // outside, summited but started → shown w/ ✓
    ];
    const sel = selectMixedSummitHandoff(domains, [WNA, FRAC]);
    // PROB is the only started, non-exhausted outside domain → nextOpen.
    expect(sel.nextOpen?.domain).toBe(PROB);
    // Started outside domains appear (summited ones with a ✓); the fresh non-next
    // one (integers) does not.
    expect(sel.switchable.map((d) => d.domain)).toEqual([PROB, "geometry"]);
    // In-blend domains are never switch targets.
    expect(sel.switchable.some((d) => d.domain === WNA || d.domain === FRAC)).toBe(false);
  });

  it("handles an empty domain list without throwing", () => {
    const sel = selectMixedSummitHandoff([], [WNA, FRAC]);
    expect(sel.domainsInSet).toEqual([]);
    expect(sel.allExhausted).toBe(false);
    expect(sel.allPlacedThrough).toBe(false);
    expect(sel.nextOpen).toBeNull();
    expect(sel.switchable).toEqual([]);
  });
});

// The native iPad app can't import from shared/ at runtime (metro won't crawl
// outside its root under --reset-cache), so native/scripts/sync-vendor.js copies
// this file to native/vendor/shared/practiceSummit.ts read-only. The web summit
// surface and the native one MUST agree on "which domain is next" — a drift here
// silently splits the handoff decision. This makes divergence un-mergeable:
// re-run `node native/scripts/sync-vendor.js` after editing shared/practiceSummit.ts.
describe("native vendor copy is in lockstep", () => {
  it("native/vendor/shared/practiceSummit.ts is byte-identical to shared/practiceSummit.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "practiceSummit.ts"), "utf8");
    const vendored = readFileSync(
      join(here, "..", "native", "vendor", "shared", "practiceSummit.ts"),
      "utf8",
    );
    expect(vendored, "vendor copy drifted — run `node native/scripts/sync-vendor.js`").toBe(
      source,
    );
  });
});
