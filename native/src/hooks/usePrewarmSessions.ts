import { useEffect } from "react";
import { useConvex } from "convex/react";
import type { ConvexReactClient } from "convex/react";

import { api, type Id } from "@/lib/convex";

// The subscription only exists to keep the query warm; nothing reads updates.
//
// Every subscription needs its OWN callback object. Convex keeps a query's
// listeners in a `Set` keyed by function identity, so two subscriptions to the
// same session with the same callback collapse to one entry: the first
// unsubscribe deletes the token's whole listener set, and the second throws
// "Cannot read property 'delete' of undefined" from an effect cleanup, which
// crashed the iPad Home screen. A shared module-level no-op (the October fix)
// still collided across two mounted Home screens (Practice's Done button used
// to stack a second Home with `router.replace("/")`). The closure captures `id` so the React
// Compiler can never hoist it into one shared `_temp`.
function keepWarm(id: string) {
  return () => void id;
}

/** Subscribe once per distinct session; returns the matching teardown. */
export function prewarmSessions(
  convex: Pick<ConvexReactClient, "watchQuery">,
  ids: readonly string[],
): () => void {
  const unsubs = [...new Set(ids)].map((id) =>
    convex
      .watchQuery(api.sessions.getWithMessages, { id: id as Id<"sessions"> })
      .onUpdate(keepWarm(id)),
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
