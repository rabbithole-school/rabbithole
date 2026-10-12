/**
 * The practice run's ITEM QUEUE, as one pure reducer shared by web and native.
 *
 * WHY THIS EXISTS. `components/practice/PracticeSession.tsx` and
 * `native/src/app/practice.tsx` each keep their own copy of the served-item
 * queue — `items`, the parallel `segments` run-length list, the mapping
 * progress offset + last-mapped-domain label, and the optional challenge /
 * stretch tails — as a fistful of separately-updated `useState` hooks. Every
 * load, append, replace, and tail-acceptance transition was hand-duplicated
 * across both ~6,000-line files (`appendMappingSegment` was even copy-pasted
 * verbatim). This file is that queue, extracted once.
 *
 * WHAT IT OWNS. Which items are queued, their playlist-segment grouping, the
 * mapping-sit progress counters, and the optional challenge/stretch tails —
 * the shapes `shared/practiceSegments.ts` and `convex/lib/practice/session.ts`
 * (`ServedItem`) describe. It does NOT own: the current position (`idx`) or
 * breaker/hint/lifecycle state (`shared/practiceMachine.ts` + its
 * `usePracticeMachine` host own that — this reducer is a sibling, not a
 * replacement), or verdict/phase/lane-local UI state (still per-host
 * `useState`; a follow-up slice).
 *
 * DESIGN CHOICE: a plain `(state, action) => state` reducer, not the
 * command-emitting shape `shared/practiceMachine.ts` uses. That file emits
 * commands because breaker sequencing has real asynchronous side effects to
 * coordinate (server round-trips, persistence writes, replay-safe retries).
 * Every transition here is a synchronous array/counter edit over data the
 * caller already has in hand — appending already-fetched items, swapping in
 * an already-served tail, replacing an already-fetched fresh variant. There is
 * nothing to sequence and nothing to replay, so a command layer would only
 * add ceremony. Callers that need to react to a transition (e.g. telling the
 * breaker/hint machine the item count changed) read the OLD state from the
 * hook's return value before dispatching — exactly the pattern the original
 * `useState` call sites already used ("capture `next`, then set state, then
 * tell the other machine about `next`").
 *
 * Framework-free (no React, no DOM) so it vendors byte-identically into the
 * native bundle (native/scripts/sync-vendor.js → native/vendor/shared/).
 * Imports only its own sibling `../practiceSegments` (the canonical `Segment`
 * type + kind union, already vendored).
 */

import type { Segment } from "../practiceSegments";

export type { Segment };

/**
 * The item-queue state. Generic over the caller's own served-item shape
 * (`TItem`) so this stays decoupled from either surface's `ServedItem` type —
 * the same shape `shared/practiceResumeContract.ts`'s `ResumeSnapshot` uses.
 * The reducer only ever appends/replaces/slices these arrays; it never reads
 * an item's fields.
 */
export type PracticeQueueState<TItem = unknown> = {
  /** The served run, in encounter order. `null` before the first load. */
  items: TItem[] | null;
  /** Playlist segments v1 — parallel run-length metadata over `items` (counts
   *  sum to `items.length` on the wire; see `shared/practiceSegments.ts`). */
  segments: Segment[];
  /** Option D: how many `· mapping` items this scholar has already answered
   *  in earlier recompositions of the SAME all-mapping sit, before this
   *  batch. Used to test the sit against the shared serving ceiling. */
  mappingProgressOffset: number;
  /** The label of a domain that FINISHED placing during this run (the last
   *  mapping answer that converged its domain) — drives the done-screen
   *  "Your tree just filled in ✨" moment. Reset by `reset`. */
  mappedDomainLabel: string | null;
  /** The OPTIONAL above-band challenge tail served alongside the required
   *  set, offered (never mixed in) on the done screen. */
  challengeItems: TItem[];
  /** Whether the scholar accepted the challenge tail and is now working it as
   *  its own labeled round. */
  inChallenge: boolean;
  /** The OPTIONAL "Go deeper" stretch tail — insight problems on nodes the
   *  scholar already owns, offered on the done screen. */
  stretchItems: TItem[];
  /** Whether the scholar accepted the stretch tail and is now working it as
   *  its own labeled round. */
  inStretch: boolean;
  /** True once ANY attempt (first try or retry) solved a stretch item this
   *  round — distinguishes "cracked it eventually" from "not this time" on
   *  the done wrap. Reset false whenever a fresh stretch round starts. */
  stretchCracked: boolean;
};

