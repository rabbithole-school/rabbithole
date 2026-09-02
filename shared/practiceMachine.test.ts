import { describe, expect, it } from "vitest";

import {
  breakerEasyItemMatchesCommand,
  breakerCommandId,
  DURABLE_COMMAND_KINDS,
  isDurableCommand,
  newPracticeState,
  practiceReduce,
  resumeIdx,
  runPracticeEvents,
  submitCommandId,
  type PracticeCommand,
  type PracticeEvent,
  type PracticeState,
} from "./practiceMachine";
import {
  advanceBreakerFlow,
  breakerLegacyOffer,
  newBreakerFlow,
} from "./practiceLoop";
import type { OutboxAnswer } from "./practiceOutboxContract";

// ─────────────────────────────────────────────────────────────────────────
// Characterization vectors for the practice machine.
//
// These assert the COMMANDS the machine emits, in order — not just the state
// it lands in. A reducer that reaches the right state while emitting the wrong
// side effects (two submits, a submit that bypasses the outbox barrier, a
// breaker item served before the write that authorizes it) is exactly the
// class of bug the old effect/ref orchestration produced, and a state-only
// assertion cannot see any of it.
//
// The scenarios come from the behavior of the current web and native run
// screens: their submit paths, their breaker chains, and the failure/ordering
// paths their refs and promise-chains were compensating for.
// ─────────────────────────────────────────────────────────────────────────

const SCHOLAR = "scholar-1";

function entry(over: Partial<OutboxAnswer> = {}): OutboxAnswer {
  return {
    clientEventId: "evt-1",
    itemId: "item-1",
    answer: "42",
    record: true,
    skillLabel: "Add fractions",
    queuedAt: 1_000,
    ...over,
  };
}

function start(over: Parameters<typeof newPracticeState>[0] extends never ? never : Partial<Parameters<typeof newPracticeState>[0]> = {}): PracticeState {
  return newPracticeState({
    scholarId: SCHOLAR,
    itemCount: 6,
    itemId: "item-1",
    ...over,
  });
}

const kinds = (commands: PracticeCommand[]) => commands.map((c) => c.kind);
const ids = (commands: PracticeCommand[]) => commands.map((c) => c.id);

function acknowledgeLifecycle(step: ReturnType<typeof practiceReduce>) {
  const command = step.commands.find(
    (candidate) => candidate.kind === "recordBreakerLifecycle",
  );
  expect(command).toBeDefined();
  return practiceReduce(step.state, {
    type: "server:lifecycleRecorded",
    id: command!.id,
  });
}

/** Drive an answer all the way to a graded verdict. */
function answered(state: PracticeState, correct: boolean, over: Partial<OutboxAnswer> = {}) {
  const e = entry(over);
  const submitted = practiceReduce(state, {
    type: "ui:submit",
    answer: e.answer,
    clientEventId: e.clientEventId,
    entry: e,
  });
  return practiceReduce(submitted.state, {
    type: "server:submitSucceeded",
    id: submitCommandId(e.clientEventId),
    result: { correct },
  });
}

describe("ordinary submit", () => {
  it("emits exactly one submitAnswer, routed through the outbox domain", () => {
    const e = entry();
    const step = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });

    expect(kinds(step.commands)).toEqual(["submitAnswer"]);
    const [command] = step.commands;
    expect(command!.kind).toBe("submitAnswer");
    // The barrier is the only path to the network: a submit that named no
    // outbox domain could overtake an older queued answer.
    expect((command as Extract<PracticeCommand, { kind: "submitAnswer" }>).domain).toBe(
      `outbox:${SCHOLAR}`,
    );
    expect(command!.id).toBe(submitCommandId("evt-1"));
    expect(step.state.item.phase).toEqual({
      kind: "submitting",
      commandId: submitCommandId("evt-1"),
    });
  });

  it("treats a multiple-choice index as the same opaque answer contract", () => {
    const choice = entry({ answer: "2", clientEventId: "evt-choice" });
    const step = practiceReduce(start(), {
      type: "ui:submit",
      answer: choice.answer,
      clientEventId: choice.clientEventId,
      entry: choice,
    });
    const command = step.commands[0] as Extract<
      PracticeCommand,
      { kind: "submitAnswer" }
    >;
    expect(command.entry.answer).toBe("2");
    expect(command.id).toBe(submitCommandId("evt-choice"));
  });

  it("ignores a second tap while a submit is in flight", () => {
    const e = entry();
    const first = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const second = practiceReduce(first.state, {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: "evt-2",
      entry: entry({ clientEventId: "evt-2" }),
    });
    // The old code needed `busy` AND `submitInFlightRef` for this.
    expect(second.commands).toEqual([]);
    expect(second.state).toBe(first.state);
  });

  it("records the grade and saves a resume snapshot", () => {
    const step = answered(start(), true);
    expect(step.state.item.phase).toEqual({ kind: "feedback", correct: true });
    expect(step.state.item.hasRecorded).toBe(true);
    expect(kinds(step.commands)).toEqual(["saveResume", "haptic"]);
  });

  it("advances the resume position past a recorded item, never re-serving it", () => {
    const graded = answered(start(), true);
    // hasRecorded → the first UN-recorded index is the next one.
    expect(resumeIdx(graded.state)).toBe(1);
    const advanced = practiceReduce(graded.state, { type: "ui:advance" });
    expect(advanced.state.run.idx).toBe(1);
    expect(resumeIdx(advanced.state)).toBe(1);
  });
});

describe("stale, late and duplicate results", () => {
  it("drops a success whose command id is not the one being awaited", () => {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const stale = practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("some-other-receipt"),
      result: { correct: true },
    });
    expect(stale.state).toBe(submitted.state);
    expect(stale.commands).toEqual([]);
  });

  it("drops a duplicate success for a command already applied", () => {
    const graded = answered(start(), true);
    const again = practiceReduce(graded.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-1"),
      result: { correct: true },
    });
    // Applying it twice would double-count the run and re-fire the haptic.
    expect(again.commands).toEqual([]);
    expect(again.state.run.correctCount).toBe(1);
  });

  it("drops a response that lands after the scholar moved on", () => {
    const graded = answered(start(), true);
    const advanced = practiceReduce(graded.state, { type: "ui:advance" });
    const late = practiceReduce(advanced.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-1"),
      result: { correct: false },
    });
    expect(late.state).toBe(advanced.state);
  });
});

describe("command failure", () => {
  it("releases a failed submit for an identical receipt-preserving retry", () => {
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: "42",
      clientEventId: "evt-failed",
      clientEventKey: "item-1:42",
      entry: entry({ clientEventId: "evt-failed" }),
    });
    const failed = practiceReduce(submitted.state, {
      type: "server:commandFailed",
      id: submitCommandId("evt-failed"),
    });
    expect(failed.state.item.phase).toEqual({ kind: "answering" });
    expect(failed.state.item.clientEventId).toBe("evt-failed");
    expect(failed.state.item.clientEventKey).toBe("item-1:42");
  });

  it("releases a failed hint command without inventing a served rung", () => {
    const opened = practiceReduce(start(), { type: "ui:hintPressed" });
    const requested = practiceReduce(opened.state, {
      type: "ui:hintPressed",
    });
    const failed = practiceReduce(requested.state, {
      type: "server:commandFailed",
      id: requested.commands[0]!.id,
    });
    expect(failed.state.hint.pendingCommandId).toBeNull();
    expect(failed.state.hint.nextStepIndex).toBe(0);
  });
});

describe("ambiguous failure and the queued path", () => {
  it("queues without claiming a grade, and still lets the scholar advance", () => {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const queued = practiceReduce(submitted.state, {
      type: "server:submitQueued",
      id: submitCommandId("evt-1"),
      queuedCount: 1,
    });
    expect(queued.state.item.phase).toEqual({ kind: "queued", queuedCount: 1 });
    // Recorded for resume purposes, but there is no verdict to show.
    expect(queued.state.item.hasRecorded).toBe(true);
    expect(queued.state.run.correctCount).toBe(0);

    const advanced = practiceReduce(queued.state, { type: "ui:advance" });
    expect(advanced.state.run.idx).toBe(1);
  });

  it("keeps the receipt on a hard failure so the retry replays the SAME id", () => {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const failed = practiceReduce(submitted.state, {
      type: "server:submitFailed",
      id: submitCommandId("evt-1"),
      submissionReplay: false,
    });
    // Neither submitted nor durably queued: back to answering, and the receipt
    // survives so the server's dedup can recognize the retry.
    expect(failed.state.item.phase).toEqual({ kind: "answering" });
    expect(failed.state.item.clientEventId).toBe("evt-1");
    expect(failed.state.item.clientEventReplay).toBe(false);
    expect(failed.state.item.hasRecorded).toBe(false);
  });

  it("cannot advance while a submit is still in flight", () => {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const advanced = practiceReduce(submitted.state, { type: "ui:advance" });
    expect(advanced.state).toBe(submitted.state);
  });
});

