import { beforeAll, describe, expect, it } from "vitest";

import {
  breakerCommandId,
  isDurableCommand,
  newPracticeState,
  practiceReduce,
  runPracticeEvents,
  submitCommandId,
  type PracticeCommand,
  type PracticeEvent,
  type PracticeState,
} from "./practiceMachine";
import {
  advanceBreakerFlow,
  breakerControls,
  newBreakerFlow,
} from "./practiceLoop";
import type { BreakerLifecycleOperation } from "./practiceLifecycleRetry";
import type { OutboxAnswer } from "./practiceOutboxContract";

// ─────────────────────────────────────────────────────────────────────────
// Bounded state-space exploration of the practice reducer.
//
// practiceMachine.test.ts pins scenarios someone thought of. This file asks
// the complementary question: across EVERY interleaving of a small, realistic
// event alphabet, do the promises the reducer's own comments make still hold?
//
// The world being explored is (reducer state × outstanding commands × a coarse
// server × the host's current run key). Server results are never invented out
// of thin air: they are generated FROM THE COMMANDS the reducer actually
// emitted, and each may arrive late (any time after emission, interleaved with
// any UI or host event) or duplicated (a re-emitted in-flight id is replayed
// by the host coordinator, so it answers twice). Out-of-order delivery is
// explored under two transports (see `Transport`): the reducer's declared
// per-domain FIFO, and the stricter one-command-at-a-time order the shipped
// hosts actually give. A result that duplicates or overtakes its OWN domain is
// not modelled: the hosts cannot produce it, and an earlier draft that allowed
// it only surfaced traces the coordinator rules out. UI events are offered
// only when the web/native hosts would render the control (their shared
// `busy` gate, `breakerControls`). Host effects model the breaker-projection
// effect both run screens share (PracticeSession.tsx / native practice.tsx:
// `hydrate:breaker` when an applicable episode is active, else
// `hydrate:noBreakerForRun` followed by `run:inputsChanged`), plus in-place
// navigation between two run keys and the reload the hosts offer.
//
// Everything is deterministic: BFS order, so each counterexample printed
// (PRACTICE_EXPLORE_VERBOSE=1) is a shortest trace within the model.
// ─────────────────────────────────────────────────────────────────────────

const SCHOLAR = "scholar-x";
const MAX_STATES = 500_000;

// ─── The world ───────────────────────────────────────────────────────────

/** One command execution still owed a result, kept in emission order so the
 *  `Transport` can decide which entries may answer next. */
type PoolEntry = {
  command: PracticeCommand;
  /** coachOpened: launchCoach presented, its durable write still to answer. */
  stage: "out" | "coachOpened";
  /** The reducer re-emitted this id while it was still in flight. The host's
   *  coordinator refuses the second claim, waits for release and REPLAYS it
   *  (hooks/usePracticeMachine.ts), so a second result follows the first —
   *  this is where duplicate results come from. */
  replay: boolean;
};

type Snapshot = Extract<PracticeEvent, { type: "hydrate:breaker" }>["episode"];

/** The server's episode, coarsely: which lifecycle evidence it has RECORDED
 *  and which recovery items it pinned. Its projection is derived the way
 *  `breakerFlowFromLifecycle` (convex/lib/practice/spiralBreaker.ts) derives
 *  it — from durable evidence, never from the client's optimistic flow. */
type ServerEpisode = {
  triggerAttemptId: string;
  triggerItemId: string;
  /** The run key whose domain the streak was counted in. */
  runKey: string;
  recorded: readonly BreakerLifecycleOperation[];
  repairStepIndex: number | null;
  freshItemId: string | null;
  freshCorrect: boolean | null;
  easyItemId: string | null;
  easyUnavailable: boolean;
  terminal: boolean;
};

type World = {
  machine: PracticeState;
  pool: readonly PoolEntry[];
  server: ServerEpisode | null;
  hostKey: string;
};

type EdgeKind = "ui" | "result" | "host" | "nav";
type Edge = { label: string; kind: EdgeKind; events: PracticeEvent[]; world: World };

function entry(itemId: string, clientEventId: string): OutboxAnswer {
  return {
    clientEventId,
    itemId,
    answer: "7",
    record: true,
    skillLabel: "Explore",
    queuedAt: 0,
  };
}

// ─── Stepping ────────────────────────────────────────────────────────────

type StepRecord = {
  before: PracticeState;
  event: PracticeEvent;
  after: PracticeState;
  commands: PracticeCommand[];
};

const RESULT_BEARING = new Set<PracticeCommand["kind"]>([
  "loadRun",
  "submitAnswer",
  "serveHintRung",
  "recordBreakerLifecycle",
  "serveBreakerFresh",
  "serveBreakerEasy",
  "launchCoach",
  "gradeLocally",
  "gradeProvisionally",
]);

function withEmitted(
  pool: readonly PoolEntry[],
  commands: readonly PracticeCommand[],
): readonly PoolEntry[] {
  let next = pool;
  for (const command of commands) {
    if (!RESULT_BEARING.has(command.kind)) continue;
    const index = next.findIndex((p) => p.command.id === command.id);
    next =
      index === -1
        ? [...next, { command, stage: "out", replay: false }]
        : next.map((p, i) => (i === index ? { ...p, replay: true } : p));
  }
  return next;
}

function domainOf(command: PracticeCommand): string | null {
  return "domain" in command ? command.domain : null;
}

/** Apply events through the reducer, pooling every result-bearing command. */
function applyEvents(
  world: World,
  events: readonly PracticeEvent[],
  steps: StepRecord[],
): World {
  let machine = world.machine;
  let pool = world.pool;
  for (const event of events) {
    const step = practiceReduce(machine, event);
    steps.push({ before: machine, event, after: step.state, commands: step.commands });
    pool = withEmitted(pool, step.commands);
    machine = step.state;
  }
  return { ...world, machine, pool };
}

/** What `activeBreakerEpisode` would hand the host right now. */
function projection(server: ServerEpisode): Snapshot {
  const has = (op: BreakerLifecycleOperation) => server.recorded.includes(op);
  let flow = newBreakerFlow(has("repairUnavailable") ? "unavailable" : "opening");
  if (has("repairShown") || has("repairStarted")) {
    flow = advanceBreakerFlow(flow, { type: "repairOpened" });
  }
  if (has("repairCompleted")) flow = advanceBreakerFlow(flow, { type: "repairDone" });
  if (has("coachEscalated")) flow = advanceBreakerFlow(flow, { type: "coachOpened" });
  if (server.freshItemId) flow = advanceBreakerFlow(flow, { type: "freshServed" });
  if (server.freshCorrect !== null) {
    flow = advanceBreakerFlow(flow, {
      type: "freshGraded",
      correct: server.freshCorrect,
      assisted: false,
      verified: true,
    });
    flow = advanceBreakerFlow(flow, { type: "closed" });
  }
  if (server.easyItemId || server.easyUnavailable) {
    flow = advanceBreakerFlow(flow, { type: "easyRequested" });
  }
  if (server.easyUnavailable) flow = advanceBreakerFlow(flow, { type: "easyUnavailable" });
  return {
    triggerAttemptId: server.triggerAttemptId,
    recoveryAvailable: true,
    triggerItemId: server.triggerItemId,
    triggerNodeKey: "node",
    domain: server.runKey,
    missStreak: 3,
    flow,
    repairStepIndex: server.repairStepIndex,
    freshItemId: server.freshItemId,
    easyItemId: server.easyItemId,
    confirmedLifecycle: server.recorded,
  };
}

