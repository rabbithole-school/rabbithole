/**
 * The native host for the practice machine: it turns emitted commands into
 * real effects (Convex mutations, native file-system persistence) and
 * dispatches typed results back. Ported from the web host
 * (hooks/usePracticeMachine.ts) — same reducer, same coordinator, same
 * outbox/resume contracts — with only the native-specific seams swapped in
 * (the native persistence adapter, `@convex/api`/`@convex/dataModel` path
 * aliases, and an optional `onHaptic` since native haptics are host/platform
 * policy web has no equivalent of).
 *
 * The split is the point. The reducer says WHAT should happen and rejects stale
 * results; `practiceCoordinator` decides WHETHER THIS CALLER may start a command
 * and in what order; this hook is the only place that actually calls a Convex
 * mutation or touches storage. Nothing below makes an orchestration decision —
 * if a branch here starts choosing what happens next, it belongs in the reducer.
 *
 * Two things are deliberately NOT here:
 *
 *   No one-shot latch refs. A command is emitted once by the transition that
 *   warrants it and claimed once by the coordinator, so the six latches the old
 *   orchestration needed (`breakerRepairStartedRef`, `breakerCoachStartedRef`,
 *   `breakerShownReportedRef`, `breakerFreshRequestedRef`,
 *   `breakerOutcomeReportedRef`, `doneHapticFired`) have nothing left to guard.
 *
 *   No promise chain. Ordering is a declared domain on the command, honored by
 *   the coordinator's keyed mutex, rather than a `breakerLifecycleQueueRef` that
 *   every new call site had to remember to await.
 *
 * One thing IS here that web's host doesn't have: a bounded drain-retry
 * scheduler (`scheduleDrainRetry`/`clearDrainRetry`, below). Native has no
 * browser `online` event pairing with the WebSocket the way web's `isOffline`
 * combines `navigator.onLine` + Convex connection state, so a drain that stops
 * early needs its OWN retry loop rather than waiting solely on the next
 * `env:mounted`/`env:online` transition. It is an executor-internal timer +
 * failure count in a ref — never canonical machine state.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useConvex, useMutation } from "convex/react";
import { api } from "@convex/api";
import type { Id } from "@convex/dataModel";
import {
  acquirePracticeCoordinator,
  releasePracticeCoordinator,
  type PracticeCoordinator,
} from "@/lib/practiceCoordinator";
import { nativePracticePersistenceAdapter } from "@/lib/practicePersistenceAdapter";
import {
  clearResumeSnapshot,
  saveResumeSnapshot,
  type ResumeSnapshot,
} from "../../vendor/shared/practiceResumeContract";
import {
  drainOutbox,
  enqueueOutboxAnswer,
  loadOutbox,
  submitWithOutboxBarrier,
  type OutboxAnswer,
  type OutboxSubmitArgs,
} from "../../vendor/shared/practiceOutboxContract";
import {
  outboxRetryDelayMs,
  withPracticeSubmitTimeout,
} from "@/lib/practiceOutboxRetry";
import {
  breakerLifecycleEvent,
  retryBreakerLifecycleWrite,
  type BreakerLifecycleOperation,
} from "../../vendor/shared/practiceLifecycleRetry";
import {
  settleBreakerTriggerItemSubmission,
  stageBreakerTriggerItemPayload,
} from "@/lib/breakerItemCache";
import {
  breakerLegacyOffer,
  breakerLegacyRecovery,
} from "../../vendor/shared/practiceLoop";
import {
  breakerEasyItemMatchesCommand,
  isDurableCommand,
  practiceReduce,
  type PracticeCommand,
  type PracticeEvent,
  type PracticeState,
} from "../../vendor/shared/practiceMachine";

/** What the host must supply that the machine cannot know: the served-item
 *  payloads, and the surfaces a command lands on. */
export type LoadedPracticeRun = {
  itemCount: number;
  itemId: string | null;
  scopeKey: string;
  dayKey: string;
  allMapping?: boolean;
  tuneupId?: string | null;
  resume?: { idx: number; hasRecorded: boolean; itemId: string | null };
  discardResume?: boolean;
};

