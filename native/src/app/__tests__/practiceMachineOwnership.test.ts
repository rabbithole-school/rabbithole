import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// The native mirror of components/practice/__tests__/practiceMachineOwnership
// .test.ts — a literal source-shape regression enforcing that
// `usePracticeMachine` plus its coordinator remain the SOLE canonical owner
// of run idx/item phase/hasRecorded/missCount/hint progression/breaker
// state/lane suspension/persistence/terminal/tune-up completion in
// native/src/app/practice.tsx. It is deliberately a string/regex check on the
// FILE, not a rendered-component test: this screen has no existing render
// harness (mounting it needs ~20 mocked Convex queries), and the property
// being enforced — "the deleted orchestration never comes back" — is a
// property of the SOURCE, not of any one behavior a render would exercise.
// ─────────────────────────────────────────────────────────────────────────

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const source = readFileSync(resolve(repoRoot, "native/src/app/practice.tsx"), "utf8");
const executorSource = readFileSync(
  resolve(repoRoot, "native/src/hooks/usePracticeMachine.ts"),
  "utf8",
);
const manipulativeSource = readFileSync(
  resolve(repoRoot, "native/src/components/manipulatives/NativeManipulativeItem.tsx"),
  "utf8",
);
const breakerHydrationSource = readFileSync(
  resolve(repoRoot, "native/src/lib/breakerHydration.ts"),
  "utf8",
);