describe("drain acknowledgements stay off the current item", () => {
  it("never turns a replayed historical answer into this item's grade", () => {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const drained = runPracticeEvents(submitted.state, [
      { type: "persist:drainProgressed", id: `drain:${SCHOLAR}`, remaining: 1 },
      { type: "persist:drainSettled", id: `drain:${SCHOLAR}`, outcome: "drained" },
    ]);
    // Still waiting on the live submit — the drain said nothing about it.
    expect(drained.state.item.phase).toEqual({
      kind: "submitting",
      commandId: submitCommandId("evt-1"),
    });
    expect(drained.commands).toEqual([]);
  });

  it("drains on mount and on reconnect, without needing a connectivity flap", () => {
    const mounted = practiceReduce(start(), { type: "env:mounted", queuedCount: 2 });
    expect(kinds(mounted.commands)).toEqual(["drainOutbox"]);
    const online = practiceReduce(mounted.state, { type: "env:online" });
    expect(kinds(online.commands)).toEqual(["drainOutbox"]);
    // Same semantic id both times, so the host's claim registry collapses them.
    expect(ids(online.commands)).toEqual([`drain:${SCHOLAR}`]);
  });
});

describe("breaker", () => {
  const backOff = {
    triggerAttemptId: "attempt-1",
    triggerNodeKey: "node-1",
    domain: "whole-number-arithmetic",
    missStreak: 3,
    recoveryAvailable: true,
    initialRepairStatus: "opening" as const,
    repairStepIndex: null,
  };

  function triggered() {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    return practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-1"),
      result: { correct: false, backOff },
    });
  }

  function freshIssued() {
    const shown = practiceReduce(triggered().state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "reveal",
    });
    const shownRecorded = acknowledgeLifecycle(shown);
    return acknowledgeLifecycle(shownRecorded);
  }

  function completedLifecyclePending() {
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: "1",
      clientEventId: "evt-pending",
      entry: entry({ clientEventId: "evt-pending" }),
    });
    return practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-pending"),
      result: {
        correct: false,
        backOff: {
          ...backOff,
          initialRepairStatus: "done",
          repairStepIndex: 0,
        },
      },
    });
  }

  it("clears the local resume and serves the repair rung, never a snapshot", () => {
    const step = triggered();
    // A breaker is rehydrated from the SERVER's projection, so a local snapshot
    // of it would be a second, divergent source of truth.
    expect(kinds(step.commands)).toContain("clearResume");
    expect(kinds(step.commands)).toContain("serveHintRung");
    expect(kinds(step.commands)).not.toContain("saveResume");
    expect(step.state.breaker?.triggerAttemptId).toBe("attempt-1");
  });

  it("escalates to the coach when there is no openable rung — never a dead end", () => {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const step = practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-1"),
      result: {
        correct: false,
        backOff: { ...backOff, initialRepairStatus: "unavailable" },
      },
    });
    expect(kinds(step.commands)).toContain("launchCoach");
    expect(kinds(step.commands)).not.toContain("serveHintRung");
    const opened = practiceReduce(step.state, {
      type: "server:coachOpened",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    });
    expect(opened.state.lane).toBe("handoff");
    const recorded = practiceReduce(opened.state, {
      type: "server:lifecycleRecorded",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    });
    expect(recorded.commands).toEqual([]);
  });

  it("serves the fresh item only AFTER support is recorded", () => {
    const step = triggered();
    // Repair is still opening — nothing has been recorded yet.
    expect(kinds(step.commands)).not.toContain("serveBreakerFresh");

    const shown = practiceReduce(step.state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: true,
      rungKind: "completion",
    });
    expect(kinds(shown.commands)).not.toContain("serveBreakerFresh");
  });

  it("puts fresh issuance in the SAME ordering domain as the lifecycle writes", () => {
    const step = triggered();
    const shown = practiceReduce(step.state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "completion",
    });
    const started = practiceReduce(shown.state, {
      type: "ui:breakerRepairStarted",
    });
    const completed = practiceReduce(started.state, {
      type: "ui:breakerRepairCompleted",
    });
    const shownRecorded = practiceReduce(completed.state, {
      type: "server:lifecycleRecorded",
      id: shown.commands[0]!.id,
    });
    const startedRecorded = acknowledgeLifecycle(shownRecorded);
    const completedCommand = startedRecorded.commands[0]!;
    const completedRecorded = acknowledgeLifecycle(startedRecorded);
    const fresh = completedRecorded.commands[0]!;
    expect((completedCommand as { domain: string }).domain).toBe(
      "breaker-lifecycle:attempt-1",
    );
    expect((fresh as { domain: string }).domain).toBe(
      "breaker-lifecycle:attempt-1",
    );
  });

  it("offers the easy exit once, and only the server grades it", () => {
    const step = triggered();
    const first = practiceReduce(step.state, { type: "ui:breakerEasyFinish" });
    expect(kinds(first.commands)).toEqual(["serveBreakerEasy"]);
    expect(first.commands[0]).toMatchObject({ expectedItemId: null });
    // A second tap must not issue a second item.
    const second = practiceReduce(first.state, { type: "ui:breakerEasyFinish" });
    expect(second.commands).toEqual([]);
  });

  it("treats coach-opened as opened, not complete", () => {
    const requested = practiceReduce(triggered().state, {
      type: "ui:breakerCoach",
    });
    expect(kinds(requested.commands)).toEqual(["launchCoach"]);
    const opened = practiceReduce(requested.state, {
      type: "server:coachOpened",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    });
    expect(opened.state.breaker?.flow.coachUsed).toBe(true);
    // The chat now owns the screen; the fresh item is not served until the
    // coach actually ends.
    expect(opened.state.lane).toBe("handoff");
    expect(kinds(opened.commands)).not.toContain("serveBreakerFresh");
    const recorded = practiceReduce(opened.state, {
      type: "server:lifecycleRecorded",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    });
    const duplicateOpened = practiceReduce(recorded.state, {
      type: "server:coachOpened",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    });
    expect(duplicateOpened.state).toBe(recorded.state);
  });

  it("keeps the easy escape live while the coach lane owns the screen", () => {
    const requested = practiceReduce(triggered().state, {
      type: "ui:breakerCoach",
    });
    const opened = practiceReduce(requested.state, {
      type: "server:coachOpened",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    });
    expect(opened.state.lane).toBe("handoff");

    const escaped = practiceReduce(opened.state, {
      type: "ui:breakerEasyFinish",
    });
    expect(escaped.commands).toEqual([]);
    expect(escaped.state.lane).toBe("handoff");
    expect(escaped.state.breaker?.flow.stage).toBe("coach");

    const recorded = practiceReduce(escaped.state, {
      type: "server:lifecycleRecorded",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    });
    expect(kinds(recorded.commands)).toEqual(["serveBreakerEasy"]);
    const served = practiceReduce(recorded.state, {
      type: "server:breakerEasyServed",
      id: breakerCommandId("attempt-1", "easy"),
      itemId: "item-easy",
    });
    expect(served.state.lane).toBeNull();
    expect(served.state.breaker?.flow.stage).toBe("easy");
  });

  it("keeps a failed easy request retryable without inventing unavailability", () => {
    const first = practiceReduce(triggered().state, {
      type: "ui:breakerEasyFinish",
    });
    const id = breakerCommandId("attempt-1", "easy");
    expect(kinds(first.commands)).toEqual(["serveBreakerEasy"]);

    const failed = practiceReduce(first.state, {
      type: "server:commandFailed",
      id,
    });
    expect(failed.state.breaker?.flow.easy).toBeUndefined();
    expect(failed.state.breaker?.easyRequested).toBe(false);
    expect(failed.state.breaker?.emitted).not.toContain(id);

    const retried = practiceReduce(failed.state, {
      type: "ui:breakerEasyFinish",
    });
    expect(retried.commands).toEqual(first.commands);
    expect(retried.state.breaker?.flow.easy).toBeUndefined();
  });

  it("requires the SERVER's verdict for recovery recognition", () => {
    const issued = freshIssued();
    const served = practiceReduce(issued.state, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-1", "fresh"),
      itemId: "item-fresh",
    });
    const graded = practiceReduce(
      {
        ...served.state,
        item: { ...served.state.item, itemId: "item-fresh" },
      },
      {
        type: "ui:submit",
        answer: "7",
        clientEventId: "evt-fresh",
        entry: entry({ clientEventId: "evt-fresh", itemId: "item-fresh" }),
      },
    );
    const applied = practiceReduce(graded.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-fresh"),
      result: { correct: true, breakerRecoveryVerified: false },
    });
    // Correct locally, but the server did not link the result — no recognition.
    expect(applied.state.breaker?.flow.fresh).toEqual({
      correct: true,
      assisted: false,
      verified: false,
    });
  });

  it("rewinds a mid-run cursor when the fresh recovery replaces the payload", () => {
    const issued = freshIssued();
    const midRun = {
      ...issued.state,
      run: { ...issued.state.run, idx: 4, itemCount: 8 },
    };
    const served = practiceReduce(midRun, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-1", "fresh"),
      itemId: "item-fresh",
    });
    expect(served.state.run).toMatchObject({ idx: 0, itemCount: 1 });
    expect(served.state.item.itemId).toBe("item-fresh");
  });

  it("rewinds a mid-run cursor when the easy finish replaces the payload", () => {
    const requested = practiceReduce(
      {
        ...triggered().state,
        run: { ...triggered().state.run, idx: 4, itemCount: 8 },
      },
      { type: "ui:breakerEasyFinish" },
    );
    const served = practiceReduce(requested.state, {
      type: "server:breakerEasyServed",
      id: breakerCommandId("attempt-1", "easy"),
      itemId: "item-easy",
    });
    expect(served.state.run).toMatchObject({ idx: 0, itemCount: 1 });
    expect(served.state.item.itemId).toBe("item-easy");
  });

  it("runs the full repair → fresh miss → easy finish sequence in declared order", () => {
    const opened = practiceReduce(triggered().state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "completion",
    });
    expect(kinds(opened.commands)).toEqual(["recordBreakerLifecycle"]);

    const started = practiceReduce(opened.state, {
      type: "ui:breakerRepairStarted",
    });
    expect(started.commands).toEqual([]);

    const repaired = practiceReduce(started.state, {
      type: "ui:breakerRepairCompleted",
    });
    expect(repaired.commands).toEqual([]);

    const shownRecorded = practiceReduce(repaired.state, {
      type: "server:lifecycleRecorded",
      id: opened.commands[0]!.id,
    });
    expect(shownRecorded.commands).toContainEqual(
      expect.objectContaining({
        kind: "recordBreakerLifecycle",
        operation: "repairStarted",
      }),
    );
    const startedRecorded = acknowledgeLifecycle(shownRecorded);
    expect(startedRecorded.commands).toContainEqual(
      expect.objectContaining({
        kind: "recordBreakerLifecycle",
        operation: "repairCompleted",
      }),
    );
    expect(kinds(startedRecorded.commands)).not.toContain(
      "serveBreakerFresh",
    );
    const completedRecorded = acknowledgeLifecycle(startedRecorded);
    expect(kinds(completedRecorded.commands)).toEqual([
      "serveBreakerFresh",
    ]);

    const fresh = practiceReduce(completedRecorded.state, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-1", "fresh"),
      itemId: "item-fresh",
    });
    const submittedFresh = practiceReduce(fresh.state, {
      type: "ui:submit",
      answer: "7",
      clientEventId: "evt-fresh",
      entry: entry({
        clientEventId: "evt-fresh",
        itemId: "item-fresh",
        breakerTriggerAttemptId: "attempt-1",
      }),
    });
    const missedFresh = practiceReduce(submittedFresh.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-fresh"),
      result: { correct: false, breakerRecoveryVerified: false },
    });
    expect(missedFresh.state.item.phase.kind).toBe("feedback");

    const intermediateClose = practiceReduce(missedFresh.state, {
      type: "ui:breakerClose",
    });
    expect(kinds(intermediateClose.commands)).not.toContain(
      "recordBreakerOutcome",
    );

    const easyRequested = practiceReduce(intermediateClose.state, {
      type: "ui:breakerEasyFinish",
    });
    expect(kinds(easyRequested.commands)).toEqual(["serveBreakerEasy"]);
    const easy = practiceReduce(easyRequested.state, {
      type: "server:breakerEasyServed",
      id: breakerCommandId("attempt-1", "easy"),
      itemId: "item-easy",
    });
    const submittedEasy = practiceReduce(easy.state, {
      type: "ui:submit",
      answer: "4",
      clientEventId: "evt-easy",
      entry: entry({
        clientEventId: "evt-easy",
        itemId: "item-easy",
        breakerEasyTriggerAttemptId: "attempt-1",
      }),
    });
    const gradedEasy = practiceReduce(submittedEasy.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-easy"),
      result: { correct: true },
    });
    expect(gradedEasy.state.item.phase).toEqual({
      kind: "feedback",
      correct: true,
    });

    const finalClose = practiceReduce(gradedEasy.state, {
      type: "ui:breakerClose",
    });
    expect(kinds(finalClose.commands)).toEqual(["recordBreakerOutcome"]);
    expect(finalClose.state.breaker?.flow.easy).toBe("correct");
  });

  it("records a prepared reveal as completed before issuing the fresh item", () => {
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: "1",
      clientEventId: "evt-reveal",
      entry: entry({ clientEventId: "evt-reveal" }),
    });
    const triggeredWithReveal = practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-reveal"),
      result: {
        correct: false,
        backOff: {
          ...backOff,
          initialRepairStatus: "done",
          repairStepIndex: 0,
        },
      },
    });
    expect(kinds(triggeredWithReveal.commands)).toEqual([
      "clearResume",
      "recordBreakerLifecycle",
      "haptic",
    ]);
    const completed = triggeredWithReveal.commands[1];
    const recorded = acknowledgeLifecycle(triggeredWithReveal);
    expect(kinds(recorded.commands)).toEqual(["serveBreakerFresh"]);
    const fresh = recorded.commands[0];
    expect((completed as { domain: string }).domain).toBe(
      (fresh as { domain: string }).domain,
    );
  });

  it("keeps a failed lifecycle write recoverable and releases fresh exactly once after retry", () => {
    const pending = completedLifecyclePending();
    const lifecycle = pending.commands.find(
      (command) => command.kind === "recordBreakerLifecycle",
    )!;
    expect(kinds(pending.commands)).not.toContain("serveBreakerFresh");

    const failed = practiceReduce(pending.state, {
      type: "server:lifecycleFailed",
      id: lifecycle.id,
    });
    expect(failed.commands).toEqual([]);
    expect(failed.state.breaker?.lifecycle.pending).toEqual([
      { operation: "repairCompleted", status: "recoverable" },
    ]);
    expect(failed.state.breaker?.flow).toMatchObject({
      stage: "repair",
      repair: "done",
    });
    expect(failed.state.item.itemId).toBe("item-1");

    const duplicateFailure = practiceReduce(failed.state, {
      type: "server:lifecycleFailed",
      id: lifecycle.id,
    });
    expect(duplicateFailure.state).toBe(failed.state);
    const prematureClose = practiceReduce(failed.state, {
      type: "ui:breakerClose",
    });
    expect(prematureClose.state).toBe(failed.state);
    expect(prematureClose.commands).toEqual([]);
    const prematureFresh = practiceReduce(failed.state, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-1", "fresh"),
      itemId: "item-premature",
    });
    expect(prematureFresh.state).toBe(failed.state);

    const retried = practiceReduce(failed.state, {
      type: "ui:retryBreakerLifecycle",
    });
    expect(retried.commands).toEqual([lifecycle]);
    const recorded = practiceReduce(retried.state, {
      type: "server:lifecycleRecorded",
      id: lifecycle.id,
    });
    expect(kinds(recorded.commands)).toEqual(["serveBreakerFresh"]);

    const duplicateSuccess = practiceReduce(recorded.state, {
      type: "server:lifecycleRecorded",
      id: lifecycle.id,
    });
    const staleFailure = practiceReduce(recorded.state, {
      type: "server:lifecycleFailed",
      id: lifecycle.id,
    });
    expect(duplicateSuccess.state).toBe(recorded.state);
    expect(duplicateSuccess.commands).toEqual([]);
    expect(staleFailure.state).toBe(recorded.state);
    expect(staleFailure.commands).toEqual([]);
  });

  it("blocks easy and coach commands behind earlier lifecycle evidence", () => {
    const shown = practiceReduce(triggered().state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "completion",
    });
    const easyIntent = practiceReduce(shown.state, {
      type: "ui:breakerEasyFinish",
    });
    expect(easyIntent.commands).toEqual([]);
    expect(easyIntent.state.breaker?.easyRequested).toBe(true);
    const easyUnblocked = practiceReduce(easyIntent.state, {
      type: "server:lifecycleRecorded",
      id: shown.commands[0]!.id,
    });
    expect(kinds(easyUnblocked.commands)).toEqual(["serveBreakerEasy"]);
    expect(kinds(easyUnblocked.commands)).not.toContain(
      "serveBreakerFresh",
    );

    const coachShown = practiceReduce(triggered().state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "completion",
    });
    const coachIntent = practiceReduce(coachShown.state, {
      type: "ui:breakerCoach",
    });
    expect(coachIntent.commands).toEqual([]);
    const shownRecorded = practiceReduce(coachIntent.state, {
      type: "server:lifecycleRecorded",
      id: coachShown.commands[0]!.id,
    });
    expect(kinds(shownRecorded.commands)).toEqual(["launchCoach"]);
    const coachOpened = practiceReduce(shownRecorded.state, {
      type: "server:coachOpened",
      id: shownRecorded.commands[0]!.id,
    });
    const coachFailed = practiceReduce(coachOpened.state, {
      type: "server:lifecycleFailed",
      id: shownRecorded.commands[0]!.id,
    });
    expect(coachFailed.state.lane).toBe("handoff");
    expect(kinds(coachFailed.commands)).not.toContain("launchCoach");
    const coachRetried = practiceReduce(coachFailed.state, {
      type: "ui:retryBreakerLifecycle",
    });
    expect(coachRetried.commands[0]?.id).toBe(
      shownRecorded.commands[0]?.id,
    );
    const coachRecorded = acknowledgeLifecycle(coachRetried);
    expect(coachRecorded.commands).toEqual([]);
    expect(coachRecorded.state.lane).toBe("handoff");
    const coachEnded = practiceReduce(coachRecorded.state, {
      type: "lane:coachEnded",
    });
    expect(kinds(coachEnded.commands)).toEqual(["serveBreakerFresh"]);
  });

  it("keeps coach presentation truthful while its durable evidence is pending", () => {
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: "1",
      clientEventId: "evt-auto-coach",
      entry: entry({ clientEventId: "evt-auto-coach" }),
    });
    const coachPending = practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-auto-coach"),
      result: {
        correct: false,
        backOff: {
          ...backOff,
          initialRepairStatus: "unavailable",
        },
      },
    });
    const lifecycle = coachPending.commands.find(
      (command) => command.kind === "launchCoach",
    )!;
    expect(lifecycle).toBeDefined();
    const opened = practiceReduce(coachPending.state, {
      type: "server:coachOpened",
      id: lifecycle.id,
    });

    const easyIntent = practiceReduce(opened.state, {
      type: "ui:breakerEasyFinish",
    });
    expect(easyIntent.commands).toEqual([]);
    const confirmed = practiceReduce(easyIntent.state, {
      type: "server:lifecycleRecorded",
      id: lifecycle.id,
    });
    expect(kinds(confirmed.commands)).toEqual(["serveBreakerEasy"]);
    expect(confirmed.state.lane).toBe("handoff");
    expect(confirmed.state.breaker?.flow.coachUsed).toBe(true);

    const projected = practiceReduce(easyIntent.state, {
      type: "hydrate:breaker",
      episode: {
        triggerAttemptId: "attempt-1",
        triggerItemId: "item-1",
        triggerNodeKey: "node-1",
        domain: "whole-number-arithmetic",
        missStreak: 3,
        flow: {
          stage: "coach",
          repair: "unavailable",
          coachUsed: true,
        },
        repairStepIndex: null,
        freshItemId: null,
        easyItemId: null,
        confirmedLifecycle: ["coachEscalated"],
      },
    });
    expect(kinds(projected.commands)).toEqual(["serveBreakerEasy"]);
    expect(projected.state.lane).toBe("handoff");
    expect(projected.state.breaker?.flow.coachUsed).toBe(true);

    const easy = practiceReduce(confirmed.state, {
      type: "server:breakerEasyServed",
      id: breakerCommandId("attempt-1", "easy"),
      itemId: "item-easy",
    });
    const submittedEasy = practiceReduce(easy.state, {
      type: "ui:submit",
      answer: "4",
      clientEventId: "evt-auto-coach-easy",
      entry: entry({
        clientEventId: "evt-auto-coach-easy",
        itemId: "item-easy",
        breakerEasyTriggerAttemptId: "attempt-1",
      }),
    });
    const gradedEasy = practiceReduce(submittedEasy.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-auto-coach-easy"),
      result: { correct: true },
    });
    const closed = practiceReduce(gradedEasy.state, {
      type: "ui:breakerClose",
    });
    const outcome = closed.commands.find(
      (command) => command.kind === "recordBreakerOutcome",
    );
    expect(outcome).toBeDefined();
    if (outcome?.kind === "recordBreakerOutcome") {
      expect(outcome.flow.coachUsed).toBe(true);
      expect(breakerLegacyOffer(outcome.flow)).toBe("accepted");
    }
  });

  it("releases a failed easy request while the coach lane owns the screen", () => {
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: "1",
      clientEventId: "evt-auto-coach-failure",
      entry: entry({ clientEventId: "evt-auto-coach-failure" }),
    });
    const coachPending = practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-auto-coach-failure"),
      result: {
        correct: false,
        backOff: { ...backOff, initialRepairStatus: "unavailable" },
      },
    });
    const lifecycle = coachPending.commands.find(
      (command) => command.kind === "launchCoach",
    )!;
    const opened = practiceReduce(coachPending.state, {
      type: "server:coachOpened",
      id: lifecycle.id,
    });
    const intended = practiceReduce(opened.state, {
      type: "ui:breakerEasyFinish",
    });
    const confirmed = practiceReduce(intended.state, {
      type: "server:lifecycleRecorded",
      id: lifecycle.id,
    });
    const easyId = breakerCommandId("attempt-1", "easy");
    expect(kinds(confirmed.commands)).toEqual(["serveBreakerEasy"]);
    expect(confirmed.state.lane).toBe("handoff");

    const failed = practiceReduce(confirmed.state, {
      type: "server:commandFailed",
      id: easyId,
    });
    expect(failed.state).not.toBe(confirmed.state);
    expect(failed.state.breaker?.easyRequested).toBe(false);
    expect(failed.state.breaker?.emitted).not.toContain(easyId);

    const retried = practiceReduce(failed.state, {
      type: "ui:breakerEasyFinish",
    });
    expect(retried.commands).toEqual(confirmed.commands);
  });

  it("reconciles a lost lifecycle acknowledgement from the server projection and across reload", () => {
    const pending = completedLifecyclePending();
    const lifecycle = pending.commands.find(
      (command) => command.kind === "recordBreakerLifecycle",
    )!;
    const failed = practiceReduce(pending.state, {
      type: "server:lifecycleFailed",
      id: lifecycle.id,
    });
    const baseEpisode = {
      triggerAttemptId: "attempt-1",
      triggerItemId: "item-1",
      triggerNodeKey: "node-1",
      domain: "whole-number-arithmetic",
      missStreak: 3,
      repairStepIndex: 0,
      freshItemId: null,
      easyItemId: null,
    };
    const staleProjection = practiceReduce(failed.state, {
      type: "hydrate:breaker",
      episode: {
        ...baseEpisode,
        flow: newBreakerFlow("open"),
        confirmedLifecycle: ["repairShown"],
      },
    });
    expect(staleProjection.state.breaker?.lifecycle.pending).toEqual([
      { operation: "repairCompleted", status: "recoverable" },
    ]);
    expect(staleProjection.commands).toEqual([]);

    const completedFlow = advanceBreakerFlow(
      advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
      { type: "repairDone" },
    );
    const authoritative = practiceReduce(staleProjection.state, {
      type: "hydrate:breaker",
      episode: {
        ...baseEpisode,
        flow: completedFlow,
        confirmedLifecycle: [
          "repairShown",
          "repairCompleted",
        ],
      },
    });
    expect(authoritative.state.breaker?.lifecycle.pending).toEqual([]);
    expect(kinds(authoritative.commands)).toEqual(["serveBreakerFresh"]);

    const duplicateProjection = practiceReduce(authoritative.state, {
      type: "hydrate:breaker",
      episode: {
        ...baseEpisode,
        flow: completedFlow,
        confirmedLifecycle: [
          "repairShown",
          "repairCompleted",
        ],
      },
    });
    expect(duplicateProjection.commands).toEqual([]);

    const afterProcessReload = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: {
        ...baseEpisode,
        flow: completedFlow,
        confirmedLifecycle: [
          "repairShown",
          "repairCompleted",
        ],
      },
    });
    expect(
      ids(afterProcessReload.commands).filter((id) => id.endsWith(":fresh")),
    ).toEqual([breakerCommandId("attempt-1", "fresh")]);
  });
});

