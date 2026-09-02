"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import type { FunctionReference, FunctionReturnType } from "convex/server";

/**
 * Keep-previous-data over a Convex `useQuery`.
 *
 * A plain `useQuery` returns `undefined` the instant its args change (e.g. the
 * teacher switches domains), so any `x === undefined ? <Spinner/> : <View/>`
 * gate unmounts the whole subtree to a spinner and remounts it — a hard flicker
 * on every switch. This hook retains the LAST defined result while the new args
 * load, so the previous domain's content stays on screen until the next one
 * arrives, then swaps in one frame (stale-while-revalidate).
 *
 * Only ever moves forward to a defined value, so the returned value is `undefined`
 * only before the very first result — the loading gate then fires on initial
 * load but not on subsequent arg changes.
 *
 * Callers must guard the "skip" case with a preceding conditional: because this
 * hook can't tell a skipped query from a loading one, a site that flips to
 * `"skip"` and still renders would show stale data. Every current caller renders
 * an explicit empty/loading branch before reaching the smoothed value.
 */
export function useSmoothedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: Parameters<typeof useQuery<Query>>[1],
): FunctionReturnType<Query> | undefined {
  return useSmoothedQueryWithPending(query, args).data;
}

/**
 * Like `useSmoothedQuery`, but also reports whether the value currently on
 * screen is a RETAINED previous result while a new one loads (`isPending`).
 *
 * A caller that wants to keep the old content visible during an arg swap AND
 * signal that the swap is in flight — e.g. a subtle opacity dim so a teacher
 * never mistakes the outgoing scholar's data for the incoming one's — reads
 * `isPending`. It is `true` only while a defined previous value is being shown
 * in place of a still-loading live value; it is `false` on the very first load
 * (there is nothing stale to dim) and once the live value has arrived.
 */
export function useSmoothedQueryWithPending<
  Query extends FunctionReference<"query">,
>(
  query: Query,
  args: Parameters<typeof useQuery<Query>>[1],
): { data: FunctionReturnType<Query> | undefined; isPending: boolean } {
  const live = useQuery(query, args);
  // Keep-previous via React's "adjust state during render" pattern: when a new
  // defined result arrives we store it and re-render immediately (no commit, no
  // effect). `live` is a stable reference between renders until the underlying
  // data actually changes, so the `!== last` guard prevents a render loop.
  const [last, setLast] = useState<FunctionReturnType<Query> | undefined>(live);
  if (live !== undefined && live !== last) setLast(live);
  return resolveSmoothed(live, last);
}

/**
 * Pure core of the keep-previous behaviour, extracted so the transition logic
 * is testable without a React renderer (the repo's Vitest env is edge-runtime,
 * no DOM). Given the live query value and the last-retained value it returns
 * what to SHOW and whether that value is a stale stand-in.
 */
export function resolveSmoothed<T>(
  live: T | undefined,
  last: T | undefined,
): { data: T | undefined; isPending: boolean } {
  return {
    data: live !== undefined ? live : last,
    isPending: live === undefined && last !== undefined,
  };
}
