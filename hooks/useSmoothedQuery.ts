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
 * Moves forward to each defined value and retains it while the next args set
 * loads, so the returned value is `undefined` only before the very first result
 * or while the query is skipped (below) — the loading gate then fires on initial
 * load but not on subsequent arg changes.
 *
 * A query whose args are `"skip"` reports `undefined`, never a retained value,
 * AND drops what it was retaining: a skip is a deliberate "nothing to show"
 * (signed out, no scholar picked), and a later re-enable with different args
 * (another scholar) must load fresh rather than flash the previous one's data.
 *
 * This is also the fix for the minute-bucket cache-buster pattern (a
 * `now: minuteNow` arg that re-arms a subscription across institution midnight):
 * without it, every minute boundary drops the query to `undefined` for one
 * round-trip and any `=== undefined` gate above a form unmounts it, wiping
 * whatever the scholar was typing (Home quest dialog, 2026-09-22).
 */
export function useSmoothedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: Parameters<typeof useQuery<Query>>[1],
  options?: SmoothedQueryOptions,
): FunctionReturnType<Query> | undefined {
  return useSmoothedQueryWithPending(query, args, options).data;
}

/** Optional controls for `useSmoothedQuery` / `useSmoothedQueryWithPending`. */
export type SmoothedQueryOptions = {
  /**
   * Scope what may be retained. Retaining across ANY arg change is only safe
   * when the arg that changed is a clock (`now: minuteNow`): the old result
   * still describes the same subject, a minute staler. When another arg names
   * the SUBJECT — an institution lens, an assignment id — showing the previous
   * subject's data while the new one loads would put one school's devices (or
   * one cohort's run budget) under another's heading.
   *
   * Pass that subject as `resetKey`. Retention then spans only renders where
   * the key is unchanged; the render the key changes on behaves like a fresh
   * `useQuery` (`undefined` until the new subject's data arrives, `isPending`
   * false — nothing stale is on screen to dim). Omitted, the hook retains
   * across every arg change, as before.
   */
  resetKey?: string | number | null;
};

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
  options?: SmoothedQueryOptions,
): { data: FunctionReturnType<Query> | undefined; isPending: boolean } {
  const live = useQuery(query, args);
  const skipped = args === "skip";
  const resetKey = options?.resetKey;
  // Keep-previous via React's "adjust state during render" pattern: when a new
  // defined result arrives we store it and re-render immediately (no commit, no
  // effect). `live` is a stable reference between renders until the underlying
  // data actually changes, so the identity guard prevents a render loop.
  const [held, setHeld] = useState<Held<FunctionReturnType<Query>>>(() => ({
    key: resetKey,
    value: skipped ? undefined : live,
  }));
  const next = nextHeld(live, held, resetKey, skipped);
  if (!Object.is(next.key, held.key) || next.value !== held.value) setHeld(next);
  if (skipped) return { data: undefined, isPending: false };
  return resolveSmoothed(live, next.value);
}

/** What the hook holds between renders: the retained value and the
 *  `resetKey` it was retained under. */
export type Held<T> = {
  key: SmoothedQueryOptions["resetKey"];
  value: T | undefined;
};

/**
 * The retention step with a reset key: a changed key discards what was held
 * (it belonged to another subject) before the ordinary keep-previous rule
 * runs, so the first render under a new key shows only the live value.
 * Pure, for the same testability reason as `resolveSmoothed`.
 */
export function nextHeld<T>(
  live: T | undefined,
  held: Held<T>,
  resetKey: SmoothedQueryOptions["resetKey"],
  skipped: boolean,
): Held<T> {
  const last = Object.is(held.key, resetKey) ? held.value : undefined;
  return { key: resetKey, value: nextRetained(live, last, skipped) };
}

/**
 * What the hook should retain after this render: the live value when there is
 * one, the previous retained value while a new args set loads, and NOTHING
 * while the query is skipped — so a skip → re-enable never resurfaces data
 * that belonged to the previous args (a different scholar, a signed-out user).
 * Pure, for the same testability reason as `resolveSmoothed`.
 */
export function nextRetained<T>(
  live: T | undefined,
  last: T | undefined,
  skipped: boolean,
): T | undefined {
  if (skipped) return undefined;
  return live !== undefined ? live : last;
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