/** The state every run starts from, before the first load. Mirrors the
 *  original `useState` initializers exactly. */
export function initialQueueState<TItem = unknown>(): PracticeQueueState<TItem> {
  return {
    items: null,
    segments: [],
    mappingProgressOffset: 0,
    mappedDomainLabel: null,
    challengeItems: [],
    inChallenge: false,
    stretchItems: [],
    inStretch: false,
    stretchCracked: false,
  };
}

/** The full payload a `"loaded"` action installs — every load path (a
 *  restored resume snapshot, a quick-facts round, or an ordinary
 *  `practiceSession` serve) supplies every field explicitly, even one it
 *  knows is already at its default, so the reducer never has to guess a
 *  branch's intent from an omitted key. */
export type QueueLoadedPayload<TItem> = {
  items: TItem[];
  segments: Segment[];
  mappingProgressOffset: number;
  mappedDomainLabel: string | null;
  challengeItems: TItem[];
  stretchItems: TItem[];
};

export type QueueAction<TItem> =
  /** A fresh load is starting (`resetHostRun`/its native twin): clears the
   *  queue to "nothing loaded yet" and drops any in-progress tail round.
   *  Deliberately leaves `challengeItems`/`stretchItems` untouched — the
   *  original `useState` reset never cleared them either, because every
   *  `"loaded"` dispatch that follows always overwrites them anyway. */
  | { type: "reset" }
  /** A load resolved (any of the three serve paths): installs the served
   *  run wholesale. */
  | ({ type: "loaded" } & QueueLoadedPayload<TItem>)
  /** Option D's mapping-sit recomposition (F1): the served batch is
   *  exhausted and the sit continues, so the next probes are appended and
   *  folded into the trailing `· mapping` segment (or a new one starts). A
   *  no-op if the queue hasn't loaded yet or nothing was added. */
  | { type: "mappingBatchAppended"; added: TItem[] }
  /** "I used help" appended a fresh bare retry of the same skill later in
   *  the run (never interrupting the verdict just shown). A no-op before the
   *  first load. */
  | { type: "itemAppended"; item: TItem }
  /** Undoing a help-used admission withdraws exactly the item it appended —
   *  always the last item in the queue (the caller only dispatches this
   *  while that item is still ahead of the scholar). A no-op before the
   *  first load. */
  | { type: "lastItemWithdrawn" }
  /** Swap the item at `index` in place — a mapping "confirm before you cap"
   *  retry, or a fresh variant of the same skill after a stuck breaker. A
   *  no-op before the first load. */
  | { type: "itemReplacedAt"; index: number; item: TItem }
  /** Swap the WHOLE queue for exactly one item and drop segments — a breaker
   *  repair/fresh/easy install, or restoring a persisted breaker trigger-item
   *  payload after a relaunch. */
  | { type: "singleItemInstalled"; item: TItem }
  /** Accept the offered challenge tail: it becomes the run, the offer is
   *  cleared, and stale segments from the just-finished required set are
   *  dropped (the challenge round has no segment kind of its own). A no-op
   *  when nothing was offered. */
  | { type: "challengeAccepted" }
  /** Accept the offered stretch ("Go deeper") tail: it becomes the run, the
   *  offer is cleared, `stretchCracked` restarts false, and stale segments
   *  are dropped. A no-op when nothing was offered. */
  | { type: "stretchAccepted" }
  /** An attempt (first try or a retry) solved a stretch item this round. */
  | { type: "stretchCracked" }
  /** A mapping answer just converged a domain's placement. */
  | { type: "mappedDomainLabelSet"; label: string | null };

/**
 * Extend a run-length `segments` list with `count` more mapping items: grow
 * the trailing mapping segment if the run already ends in one (a seamless
 * continuation of the same `· mapping` beat), else append a fresh mapping
 * segment. Keeps the segment strip + beat headers aligned with appended items
 * (Option D F1 recomposition).
 *
 * Previously hand-duplicated verbatim in both hosts; now the one owner.
 */