export type PracticeHostBindings = {
  scholarId: Id<"users"> | null;
  loadRun: (
    inputKey: string,
    forceFresh: boolean,
  ) => Promise<LoadedPracticeRun>;
  onLoadError: (error: unknown) => void;
  onSubmitError: (message: string | null) => void;
  /** The exact scholar-safe item payload staged before a trigger-eligible submit. */
  getTriggerItemPayload: (itemId: string) => unknown | null;
  /** A submit was withheld because its trigger payload was not durably recoverable. */
  onTriggerItemPersistenceError: (error: unknown) => void;
  /** Install a server-issued breaker item (fresh or easy) as the whole run. */
  onBreakerItem: (item: unknown, kind: "fresh" | "easy") => void;
  /** Render a served hint rung. */
  onHintRung: (
    served: unknown,
    source: "ladder" | "breaker" | "breakerRestore",
  ) => void;
  onHintError: (message: string) => void;
  /** Install the server/client grade payload used only for rendering. */
  onGrade: (result: unknown, entry: OutboxAnswer) => void;
  /** Open the bounded Socratic coach on the trigger item. */
  onCoach: () => void;
  onHandoff: (entryMode: "ladder" | "spiral") => void;
  /** The snapshot payload for a resume write; null when there is nothing to save. */
  buildResumeSnapshot: (
    resumeIdx: number,
  ) => ResumeSnapshot<unknown, unknown, unknown> | null;
  /** Optional because native haptics are host/platform policy. */
  onHaptic?: (style: "success" | "warning") => void;
  onQueuedCount: (count: number) => void;
  onDispatchCompleted: (receipts: unknown) => void;
  /** Rehearsal's injected client grader. Present only in rehearse mode. */
  gradeLocally?: (entry: OutboxAnswer) => Promise<unknown>;
  /**
   * Native-only extension: an entry was durably queued rather than graded
   * (an offline submit, or a live one that failed ambiguously and fell back
   * to the outbox). Optional — a caller with no promise-based submit bridge
   * (the ordinary typed/MC path, which reacts to `state.item.phase` instead)
   * has nothing to do here. `NativeManipulativeItem`'s Done button is
   * promise-based (it awaits ITS OWN outcome), so the host uses this to
   * resolve that promise with `{ status: "queued" }` — the manipulative-only
   * counterpart to `onGrade` resolving it with the graded result.
   */
  onAnswerQueued?: (entry: OutboxAnswer, queuedCount: number) => void;
};

export type PracticeMachineHandle = {
  state: PracticeState;
  /** Dispatch an event and execute whatever it emits. */
  send: (event: PracticeEvent) => void;
  coordinator: PracticeCoordinator | null;
};

type CommandBatch = {
  sequence: number;
  commands: readonly PracticeCommand[];
};

type MachineHostState = {
  machine: PracticeState;
  batches: readonly CommandBatch[];
  nextSequence: number;
};

type MachineHostAction =
  | { type: "event"; event: PracticeEvent }
  | { type: "batchFinished"; sequence: number };

/**
 * `host` is a ref the component installs in a layout effect. The machine owns
 * state; the host owns render payloads, and those closures change every render.
 * The layout effect runs before this hook's passive command executor, so every
 * command sees the just-committed bindings without reading or writing a ref
 * during render. This is a callback handle, not a mirror of machine state.
 */

type PracticeCommandExecutorDependencies = {
  boundRef: { current: PracticeHostBindings };
  online: boolean;
  dispatch: (event: PracticeEvent) => void;
  clearDrainRetry: () => void;
  scheduleDrainRetry: () => void;
  convex: ReturnType<typeof useConvex>;
  submit: ReturnType<typeof useMutation<typeof api.practiceSkills.submitAnswer>>;
  serveHintStep: ReturnType<typeof useMutation<typeof api.practiceSkills.serveHintStep>>;
  recordLifecycle: ReturnType<
    typeof useMutation<typeof api.practiceSkills.recordBreakerRecoveryLifecycle>
  >;
  recordOutcome: ReturnType<
    typeof useMutation<typeof api.practiceSkills.recordBreakerOutcome>
  >;
  completeTuneup: ReturnType<typeof useMutation<typeof api.practiceTuneups.complete>>;
};

