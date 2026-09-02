import {
  createElement,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─────────────────────────────────────────────────────────────────────────
// These tests exercise ONLY the native binding seams `usePracticeMachine.ts`
// adds on top of the shared reducer (already covered by
// shared/practiceMachine.test.ts) and the shared coordinator (already covered
// by native/src/lib/__tests__/practiceCoordinator.test.ts): the bounded outbox
// drain-retry scheduler and the `onAnswerQueued` binding a promise-based
// caller (NativeManipulativeItem) needs to resolve its own submission. A real
// file-system-backed adapter and a real Convex client are irrelevant to that,
// so both are replaced with tiny in-memory/no-op fakes.
// ─────────────────────────────────────────────────────────────────────────

const store = vi.hoisted(() => ({
  files: new Map<string, string>(),
  failNextWrite: false,
}));

vi.mock("@/lib/practicePersistenceAdapter", () => ({
  nativePracticePersistenceAdapter: {
    kind: "memory",
    read: async (key: string) => store.files.get(key) ?? null,
    write: async (key: string, value: string) => {
      if (store.failNextWrite) {
        store.failNextWrite = false;
        throw new Error("simulated process death before durable write");
      }
      store.files.set(key, value);
    },
    remove: async (key: string) => {
      store.files.delete(key);
    },
  },
}));

const handlers = vi.hoisted(() => ({
  submitAnswer: vi.fn(),
  serveHintStep: vi.fn(),
  recordBreakerRecoveryLifecycle: vi.fn(
    async (_args: { event: string; triggerAttemptId?: unknown }) => ({
      recorded: true,
      lifecycle: {} as Record<string, number>,
    }),
  ),
  recordBreakerOutcome: vi.fn(async () => ({})),
  completeTuneup: vi.fn(async () => ({})),
  breakerEasyFinishSession: vi.fn(),
  breakerRecoverySession: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useConvex: () => ({
    mutation: (ref: string, args: unknown) => {
      if (ref === "practiceSkills.breakerEasyFinishSession") {
        return handlers.breakerEasyFinishSession(args);
      }
      if (ref === "practiceSkills.breakerRecoverySession") {
        return handlers.breakerRecoverySession(args);
      }
      return Promise.resolve({});
    },
  }),
  useMutation: (ref: string) => {
    switch (ref) {
      case "practiceSkills.submitAnswer":
        return handlers.submitAnswer;
      case "practiceSkills.serveHintStep":
        return handlers.serveHintStep;
      case "practiceSkills.recordBreakerRecoveryLifecycle":
        return handlers.recordBreakerRecoveryLifecycle;
      case "practiceSkills.recordBreakerOutcome":
        return handlers.recordBreakerOutcome;
      case "practiceTuneups.complete":
        return handlers.completeTuneup;
      default:
        return vi.fn();
    }
  },
}));

vi.mock("@convex/api", () => ({
  api: {
    practiceSkills: {
      submitAnswer: "practiceSkills.submitAnswer",
      serveHintStep: "practiceSkills.serveHintStep",
      recordBreakerRecoveryLifecycle: "practiceSkills.recordBreakerRecoveryLifecycle",
      recordBreakerOutcome: "practiceSkills.recordBreakerOutcome",
      breakerEasyFinishSession: "practiceSkills.breakerEasyFinishSession",
      breakerRecoverySession: "practiceSkills.breakerRecoverySession",
    },
    practiceTuneups: { complete: "practiceTuneups.complete" },
  },
}));

import {
  usePracticeMachine,
  type PracticeHostBindings,
  type PracticeMachineHandle,
} from "../usePracticeMachine";
import { newPracticeState } from "../../../vendor/shared/practiceMachine";
import type { Id } from "@convex/dataModel";
import {
  enqueueOutboxAnswer,
  type OutboxAnswer,
} from "../../../vendor/shared/practiceOutboxContract";
import { nativePracticePersistenceAdapter } from "@/lib/practicePersistenceAdapter";
import { restoreBreakerTriggerItemPayload } from "@/lib/breakerItemCache";

const SCHOLAR = "scholar-1" as Id<"users">;

function entry(clientEventId: string): OutboxAnswer {
  return {
    clientEventId,
    itemId: "item-1",
    answer: "4",
    record: true,
    skillLabel: "skill",
    queuedAt: 0,
  };
}

function unavailableBreakerResult() {
  return {
    correct: false,
    backOff: { missStreak: 3 },
    breakerRecovery: {
      triggerAttemptId: "attempt-trigger",
      triggerNodeKey: "node-trigger",
      domain: "whole-number-arithmetic",
      initialRepair: {
        rung: null,
        hasMore: false,
        stepCount: 0,
      },
    },
  };
}

function pinnedEasyEpisode() {
  return {
    triggerAttemptId: "attempt-9",
    recoveryAvailable: true,
    triggerItemId: "item-trigger",
    triggerNodeKey: "node-9",
    domain: "whole-number-arithmetic",
    missStreak: 3,
    flow: {
      stage: "easy" as const,
      repair: "done" as const,
      coachUsed: true,
      fresh: { correct: false, assisted: false, verified: true },
      easy: "requested" as const,
    },
    repairStepIndex: 1,
    freshItemId: "item-fresh",
    easyItemId: "item-easy",
  };
}

function Harness({
  handle,
  online,
  onGrade,
  onQueuedCount,
  onAnswerQueued,
  onBreakerItem,
  onCoach,
  onHintError,
  onSubmitError,
  onTriggerItemPersistenceError,
}: {
  handle: { current: PracticeMachineHandle | null };
  online: boolean;
  onGrade: (result: unknown, entry: OutboxAnswer) => void;
  onQueuedCount: (count: number) => void;
  onAnswerQueued: (entry: OutboxAnswer, count: number) => void;
  onBreakerItem: (item: unknown, kind: "fresh" | "easy") => void;
  onCoach: () => void;
  onHintError: (message: string) => void;
  onSubmitError: (message: string | null) => void;
  onTriggerItemPersistenceError: (error: unknown) => void;
}) {
  const hostRef = useRef<PracticeHostBindings>({
    scholarId: SCHOLAR,
    loadRun: async () => ({
      itemCount: 1,
      itemId: "item-1",
      scopeKey: "scope",
      dayKey: "day",
    }),
    onLoadError: () => {},
    onSubmitError,
    getTriggerItemPayload: (itemId) => ({ itemId, stem: "What is 2 + 2?" }),
    onTriggerItemPersistenceError,
    onBreakerItem,
    onHintRung: () => {},
    onHintError,
    onGrade,
    onCoach,
    onHandoff: () => {},
    buildResumeSnapshot: () => null,
    onQueuedCount,
    onDispatchCompleted: () => {},
    onAnswerQueued,
  });
  const initial = useMemo(
    () => newPracticeState({ scholarId: String(SCHOLAR), itemCount: 1, itemId: "item-1" }),
    [],
  );
  const machine = usePracticeMachine(initial, SCHOLAR, hostRef, { online });
  useLayoutEffect(() => {
    hostRef.current = {
      ...hostRef.current,
      onGrade,
      onQueuedCount,
      onAnswerQueued,
      onBreakerItem,
      onCoach,
      onHintError,
      onSubmitError,
      onTriggerItemPersistenceError,
    };
  }, [
    onAnswerQueued,
    onBreakerItem,
    onCoach,
    onHintError,
    onSubmitError,
    onGrade,
    onQueuedCount,
    onTriggerItemPersistenceError,
  ]);
  useImperativeHandle(handle, () => machine, [machine]);
  return null;
}

async function mount(online: boolean) {
  const handle: { current: PracticeMachineHandle | null } = { current: null };
  const onGrade = vi.fn();
  const onQueuedCount = vi.fn();
  const onAnswerQueued = vi.fn();
  const onBreakerItem = vi.fn();
  const onCoach = vi.fn();
  const onHintError = vi.fn();
  const onSubmitError = vi.fn();
  const onTriggerItemPersistenceError = vi.fn();
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(
      createElement(Harness, {
        handle,
        online,
        onGrade,
        onQueuedCount,
        onAnswerQueued,
        onBreakerItem,
        onCoach,
        onHintError,
        onSubmitError,
        onTriggerItemPersistenceError,
      }),
    );
  });
  const rerender = async (nextOnline: boolean) => {
    await act(async () => {
      tree.update(
        createElement(Harness, {
          handle,
          online: nextOnline,
          onGrade,
          onQueuedCount,
          onAnswerQueued,
          onBreakerItem,
          onCoach,
          onHintError,
          onSubmitError,
          onTriggerItemPersistenceError,
        }),
      );
    });
  };
  return {
    handle,
    tree,
    onGrade,
    onQueuedCount,
    onAnswerQueued,
    onBreakerItem,
    onCoach,
    onHintError,
    onSubmitError,
    onTriggerItemPersistenceError,
    rerender,
  };
}

