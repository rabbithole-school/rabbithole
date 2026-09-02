import { describe, expect, it } from "vitest";

import {
  newPracticeState,
  practiceReduce,
  submitCommandId,
  type PracticeState,
} from "../../../vendor/shared/practiceMachine";
import {
  advanceBreakerFlow,
  newBreakerFlow,
} from "../../../vendor/shared/practiceLoop";
import type { OutboxAnswer } from "../../../vendor/shared/practiceOutboxContract";

const SCHOLAR = "scholar-1";

function start(): PracticeState {
  return newPracticeState({
    scholarId: SCHOLAR,
    itemCount: 3,
    itemId: "item-1",
  });
}

function answer(): OutboxAnswer {
  return {
    clientEventId: "event-1",
    itemId: "item-1",
    answer: "4",
    record: true,
    skillLabel: "Addition",
    queuedAt: 1,
  };
}

describe("native practice machine bridges", () => {
  it("advances from a durable queued answer without claiming a grade", () => {
    const submitting = practiceReduce(start(), {
      type: "ui:submit",
      answer: "4",
      clientEventId: "event-1",
      entry: answer(),
    });
    const queued = practiceReduce(submitting.state, {
      type: "server:submitQueued",
      id: submitCommandId("event-1"),
      queuedCount: 1,
    });
    expect(queued.state.item).toMatchObject({
      phase: { kind: "queued", queuedCount: 1 },
      hasRecorded: true,
    });
    expect(queued.state.run.correctCount).toBe(0);

    const advanced = practiceReduce(queued.state, {
      type: "ui:advance",
      nextItemId: "item-2",
    });
    expect(advanced.state.run.idx).toBe(1);
    expect(advanced.state.item).toMatchObject({
      itemId: "item-2",
      phase: { kind: "answering" },
      hasRecorded: false,
    });
  });

  it("returns mapping outcomes through the typed lane bridge", () => {
    const entered = practiceReduce(start(), {
      type: "lane:entered",
      lane: "mapping",
    });
    const answered = practiceReduce(entered.state, {
      type: "lane:mappingAnswered",
      recorded: true,
      correct: false,
    });
    expect(answered.state.lane).toBeNull();
    expect(answered.state.item).toMatchObject({
      phase: { kind: "feedback", correct: false },
      hasRecorded: true,
      missCount: 1,
    });
    expect(answered.state.run.answeredCount).toBe(1);
  });

  it("routes handoff close outcomes without a direct host advance", () => {
    const entered = practiceReduce(start(), {
      type: "lane:entered",
      lane: "handoff",
    });
    const retry = practiceReduce(entered.state, {
      type: "lane:handoffClosed",
      outcome: "retry-same",
    });
    expect(retry.state.lane).toBeNull();
    expect(retry.state.item.phase.kind).toBe("retry");

    const advanced = practiceReduce(entered.state, {
      type: "lane:handoffClosed",
      outcome: "advance",
      itemId: "item-2",
    });
    expect(advanced.state.run.idx).toBe(1);
    expect(advanced.state.item.itemId).toBe("item-2");
  });

  it("returns a completed coach lane to the machine-owned fresh issue", () => {
    const coachFlow = advanceBreakerFlow(newBreakerFlow("unavailable"), {
      type: "coachOpened",
    });
    const coached: PracticeState = {
      ...start(),
      lane: "handoff",
      breaker: {
        triggerAttemptId: "attempt-1",
        recoveryAvailable: true,
        triggerItemId: "item-1",
        missStreak: 3,
        triggerNodeKey: "addition",
        domain: "whole-number-arithmetic",
        flow: coachFlow,
        freshItemId: null,
        easyItemId: null,
        repairStepIndex: null,
        lifecycle: {
          confirmed: ["coachEscalated"],
          pending: [],
        },
        easyRequested: false,
        emitted: [],
      },
    };
    const ended = practiceReduce(coached, { type: "lane:coachEnded" });
    expect(ended.state.lane).toBeNull();
    expect(ended.commands).toEqual([
      expect.objectContaining({
        kind: "serveBreakerFresh",
        triggerAttemptId: "attempt-1",
      }),
    ]);
  });

  it("suspends and returns a native-only beat through the generic bridge", () => {
    const entered = practiceReduce(start(), {
      type: "lane:entered",
      lane: "beat",
    });
    expect(entered.state.lane).toBe("beat");
    const proceeded = practiceReduce(entered.state, {
      type: "lane:beatProceeded",
    });
    expect(proceeded.state.lane).toBeNull();
    expect(proceeded.state.run.idx).toBe(0);
  });

  it("replaces a completed run through the typed tail bridge", () => {
    const terminal = {
      ...start(),
      terminal: true,
      lane: "offers" as const,
    };
    const accepted = practiceReduce(terminal, {
      type: "lane:tailAccepted",
      itemCount: 2,
      itemId: "challenge-1",
    });
    expect(accepted.state).toMatchObject({
      terminal: false,
      lane: null,
      run: { idx: 0, itemCount: 2, correctCount: 0, answeredCount: 0 },
      item: { itemId: "challenge-1", phase: { kind: "answering" } },
    });
  });
});
