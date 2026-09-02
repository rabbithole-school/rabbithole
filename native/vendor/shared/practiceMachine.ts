/**
 * The practice run's orchestration, as one pure command-emitting state machine
 * shared by web and native.
 *
 * WHY THIS EXISTS. The two run screens (components/practice/PracticeSession.tsx
 * and native/src/app/practice.tsx) are ~6,000 lines each and drive the SAME
 * breaker sequence with two separately-maintained copies of the same machinery:
 * a ref mirroring `breaker` so async callbacks can read it, six one-shot latch
 * refs, a hand-rolled promise chain serializing lifecycle writes, and three
 * `queueMicrotask` effects chaining repair → coach → fresh. The sequence itself
 * was already shared (`advanceBreakerFlow`); everything that DROVE it was
 * forked, and the copies had drifted. This file is the driver, shared.
 *
 * WHAT IT OWNS. Ephemeral run state only: which item is on screen, what phase
 * that item is in, breaker presentation, hint attachment, and WHEN to persist.
 * The server remains authoritative for everything consequential — serving
 * eligibility, item identity, grading, scheduler/mastery/placement, breaker
 * activation and issuance, terminal status. The machine never grades and never
 * decides recovery; it asks, and applies what comes back.
 *
 * WHAT IT EMITS. A reducer step returns the next state AND an explicit list of
 * commands. Nothing here performs I/O, reads a clock, or generates randomness,
 * so a whole session is reproducible from an event list. The host executes
 * commands and dispatches typed results back.
 *
 * TWO LAYERS OF COMMAND IDENTITY — the distinction the rest of this file
 * depends on:
 *
 *   Layer A, semantic identity (survives a reload). A command's id is derived
 *   from a durable or server-authoritative fact — `clientEventId` for a submit,
 *   the trigger attempt for a breaker operation, item+rung for a hint. After a
 *   process restart the same logical command re-derives to the same id, so a
 *   replay is a no-op server-side rather than a duplicate.
 *
 *   Layer B, in-process exclusivity (deliberately transient). The HOST owns a
 *   synchronous `tryClaim(id)` registry that gates side effects. That, not this
 *   reducer, is what stops React Strict Mode's double effect invocation from
 *   executing one command twice: an async dispatch cannot be a lock, because
 *   both invocations can observe "not started" before either commits.
 *
 * This reducer therefore tracks command progress for RENDERING and for
 * REJECTING STALE RESULTS — never as a mutual-exclusion primitive. See
 * `isAwaiting`.
 *
 * Imports nothing but its own siblings, so it vendors into the native bundle
 * byte-identically (native/scripts/sync-vendor.js) and is enforced by
 * practiceMachineImports.test.ts.
 */

import {
  advanceBreakerFlow,
  breakerFreshReconstructable,
  newBreakerFlow,
  type BreakerFlow,
  type BreakerRepairStatus,
} from "./practiceLoop";
import type { BreakerLifecycleOperation } from "./practiceLifecycleRetry";
import type { OutboxAnswer } from "./practiceOutboxContract";

// ─── Identity ────────────────────────────────────────────────────────────

/** A command's identity. Semantic wherever the command is durable, so it
 *  re-derives to the same value after a reload; only genuinely ephemeral
 *  commands (haptics, navigation) carry a per-run counter, and those are
 *  intentionally never replayed after process death. */
export type CommandId = string;

export const submitCommandId = (clientEventId: string): CommandId =>
  `submit:${clientEventId}`;
export const drainCommandId = (scholarId: string): CommandId => `drain:${scholarId}`;
/** Includes the version: two snapshots for the same scholar are DIFFERENT
 *  commands. Sharing one id would make the coordinator refuse the newer one
 *  while the older was still writing, leaving the stale position on disk.
 *  Still reload-stable in the sense that matters — a save is never replayed
 *  after a reload; the snapshot itself is the durable artifact. */
export const resumeSaveCommandId = (scholarId: string, version: number): CommandId =>
  `resume-save:${scholarId}:${version}`;
export const resumeClearCommandId = (scholarId: string): CommandId =>
  `resume-clear:${scholarId}`;
export const hintCommandId = (itemId: string, stepIndex: number): CommandId =>
  `hint:${itemId}:${stepIndex}`;
export const breakerCommandId = (
  triggerAttemptId: string,
  operation: BreakerOperation,
): CommandId => `breaker:${triggerAttemptId}:${operation}`;
export const tuneupCommandId = (tuneupId: string): CommandId =>
  `tuneup:${tuneupId}:complete`;

export type BreakerOperation =
  | "repairServe"
  | "repairRestore"
  | "repairShown"
  | "repairUnavailable"
  | "repairStarted"
  | "repairCompleted"
  | "coachEscalated"
  | "fresh"
  | "easy"
  | "stopped"
  | "outcome";

// ─── Commands ────────────────────────────────────────────────────────────

/**
 * An ordering domain. The host runs at most one command per domain at a time,
 * in emission order, using the same keyed mutex the outbox uses. Ephemeral
 * commands declare no domain: they are independent, deduplicated by id, and
 * executed immediately.
 */
export type CommandDomain = string;

export const outboxDomain = (scholarId: string): CommandDomain => `outbox:${scholarId}`;
export const resumeDomain = (scholarId: string): CommandDomain => `resume:${scholarId}`;
export const hintDomain = (itemId: string): CommandDomain => `hint:${itemId}`;
/** Lifecycle records AND fresh/easy issuance share one domain on purpose: the
 *  server refuses a recovery session until the lifecycle has recorded support,
 *  so issuance must never overtake the write that authorizes it. The old code
 *  expressed this as a lone `await` on a promise-chain ref; here it is a
 *  declared constraint the host cannot forget to honor. */
export const breakerDomain = (triggerAttemptId: string): CommandDomain =>
  `breaker-lifecycle:${triggerAttemptId}`;

export type PracticeCommand =
  /** Ephemeral host read. The machine decides when a payload may replace the
   *  current run; the host owns the item-shaped query/restore result. */
  | {
      kind: "loadRun";
      id: CommandId;
      inputKey: string;
      forceFresh: boolean;
    }
  /** Durable. Routed through the outbox barrier so it can never overtake an
   *  older queued answer; idempotent server-side via `clientEventId`. */
  | {
      kind: "submitAnswer";
      id: CommandId;
      domain: CommandDomain;
      entry: OutboxAnswer;
    }
  /** Durable. Replays queued answers in order. */
  | { kind: "drainOutbox"; id: CommandId; domain: CommandDomain }
  /** Durable. `version` makes a late write lose to a newer one. */
  | {
      kind: "saveResume";
      id: CommandId;
      domain: CommandDomain;
      version: number;
      resumeIdx: number;
    }
  | { kind: "clearResume"; id: CommandId; domain: CommandDomain; reason: ResumeClearReason }
  /** Durable-ish: re-serving an already-served rung is idempotent server-side
   *  and does not advance the ladder, which is what makes resume safe. */
  | {
      kind: "serveHintRung";
      id: CommandId;
      domain: CommandDomain;
      itemId: string;
      stepIndex: number;
      source: "ladder" | "breaker" | "breakerRestore";
    }
  | {
      kind: "recordBreakerLifecycle";
      id: CommandId;
      domain: CommandDomain;
      triggerAttemptId: string;
      operation: BreakerLifecycleOperation;
    }
  | {
      kind: "serveBreakerFresh";
      id: CommandId;
      domain: CommandDomain;
      triggerAttemptId: string;
    }
  | {
      kind: "serveBreakerEasy";
      id: CommandId;
      domain: CommandDomain;
      triggerAttemptId: string;
      /** A server-pinned item reconstructed after relaunch. Null for first issue. */
      expectedItemId: string | null;
    }
  /** Replayable host transition. It opens the coach, then keeps this lifecycle
   * queue entry pending until `coachEscalated` is durable. */
  | { kind: "launchCoach"; id: CommandId; domain: CommandDomain; triggerAttemptId: string }
  /** Durable, but with NO durable client-side intent: after a reload this
   *  relies on the server's idempotent `complete` plus a re-derived terminal
   *  state. Deliberately in-process retry only. */
  | { kind: "completeTuneup"; id: CommandId; tuneupId: string; correctCount: number }
  /** Legacy staff telemetry (stuck alerts / end-of-day). Monotonic server-side,
   *  so a retry is safe; emitted once when the episode reaches its close. */
  | {
      kind: "recordBreakerOutcome";
      id: CommandId;
      domain: CommandDomain;
      triggerAttemptId: string;
      triggerItemId: string;
      missStreak: number;
      flow: BreakerFlow;
    }
  /** Ephemeral. No domain, deduplicated by id, never replayed after a reload —
   *  a haptic that missed its moment must not fire on relaunch. */
  | { kind: "haptic"; id: CommandId; style: "success" | "warning" }
  | { kind: "scrollToEnd"; id: CommandId }
  | { kind: "openHandoff"; id: CommandId; entryMode: "ladder" | "spiral" }
  /** Rehearse only: a staff member drives the drill with an injected grader and
   *  the machine emits NO durable command at all. */
  | { kind: "gradeLocally"; id: CommandId; entry: OutboxAnswer };