type SubmitAnswerArgs = Parameters<PracticeCommandExecutorDependencies["submit"]>[0];
type SubmitAnswerResult = Awaited<
  ReturnType<PracticeCommandExecutorDependencies["submit"]>
>;

function canOpenBreaker(
  entry: Pick<
    OutboxAnswer,
    | "record"
    | "suppressBreaker"
    | "breakerTriggerAttemptId"
    | "breakerEasyTriggerAttemptId"
  >,
): boolean {
  return (
    entry.record &&
    entry.suppressBreaker !== true &&
    entry.breakerTriggerAttemptId === undefined &&
    entry.breakerEasyTriggerAttemptId === undefined
  );
}

function triggerAttemptDisposition(
  result: SubmitAnswerResult,
): string | null | undefined {
  if (!result.backOff || result.backOff.reattached) return null;
  return result.breakerRecovery?.triggerAttemptId
    ? String(result.breakerRecovery.triggerAttemptId)
    : undefined;
}

/** Executes committed commands outside React's render/compiler scope. */
async function executePracticeCommand(
  command: PracticeCommand,
  dependencies: PracticeCommandExecutorDependencies,
): Promise<void> {
  const {
    boundRef,
    clearDrainRetry,
    completeTuneup,
    convex,
    dispatch,
    online,
    recordLifecycle,
    recordOutcome,
    scheduleDrainRetry,
    serveHintStep,
    submit,
  } = dependencies;
  const host = boundRef.current;
  const sid = host.scholarId;
  if (!sid) return;
  const persistBreakerLifecycle = async (
    operation: BreakerLifecycleOperation,
    id: string,
    triggerAttemptId: string,
  ) => {
    const outcome = await retryBreakerLifecycleWrite({
      operation,
      write: () =>
        withPracticeSubmitTimeout(
          recordLifecycle({
            scholarId: sid,
            triggerAttemptId:
              triggerAttemptId as Id<"practiceAttempts">,
            event: breakerLifecycleEvent(operation),
          }),
        ),
    });
    if (outcome.status === "recorded") {
      dispatch({ type: "server:lifecycleRecorded", id });
    } else {
      console.error(
        "practice breaker lifecycle remains pending:",
        outcome.error,
      );
      dispatch({ type: "server:lifecycleFailed", id });
    }
  };
  const submitOutboxEntry = async (args: OutboxSubmitArgs) => {
    const submissionArgs: SubmitAnswerArgs = {
      scholarId: sid,
      itemId: args.itemId,
      answer: args.answer,
      clientEventId: args.clientEventId,
      record: args.record,
      replay: args.replay,
      ...(args.predictedConfidence !== undefined
        ? {
            predictedConfidence:
              args.predictedConfidence as SubmitAnswerArgs["predictedConfidence"],
          }
        : {}),
      ...(args.breakerTriggerAttemptId !== undefined
        ? {
            breakerTriggerAttemptId:
              args.breakerTriggerAttemptId as Id<"practiceAttempts">,
          }
        : {}),
      ...(args.breakerEasyTriggerAttemptId !== undefined
        ? {
            breakerEasyTriggerAttemptId:
              args.breakerEasyTriggerAttemptId as Id<"practiceAttempts">,
          }
        : {}),
      ...(args.suppressBreaker !== undefined
        ? { suppressBreaker: args.suppressBreaker }
        : {}),
      ...(args.prepareBreakerRepair !== undefined
        ? { prepareBreakerRepair: args.prepareBreakerRepair }
        : {}),
      ...(args.dontKnow !== undefined ? { dontKnow: args.dontKnow } : {}),
      ...(args.latencyMs !== undefined ? { firstKeyMs: args.latencyMs } : {}),
      ...(args.thinkTimeMs !== undefined ? { elapsedMs: args.thinkTimeMs } : {}),
    };
    const result = await withPracticeSubmitTimeout(submit(submissionArgs));
    if (canOpenBreaker(args)) {
      const triggerAttemptId = triggerAttemptDisposition(result);
      if (triggerAttemptId !== undefined) {
        const settled = await settleBreakerTriggerItemSubmission(
          nativePracticePersistenceAdapter,
          String(sid),
          {
            clientEventId: args.clientEventId,
            triggerAttemptId,
          },
        );
        if (!settled.ok) {
          console.error(
            "practice breaker trigger-item receipt reconciliation failed:",
            settled.error,
          );
        }
      }
    }
    return result;
  };

  switch (command.kind) {
    case "loadRun": {
      try {
        const loaded = await host.loadRun(
          command.inputKey,
          command.forceFresh,
        );
        dispatch({
          type: "run:loaded",
          id: command.id,
          itemCount: loaded.itemCount,
          itemId: loaded.itemId,
          scopeKey: loaded.scopeKey,
          dayKey: loaded.dayKey,
          ...(loaded.allMapping !== undefined
            ? { allMapping: loaded.allMapping }
            : {}),
          ...(loaded.tuneupId !== undefined
            ? { tuneupId: loaded.tuneupId }
            : {}),
        });
        if (loaded.resume) {
          dispatch({
            type: "hydrate:resume",
            ...loaded.resume,
          });
        }
        if (loaded.discardResume) {
          dispatch({
            type: "persist:discardResume",
            reason: "invalid",
          });
        }
      } catch (error) {
        host.onLoadError(error);
        dispatch({ type: "run:loadFailed", id: command.id });
      }
      return;
    }

    case "submitAnswer": {
      host.onSubmitError(null);
      const submissionReplay =
        command.entry.submissionReplay ?? !online;
      if (canOpenBreaker(command.entry)) {
        const item = host.getTriggerItemPayload(command.entry.itemId);
        if (item === null) {
          const error = new Error(
            "The trigger-eligible practice item payload is unavailable",
          );
          console.error("practice breaker trigger-item staging failed:", error);
          host.onTriggerItemPersistenceError(error);
          dispatch({
            type: "server:submitFailed",
            id: command.id,
            submissionReplay,
          });
          return;
        }
        const staged = await stageBreakerTriggerItemPayload(
          nativePracticePersistenceAdapter,
          String(sid),
          {
            clientEventId: command.entry.clientEventId,
            itemId: command.entry.itemId,
            item,
          },
        );
        if (!staged.ok) {
          console.error(
            "practice breaker trigger-item staging failed:",
            staged.error,
          );
          host.onTriggerItemPersistenceError(staged.error);
          dispatch({
            type: "server:submitFailed",
            id: command.id,
            submissionReplay,
          });
          return;
        }
      }
      if (!online) {
        const queued = await enqueueOutboxAnswer(
          nativePracticePersistenceAdapter,
          String(sid),
          { ...command.entry, submissionReplay },
        );
        if (queued) {
          host.onQueuedCount(queued.length);
          host.onAnswerQueued?.(command.entry, queued.length);
          scheduleDrainRetry();
          dispatch({
            type: "server:submitQueued",
            id: command.id,
            queuedCount: queued.length,
          });
        } else {
          host.onSubmitError(
            "That answer couldn't be saved. Try again before moving on.",
          );
          dispatch({
            type: "server:submitFailed",
            id: command.id,
            submissionReplay,
          });
        }
        return;
      }
      // Always through the barrier: a live answer must never overtake an
      // older queued one, and an ambiguous failure queues under the SAME
      // receipt so the replay is a server-side no-op.
      const outcome = await submitWithOutboxBarrier({
        adapter: nativePracticePersistenceAdapter,
        scholarId: String(sid),
        entry: command.entry,
        submit: submitOutboxEntry,
      });
      if (outcome.status === "submitted") {
        const res = outcome.result as {
          correct: boolean;
          backOff?: {
            missStreak: number;
          };
          breakerRecovery?: {
            triggerAttemptId: string;
            triggerNodeKey: string;
            domain: string;
            initialRepair?: {
              rung: null | {
                kind: "completion" | "reveal";
                stepIndex: number;
              };
              hasMore: boolean;
            };
          };
          breakerRecoveryVerified?: boolean;
          dispatchCompleted?: unknown;
        };
        host.onGrade(res, command.entry);
        host.onDispatchCompleted(res.dispatchCompleted);
        const recovery = res.breakerRecovery;
        const initialRepair = recovery?.initialRepair;
        if (initialRepair?.rung) {
          host.onHintRung(initialRepair, "breaker");
        }
        dispatch({
          type: "server:submitSucceeded",
          id: command.id,
          result: {
            correct: res.correct,
            ...(res.backOff
              ? {
                  backOff: {
                    triggerAttemptId:
                      recovery?.triggerAttemptId ??
                      `legacy:${command.entry.itemId}`,
                    triggerNodeKey: recovery?.triggerNodeKey ?? "",
                    domain: recovery?.domain ?? "",
                    missStreak: res.backOff.missStreak,
                    recoveryAvailable: recovery !== undefined,
                    initialRepairStatus:
                      initialRepair === undefined
                        ? "opening"
                        : initialRepair.rung === null
                          ? "unavailable"
                          : initialRepair.rung.kind === "reveal"
                            ? "done"
                            : "open",
                    repairStepIndex:
                      initialRepair?.rung?.stepIndex ?? null,
                  },
                }
              : {}),
            ...(res.breakerRecoveryVerified !== undefined
              ? { breakerRecoveryVerified: res.breakerRecoveryVerified }
              : {}),
          },
        });
      } else if (outcome.status === "queued") {
        host.onQueuedCount(outcome.count);
        host.onAnswerQueued?.(command.entry, outcome.count);
        scheduleDrainRetry();
        dispatch({
          type: "server:submitQueued",
          id: command.id,
          queuedCount: outcome.count,
        });
      } else {
        // Storage itself failed: nothing was submitted and nothing durably
        // queued, so the scholar must not advance past this answer.
        host.onSubmitError(
          "That answer couldn't be saved. Try again before moving on.",
        );
        dispatch({
          type: "server:submitFailed",
          id: command.id,
          submissionReplay,
        });
      }
      return;
    }

    case "drainOutbox": {
      const outcome = await drainOutbox({
        adapter: nativePracticePersistenceAdapter,
        scholarId: String(sid),
        submit: submitOutboxEntry,
        isCancelled: () => false,
        onRemaining: host.onQueuedCount,
        onSubmitted: (res) =>
          host.onDispatchCompleted(
            (res as { dispatchCompleted?: unknown }).dispatchCompleted,
          ),
      });
      // A drain that genuinely finished needs no more retries; one that
      // stopped early (something is still queued) schedules the next
      // bounded attempt rather than waiting indefinitely for the next
      // mount or connectivity transition.
      if (outcome.status === "drained") {
        clearDrainRetry();
      } else if (outcome.status === "blocked" || outcome.status === "unreadable") {
        scheduleDrainRetry();
      }
      // Its own channel: a replayed historical answer is never this item's
      // grade.
      dispatch({
        type: "persist:drainSettled",
        id: command.id,
        outcome:
          outcome.status === "drained"
            ? "drained"
            : outcome.status === "unreadable"
              ? "unreadable"
              : "blocked",
      });
      return;
    }

    case "saveResume": {
      const snapshot = host.buildResumeSnapshot(command.resumeIdx);
      if (!snapshot) return;
      const outcome = await saveResumeSnapshot(
        nativePracticePersistenceAdapter,
        String(sid),
        snapshot,
      );
      if (outcome.ok) {
        dispatch({
          type: "persist:resumeSaved",
          id: command.id,
          version: command.version,
        });
      } else {
        // Honest failure: a caller must never claim a run is resumable off
        // a write that didn't land (Safari private mode, a full quota).
        dispatch({ type: "persist:resumeFailed", id: command.id });
      }
      return;
    }

    case "clearResume": {
      await clearResumeSnapshot(nativePracticePersistenceAdapter, String(sid));
      return;
    }

    case "serveHintRung": {
      try {
        const served = await withPracticeSubmitTimeout(
          serveHintStep({
            scholarId: sid,
            itemId: command.itemId,
            stepIndex: command.stepIndex,
          }),
        );
        if (!served.rung) {
          dispatch({ type: "server:hintUnavailable", id: command.id });
          return;
        }
        host.onHintRung(served, command.source);
        dispatch({
          type: "server:hintServed",
          id: command.id,
          stepIndex: served.rung.stepIndex,
          hasMore: served.hasMore,
          rungKind: served.rung.kind,
        });
      } catch {
        // Includes the "hint steps must be opened in order" guard. No rung
        // here is an ordinary breaker outcome, but a scholar-pulled ladder
        // stays retryable and names the transport failure.
        if (command.source === "ladder") {
          host.onHintError("That next step couldn’t load — try again.");
          dispatch({ type: "server:commandFailed", id: command.id });
        } else {
          dispatch({ type: "server:hintUnavailable", id: command.id });
        }
      }
      return;
    }

    case "recordBreakerLifecycle": {
      await persistBreakerLifecycle(
        command.operation,
        command.id,
        command.triggerAttemptId,
      );
      return;
    }

    case "serveBreakerFresh": {
      try {
        const res = await convex.mutation(
          api.practiceSkills.breakerRecoverySession,
          {
            scholarId: sid,
            triggerAttemptId:
              command.triggerAttemptId as Id<"practiceAttempts">,
            seed: Math.floor(Math.random() * 2_000_000_000),
          },
        );
        const item = (res.items as { itemId: string }[])[0];
        if (!item) {
          dispatch({ type: "server:breakerFreshUnavailable", id: command.id });
          return;
        }
        host.onBreakerItem(item, "fresh");
        dispatch({
          type: "server:breakerFreshServed",
          id: command.id,
          itemId: item.itemId,
        });
      } catch (error) {
        console.error("practice breaker fresh item failed:", error);
        dispatch({ type: "server:breakerFreshUnavailable", id: command.id });
      }
      return;
    }

    case "serveBreakerEasy": {
      try {
        const res = await convex.mutation(
          api.practiceSkills.breakerEasyFinishSession,
          {
            scholarId: sid,
            triggerAttemptId:
              command.triggerAttemptId as Id<"practiceAttempts">,
            seed: Math.floor(Math.random() * 2_000_000_000),
          },
        );
        if (!res.available) {
          dispatch({ type: "server:breakerEasyUnavailable", id: command.id });
          return;
        }
        const item = (res.items as { itemId: string }[])[0];
        if (!item) {
          throw new Error("Easy finish response omitted its item");
        }
        if (!breakerEasyItemMatchesCommand(command, item.itemId)) {
          console.error(
            `practice breaker easy item mismatch: expected ${command.expectedItemId}, received ${item.itemId}`,
          );
          return;
        }
        host.onBreakerItem(item, "easy");
        dispatch({
          type: "server:breakerEasyServed",
          id: command.id,
          itemId: item.itemId,
        });
      } catch (error) {
        console.error("practice breaker easy finish failed:", error);
        host.onHintError("That easy finish couldn’t load — try again.");
        dispatch({ type: "server:commandFailed", id: command.id });
      }
      return;
    }

    case "launchCoach": {
      host.onCoach();
      // Opening the lane is a UI fact, not a telemetry acknowledgement. Let
      // the scholar enter it immediately while the same command retains its
      // breaker ordering domain until the lifecycle write settles.
      dispatch({ type: "server:coachOpened", id: command.id });
      await persistBreakerLifecycle(
        "coachEscalated",
        command.id,
        command.triggerAttemptId,
      );
      return;
    }

    case "recordBreakerOutcome": {
      try {
        await recordOutcome({
          scholarId: sid,
          itemId: command.triggerItemId,
          streak: command.missStreak,
          offer: breakerLegacyOffer(command.flow),
          recovery: breakerLegacyRecovery(command.flow),
        });
      } catch (error) {
        console.error("practice breaker outcome failed:", error);
      }
      return;
    }

    case "completeTuneup": {
      try {
        await completeTuneup({
          tuneupId: command.tuneupId as Id<"practiceTuneups">,
          correctCount: command.correctCount,
        });
      } catch (error) {
        console.error("practice tuneup completion failed:", error);
      }
      return;
    }

    case "haptic":
      host.onHaptic?.(command.style);
      return;

    case "openHandoff":
      host.onHandoff(command.entryMode);
      return;

    case "gradeLocally": {
      // Feed the verdict back through the SAME reducer path a live grade
      // uses (`local:graded`), so rehearse never grows a second, split
      // copy of "was this item answered" living only in the host.
      if (!host.gradeLocally) {
        dispatch({ type: "server:commandFailed", id: command.id });
        return;
      }
      const result = await host.gradeLocally(command.entry);
      const correct =
        typeof result === "object" &&
        result !== null &&
        "correct" in result &&
        (result as { correct: unknown }).correct === true;
      host.onGrade(result, command.entry);
      dispatch({ type: "local:graded", id: command.id, correct });
      return;
    }

    default:
      return;
  }
}