// ─── The simulated server: results FROM emitted commands ─────────────────

function triggerFor(itemId: string): string {
  return `t:${itemId}`;
}

function resultsFor(entryState: PoolEntry, world: World): PracticeEvent[] {
  const c = entryState.command;
  if (entryState.stage === "coachOpened") {
    return [
      { type: "server:lifecycleRecorded", id: c.id },
      { type: "server:lifecycleFailed", id: c.id },
    ];
  }
  switch (c.kind) {
    case "loadRun":
      return [
        {
          type: "run:loaded",
          id: c.id,
          itemCount: 2,
          itemId: `${c.inputKey}-0`,
          scopeKey: c.inputKey,
          dayKey: "d",
        },
        { type: "run:loadFailed", id: c.id },
      ];
    case "submitAnswer": {
      const itemId = c.entry.itemId;
      const out: PracticeEvent[] = [];
      if (itemId.startsWith("fresh:")) {
        out.push(
          {
            type: "server:submitSucceeded",
            id: c.id,
            result: { correct: true, breakerRecoveryVerified: true },
          },
          { type: "server:submitSucceeded", id: c.id, result: { correct: false } },
        );
      } else if (itemId.startsWith("easy:")) {
        out.push(
          { type: "server:submitSucceeded", id: c.id, result: { correct: true } },
          { type: "server:submitSucceeded", id: c.id, result: { correct: false } },
        );
      } else {
        out.push(
          { type: "server:submitSucceeded", id: c.id, result: { correct: true } },
          { type: "server:submitSucceeded", id: c.id, result: { correct: false } },
        );
        // The server opens an episode on a threshold miss — only when none is
        // live (it refuses to stack them).
        if (!world.server || world.server.terminal) {
          for (const initialRepairStatus of ["opening", "done"] as const) {
            out.push({
              type: "server:submitSucceeded",
              id: c.id,
              result: {
                correct: false,
                backOff: {
                  triggerAttemptId: triggerFor(itemId),
                  triggerNodeKey: "node",
                  domain: world.hostKey,
                  missStreak: 3,
                  recoveryAvailable: true,
                  initialRepairStatus,
                  repairStepIndex: initialRepairStatus === "done" ? 0 : null,
                },
              },
            });
          }
        }
      }
      out.push(
        { type: "server:submitQueued", id: c.id, queuedCount: 1 },
        { type: "server:submitFailed", id: c.id, submissionReplay: false },
      );
      return out;
    }
    case "gradeLocally":
      return [
        { type: "local:graded", id: c.id, correct: true },
        { type: "local:graded", id: c.id, correct: false },
      ];
    case "gradeProvisionally":
      // The host installs exactly the verdict it was handed.
      return [
        { type: "local:provisionalGraded", id: c.id, correct: c.correct, entry: c.entry },
      ];
    case "serveHintRung": {
      // What the web host dispatches (hooks/usePracticeMachine.ts): a rung, no
      // rung, or — for the scholar-pulled ladder only — a transport failure.
      const out: PracticeEvent[] = [
        {
          type: "server:hintServed",
          id: c.id,
          stepIndex: c.stepIndex,
          hasMore: true,
          rungKind: "completion",
        },
        {
          type: "server:hintServed",
          id: c.id,
          stepIndex: c.stepIndex,
          hasMore: false,
          rungKind: "reveal",
        },
        { type: "server:hintUnavailable", id: c.id },
      ];
      if (c.source === "ladder") out.push({ type: "server:commandFailed", id: c.id });
      return out;
    }
    case "recordBreakerLifecycle":
      return [
        { type: "server:lifecycleRecorded", id: c.id },
        { type: "server:lifecycleFailed", id: c.id },
      ];
    case "launchCoach":
      // Host order: presentation first, then the durable write.
      return [{ type: "server:coachOpened", id: c.id }];
    case "serveBreakerFresh":
      return [
        {
          type: "server:breakerFreshServed",
          id: c.id,
          itemId: `fresh:${c.triggerAttemptId}`,
        },
        { type: "server:breakerFreshUnavailable", id: c.id },
      ];
    case "serveBreakerEasy":
      return [
        {
          type: "server:breakerEasyServed",
          id: c.id,
          itemId: c.expectedItemId ?? `easy:${c.triggerAttemptId}`,
        },
        { type: "server:breakerEasyUnavailable", id: c.id },
        { type: "server:commandFailed", id: c.id },
      ];
    default:
      return [];
  }
}

type BackOff = NonNullable<
  Extract<PracticeEvent, { type: "server:submitSucceeded" }>["result"]["backOff"]
>;

function openedEpisode(world: World, itemId: string, backOff: BackOff): ServerEpisode {
  const done = backOff.initialRepairStatus === "done";
  return {
    triggerAttemptId: backOff.triggerAttemptId,
    triggerItemId: itemId,
    runKey: world.hostKey,
    // A prepared reveal rung was shown as part of the grading write.
    recorded: done ? ["repairShown"] : [],
    repairStepIndex: backOff.repairStepIndex,
    freshItemId: null,
    freshCorrect: null,
    easyItemId: null,
    easyUnavailable: false,
    terminal: false,
  };
}

/** The server's own bookkeeping when it answers a command (authoritative,
 *  whether or not the reducer accepts the answer). */
function serverAfter(world: World, command: PracticeCommand, event: PracticeEvent): ServerEpisode | null {
  const server = world.server;
  if (event.type === "server:submitSucceeded" && command.kind === "submitAnswer") {
    if (event.result.backOff) return openedEpisode(world, command.entry.itemId, event.result.backOff);
    if (!server || server.terminal) return server;
    const itemId = command.entry.itemId;
    // Terminal = a correct fresh result, or the easy item graded.
    if (itemId === server.freshItemId && server.freshCorrect === null) {
      return { ...server, freshCorrect: event.result.correct, terminal: event.result.correct };
    }
    if (itemId === server.easyItemId) return { ...server, terminal: true };
    return server;
  }
  if (!server || server.terminal) return server;
  const own = (id: string) => id.startsWith(`breaker:${server.triggerAttemptId}:`);
  switch (event.type) {
    case "server:lifecycleRecorded": {
      if (!own(event.id)) return server;
      const op: BreakerLifecycleOperation | null =
        command.kind === "recordBreakerLifecycle"
          ? command.operation
          : command.kind === "launchCoach"
            ? "coachEscalated"
            : null;
      return op && !server.recorded.includes(op)
        ? { ...server, recorded: [...server.recorded, op] }
        : server;
    }
    case "server:hintServed":
      return own(event.id) ? { ...server, repairStepIndex: event.stepIndex } : server;
    case "server:breakerFreshServed":
      return own(event.id) ? { ...server, freshItemId: event.itemId } : server;
    case "server:breakerEasyServed":
      return own(event.id) ? { ...server, easyItemId: event.itemId } : server;
    case "server:breakerEasyUnavailable":
      return own(event.id) ? { ...server, easyUnavailable: true, terminal: true } : server;
    default:
      return server;
  }
}