export type ResumeClearReason =
  | "fresh-serve"
  | "breaker-started"
  | "run-complete"
  | "run-exhausted"
  | "invalid";

/** Commands that reach the network or durable storage. In rehearse mode the
 *  reducer must never emit one of these; `assertNoDurableCommands` in the tests
 *  asserts that as a property over every vector rather than trusting a scatter
 *  of early returns the way the old components did. */
export const DURABLE_COMMAND_KINDS = [
  "submitAnswer",
  "drainOutbox",
  "saveResume",
  "clearResume",
  "serveHintRung",
  "recordBreakerLifecycle",
  "serveBreakerFresh",
  "serveBreakerEasy",
  "launchCoach",
  "completeTuneup",
  "recordBreakerOutcome",
] as const;

export function isDurableCommand(command: PracticeCommand): boolean {
  return (DURABLE_COMMAND_KINDS as readonly string[]).includes(command.kind);
}

export function breakerEasyItemMatchesCommand(
  command: Extract<PracticeCommand, { kind: "serveBreakerEasy" }>,
  itemId: string,
): boolean {
  return command.expectedItemId === null || command.expectedItemId === itemId;
}

// ─── State ───────────────────────────────────────────────────────────────

export type RunMode = "live" | "rehearse";

/** Lanes that keep their existing UI for now. While one is active the machine
 *  is SUSPENDED, not absent: it still owns items/idx/log and the continuation,
 *  and the lane returns through a typed event instead of writing run state. */
export type Lane =
  | "mapping"
  | "handoff"
  | "dialogue"
  | "teachingStep"
  | "beat"
  | "offers";

/** What the item on screen is doing. This is the cluster the old components
 *  spread across `phase`, `busy`, `submitInFlightRef`, `hasRecorded`, `result`
 *  and `missCount` — correlated fields that only made sense in certain
 *  combinations and had no single owner. */
export type ItemPhase =
  | { kind: "answering" }
  | { kind: "submitting"; commandId: CommandId }
  /** Graded. The verdict itself lives in host state (it is render data); the
   *  machine only needs to know a grade arrived. */
  | { kind: "feedback"; correct: boolean }
  /** Durably queued, NO grade claimed. The scholar may advance — an offline
   *  answer must not trap them on the item — but nothing pretends it was
   *  marked. */
  | { kind: "queued"; queuedCount: number }
  | { kind: "retry"; missCount: number };

export type ItemState = {
  itemId: string | null;
  phase: ItemPhase;
  /** Whether THIS item has already been recorded to mastery. With `idx` this is
   *  the resume position: the first un-recorded index. */
  hasRecorded: boolean;
  missCount: number;
  /** The receipt for the in-flight or last-attempted answer. Held in state
   *  rather than a ref so it survives a re-render and is directly assertable —
   *  the old `answerEventRef` was invisible to tests. */
  clientEventId: string | null;
  /** The fingerprint the receipt belongs to. A caller reuses the receipt only
   *  for an IDENTICAL answer; anything else is a new logical answer and mints a
   *  new one, which is what keeps the server's dedup exact rather than
   *  over-eager. */
  clientEventKey: string | null;
  /** Replay mode used by this receipt's first server attempt. Retained only
   * after a persistence failure so an online/offline retry cannot flip it. */
  clientEventReplay: boolean | null;
  /** Per-item dedup for pulling the coach off an exhausted hint ladder. State,
   *  not a ref: it is a fact about the item, not an imperative handle. */
  ladderCoachPulled: boolean;
};

export type HintState = {
  itemId: string | null;
  open: boolean;
  nextStepIndex: number;
  exhausted: boolean;
  pendingCommandId: CommandId | null;
};

export type BreakerLifecycleCommandState = {
  operation: BreakerLifecycleOperation;
  /** `recoverable` means bounded automatic retries exhausted. The same semantic
   * command remains queued until the scholar explicitly retries or the server
   * projection proves it already landed. */
  status: "queued" | "pending" | "recoverable";
};

export type BreakerState = {
  triggerAttemptId: string;
  /** A v2 trigger attempt can authorize fresh/easy recovery issuance. Older
   *  back-off payloads may still show support but cannot mint those items. */
  recoveryAvailable: boolean;
  triggerItemId: string | null;
  /** Consecutive counted misses that opened the episode. Carried because the
   *  legacy staff-facing outcome row still reports it. */
  missStreak: number;
  triggerNodeKey: string;
  domain: string;
  flow: BreakerFlow;
  /** The server-pinned recovery items, once issued. Reconstructed from the
   *  server's projection on resume — never remembered locally across a reload. */
  freshItemId: string | null;
  easyItemId: string | null;
  /** The rung already served for the trigger item, so a resume re-serves THAT
   *  rung instead of spending a new hint. */
  repairStepIndex: number | null;
  lifecycle: {
    /** Exact server-confirmed evidence for this episode. */
    confirmed: readonly BreakerLifecycleOperation[];
    /** Ordered durable intent. Only the head may be emitted, so later
     * progression can never overtake an unacknowledged lifecycle write. */
    pending: readonly BreakerLifecycleCommandState[];
  };
  /** The easy exit was chosen while a prerequisite lifecycle write was still
   * pending. The intent stays in machine state and is issued once unblocked. */
  easyRequested: boolean;
  /** Commands already emitted for this episode, so a re-entry into the same
   *  state does not emit them twice. Lifecycle retries are the deliberate
   *  exception: their pending entry re-emits the SAME semantic id after an
   *  explicit retry. */
  emitted: readonly CommandId[];
};

export type RunState = {
  itemCount: number;
  idx: number;
  correctCount: number;
  answeredCount: number;
  /** Stamped by the server on the run this state was built from. */
  scopeKey: string | null;
  dayKey: string | null;
  /** Monotonic, so a late snapshot write loses to a newer one. */
  resumeVersion: number;
  tuneupId: string | null;
  suppressBreaker: boolean;
  /** The full host input fingerprint for the payload currently installed. */
  inputKey: string | null;
  /** The one payload read currently in flight. */
  pendingLoad: {
    id: CommandId;
    inputKey: string;
    forceFresh: boolean;
  } | null;
  /** A failed automatic load waits for an explicit retry instead of spinning. */
  failedInputKey: string | null;
  /** Whether the currently-loaded run is an all-mapping ("Math Check-In")
   *  ceremony. While true, a later `run:loaded` for a DIFFERENT payload is
   *  frozen out rather than applied — see the `run:loaded` case below. This
   *  is the one piece of state the old `loadedInputKeyRef` encoded that a
   *  bare key comparison cannot: the freeze must survive an input-key change,
   *  not just dedupe an unchanged one. */
  allMapping: boolean;
};

export type PracticeState = {
  mode: RunMode;
  scholarId: string;
  run: RunState;
  item: ItemState;
  hint: HintState;
  breaker: BreakerState | null;
  lane: Lane | null;
  terminal: boolean;
  /** Counter for EPHEMERAL command ids only. Never the basis for durable
   *  identity: it cannot be re-derived after a reload, which is precisely why
   *  durable commands key off server-meaningful values instead. */
  seq: number;
};

export function newPracticeState(args: {
  scholarId: string;
  itemCount: number;
  mode?: RunMode;
  scopeKey?: string | null;
  dayKey?: string | null;
  tuneupId?: string | null;
  suppressBreaker?: boolean;
  itemId?: string | null;
}): PracticeState {
  return {
    mode: args.mode ?? "live",
    scholarId: args.scholarId,
    run: {
      itemCount: args.itemCount,
      idx: 0,
      correctCount: 0,
      answeredCount: 0,
      scopeKey: args.scopeKey ?? null,
      dayKey: args.dayKey ?? null,
      resumeVersion: 0,
      tuneupId: args.tuneupId ?? null,
      suppressBreaker: args.suppressBreaker ?? false,
      inputKey: null,
      pendingLoad: null,
      failedInputKey: null,
      allMapping: false,
    },
    item: {
      itemId: args.itemId ?? null,
      phase: { kind: "answering" },
      hasRecorded: false,
      missCount: 0,
      clientEventId: null,
      clientEventKey: null,
      clientEventReplay: null,
      ladderCoachPulled: false,
    },
    hint: freshHint(),
    breaker: null,
    lane: null,
    terminal: false,
    seq: 0,
  };
}

// ─── Events ──────────────────────────────────────────────────────────────