describe("breaker hydration", () => {
  const episode = {
    triggerAttemptId: "attempt-9",
    triggerItemId: "item-trigger",
    triggerNodeKey: "node-9",
    domain: "whole-number-arithmetic",
    missStreak: 3,
    repairStepIndex: 2,
    freshItemId: null,
    easyItemId: null,
  };

  it("restores the real trigger item and the rung already served", () => {
    const step = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: { ...episode, flow: newBreakerFlow("open") },
    });
    expect(step.state.breaker?.triggerItemId).toBe("item-trigger");
    expect(step.state.breaker?.repairStepIndex).toBe(2);
  });

  it("re-serves the SAME rung index, not a new hint", () => {
    const step = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: { ...episode, flow: newBreakerFlow("opening") },
    });
    const hint = step.commands.find((c) => c.kind === "serveHintRung");
    expect(hint).toBeDefined();
    if (hint && "stepIndex" in hint) expect(hint.stepIndex).toBe(2);
  });

  it("reconstructs the fresh item on a SECOND resume, when the stage is already fresh", () => {
    // The bug this closes: `breakerSupportRecorded` goes false once the stage
    // is "fresh", so a first reload worked and a second rendered an empty card
    // forever. Found only by reloading twice against a live app.
    const alreadyFresh = advanceBreakerFlow(
      advanceBreakerFlow(
        advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
        { type: "repairDone" },
      ),
      { type: "freshServed" },
    );
    expect(alreadyFresh.stage).toBe("fresh");
    // The server reports the item as ALREADY PINNED in this state — that is
    // precisely why this mount, which has no copy of it, must ask again.
    const step = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: { ...episode, flow: alreadyFresh, freshItemId: "item-fresh" },
    });
    expect(kinds(step.commands)).toContain("serveBreakerFresh");
  });

  it("reinstalls the same pinned easy item on consecutive relaunches", () => {
    const repaired = advanceBreakerFlow(
      advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
      { type: "repairDone" },
    );
    const requestedEasy = advanceBreakerFlow(
      advanceBreakerFlow(
        advanceBreakerFlow(repaired, { type: "freshServed" }),
        {
          type: "freshGraded",
          correct: false,
          assisted: false,
          verified: false,
        },
      ),
      { type: "easyRequested" },
    );
    const pinnedEpisode = {
      ...episode,
      flow: requestedEasy,
      freshItemId: "item-fresh",
      easyItemId: "item-easy",
    };

    for (const relaunch of [1, 2]) {
      const hydrated = practiceReduce(start(), {
        type: "hydrate:breaker",
        episode: pinnedEpisode,
      });
      expect(hydrated.commands).toEqual([
        {
          kind: "serveBreakerEasy",
          id: "breaker:attempt-9:easy",
          domain: "breaker-lifecycle:attempt-9",
          triggerAttemptId: "attempt-9",
          expectedItemId: "item-easy",
        },
      ]);
      const command = hydrated.commands[0] as Extract<
        PracticeCommand,
        { kind: "serveBreakerEasy" }
      >;
      expect(breakerEasyItemMatchesCommand(command, "item-easy")).toBe(true);

      const installed = practiceReduce(hydrated.state, {
        type: "server:breakerEasyServed",
        id: command.id,
        itemId: "item-easy",
      });
      expect(installed.state, `relaunch ${relaunch}`).not.toBe(hydrated.state);
      expect(installed.state.item).toMatchObject({
        itemId: "item-easy",
        phase: { kind: "answering" },
        hasRecorded: false,
      });
      expect(installed.state.breaker?.easyItemId).toBe("item-easy");
      expect(installed.state.breaker?.flow.easy).toBe("requested");
      expect(installed.state.run).toMatchObject({
        idx: 0,
        itemCount: 1,
        answeredCount: 0,
        correctCount: 0,
      });
      expect(installed.commands).toEqual([]);
    }
  });

  it("retries a failed pinned easy-item reinstall", () => {
    const repaired = advanceBreakerFlow(
      advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
      { type: "repairDone" },
    );
    const requestedEasy = advanceBreakerFlow(
      advanceBreakerFlow(
        advanceBreakerFlow(repaired, { type: "freshServed" }),
        {
          type: "freshGraded",
          correct: false,
          assisted: false,
          verified: false,
        },
      ),
      { type: "easyRequested" },
    );
    const hydrated = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: {
        ...episode,
        flow: requestedEasy,
        freshItemId: "item-fresh",
        easyItemId: "item-easy",
      },
    });
    const command = hydrated.commands[0]!;
    const failed = practiceReduce(hydrated.state, {
      type: "server:commandFailed",
      id: command.id,
    });
    expect(failed.state.breaker?.emitted).not.toContain(command.id);
    expect(failed.state.breaker?.flow.easy).toBe("requested");

    const retried = practiceReduce(failed.state, {
      type: "ui:breakerEasyFinish",
    });
    expect(retried.commands).toEqual(hydrated.commands);
  });

  it("does not replace an easy pin or replay terminal and graded work", () => {
    const repaired = advanceBreakerFlow(
      advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
      { type: "repairDone" },
    );
    const requestedEasy = advanceBreakerFlow(
      advanceBreakerFlow(
        advanceBreakerFlow(repaired, { type: "freshServed" }),
        {
          type: "freshGraded",
          correct: false,
          assisted: false,
          verified: false,
        },
      ),
      { type: "easyRequested" },
    );
    const pinnedEpisode = {
      ...episode,
      flow: requestedEasy,
      freshItemId: "item-fresh",
      easyItemId: "item-easy",
    };
    const hydrated = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: pinnedEpisode,
    });
    const command = hydrated.commands[0] as Extract<
      PracticeCommand,
      { kind: "serveBreakerEasy" }
    >;
    expect(breakerEasyItemMatchesCommand(command, "item-other")).toBe(false);
    const mismatch = practiceReduce(hydrated.state, {
      type: "server:breakerEasyServed",
      id: command.id,
      itemId: "item-other",
    });
    expect(mismatch.state).toBe(hydrated.state);
    expect(mismatch.commands).toEqual([]);
    const stale = practiceReduce(hydrated.state, {
      type: "server:breakerEasyServed",
      id: breakerCommandId("attempt-stale", "easy"),
      itemId: "item-easy",
    });
    expect(stale.state).toBe(hydrated.state);
    expect(stale.commands).toEqual([]);

    const gradedFlow = advanceBreakerFlow(requestedEasy, {
      type: "easyGraded",
      correct: true,
    });
    const graded = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: { ...pinnedEpisode, flow: gradedFlow },
    });
    expect(graded.commands).toEqual([]);

    const terminal = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: {
        ...pinnedEpisode,
        flow: advanceBreakerFlow(gradedFlow, { type: "closed" }),
      },
    });
    expect(terminal.commands).toEqual([]);

    const terminalRequested = {
      ...hydrated.state,
      terminal: true,
      breaker: hydrated.state.breaker
        ? { ...hydrated.state.breaker, emitted: [] }
        : null,
    };
    const terminalEmission = practiceReduce(terminalRequested, {
      type: "lane:coachEnded",
    });
    expect(terminalEmission.commands).toEqual([]);
    const terminalResult = practiceReduce(terminalRequested, {
      type: "server:breakerEasyServed",
      id: command.id,
      itemId: "item-easy",
    });
    expect(terminalResult.state).toBe(terminalRequested);
  });

  it("does not reconstruct — or regrade — an already graded fresh item", () => {
    const graded = advanceBreakerFlow(
      advanceBreakerFlow(
        advanceBreakerFlow(
          advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
          { type: "repairDone" },
        ),
        { type: "freshServed" },
      ),
      { type: "freshGraded", correct: true, assisted: false, verified: true },
    );
    const step = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: { ...episode, flow: graded, freshItemId: "item-fresh" },
    });
    expect(kinds(step.commands)).not.toContain("serveBreakerFresh");
  });

  it("lets a live episode outrank a stale resume snapshot", () => {
    const hydrated = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: { ...episode, flow: newBreakerFlow("open") },
    });
    const resumed = practiceReduce(hydrated.state, {
      type: "hydrate:resume",
      idx: 4,
      hasRecorded: true,
      itemId: "item-5",
    });
    expect(resumed.state.run.idx).toBe(0);
    expect(resumed.state.breaker).not.toBeNull();
  });

  it("does not rewind a local repair while the reactive projection catches up", () => {
    const hydrated = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: { ...episode, flow: newBreakerFlow("open") },
    });
    const completed = practiceReduce(hydrated.state, {
      type: "ui:breakerRepairCompleted",
    });
    expect(completed.state.breaker?.flow.repair).toBe("done");

    const staleProjection = practiceReduce(completed.state, {
      type: "hydrate:breaker",
      episode: { ...episode, flow: newBreakerFlow("open") },
    });
    expect(staleProjection.state).toBe(completed.state);
  });
});