// ─── What the hosts would let a scholar (or the host) do ─────────────────

/** The web/native `busy` gate (PracticeSession.tsx / practice.tsx `busy`),
 *  minus host-only flags. */
function busy(s: PracticeState): boolean {
  const b = s.breaker;
  const easyLoading =
    !!b &&
    (b.flow.easy === undefined || b.flow.easy === "requested") &&
    b.easyItemId !== s.item.itemId &&
    b.emitted.includes(breakerCommandId(b.triggerAttemptId, "easy"));
  return (
    s.item.phase.kind === "submitting" ||
    s.hint.pendingCommandId !== null ||
    easyLoading ||
    (b?.lifecycle.pending.length ?? 0) > 0 ||
    s.run.pendingLoad !== null
  );
}

function onBreakerItem(s: PracticeState): boolean {
  const b = s.breaker;
  return (
    !!b &&
    s.item.itemId !== null &&
    (s.item.itemId === b.freshItemId || s.item.itemId === b.easyItemId)
  );
}

function uiEvents(s: PracticeState): Array<{ label: string; events: PracticeEvent[] }> {
  const out: Array<{ label: string; events: PracticeEvent[] }> = [];
  const b = s.breaker;
  if (s.terminal) return out;

  if (s.lane === "handoff") {
    if (b) out.push({ label: "coach ended", events: [{ type: "lane:coachEnded" }] });
    else {
      out.push({
        label: "handoff closed → advance",
        events: [{ type: "lane:handoffClosed", outcome: "advance", itemId: `${s.run.inputKey}-${s.run.idx + 1}` }],
      });
      out.push({
        label: "handoff closed → retry",
        events: [{ type: "lane:handoffClosed", outcome: "retry-same" }],
      });
    }
    return out;
  }
  if (s.lane) {
    out.push({ label: "lane exited", events: [{ type: "lane:exited" }] });
    return out;
  }

  if (b?.lifecycle.pending[0]?.status === "recoverable") {
    out.push({ label: "retry lifecycle", events: [{ type: "ui:retryBreakerLifecycle" }] });
  }
  if (busy(s)) return out;

  const phase = s.item.phase.kind;
  const itemOnScreen = !b || onBreakerItem(s);
  if (itemOnScreen && s.item.itemId && (phase === "answering" || phase === "retry")) {
    const id =
      s.item.clientEventId ??
      `${s.item.itemId}/${s.item.missCount}/${s.item.hasRecorded ? 1 : 0}`;
    const e = entry(s.item.itemId, id);
    out.push({
      label: `submit ${s.item.itemId}`,
      events: [{ type: "ui:submit", answer: e.answer, clientEventId: id, entry: e }],
    });
    // A Fast math round checks bare facts on the client first; the server may
    // still disagree (both results are generated from the submit it emits).
    if (s.run.suppressBreaker && s.mode === "live") {
      for (const provisionalCorrect of [true, false]) {
        out.push({
          label: `submit ${s.item.itemId} (provisional ${provisionalCorrect})`,
          events: [
            { type: "ui:submit", answer: e.answer, clientEventId: id, entry: e, provisionalCorrect },
          ],
        });
      }
    }
    if (!b && s.mode === "live") {
      out.push({ label: "hint", events: [{ type: "ui:hintPressed" }] });
    }
  }
  if (s.item.confirming) {
    // What the hosts send for Next / Try again tapped before confirmation.
    out.push({ label: "hold next", events: [{ type: "ui:hold", action: "advance" }] });
    out.push({ label: "hold retry", events: [{ type: "ui:hold", action: "retry" }] });
  }
  if (!b && (phase === "feedback" || phase === "queued")) {
    out.push({
      label: "next",
      events: [{ type: "ui:advance", nextItemId: `${s.run.inputKey}-${s.run.idx + 1}` }],
    });
    if (phase === "feedback" && s.item.phase.kind === "feedback" && !s.item.phase.correct) {
      out.push({ label: "retry", events: [{ type: "ui:retry" }] });
      if (s.mode === "live") {
        out.push({ label: "talk it through", events: [{ type: "lane:entered", lane: "handoff" }] });
      }
    }
  }
  if (b) {
    if (onBreakerItem(s) && (phase === "feedback" || phase === "queued")) {
      out.push({ label: "finish breaker item", events: [{ type: "ui:breakerClose" }] });
    }
    if (b.flow.stage === "close") {
      out.push({ label: "breaker close", events: [{ type: "ui:breakerClose" }] });
    }
    const controls = breakerControls(b.flow);
    const offered = [controls.primary, ...controls.peers];
    if (offered.includes("coach")) {
      out.push({ label: "breaker coach", events: [{ type: "ui:breakerCoach" }] });
    }
    if (offered.includes("easyFinish")) {
      out.push({ label: "easy finish", events: [{ type: "ui:breakerEasyFinish" }] });
    }
    if (offered.includes("checkStep")) {
      out.push({ label: "repair started", events: [{ type: "ui:breakerRepairStarted" }] });
      out.push({ label: "repair completed", events: [{ type: "ui:breakerRepairCompleted" }] });
    }
  }
  return out;
}

/** Whether the scholar has something to do right now (the liveness target). */
function scholarCanAct(s: PracticeState): boolean {
  if (s.terminal || s.lane !== null) return true;
  const b = s.breaker;
  if (b?.lifecycle.pending[0]?.status === "recoverable") return true;
  if (busy(s)) return false;
  const phase = s.item.phase.kind;
  const answerable = phase !== "submitting" && s.item.itemId !== null;
  if (!b) return answerable || s.run.failedInputKey !== null;
  if (b.flow.stage === "fresh" || b.flow.stage === "easy") {
    // An item stage: the answer surface owns the CTA, so it needs the item.
    return onBreakerItem(s) && answerable;
  }
  const controls = breakerControls(b.flow);
  return b.flow.stage === "close" || controls.primary !== null || controls.peers.length > 0;
}

// ─── Successors ──────────────────────────────────────────────────────────