beforeEach(() => {
  store.files.clear();
  store.failNextWrite = false;
  handlers.submitAnswer.mockReset();
  handlers.serveHintStep.mockReset();
  handlers.breakerEasyFinishSession.mockReset();
  handlers.breakerRecoverySession.mockReset();
  handlers.recordBreakerRecoveryLifecycle.mockReset();
  handlers.recordBreakerRecoveryLifecycle.mockImplementation(
    async ({ event }: { event: string }) => {
      const field =
        event === "repair_shown"
          ? "repairShownAt"
          : event === "repair_unavailable"
            ? "repairUnavailableAt"
            : event === "repair_started"
              ? "repairStartedAt"
              : event === "repair_completed"
                ? "repairCompletedAt"
                : event === "coach_escalated"
                  ? "coachEscalatedAt"
                  : "stoppedAt";
      return { recorded: true, lifecycle: { [field]: 1 } };
    },
  );
  handlers.recordBreakerOutcome.mockClear();
  handlers.completeTuneup.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("usePracticeMachine (native binding seams)", () => {
  it("withholds the server mutation when death or storage failure precedes the payload write", async () => {
    handlers.submitAnswer.mockResolvedValue({ correct: false });
    const {
      handle,
      onGrade,
      onTriggerItemPersistenceError,
      tree,
    } = await mount(true);
    store.failNextWrite = true;

    await act(async () => {
      handle.current!.send({
        type: "ui:submit",
        answer: "4",
        clientEventId: "evt-before-write",
        entry: entry("evt-before-write"),
      });
    });

    expect(handlers.submitAnswer).not.toHaveBeenCalled();
    expect(onGrade).not.toHaveBeenCalled();
    expect(handlers.recordBreakerRecoveryLifecycle).not.toHaveBeenCalled();
    expect(handlers.recordBreakerOutcome).not.toHaveBeenCalled();
    expect(onTriggerItemPersistenceError).toHaveBeenCalledTimes(1);
    expect(handle.current!.state.item.phase.kind).toBe("answering");
    expect(handle.current!.state.item.clientEventReplay).toBe(false);
    expect(store.files.size).toBe(0);
    await act(async () => tree.unmount());
  });

  it("marks an offline trigger-staging failure as an offline-first replay", async () => {
    handlers.submitAnswer.mockResolvedValueOnce({ correct: true });
    const mounted = await mount(false);
    store.failNextWrite = true;
    const first = entry("evt-offline-stage");

    await act(async () => {
      mounted.handle.current!.send({
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        clientEventKey: "offline-trigger-payload",
        entry: first,
      });
    });

    expect(handlers.submitAnswer).not.toHaveBeenCalled();
    expect(mounted.handle.current!.state.item.clientEventReplay).toBe(true);

    await mounted.rerender(true);
    await act(async () => {
      mounted.handle.current!.send({
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        clientEventKey: "offline-trigger-payload",
        entry: {
          ...first,
          submissionReplay:
            mounted.handle.current!.state.item.clientEventReplay ?? undefined,
        },
      });
    });
    expect(handlers.submitAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ replay: true }),
    );
    await act(async () => mounted.tree.unmount());
  });

  it("retains the original online replay mode after ambiguous persistence failure", async () => {
    handlers.submitAnswer
      .mockRejectedValueOnce(new Error("ambiguous"))
      .mockResolvedValueOnce({ correct: true });
    const mounted = await mount(true);
    store.failNextWrite = true;
    const first = {
      ...entry("evt-replay-online"),
      suppressBreaker: true,
    };

    await act(async () => {
      mounted.handle.current!.send({
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        clientEventKey: "same-payload",
        entry: first,
      });
    });
    expect(mounted.handle.current!.state.item.clientEventReplay).toBe(false);
    expect(mounted.onSubmitError).toHaveBeenLastCalledWith(
      "That answer couldn't be saved. Try again before moving on.",
    );

    await act(async () => {
      mounted.handle.current!.send({
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        clientEventKey: "same-payload",
        entry: {
          ...first,
          submissionReplay:
            mounted.handle.current!.state.item.clientEventReplay ?? undefined,
        },
      });
    });
    expect(handlers.submitAnswer).toHaveBeenCalledTimes(2);
    expect(handlers.submitAnswer.mock.calls.map(([args]) => args.replay)).toEqual([
      false,
      false,
    ]);
    expect(mounted.onSubmitError).toHaveBeenLastCalledWith(null);
    await act(async () => mounted.tree.unmount());
  });

  it("retains offline replay mode when durable enqueue itself fails", async () => {
    handlers.submitAnswer.mockResolvedValueOnce({ correct: true });
    const mounted = await mount(false);
    store.failNextWrite = true;
    const first = {
      ...entry("evt-replay-offline"),
      suppressBreaker: true,
    };

    await act(async () => {
      mounted.handle.current!.send({
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        clientEventKey: "same-offline-payload",
        entry: first,
      });
    });
    expect(mounted.handle.current!.state.item.clientEventReplay).toBe(true);
    expect(mounted.onSubmitError).toHaveBeenLastCalledWith(
      "That answer couldn't be saved. Try again before moving on.",
    );

    await mounted.rerender(true);
    await act(async () => {
      mounted.handle.current!.send({
        type: "ui:submit",
        answer: first.answer,
        clientEventId: first.clientEventId,
        clientEventKey: "same-offline-payload",
        entry: {
          ...first,
          submissionReplay:
            mounted.handle.current!.state.item.clientEventReplay ?? undefined,
        },
      });
    });
    expect(handlers.submitAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ replay: true }),
    );
    expect(mounted.onSubmitError).toHaveBeenLastCalledWith(null);
    await act(async () => mounted.tree.unmount());
  });

  it("finishes the crash-atomic payload write before allowing a trigger attempt to commit", async () => {
    handlers.submitAnswer.mockImplementation(async () => {
      const raw = store.files.get("rh-practice-breaker-item:scholar-1");
      expect(raw).toBeDefined();
      expect(JSON.parse(raw!)).toMatchObject({
        v: 2,
        entries: [
          {
            clientEventId: "evt-trigger",
            itemId: "item-1",
            item: { itemId: "item-1", stem: "What is 2 + 2?" },
          },
        ],
      });
      return {
        correct: false,
        backOff: { missStreak: 3 },
        breakerRecovery: {
          triggerAttemptId: "attempt-trigger",
          triggerNodeKey: "node-trigger",
          domain: "whole-number-arithmetic",
          initialRepair: {
            rung: {
              kind: "completion",
              stepIndex: 0,
              prompt: "Finish the step",
              expected: "4",
              answerType: "integer",
            },
            hasMore: true,
            stepCount: 2,
          },
        },
      };
    });
    const { handle, onGrade, tree } = await mount(true);

    await act(async () => {
      handle.current!.send({
        type: "ui:submit",
        answer: "4",
        clientEventId: "evt-trigger",
        entry: entry("evt-trigger"),
      });
    });

    expect(handlers.submitAnswer).toHaveBeenCalledTimes(1);
    expect(onGrade).toHaveBeenCalledTimes(1);
    expect(handle.current!.state.breaker).toMatchObject({
      triggerAttemptId: "attempt-trigger",
      triggerItemId: "item-1",
      missStreak: 3,
    });
    await expect(
      restoreBreakerTriggerItemPayload(
        nativePracticePersistenceAdapter,
        String(SCHOLAR),
        "attempt-trigger",
        "item-1",
      ),
    ).resolves.toMatchObject({
      status: "ready",
      source: "bound",
      item: { itemId: "item-1", stem: "What is 2 + 2?" },
    });
    await act(async () => tree.unmount());
  });

  it("presents the coach before awaiting lifecycle persistence and confirms after one retry", async () => {
    vi.useFakeTimers();
    handlers.submitAnswer.mockResolvedValue(unavailableBreakerResult());
    handlers.recordBreakerRecoveryLifecycle
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce({
        recorded: true,
        lifecycle: { coachEscalatedAt: 1 },
      });
    const { handle, onCoach, tree } = await mount(true);

    await act(async () => {
      handle.current!.send({
        type: "ui:submit",
        answer: "4",
        clientEventId: "evt-coach-retry",
        entry: entry("evt-coach-retry"),
      });
      await Promise.resolve();
    });

    expect(onCoach).toHaveBeenCalledTimes(1);
    expect(handle.current!.state.lane).toBe("handoff");
    expect(handlers.recordBreakerRecoveryLifecycle).toHaveBeenCalledTimes(1);
    expect(handle.current!.state.breaker?.lifecycle.pending[0]).toMatchObject({
      operation: "coachEscalated",
      status: "pending",
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(handlers.recordBreakerRecoveryLifecycle).toHaveBeenCalledTimes(2);
    expect(onCoach).toHaveBeenCalledTimes(1);
    expect(handle.current!.state.breaker?.lifecycle.pending).toEqual([]);
    expect(handlers.recordBreakerRecoveryLifecycle.mock.calls[0][0]).toMatchObject({
      triggerAttemptId: "attempt-trigger",
      event: "coach_escalated",
    });
    expect(handlers.recordBreakerRecoveryLifecycle.mock.calls[1][0]).toMatchObject({
      triggerAttemptId: "attempt-trigger",
      event: "coach_escalated",
    });
    await act(async () => tree.unmount());
  });

  it("fails closed after three unconfirmed lifecycle writes, retries without relaunching coach, and preserves the trigger payload", async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    handlers.submitAnswer.mockResolvedValue(unavailableBreakerResult());
    handlers.recordBreakerRecoveryLifecycle.mockResolvedValue({
      recorded: true,
      // A success-shaped response without the exact requested evidence is not
      // an acknowledgement and must exhaust the same bounded retry path.
      lifecycle: { repairStartedAt: 1 },
    });
    handlers.breakerRecoverySession.mockResolvedValue({
      items: [{ itemId: "item-fresh" }],
    });
    const { handle, onBreakerItem, onCoach, tree } = await mount(true);

    await act(async () => {
      handle.current!.send({
        type: "ui:submit",
        answer: "4",
        clientEventId: "evt-coach-exhausted",
        entry: entry("evt-coach-exhausted"),
      });
      await Promise.resolve();
    });
    expect(onCoach).toHaveBeenCalledTimes(1);
    expect(handlers.recordBreakerRecoveryLifecycle).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(handlers.recordBreakerRecoveryLifecycle).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(handlers.recordBreakerRecoveryLifecycle).toHaveBeenCalledTimes(3);
    expect(handle.current!.state.breaker?.lifecycle.pending).toEqual([
      { operation: "coachEscalated", status: "recoverable" },
    ]);
    expect(onCoach).toHaveBeenCalledTimes(1);
    expect(handlers.breakerRecoverySession).not.toHaveBeenCalled();
    expect(handlers.breakerEasyFinishSession).not.toHaveBeenCalled();
    expect(handlers.recordBreakerOutcome).not.toHaveBeenCalled();

    await expect(
      restoreBreakerTriggerItemPayload(
        nativePracticePersistenceAdapter,
        String(SCHOLAR),
        "attempt-trigger",
        "item-1",
      ),
    ).resolves.toMatchObject({
      status: "ready",
      source: "bound",
      item: { itemId: "item-1" },
    });

    await act(async () => {
      handle.current!.send({ type: "lane:coachEnded" });
    });
    expect(handle.current!.state.lane).toBeNull();
    expect(handlers.breakerRecoverySession).not.toHaveBeenCalled();

    handlers.recordBreakerRecoveryLifecycle.mockReset();
    handlers.recordBreakerRecoveryLifecycle.mockResolvedValue({
      recorded: true,
      lifecycle: { coachEscalatedAt: 2 },
    });
    await act(async () => {
      handle.current!.send({ type: "ui:retryBreakerLifecycle" });
      await Promise.resolve();
    });

    expect(handlers.recordBreakerRecoveryLifecycle).toHaveBeenCalledTimes(1);
    expect(onCoach).toHaveBeenCalledTimes(1);
    expect(handlers.breakerRecoverySession).toHaveBeenCalledTimes(1);
    expect(onBreakerItem).toHaveBeenCalledWith(
      { itemId: "item-fresh" },
      "fresh",
    );
    expect(handle.current!.state.breaker?.lifecycle.pending).toEqual([]);

    consoleError.mockRestore();
    await act(async () => tree.unmount());
  });

  it("queues while the Convex socket is offline and drains only after it reconnects", async () => {
    vi.useFakeTimers();
    handlers.submitAnswer.mockResolvedValue({ correct: true });
    const { handle, onAnswerQueued, onQueuedCount, rerender, tree } =
      await mount(false);

    await act(async () => {
      handle.current!.send({
        type: "ui:submit",
        answer: "4",
        clientEventId: "evt-1",
        entry: entry("evt-1"),
      });
    });

    // Known-offline: enqueued immediately, no submit attempt at all.
    expect(handlers.submitAnswer).not.toHaveBeenCalled();
    expect(onAnswerQueued).toHaveBeenCalledTimes(1);
    expect(onAnswerQueued.mock.calls[0][0]).toMatchObject({ clientEventId: "evt-1" });
    expect(onAnswerQueued.mock.calls[0][1]).toBe(1);
    expect(onQueuedCount).toHaveBeenLastCalledWith(1);
    expect(handle.current!.state.item.phase.kind).toBe("queued");

    // The socket is the honest connectivity signal: bounded retry must not
    // invent an online transition while Convex still reports disconnected.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(handlers.submitAnswer).not.toHaveBeenCalled();

    await rerender(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(handlers.submitAnswer).toHaveBeenCalledTimes(1);
    expect(onQueuedCount).toHaveBeenLastCalledWith(0);

    await act(async () => tree.unmount());
  });

  it("queues an online submit that fails ambiguously and reports it the same way", async () => {
    handlers.submitAnswer.mockImplementationOnce(async () => {
      // The server may commit immediately after this callback begins. The
      // candidate must already be durable even though this response is lost.
      expect(store.files.get("rh-practice-breaker-item:scholar-1")).toBeDefined();
      throw new Error("network blip");
    });
    const {
      handle,
      onAnswerQueued,
      onGrade,
      onQueuedCount,
      tree,
    } = await mount(true);

    await act(async () => {
      handle.current!.send({
        type: "ui:submit",
        answer: "4",
        clientEventId: "evt-2",
        entry: entry("evt-2"),
      });
    });

    // A live attempt WAS made (unlike the known-offline case above) — it just
    // didn't land cleanly, so the SAME entry falls back to the outbox rather
    // than being lost or silently retried under a new receipt.
    expect(handlers.submitAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswerQueued).toHaveBeenCalledTimes(1);
    expect(onAnswerQueued.mock.calls[0][0]).toMatchObject({ clientEventId: "evt-2" });
    expect(handle.current!.state.item.phase.kind).toBe("queued");
    expect(onQueuedCount).toHaveBeenLastCalledWith(1);
    expect(onGrade).not.toHaveBeenCalled();
    expect(handlers.recordBreakerRecoveryLifecycle).not.toHaveBeenCalled();
    expect(handlers.recordBreakerOutcome).not.toHaveBeenCalled();

    // Model the lost response having committed a breaker. Two process
    // relaunches can adopt and then re-read the same candidate without
    // resubmitting or manufacturing a second grade/lifecycle/outcome.
    const firstRelaunch = await restoreBreakerTriggerItemPayload(
      nativePracticePersistenceAdapter,
      String(SCHOLAR),
      "attempt-lost-ack",
      "item-1",
    );
    const secondRelaunch = await restoreBreakerTriggerItemPayload(
      nativePracticePersistenceAdapter,
      String(SCHOLAR),
      "attempt-lost-ack",
      "item-1",
    );
    expect(firstRelaunch).toMatchObject({
      status: "ready",
      source: "candidate",
      item: { itemId: "item-1" },
    });
    expect(secondRelaunch).toMatchObject({
      status: "ready",
      source: "bound",
      item: { itemId: "item-1" },
    });
    expect(handlers.submitAnswer).toHaveBeenCalledTimes(1);

    await act(async () => tree.unmount());
  });

  it("maps persisted timing fields back to the submitAnswer API names", async () => {
    handlers.submitAnswer.mockResolvedValue({ correct: true });
    const { handle, tree } = await mount(true);
    await act(async () => {
      handle.current!.send({
        type: "ui:submit",
        answer: "4",
        clientEventId: "evt-timing",
        entry: {
          ...entry("evt-timing"),
          latencyMs: 125,
          thinkTimeMs: 500,
        },
      });
    });

    expect(handlers.submitAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        clientEventId: "evt-timing",
        firstKeyMs: 125,
        elapsedMs: 500,
      }),
    );
    const submitted = handlers.submitAnswer.mock.calls[0][0];
    expect(submitted).not.toHaveProperty("latencyMs");
    expect(submitted).not.toHaveProperty("thinkTimeMs");
    await act(async () => tree.unmount());
  });

  it("reinstalls only the server-pinned easy item without inventing unavailability", async () => {
    const episode = pinnedEasyEpisode();
    handlers.breakerEasyFinishSession.mockResolvedValueOnce({
      available: true,
      items: [{ itemId: "item-easy" }],
    });
    const matching = await mount(true);
    await act(async () => {
      matching.handle.current!.send({ type: "hydrate:breaker", episode });
    });
    expect(matching.onBreakerItem).toHaveBeenCalledWith(
      { itemId: "item-easy" },
      "easy",
    );
    expect(matching.handle.current!.state.item.itemId).toBe("item-easy");
    expect(handlers.recordBreakerRecoveryLifecycle).not.toHaveBeenCalled();
    expect(handlers.recordBreakerOutcome).not.toHaveBeenCalled();
    expect(handlers.submitAnswer).not.toHaveBeenCalled();
    await act(async () => matching.tree.unmount());

    handlers.breakerEasyFinishSession.mockResolvedValueOnce({
      available: true,
      items: [{ itemId: "item-other" }],
    });
    const mismatch = await mount(true);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      mismatch.handle.current!.send({ type: "hydrate:breaker", episode });
    });
    expect(mismatch.onBreakerItem).not.toHaveBeenCalled();
    expect(mismatch.handle.current!.state.item.itemId).not.toBe("item-other");
    expect(mismatch.handle.current!.state.breaker?.flow).toMatchObject({
      stage: "easy",
      easy: "requested",
    });
    expect(mismatch.onHintError).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      "practice breaker easy item mismatch: expected item-easy, received item-other",
    );
    consoleError.mockRestore();
    await act(async () => mismatch.tree.unmount());
  });

  it("releases a transient easy-finish failure for exact retry", async () => {
    handlers.breakerEasyFinishSession
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce({
        available: true,
        items: [{ itemId: "item-easy" }],
      });
    const mounted = await mount(true);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await act(async () => {
      mounted.handle.current!.send({
        type: "hydrate:breaker",
        episode: pinnedEasyEpisode(),
      });
    });

    expect(mounted.onHintError).toHaveBeenCalledWith(
      "That easy finish couldn’t load — try again.",
    );
    expect(mounted.handle.current!.state.breaker?.easyRequested).toBe(false);
    expect(mounted.handle.current!.state.breaker?.flow.easy).toBe("requested");

    await act(async () => {
      mounted.handle.current!.send({ type: "ui:breakerEasyFinish" });
    });
    expect(handlers.breakerEasyFinishSession).toHaveBeenCalledTimes(2);
    expect(mounted.onBreakerItem).toHaveBeenCalledWith(
      { itemId: "item-easy" },
      "easy",
    );
    expect(mounted.handle.current!.state.item.itemId).toBe("item-easy");
    consoleError.mockRestore();
    await act(async () => mounted.tree.unmount());
  });

  it("closes only when the server authoritatively reports easy-finish unavailability", async () => {
    handlers.breakerEasyFinishSession.mockResolvedValueOnce({
      available: false,
      items: [],
    });
    const mounted = await mount(true);
    await act(async () => {
      mounted.handle.current!.send({
        type: "hydrate:breaker",
        episode: pinnedEasyEpisode(),
      });
    });

    expect(mounted.handle.current!.state.breaker?.flow).toMatchObject({
      stage: "close",
      easy: "unavailable",
    });
    expect(mounted.onHintError).not.toHaveBeenCalled();
    await act(async () => mounted.tree.unmount());
  });

  it("doubles the retry delay across consecutive blocked drains, capped at 30s", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    // Every replay attempt fails — the drain stays "blocked" every pass, so
    // each pass must schedule a LONGER retry than the one before it.
    handlers.submitAnswer.mockRejectedValue(new Error("still down"));
    await enqueueOutboxAnswer(
      nativePracticePersistenceAdapter,
      String(SCHOLAR),
      entry("evt-3"),
    );
    const { tree } = await mount(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    setTimeoutSpy.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    const firstDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
    expect(firstDelay).toBe(2_000);

    setTimeoutSpy.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    const secondDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
    expect(secondDelay).toBe(4_000);

    await act(async () => tree.unmount());
    setTimeoutSpy.mockRestore();
  });

  it("relaunch: a pending outbox entry written by a PRIOR mount is neither lost nor left un-drained by a fresh one", async () => {
    vi.useFakeTimers();
    // Simulate the process having been killed with one answer still queued:
    // write it through the REAL contract function against the SAME (mocked)
    // adapter the harness will read from, entirely before any harness exists.
    const seeded = await enqueueOutboxAnswer(
      nativePracticePersistenceAdapter,
      String(SCHOLAR),
      entry("evt-relaunch"),
    );
    expect(seeded).not.toBeNull();
    expect(store.files.size).toBe(1);

    // The fresh mount's own submit succeeds immediately (this scholar is back
    // online), so only the PRE-EXISTING entry should ever reach the mock.
    handlers.submitAnswer.mockResolvedValue({ correct: true });
    const { onQueuedCount, tree } = await mount(true);

    // The mount-time drain is async (loadOutbox → env:mounted → drainOutbox);
    // let its microtasks/timers settle.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The relaunch reported the queued entry's count on mount (never silently
    // dropped it) and then drained it back down to zero — never re-alerting
    // or regrading anything the scholar already answered before the kill.
    expect(onQueuedCount).toHaveBeenCalledWith(1);
    expect(handlers.submitAnswer).toHaveBeenCalledTimes(1);
    expect(handlers.submitAnswer.mock.calls[0][0]).toMatchObject({
      clientEventId: "evt-relaunch",
    });
    expect(onQueuedCount).toHaveBeenLastCalledWith(0);
    expect(store.files.size).toBe(0);

    await act(async () => tree.unmount());
  });
});
