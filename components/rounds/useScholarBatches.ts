"use client";

/**
 * Paging for the board's two quantitative reads.
 *
 * `practiceDigest.weeklySignalsForScholars` and `scholars.levelSignalsForScholars`
 * are both bounded fan-out queries: they take at most 60 scholar ids and THROW
 * over that rather than silently returning a short roster. That is the right
 * server behaviour — a truncated roster on a projected wall is a wrong number —
 * but it means the caller has to page.
 *
 * So: one call per batch of 60, merged into a single lookup. Never one call per
 * row (that is a fan-out per scholar on a surface that shows the whole school),
 * and never one unbounded call (a 61st scholar would take the whole meeting's
 * board down mid-ritual).
 *
 * `useQueries` is what makes the batch count dynamic — it takes a map of
 * requests, so the number of subscriptions can follow the roster without
 * breaking the rules of hooks. It also RETURNS errors instead of throwing them,
 * which is what lets a refused read (operations staff have no access to reading
 * level) degrade to "unavailable" instead of tearing the board down.
 */

import { useMemo } from "react";
import { useQueries } from "convex/react";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";

/** Mirrors the server's fan-out bound. Keep in step with both queries. */
export const SCHOLAR_BATCH_SIZE = 60;

export function chunkScholarIds(
  ids: readonly string[],
  size: number = SCHOLAR_BATCH_SIZE,
): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size) as string[]);
  }
  return out;
}

export interface BatchedScholarRows<Row> {
  /** Merged rows, keyed by scholar id. Partial while batches are in flight. */
  byId: Map<string, Row>;
  /** At least one batch has not answered yet. */
  loading: boolean;
  /** At least one batch was refused or failed. Render "unavailable", not an alarm. */
  failed: boolean;
}

interface RowsEnvelope<Row> {
  rows: Row[];
}

/**
 * Subscribe to a `{ scholarIds } -> { rows }` query across as many batches as
 * the roster needs, and merge the answers.
 *
 * `extraArgs` are passed to every batch unchanged — for a per-week read (the
 * SEL synthesis) the week key rides here, so the same batching/merge/refusal
 * discipline covers a parameterised roster read without a second helper.
 */
export function useBatchedScholarRows<Row extends { scholarId: string }>(
  query: FunctionReference<"query">,
  scholarIds: readonly string[],
  extraArgs?: Record<string, unknown>,
): BatchedScholarRows<Row> {
  // `api.foo.bar` is a Proxy: every property access hands back a NEW object, so
  // memoising on the reference itself rebuilds the request map on every render,
  // and `useQueries` re-subscribes in a loop. Convex's own hooks key on the
  // function NAME for exactly this reason; so do we.
  const queryName = getFunctionName(query);
  const key = scholarIds.join(",");
  const extraKey = JSON.stringify(extraArgs ?? {});

  const requests = useMemo(() => {
    const ref = makeFunctionReference<"query">(queryName);
    const extra = extraKey ? (JSON.parse(extraKey) as Record<string, unknown>) : {};
    const out: Record<
      string,
      { query: FunctionReference<"query">; args: Record<string, unknown> }
    > = {};
    chunkScholarIds(key ? key.split(",") : []).forEach((batch, i) => {
      out[`batch-${i}`] = { query: ref, args: { ...extra, scholarIds: batch } };
    });
    return out;
  }, [key, queryName, extraKey]);

  const results = useQueries(
    requests as Parameters<typeof useQueries>[0],
  ) as Record<string, RowsEnvelope<Row> | Error | undefined>;

  return useMemo(() => {
    const byId = new Map<string, Row>();
    let loading = false;
    let failed = false;
    for (const name of Object.keys(requests)) {
      const value = results[name];
      if (value === undefined) {
        loading = true;
        continue;
      }
      if (value instanceof Error) {
        failed = true;
        continue;
      }
      for (const row of value.rows ?? []) byId.set(String(row.scholarId), row);
    }
    return { byId, loading, failed };
  }, [requests, results]);
}