describe("process-reload recovery derives the SAME command ids", () => {
  it("re-derives a breaker command id from durable facts, not a counter", () => {
    // A monotonic sequence cannot survive a reload; the trigger attempt can.
    expect(breakerCommandId("attempt-1", "fresh")).toBe("breaker:attempt-1:fresh");
    expect(submitCommandId("evt-1")).toBe("submit:evt-1");
  });

  it("emits an identical fresh-issuance id before and after a simulated reload", () => {
    const flow = advanceBreakerFlow(
      advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
      { type: "repairDone" },
    );
    const episode = {
      triggerAttemptId: "attempt-9",
      triggerItemId: "item-trigger",
      triggerNodeKey: "node-9",
      domain: "d",
      missStreak: 3,
      repairStepIndex: 0,
      freshItemId: null,
      easyItemId: null,
      flow,
    };
    const before = practiceReduce(start(), { type: "hydrate:breaker", episode });
    // A brand-new machine (everything transient is gone) hydrating the same
    // server projection must ask for the same command.
    const after = practiceReduce(start(), { type: "hydrate:breaker", episode });
    const pick = (t: typeof before) =>
      t.commands.filter((c) => c.kind === "serveBreakerFresh").map((c) => c.id);
    expect(pick(before)).toEqual(pick(after));
    expect(pick(before)).toEqual(["breaker:attempt-9:fresh"]);
  });

  it("never replays an ephemeral command's identity across a reload", () => {
    // Ephemeral ids are per-run counters BY DESIGN: a haptic that missed its
    // moment must not fire on relaunch.
    const graded = answered(start(), true);
    const haptic = graded.commands.find((c) => c.kind === "haptic");
    expect(haptic?.id.startsWith("ui:")).toBe(true);
    expect(isDurableCommand(haptic!)).toBe(false);
  });
});

