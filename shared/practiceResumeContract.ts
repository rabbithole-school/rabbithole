/**
 * The framework-agnostic "ordinary-run resume snapshot" contract — one
 * definition of what gets persisted, what makes a persisted run still valid,
 * and where it's read/saved/cleared. Built on `practicePersistenceCore.ts`'s
 * adapter contract; web and native each supply their own
 * `KeyValueStorageAdapter` (localStorage / expo-file-system) and otherwise run
 * this exact logic.
 *
 * A practice run is served as a deterministic set of stem-only items (see
 * convex/lib/practice/session.ts): the itemId encodes `skillKey#seed`, and
 * grading re-derives the answer server-side — no answer ever reaches the
 * client. The engine deliberately persists NO per-run state; the seed +
 * position live only in ephemeral memory (React state on both surfaces). So
 * leaving mid-block (Home) or a reload/relaunch would otherwise regenerate a
 * fresh random seed at position 0 and lose the scholar's place. This snapshots
 * the served items (no answers) + the next-unanswered position so re-entry
 * resumes exactly there — grading stays entirely server-authoritative.
 *
 * Validity is now THREE-WAY: `inputKey` (which mode/domain/skillKeys this run
 * was served for), `scopeKey` (the server-canonical Practice-scope
 * fingerprint — see convex/lib/practice/mathPlan.ts's `practiceScopeKey`), and
 * `dayKey` (the institution-local calendar day the run was served on — see
 * shared/institutionDay.ts's `dayKeyForTimezone`). All three must match the
 * CURRENT server state or the snapshot is discarded and a fresh run is
 * served — never an invented wall-clock timer.
 */

import {
  readJsonOrThrow,
  removeKey,
  writeJson,
  type KeyValueStorageAdapter,
  type PersistOutcome,
} from "./practicePersistenceCore";

/** A persisted in-progress practice run. `TItem`/`TSegment`/`TLaunchpad` are
 *  the caller's own served-item / segment / Launchpad shapes — kept generic so
 *  this contract stays decoupled from either surface's component types. */
export type ResumeSnapshot<TItem = unknown, TSegment = unknown, TLaunchpad = unknown> = {
  /** The session-inputs fingerprint the run was served for (mode, domain,
   *  skillKeys, …) — a client-computed value, unchanged from the original
   *  web-only store. A restore only applies when this equals the CURRENT
   *  inputs, so a different mode never resumes another mode's run. */
  inputKey: string;
  /** The server-canonical Practice-scope fingerprint at serve time. A scope
   *  change (a new Math plan, a standing assignment edit) invalidates the
   *  snapshot even when `inputKey` is unchanged — resuming into content the
   *  scholar is no longer scoped to would be silently wrong. */
  scopeKey: string;
  /** The institution-local calendar day (`YYYY-MM-DD`) the run was served on.
   *  A day rollover invalidates the snapshot — never an invented 24-hour
   *  timer; this is the SAME day boundary the server's own daily bookkeeping
   *  uses. */
  dayKey: string;
  /** The served items (stems only — no answers), exactly as rendered. */
  items: TItem[];
  /** Playlist-segment run-lengths, so beats stay aligned on resume. */
  segments: TSegment[];
  /** The next un-answered index = count of already-recorded items. */
  resumeIdx: number;
  /** The run's Launchpad, if it had one. Persisted so a doorway the scholar
   *  has not reached yet survives a leave-and-return. */
  launchpad?: TLaunchpad | null;
  /** Option D: the ceremony state of an all-mapping ("Math Check-In") sit, so
   *  a resumed all-mapping run keeps its warm header instead of reverting to
   *  a plain playlist. */
  allMapping?: boolean;
  /** Server-authoritative count already recorded before this run loaded. */
  mappingProgressOffset?: number;
  mappedDomainLabel?: string | null;
  savedAt: number;
};

/**
 * The invariant-safe resume position: the number of items already RECORDED to
 * mastery, which is the index of the first un-recorded item. On a fresh item
 * (`hasRecorded === false`) that's `idx`; once the current item has been
 * graded, it's `idx + 1`, so a resume skips the already-recorded item rather
 * than re-serving (and re-recording) it.
 */
export function resumePosition(idx: number, hasRecorded: boolean): number {
  return idx + (hasRecorded ? 1 : 0);
}

/**
 * The authoritative next-item index for a resumed run, derived ONLY from the
 * server-recorded position (never a client-remembered `idx` that could have
 * drifted from what was actually recorded). Returns `null` once the recorded
 * item was the last one in the run — there is nothing left to resume INTO,
 * and the caller must treat that as "run finished", not "resume item 0".
 *
 * Throws on a position that could not possibly come from THIS run — a
 * negative/non-integer index, or a recorded index at/past `itemCount` (stale
 * server state referring to a run that no longer matches the served items) —
 * so a caller never silently resumes into a wrong or invented position.
 */
