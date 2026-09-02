"use client";

/**
 * Data hooks for the World Workbench scholar surface. Thin React wrappers over
 * the `simulatorBenches` / `simulatorRuns` Convex functions — the bench IS a session,
 * so every query keys off `sessionId` (the branch predicate the route already
 * resolved). Reads only; the sole deck writer is the scholar's SpeciesPromptEditor.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCachedQuery } from "@/hooks/useCachedQuery";

/**
 * Stage-1 World→Simulator widen: every live run id the canonical backend
 * hands back (even through the `simulatorRuns` alias paths kept for fleet
 * compatibility) is now `Id<"simulatorRuns">`. This union lets Workbench
 * state/props keep accepting a lingering `Id<"simulatorRuns">`-typed value
 * (e.g. from an older call site) without a mass rename of run-id symbols.
 */
export type WorkbenchRunId = Id<"simulatorRuns"> | Id<"simulatorRuns">;

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
 * The bench descriptor + the world spec the renderer needs. `null` = the bench
 * aggregate has not been opened yet; `undefined` = loading. Lazily opens the
 * aggregate on first sight so a fresh world session has a deck to edit — and,
 * critically (review Finding 8), SURFACES the ensure error instead of swallowing
 * it, so a teacher opening a scholar-unopened bench (or any real failure) gets
 * an actionable state, not an eternal spinner.
 */
export function useWorkbenchBench(sessionId: Id<"sessions">) {
  const bench = useCachedQuery(
    api.simulatorBenches.getBench,
    { sessionId },
    `simulatorBench.${sessionId}`,
  );
  const ensure = useMutation(api.simulatorBenches.ensureBench);
  const openedForRef = useRef<Id<"sessions"> | null>(null);
  const healedForRef = useRef<Id<"sessions"> | null>(null);
  const [ensureError, setEnsureError] = useState<string | null>(null);

  // The single place that opens the bench, for BOTH the automatic first attempt
  // and retry(). Stable across renders (convex/react memoizes `ensure`), so the
  // effect below is driven only by `bench` / `sessionId`.
  const open = useCallback(() => {
    setEnsureError(null);
    ensure({ sessionId }).catch((error: unknown) => {
      setEnsureError(error instanceof Error ? error.message : "Could not open this Workbench");
    });
  }, [ensure, sessionId]);

  // Ensure at most once per session; never loop on failure (a rejected ensure
  // that re-fired would spin forever). The ref records WHICH session was opened
  // rather than a bare boolean, so a client-side nav to a second world bench
  // still opens instead of hanging unopened forever.
  //
  // retry() calls open() DIRECTLY and deliberately does not re-arm this ref:
  // mutating a ref changes no dependency, so re-arming alone would never re-run
  // the effect and the retry button would do nothing but clear the error text
  // (leaving an eternal "Opening the Workbench…" spinner).
  useEffect(() => {
    if (bench === null && openedForRef.current !== sessionId) {
      openedForRef.current = sessionId;
      open();
    }
  }, [bench, sessionId, open]);

  // Heal-on-open: when the bench already exists AND a Species card is not ready,
  // poke ensureBench once so the server's gated scheduler can retry a failure,
  // restart an orphaned compile, or create a missing row. A healthy deck never
  // enters this branch, so a normal open costs nothing. Errors are
  // SWALLOWED on purpose: a teacher viewing a scholar's bench makes ensureBench
  // throw "Only the scholar can open this Workbench" — that must stay silent and
  // must NOT set ensureError or change any rendered state. The server already
  // gates retries by fingerprint, backoff, attempt ceiling, and stuck timeout,
  // so firing once per session cannot storm the compiler.
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
    // No aggregate yet and no error → the open is in flight (show a labeled
    // "opening" state, never a bare eternal spinner — review Finding 8). A
    // retry clears the error, so this covers the in-flight retry too.
    isUnopened: bench === null && ensureError === null,
    ensureError,
    retry: open,
  };
}

/** The run manifest rows — reactive, drives RunTray + Compare dot strip. An
 *  explicit bound keeps the tick-invalidated subscription small (review
 *  Finding 5); older runs page in via the mutation's `beforeQueuedAt` cursor. */
export function useWorkbenchRuns(sessionId: Id<"sessions">) {
  return useQuery(api.simulatorRuns.listForBench, { sessionId, limit: 24 });
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
