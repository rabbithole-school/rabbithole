/**
 * Golden characterization vectors: what the CURRENT web orchestration actually
 * does, captured by temporarily instrumenting `PracticeSession.tsx` and driving
 * the real app (worktree dev server, seeded scholar, live Convex dev
 * deployment). The instrumentation itself was deliberately not committed — only
 * the observations are, and this suite replays them against the machine.
 *
 * These matter because ordering and failure paths are exactly what a careful
 * READING of a 5,782-line component gets wrong. Every expectation below is an
 * observed sequence, not an inferred one; the raw traces are quoted in the
 * comments so a later reader can tell evidence from intent.
 *
 * Coverage is honest about its limits. The submit, retry and resume-write
 * ordering were observed live. The breaker chain and offline paths are covered
 * by the vectors in practiceMachine.test.ts, derived from the source with line
 * references and pinned server-side by the convex practice suites; they are
 * marked as such rather than being passed off as captured traces.
 */

import { describe, expect, it } from "vitest";

import {
  newPracticeState,
  practiceReduce,
  resumeIdx,
  submitCommandId,
  type PracticeCommand,
  type PracticeState,
} from "./practiceMachine";
import type { OutboxAnswer } from "./practiceOutboxContract";

const SCHOLAR = "scholar-1";
const ITEM = "gen#jx7tbedvkjs7wzxtvbcddw91rx8dd2sc";

const kinds = (commands: PracticeCommand[]) => commands.map((c) => c.kind);

function entry(over: Partial<OutboxAnswer> = {}): OutboxAnswer {
  return {
    clientEventId: "3bf9a6f9-8eb2-43c7-b0ee-4e9a79e8d79d",
    itemId: ITEM,
    answer: "100",
    record: true,
    skillLabel: "Write three-digit numbers in expanded form",
    queuedAt: 0,
    ...over,
  };
}

function start(): PracticeState {
  return newPracticeState({ scholarId: SCHOLAR, itemCount: 8, itemId: ITEM });
}

describe("captured: a recorded first attempt that misses", () => {
  /**
   * Observed trace (relative ms):
   *   0    submit:call        { itemId, clientEventId, record: true }
   *   688  submit:ok          { correct: false, backOff: false }
   *   736  persist:saveResume { idx: 0, hasRecorded: true }
   */
  it("submits once, then writes the resume snapshot AFTER the grade", () => {
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    expect(kinds(submitted.commands)).toEqual(["submitAnswer"]);

    const graded = practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId(e.clientEventId),
      result: { correct: false },
    });

    // The observed order: the snapshot is written once the grade is known, not
    // optimistically before it. A snapshot written before the grade would
    // resume past an item whose result never landed.
    expect(kinds(graded.commands)).toEqual(["saveResume", "haptic"]);
    const save = graded.commands.find((c) => c.kind === "saveResume");
    expect(save).toBeDefined();
  });

  it("records the same position the live app persisted: idx 0, hasRecorded true", () => {
    const e = entry();
    const graded = practiceReduce(
      practiceReduce(start(), {
        type: "ui:submit",
        answer: e.answer,
        clientEventId: e.clientEventId,
        entry: e,
      }).state,
      {
        type: "server:submitSucceeded",
        id: submitCommandId(e.clientEventId),
        result: { correct: false },
      },
    );
    expect(graded.state.run.idx).toBe(0);
    expect(graded.state.item.hasRecorded).toBe(true);
    // …which is what makes the resume position the FIRST UN-RECORDED item.
    expect(resumeIdx(graded.state)).toBe(1);
  });
});

describe("captured: the retry after a miss", () => {
  /**
   * Observed trace (continuing the run above):
   *   24756 submit:call { itemId: <same>, clientEventId: "3cf3ee83-…", record: false }
   *   25051 submit:ok   { correct: false, backOff: false }
   *   25068 persist:saveResume { idx: 0, hasRecorded: true }
   *
   * Two things the live app proves here, both easy to get wrong by reading:
   *  1. the retry carries `record: false` — it is a diagnostic attempt and must
   *     not move the scheduler a second time;
   *  2. it carries a DIFFERENT clientEventId from the first attempt. The receipt
   *     is per logical answer, so a genuinely new answer mints a new one; only
   *     an identical replay of the SAME answer reuses it, which is what makes
   *     the server's dedup exact rather than over-eager.
   */
  it("mints a NEW receipt for a genuinely different answer", () => {
    const first = entry();
    const graded = practiceReduce(
      practiceReduce(start(), {
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        entry: first,
      }).state,
      {
        type: "server:submitSucceeded",
        id: submitCommandId(first.clientEventId),
        result: { correct: false },
      },
    );
    // Consumed, so the next logical answer gets its own receipt.
    expect(graded.state.item.clientEventId).toBeNull();

    const retried = practiceReduce(graded.state, { type: "ui:retry" });
    const second = entry({
      clientEventId: "3cf3ee83-01ff-494e-8dab-5da905c15580",
      record: false,
      answer: "200",
    });
    const resubmitted = practiceReduce(retried.state, {
      type: "ui:submit",
      answer: second.answer,
      clientEventId: second.clientEventId,
      entry: second,
    });
    const command = resubmitted.commands[0];
    expect(command?.kind).toBe("submitAnswer");
    expect(command?.id).toBe(submitCommandId("3cf3ee83-01ff-494e-8dab-5da905c15580"));
    expect(command?.id).not.toBe(submitCommandId(first.clientEventId));
  });

  it("keeps the SAME receipt when the identical answer is replayed after a failure", () => {
    // The mirror image, and the reason the receipt is held in state at all: a
    // lost response must replay under its original id so the server recognizes
    // it, rather than minting a duplicate attempt.
    const e = entry();
    const submitted = practiceReduce(start(), {
      type: "ui:submit",
      answer: e.answer,
      clientEventId: e.clientEventId,
      entry: e,
    });
    const failed = practiceReduce(submitted.state, {
      type: "server:submitFailed",
      id: submitCommandId(e.clientEventId),
      submissionReplay: false,
    });
    expect(failed.state.item.clientEventId).toBe(e.clientEventId);
    expect(failed.state.item.clientEventReplay).toBe(false);
  });

  it("does not double-count the run when a retry is graded", () => {
    // Observed: the second submit reported `record: false`, and the app's
    // position did not move (`idx: 0` in both saveResume entries).
    const first = entry();
    const graded = practiceReduce(
      practiceReduce(start(), {
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        entry: first,
      }).state,
      {
        type: "server:submitSucceeded",
        id: submitCommandId(first.clientEventId),
        result: { correct: false },
      },
    );
    const second = entry({ clientEventId: "evt-retry", record: false });
    const regraded = practiceReduce(
      practiceReduce(practiceReduce(graded.state, { type: "ui:retry" }).state, {
        type: "ui:submit",
        answer: second.answer,
        clientEventId: second.clientEventId,
        entry: second,
      }).state,
      {
        type: "server:submitSucceeded",
        id: submitCommandId("evt-retry"),
        result: { correct: false },
      },
    );
    // `answeredCount` counts items, not attempts: the item was already recorded.
    expect(regraded.state.run.answeredCount).toBe(1);
    expect(regraded.state.run.idx).toBe(0);
  });
});
