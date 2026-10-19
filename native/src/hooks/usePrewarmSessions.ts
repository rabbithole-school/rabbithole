import { useEffect } from "react";
import { useConvex } from "convex/react";
import type { ConvexReactClient } from "convex/react";

import { api, type Id } from "@/lib/convex";

// The subscription only exists to keep the query warm; nothing reads updates.
//
// It is deliberately ONE shared function. The React Compiler already hoists a
// capture-free `() => {}` to a module-level `_temp`, so in a release build every
// subscription passes the same callback anyway. Convex keeps a query's
// listeners in a `Set`, so two subscriptions to the same session with the same
// callback collapse to one entry: the first unsubscribe deletes the token's
// whole listener set, and the second throws
// "Cannot read property 'delete' of undefined" from an effect cleanup, which
// crashed the iPad Home screen. Naming the callback makes tests behave the way
// the compiled app does, and `prewarmSessions` drops duplicate ids so it never
// holds two subscriptions per session.
const KEEP_WARM = () => {};

/** Subscribe once per distinct session; returns the matching teardown. */
export function prewarmSessions(
  convex: Pick<ConvexReactClient, "watchQuery">,
  ids: readonly string[],
): () => void {
  const unsubs = [...new Set(ids)].map((id) =>
    convex
      .watchQuery(api.sessions.getWithMessages, { id: id as Id<"sessions"> })
      .onUpdate(KEEP_WARM),
  );
  return () => unsubs.forEach((u) => u());
}

// Prewarm each row's chat query while home is mounted, so tapping in paints
// instantly (native equivalent of the web RoutePrefetcher — same Convex
// shared-subscription trick).
export function usePrewarmSessions(ids: string[]) {
  const convex = useConvex();
  const key = [...new Set(ids)].sort().join(",");
  useEffect(
    () => prewarmSessions(convex, key ? key.split(",") : []),
    [convex, key],
  );
}