export function authoritativeResumeIndex(
  recordedIndex: number,
  itemCount: number,
): number | null {
  if (
    !Number.isInteger(recordedIndex) ||
    recordedIndex < 0 ||
    !Number.isInteger(itemCount) ||
    itemCount <= recordedIndex
  ) {
    throw new Error("Recorded practice position is outside the active run");
  }
  const nextIndex = recordedIndex + 1;
  return nextIndex < itemCount ? nextIndex : null;
}

/**
 * The canonical `scopeKey` sentinel for a Quick Facts run. Quick Facts has no
 * server-side Practice-scope fingerprint of its own (it isn't a Math-plan
 * scoped run), so both the client (deciding what `scopeKey` to snapshot/
 * compare) and the server (validating a resume/replay against the SAME
 * three-way key) must agree on one fixed literal rather than each side
 * inventing its own — this constant is that single source of truth.
 */
export const QUICK_FACTS_SCOPE_KEY = "quick-facts";

/** The current server/client state a persisted snapshot is validated
 *  against. All three must match for a restore to apply. */
export type ResumeValidityContext = {
  inputKey: string;
  scopeKey: string;
  dayKey: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRawSnapshot(value: unknown): value is ResumeSnapshot {
  return (
    isPlainObject(value) &&
    "items" in value &&
    "resumeIdx" in value &&
    "inputKey" in value &&
    Array.isArray((value as { items: unknown }).items)
  );
}

/**
 * Whether a loaded snapshot should be restored for the CURRENT context. True
 * only for a genuine mid-run position: matching inputKey/scopeKey/dayKey, a
 * non-empty item set, and a position strictly inside the run (past item 1,
 * before the end — item 1 untouched has nothing to restore, and an
 * at/after-end position is a finished run).
 *
 * A snapshot saved before this three-way validation shipped has no
 * `scopeKey`/`dayKey` at all (`undefined`) and is treated as stale — it can
 * never accidentally match a real key, so it is always discarded rather than
 * silently resumed into unvalidated content.
 */
export function isResumableSnapshot<TItem, TSegment, TLaunchpad>(
  snap: ResumeSnapshot<TItem, TSegment, TLaunchpad> | null,
  current: ResumeValidityContext,
): snap is ResumeSnapshot<TItem, TSegment, TLaunchpad> {
  return (
    !!snap &&
    snap.inputKey === current.inputKey &&
    snap.scopeKey === current.scopeKey &&
    snap.dayKey === current.dayKey &&
    Array.isArray(snap.items) &&
    snap.items.length > 0 &&
    Number.isInteger(snap.resumeIdx) &&
    snap.resumeIdx > 0 &&
    snap.resumeIdx < snap.items.length
  );
}

function resumeStorageKey(scholarId: string): string {
  return `rh-practice-resume:${scholarId}`;
}

/** Reads the persisted run for one scholar. A confirmed-missing key (never
 *  saved, or durably cleared) resolves to `null` — nothing was lost. Corrupt
 *  or unreadable storage (bad JSON, a value that fails shape validation, or
 *  the adapter itself failing) REJECTS instead — the caller must not treat
 *  "storage is broken" as "there was never a run to resume". */
export async function loadResumeSnapshot<
  TItem = unknown,
  TSegment = unknown,
  TLaunchpad = unknown,
>(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
): Promise<ResumeSnapshot<TItem, TSegment, TLaunchpad> | null> {
  return readJsonOrThrow(adapter, resumeStorageKey(scholarId), isRawSnapshot) as Promise<
    ResumeSnapshot<TItem, TSegment, TLaunchpad> | null
  >;
}

/** Persists the in-progress run (overwriting any prior snapshot). Returns an
 *  explicit outcome — a caller MUST NOT claim the run is resumable on a
 *  failed write. */
export async function saveResumeSnapshot<TItem, TSegment, TLaunchpad = unknown>(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
  snap: ResumeSnapshot<TItem, TSegment, TLaunchpad>,
): Promise<PersistOutcome> {
  return writeJson(adapter, resumeStorageKey(scholarId), snap);
}

/** Drops the snapshot (run finished/expired, or an explicit fresh load /
 *  restart). Explicit outcome; a failed clear is a harmless degradation the
 *  caller may choose to ignore (a stale snapshot only resumes when its
 *  inputKey/scopeKey/dayKey AND position all still validate). */
export async function clearResumeSnapshot(
  adapter: KeyValueStorageAdapter,
  scholarId: string,
): Promise<PersistOutcome> {
  return removeKey(adapter, resumeStorageKey(scholarId));
}
