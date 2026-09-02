/**
 * The host side of the practice machine: the piece that actually performs the
 * commands the reducer emits, and the only place mutual exclusion and ordering
 * live.
 *
 * This exists because the reducer deliberately does NOT provide either. The
 * split matters:
 *
 *   The reducer decides WHAT should happen and rejects stale results. It is
 *   pure, so a whole session replays from an event list.
 *
 *   This coordinator decides WHETHER THIS CALLER may start a command, and in
 *   what order. Both are synchronous decisions, and neither can be expressed as
 *   a React dispatch: under Strict Mode two effect invocations can both observe
 *   a command as un-started and both dispatch a "claim" before either reducer
 *   step commits. `tryClaim` closes that window by checking and inserting in one
 *   turn, with no `await` in between.
 *
 * Ordering is delegated, never re-implemented. Commands carrying a `domain` run
 * one-at-a-time within it via the SAME keyed mutex the outbox already uses, so
 * breaker fresh issuance cannot overtake the lifecycle write that authorizes it,
 * and resume snapshots cannot be written out of order. Commands with no domain
 * are ephemeral: independent, deduplicated by id, executed immediately, and
 * intentionally never replayed after process death.
 *
 * Lifetime. One coordinator per scholar, reference-counted. Releasing the last
 * reference detaches subscribers; it does NOT cancel already-started durable
 * work, which is idempotent and whose completion is observable through its own
 * durable source. A full page reload destroys this object outright — recovery
 * after that comes from the outbox, the server's breaker projection, and the
 * versioned resume snapshot, never from a resurrected in-memory ledger.
 */

import { createKeyedMutex } from "@/shared/practicePersistenceCore";
import type { CommandId, PracticeCommand } from "@/shared/practiceMachine";

export type CommandRunner = (command: PracticeCommand) => Promise<void>;

export type PracticeCoordinator = {
  readonly scholarId: string;
  /**
   * Synchronously claim the right to execute this command. Returns false if
   * another caller already holds it — the loser must do nothing at all, not
   * wait and retry, because the winner will dispatch the result.
   */
  tryClaim(id: CommandId): boolean;
  /** Release a claim so a later, genuinely new occurrence can run. */
  release(id: CommandId): void;
  /** Whether a command is currently claimed (diagnostics and tests). */
  isClaimed(id: CommandId): boolean;
  /** Resolve once the current owner releases this id (immediately if free). */
  waitForRelease(id: CommandId): Promise<void>;
  /**
   * Claim, then run through the command's ordering domain. Resolves to false
   * without running when the claim was refused. The claim is released once the
   * command settles, so a genuinely new occurrence of the same semantic id (a
   * later drain, say) can run again.
   */
  execute(command: PracticeCommand, run: CommandRunner): Promise<boolean>;
  /** Execute a whole emitted list in order. Returns ids refused because another
   *  mount currently owns their claim, so this caller can leave a waiting state. */
  executeAll(
    commands: readonly PracticeCommand[],
    run: CommandRunner,
  ): Promise<readonly CommandId[]>;
  retain(): void;
  /** Returns true when this coordinator can be forgotten: no references AND no
   *  in-flight executions. Work outlives the component that started it. */
  release_(): boolean;
  /** Diagnostics and tests. */
  readonly inFlight: number;
};

function createCoordinator(scholarId: string): PracticeCoordinator {
  const claimed = new Set<CommandId>();
  const releaseWaiters = new Map<CommandId, Set<() => void>>();
  const ordered = createKeyedMutex();
  let refs = 0;
  let running = 0;
  /** Set when the last reference drops while work is still running, so the
   *  registry entry is removed once that work settles rather than being
   *  orphaned. */
  let disposeWhenIdle = false;

  const coordinator: PracticeCoordinator = {
    scholarId,

    tryClaim(id) {
      // Check-and-insert in ONE synchronous turn. Any `await` here would
      // reopen the double-execution window this method exists to close.
      if (claimed.has(id)) return false;
      claimed.add(id);
      return true;
    },

    release(id) {
      claimed.delete(id);
      const waiters = releaseWaiters.get(id);
      if (waiters) {
        releaseWaiters.delete(id);
        for (const resolve of waiters) resolve();
      }
    },

    isClaimed(id) {
      return claimed.has(id);
    },

    waitForRelease(id) {
      if (!claimed.has(id)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const waiters = releaseWaiters.get(id) ?? new Set<() => void>();
        waiters.add(resolve);
        releaseWaiters.set(id, waiters);
      });
    },

    async execute(command, run) {
      if (!coordinator.tryClaim(command.id)) return false;
      const domain = "domain" in command ? command.domain : null;
      running += 1;
      try {
        if (domain) {
          await ordered(domain, () => run(command));
        } else {
          // Ephemeral: no ordering domain by design.
          await run(command);
        }
        return true;
      } finally {
        coordinator.release(command.id);
        running -= 1;
        if (running === 0 && disposeWhenIdle && refs === 0) {
          coordinators.delete(scholarId);
        }
      }
    },

    async executeAll(commands, run) {
      const seen = new Set<CommandId>();
      const refused: CommandId[] = [];
      for (const command of commands) {
        // React Strict Mode may evaluate the hook reducer twice before one
        // commit. The state result is discarded once, but a ref-backed emitted
        // queue can still contain the same semantic command twice. Collapse
        // duplicates within this one committed batch; a later batch may reuse
        // the id after this execution settles (for example, a reconnect drain).
        if (seen.has(command.id)) continue;
        seen.add(command.id);
        if (!(await coordinator.execute(command, run))) {
          refused.push(command.id);
        }
      }
      return refused;
    },

    retain() {
      refs += 1;
    },

    release_() {
      refs = Math.max(0, refs - 1);
      if (refs > 0) return false;
      if (running > 0) {
        // Unmounting mid-flight must NOT hand the next mount a fresh claim
        // registry and mutex — that would let the same command, or a later one
        // in the same ordering domain, run concurrently with work still going.
        disposeWhenIdle = true;
        return false;
      }
      return true;
    },

    get inFlight() {
      return running;
    },
  };

  return coordinator;
}

/**
 * One coordinator per scholar for this JS runtime — which is exactly the
 * concurrency domain that matters, since there is no cross-process writer. A
 * second browser tab is a separate runtime: it stays correctness-safe through
 * the server's `clientEventId` dedup, but the app assumes a single active
 * practice tab and does not attempt cross-tab coordination.
 */
const coordinators = new Map<string, PracticeCoordinator>();

export function acquirePracticeCoordinator(scholarId: string): PracticeCoordinator {
  let coordinator = coordinators.get(scholarId);
  if (!coordinator) {
    coordinator = createCoordinator(scholarId);
    coordinators.set(scholarId, coordinator);
  }
  coordinator.retain();
  return coordinator;
}

/**
 * Drop one reference. In-flight durable work is deliberately left running: it
 * is idempotent, and cancelling a submit mid-flight is precisely how an answer
 * goes missing.
 */
export function releasePracticeCoordinator(scholarId: string): void {
  const coordinator = coordinators.get(scholarId);
  if (!coordinator) return;
  if (coordinator.release_()) coordinators.delete(scholarId);
}

/** Test seam: forget every coordinator. Never called by app code. */
export function __resetPracticeCoordinators(): void {
  coordinators.clear();
}