export function appendMappingSegment(prev: Segment[], count: number): Segment[] {
  if (count <= 0) return prev;
  const last = prev[prev.length - 1];
  if (last && last.kind === "mapping") {
    return [...prev.slice(0, -1), { kind: "mapping", count: last.count + count }];
  }
  return [...prev, { kind: "mapping", count }];
}

/** Every item-queue transition. Pure: no I/O, no clock, no randomness — a
 *  whole run's queue state is reproducible from its action list. */
export function queueReducer<TItem>(
  state: PracticeQueueState<TItem>,
  action: QueueAction<TItem>,
): PracticeQueueState<TItem> {
  switch (action.type) {
    case "reset":
      return {
        ...state,
        items: null,
        segments: [],
        mappingProgressOffset: 0,
        mappedDomainLabel: null,
        inChallenge: false,
        inStretch: false,
        stretchCracked: false,
      };

    case "loaded":
      return {
        ...state,
        items: action.items,
        segments: action.segments,
        mappingProgressOffset: action.mappingProgressOffset,
        mappedDomainLabel: action.mappedDomainLabel,
        challengeItems: action.challengeItems,
        stretchItems: action.stretchItems,
      };

    case "mappingBatchAppended": {
      if (!state.items || action.added.length === 0) return state;
      return {
        ...state,
        items: [...state.items, ...action.added],
        segments: appendMappingSegment(state.segments, action.added.length),
      };
    }

    case "itemAppended": {
      if (!state.items) return state;
      return { ...state, items: [...state.items, action.item] };
    }

    case "lastItemWithdrawn": {
      if (!state.items || state.items.length === 0) return state;
      return { ...state, items: state.items.slice(0, -1) };
    }

    case "itemReplacedAt": {
      if (!state.items) return state;
      return {
        ...state,
        items: state.items.map((it, i) => (i === action.index ? action.item : it)),
      };
    }

    case "singleItemInstalled":
      return { ...state, items: [action.item], segments: [] };

    case "challengeAccepted": {
      if (state.challengeItems.length === 0) return state;
      return {
        ...state,
        items: state.challengeItems,
        challengeItems: [],
        inChallenge: true,
        segments: [],
      };
    }

    case "stretchAccepted": {
      if (state.stretchItems.length === 0) return state;
      return {
        ...state,
        items: state.stretchItems,
        stretchItems: [],
        inStretch: true,
        stretchCracked: false,
        segments: [],
      };
    }

    case "stretchCracked":
      return state.stretchCracked ? state : { ...state, stretchCracked: true };

    case "mappedDomainLabelSet":
      return { ...state, mappedDomainLabel: action.label };

    default: {
      // Exhaustiveness guard — a new action variant must be handled above.
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

// ─── Selectors ───────────────────────────────────────────────────────────
// `idx` (the current position) is owned by `shared/practiceMachine.ts`'s
// host, not this reducer, so selectors that need a position take it as an
// argument rather than reading it from `state`.

export function selectItems<TItem>(state: PracticeQueueState<TItem>): TItem[] | null {
  return state.items;
}

export function selectTotal<TItem>(state: PracticeQueueState<TItem>): number {
  return state.items?.length ?? 0;
}

export function selectCurrentItem<TItem>(
  state: PracticeQueueState<TItem>,
  idx: number,
): TItem | undefined {
  return state.items?.[idx];
}

/** `idx`/`total` for the progress bar / "N of M" copy — feed straight into
 *  `shared/practiceLoop.ts`'s `progressFraction`/`isLastItem`. */
export function selectProgress<TItem>(
  state: PracticeQueueState<TItem>,
  idx: number,
): { idx: number; total: number } {
  return { idx, total: state.items?.length ?? 0 };
}

export function selectIsInChallenge<TItem>(state: PracticeQueueState<TItem>): boolean {
  return state.inChallenge;
}

export function selectIsInStretch<TItem>(state: PracticeQueueState<TItem>): boolean {
  return state.inStretch;
}

export function selectHasChallengeOffer<TItem>(state: PracticeQueueState<TItem>): boolean {
  return state.challengeItems.length > 0;
}

export function selectHasStretchOffer<TItem>(state: PracticeQueueState<TItem>): boolean {
  return state.stretchItems.length > 0;
}