/** A graded answer, as the server reported it. */
export type GradeResult = {
  correct: boolean;
  /** Present when the server opened a breaker on this miss. */
  backOff?: {
    triggerAttemptId: string;
    triggerNodeKey: string;
    domain: string;
    missStreak: number;
    recoveryAvailable: boolean;
    initialRepairStatus: BreakerRepairStatus;
    repairStepIndex: number | null;
  };
  /** The server's own verdict on a linked fresh recovery attempt. Client state
   *  alone can never earn recognition. */
  breakerRecoveryVerified?: boolean;
};

export type PracticeEvent =
  // ── the scholar ──
  | {
      type: "ui:submit";
      answer: string;
      clientEventId: string;
      /** Fingerprint of this logical answer, so a retry of the SAME answer can
       *  reuse the receipt. */
      clientEventKey?: string;
      entry: OutboxAnswer;
    }
  | { type: "ui:advance"; nextItemId?: string | null }
  | { type: "ui:retry" }
  | { type: "ui:hintPressed" }
  | { type: "ui:hintLadderPulled" }
  | { type: "ui:breakerRepairStarted" }
  | { type: "ui:breakerEasyFinish" }
  | { type: "ui:breakerCoach" }
  | { type: "ui:breakerRepairCompleted" }
  | { type: "ui:breakerClose" }
  | { type: "ui:retryBreakerLifecycle" }
  // ── the server answering a command ──
  | { type: "server:submitSucceeded"; id: CommandId; result: GradeResult }
  | { type: "server:submitQueued"; id: CommandId; queuedCount: number }
  | {
      type: "server:submitFailed";
      id: CommandId;
      submissionReplay: boolean;
    }
  | {
      type: "server:hintServed";
      id: CommandId;
      stepIndex: number;
      hasMore: boolean;
      rungKind: "completion" | "reveal";
    }
  | { type: "server:hintUnavailable"; id: CommandId }
  | { type: "server:breakerFreshServed"; id: CommandId; itemId: string }
  | { type: "server:breakerFreshUnavailable"; id: CommandId }
  | { type: "server:breakerEasyServed"; id: CommandId; itemId: string }
  | { type: "server:breakerEasyUnavailable"; id: CommandId }
  | { type: "server:coachOpened"; id: CommandId }
  | { type: "server:lifecycleRecorded"; id: CommandId }
  | { type: "server:lifecycleFailed"; id: CommandId }
  | { type: "server:commandFailed"; id: CommandId }
  // ── persistence, on its OWN channel ──
  // Drain results never arrive as `server:submitSucceeded`: a replayed
  // historical answer must never be mistaken for the current item's grade.
  | { type: "persist:drainProgressed"; id: CommandId; remaining: number }
  | { type: "persist:drainSettled"; id: CommandId; outcome: "drained" | "blocked" | "unreadable" }
  | { type: "persist:resumeSaved"; id: CommandId; version: number }
  | { type: "persist:resumeFailed"; id: CommandId }
  | { type: "persist:discardResume"; reason: ResumeClearReason }
  // ── hydration, from the server's projection ──
  | {
      type: "hydrate:breaker";
      episode: {
        triggerAttemptId: string;
        recoveryAvailable?: boolean;
        triggerItemId: string | null;
        triggerNodeKey: string;
        domain: string;
        missStreak: number;
        flow: BreakerFlow;
        repairStepIndex: number | null;
        freshItemId: string | null;
        easyItemId: string | null;
        confirmedLifecycle?: readonly BreakerLifecycleOperation[];
      };
    }
  | { type: "hydrate:resume"; idx: number; hasRecorded: boolean; itemId: string | null }
  | { type: "run:inputsChanged"; inputKey: string }
  | { type: "run:reloadRequested" }
  | { type: "run:itemCountAdjusted"; delta: number }
  // ── the served payload synchronizing the run's position ──
  /** Fired whenever the host serves (or re-renders with) a payload, so the
   *  machine can adopt its `itemCount`/first item without importing the item
   *  shape itself. Idempotent for an unchanged payload (`scopeKey`+`dayKey`
   *  identical) and FROZEN — entirely ignored — while an all-mapping
   *  ceremony is underway, which is the one case a genuinely changed payload
   *  must still not reset the run. Both properties used to live in the
   *  component's opaque `loadedInputKeyRef`; here they are explicit reducer
   *  rules instead. */
  | {
      type: "run:loaded";
      id: CommandId;
      itemCount: number;
      itemId: string | null;
      scopeKey: string;
      dayKey: string;
      allMapping?: boolean;
      tuneupId?: string | null;
    }
  | { type: "run:loadFailed"; id: CommandId }
  // ── rehearsal's local grade, fed back through the SAME reducer path as a
  //    server grade so rehearse never grows split canonical state ──
  | { type: "local:graded"; id: CommandId; correct: boolean }
  // ── lanes returning control (the typed bridge) ──
  | { type: "lane:entered"; lane: Lane }
  | { type: "lane:mappingAnswered"; recorded: boolean; correct: boolean }
  | { type: "lane:mappingRetry"; itemId: string }
  | { type: "lane:batchAppended"; addedCount: number }
  | {
      type: "lane:handoffClosed";
      outcome: "retry-same" | "fresh-variant" | "advance";
      itemId?: string | null;
    }
  | { type: "lane:coachEnded" }
  | { type: "lane:tailAccepted"; itemCount: number; itemId?: string | null }
  | { type: "lane:beatProceeded" }
  | { type: "lane:exited" }
  // ── environment ──
  | { type: "env:online" }
  | { type: "env:mounted"; queuedCount: number; online?: boolean };

export type Transition = { state: PracticeState; commands: PracticeCommand[] };

// ─── Helpers ─────────────────────────────────────────────────────────────

const none = (state: PracticeState): Transition => ({ state, commands: [] });

/**
 * Whether the machine is currently waiting on this exact command. Every
 * `server:*` / `persist:*` handler goes through this, so a late, duplicated, or
 * superseded result is dropped rather than applied to whatever is on screen
 * now. This is stale-result rejection, NOT mutual exclusion — exclusivity is
 * the host's synchronous `tryClaim`, because two Strict-Mode invocations can
 * both observe an un-started command before either dispatch commits.
 */
export function isAwaiting(state: PracticeState, id: CommandId): boolean {
  if (state.item.phase.kind === "submitting" && state.item.phase.commandId === id) {
    return true;
  }
  if (state.hint.pendingCommandId === id) return true;
  if (state.run.pendingLoad?.id === id) return true;
  const breaker = state.breaker;
  if (!breaker) return false;
  if (
    breaker.lifecycle.confirmed.some(
      (operation) =>
        breakerCommandId(breaker.triggerAttemptId, operation) === id,
    )
  ) {
    return false;
  }
  if (
    breaker.lifecycle.pending.some(
      ({ operation }) =>
        breakerCommandId(breaker.triggerAttemptId, operation) === id,
    )
  ) {
    return true;
  }
  return breaker.emitted.includes(id);
}

/** Rehearse emits no durable command, ever. Expressed once, here, instead of
 *  the sixteen scattered early-returns the web component grew. */
function allowDurable(state: PracticeState): boolean {
  return state.mode === "live";
}

function ephemeral(state: PracticeState): { id: CommandId; seq: number } {
  const seq = state.seq + 1;
  return { id: `ui:${seq}`, seq };
}

function markEmitted(breaker: BreakerState, id: CommandId): BreakerState {
  return breaker.emitted.includes(id)
    ? breaker
    : { ...breaker, emitted: [...breaker.emitted, id] };
}

function hasEmitted(breaker: BreakerState | null, id: CommandId): boolean {
  return breaker?.emitted.includes(id) ?? false;
}

function queueBreakerLifecycle(
  breaker: BreakerState,
  operation: BreakerLifecycleOperation,
): BreakerState {
  if (
    breaker.lifecycle.confirmed.includes(operation) ||
    breaker.lifecycle.pending.some(
      (candidate) => candidate.operation === operation,
    )
  ) {
    return breaker;
  }
  return {
    ...breaker,
    lifecycle: {
      ...breaker.lifecycle,
      pending: [
        ...breaker.lifecycle.pending,
        { operation, status: "queued" },
      ],
    },
  };
}

function markLifecycleHeadPending(breaker: BreakerState): BreakerState {
  const [head, ...tail] = breaker.lifecycle.pending;
  if (!head || head.status !== "queued") return breaker;
  return {
    ...breaker,
    lifecycle: {
      ...breaker.lifecycle,
      pending: [{ ...head, status: "pending" }, ...tail],
    },
  };
}

function confirmLifecycleHead(
  breaker: BreakerState,
  id: CommandId,
): { breaker: BreakerState; operation: BreakerLifecycleOperation } | null {
  const [head, ...tail] = breaker.lifecycle.pending;
  if (
    !head ||
    breakerCommandId(breaker.triggerAttemptId, head.operation) !== id
  ) {
    return null;
  }
  return {
    operation: head.operation,
    breaker: {
      ...breaker,
      lifecycle: {
        confirmed: breaker.lifecycle.confirmed.includes(head.operation)
          ? breaker.lifecycle.confirmed
          : [...breaker.lifecycle.confirmed, head.operation],
        pending: tail,
      },
    },
  };
}

