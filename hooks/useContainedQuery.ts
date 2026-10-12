"use client";

import { useMemo } from "react";
import { useQueries, type RequestForQueries } from "convex/react";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";

/**
 * A Convex `useQuery` that REPORTS a server error instead of throwing it.
 *
 * `useQuery` rethrows a failed query in render. Inside a card that is fine —
 * an error boundary around the card contains it. But the scholar Home lifts
 * its practice queries into the PAGE (the page owns the tile selection that
 * drives the preview queries), so a throw there has no card-sized boundary to
 * land in: it takes the whole Home down to the app-wide "Something went wrong"
 * (2026-09-22: `choiceCardsForSelf` hit Convex's read limit; the iPad twin of
 * this crashed the app outright). With this hook the page gets the error as a
 * value and renders a card-sized notice in the card's place.
 *
 * Same subscription as `useQuery` — built on the stable `useQueries` that
 * `useQuery` itself wraps, so an identical call shares one subscription.
 * (`useQuery_experimental` does this natively but is marked experimental in
 * convex 1.43.)
 */
export function useContainedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: Query["_args"] | "skip",
): { data: FunctionReturnType<Query> | undefined; error: Error | undefined } {
  const skip = args === "skip";
  // Keyed on the stringified args and the function NAME, like convex's own
  // useQuery: a fresh-but-equal args object (or api proxy) each render must
  // not resubscribe. Both are rebuilt from the keys inside the memo.
  const argsKey = JSON.stringify(convexToJson((skip ? {} : args) as Value));
  const queryName = getFunctionName(query);
  const queries = useMemo(
    (): RequestForQueries =>
      skip
        ? {}
        : {
            query: {
              query: makeFunctionReference<"query">(queryName),
              args: jsonToConvex(JSON.parse(argsKey)) as Record<string, Value>,
            },
          },
    [argsKey, queryName, skip],
  );
  const result = useQueries(queries).query;
  return result instanceof Error
    ? { data: undefined, error: result }
    : { data: result as FunctionReturnType<Query> | undefined, error: undefined };
}
