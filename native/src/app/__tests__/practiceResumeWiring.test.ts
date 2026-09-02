import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// Native-specific wiring seams for acceptance #5 ("Full resume/hydration")
// that the shared contract tests structurally cannot cover, because they
// test the pure contract in isolation, not whether THIS host actually calls
// it correctly:
//   - shared/practiceResumeContract.test.ts already exhaustively covers
//     isResumableSnapshot/authoritativeResumeIndex, INCLUDING the Quick
//     Facts QUICK_FACTS_SCOPE_KEY sentinel semantics, against the pure
//     contract.
//   - shared/practiceOutboxContract.test.ts + native's own
//     practicePersistenceAdapter.test.ts already cover "an enqueued outbox
//     entry survives a read/write round trip and is never silently dropped".
// What's left, and native-specific: does native's `loadRun` actually reach
// those pure functions with the RIGHT arguments? This file pins down (as a
// regression guard) a real bug found and fixed during this migration: an
// early draft gated resume-checking on `!quickFacts`, which skipped resume
// entirely for Quick Facts (diverging from web, which resumes Quick Facts
// too, substituting the QUICK_FACTS_SCOPE_KEY sentinel for the ordinary
// scopeKey). It also confirms the outbox is read/enqueued unconditionally
// (no invented client-side expiry), and that a saved snapshot never carries
// an answer.
// ─────────────────────────────────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const source = readFileSync(resolve(repoRoot, "native/src/app/practice.tsx"), "utf8");

describe("native resume/outbox wiring seams", () => {
  it("checks resume validity for EVERY run, including Quick Facts (regression guard)", () => {
    // The bug this guards: `if (!forceFresh && !quickFacts)` skipped the
    // whole resume-snapshot check for Quick Facts. The fix checks resume
    // for any non-forced load and substitutes the QUICK_FACTS_SCOPE_KEY
    // sentinel for the ordinary scopeKey only inside the validity object —
    // exactly mirroring components/practice/PracticeSession.tsx's
    // `loadSession`.
    expect(source).toContain("if (!forceFresh) {");
    expect(source).not.toContain("if (!forceFresh && !quickFacts)");
    expect(source).toContain("scopeKey: quickFacts ? QUICK_FACTS_SCOPE_KEY : currentScope.scopeKey");
  });

  it("never claims a resumed item was already recorded (authoritative first-unrecorded index)", () => {
    // hydrate:resume's `hasRecorded` must be false — resumeIdx IS the first
    // UNRECORDED item; claiming otherwise would silently skip grading it.
    expect(source).toMatch(/resume:\s*\{\s*idx:\s*snapshot\.resumeIdx,\s*hasRecorded:\s*false,/);
  });

  it("gives resumed mapping submissions a real per-run seed", () => {
    const loadRunStart = source.indexOf("const loadRun = useCallback");
    const resumeCheck = source.indexOf("if (!forceFresh) {", loadRunStart);
    const seedWrite = source.indexOf("setRunSeed(seed);", loadRunStart);
    expect(loadRunStart).toBeGreaterThanOrEqual(0);
    expect(seedWrite).toBeGreaterThan(loadRunStart);
    expect(seedWrite).toBeLessThan(resumeCheck);
  });

  it("never persists an answer, record, or grade into a resume snapshot", () => {
    const buildFn = source.match(
      /const buildResumeSnapshot = useCallback\([\s\S]*?\n {2}\);\n/,
    )?.[0];
    expect(buildFn, "buildResumeSnapshot definition not found").toBeTruthy();
    for (const forbidden of ["answer:", "record:", "correct:", "grade"]) {
      expect(buildFn, forbidden).not.toContain(forbidden);
    }
  });

  it("reads the pending outbox unconditionally on mount, with no invented client-side expiry", () => {
    expect(source).not.toMatch(/expir|maxAge|\bttl\b/i);
  });
});

describe("native offline don't-know no-op (acceptance #7, regression guard)", () => {
  // A real gap found and fixed during this migration: an early draft's
  // `onDontKnow` guard was `if (!current || busy || !isFirstAttempt(...))`
  // — missing the offline check web's exact equivalent has
  // (`if (!current || busy || isOffline || !isFirstAttempt(...))` in
  // components/practice/PracticeSession.tsx). Without it, tapping "I
  // haven't learned this yet" while offline would enqueue a `dontKnow`
  // outbox entry and submit it once back online — never a no-op — directly
  // contradicting "do not enqueue and do not submit".
  const onDontKnowFn = source.match(
    /const onDontKnow = useCallback\(async \(\) => \{\n {4}if \([^\n]*\) return;/,
  )?.[0];

  it("the handler's own top-level guard checks online status before anything else", () => {
    expect(onDontKnowFn, "onDontKnow definition/guard not found").toBeTruthy();
    expect(onDontKnowFn).toMatch(/if \(!current \|\| busy \|\| !online \|\|/);
  });

  it("the affordance is HIDDEN (not merely disabled) while offline, both for pad items and the manipulative card", () => {
    // The outer (typed/MC) skip link.
    expect(source).toMatch(/showSkip=\{\s*phase === "answering" &&\s*online &&/);
    // The manipulative card gets the SAME signal threaded in as a prop, so
    // its OWN internal skip link (a separate render tree) hides identically
    // rather than only no-op'ing on tap.
    expect(source).toMatch(/<NativeManipulativeItem[\s\S]*?online=\{online\}[\s\S]*?\/>/);
  });
});