function failLifecycleHead(
  breaker: BreakerState,
  id: CommandId,
): BreakerState | null {
  const [head, ...tail] = breaker.lifecycle.pending;
  if (
    !head ||
    head.status !== "pending" ||
    breakerCommandId(breaker.triggerAttemptId, head.operation) !== id
  ) {
    return null;
  }
  return {
    ...breaker,
    lifecycle: {
      ...breaker.lifecycle,
      pending: [{ ...head, status: "recoverable" }, ...tail],
    },
  };
}

function reconcileLifecycleProjection(
  breaker: BreakerState,
  confirmed: readonly BreakerLifecycleOperation[],
): BreakerState {
  if (confirmed.length === 0) return breaker;
  const merged = [
    ...breaker.lifecycle.confirmed,
    ...confirmed.filter(
      (operation) => !breaker.lifecycle.confirmed.includes(operation),
    ),
  ];
  const pending = breaker.lifecycle.pending.filter(
    ({ operation }) => !merged.includes(operation),
  );
  if (
    merged.length === breaker.lifecycle.confirmed.length &&
    pending.length === breaker.lifecycle.pending.length
  ) {
    return breaker;
  }
  return {
    ...breaker,
    lifecycle: {
      confirmed: merged,
      pending,
    },
  };
}

/**
 * The commands a breaker state implies right now, emitted at most once each.
 *
 * This replaces the three `queueMicrotask` effects (and their cancellation
 * guards, and the latch refs that stopped them re-firing) that chained
 * repair → coach → fresh on both surfaces. Because emission is keyed by
 * semantic id, re-entering the same state is a no-op — including after a
 * reload, where the ids re-derive identically.
 */
function breakerCommands(
  state: PracticeState,
): { breaker: BreakerState; commands: PracticeCommand[] } | null {
  const breaker = state.breaker;
  if (!breaker || !allowDurable(state)) return null;
  const commands: PracticeCommand[] = [];
  let next = breaker;
  const domain = breakerDomain(breaker.triggerAttemptId);

  const emit = (operation: BreakerOperation, command: (id: CommandId) => PracticeCommand) => {
    const id = breakerCommandId(breaker.triggerAttemptId, operation);
    if (hasEmitted(next, id)) return;
    commands.push(command(id));
    next = markEmitted(next, id);
  };

  // An unavailable rung automatically chooses the bounded coach. Earlier
  // lifecycle prerequisites clear first; the launch itself retains the queue
  // head until its `coach_escalated` evidence is durable.
  if (
    next.flow.stage === "repair" &&
    next.flow.repair === "unavailable" &&
    next.recoveryAvailable &&
    !next.easyRequested
  ) {
    next = queueBreakerLifecycle(next, "coachEscalated");
  }

  // Lifecycle intent is a real causal queue, not merely an ordering-domain
  // convention. Only its head may execute, and every dependent command waits
  // until the head is acknowledged or the server projection proves it landed.
  const lifecycleHead = next.lifecycle.pending[0];
  if (lifecycleHead) {
    if (lifecycleHead.status === "queued") {
      const id = breakerCommandId(
        next.triggerAttemptId,
        lifecycleHead.operation,
      );
      commands.push(
        lifecycleHead.operation === "coachEscalated" &&
          !next.flow.coachUsed
          ? {
              kind: "launchCoach",
              id,
              domain,
              triggerAttemptId: next.triggerAttemptId,
            }
          : {
              kind: "recordBreakerLifecycle",
              id,
              domain,
              triggerAttemptId: next.triggerAttemptId,
              operation: lifecycleHead.operation,
            },
      );
      next = markEmitted(markLifecycleHeadPending(next), id);
    }
    return { breaker: next, commands };
  }

  // A tap on the quiet exit can happen while lifecycle evidence is catching up.
  // Preserve the tap as state, then issue exactly once after the queue clears.
  if (
    next.recoveryAvailable &&
    !state.terminal &&
    (next.easyRequested ||
      (next.flow.stage === "easy" && next.flow.easy === "requested"))
  ) {
    emit("easy", (id) => ({
      kind: "serveBreakerEasy",
      id,
      domain,
      triggerAttemptId: next.triggerAttemptId,
      expectedItemId: next.easyItemId,
    }));
    return { breaker: next, commands };
  }

  // A repair rung that is still opening needs serving — unless the server
  // already told us there is none, in which case the coach IS the support.
  if (next.flow.stage === "repair" && next.flow.repair === "opening" && next.triggerItemId) {
    emit("repairServe", (id) => ({
      kind: "serveHintRung",
      id,
      domain: hintDomain(next.triggerItemId!),
      itemId: next.triggerItemId!,
      stepIndex: next.repairStepIndex ?? 0,
      source: "breaker",
    }));
  }

  // Support recorded (or a prior resume already pinned the item) → the one
  // fresh, same-node item. `breakerFreshReconstructable` is what makes a SECOND
  // reload work: `breakerSupportRecorded` goes false once the stage is already
  // "fresh", which used to strand a re-resume on an empty card.
  //
  // Deliberately NOT while the coach chat is on screen. `breakerSupportRecorded`
  // is true as soon as the stage is "coach" — that only means the SERVER would
  // accept the request, because `coach_escalated` is recorded. The scholar is
  // still mid-conversation. Serving the fresh item here would yank the coach
  // out from under them; the live code waits for the chat to end, and so does
  // this. Coach-open is not coach-complete.
  // Note there is deliberately no `!next.freshItemId` guard: a resumed episode
  // whose item was ALREADY pinned server-side is exactly the case that needs
  // reconstructing, because this mount has no copy of the item. Re-issuance is
  // idempotent per trigger attempt, and `emitted` stops a live flow asking
  // twice.
  if (
    next.recoveryAvailable &&
    breakerFreshReconstructable(next.flow) &&
    state.lane !== "handoff" &&
    !next.easyRequested &&
    !hasEmitted(next, breakerCommandId(next.triggerAttemptId, "easy"))
  ) {
    emit("fresh", (id) => ({
      kind: "serveBreakerFresh",
      id,
      // Same domain as the lifecycle writes: issuance must not overtake the
      // record that authorizes it.
      domain,
      triggerAttemptId: next.triggerAttemptId,
    }));
  }

  // The episode is over: send the staff-facing outcome row once. Previously a
  // ref-guarded effect keyed on a stringified signature.
  const awaitingEasyFinish =
    next.flow.stage === "close" &&
    next.flow.fresh?.correct === false &&
    next.flow.easy === undefined;
  if (next.flow.stage === "close" && next.triggerItemId && !awaitingEasyFinish) {
    emit("outcome", (id) => ({
      kind: "recordBreakerOutcome",
      id,
      domain,
      triggerAttemptId: next.triggerAttemptId,
      triggerItemId: next.triggerItemId!,
      missStreak: next.missStreak,
      flow: next.flow,
    }));
  }

  return { breaker: next, commands };
}

/** Fold the breaker's implied commands into a transition. */
function withBreakerCommands(state: PracticeState, commands: PracticeCommand[]): Transition {
  const derived = breakerCommands(state);
  if (!derived) return { state, commands };
  return {
    state:
      derived.breaker === state.breaker
        ? state
        : { ...state, breaker: derived.breaker },
    commands: [...commands, ...derived.commands],
  };
}

function advanceFlow(
  state: PracticeState,
  event: Parameters<typeof advanceBreakerFlow>[1],
): PracticeState {
  if (!state.breaker) return state;
  return {
    ...state,
    breaker: { ...state.breaker, flow: advanceBreakerFlow(state.breaker.flow, event) },
  };
}

/** The resume position: the index of the first un-recorded item. */
export function resumeIdx(state: PracticeState): number {
  return state.run.idx + (state.item.hasRecorded ? 1 : 0);
}

function saveResume(state: PracticeState): { state: PracticeState; command: PracticeCommand } {
  const version = state.run.resumeVersion + 1;
  return {
    state: { ...state, run: { ...state.run, resumeVersion: version } },
    command: {
      kind: "saveResume",
      id: resumeSaveCommandId(state.scholarId, version),
      domain: resumeDomain(state.scholarId),
      version,
      resumeIdx: resumeIdx(state),
    },
  };
}

function clearResume(state: PracticeState, reason: ResumeClearReason): PracticeCommand {
  return {
    kind: "clearResume",
    id: resumeClearCommandId(state.scholarId),
    domain: resumeDomain(state.scholarId),
    reason,
  };
}

function freshItem(itemId: string | null): ItemState {
  return {
    itemId,
    phase: { kind: "answering" },
    hasRecorded: false,
    missCount: 0,
    clientEventId: null,
    clientEventKey: null,
    clientEventReplay: null,
    ladderCoachPulled: false,
  };
}

