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
 * A Convex `useQuery` that REPORTS a server error instead of throwing it into
 * render. Native twin of web hooks/useContainedQuery.ts (same contract, same
 * shared subscription — built on the `useQueries` that `useQuery` wraps).
 *
 * Use it for a read that must degrade to an empty state rather than take a
 * screen down — e.g. a NEW query an older backend doesn't have yet ("Could not
 * find public function"), which would otherwise crash the Home on deploy skew.
 */
export function useContainedQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: Query["_args"] | "skip",
): { data: FunctionReturnType<Query> | undefined; error: Error | undefined } {
  const skip = args === "skip";
  // Keyed on the stringified args and the function NAME, like convex's own
  // useQuery: a fresh-but-equal args object each render must not resubscribe.
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