/**
 * How results may be ordered.
 *   "domain-fifo" — the reducer's own contract (`CommandDomain`): FIFO within a
 *     domain, anything goes across domains and for domain-less commands.
 *   "host-fifo" — what the shipped hosts actually do: both hooks drain one
 *     committed batch at a time and `practiceCoordinator.executeAll` awaits
 *     each command in turn, so a mount has ONE command in flight and results
 *     arrive in emission order.
 * A violation that needs "domain-fifo" is a reducer that leans on host
 * ordering it does not declare; one that survives "host-fifo" is live.
 */
type Transport = "domain-fifo" | "host-fifo";

function successors(
  world: World,
  transport: Transport,
  onStep: (edge: Edge, steps: StepRecord[]) => void,
): void {
  const s = world.machine;

  for (const ui of uiEvents(s)) {
    const steps: StepRecord[] = [];
    onStep({ label: ui.label, kind: "ui", events: ui.events, world: applyEvents(world, ui.events, steps) }, steps);
  }

  world.pool.forEach((pooled, index) => {
    const domain = domainOf(pooled.command);
    const queuedBehind =
      transport === "host-fifo"
        ? index > 0
        : domain !== null &&
          world.pool.some((other, j) => j < index && domainOf(other.command) === domain);
    if (queuedBehind) return;
    for (const event of resultsFor(pooled, world)) {
      const steps: StepRecord[] = [];
      const server = serverAfter(world, pooled.command, event);
      const pool: PoolEntry[] =
        event.type === "server:coachOpened"
          ? world.pool.map((p, i) => (i === index ? { ...p, stage: "coachOpened" } : p))
          : pooled.replay
            ? world.pool.map((p, i) => (i === index ? { ...p, stage: "out", replay: false } : p))
            : world.pool.filter((_, i) => i !== index);
      const label = `${pooled.replay ? "(replayed) " : ""}${describe_(event)}`;
      onStep(
        { label, kind: "result", events: [event], world: applyEvents({ ...world, server, pool }, [event], steps) },
        steps,
      );
    }
  });

  // The shared breaker-projection effect.
  const server = world.server;
  const applies = !!server && !server.terminal && server.runKey === world.hostKey;
  if (applies && s.mode === "live") {
    const events: PracticeEvent[] = [
      { type: "hydrate:breaker", inputKey: world.hostKey, episode: projection(server) },
    ];
    const steps: StepRecord[] = [];
    onStep({ label: "host: hydrate projection", kind: "host", events, world: applyEvents(world, events, steps) }, steps);
  } else if (!applies) {
    const events: PracticeEvent[] = [
      { type: "hydrate:noBreakerForRun" },
      { type: "run:inputsChanged", inputKey: world.hostKey },
    ];
    const steps: StepRecord[] = [];
    onStep({ label: `host: no episode for run → inputsChanged(${world.hostKey})`, kind: "host", events, world: applyEvents(world, events, steps) }, steps);
  }

  // The scholar navigates to another run (a `?domain=` change), or reloads.
  const other = world.hostKey === "A" ? "B" : "A";
  onStep({ label: `navigate to ${other}`, kind: "nav", events: [], world: { ...world, hostKey: other } }, []);
  // Hosts send reload only from a finished run ("Practice again"), a
  // placement completing, or the load-error screen — never mid-item.
  if (!s.breaker && s.run.pendingLoad === null && (s.terminal || s.run.failedInputKey !== null)) {
    const events: PracticeEvent[] = [{ type: "run:reloadRequested" }];
    const steps: StepRecord[] = [];
    onStep({ label: "reload", kind: "nav", events, world: applyEvents(world, events, steps) }, steps);
  }
}

function describe_(event: PracticeEvent): string {
  switch (event.type) {
    case "server:submitSucceeded":
      return `submitSucceeded(${event.id}, correct=${event.result.correct}${event.result.backOff ? `, backOff ${event.result.backOff.initialRepairStatus}` : ""})`;
    case "server:hintServed":
      return `hintServed(${event.id}, ${event.rungKind}, hasMore=${event.hasMore})`;
    case "run:loaded":
      return `run:loaded(${event.id}, ${event.scopeKey})`;
    default:
      return "id" in event ? `${event.type}(${event.id})` : event.type;
  }
}

// ─── Invariants ──────────────────────────────────────────────────────────

type Check = (edge: Edge, steps: StepRecord[], from: World) => string | null;

function freshIssuanceAuthorized(step: StepRecord): string | null {
  for (const command of step.commands) {
    if (command.kind !== "serveBreakerFresh") continue;
    const b = step.after.breaker;
    const confirmed: readonly BreakerLifecycleOperation[] = b?.lifecycle.confirmed ?? [];
    const recordsSupport =
      confirmed.includes("repairCompleted") || confirmed.includes("coachEscalated");
    if (!recordsSupport) return `serveBreakerFresh emitted with confirmed=[${confirmed.join(",")}]`;
    if (step.after.lane === "handoff") return "serveBreakerFresh emitted while the coach lane is on screen";
  }
  return null;
}