describe("rehearse emits no durable command, ever", () => {
  const rehearse = () => start({ mode: "rehearse" });

  it("grades locally instead of submitting", () => {
    const e = entry();
    const step = practiceReduce(rehearse(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    expect(kinds(step.commands)).toEqual(["gradeLocally"]);
  });

  it("writes no resume snapshot", () => {
    // Today's components call saveResume/clearResume with NO rehearse check at
    // all — only the snapshot key differs. That was an accident, not a design.
    const step = practiceReduce(rehearse(), { type: "env:mounted", queuedCount: 0 });
    expect(step.commands).toEqual([]);
  });

  it("emits no durable command across a whole run", () => {
    const events: PracticeEvent[] = [
      { type: "env:mounted", queuedCount: 0 },
      { type: "env:online" },
      {
        type: "ui:submit",
        answer: "1",
        clientEventId: "evt-1",
        entry: entry(),
      },
      { type: "ui:advance" },
      { type: "ui:breakerEasyFinish" },
      { type: "ui:advance" },
    ];
    const { commands } = runPracticeEvents(rehearse(), events);
    const durable = commands.filter(isDurableCommand);
    expect(durable).toEqual([]);
    // Guards the guard: the property is only meaningful if the durable list is
    // real.
    expect(DURABLE_COMMAND_KINDS.length).toBeGreaterThan(5);
  });
});

describe("suspended lanes keep the machine as the sole owner", () => {
  it("emits no item command while a lane owns the screen", () => {
    const suspended = practiceReduce(start(), { type: "lane:entered", lane: "mapping" });
    const attempted = practiceReduce(suspended.state, {
      type: "ui:submit",
      answer: "1",
      clientEventId: "evt-x",
      entry: entry({ clientEventId: "evt-x" }),
    });
    expect(attempted.commands).toEqual([]);
    expect(attempted.state.lane).toBe("mapping");
  });

  it("retains the continuation across a lane, rather than losing it", () => {
    const graded = answered(start(), true);
    const advanced = practiceReduce(graded.state, { type: "ui:advance" });
    const suspended = practiceReduce(advanced.state, {
      type: "lane:entered",
      lane: "dialogue",
    });
    // idx/log survive the suspension — the lane does not own them.
    expect(suspended.state.run.idx).toBe(1);
    expect(suspended.state.run.correctCount).toBe(1);
    const returned = practiceReduce(suspended.state, { type: "lane:exited" });
    expect(returned.state.run.idx).toBe(1);
    expect(returned.state.lane).toBeNull();
  });

  it("applies a mapping result itself instead of letting the lane write run state", () => {
    const suspended = practiceReduce(start(), { type: "lane:entered", lane: "mapping" });
    const applied = practiceReduce(suspended.state, {
      type: "lane:mappingAnswered",
      recorded: true,
      correct: true,
    });
    expect(applied.state.run.correctCount).toBe(1);
    expect(applied.state.lane).toBeNull();
    expect(kinds(applied.commands)).toEqual(["saveResume"]);
  });

  it("routes a handoff 'advance' through the machine's own advance", () => {
    // On native the chat component currently receives `onAdvance={advance}` and
    // calls run advancement in place. This is the typed replacement.
    const suspended = practiceReduce(start(), { type: "lane:entered", lane: "handoff" });
    const closed = practiceReduce(suspended.state, {
      type: "lane:handoffClosed",
      outcome: "advance",
    });
    expect(closed.state.run.idx).toBe(1);
    expect(closed.state.lane).toBeNull();
  });

  it("routes retry-same and fresh-variant returns without exposing setters", () => {
    const suspended = practiceReduce(start(), {
      type: "lane:entered",
      lane: "handoff",
    });
    const retry = practiceReduce(suspended.state, {
      type: "lane:handoffClosed",
      outcome: "retry-same",
    });
    expect(retry.state.item.phase.kind).toBe("retry");
    expect(retry.state.run.idx).toBe(0);

    const fresh = practiceReduce(suspended.state, {
      type: "lane:handoffClosed",
      outcome: "fresh-variant",
      itemId: "item-fresh",
    });
    expect(fresh.state.item.itemId).toBe("item-fresh");
    expect(fresh.state.item.hasRecorded).toBe(false);
    expect(fresh.state.run.idx).toBe(0);
  });

  it("appends a mapping batch and keeps the machine's count aligned", () => {
    const suspended = practiceReduce(start(), {
      type: "lane:entered",
      lane: "mapping",
    });
    const appended = practiceReduce(suspended.state, {
      type: "lane:batchAppended",
      addedCount: 3,
    });
    expect(appended.state.run.itemCount).toBe(9);
    expect(appended.state.lane).toBeNull();
  });

  it("returns from the generic beat without advancing the run", () => {
    const suspended = practiceReduce(start(), {
      type: "lane:entered",
      lane: "beat",
    });
    const returned = practiceReduce(suspended.state, {
      type: "lane:beatProceeded",
    });
    expect(returned.state.run.idx).toBe(0);
    expect(returned.state.lane).toBeNull();
  });

  it("lets a tail replace the run through one owner, resetting one set of fields", () => {
    const graded = answered(start(), true);
    const replaced = practiceReduce(graded.state, {
      type: "lane:tailAccepted",
      itemCount: 3,
      itemId: "tail-1",
    });
    expect(replaced.state.run.idx).toBe(0);
    expect(replaced.state.run.itemCount).toBe(3);
    expect(replaced.state.run.correctCount).toBe(0);
    expect(replaced.state.item.itemId).toBe("tail-1");
    expect(replaced.state.item.hasRecorded).toBe(false);
    expect(replaced.state.terminal).toBe(false);
  });
});

describe("terminal transition", () => {
  function runToEnd(state: PracticeState) {
    let current = state;
    const commands: PracticeCommand[] = [];
    for (let i = 0; i < 6; i += 1) {
      const graded = answered(current, true, { clientEventId: `evt-${i}` });
      current = graded.state;
      commands.push(...graded.commands);
      const advanced = practiceReduce(current, {
        type: "ui:advance",
        nextItemId: `item-${i + 2}`,
      });
      current = advanced.state;
      commands.push(...advanced.commands);
    }
    return { state: current, commands };
  }

  it("fires the completion haptic exactly once, with no one-shot latch", () => {
    const { state, commands } = runToEnd(start());
    expect(state.terminal).toBe(true);
    const terminalHaptics = commands.filter(
      (c) => c.kind === "haptic" && c.style === "success",
    );
    // One per correct answer plus exactly one for the landing.
    expect(terminalHaptics.length).toBe(7);
    // Re-entering the terminal state must not fire another.
    const again = practiceReduce(state, { type: "ui:advance" });
    expect(again.commands).toEqual([]);
  });

  it("clears the resume snapshot and completes an attached tune-up once", () => {
    const { state, commands } = runToEnd(start({ tuneupId: "tuneup-1" }));
    expect(state.terminal).toBe(true);
    const completions = commands.filter((c) => c.kind === "completeTuneup");
    expect(completions).toHaveLength(1);
    expect(completions[0]!.id).toBe("tuneup:tuneup-1:complete");
    expect(
      commands.some((c) => c.kind === "clearResume" && c.reason === "run-complete"),
    ).toBe(true);
  });

  it("completes no tune-up when the run has none", () => {
    const { commands } = runToEnd(start());
    expect(commands.filter((c) => c.kind === "completeTuneup")).toEqual([]);
  });

  it("scores a tune-up from recorded first attempts, not successful retries", () => {
    const initial = start({ itemCount: 1, tuneupId: "tuneup-1" });
    const missed = answered(initial, false);
    const retrying = practiceReduce(missed.state, { type: "ui:retry" });
    const recovered = answered(retrying.state, true, {
      clientEventId: "evt-retry",
      record: false,
    });
    expect(recovered.state.run.correctCount).toBe(0);
    const terminal = practiceReduce(recovered.state, {
      type: "ui:advance",
    });
    const completion = terminal.commands.find(
      (command) => command.kind === "completeTuneup",
    );
    expect(completion).toMatchObject({ correctCount: 0 });
  });
});

describe("Quick Facts containment", () => {
  it("never opens a breaker, even on a threshold miss", () => {
    const step = practiceReduce(
      practiceReduce(start({ suppressBreaker: true }), {
        type: "ui:submit",
        answer: "1",
        clientEventId: "evt-qf",
        entry: entry({ clientEventId: "evt-qf", suppressBreaker: true }),
      }).state,
      {
        type: "server:submitSucceeded",
        id: submitCommandId("evt-qf"),
        result: {
          correct: false,
          backOff: {
            triggerAttemptId: "attempt-1",
            triggerNodeKey: "node-1",
            domain: "whole-number-arithmetic",
            missStreak: 3,
            recoveryAvailable: true,
            initialRepairStatus: "opening",
            repairStepIndex: null,
          },
        },
      },
    );
    expect(step.state.breaker).toBeNull();
    expect(kinds(step.commands)).not.toContain("serveHintRung");
  });
});

describe("hint ladder coach pull", () => {
  it("opens, serves, and exhausts the ordinary ladder through commands", () => {
    const opened = practiceReduce(start(), { type: "ui:hintPressed" });
    expect(opened.state.hint.open).toBe(true);
    expect(opened.commands).toEqual([]);

    const requested = practiceReduce(opened.state, {
      type: "ui:hintPressed",
    });
    expect(kinds(requested.commands)).toEqual(["serveHintRung"]);
    expect(
      (
        requested.commands[0] as Extract<
          PracticeCommand,
          { kind: "serveHintRung" }
        >
      ).source,
    ).toBe("ladder");

    const served = practiceReduce(requested.state, {
      type: "server:hintServed",
      id: requested.commands[0]!.id,
      stepIndex: 0,
      hasMore: false,
      rungKind: "reveal",
    });
    expect(served.state.hint).toMatchObject({
      itemId: "item-1",
      open: true,
      nextStepIndex: 1,
      exhausted: true,
      pendingCommandId: null,
    });

    const coach = practiceReduce(served.state, { type: "ui:hintPressed" });
    expect(kinds(coach.commands)).toEqual(["openHandoff"]);
    expect(coach.state.lane).toBe("handoff");
  });

  it("pulls the coach once per item, not once per tap", () => {
    const first = practiceReduce(start(), { type: "ui:hintLadderPulled" });
    expect(first.state.item.ladderCoachPulled).toBe(true);
    expect(first.state.lane).toBe("handoff");
    const second = practiceReduce(first.state, { type: "ui:hintLadderPulled" });
    expect(second.state).toBe(first.state);
  });

  it("resets the pull for the next item", () => {
    const pulled = practiceReduce(start(), { type: "ui:hintLadderPulled" });
    const returned = practiceReduce(pulled.state, { type: "lane:exited" });
    const graded = answered(returned.state, true);
    const advanced = practiceReduce(graded.state, { type: "ui:advance" });
    expect(advanced.state.item.ladderCoachPulled).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Regressions from independent review. Each of these was a real defect the
// vectors above did not catch, which is the point of reviewing against the
// requirement rather than against the author's reasoning.
// ─────────────────────────────────────────────────────────────────────────

describe("review regressions", () => {
  const backOff = {
    triggerAttemptId: "attempt-1",
    triggerNodeKey: "node-1",
    domain: "whole-number-arithmetic",
    missStreak: 3,
    recoveryAvailable: true,
    initialRepairStatus: "opening" as const,
    repairStepIndex: null,
  };

  function triggered(state = start()) {
    const e = entry();
    const submitted = practiceReduce(state, {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    return practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-1"),
      result: { correct: false, backOff },
    });
  }

  function freshIssued() {
    const shown = practiceReduce(triggered().state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "reveal",
    });
    return acknowledgeLifecycle(acknowledgeLifecycle(shown));
  }

  it("writes no resume snapshot from the mapping lane during a rehearsal", () => {
    // The mapping branch bypassed the rehearse gate entirely.
    const suspended = practiceReduce(start({ mode: "rehearse" }), {
      type: "lane:entered",
      lane: "mapping",
    });
    const applied = practiceReduce(suspended.state, {
      type: "lane:mappingAnswered",
      recorded: true,
      correct: true,
    });
    expect(applied.commands.filter(isDurableCommand)).toEqual([]);
  });

  it("can actually drive a repair to completion and on to the fresh item", () => {
    // Previously nothing could move repair from "open" to "done", so an
    // ordinary episode could never reach the recovery item at all.
    const step = triggered();
    const shown = practiceReduce(step.state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "completion",
    });
    expect(shown.state.breaker?.flow.repair).toBe("open");

    const started = practiceReduce(shown.state, {
      type: "ui:breakerRepairStarted",
    });
    const completed = practiceReduce(started.state, {
      type: "ui:breakerRepairCompleted",
    });
    expect(completed.state.breaker?.flow.repair).toBe("done");
    expect(completed.commands).toEqual([]);

    const shownRecorded = practiceReduce(completed.state, {
      type: "server:lifecycleRecorded",
      id: shown.commands[0]!.id,
    });
    const startedRecorded = acknowledgeLifecycle(shownRecorded);
    const lifecycle = startedRecorded.commands[0]!;
    const completedRecorded = acknowledgeLifecycle(startedRecorded);
    const fresh = completedRecorded.commands[0]!;
    expect(kinds(completedRecorded.commands)).toEqual([
      "serveBreakerFresh",
    ]);
    // Same ordering domain remains as defense in depth, but the reducer's
    // acknowledgement gate is now the causal boundary.
    expect((lifecycle as { domain: string }).domain).toBe(
      "breaker-lifecycle:attempt-1",
    );
    expect((fresh as { domain: string }).domain).toBe(
      "breaker-lifecycle:attempt-1",
    );
  });

  it("escalates the coach on request, once", () => {
    const step = triggered();
    const first = practiceReduce(step.state, { type: "ui:breakerCoach" });
    expect(kinds(first.commands)).toEqual(["launchCoach"]);
    const second = practiceReduce(first.state, { type: "ui:breakerCoach" });
    expect(second.commands).toEqual([]);
  });

  it("reconstructs a pinned-but-ungraded fresh item on resume", () => {
    // The old guard skipped reconstruction whenever the server reported the
    // item as already pinned — which is exactly the resume case, since this
    // mount holds no copy of it.
    const flow = advanceBreakerFlow(
      advanceBreakerFlow(
        advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
        { type: "repairDone" },
      ),
      { type: "freshServed" },
    );
    const step = practiceReduce(start(), {
      type: "hydrate:breaker",
      episode: {
        triggerAttemptId: "attempt-9",
        triggerItemId: "item-trigger",
        triggerNodeKey: "node-9",
        domain: "d",
        missStreak: 3,
        flow,
        repairStepIndex: 0,
        freshItemId: "item-fresh",
        easyItemId: null,
      },
    });
    expect(kinds(step.commands)).toContain("serveBreakerFresh");
  });

  it("ignores a duplicate fresh-served result rather than regrading the item", () => {
    const issued = freshIssued();
    const served = practiceReduce(issued.state, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-1", "fresh"),
      itemId: "item-fresh",
    });
    const withItem: PracticeState = {
      ...served.state,
      item: { ...served.state.item, itemId: "item-fresh" },
    };
    const graded = practiceReduce(
      practiceReduce(withItem, {
        type: "ui:submit",
        answer: "7",
        clientEventId: "evt-fresh",
        entry: entry({ clientEventId: "evt-fresh", itemId: "item-fresh" }),
      }).state,
      {
        type: "server:submitSucceeded",
        id: submitCommandId("evt-fresh"),
        result: { correct: true, breakerRecoveryVerified: true },
      },
    );
    expect(graded.state.item.hasRecorded).toBe(true);

    // A late duplicate must not reset the item to un-recorded and reopen it.
    const duplicate = practiceReduce(graded.state, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-1", "fresh"),
      itemId: "item-fresh",
    });
    expect(duplicate.state.item.hasRecorded).toBe(true);
    expect(duplicate.state.breaker?.flow.fresh).toBeDefined();
  });

  it("ignores a breaker result belonging to a different episode", () => {
    const step = triggered();
    const foreign = practiceReduce(step.state, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-OTHER", "fresh"),
      itemId: "item-wrong",
    });
    expect(foreign.state).toBe(step.state);
  });

  it("gives each resume snapshot its own command id, so a newer one is never refused", () => {
    // One shared id meant the coordinator rejected version 2 while version 1
    // was still writing, leaving the stale position on disk.
    const first = answered(start(), true);
    const advanced = practiceReduce(first.state, {
      type: "ui:advance",
      nextItemId: "item-2",
    });
    const second = answered(advanced.state, true, { clientEventId: "evt-2" });
    const saveIds = [...first.commands, ...second.commands]
      .filter((c) => c.kind === "saveResume")
      .map((c) => c.id);
    expect(saveIds).toHaveLength(2);
    expect(new Set(saveIds).size).toBe(2);
  });
});

describe("run:loaded", () => {
  function request(state: PracticeState, inputKey = "inputs-a") {
    const requested = practiceReduce(state, {
      type: "run:inputsChanged",
      inputKey,
    });
    const command = requested.commands[0];
    expect(command?.kind).toBe("loadRun");
    return {
      requested,
      id: command!.id,
    };
  }

  it("adopts the served payload's item count and first item on the first load", () => {
    const fresh = newPracticeState({ scholarId: SCHOLAR, itemCount: 0, itemId: null });
    const { requested, id } = request(fresh);
    const step = practiceReduce(requested.state, {
      type: "run:loaded",
      id,
      itemCount: 6,
      itemId: "item-1",
      scopeKey: "scope-a",
      dayKey: "2026-01-01",
    });
    expect(step.state.run.itemCount).toBe(6);
    expect(step.state.item.itemId).toBe("item-1");
    expect(step.state.run.scopeKey).toBe("scope-a");
    expect(step.state.run.dayKey).toBe("2026-01-01");
  });

  it("is idempotent for an unchanged payload (re-render churn is not a reset)", () => {
    const { requested, id } = request(start());
    const loaded = practiceReduce(requested.state, {
      type: "run:loaded",
      id,
      itemCount: 6,
      itemId: "item-1",
      scopeKey: "scope-a",
      dayKey: "2026-01-01",
    }).state;
    const advanced = practiceReduce(loaded, { type: "ui:advance", nextItemId: "item-2" }).state;
    const rerendered = practiceReduce(advanced, {
      type: "run:inputsChanged",
      inputKey: "inputs-a",
    });
    // Same host fingerprint: the in-progress position must survive.
    expect(rerendered.state).toBe(advanced);
    expect(rerendered.commands).toEqual([]);
  });

  it("resets the run for a genuinely new host input", () => {
    const first = request(start());
    const loaded = practiceReduce(first.requested.state, {
      type: "run:loaded",
      id: first.id,
      itemCount: 6,
      itemId: "item-1",
      scopeKey: "scope-a",
      dayKey: "2026-01-01",
    }).state;
    const advanced = practiceReduce(loaded, { type: "ui:advance", nextItemId: "item-2" }).state;
    const second = request(advanced, "inputs-b");
    const reloaded = practiceReduce(second.requested.state, {
      type: "run:loaded",
      id: second.id,
      itemCount: 4,
      itemId: "item-new-1",
      scopeKey: "scope-b",
      dayKey: "2026-01-01",
    }).state;
    expect(reloaded.run.idx).toBe(0);
    expect(reloaded.run.itemCount).toBe(4);
    expect(reloaded.item.itemId).toBe("item-new-1");
    expect(reloaded.run.scopeKey).toBe("scope-b");
  });

  it("freezes an all-mapping ceremony against a mid-sit payload change", () => {
    const first = request(start());
    const loaded = practiceReduce(first.requested.state, {
      type: "run:loaded",
      id: first.id,
      itemCount: 6,
      itemId: "item-1",
      scopeKey: "scope-a",
      dayKey: "2026-01-01",
      allMapping: true,
    }).state;
    expect(loaded.run.allMapping).toBe(true);
    const advanced = practiceReduce(loaded, { type: "ui:advance", nextItemId: "item-2" }).state;

    // The parent re-derives its `domains` prop mid-ceremony (a domain just
    // finished mapping), which would ordinarily look like a real input change.
    const frozen = practiceReduce(advanced, {
      type: "run:inputsChanged",
      inputKey: "inputs-after-domain-map",
    });
    expect(frozen.commands).toEqual([]);
    expect(frozen.state.run.idx).toBe(advanced.run.idx);
    expect(frozen.state.item.itemId).toBe(advanced.item.itemId);
    expect(frozen.state.run.inputKey).toBe("inputs-after-domain-map");
  });

  it("still applies the very first load even when the served payload is itself all-mapping", () => {
    const fresh = newPracticeState({ scholarId: SCHOLAR, itemCount: 0, itemId: null });
    const { requested, id } = request(fresh);
    const step = practiceReduce(requested.state, {
      type: "run:loaded",
      id,
      itemCount: 3,
      itemId: "item-1",
      scopeKey: "scope-a",
      dayKey: "2026-01-01",
      allMapping: true,
    });
    expect(step.state.run.itemCount).toBe(3);
    expect(step.state.item.itemId).toBe("item-1");
  });

  it("does not get swallowed by a suspended lane", () => {
    const inLane = practiceReduce(start(), { type: "lane:entered", lane: "mapping" }).state;
    const { requested, id } = request(inLane);
    const reloaded = practiceReduce(requested.state, {
      type: "run:loaded",
      id,
      itemCount: 3,
      itemId: "item-new",
      scopeKey: "scope-fresh",
      dayKey: "2026-01-01",
    });
    expect(reloaded.state.run.itemCount).toBe(3);
    expect(reloaded.state.item.itemId).toBe("item-new");
  });

  it("leaves a failed load retryable without spinning automatically", () => {
    const { requested, id } = request(start(), "inputs-failing");
    const failed = practiceReduce(requested.state, {
      type: "run:loadFailed",
      id,
    });
    expect(failed.state.run.pendingLoad).toBeNull();
    expect(failed.state.run.failedInputKey).toBe("inputs-failing");
    expect(
      practiceReduce(failed.state, {
        type: "run:inputsChanged",
        inputKey: "inputs-failing",
      }).commands,
    ).toEqual([]);
    const retry = practiceReduce(failed.state, {
      type: "run:reloadRequested",
    });
    expect(kinds(retry.commands)).toEqual(["loadRun"]);
  });

  it("keeps host-appended and removed item counts canonical", () => {
    const added = practiceReduce(start(), {
      type: "run:itemCountAdjusted",
      delta: 1,
    });
    expect(added.state.run.itemCount).toBe(7);
    const removed = practiceReduce(added.state, {
      type: "run:itemCountAdjusted",
      delta: -1,
    });
    expect(removed.state.run.itemCount).toBe(6);
  });

  it("restores an ordinary run at the first unrecorded payload item", () => {
    const fresh = newPracticeState({
      scholarId: SCHOLAR,
      itemCount: 0,
      itemId: null,
    });
    const { requested, id } = request(fresh);
    const loaded = practiceReduce(requested.state, {
      type: "run:loaded",
      id,
      itemCount: 4,
      itemId: "item-1",
      scopeKey: "scope-a",
      dayKey: "2026-01-01",
    });
    const resumed = practiceReduce(loaded.state, {
      type: "hydrate:resume",
      idx: 2,
      hasRecorded: false,
      itemId: "item-3",
    });
    expect(resumed.state.run.idx).toBe(2);
    expect(resumed.state.item.itemId).toBe("item-3");
    expect(resumed.state.item.hasRecorded).toBe(false);
  });
});

describe("local:graded (rehearse)", () => {
  it("grades a rehearsal answer without emitting any durable command", () => {
    const rehearsing = newPracticeState({
      scholarId: SCHOLAR,
      itemCount: 3,
      itemId: "item-1",
      mode: "rehearse",
    });
    const submitted = practiceReduce(rehearsing, {
      type: "ui:submit",
      answer: "42",
      clientEventId: "evt-1",
      entry: entry(),
    });
    expect(submitted.commands.map((c) => c.kind)).toEqual(["gradeLocally"]);
    expect(submitted.state.item.phase.kind).toBe("submitting");
    const gradeCommand = submitted.commands[0] as Extract<
      PracticeCommand,
      { kind: "gradeLocally" }
    >;

    const graded = practiceReduce(submitted.state, {
      type: "local:graded",
      id: gradeCommand.id,
      correct: true,
    });
    expect(graded.state.item.phase).toEqual({ kind: "feedback", correct: true });
    expect(graded.state.run.correctCount).toBe(1);
    expect(graded.commands.every((c) => !isDurableCommand(c))).toBe(true);
    expect(graded.commands.map((c) => c.kind)).toEqual(["haptic"]);
  });

  it("ignores a local grade that does not match the awaited command (stale/duplicate)", () => {
    const rehearsing = newPracticeState({
      scholarId: SCHOLAR,
      itemCount: 3,
      itemId: "item-1",
      mode: "rehearse",
    });
    const submitted = practiceReduce(rehearsing, {
      type: "ui:submit",
      answer: "42",
      clientEventId: "evt-1",
      entry: entry(),
    });
    const stale = practiceReduce(submitted.state, {
      type: "local:graded",
      id: "ui:999",
      correct: true,
    });
    expect(stale.state).toBe(submitted.state);
  });
});
