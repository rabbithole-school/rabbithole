"use client";

/**
 * Re-entry durability for the practice drill. A practice run is served as a
 * deterministic set of stem-only items (convex/lib/practice/session.ts: the
 * itemId encodes `skillKey#seed`, and grading re-derives the answer server-side
 * — no answer ever reaches the client). The engine deliberately persists NO
 * per-run state; the seed + position live only in ephemeral React state
 * (PracticeSession.tsx: `seedRef`, `idx`). So leaving mid-block (Home) or a
 * reload remounts the component with a fresh random seed at position 0 → the
 * whole block regenerates as "item 1 of N" and the scholar's place is lost.
 *
 * This snapshots the in-progress run to `localStorage` so re-entry restores the
 * SAME served items at the SAME position — the exact sibling pattern of
 * lib/practiceOfflineQueue.ts (which already persists in-flight answers here).
 * It stores no answers (the items are the same answer-free `ServedItem`s already
 * on the client) and no scheduler state, so it can never fake a grade or move
 * mastery — grading stays server-authoritative.
 *
 * Invariant: `resumeIdx` is the count of ALREADY-RECORDED items (see
 * `resumePosition`), i.e. the first un-recorded item — so resuming never
 * re-serves or re-records an item, and fluency is never minted twice.
 */

/** A persisted in-progress practice run. `TItem`/`TSegment` are the caller's
 *  own served-item / segment shapes (PracticeSession's local types) — kept
 *  generic so this store stays decoupled from the component. */
export type ResumeSnapshot<TItem = unknown, TSegment = unknown, TLaunchpad = unknown> = {
  /** The session-inputs fingerprint the run was served for. A restore only
   *  applies when this equals the CURRENT inputs, so a different mode (a
   *  problem set, a tune-up, a different domain blend) never resumes another
   *  mode's run. */
  inputKey: string;
  /** The served items (stems only — no answers), exactly as rendered. */
  items: TItem[];
  /** Playlist-segment run-lengths, so beats stay aligned on resume. */
  segments: TSegment[];
  /** The next un-answered index = count of already-recorded items. */
  resumeIdx: number;
  /** The run's Launchpad, if it had one (`{at, entry}` -- see
   *  convex/lib/practice/instructionEntries.ts). Persisted so a doorway the
   *  scholar has not reached yet survives a leave-and-return; the render gate is
   *  `idx === at`, so an already-passed doorway simply never re-opens. Typed
   *  loosely here to keep this store decoupled from the practice types. */
  launchpad?: TLaunchpad | null;
  /** Option D (F6a): the ceremony state of an all-mapping ("Math Check-In") sit,
   *  so a resumed 100% mapping run keeps its warm header instead of reverting to
   *  a plain playlist. `mappedDomainLabel` preserves a domain that finished
   *  placing BEFORE the scholar left, so the Done beat stays truthful on resume. */
  allMapping?: boolean;
  /** Server-authoritative count already recorded before this run loaded. */
  mappingProgressOffset?: number;
  mappedDomainLabel?: string | null;
  savedAt: number;
};

function storageKey(scholarId: string): string {
  return `rh-practice-resume:${scholarId}`;
}

/**
 * The invariant-safe resume position: the number of items already RECORDED to
 * mastery, which is the index of the first un-recorded item. On a fresh item
 * (`hasRecorded === false`) that's `idx`; once the current item has been graded
 * (feedback / retry / handoff / offline-queued — all set `hasRecorded`), it's
 * `idx + 1`, so a resume skips the already-recorded item rather than re-serving
 * (and re-recording) it.
 */
export function resumePosition(idx: number, hasRecorded: boolean): number {
  return idx + (hasRecorded ? 1 : 0);
}

/**
 * Whether a loaded snapshot should be restored for the current session inputs.
 * True only for a genuine mid-run position: same inputs, a non-empty item set,
 * and a position strictly inside the run (past item 1, before the end — item 1
 * untouched has nothing to restore, and an at/after-end position is a finished
 * run).
 */
export function isResumable<TItem, TSegment, TLaunchpad>(
  snap: ResumeSnapshot<TItem, TSegment, TLaunchpad> | null,
  currentInputKey: string,
): snap is ResumeSnapshot<TItem, TSegment, TLaunchpad> {
  return (
    !!snap &&
    snap.inputKey === currentInputKey &&
    Array.isArray(snap.items) &&
    snap.items.length > 0 &&
    Number.isInteger(snap.resumeIdx) &&
    snap.resumeIdx > 0 &&
    snap.resumeIdx < snap.items.length
  );
}

/** Reads the persisted run for one scholar. Safe on the server (SSR). */
export function loadResume<TItem = unknown, TSegment = unknown, TLaunchpad = unknown>(
  scholarId: string,
): ResumeSnapshot<TItem, TSegment, TLaunchpad> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(scholarId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "items" in parsed &&
      "resumeIdx" in parsed &&
      "inputKey" in parsed
    ) {
      return parsed as ResumeSnapshot<TItem, TSegment, TLaunchpad>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persists the in-progress run (overwriting any prior snapshot). */
export function saveResume<TItem, TSegment, TLaunchpad = unknown>(
  scholarId: string,
  snap: ResumeSnapshot<TItem, TSegment, TLaunchpad>,
): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(scholarId), JSON.stringify(snap));
  } catch {
    // Storage can throw (Safari private mode, quota). Losing the snapshot is an
    // acceptable degradation — it only costs a regenerated run, never a grade.
  }
}

/** Drops the snapshot (run finished, or an explicit fresh load / restart). */
export function clearResume(scholarId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(storageKey(scholarId));
  } catch {
    // See saveResume — a failed clear is harmless (a stale snapshot only
    // resumes when its inputKey matches AND its position is mid-run).
  }
}