export function usePracticeMachine(
  initial: PracticeState,
  scholarId: Id<"users"> | null,
  host: { current: PracticeHostBindings },
  options: { online: boolean },
): PracticeMachineHandle {
  const convex = useConvex();
  const submit = useMutation(api.practiceSkills.submitAnswer);
  const serveHintStep = useMutation(api.practiceSkills.serveHintStep);
  const recordLifecycle = useMutation(
    api.practiceSkills.recordBreakerRecoveryLifecycle,
  );
  const recordOutcome = useMutation(api.practiceSkills.recordBreakerOutcome);
  const completeTuneup = useMutation(api.practiceTuneups.complete);

  // Commands live in reducer state, not a ref mutated from inside the reducer.
  // That keeps the reducer pure under Strict Mode while still guaranteeing a
  // command executes only after its state transition commits.
  const [hostState, rawDispatch] = useReducer(
    (current: MachineHostState, action: MachineHostAction): MachineHostState => {
      if (action.type === "batchFinished") {
        return {
          ...current,
          batches: current.batches.filter(
            (batch) => batch.sequence !== action.sequence,
          ),
        };
      }
      const step = practiceReduce(current.machine, action.event);
      if (step.state === current.machine && step.commands.length === 0) {
        return current;
      }
      if (step.commands.length === 0) {
        return { ...current, machine: step.state };
      }
      const batch: CommandBatch = {
        sequence: current.nextSequence,
        commands: step.commands,
      };
      return {
        machine: step.state,
        batches: [...current.batches, batch],
        nextSequence: current.nextSequence + 1,
      };
    },
    {
      machine: initial,
      batches: [],
      nextSequence: 1,
    },
  );

  const boundRef = host;
  const state = hostState.machine;
  const onlineAtMountRef = useRef(options.online);
  const coordinator = useMemo(
    () => (scholarId ? acquirePracticeCoordinator(String(scholarId)) : null),
    [scholarId],
  );

  useEffect(() => {
    if (!scholarId) return;
    return () => releasePracticeCoordinator(String(scholarId));
  }, [scholarId]);

  const dispatch = useCallback((event: PracticeEvent) => {
    rawDispatch({ type: "event", event });
  }, []);

  // Native-only bounded retry for the outbox drain. Native has no browser
  // `online` event pairing with the WebSocket the way web's `isOffline`
  // combines `navigator.onLine` + Convex connection state (useConvexOnline is
  // the WHOLE signal here) — so a drain that stops early with something still
  // queued (a "blocked"/"unreadable" outcome) would otherwise sit unretried
  // until the next `env:mounted`/`env:online` transition, which may never come
  // if the app never actually goes offline (e.g. one transient server error
  // while the socket stayed up). This schedules the SAME retry the old
  // `queuedFeedbackCanAdvance`-adjacent code did informally, using the pure
  // vendored backoff helper — 1s, doubling, capped at 30s — as an EXECUTOR
  // internal: a timer + a failure count in a ref, never canonical machine
  // state, and never a stringly re-derivation of "can this advance".
  const drainRetryRef = useRef<{
    failureCount: number;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ failureCount: 0, timer: null });
  const scheduleDrainRetry = useCallback(() => {
    if (!options.online) return;
    const retry = drainRetryRef.current;
    if (retry.timer) clearTimeout(retry.timer);
    retry.failureCount += 1;
    const delay = outboxRetryDelayMs(retry.failureCount);
    retry.timer = setTimeout(() => {
      retry.timer = null;
      dispatch({ type: "env:online" });
    }, delay);
  }, [dispatch, options.online]);
  const clearDrainRetry = useCallback(() => {
    const retry = drainRetryRef.current;
    if (retry.timer) clearTimeout(retry.timer);
    retry.timer = null;
    retry.failureCount = 0;
  }, []);
  useEffect(() => {
    const retry = drainRetryRef.current;
    return () => {
      if (retry.timer) clearTimeout(retry.timer);
    };
  }, []);
  useEffect(() => {
    if (options.online) return;
    const retry = drainRetryRef.current;
    if (retry.timer) clearTimeout(retry.timer);
    retry.timer = null;
  }, [options.online]);
  const previousOnlineRef = useRef(options.online);

  useEffect(() => {
    if (!scholarId || state.mode !== "live") return;
    let cancelled = false;
    void loadOutbox(nativePracticePersistenceAdapter, String(scholarId))
      .then((queued) => {
        if (cancelled) return;
        boundRef.current.onQueuedCount(queued.length);
        dispatch({
          type: "env:mounted",
          queuedCount: queued.length,
          online: onlineAtMountRef.current,
        });
      })
      .catch((error) => {
        console.error("practice outbox could not be read:", error);
        if (!cancelled) {
          dispatch({
            type: "persist:drainSettled",
            id: `drain:${String(scholarId)}`,
            outcome: "unreadable",
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // Mount/scholar lifecycle only. Connectivity has its own typed event below.
  }, [boundRef, dispatch, scholarId, state.mode]);

  useEffect(() => {
    const wasOnline = previousOnlineRef.current;
    previousOnlineRef.current = options.online;
    if (
      !scholarId ||
      state.mode !== "live" ||
      !options.online ||
      wasOnline
    ) {
      return;
    }
    clearDrainRetry();
    dispatch({ type: "env:online" });
  }, [clearDrainRetry, dispatch, options.online, scholarId, state.mode]);

  const run = useCallback(
    (command: PracticeCommand) =>
      executePracticeCommand(command, {
        boundRef,
        online: options.online,
        dispatch,
        clearDrainRetry,
        scheduleDrainRetry,
        convex,
        submit,
        serveHintStep,
        recordLifecycle,
        recordOutcome,
        completeTuneup,
      }),
    [
      boundRef,
      clearDrainRetry,
      completeTuneup,
      convex,
      dispatch,
      options.online,
      recordLifecycle,
      recordOutcome,
      scheduleDrainRetry,
      serveHintStep,
      submit,
    ],
  );

  const processingBatch = useRef<number | null>(null);
  const nextBatch = hostState.batches[0];

  // Drain one committed reducer batch at a time. `processingBatch` is an
  // imperative effect handle (not state mirroring): it closes Strict Mode's
  // setup/cleanup/setup window without participating in rendering.
  useEffect(() => {
    if (!coordinator || !nextBatch) return;
    if (processingBatch.current !== null) return;
    processingBatch.current = nextBatch.sequence;
    const runSafely = async (command: PracticeCommand) => {
      try {
        await run(command);
      } catch (error) {
        console.error(`practice command ${command.kind} failed:`, error);
        dispatch({
          type:
            command.kind === "recordBreakerLifecycle" ||
            command.kind === "launchCoach"
              ? "server:lifecycleFailed"
              : "server:commandFailed",
          id: command.id,
        });
      }
    };
    void coordinator
      .executeAll(nextBatch.commands, runSafely)
      .then(async (refused) => {
        for (const id of refused) {
          const command = nextBatch.commands.find(
            (candidate) => candidate.id === id,
          );
          if (!command) continue;
          const replayForCurrentMount =
            isDurableCommand(command) ||
            command.kind === "loadRun" ||
            command.kind === "openHandoff" ||
            command.kind === "gradeLocally";
          if (!replayForCurrentMount) {
            dispatch({ type: "server:commandFailed", id });
            continue;
          }
          // A prior mount owns the first execution, but its result dispatch
          // targets that prior reducer. Wait for it, then replay this idempotent
          // command so the current mount receives its own typed result.
          do {
            await coordinator.waitForRelease(id);
          } while (!(await coordinator.execute(command, runSafely)));
        }
      })
      .catch((error) => {
        // Individual runners are caught above; this is coordinator failure.
        console.error("practice command coordinator failed:", error);
      })
      .finally(() => {
        processingBatch.current = null;
        rawDispatch({
          type: "batchFinished",
          sequence: nextBatch.sequence,
        });
      });
  }, [coordinator, dispatch, nextBatch, run]);

  return { state, send: dispatch, coordinator };
}
