/**
 * The framework-agnostic offline-answer outbox contract. A submit made while
 * offline (or one that fails ambiguously mid-flight — the socket looked fine
 * a moment ago but the request never landed) can't be graded locally: the
 * correct answer is server-only (anti-offloading — see submitAnswer), so
 * there is no client-side verdict to fake. Instead the answer is queued
 * durably and replayed through the exact same mutation once connectivity is
 * back, carrying the SAME `clientEventId` from the first logical submit
 * through every retry so the server's idempotent-replay guard (`submitAnswer`
 * dedup by `clientEventId`) makes a lost-ack replay safe rather than a
 * duplicate attempt.
 *
 * This is the direct generalization of the web-only `lib/practiceOfflineQueue.ts`
 * + `components/practice/rehearseZeroWrite.ts`'s `drainOfflineQueue`, lifted
 * onto the shared adapter contract so native gets the exact same durability
 * and replay semantics rather than a second, hand-mirrored implementation.
 *
 * Missing vs. unreadable, and why it matters here specifically: an empty
 * outbox and a CORRUPT outbox must never be confused. `loadOutbox` returns
 * `[]` only for a confirmed-missing key; unreadable/invalid storage rejects
 * instead. That is the difference between "there is genuinely nothing queued
 * — safe to start a fresh empty queue" and "something is queued but we can't
 * currently read it — enqueuing here would silently overwrite bytes that may
 * still hold a scholar's answer". `enqueueOutboxAnswer` therefore fails
 * closed (returns `null`, writes nothing) the moment the load fails, rather
 * than papering over the unreadable state with a fresh one-entry queue.
 */

import {
  createKeyedMutex,
  readJsonOrThrow,
  removeKey,
  writeJson,
  type KeyValueStorageAdapter,
  type PersistOutcome,
} from "./practicePersistenceCore";

/** Guards the compound "load → modify → save" sequences below (enqueue,
 *  drain) so two concurrent callers for the SAME scholar can never interleave
 *  and silently lose an answer — a single adapter-level write lock is not
 *  enough for that, since the load and the save are separate suspend points.
 *  Module-scoped: one JS runtime (one browser tab, one native app instance)
 *  shares one mutex, which is exactly the concurrency domain that matters
 *  here (there is no cross-process writer). */
const outboxLock = createKeyedMutex();

/** One queued (not-yet-acknowledged) practice answer. */
export type OutboxAnswer = {
  clientEventId: string;
  itemId: string;
  answer: string;
  /** Mirrors the `record` flag submitAnswer expects — false for a retry
   *  during the Socratic-handoff loop, so the scheduler isn't double-hit. */
  record: boolean;
  skillLabel: string;
  queuedAt: number;
  /** Predict-then-Check: the kid's optional pre-answer confidence, carried
   *  through the outage so the replayed submitAnswer logs the SAME
   *  prediction it would have online. Present only on a recorded first
   *  attempt where the chip was used. */
  predictedConfidence?: string;
  /** Preserve the server-authoritative breaker linkage across an outage. */
  breakerTriggerAttemptId?: string;
  breakerEasyTriggerAttemptId?: string;
  /** Quick Facts never opens the general-practice breaker surface. */
  suppressBreaker?: boolean;
  /** Ask the server to return the prepared first repair with a threshold miss. */
  prepareBreakerRepair?: boolean;
  /** Silent latency instrument, present only on a measurable recorded attempt. */
  latencyMs?: number;
  thinkTimeMs?: number;
  /** An honest "I don't know" submission (distinct from a wrong guess) — the
   *  scholar declined to answer rather than guessing. Carried through an
   *  outage/replay exactly like any other submitAnswer flag so a queued or
   *  barrier-submitted don't-know is never silently coerced into a guess.
   *  Mapping uses a separate placement path and never enters this outbox, so
   *  this flag only ever appears on general-practice/Quick-Facts entries. */
  dontKnow?: boolean;
  /** The replay mode used by the first server attempt. An ambiguous live
   *  failure persists `false`; new offline-first rows persist `true`. Rows from
   *  before this field existed default to `false`, which is compatible with an
   *  already-landed live attempt and cannot permanently wedge the FIFO. */
  submissionReplay?: boolean;
};

function outboxStorageKey(scholarId: string): string {
  return `rh-practice-offline-queue:${scholarId}`;
}

