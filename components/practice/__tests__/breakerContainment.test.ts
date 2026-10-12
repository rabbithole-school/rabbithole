import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The web twin of the breaker-containment assertions in
// native/src/app/__tests__/practiceMachineOwnership.test.ts.
//
// A breaker episode is scholar-WIDE (the miss streak is counted across every
// lane and domain), but it also outranks loading a run — so it must only own
// the run it actually belongs to. Both surfaces key their practice screen
// WITHOUT the domain, so a domain switch re-renders in place and stale
// breaker state would keep refusing every load, for longer than the episode
// itself lives. Observed in class 2026-09-17: a scholar's seven math domains
// all showed the breaker's close card with no items behind it.
//
// Deliberately a source-shape check, like its native mirror: mounting
// PracticeSession needs ~20 mocked Convex queries, while the property being
// enforced — the clear is dispatched, from the shared predicate, BEFORE the
// run is requested — is a property of the source.
// ─────────────────────────────────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(
  resolve(repoRoot, "components/practice/PracticeSession.tsx"),
  "utf8",
);

describe("web PracticeSession breaker containment", () => {
  it("clears a non-applicable breaker before asking for a run", () => {
    expect(source).toContain('type: "hydrate:noBreakerForRun"');
    const clear = source.indexOf('type: "hydrate:noBreakerForRun"');
    const load = source.indexOf('type: "run:inputsChanged"', clear);
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(load).toBeGreaterThan(clear);
  });

  it("decides applicability with the ONE shared predicate", () => {
    expect(source).toContain("breakerEpisodeAppliesToRun({");
    // Never a locally re-derived domain comparison against the episode.
    expect(source).not.toMatch(/activeBreakerEpisode\.domain\s*===/);
  });

  it("hydrates only the episode that passed the predicate", () => {
    // The event must carry the FILTERED episode, not the raw query result —
    // that substitution is the whole fix.
    const hydrate = source.indexOf('type: "hydrate:breaker"');
    expect(hydrate).toBeGreaterThanOrEqual(0);
    const block = source.slice(hydrate, hydrate + 900);
    expect(block).toContain("breakerEpisode.triggerAttemptId");
    expect(block).not.toContain("activeBreakerEpisode.triggerAttemptId");
  });
});