const INVARIANTS: Record<string, Check> = {
  // practiceMachine.ts BreakerState.lifecycle.pending: "Ordered durable intent.
  // Only the head may be emitted, so later progression can never overtake an
  // unacknowledged lifecycle write."
  lifecycleHeadOnly: (_edge, steps) => {
    for (const step of steps) {
      const b = step.after.breaker;
      if (b) {
        const inFlight = b.lifecycle.pending.filter((p) => p.status !== "queued");
        if (inFlight.length > 1) return `${inFlight.length} lifecycle ops in flight`;
        if (inFlight.length === 1 && b.lifecycle.pending[0] !== inFlight[0]) {
          return `in-flight lifecycle op ${inFlight[0]!.operation} is not the queue head`;
        }
      }
      const lifecycle = step.commands.filter(
        (c) => c.kind === "recordBreakerLifecycle" || c.kind === "launchCoach",
      );
      if (lifecycle.length > 1) return `one step emitted ${lifecycle.length} lifecycle writes`;
      const head = b?.lifecycle.pending[0];
      for (const c of lifecycle) {
        if (!b || !head || breakerCommandId(b.triggerAttemptId, head.operation) !== c.id) {
          return `emitted lifecycle ${c.id} that is not the queue head`;
        }
      }
    }
    return null;
  },

  // practiceMachine.ts `gradeLocally`: "Rehearse only: … the machine emits NO
  // durable command at all" (and DURABLE_COMMAND_KINDS: "In rehearse mode the
  // reducer must never emit one of these").
  rehearseNeverDurable: (_edge, steps) => {
    for (const step of steps) {
      if (step.before.mode !== "rehearse") continue;
      const durable = step.commands.filter(isDurableCommand);
      if (durable.length > 0) return `rehearse emitted ${durable.map((c) => c.kind).join(",")}`;
    }
    return null;
  },

  // practiceMachine.ts `server:breakerFreshServed`: a duplicate "after the
  // fresh item was graded would otherwise reset the item to un-recorded and let
  // it be answered again"; practiceLoop.ts `breakerFreshReconstructable`: once
  // graded, "reconstructing then would be a regrade".
  freshNeverRegraded: (_edge, steps) => {
    for (const step of steps) {
      const before = step.before.breaker;
      const after = step.after.breaker;
      if (!before?.flow.fresh) continue;
      // The verdict is `correct`. `verified` is not compared: the server's
      // projection reports every recorded fresh result as verified
      // (`breakerFlowFromLifecycle`), so a re-hydrate legitimately flips a
      // missed item's flag without regrading it.
      if (after?.triggerAttemptId === before.triggerAttemptId) {
        if (after.flow.fresh?.correct !== before.flow.fresh.correct) {
          return `graded fresh ${JSON.stringify(before.flow.fresh)} became ${JSON.stringify(after.flow.fresh)}`;
        }
      }
      if (step.commands.some((c) => c.kind === "serveBreakerFresh" && c.triggerAttemptId === before.triggerAttemptId)) {
        return "serveBreakerFresh re-emitted after the fresh item was graded";
      }
    }
    return null;
  },

  // practiceMachine.ts `recordBreakerOutcome`: "emitted once when the episode
  // reaches its close" (and breakerCommands: "send the staff-facing outcome
  // row once").
  outcomeAtMostOnce: (_edge, steps, from) => {
    const seen = new Set(from.machine.breaker?.emitted ?? []);
    for (const step of steps) {
      for (const c of step.commands) {
        if (c.kind !== "recordBreakerOutcome") continue;
        if (seen.has(c.id)) return `recordBreakerOutcome ${c.id} emitted twice`;
        seen.add(c.id);
      }
    }
    return null;
  },

  // practiceMachine.ts breakerCommands: "The episode is over: send the
  // staff-facing outcome row once." An episode whose recovery was won must not
  // be dropped from the machine before that row is emitted.
  outcomeNotLost: (_edge, steps) => {
    for (const step of steps) {
      const b = step.before.breaker;
      if (!b?.flow.fresh?.correct) continue;
      if (step.after.breaker?.triggerAttemptId === b.triggerAttemptId) continue;
      // Leaving for another run (or an explicit reload) before tapping Finish
      // is the accepted trade-off: keeping the card there re-creates TRA-342.
      if (step.event.type === "run:reloadRequested") continue;
      if (
        step.event.type === "run:inputsChanged" &&
        step.event.inputKey !== (b.runKey ?? step.before.run.inputKey)
      ) {
        continue;
      }
      const outcomeId = breakerCommandId(b.triggerAttemptId, "outcome");
      const emitted =
        b.emitted.includes(outcomeId) || step.commands.some((c) => c.id === outcomeId);
      if (!emitted) return `${step.event.type} dropped a won episode before recordBreakerOutcome`;
    }
    return null;
  },

  // practiceMachine.ts `breakerDomain`: "the server refuses a recovery session
  // until the lifecycle has recorded support, so issuance must never overtake
  // the write that authorizes it"; breakerCommands: "Coach-open is not
  // coach-complete" (never serve fresh while the coach chat is on screen).
  freshAfterRecordedSupport: (_edge, steps) => {
    for (const step of steps) {
      const problem = freshIssuanceAuthorized(step);
      if (problem) return problem;
    }
    return null;
  },

  // practiceMachine.ts `isAwaiting`: every server result is matched against an
  // awaited command; a phase/hint/load/lifecycle that is waiting must be
  // waiting on something that can still answer, or the busy gate never lifts
  // (the header: "a late async resolution must never strand a struggling kid").
  busyHasALiveResolver: (edge) => {
    const w = edge.world;
    const s = w.machine;
    const live = (id: string) => w.pool.some((p) => p.command.id === id);
    if (s.item.phase.kind === "submitting" && !live(s.item.phase.commandId)) {
      return `phase submitting on ${s.item.phase.commandId} with no outstanding command`;
    }
    if (s.hint.pendingCommandId && !live(s.hint.pendingCommandId)) {
      return `hint pending on ${s.hint.pendingCommandId} with no outstanding command`;
    }
    if (s.run.pendingLoad && !live(s.run.pendingLoad.id)) {
      return `load pending on ${s.run.pendingLoad.id} with no outstanding command`;
    }
    const b = s.breaker;
    const head = b?.lifecycle.pending[0];
    if (b && head?.status === "pending" && !live(breakerCommandId(b.triggerAttemptId, head.operation))) {
      return `lifecycle ${head.operation} pending with no outstanding write`;
    }
    return null;
  },

  // practiceMachine.ts `hydrate:noBreakerForRun`: "Without this, breaker state
  // outlived the episode on a mounted screen and `run:inputsChanged` refused
  // every load for as long as the component stayed mounted."
  noEpisodeNeverRefusesTheRun: (edge) => {
    if (edge.kind !== "host" || edge.events[0]?.type !== "hydrate:noBreakerForRun") return null;
    const s = edge.world.machine;
    const key = edge.world.hostKey;
    // A breaker this mount already settled (its result is in, the close card
    // is up) stays on ITS run until the scholar closes it; anything else must
    // be gone.
    if (s.breaker) {
      const settled =
        s.breaker.flow.fresh?.correct === true ||
        (s.breaker.flow.easy !== undefined && s.breaker.flow.easy !== "requested");
      if (settled && s.breaker.runKey === key) return null;
      return settled
        ? `settled breaker for ${s.breaker.runKey} kept over run ${key}`
        : "breaker survived hydrate:noBreakerForRun";
    }
    const served =
      s.run.inputKey === key ||
      s.run.pendingLoad !== null || // the host re-sends once it settles
      s.run.failedInputKey === key || // reload button
      s.run.allMapping;
    return served ? null : `run:inputsChanged(${key}) refused with inputKey=${s.run.inputKey}`;
  },
};

// ─── The explorer ────────────────────────────────────────────────────────

type Node = { world: World; depth: number; parent: string | null; label: string; expanded: boolean };
type Violation = { trace: string[]; detail: string };

function hashWorld(world: World): string {
  const pool = world.pool.map((p) => [p.command.id, p.stage, p.replay]);
  return JSON.stringify([world.machine, pool, world.server, world.hostKey]);
}

function traceTo(nodes: Map<string, Node>, hash: string): string[] {
  const labels: string[] = [];
  let cursor: string | null = hash;
  while (cursor) {
    const node: Node = nodes.get(cursor)!;
    labels.unshift(node.label);
    cursor = node.parent;
  }
  return labels;
}

type Exploration = {
  states: number;
  transitions: number;
  capped: boolean;
  violations: Map<string, Violation>;
  stuck: Violation | null;
};