function freshHint(): HintState {
  return {
    itemId: null,
    open: false,
    nextStepIndex: 0,
    exhausted: false,
    pendingCommandId: null,
  };
}

function requestRunLoad(
  state: PracticeState,
  inputKey: string,
  forceFresh: boolean,
): Transition {
  if (state.run.pendingLoad) return none(state);
  const { id, seq } = ephemeral(state);
  return {
    state: {
      ...state,
      seq,
      run: {
        ...state.run,
        pendingLoad: { id, inputKey, forceFresh },
        failedInputKey: null,
      },
    },
    commands: [{ kind: "loadRun", id, inputKey, forceFresh }],
  };
}

function sameBreakerEpisode(
  current: BreakerState,
  episode: Extract<PracticeEvent, { type: "hydrate:breaker" }>["episode"],
): boolean {
  return (
    current.triggerAttemptId === episode.triggerAttemptId &&
    current.triggerItemId === episode.triggerItemId &&
    current.missStreak === episode.missStreak &&
    current.triggerNodeKey === episode.triggerNodeKey &&
    current.domain === episode.domain &&
    current.repairStepIndex === episode.repairStepIndex &&
    current.freshItemId === episode.freshItemId &&
    current.easyItemId === episode.easyItemId &&
    current.flow.stage === episode.flow.stage &&
    current.flow.repair === episode.flow.repair &&
    current.flow.coachUsed === episode.flow.coachUsed &&
    JSON.stringify(current.flow.fresh) === JSON.stringify(episode.flow.fresh) &&
    current.flow.easy === episode.flow.easy
  );
}

function breakerProgress(flow: BreakerFlow): number {
  if (flow.stage === "repair") {
    if (flow.repair === "opening") return 0;
    if (flow.repair === "open" || flow.repair === "unavailable") return 1;
    return 2;
  }
  if (flow.stage === "coach") return 3;
  if (flow.stage === "fresh") return flow.fresh ? 5 : 4;
  if (flow.stage === "easy") {
    return flow.easy === "requested" ? 7 : 8;
  }
  if (flow.fresh?.correct === false && flow.easy === undefined) return 6;
  return 9;
}

// ─── The reducer ─────────────────────────────────────────────────────────

/**
 * One pure step. Illegal, late and duplicate events are IGNORED rather than
 * throwing — the same discipline `advanceBreakerFlow` already uses, and for the
 * same reason: a double tap or a late async resolution must never strand a
 * struggling kid.
 */