function isOutboxAnswer(value: unknown): value is OutboxAnswer {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.clientEventId === "string" &&
    typeof v.itemId === "string" &&
    typeof v.answer === "string" &&
    typeof v.record === "boolean" &&
    typeof v.skillLabel === "string" &&
    typeof v.queuedAt === "number" &&
    (v.submissionReplay === undefined ||
      typeof v.submissionReplay === "boolean") &&
    (v.dontKnow === undefined || typeof v.dontKnow === "boolean") &&
    (v.latencyMs === undefined || typeof v.latencyMs === "number") &&
    (v.thinkTimeMs === undefined || typeof v.thinkTimeMs === "number")
  );
}

function isOutboxArray(value: unknown): value is OutboxAnswer[] {
  return Array.isArray(value) && value.every(isOutboxAnswer);
}

/** Reads the persisted outbox for one scholar. A confirmed-missing key
 *  (never saved, or durably cleared once empty) resolves to `[]` — nothing
 *  was lost. Unreadable/invalid storage (bad JSON, a value that fails shape
 *  validation, or the adapter itself failing) REJECTS instead of silently
 *  reporting an empty queue — see the module doc for why that distinction is
 *  load-bearing here. */
export async function loadOutbox(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
): Promise<OutboxAnswer[]> {
  return (await readJsonOrThrow(adapter, outboxStorageKey(scholarId), isOutboxArray)) ?? [];
}

/** Persists the outbox (or clears the key entirely once it's empty). Explicit
 *  outcome — a caller must not advance/claim "queued" on a failed write. */
export async function saveOutbox(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
  outbox: OutboxAnswer[],
): Promise<PersistOutcome> {
  if (outbox.length === 0) {
    return removeKey(adapter, outboxStorageKey(scholarId));
  }
  return writeJson(adapter, outboxStorageKey(scholarId), outbox);
}

/**
 * Append one answer and durably persist. Returns the new outbox on success,
 * `null` when no mutation was performed — either because the write failed
 * durably, OR because the outbox couldn't be read in the first place
 * (unreadable/corrupt storage). The caller must NOT advance past the answer
 * (no "next item" navigation, no `hasRecorded`) until it sees a non-null
 * result. Critically: a failed READ never falls back to "treat it as empty
 * and enqueue anyway" — that would silently overwrite whatever bytes are
 * actually on disk with a lossy one-entry queue. Nothing is written in that
 * case; the existing (unreadable) bytes are left exactly as they were.
 */
export async function enqueueOutboxAnswer(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
  entry: OutboxAnswer,
): Promise<OutboxAnswer[] | null> {
  return outboxLock(scholarId, async () => {
    let existing: OutboxAnswer[];
    try {
      existing = await loadOutbox(adapter, scholarId);
    } catch {
      // Storage exists but couldn't be trusted — fail closed. No write call
      // is made, so whatever bytes are actually there are untouched.
      return null;
    }
    const next = [...existing, entry];
    const outcome = await saveOutbox(adapter, scholarId, next);
    return outcome.ok ? next : null;
  });
}

/** The base submit payload for one outbox-shaped answer — the exact shape
 *  the reconnect/retry path and the "submit live, fall back to the outbox"
 *  barrier both send to `submitAnswer`. `replay` is authoritative server
 *  behavior, so a queued retry preserves the first attempt's value. */
export type OutboxSubmitArgs = {
  scholarId: string;
  itemId: string;
  answer: string;
  clientEventId: string;
  record: boolean;
  replay: boolean;
  predictedConfidence?: OutboxAnswer["predictedConfidence"];
  breakerTriggerAttemptId?: OutboxAnswer["breakerTriggerAttemptId"];
  breakerEasyTriggerAttemptId?: OutboxAnswer["breakerEasyTriggerAttemptId"];
  suppressBreaker?: OutboxAnswer["suppressBreaker"];
  prepareBreakerRepair?: OutboxAnswer["prepareBreakerRepair"];
  dontKnow?: OutboxAnswer["dontKnow"];
  latencyMs?: OutboxAnswer["latencyMs"];
  thinkTimeMs?: OutboxAnswer["thinkTimeMs"];
};

/** Historical name for the payload used while draining. The `replay` value is
 *  the persisted first-attempt mode, not necessarily `true`. */