function explore(
  seeds: Array<{ label: string; world: World }>,
  transport: Transport,
  maxDepth: number,
): Exploration {
  const nodes = new Map<string, Node>();
  const violations = new Map<string, Violation>();
  const resolverEdges = new Map<string, string[]>();
  let frontier: string[] = [];
  let transitions = 0;
  let capped = false;
  for (const seed of seeds) {
    const hash = hashWorld(seed.world);
    if (nodes.has(hash)) continue;
    nodes.set(hash, { world: seed.world, depth: 0, parent: null, label: `seed: ${seed.label}`, expanded: false });
    frontier.push(hash);
  }
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const hash of frontier) {
      const node = nodes.get(hash)!;
      node.expanded = true;
      const outs: string[] = [];
      successors(node.world, transport, (edge, steps) => {
        transitions++;
        const target = hashWorld(edge.world);
        const trace = () => [...traceTo(nodes, hash), edge.label];
        for (const [name, check] of Object.entries(INVARIANTS)) {
          if (violations.has(name)) continue;
          const detail = check(edge, steps, node.world);
          if (detail) violations.set(name, { trace: trace(), detail });
        }
        // Liveness resolves only through edges nobody has to choose: server
        // results and the host's automatic projection effect.
        if (edge.kind === "result" || edge.kind === "host") outs.push(target);
        if (!nodes.has(target)) {
          if (nodes.size >= MAX_STATES) {
            capped = true;
            return;
          }
          nodes.set(target, { world: edge.world, depth: depth + 1, parent: hash, label: edge.label, expanded: false });
          next.push(target);
        }
      });
      resolverEdges.set(hash, outs);
    }
    frontier = next;
  }

  // Liveness within the bound: a state is fine if the scholar can act, or some
  // automatic edge leads to a fine state. Unexpanded (frontier) states are
  // unknown, and so are given the benefit of the doubt.
  const fine = new Set<string>();
  for (const [hash, node] of nodes) {
    if (!node.expanded || scholarCanAct(node.world.machine)) fine.add(hash);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [hash, outs] of resolverEdges) {
      if (fine.has(hash)) continue;
      if (outs.some((target) => fine.has(target))) {
        fine.add(hash);
        changed = true;
      }
    }
  }
  let stuck: Violation | null = null;
  for (const [hash, node] of nodes) {
    if (fine.has(hash)) continue;
    const trace = traceTo(nodes, hash);
    if (!stuck || trace.length < stuck.trace.length) {
      stuck = { trace, detail: stuckDetail(node.world.machine) };
    }
  }
  return { states: nodes.size, transitions, capped, violations, stuck };
}

function stuckDetail(s: PracticeState): string {
  return JSON.stringify({
    phase: s.item.phase,
    itemId: s.item.itemId,
    hint: s.hint.pendingCommandId,
    load: s.run.pendingLoad,
    breaker: s.breaker && {
      stage: s.breaker.flow.stage,
      fresh: s.breaker.flow.fresh,
      freshItemId: s.breaker.freshItemId,
      pending: s.breaker.lifecycle.pending,
    },
  });
}

// ─── Seeds ───────────────────────────────────────────────────────────────

function loadedRun(mode: "live" | "rehearse", suppressBreaker = false): PracticeState {
  const base = newPracticeState({ scholarId: SCHOLAR, itemCount: 0, mode, suppressBreaker });
  const requested = practiceReduce(base, { type: "run:inputsChanged", inputKey: "A" });
  const load = requested.commands[0]!;
  return practiceReduce(requested.state, {
    type: "run:loaded",
    id: load.id,
    itemCount: 2,
    itemId: "A-0",
    scopeKey: "A",
    dayKey: "d",
  }).state;
}

function worldFrom(machine: PracticeState, commands: PracticeCommand[], server: ServerEpisode | null): World {
  return { machine, pool: withEmitted([], commands), server, hostKey: "A" };
}

const TRIGGER = triggerFor("A-0");

function serverEpisode(over: Partial<ServerEpisode> = {}): ServerEpisode {
  return {
    triggerAttemptId: TRIGGER,
    triggerItemId: "A-0",
    runKey: "A",
    recorded: [],
    repairStepIndex: null,
    freshItemId: null,
    freshCorrect: null,
    easyItemId: null,
    easyUnavailable: false,
    terminal: false,
    ...over,
  };
}

function triggeredSeed(): World {
  const e = entry("A-0", "A-0/0/0");
  const run = runPracticeEvents(loadedRun("live"), [
    { type: "ui:submit", answer: e.answer, clientEventId: e.clientEventId, entry: e },
    {
      type: "server:submitSucceeded",
      id: submitCommandId(e.clientEventId),
      result: {
        correct: false,
        backOff: {
          triggerAttemptId: TRIGGER,
          triggerNodeKey: "node",
          domain: "A",
          missStreak: 3,
          recoveryAvailable: true,
          initialRepairStatus: "opening",
          repairStepIndex: null,
        },
      },
    },
  ]);
  return worldFrom(
    run.state,
    run.commands.filter((c) => c.kind !== "submitAnswer"),
    serverEpisode(),
  );
}

/** A cold mount: a new reducer hydrated from the server's projection. */
function hydratedSeed(server: ServerEpisode): World {
  const step = practiceReduce(newPracticeState({ scholarId: SCHOLAR, itemCount: 0 }), {
    type: "hydrate:breaker",
    inputKey: server.runKey,
    episode: projection(server),
  });
  return worldFrom(step.state, step.commands, server);
}

const SEEDS = [
  { label: "live run", world: worldFrom(loadedRun("live"), [], null) },
  { label: "rehearse run", world: worldFrom(loadedRun("rehearse"), [], null) },
  { label: "fast math run", world: worldFrom(loadedRun("live", true), [], null) },
  { label: "triggered breaker", world: triggeredSeed() },
  {
    label: "cold mount, repair open",
    world: hydratedSeed(serverEpisode({ recorded: ["repairShown"], repairStepIndex: 0 })),
  },
  {
    label: "cold mount, fresh pinned",
    world: hydratedSeed(
      serverEpisode({
        recorded: ["repairShown", "repairCompleted"],
        repairStepIndex: 0,
        freshItemId: `fresh:${TRIGGER}`,
      }),
    ),
  },
];

// ─── The checks ──────────────────────────────────────────────────────────