export function practiceReduce(
  state: PracticeState,
  event: PracticeEvent,
): Transition {
  // A suspended lane owns the screen. The machine still owns items/idx/log and
  // the continuation; it just refuses to act on item events until the lane
  // returns through its typed event. Persistence and hydration still flow.
  if (
    state.lane &&
    !isLaneEvent(event) &&
    !isPersistenceEvent(event) &&
    !event.type.startsWith("ui:breaker") &&
    event.type !== "ui:retryBreakerLifecycle" &&
    !event.type.startsWith("server:breaker") &&
    event.type !== "server:commandFailed" &&
    !event.type.startsWith("server:lifecycle")
  ) {
    return none(state);
  }

  switch (event.type) {
    // ── the scholar answers ──────────────────────────────────────────────
    case "ui:submit": {
      if (state.terminal) return none(state);
      // One in-flight submit per item. The old code needed `busy` AND
      // `submitInFlightRef` for this; the phase says it once.
      if (
        state.item.phase.kind !== "answering" &&
        state.item.phase.kind !== "retry"
      ) {
        return none(state);
      }
      if (!state.item.itemId) return none(state);

      if (!allowDurable(state)) {
        // Rehearse: graded by an injected client grader, nothing written. Still
        // goes through `submitting` so a double tap is rejected the same way a
        // live submit is, and the grade comes back through `local:graded`
        // rather than the host mutating item state directly.
        const { id, seq } = ephemeral(state);
        return {
          state: {
            ...state,
            seq,
            item: { ...state.item, phase: { kind: "submitting", commandId: id } },
          },
          commands: [{ kind: "gradeLocally", id, entry: event.entry }],
        };
      }

      const id = submitCommandId(event.clientEventId);
      return {
        state: {
          ...state,
          item: {
            ...state.item,
            phase: { kind: "submitting", commandId: id },
            clientEventId: event.clientEventId,
            clientEventKey: event.clientEventKey ?? null,
            clientEventReplay: event.entry.submissionReplay ?? null,
          },
        },
        commands: [
          {
            kind: "submitAnswer",
            id,
            domain: outboxDomain(state.scholarId),
            entry: event.entry,
          },
        ],
      };
    }

    case "server:submitSucceeded": {
      if (!isAwaiting(state, event.id)) return none(state);
      const { result } = event;
      const missCount = result.correct ? state.item.missCount : state.item.missCount + 1;
      let next: PracticeState = {
        ...state,
        run: {
          ...state.run,
          correctCount:
            state.run.correctCount +
            (result.correct && !state.item.hasRecorded ? 1 : 0),
          answeredCount: state.run.answeredCount + (state.item.hasRecorded ? 0 : 1),
        },
        item: {
          ...state.item,
          phase: { kind: "feedback", correct: result.correct },
          hasRecorded: true,
          missCount,
          // The receipt has been consumed; a genuinely new answer mints a new
          // one. Retrying the SAME answer reuses it, which is what makes the
          // server's dedup exact.
          clientEventId: null,
          clientEventKey: null,
          clientEventReplay: null,
        },
      };
      let commands: PracticeCommand[] = [];

      // A graded fresh recovery item: only the SERVER's verdict counts.
      if (next.breaker && next.breaker.freshItemId === state.item.itemId) {
        next = advanceFlow(next, {
          type: "freshGraded",
          correct: result.correct,
          assisted: false,
          verified: result.breakerRecoveryVerified === true,
        });
      } else if (next.breaker && next.breaker.easyItemId === state.item.itemId) {
        next = advanceFlow(next, { type: "easyGraded", correct: result.correct });
      } else if (result.backOff && !next.breaker && !next.run.suppressBreaker) {
        // The server opened an episode. Local resume is cleared: a breaker is
        // hydrated from the server's projection, never from a snapshot.
        next = {
          ...next,
          breaker: {
            triggerAttemptId: result.backOff.triggerAttemptId,
            recoveryAvailable: result.backOff.recoveryAvailable,
            triggerItemId: state.item.itemId,
            missStreak: result.backOff.missStreak,
            triggerNodeKey: result.backOff.triggerNodeKey,
            domain: result.backOff.domain,
            flow: newBreakerFlow(result.backOff.initialRepairStatus),
            freshItemId: null,
            easyItemId: null,
            repairStepIndex: result.backOff.repairStepIndex,
            lifecycle: { confirmed: [], pending: [] },
            easyRequested: false,
            emitted: [],
          },
        };
        commands.push(clearResume(next, "breaker-started"));
        if (
          result.backOff.recoveryAvailable &&
          result.backOff.initialRepairStatus === "done" &&
          next.breaker
        ) {
          next = {
            ...next,
            breaker: queueBreakerLifecycle(
              next.breaker,
              "repairCompleted",
            ),
          };
          const scheduled = withBreakerCommands(next, commands);
          next = scheduled.state;
          commands = scheduled.commands;
        }
      }

      if (!next.breaker) {
        const saved = saveResume(next);
        next = saved.state;
        commands.push(saved.command);
      }
      commands.push({
        kind: "haptic",
        id: `ui:${next.seq + 1}`,
        style: result.correct ? "success" : "warning",
      });
      next = { ...next, seq: next.seq + 1 };
      return withBreakerCommands(next, commands);
    }

    case "server:submitQueued": {
      if (!isAwaiting(state, event.id)) return none(state);
      // Durably queued and NOT graded. The scholar may move on — an outage must
      // not trap them — but nothing here claims a verdict, and `hasRecorded`
      // still becomes true so the resume position skips the answered item.
      const next: PracticeState = {
        ...state,
        item: {
          ...state.item,
          phase: { kind: "queued", queuedCount: event.queuedCount },
          hasRecorded: true,
          clientEventId: null,
          clientEventKey: null,
          clientEventReplay: null,
        },
        run: {
          ...state.run,
          answeredCount: state.run.answeredCount + (state.item.hasRecorded ? 0 : 1),
        },
      };
      const saved = saveResume(next);
      return { state: saved.state, commands: [saved.command] };
    }

    case "server:submitFailed": {
      if (!isAwaiting(state, event.id)) return none(state);
      // Neither submitted nor durably queued: the scholar must not advance past
      // an answer that was lost. Back to answering, receipt retained so the
      // retry carries the SAME id.
      return none({
        ...state,
        item: {
          ...state.item,
          phase: { kind: "answering" },
          clientEventId: state.item.clientEventId,
          clientEventReplay: event.submissionReplay,
        },
      });
    }

    case "local:graded": {
      // Rehearse only (a live run never emits `gradeLocally`), so no breaker,
      // no resume write — `allowDurable` is false for the whole mode. Still
      // routed through the SAME shape as a server grade (correctCount, phase,
      // hasRecorded) so rehearse never grows a second, split copy of "was this
      // item answered".
      if (!isAwaiting(state, event.id)) return none(state);
      const missCount = event.correct ? state.item.missCount : state.item.missCount + 1;
      const next: PracticeState = {
        ...state,
        run: {
          ...state.run,
          correctCount:
            state.run.correctCount +
            (event.correct && !state.item.hasRecorded ? 1 : 0),
          answeredCount: state.run.answeredCount + (state.item.hasRecorded ? 0 : 1),
        },
        item: {
          ...state.item,
          phase: { kind: "feedback", correct: event.correct },
          hasRecorded: true,
          missCount,
          clientEventId: null,
          clientEventKey: null,
          clientEventReplay: null,
        },
      };
      const seq = next.seq + 1;
      return {
        state: { ...next, seq },
        commands: [
          { kind: "haptic", id: `ui:${seq}`, style: event.correct ? "success" : "warning" },
        ],
      };
    }

    // ── moving through the run ───────────────────────────────────────────
    case "ui:retry": {
      if (state.item.phase.kind !== "feedback") return none(state);
      return none({
        ...state,
        item: { ...state.item, phase: { kind: "retry", missCount: state.item.missCount } },
      });
    }

    case "ui:advance": {
      if (state.terminal) return none(state);
      // A queued answer may advance; a submitting one may not.
      if (state.item.phase.kind === "submitting") return none(state);
      const nextIdx = state.run.idx + 1;
      if (nextIdx >= state.run.itemCount) return terminate(state, "run-complete");
      return none({
        ...state,
        run: { ...state.run, idx: nextIdx },
        item: freshItem(event.nextItemId ?? null),
        hint: freshHint(),
      });
    }

    // ── the hint ladder ──────────────────────────────────────────────────
    case "ui:hintPressed": {
      if (
        !allowDurable(state) ||
        state.terminal ||
        !state.item.itemId ||
        state.item.phase.kind === "submitting"
      ) {
        return none(state);
      }
      const itemId = state.item.itemId;
      if (state.hint.itemId !== itemId) {
        return none({
          ...state,
          hint: {
            ...freshHint(),
            itemId,
            open: true,
          },
        });
      }
      if (!state.hint.open) {
        return none({ ...state, hint: { ...state.hint, open: true } });
      }
      if (state.hint.pendingCommandId) return none(state);
      if (state.hint.exhausted) {
        return practiceReduce(state, { type: "ui:hintLadderPulled" });
      }
      const id = hintCommandId(itemId, state.hint.nextStepIndex);
      return {
        state: {
          ...state,
          hint: { ...state.hint, pendingCommandId: id },
        },
        commands: [
          {
            kind: "serveHintRung",
            id,
            domain: hintDomain(itemId),
            itemId,
            stepIndex: state.hint.nextStepIndex,
            source: "ladder",
          },
        ],
      };
    }

    case "ui:hintLadderPulled": {
      // Per-item dedup: repeated taps on an exhausted ladder must not re-open
      // the coach chat for the same item. State, not a Set in a ref.
      if (!allowDurable(state) || state.item.ladderCoachPulled) return none(state);
      const { id, seq } = ephemeral(state);
      return {
        state: {
          ...state,
          seq,
          item: { ...state.item, ladderCoachPulled: true },
          lane: "handoff",
        },
        commands: [{ kind: "openHandoff", id, entryMode: "ladder" }],
      };
    }

    // ── the breaker ──────────────────────────────────────────────────────
    case "server:hintServed": {
      if (state.hint.pendingCommandId === event.id) {
        return none({
          ...state,
          hint: {
            itemId: state.item.itemId,
            open: true,
            nextStepIndex: event.stepIndex + 1,
            exhausted: !event.hasMore,
            pendingCommandId: null,
          },
        });
      }
      if (!state.breaker) return none(state);
      const serveId = breakerCommandId(state.breaker.triggerAttemptId, "repairServe");
      const restoreId = breakerCommandId(
        state.breaker.triggerAttemptId,
        "repairRestore",
      );
      if (event.id !== serveId && event.id !== restoreId) return none(state);

      let next: PracticeState = {
        ...state,
        hint: {
          itemId: state.breaker.triggerItemId,
          open: true,
          nextStepIndex: event.stepIndex + 1,
          exhausted: !event.hasMore,
          pendingCommandId: null,
        },
        breaker: { ...state.breaker, repairStepIndex: event.stepIndex },
      };
      if (event.id === restoreId) return none(next);

      next = advanceFlow(next, { type: "repairOpened" });
      const shownBreaker = next.breaker;
      if (shownBreaker?.recoveryAvailable) {
        next = {
          ...next,
          breaker: queueBreakerLifecycle(shownBreaker, "repairShown"),
        };
      }
      if (event.rungKind === "reveal") {
        next = advanceFlow(next, { type: "repairDone" });
        const completedBreaker = next.breaker;
        if (completedBreaker?.recoveryAvailable) {
          next = {
            ...next,
            breaker: queueBreakerLifecycle(
              completedBreaker,
              "repairCompleted",
            ),
          };
        }
      }
      return withBreakerCommands(next, []);
    }

    case "server:hintUnavailable": {
      if (state.hint.pendingCommandId === event.id) {
        return none({
          ...state,
          hint: {
            ...state.hint,
            exhausted: true,
            pendingCommandId: null,
          },
        });
      }
      if (
        !state.breaker ||
        event.id !== breakerCommandId(state.breaker.triggerAttemptId, "repairServe")
      ) {
        return none(state);
      }
      let next = advanceFlow(state, { type: "repairUnavailable" });
      const unavailableBreaker = next.breaker;
      if (unavailableBreaker?.recoveryAvailable) {
        next = {
          ...next,
          breaker: queueBreakerLifecycle(
            unavailableBreaker,
            "repairUnavailable",
          ),
        };
      }
      return withBreakerCommands(next, []);
    }

    case "server:coachOpened": {
      if (!state.breaker) return none(state);
      const lifecycleHead = state.breaker.lifecycle.pending[0];
      if (
        event.id !==
          breakerCommandId(
            state.breaker.triggerAttemptId,
            "coachEscalated",
          ) ||
        lifecycleHead?.operation !== "coachEscalated" ||
        lifecycleHead.status !== "pending"
      ) {
        return none(state);
      }
      // Presentation is immediate once earlier lifecycle prerequisites clear,
      // but this command remains pending until its own durable evidence lands.
      // Fresh/easy issuance therefore cannot overtake a failed coach write.
      return withBreakerCommands(
        {
          ...advanceFlow(state, { type: "coachOpened" }),
          lane: "handoff",
        },
        [],
      );
    }

    case "lane:coachEnded": {
      if (!state.breaker) return none({ ...state, lane: null });
      if (
        hasEmitted(
          state.breaker,
          breakerCommandId(state.breaker.triggerAttemptId, "easy"),
        ) &&
        state.breaker.flow.easy === undefined
      ) {
        return none(state);
      }
      if (!state.breaker.recoveryAvailable) {
        return withBreakerCommands(
          advanceFlow({ ...state, lane: null }, { type: "closed" }),
          [],
        );
      }
      return withBreakerCommands({ ...state, lane: null }, []);
    }

    case "server:breakerFreshServed": {
      if (!state.breaker) return none(state);
      // Exact identity, not merely "a breaker exists": a duplicate arriving
      // after the fresh item was graded would otherwise reset the item to
      // un-recorded and let it be answered again.
      if (event.id !== breakerCommandId(state.breaker.triggerAttemptId, "fresh")) {
        return none(state);
      }
      if (!isAwaiting(state, event.id)) return none(state);
      if (state.breaker.flow.fresh) return none(state);
      const next: PracticeState = {
        ...advanceFlow(state, { type: "freshServed" }),
        run: { ...state.run, idx: 0, itemCount: 1 },
        item: freshItem(event.itemId),
        hint: freshHint(),
      };
      return none({
        ...next,
        breaker: next.breaker ? { ...next.breaker, freshItemId: event.itemId } : null,
      });
    }

    case "server:breakerFreshUnavailable": {
      if (!state.breaker) return none(state);
      if (event.id !== breakerCommandId(state.breaker.triggerAttemptId, "fresh")) {
        return none(state);
      }
      if (!isAwaiting(state, event.id)) return none(state);
      // No same-node item to serve: end warmly rather than inventing one.
      return withBreakerCommands(advanceFlow(state, { type: "closed" }), []);
    }

    case "ui:breakerEasyFinish": {
      if (!state.breaker || !allowDurable(state)) return none(state);
      const active: PracticeState = { ...state, lane: null };
      if (!state.breaker.recoveryAvailable) {
        const requested = advanceFlow(active, { type: "easyRequested" });
        return withBreakerCommands(
          advanceFlow(requested, { type: "easyUnavailable" }),
          [],
        );
      }
      const id = breakerCommandId(state.breaker.triggerAttemptId, "easy");
      if (
        state.breaker.easyRequested ||
        hasEmitted(state.breaker, id)
      ) {
        return none(state);
      }
      return withBreakerCommands(
        {
          ...state,
          breaker: {
            ...state.breaker,
            easyRequested: true,
          },
        },
        [],
      );
    }

    case "server:breakerEasyServed": {
      if (!state.breaker) return none(state);
      if (event.id !== breakerCommandId(state.breaker.triggerAttemptId, "easy")) {
        return none(state);
      }
      if (!isAwaiting(state, event.id) || state.terminal) return none(state);
      const isFirstIssue = state.breaker.flow.easy === undefined;
      const isRequestedReinstall =
        state.breaker.flow.stage === "easy" &&
        state.breaker.flow.easy === "requested";
      if (!isFirstIssue && !isRequestedReinstall) return none(state);
      if (
        state.breaker.easyItemId !== null &&
        state.breaker.easyItemId !== event.itemId
      ) {
        return none(state);
      }
      const advanced = advanceFlow(
        { ...state, lane: null },
        { type: "easyRequested" },
      );
      return none({
        ...advanced,
        run: { ...state.run, idx: 0, itemCount: 1 },
        breaker: advanced.breaker
          ? {
              ...advanced.breaker,
              easyItemId: event.itemId,
              easyRequested: false,
            }
          : null,
        item: freshItem(event.itemId),
        hint: freshHint(),
      });
    }

    case "server:breakerEasyUnavailable": {
      if (!state.breaker) return none(state);
      if (event.id !== breakerCommandId(state.breaker.triggerAttemptId, "easy")) {
        return none(state);
      }
      if (!isAwaiting(state, event.id)) return none(state);
      const requested = advanceFlow(
        { ...state, lane: null },
        { type: "easyRequested" },
      );
      return withBreakerCommands(
        advanceFlow(
          {
            ...requested,
            breaker: requested.breaker
              ? { ...requested.breaker, easyRequested: false }
              : null,
          },
          { type: "easyUnavailable" },
        ),
        [],
      );
    }

    case "ui:breakerRepairStarted": {
      if (
        !state.breaker ||
        !state.breaker.recoveryAvailable ||
        !allowDurable(state)
      ) {
        return none(state);
      }
      const queued = queueBreakerLifecycle(
        state.breaker,
        "repairStarted",
      );
      if (queued === state.breaker) return none(state);
      return withBreakerCommands({ ...state, breaker: queued }, []);
    }

    case "ui:breakerRepairCompleted": {
      if (!state.breaker || !allowDurable(state)) return none(state);
      // The scholar finished the pushed rung. The server will not issue a
      // recovery session until this lands, which is why the lifecycle write and
      // the issuance that follows share one ordering domain.
      const advanced = advanceFlow(state, { type: "repairDone" });
      if (!state.breaker.recoveryAvailable) {
        return withBreakerCommands(advanced, []);
      }
      const marked: PracticeState = {
        ...advanced,
        breaker: advanced.breaker
          ? queueBreakerLifecycle(
              advanced.breaker,
              "repairCompleted",
            )
          : null,
      };
      return withBreakerCommands(marked, []);
    }

    case "ui:breakerCoach": {
      if (!state.breaker || !allowDurable(state)) return none(state);
      if (!state.breaker.recoveryAvailable) {
        const { id, seq } = ephemeral(state);
        return {
          state: {
            ...advanceFlow(state, { type: "coachOpened" }),
            seq,
            lane: "handoff",
          },
          commands: [{ kind: "openHandoff", id, entryMode: "spiral" }],
        };
      }
      const queued = queueBreakerLifecycle(
        state.breaker,
        "coachEscalated",
      );
      if (queued === state.breaker) return none(state);
      return withBreakerCommands({ ...state, breaker: queued }, []);
    }

    case "ui:breakerClose":
      if (
        !state.breaker ||
        state.breaker.lifecycle.pending.length > 0
      ) {
        return none(state);
      }
      return withBreakerCommands(advanceFlow(state, { type: "closed" }), []);

    case "server:lifecycleRecorded": {
      if (!state.breaker) return none(state);
      const confirmed = confirmLifecycleHead(state.breaker, event.id);
      if (!confirmed) return none(state);
      return withBreakerCommands(
        { ...state, breaker: confirmed.breaker },
        [],
      );
    }

    case "server:lifecycleFailed": {
      if (!state.breaker) return none(state);
      const failed = failLifecycleHead(state.breaker, event.id);
      return failed
        ? none({ ...state, breaker: failed })
        : none(state);
    }

    case "ui:retryBreakerLifecycle": {
      if (!state.breaker) return none(state);
      const [head, ...tail] = state.breaker.lifecycle.pending;
      if (!head || head.status !== "recoverable") return none(state);
      return withBreakerCommands(
        {
          ...state,
          breaker: {
            ...state.breaker,
            lifecycle: {
              ...state.breaker.lifecycle,
              pending: [{ ...head, status: "queued" }, ...tail],
            },
          },
        },
        [],
      );
    }

    case "server:commandFailed": {
      if (state.breaker) {
        const failed = failLifecycleHead(state.breaker, event.id);
        if (failed) return none({ ...state, breaker: failed });
        const easyId = breakerCommandId(
          state.breaker.triggerAttemptId,
          "easy",
        );
        const easyRequestPending =
          state.breaker.easyRequested ||
          (state.breaker.flow.easy === "requested" &&
            state.breaker.easyItemId !== null &&
            state.item.itemId !== state.breaker.easyItemId);
        if (event.id === easyId && easyRequestPending) {
          return none({
            ...state,
            breaker: {
              ...state.breaker,
              easyRequested: false,
              emitted: state.breaker.emitted.filter((id) => id !== easyId),
            },
          });
        }
      }
      if (!isAwaiting(state, event.id)) return none(state);
      if (state.run.pendingLoad?.id === event.id) {
        return none({
          ...state,
          run: {
            ...state.run,
            failedInputKey: state.run.pendingLoad.inputKey,
            pendingLoad: null,
          },
        });
      }
      if (state.hint.pendingCommandId === event.id) {
        return none({
          ...state,
          hint: { ...state.hint, pendingCommandId: null },
        });
      }
      if (state.item.phase.kind === "submitting") {
        return none({ ...state, item: { ...state.item, phase: { kind: "answering" } } });
      }
      return none(state);
    }

    // ── hydration ────────────────────────────────────────────────────────
    case "hydrate:breaker": {
      const { episode } = event;
      const sameTrigger =
        state.breaker?.triggerAttemptId === episode.triggerAttemptId;
      const reconciledBreaker =
        sameTrigger && state.breaker
          ? reconcileLifecycleProjection(
              state.breaker,
              episode.confirmedLifecycle ?? [],
            )
          : state.breaker;
      const projectedState =
        reconciledBreaker !== state.breaker
          ? { ...state, breaker: reconciledBreaker }
          : state;
      const projectedBreaker = projectedState.breaker;
      if (
        projectedBreaker?.triggerAttemptId === episode.triggerAttemptId &&
        breakerProgress(episode.flow) <
          breakerProgress(projectedBreaker.flow)
      ) {
        // The local transition has already emitted the durable command that
        // will move this projection forward. A reactive query can briefly
        // deliver the preceding projection in that window; never rewind the
        // scholar while the write catches up.
        return withBreakerCommands(projectedState, []);
      }
      if (projectedBreaker && sameBreakerEpisode(projectedBreaker, episode)) {
        return withBreakerCommands(projectedState, []);
      }
      // Reconstructing a graded episode would be a regrade, not a resume.
      if (episode.flow.fresh && episode.flow.stage === "close" && episode.easyItemId) {
        return none(state);
      }
      let next: PracticeState = {
        ...state,
        terminal: false,
        lane: null,
        hint: freshHint(),
        run: { ...state.run, pendingLoad: null },
        breaker: {
          triggerAttemptId: episode.triggerAttemptId,
          recoveryAvailable: episode.recoveryAvailable ?? true,
          triggerItemId: episode.triggerItemId,
          missStreak: episode.missStreak,
          triggerNodeKey: episode.triggerNodeKey,
          domain: episode.domain,
          flow: episode.flow,
          freshItemId: episode.freshItemId,
          easyItemId: episode.easyItemId,
          repairStepIndex: episode.repairStepIndex,
          lifecycle: {
            confirmed: episode.confirmedLifecycle ?? [],
            pending: [],
          },
          easyRequested: false,
          emitted: [],
        },
      };
      const commands: PracticeCommand[] = [];
      if (
        episode.triggerItemId &&
        episode.repairStepIndex !== null &&
        episode.flow.stage === "repair" &&
        (episode.flow.repair === "open" || episode.flow.repair === "done")
      ) {
        const id = breakerCommandId(episode.triggerAttemptId, "repairRestore");
        next = {
          ...next,
          breaker: next.breaker ? markEmitted(next.breaker, id) : null,
          hint: {
            ...freshHint(),
            itemId: episode.triggerItemId,
            open: true,
            pendingCommandId: id,
          },
        };
        commands.push({
          kind: "serveHintRung",
          id,
          domain: hintDomain(episode.triggerItemId),
          itemId: episode.triggerItemId,
          stepIndex: episode.repairStepIndex,
          source: "breakerRestore",
        });
      }
      return withBreakerCommands(next, commands);
    }

    case "hydrate:resume": {
      if (state.breaker) return none(state); // a live episode outranks a snapshot
      return none({
        ...state,
        run: { ...state.run, idx: event.idx },
        item: { ...freshItem(event.itemId), hasRecorded: event.hasRecorded },
        hint: freshHint(),
      });
    }

    case "run:inputsChanged": {
      if (state.breaker) return none(state);
      if (state.run.inputKey === event.inputKey) return none(state);
      if (state.run.allMapping && state.run.inputKey !== null) {
        // Finalizing a mapped domain changes the parent's derived domain inputs
        // mid-ceremony. Acknowledge the new fingerprint without replacing the
        // in-progress all-mapping payload.
        return none({
          ...state,
          run: { ...state.run, inputKey: event.inputKey },
        });
      }
      if (
        state.run.pendingLoad?.inputKey === event.inputKey ||
        state.run.failedInputKey === event.inputKey
      ) {
        return none(state);
      }
      return requestRunLoad(state, event.inputKey, false);
    }

    case "run:reloadRequested": {
      if (state.breaker) return none(state);
      const inputKey =
        state.run.pendingLoad?.inputKey ??
        state.run.failedInputKey ??
        state.run.inputKey;
      if (!inputKey) return none(state);
      return requestRunLoad(
        {
          ...state,
          run: { ...state.run, pendingLoad: null, failedInputKey: null },
        },
        inputKey,
        true,
      );
    }

    case "run:itemCountAdjusted": {
      if (!Number.isInteger(event.delta) || event.delta === 0) return none(state);
      return none({
        ...state,
        run: {
          ...state.run,
          itemCount: Math.max(
            state.run.idx + 1,
            state.run.itemCount + event.delta,
          ),
        },
      });
    }

    case "run:loaded": {
      const pending = state.run.pendingLoad;
      if (!pending || pending.id !== event.id) return none(state);
      return none({
        ...state,
        breaker: null,
        lane: null,
        terminal: false,
        run: {
          ...state.run,
          itemCount: event.itemCount,
          idx: 0,
          correctCount: 0,
          answeredCount: 0,
          scopeKey: event.scopeKey,
          dayKey: event.dayKey,
          resumeVersion: 0,
          tuneupId: event.tuneupId ?? null,
          inputKey: pending.inputKey,
          pendingLoad: null,
          failedInputKey: null,
          allMapping: event.allMapping ?? false,
        },
        item: freshItem(event.itemId),
        hint: freshHint(),
      });
    }

    case "run:loadFailed":
      if (state.run.pendingLoad?.id !== event.id) return none(state);
      return none({
        ...state,
        run: {
          ...state.run,
          failedInputKey: state.run.pendingLoad.inputKey,
          pendingLoad: null,
        },
      });

    // ── persistence ──────────────────────────────────────────────────────
    case "env:mounted": {
      if (!allowDurable(state)) return none(state);
      if (event.online === false) return none(state);
      return {
        state,
        commands: [
          {
            kind: "drainOutbox",
            id: drainCommandId(state.scholarId),
            domain: outboxDomain(state.scholarId),
          },
        ],
      };
    }

    case "env:online": {
      if (!allowDurable(state)) return none(state);
      return {
        state,
        commands: [
          {
            kind: "drainOutbox",
            id: drainCommandId(state.scholarId),
            domain: outboxDomain(state.scholarId),
          },
        ],
      };
    }

    case "persist:drainProgressed":
    case "persist:drainSettled":
      // Historical replay. Deliberately does NOT touch the current item's
      // phase — a drained old answer is not this item's grade.
      return none(state);

    case "persist:resumeSaved":
    case "persist:resumeFailed":
      return none(state);

    case "persist:discardResume":
      return allowDurable(state)
        ? { state, commands: [clearResume(state, event.reason)] }
        : none(state);

    // ── lanes ────────────────────────────────────────────────────────────
    case "lane:entered":
      return none({ ...state, lane: event.lane });

    case "lane:exited":
      return none({ ...state, lane: null });

    case "lane:mappingAnswered": {
      const next: PracticeState = {
        ...state,
        lane: null,
        item: {
          ...state.item,
          phase: { kind: "feedback", correct: event.correct },
          hasRecorded: event.recorded,
          missCount: event.correct
            ? state.item.missCount
            : state.item.missCount + 1,
        },
        run: {
          ...state.run,
          correctCount: state.run.correctCount + (event.correct ? 1 : 0),
          answeredCount: state.run.answeredCount + (event.recorded ? 1 : 0),
        },
      };
      if (!allowDurable(next)) return none(next);
      const saved = saveResume(next);
      return { state: saved.state, commands: [saved.command] };
    }

    case "lane:mappingRetry":
      return none({
        ...state,
        lane: null,
        item: freshItem(event.itemId),
        hint: freshHint(),
      });

    case "lane:batchAppended":
      return none({
        ...state,
        lane: null,
        run: { ...state.run, itemCount: state.run.itemCount + event.addedCount },
      });

    case "lane:handoffClosed": {
      const cleared: PracticeState = { ...state, lane: null };
      if (event.outcome === "advance") {
        return practiceReduce(cleared, {
          type: "ui:advance",
          nextItemId: event.itemId,
        });
      }
      if (event.outcome === "retry-same") {
        return none({
          ...cleared,
          item: { ...cleared.item, phase: { kind: "retry", missCount: cleared.item.missCount } },
          hint: freshHint(),
        });
      }
      return none({
        ...cleared,
        item: freshItem(event.itemId ?? cleared.item.itemId),
        hint: freshHint(),
      });
    }

    case "lane:tailAccepted":
      // A tail REPLACES the run. One owner means both surfaces reset the same
      // fields; they previously reset different ones.
      return none({
        ...state,
        lane: null,
        terminal: false,
        run: { ...state.run, itemCount: event.itemCount, idx: 0, correctCount: 0, answeredCount: 0 },
        item: freshItem(event.itemId ?? null),
        hint: freshHint(),
      });

    case "lane:beatProceeded":
      return none({ ...state, lane: null });

    default:
      return none(state);
  }
}