export type OutboxReplayArgs = OutboxSubmitArgs;

function buildSubmitArgs(
  scholarId: string,
  entry: OutboxAnswer,
  replay: boolean,
): OutboxSubmitArgs {
  return {
    scholarId,
    itemId: entry.itemId,
    answer: entry.answer,
    clientEventId: entry.clientEventId,
    record: entry.record,
    replay,
    ...(entry.predictedConfidence !== undefined
      ? { predictedConfidence: entry.predictedConfidence }
      : {}),
    ...(entry.breakerTriggerAttemptId
      ? { breakerTriggerAttemptId: entry.breakerTriggerAttemptId }
      : {}),
    ...(entry.breakerEasyTriggerAttemptId
      ? { breakerEasyTriggerAttemptId: entry.breakerEasyTriggerAttemptId }
      : {}),
    ...(entry.suppressBreaker !== undefined ? { suppressBreaker: entry.suppressBreaker } : {}),
    ...(entry.prepareBreakerRepair !== undefined
      ? { prepareBreakerRepair: entry.prepareBreakerRepair }
      : {}),
    ...(entry.dontKnow !== undefined ? { dontKnow: entry.dontKnow } : {}),
    ...(entry.latencyMs !== undefined ? { latencyMs: entry.latencyMs } : {}),
    ...(entry.thinkTimeMs !== undefined ? { thinkTimeMs: entry.thinkTimeMs } : {}),
  };
}

/**
 * The explicit outcome of one `drainOutbox` pass. Unlike the old `void`
 * return, a native bounded retry coordinator needs to tell "genuinely
 * nothing left to do" apart from "stopped early — try again", and needs a
 * remaining count to decide whether/how hard to keep retrying, all WITHOUT
 * waiting for a connectivity transition (the old signal a retry had to rely
 * on). `status: "unreadable"` is distinct from `"blocked"`: it means the load
 * at the START of this pass couldn't be trusted at all (so no remaining
 * count is knowable), whereas `"blocked"` means we successfully read SOME
 * entries and stopped partway through (submit or save failed), leaving a
 * known remaining count.
 */
export type DrainOutcome =
  | { status: "drained" }
  | { status: "cancelled"; remaining: number }
  | {
      status: "blocked";
      remaining: number;
      reason: "submit-failed" | "save-failed";
      error: unknown;
    }
  | { status: "unreadable"; error: unknown };

/**
 * Drain the persisted outbox through the real `submit` mutation once the
 * client is back online: replay in order, stop at the first failure (leaving
 * the rest queued — never drop an answer), persist progress after each
 * success, and only remove an entry once BOTH the submit resolved AND the
 * shrunk outbox was durably saved — a failed save re-attempts the same
 * (already-acknowledged, now idempotent-safe via `clientEventId`) entry next
 * drain rather than silently dropping it from memory only.
 */
export async function drainOutbox<T>(opts: {
  adapter: KeyValueStorageAdapter;
  scholarId: string;
  submit: (args: OutboxReplayArgs) => Promise<T>;
  isCancelled: () => boolean;
  onRemaining?: (count: number) => void;
  onSubmitted?: (result: T) => void;
}): Promise<DrainOutcome> {
  const { adapter, scholarId, submit, isCancelled, onRemaining, onSubmitted } = opts;
  // The whole drain (every iteration's load/submit/save) runs under ONE lock
  // acquisition for this scholar, so a concurrent enqueue can never read a
  // pre-drain snapshot and overwrite an in-flight shrink — it simply waits
  // its turn. Outbox sizes are tiny (a network blip's worth of answers), so
  // this costs a concurrent enqueue at most a few replay round-trips, never
  // an unbounded wait.
  return outboxLock(scholarId, async () => {
    let remaining: OutboxAnswer[];
    try {
      remaining = await loadOutbox(adapter, scholarId);
    } catch (error) {
      return { status: "unreadable", error };
    }
    if (remaining.length === 0) return { status: "drained" };
    for (const q of remaining) {
      if (isCancelled()) return { status: "cancelled", remaining: remaining.length };
      let result: T;
      try {
        result = await submit(
          buildSubmitArgs(
            scholarId,
            q,
            q.submissionReplay ?? true,
          ) as OutboxReplayArgs,
        );
      } catch (error) {
        return { status: "blocked", remaining: remaining.length, reason: "submit-failed", error };
      }
      if (!isCancelled()) onSubmitted?.(result);
      const next = remaining.slice(1);
      const outcome = await saveOutbox(adapter, scholarId, next);
      if (!outcome.ok) {
        return {
          status: "blocked",
          remaining: remaining.length,
          reason: "save-failed",
          error: outcome.error,
        };
      }
      remaining = next;
      if (!isCancelled()) onRemaining?.(remaining.length);
    }
    return { status: "drained" };
  });
}