/**
 * Invariants the explorer currently breaks on master. Each is `it.fails`, so CI
 * stays green AND flips red the day a fix lands (delete the entry then).
 *
 * outcomeNotLost — FIXED. It found that a won recovery lost its close card
 * and staff outcome row when the projection cleared (#3966), and then that the
 * first fix still lost them on a COLD mount: `run.inputKey` is null there, so
 * the host's same-run `inputsChanged` looked like a different run. The breaker
 * now records the run it belongs to (`runKey`, passed on `hydrate:breaker`).
 *
 * freshNeverRegraded — FIXED (TRA-376). With the spiral-breaker fresh item on
 * screen, an in-place `?domain=` round trip (noBreakerForRun → load for B fails
 * → back to A → hydrate) rebuilt the breaker with an empty `emitted` and
 * re-issued the pinned item; its result was accepted over the scholar's
 * in-flight answer, the first grade was dropped as stale, and the next
 * projection flipped a win back to a miss. `server:breakerFreshServed` now
 * leaves an item that is already on screen alone (a cold mount has no copy of
 * it, so it is still installed). Targeted check (c) below.
 *
 * busyHasALiveResolver (domain-fifo ONLY) — shortest counterexample (depth 10):
 *   seed: triggered breaker
 *   server:hintUnavailable(breaker:t:A-0:repairServe)
 *   server:lifecycleRecorded(breaker:t:A-0:repairUnavailable)
 *   navigate to B
 *   host: no episode for run → inputsChanged(B)
 *   run:loaded(ui:3, B)
 *   submit B-0
 *   navigate to A
 *   host: hydrate projection
 *   (replayed) server:coachOpened(breaker:t:A-0:coachEscalated)
 *   submitSucceeded(submit:B-0/0/0, correct=true)
 * `hydrate:breaker` installs A's episode over B's in-flight answer, the
 * auto-coach opens the handoff lane, and the lane gate drops the grade: the
 * item is left `submitting` with nothing outstanding to release it (until a
 * breaker item replaces it). It needs `run:loaded` and the B-0 grade to
 * overtake the still-in-flight `launchCoach` write — impossible on the shipped
 * hosts, which run one command at a time, so host-fifo holds. The reducer
 * leans on that host-side ordering; it is now the documented contract on
 * `CommandDomain` (`shared/practiceMachine.ts`), not an undeclared
 * assumption — this domain-fifo-only counterexample is expected to stay red
 * (TRA-377, option B: document the contract, no reducer change). Targeted
 * check (a) below.
 */
const KNOWN_HOST = new Set<string>();
const KNOWN_DOMAIN = new Set(["busyHasALiveResolver"]);

function describeExploration(
  transport: Transport,
  maxDepth: number,
  known: ReadonlySet<string>,
): void {
  describe(`practice reducer, bounded exploration (${transport}, depth ${maxDepth})`, () => {
    let result: Exploration;
    let elapsedMs = 0;
    const report = (name: string): string => {
      const v = name === "liveness" ? result.stuck : result.violations.get(name);
      return v ? `${name}: ${v.detail}\n  ${v.trace.join("\n  ")}` : "";
    };

    beforeAll(() => {
      const t0 = performance.now();
      result = explore(SEEDS, transport, maxDepth);
      elapsedMs = performance.now() - t0;
      if (process.env.PRACTICE_EXPLORE_VERBOSE) {
        console.info(
          `[${transport}] explored ${result.states} states / ${result.transitions} transitions in ${Math.round(elapsedMs)}ms (depth ${maxDepth}${result.capped ? ", CAPPED" : ""})`,
        );
        for (const name of [...Object.keys(INVARIANTS), "liveness"]) {
          const text = report(name);
          if (text) console.info(text);
        }
      }
      // Above the 20s budget asserted below, so that assertion is the guard
      // and a slower CI runner fails with a message rather than a hook timeout.
    }, 30_000);

    it("explores a non-trivial space inside its budget", () => {
      // Guards the harness itself: a refactor that collapses the alphabet (say,
      // every UI event gated off) would otherwise pass every check vacuously.
      expect(result.states).toBeGreaterThan(5_000);
      expect(result.capped).toBe(false);
      expect(elapsedMs).toBeLessThan(20_000);
    });

    for (const name of [...Object.keys(INVARIANTS), "liveness"]) {
      const isKnown = known.has(name);
      (isKnown ? it.fails : it)(`${isKnown ? "KNOWN VIOLATION" : "holds"}: ${name}`, () => {
        const found = name === "liveness" ? result.stuck : result.violations.get(name);
        expect(found ?? undefined, report(name)).toBeUndefined();
      });
    }
  });
}

describeExploration("host-fifo", 12, KNOWN_HOST);
describeExploration("domain-fifo", 10, KNOWN_DOMAIN);

// ─── Targeted checks for suspected findings ──────────────────────────────

