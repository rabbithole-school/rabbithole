import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = readFileSync(
  resolve(repoRoot, "components/practice/PracticeSession.tsx"),
  "utf8",
);
const executorSource = readFileSync(
  resolve(repoRoot, "hooks/usePracticeMachine.ts"),
  "utf8",
);
const nativeManipulativeSource = readFileSync(
  resolve(
    repoRoot,
    "native/src/components/manipulatives/NativeManipulativeItem.tsx",
  ),
  "utf8",
);
const embedManipulativeSource = readFileSync(
  resolve(repoRoot, "app/embed/manipulative/page.tsx"),
  "utf8",
);

describe("PracticeSession machine ownership", () => {
  it("uses the shared machine as its orchestration boundary", () => {
    expect(source).toContain("usePracticeMachine(");
    expect(source).toContain('type: "run:inputsChanged"');
    expect(executorSource).toContain('type: "run:loaded"');
    expect(source).toContain('type: "lane:mappingAnswered"');
    expect(source).toContain('type: "lane:handoffClosed"');
    expect(source).toContain('type: "lane:tailAccepted"');
    expect(source).toContain("useLayoutEffect(");
    expect(executorSource).not.toContain("pending.current");
    expect(executorSource).toContain("enqueueOutboxAnswer(");
    expect(executorSource).toContain("withPracticeSubmitTimeout(");
    const easyIdentityGuard = executorSource.indexOf(
      "breakerEasyItemMatchesCommand(command, item.itemId)",
    );
    const easyPayloadInstall = executorSource.indexOf(
      'host.onBreakerItem(item, "easy")',
    );
    expect(easyIdentityGuard).toBeGreaterThan(-1);
    expect(easyPayloadInstall).toBeGreaterThan(easyIdentityGuard);
    const easyExecutor = executorSource.slice(
      executorSource.indexOf('case "serveBreakerEasy"'),
      executorSource.indexOf('case "launchCoach"'),
    );
    expect(easyExecutor).toContain(
      'host.onHintError("That easy finish couldn’t load — try again.")',
    );
    expect(easyExecutor).toContain(
      'dispatch({ type: "server:commandFailed", id: command.id })',
    );
    expect(source).toContain("Loading your easy finish…");
    expect(source).toContain(
      'breaker.flow.easy === "requested"',
    );
    expect(executorSource).toContain("host.onSubmitError(null)");
    expect(executorSource.match(/host\.onSubmitError\(/g)).toHaveLength(3);
    expect(executorSource).toContain(
      "command.entry.submissionReplay ?? true",
    );
    expect(source).toContain("machine.state.item.clientEventReplay");
    expect(source).toContain("{submitError}");
  });

  it("keys manipulative receipts to the exact submitted payload", () => {
    for (const manipulativeSource of [
      nativeManipulativeSource,
      embedManipulativeSource,
    ]) {
      expect(manipulativeSource).toContain("payloadClientEventReceipt(");
      expect(manipulativeSource).toContain("payloadKey");
      expect(manipulativeSource).not.toContain(
        "useRef<string | null>(null)",
      );
    }
  });

  it("does not restore the deleted orchestration refs", () => {
    for (const identifier of [
      "breakerRef",
      "breakerRepairStartedRef",
      "breakerCoachStartedRef",
      "breakerShownReportedRef",
      "breakerFreshRequestedRef",
      "breakerLifecycleQueueRef",
      "breakerOutcomeReportedRef",
      "breakerFreshItemIdRef",
      "breakerRecoveryVerifiedRef",
      "answerEventRef",
      "ladderCoachPulledRef",
      "loadedInputKeyRef",
      "doneHapticFired",
      "tuneupCompletedRef",
    ]) {
      expect(source, identifier).not.toContain(identifier);
    }
    expect(source).toContain("tuneupIdRef");
  });

  it("has no parallel canonical setters or direct advancement helpers", () => {
    for (const forbidden of [
      "setIdx(",
      "setPhase(",
      "setBreaker(",
      "setHasRecorded(",
      "setMissCount(",
      "setShowHint(",
      "setHintStepLoading(",
      "advanceBreakerFlow(",
      "advanceStep(",
      "useMutation(api.practiceSkills.submitAnswer)",
      "useMutation(api.practiceSkills.serveHintStep)",
      "drainOfflineQueue(",
      "saveResume<",
      "clearResume(",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("removed at least ten component orchestration effects", () => {
    const effects = source.match(/\buseEffect\(/g) ?? [];
    expect(effects.length).toBeLessThanOrEqual(15);
  });
});