/**
 * The explicit outcome of `submitWithOutboxBarrier`. `submitted` means the
 * live submit ran and resolved (nothing was queued); `queued` means the
 * answer is durably in the outbox instead (either because older entries were
 * already ahead of it, or because the live submit itself failed
 * ambiguously) — the caller treats this exactly like an offline submit;
 * `failed` means neither happened: storage couldn't be read, or the
 * durable enqueue itself failed, so the caller must not advance past the
 * answer at all.
 */
export type SubmitWithOutboxBarrierOutcome<T> =
  | { status: "submitted"; result: T }
  | { status: "queued"; queue: OutboxAnswer[]; count: number }
  | { status: "failed"; error: unknown };

/**
 * The ordering barrier a live submit must go through so it can never overtake
 * an older queued (not-yet-acknowledged) answer. Runs under the SAME
 * `outboxLock` as `enqueueOutboxAnswer`/`drainOutbox`, so this decision — "is
 * anything already queued ahead of me?" — and its consequence (append behind
 * it, or submit right now) are one atomic step; a concurrent drain or enqueue
 * can't interleave partway through.
 *
 * - Older entries queued: append the live answer behind them and return
 *   `queued` WITHOUT calling `submit` at all — replay order is what makes a
 *   lost-ack-then-retry safe, and letting a fresher live answer jump the
 *   queue would submit item 2 before item 1's outcome is known.
 * - Queue empty: submit live, still holding the lock. An ambiguous failure
 *   (the request didn't clearly land) is treated exactly like an offline
 *   submit — the SAME `entry` (same `clientEventId`) is durably enqueued so
 *   the next drain replays it, rather than losing it or silently retrying
 *   with a new id.
 * - If the outbox can't be read, or the durable enqueue itself fails, this
 *   returns `failed` — never silently drops into "submit anyway" or "assume
 *   queued when it wasn't durably written".
 */
export async function submitWithOutboxBarrier<T>(opts: {
  adapter: KeyValueStorageAdapter;
  scholarId: string;
  entry: OutboxAnswer;
  submit: (args: OutboxSubmitArgs) => Promise<T>;
}): Promise<SubmitWithOutboxBarrierOutcome<T>> {
  const { adapter, scholarId, entry, submit } = opts;
  return outboxLock(scholarId, async () => {
    let existing: OutboxAnswer[];
    try {
      existing = await loadOutbox(adapter, scholarId);
    } catch (error) {
      return { status: "failed", error };
    }
    if (existing.length > 0) {
      // This answer has not reached the server yet; its first attempt will be
      // the later queue drain, whose authoritative replay mode is true.
      const queuedEntry = {
        ...entry,
        submissionReplay: entry.submissionReplay ?? true,
      };
      const next = [...existing, queuedEntry];
      const outcome = await saveOutbox(adapter, scholarId, next);
      if (!outcome.ok) return { status: "failed", error: outcome.error };
      return { status: "queued", queue: next, count: next.length };
    }
    try {
      const submissionReplay = entry.submissionReplay ?? false;
      const result = await submit(
        buildSubmitArgs(scholarId, entry, submissionReplay),
      );
      return { status: "submitted", result };
    } catch {
      // Ambiguous mid-flight failure — the request may or may not have
      // landed server-side. Queue durably under the SAME clientEventId so a
      // subsequent drain safely replays (or no-ops via the server's
      // idempotent dedup guard) rather than losing the answer or minting a
      // fresh attempt.
      const queuedEntry = {
        ...entry,
        submissionReplay: entry.submissionReplay ?? false,
      };
      const outcome = await saveOutbox(adapter, scholarId, [queuedEntry]);
      if (!outcome.ok) return { status: "failed", error: outcome.error };
      return { status: "queued", queue: [queuedEntry], count: 1 };
    }
  });
}