describe("suspected findings, replayed as exact traces", () => {
  const backOff = {
    triggerAttemptId: "attempt-1",
    triggerNodeKey: "node-1",
    domain: "A",
    missStreak: 3,
    recoveryAvailable: true,
    initialRepairStatus: "opening" as const,
    repairStepIndex: null,
  };
  const liveOnA = () => loadedRun("live");

  function submit(state: PracticeState, itemId: string, clientEventId: string) {
    const e = entry(itemId, clientEventId);
    return practiceReduce(state, {
      type: "ui:submit",
      answer: e.answer,
      clientEventId,
      entry: e,
    });
  }

  function lifecycleId(commands: PracticeCommand[]): string {
    const c = commands.find(
      (x) => x.kind === "recordBreakerLifecycle" || x.kind === "launchCoach",
    );
    expect(c).toBeDefined();
    return c!.id;
  }

  /** Trigger on A-0, reveal rung served, both lifecycle writes acknowledged:
   *  the step that emits `serveBreakerFresh` (the existing suite's shape). */
  function freshIssued() {
    const submitted = submit(liveOnA(), "A-0", "evt-1");
    const triggered = practiceReduce(submitted.state, {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-1"),
      result: { correct: false, backOff },
    });
    const shown = practiceReduce(triggered.state, {
      type: "server:hintServed",
      id: breakerCommandId("attempt-1", "repairServe"),
      stepIndex: 0,
      hasMore: false,
      rungKind: "reveal",
    });
    const shownRecorded = practiceReduce(shown.state, {
      type: "server:lifecycleRecorded",
      id: lifecycleId(shown.commands),
    });
    const issued = practiceReduce(shownRecorded.state, {
      type: "server:lifecycleRecorded",
      id: lifecycleId(shownRecorded.commands),
    });
    expect(issued.commands.map((c) => c.kind)).toContain("serveBreakerFresh");
    return practiceReduce(issued.state, {
      type: "server:breakerFreshServed",
      id: breakerCommandId("attempt-1", "fresh"),
      itemId: "fresh-1",
    }).state;
  }

  /** Trigger on A-0 with no repair rung, auto-coach queued; navigate to B and
   *  load it; answer B-0; navigate back to A while B-0 is in flight so the
   *  host hydrates A's episode over it. Returns the state right after the
   *  hydrate, which re-emits `launchCoach` behind the in-flight submit. */
  function coachHydratedOverInFlightAnswer(): PracticeState {
    const submitted = submit(liveOnA(), "A-0", "evt-1");
    let s = runPracticeEvents(submitted.state, [
      {
        type: "server:submitSucceeded",
        id: submitCommandId("evt-1"),
        result: { correct: false, backOff },
      },
      { type: "server:hintUnavailable", id: breakerCommandId("attempt-1", "repairServe") },
      {
        type: "server:lifecycleRecorded",
        id: breakerCommandId("attempt-1", "repairUnavailable"),
      },
    ]).state;
    const toB = runPracticeEvents(s, [
      { type: "hydrate:noBreakerForRun" },
      { type: "run:inputsChanged", inputKey: "B" },
    ]);
    const load = toB.commands.find((c) => c.kind === "loadRun")!;
    s = practiceReduce(toB.state, {
      type: "run:loaded",
      id: load.id,
      itemCount: 2,
      itemId: "B-0",
      scopeKey: "B",
      dayKey: "d",
    }).state;
    s = submit(s, "B-0", "evt-b").state;
    const back = practiceReduce(s, {
      type: "hydrate:breaker",
      episode: {
        triggerAttemptId: "attempt-1",
        triggerItemId: "A-0",
        triggerNodeKey: "node-1",
        domain: "A",
        missStreak: 3,
        flow: advanceBreakerFlow(newBreakerFlow(), { type: "repairUnavailable" }),
        repairStepIndex: null,
        freshItemId: null,
        easyItemId: null,
        confirmedLifecycle: ["repairUnavailable"],
      },
    });
    expect(back.commands.map((c) => c.kind)).toContain("launchCoach");
    expect(back.state.item.phase.kind).toBe("submitting");
    return back.state;
  }

  // (a) HOLDS on the shipped hosts. The lane gate at the top of `practiceReduce`
  // does drop `server:submit*` results, but every DIRECT lane entry is
  // host-gated off while submitting (talk-it-through and TeachingStep render
  // only in feedback and are disabled on `busy`; the mapping lane replaces
  // `ui:submit`; the dialogue lane opens before any submit). The only route
  // the explorer found is a breaker hydrated over an in-flight answer whose
  // auto-coach opens the handoff lane — and on web and native the coach
  // launch is emitted AFTER that submit and the coordinator runs one command
  // at a time (`CommandDomain` in `shared/practiceMachine.ts`), so the grade
  // always lands first.
  it("(a) in host order, a coach hydrated over an in-flight answer keeps its grade", () => {
    const graded = practiceReduce(coachHydratedOverInFlightAnswer(), {
      type: "server:submitSucceeded",
      id: submitCommandId("evt-b"),
      result: { correct: true },
    }).state;
    const coached = practiceReduce(graded, {
      type: "server:coachOpened",
      id: breakerCommandId("attempt-1", "coachEscalated"),
    }).state;
    expect(coached.lane).toBe("handoff");
    expect(coached.item.phase).toEqual({ kind: "feedback", correct: true });
  });

  // The same trace with the coach overtaking the grade (the domain-fifo
  // explorer's busyHasALiveResolver counterexample) used to be carried here as
  // a known `it.fails` — the reducer alone does drop the grade and strands the
  // item in `submitting` under that ordering. TRA-377 (option B, Andy
  // 2026-09-27): that ordering cannot occur on either shipped host — both
  // serialize commands strictly one-at-a-time via `executeAll`, regardless of
  // domain — so the reducer is not fixed to also handle it. Removed rather
  // than kept red: it exercised an ordering the contract above now documents
  // as unreachable, not a live violation. The in-contract case is test (a)
  // above; the still-relevant out-of-contract counterexample lives in the
  // domain-fifo explorer (`KNOWN_DOMAIN`, "busyHasALiveResolver") so it stays
  // visible if that host-side guarantee is ever loosened.

  function wonFreshThen(events: PracticeEvent[]) {
    const fresh = freshIssued();
    return runPracticeEvents(submit(fresh, "fresh-1", "evt-fresh").state, [
      {
        type: "server:submitSucceeded",
        id: submitCommandId("evt-fresh"),
        result: { correct: true, breakerRecoveryVerified: true },
      },
      ...events,
    ]);
  }

  it("(b) control: closing a won recovery records its outcome", () => {
    const closed = wonFreshThen([{ type: "ui:breakerClose" }]);
    expect(closed.commands.map((c) => c.kind)).toContain("recordBreakerOutcome");
  });

  // (b) FIXED (#3966 + the run key on hydrate:breaker). Was: a
  // correct fresh answer makes the episode terminal server-side, so
  // `activeBreakerEpisode` returns null and PracticeSession.tsx:1261 / native
  // practice.tsx:1582 send `hydrate:noBreakerForRun` + a same-key
  // `run:inputsChanged` — typically before the scholar taps Finish. The breaker
  // is gone, `ui:breakerClose` no-ops, and the staff outcome row never goes out.
  it("(b) a won recovery still records its outcome when the projection clears first", () => {
    const closed = wonFreshThen([
      { type: "hydrate:noBreakerForRun" },
      { type: "run:inputsChanged", inputKey: "A" },
      { type: "ui:breakerClose" },
    ]);
    expect(closed.commands.map((c) => c.kind)).toContain("recordBreakerOutcome");
  });

  // (c) FIXED (TRA-376) — the host-fifo explorer's freshNeverRegraded trace, in
  // host order. With the fresh item on screen, an in-place `?domain=` round
  // trip (noBreakerForRun → load for B fails → back to A → hydrate) rebuilds
  // the breaker with an empty `emitted`, so the pinned item is re-issued. The
  // scholar answers before that re-issue returns; its result used to be
  // accepted (`flow.fresh` is still unset) and reset the item under the
  // in-flight answer, whose grade was then dropped as stale. The re-issue is
  // still emitted; its result now leaves the on-screen item alone.
  it("(c) re-issuing an on-screen fresh item never discards the answer in flight", () => {
    const fresh = freshIssued();
    const away = runPracticeEvents(fresh, [
      { type: "hydrate:noBreakerForRun" },
      { type: "run:inputsChanged", inputKey: "B" },
    ]);
    const load = away.commands.find((c) => c.kind === "loadRun")!;
    const failed = practiceReduce(away.state, { type: "run:loadFailed", id: load.id }).state;
    const repaired = advanceBreakerFlow(
      advanceBreakerFlow(newBreakerFlow(), { type: "repairOpened" }),
      { type: "repairDone" },
    );
    const back = practiceReduce(failed, {
      type: "hydrate:breaker",
      episode: {
        triggerAttemptId: "attempt-1",
        triggerItemId: "A-0",
        triggerNodeKey: "node-1",
        domain: "A",
        missStreak: 3,
        flow: advanceBreakerFlow(repaired, { type: "freshServed" }),
        repairStepIndex: 0,
        freshItemId: "fresh-1",
        easyItemId: null,
        confirmedLifecycle: ["repairShown", "repairCompleted"],
      },
    });
    expect(back.commands.map((c) => c.kind)).toContain("serveBreakerFresh");
    expect(back.state.item.itemId).toBe("fresh-1");
    const events: PracticeEvent[] = [
      {
        type: "server:breakerFreshServed",
        id: breakerCommandId("attempt-1", "fresh"),
        itemId: "fresh-1",
      },
      {
        type: "server:submitSucceeded",
        id: submitCommandId("evt-fresh"),
        result: { correct: true, breakerRecoveryVerified: true },
      },
    ];
    const answered = submit(back.state, "fresh-1", "evt-fresh").state;
    const graded = runPracticeEvents(answered, events).state;
    expect(graded.breaker?.flow.fresh?.correct).toBe(true);
  });
});