describe("native practice.tsx machine ownership", () => {
  it("uses the shared machine as its orchestration boundary", () => {
    expect(source).toContain("usePracticeMachine(");
    expect(source).toContain('type: "run:inputsChanged"');
    expect(breakerHydrationSource).toContain('type: "hydrate:breaker"');
    expect(source).toContain('type: "ui:submit"');
    expect(source).toContain('type: "lane:mappingAnswered"');
    expect(source).toContain('type: "lane:mappingRetry"');
    expect(source).toContain('type: "lane:batchAppended"');
    expect(source).toContain('type: "lane:handoffClosed"');
    expect(source).toContain('type: "lane:coachEnded"');
    expect(source).toContain('type: "lane:tailAccepted"');
    expect(source).toContain('type: "lane:beatProceeded"');
    expect(source).toContain('type: "lane:entered"');
    expect(source).toContain('type: "ui:retry"');
    expect(source).toContain('type: "ui:breakerRepairStarted"');
    expect(source).toContain('type: "ui:breakerEasyFinish"');
    expect(source).toContain('type: "ui:breakerCoach"');
    expect(source).toContain('type: "ui:breakerClose"');
    expect(source).toContain("useLayoutEffect(");
    // The executor (native's usePracticeMachine.ts) is the ONLY place that
    // calls the durable mutations directly, or touches the outbox/resume
    // storage contracts — never the component.
    expect(executorSource).toContain('type: "run:loaded"');
    expect(executorSource).toContain('type: "hydrate:resume"');
    expect(executorSource).toContain("enqueueOutboxAnswer(");
    expect(executorSource).toContain("submitWithOutboxBarrier(");
    expect(executorSource).toContain("withPracticeSubmitTimeout(");
    expect(source).not.toContain("useMutation(api.practiceSkills.submitAnswer)");
    expect(source).not.toContain("useMutation(api.practiceSkills.serveHintStep)");
    expect(source).not.toContain("useMutation(api.practiceSkills.recordBreakerRecoveryLifecycle)");
    expect(source).not.toContain("useMutation(api.practiceSkills.recordBreakerOutcome)");
    expect(source).not.toContain("useMutation(api.practiceTuneups.complete)");
  });

  it("does not restore the deleted native orchestration cluster", () => {
    for (const identifier of [
      "breakerRef",
      "breakerOutcomeReportedRef",
      "breakerRecoveryCorrectRef",
      "breakerRepairStartedRef",
      "breakerCoachStartedRef",
      "breakerShownReportedRef",
      "breakerFreshItemIdRef",
      "breakerFreshRequestedRef",
      "breakerRecoveryVerifiedRef",
      "breakerLifecycleQueueRef",
      "submitInFlightRef",
      "answerEventRef",
      "continuingMappingRef",
      "seedRef",
      "loadedDomainRef",
      "ladderCoachPulledRef",
      "tuneupCompletedRef",
    ]) {
      expect(source, identifier).not.toContain(identifier);
    }
    // The mutation handle survives — PR1 (web) kept it for the exact same
    // reason: `completeTuneup`'s tuneupId argument has to come from
    // somewhere, and the reducer's `terminate()` only carries `run.tuneupId`
    // (a value, not a mutable handle the accept flow can stash into).
    expect(source).toContain("tuneupIdRef");
  });

  it("has no parallel canonical setters, direct submit/hint/breaker mutations, or legacy orchestration helpers", () => {
    for (const forbidden of [
      "setIdx(",
      "setPhase(\"answering\")",
      "setPhase(\"feedback\")",
      "setPhase(\"handoff\")",
      "setPhase(\"breakerRepair\")",
      "setPhase(\"breakerClose\")",
      "setBreaker(",
      "setHasRecorded(",
      "setMissCount(",
      "setShowHint(",
      "setHintItemId(",
      "setHintNextStepIndex(",
      "setHintStepsExhausted(",
      "setHintStepLoading(",
      "setAllMapping(",
      "setDone(",
      "openBreakerOffer(",
      "advanceBreaker(",
      "reportBreakerLifecycle(",
      "escalateBreakerCoach(",
      "closeBreaker(",
      "startBreakerFresh(",
      "startBreakerEasyFinish(",
      "finishBreakerFresh(",
      "finishBreakerEasy(",
      "openBreakerRepair(",
      "clientEventIdFor(",
      "onManipulativeGraded",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    // The one allowed `setPhase` is `NativeReprobeOffer`'s own unrelated
    // local phase state ("offer" | "probing" | "submitting" | "result") —
    // confirmed by grep, not by this test (a different lane-local component
    // entirely, never the machine's Phase union).
  });

  it("routes the manipulative item through the machine, not a second direct mutation", () => {
    expect(source).toContain("submitAnswerOverride={submitManipulativeAnswer}");
    expect(manipulativeSource).toContain("submitAnswerOverride");
    expect(manipulativeSource).toContain('status: "queued"');
    expect(manipulativeSource).toContain('status: "graded"');
    expect(manipulativeSource).toContain("if (!submitAnswerOverride)");
    expect(source).toContain("machine.state.item.clientEventId");
    expect(source).toContain("clientEventKey");
    expect(
      source.match(/submissionReplay: machine\.state\.item\.clientEventReplay/g),
    ).toHaveLength(3);
    expect(manipulativeSource).toContain("payloadClientEventReceipt");
    expect(manipulativeSource).toContain("standaloneClientEventReceiptRef");
    expect(source).toContain("latencyMs: args.firstKeyMs");
    expect(source).toContain("thinkTimeMs: args.elapsedMs");
  });

  it("uses the frozen lifecycle retry contract without relaunching a recoverable coach", () => {
    expect(executorSource).toContain("retryBreakerLifecycleWrite({");
    expect(executorSource).toContain('type: "server:lifecycleFailed"');
    expect(breakerHydrationSource).toContain(
      "confirmedLifecycle: episode.confirmedLifecycle",
    );
    expect(source).toContain("breakerLifecycleRecoveryNeeded");
    expect(source).toContain('type: "ui:retryBreakerLifecycle"');
    expect(source).toContain(
      "That step couldn’t be saved yet. Your work is still here.",
    );

    const coachStart = executorSource.indexOf('case "launchCoach":');
    const coachEnd = executorSource.indexOf(
      'case "recordBreakerOutcome":',
      coachStart,
    );
    const coach = executorSource.slice(coachStart, coachEnd);
    expect(coach.indexOf("host.onCoach();")).toBeLessThan(
      coach.indexOf('type: "server:coachOpened"'),
    );
    expect(coach.indexOf('type: "server:coachOpened"')).toBeLessThan(
      coach.indexOf("await persistBreakerLifecycle("),
    );
  });

  it("gives every durably queued answer an enabled advance without claiming a grade", () => {
    expect(source).toContain('phase === "queued"');
    expect(source).toContain("guardedQueuedNext");
    expect(source).toContain("Saved — you're offline");
    expect(source).toContain(
      'accessibilityLabel={isLast ? "Finish practice" : "Next question"}',
    );
    const answerAreaStart = source.indexOf("function AnswerArea(");
    const answerAreaEnd = source.indexOf("function ConfidenceSegments(", answerAreaStart);
    const answerArea = source.slice(answerAreaStart, answerAreaEnd);
    expect(answerArea).toContain('const isAnswering = phase === "answering";');
    expect(answerArea).toContain("if (!isAnswering) return null;");
    expect(answerArea).toContain("enabled={isAnswering && !busy}");
  });

  it("clears lane-local item state before every machine-owned advance", () => {
    const start = source.indexOf("const advance = useCallback");
    const end = source.indexOf(
      "// The three-miss breaker is now entirely machine-owned",
      start,
    );
    const advance = source.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(advance).toContain("resetItemHostState();");
    expect(advance).not.toContain("setMappingRetry(");
    const resetStart = source.indexOf("const resetItemHostState = useCallback");
    const resetEnd = source.indexOf(
      "// The `loadRun` half of `PracticeHostBindings`",
      resetStart,
    );
    const reset = source.slice(resetStart, resetEnd);
    expect(reset).toContain("setError(null);");
  });

  it("clears a mapping-confirm screen whenever the mapping answer settles", () => {
    const settlements =
      source.match(
        /setMappingRetry\(false\);\s*machine\.send\(\{\s*type: "lane:mappingAnswered"/g,
      ) ?? [];
    expect(settlements).toHaveLength(2);
  });

  it("maps native timing readings into the durable outbox field names", () => {
    expect(source).not.toContain("...timing,");
    expect(source.match(/latencyMs:\s*timing\.firstKeyMs/g)).toHaveLength(2);
    expect(source.match(/thinkTimeMs:\s*timing\.elapsedMs/g)).toHaveLength(2);
  });

  it("keeps host item-count removal and the machine delta in one synchronous branch", () => {
    const start = source.indexOf("const onReportHelpUsed = useCallback");
    const end = source.indexOf(
      '// "I haven\'t learned this yet"',
      start,
    );
    const helpUsed = source.slice(start, end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(helpUsed).toContain("setItems(items.slice(0, lastIdx));");
    expect(helpUsed).toContain(
      'machine.send({ type: "run:itemCountAdjusted", delta: -1 });',
    );
    expect(helpUsed).not.toContain("let withdrew");
  });

  it("hides its own don't-know skip link while offline, not just the pad items' (acceptance #7)", () => {
    expect(manipulativeSource).toMatch(
      /const showSkip =\s*!!onDontKnow && online &&/,
    );
  });

  it("threads Quick Facts containment into every canonical entry point (reducer-level suppression is covered by shared/practiceMachine.test.ts's own 'Quick Facts containment' suite)", () => {
    // The reducer's OWN suppression logic (a threshold miss never opens a
    // breaker when `run.suppressBreaker` is true) is already exhaustively
    // covered against the real reducer in shared/practiceMachine.test.ts. The
    // native-specific seam this guards is narrower but just as capable of
    // regressing silently: every host call site that constructs canonical
    // state must actually SET suppressBreaker from `quickFacts`, or the
    // reducer's containment logic never even sees it asked for.
    expect(source).toContain("suppressBreaker: quickFacts");
    const threaded = source.match(/suppressBreaker:\s*(?:quickFacts|Boolean\(quickFacts\))/g) ?? [];
    // The initial newPracticeState() call, plus every OutboxAnswer-adjacent
    // entry construction (ordinary ui:submit routing, the breaker fresh/easy
    // direct-mutation args, and the manipulative submit-context builder).
    expect(threaded.length).toBeGreaterThanOrEqual(4);
  });

  it("keeps a reasonable effect-count ceiling that still allows legitimate native UI effects", () => {
    // Matches web's practiceMachineOwnership.test.ts methodology exactly:
    // `\buseEffect\(` never matches `useLayoutEffect(` (no word boundary
    // between "Layout" and "Effect"), so the one host-bindings layout effect
    // is deliberately excluded from this ceiling.
    const effects = source.match(/\buseEffect\(/g) ?? [];
    expect(effects.length).toBeLessThanOrEqual(16);
    // And exactly one layout effect — the host bindings installer — not two
    // (a second would mean something is racing the bindings install).
    const layoutEffects = source.match(/\buseLayoutEffect\(/g) ?? [];
    expect(layoutEffects.length).toBe(1);
  });
});
