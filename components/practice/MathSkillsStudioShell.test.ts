import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The shell is wired directly to live Convex hooks, with no component render
// harness in this repo. What it gets wrong is ORDER, not arithmetic: two
// effects fire in the same commit and the wrong one winning silently discards
// the scope a shared link named. Pin that ordering beside the component.
const source = readFileSync(
  new URL("./MathSkillsStudioShell.tsx", import.meta.url),
  "utf8",
);

function scopeReconcileEffect() {
  const start = source.indexOf('if (rosterLoading || scopeKey === "") return;');
  const end = source.indexOf("}, [", start);
  if (start < 0 || end < 0) {
    throw new Error("Math Skills scope-reconcile effect markers not found.");
  }
  return source.slice(start, end);
}

describe("Math Skills scope reconcile", () => {
  // Without these the reconcile judges a guest-inclusive `?scope=` against a
  // filter/roster that is one step behind the widen it already earned, and
  // clears it — the deep link lands on All scholars for no visible reason.
  test("holds while the deep-link widen is undecided or the roster is still enrolled-only", () => {
    const effect = scopeReconcileEffect();

    expect(effect).toMatch(
      /if\s*\(pendingDeepLinkWiden\s*\|\|\s*rosterWidening\)\s*return;/,
    );
    // The guard has to precede every clear, or it guards nothing.
    const guardAt = effect.search(/pendingDeepLinkWiden/);
    const firstClearAt = effect.indexOf("onSelectScope(");
    expect(guardAt).toBeGreaterThanOrEqual(0);
    expect(firstClearAt).toBeGreaterThan(guardAt);
  });

  test("both gates are reactive deps, so the reconcile re-runs when they clear", () => {
    const deps = source.slice(source.indexOf("}, [", source.indexOf('if (rosterLoading || scopeKey === "") return;')));
    const depList = deps.slice(0, deps.indexOf("]"));

    expect(depList).toContain("pendingDeepLinkWiden");
    expect(depList).toContain("rosterWidening");
  });

  // A latch would mean setState-in-effect (new lint debt against an empty
  // baseline, and cascading renders). The gate is derived from the same pure
  // decision the hook drives, so the two cannot disagree.
  test("derives the gate rather than latching it in state", () => {
    expect(source).toContain("decideDeepLinkParticipation({ ...deepLinkInputs");
    expect(source).not.toMatch(/setSettled|setDeepLink/);
  });
});

describe("Math Skills scholar deep link", () => {
  // `resolveSlug` returns undefined in flight and null on a resolved miss.
  // `slugResolution?.enrollmentStanding` collapses both to undefined, which
  // reads as "still loading" forever and never lets the widen latch.
  test("maps the slug resolution through resolvedEnrollmentStanding, not optional chaining", () => {
    expect(source).toContain(
      "resolvedEnrollmentStanding(scholarSlugResolution)",
    );
    expect(source).not.toMatch(/scholarSlugResolution\?\./);
  });

  // The roster is enrolled-only until the widen lands, so it is structurally
  // incapable of resolving the one scholar this link is about.
  test("resolves the slug with the indexed query rather than the participation-filtered roster", () => {
    expect(source).toContain("api.scholars.resolveSlug");
  });
});
