/**
 * Data hooks for the native Simulator Workbench — the twin of the web
 * `hooks/useWorkbenchData.ts`. Thin React wrappers over the `simulatorBenches` /
 * `simulatorRuns` Convex functions (the SAME typed backend the web app uses). The
 * bench IS a session, so every query keys off `sessionId` (the branch predicate
 * the route already resolved). Reads only; the sole deck writer is the scholar's
 * own SpeciesPromptEditor → saveDeck.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import { api, type Id } from "@/lib/convex";

export type WorkbenchRunId = Id<"simulatorRuns">;

export type SimulatorBench = NonNullable<
  ReturnType<typeof useQuery<typeof api.simulatorBenches.getBench>>
>;
export type SimulatorRun = NonNullable<
  ReturnType<typeof useQuery<typeof api.simulatorRuns.get>>
>;
export type SimulatorRunListItem = NonNullable<
  ReturnType<typeof useQuery<typeof api.simulatorRuns.listForBench>>
>[number];
export type NotebookRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.simulatorBenches.listNotebook>>
>[number];

/**
 * The bench descriptor + the simulator spec the renderer needs. `null` = the bench
 * aggregate does not exist yet; `undefined` = the query is still loading. Also
 * lazily opens the bench on first sight so a fresh simulator session has a deck to
 * edit — and surfaces an `ensureError` so a caller (e.g. a teacher, who cannot
 * open a scholar's bench) shows an explanation instead of an endless spinner
 * (review Finding 8).
 */
export function useWorkbenchBench(sessionId: Id<"sessions">) {
  const bench = useQuery(api.simulatorBenches.getBench, { sessionId });
  const ensure = useMutation(api.simulatorBenches.ensureBench);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  const [ensureTried, setEnsureTried] = useState(false);
  const openedForRef = useRef<Id<"sessions"> | null>(null);
  // The session is already known to be a simulator (route branched on sessionMode),
  // but the aggregate row may not exist yet — warm it once, and remember whether
  // the attempt failed so the screen can distinguish "opening" from "can't open".
  const missing = bench === null;

  // The single place that opens the bench, for BOTH the automatic first attempt
  // and retry(). Stable across renders (convex/react memoizes `ensure`), so the
  // effect below is driven only by `missing` / `sessionId`.
  const open = useCallback(() => {
    setEnsureError(null);
    setEnsureTried(false);
    ensure({ sessionId })
      .catch((error: unknown) => {
        setEnsureError(error instanceof Error ? error.message : "Could not open this Workbench");
      })
      .finally(() => {
        setEnsureTried(true);
      });
  }, [ensure, sessionId]);

  // Ensure at most once per session; never loop on failure (a rejected ensure
  // that re-fired would spin forever). The ref records WHICH session was opened
  // rather than a bare boolean, so navigating to a second simulator bench still
  // opens. retry() calls open() directly — re-arming the ref would change no
  // dependency and so could never re-run this effect (the web twin's bug).
  useEffect(() => {
    if (missing && openedForRef.current !== sessionId) {
      openedForRef.current = sessionId;
      open();
    }
  }, [missing, sessionId, open]);
  // Heal-on-open (scholar parity with the web hook): when the bench already
  // exists AND a Species card is not ready, poke ensureBench once so the
  // server's gated scheduler retries failures, restarts orphaned compiles, or
  // creates missing rows. A healthy deck never enters this branch. Errors are
  // SWALLOWED on purpose: a teacher viewing
  // a scholar's bench makes ensureBench throw "Only the scholar can open this
  // Workbench" — that must stay silent and must NOT touch ensureError/ensureTried
  // or any rendered state. The server gates retries by fingerprint, backoff,
  // attempt ceiling, and stuck timeout, so firing once per session is safe.
  const healedForRef = useRef<Id<"sessions"> | null>(null);
  useEffect(() => {
    if (
      bench !== null &&
      bench !== undefined &&
      healedForRef.current !== sessionId &&
      bench.compiledPolicies.some((policy) => policy.status !== "ready")
    ) {
      healedForRef.current = sessionId;
      ensure({ sessionId }).catch(() => {});
    }
  }, [bench, sessionId, ensure]);
  return {
    bench,
    isLoading: bench === undefined,
    // Aggregate missing AND the open attempt has resolved with an error → the
    // spinner would otherwise never end. While a retry is in flight this is
    // null again, so the screen falls back to its "opening the bench…" state.
    ensureError: missing && ensureTried ? ensureError : null,
    retry: open,
  };
}

/** The run manifest rows — reactive, drives RunTray + Compare dot strip. */
export function useWorkbenchRuns(sessionId: Id<"sessions">) {
  return useQuery(api.simulatorRuns.listForBench, { sessionId });
}

/** A single run's live state machine. Subscribe while it is `ticking`. */
export function useWorkbenchRun(runId: WorkbenchRunId | null) {
  return useQuery(api.simulatorRuns.get, runId ? { runId: runId as Id<"simulatorRuns"> } : "skip") ?? null;
}

/** Queue position for a queued run (null once it starts ticking). */
export function useWorkbenchQueueState(runId: WorkbenchRunId | null) {
  return useQuery(api.simulatorRuns.queueState, runId ? { runId: runId as Id<"simulatorRuns"> } : "skip") ?? null;
}

/** Typed Notebook entries (hypothesis / run-marker / conclusion / note). */
export function useWorkbenchNotebook(sessionId: Id<"sessions">) {
  return useQuery(api.simulatorBenches.listNotebook, { sessionId }) ?? [];
}