/**
 * The terminal transition, modelled rather than left to an effect. The old
 * components fired the completion haptic and the tune-up patch from `useEffect`
 * guarded by one-shot refs (`doneHapticFired`, `tuneupCompletedRef`) purely
 * because Strict Mode re-ran them. Emitting both once, from the transition that
 * causes them, removes the need for either latch.
 *
 * Note the tune-up write has no durable client intent: after a reload it relies
 * on the server's idempotent `complete` plus a re-derived terminal state.
 */
function terminate(state: PracticeState, reason: ResumeClearReason): Transition {
  const seq = state.seq + 1;
  const next: PracticeState = { ...state, terminal: true, seq };
  const commands: PracticeCommand[] = [];
  if (allowDurable(state)) commands.push(clearResume(next, reason));
  commands.push({ kind: "haptic", id: `ui:${seq}`, style: "success" });
  if (allowDurable(state) && state.run.tuneupId) {
    commands.push({
      kind: "completeTuneup",
      id: tuneupCommandId(state.run.tuneupId),
      tuneupId: state.run.tuneupId,
      correctCount: state.run.correctCount,
    });
  }
  return { state: next, commands };
}

function isLaneEvent(event: PracticeEvent): boolean {
  return (
    event.type.startsWith("lane:") ||
    event.type.startsWith("hydrate:") ||
    // A freshly served run always applies, even mid-lane: it either replaces
    // the whole run (a genuine new load) or freezes deliberately (the
    // all-mapping ceremony) — neither is "an item event a suspended lane
    // should own".
    event.type.startsWith("run:")
  );
}

function isPersistenceEvent(event: PracticeEvent): boolean {
  return event.type.startsWith("persist:") || event.type.startsWith("env:");
}

/** Fold a whole event list, collecting every command in order. Used by the
 *  characterization vectors so a scenario reads as data. */
export function runPracticeEvents(
  state: PracticeState,
  events: readonly PracticeEvent[],
): { state: PracticeState; commands: PracticeCommand[] } {
  let current = state;
  const commands: PracticeCommand[] = [];
  for (const event of events) {
    const step = practiceReduce(current, event);
    current = step.state;
    commands.push(...step.commands);
  }
  return { state: current, commands };
}
