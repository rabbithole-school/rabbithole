"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo } from "react";

/**
 * Single source of truth for "am I in `?remote=<scholarId>` mode and,
 * if so, what's the scholar id?" plus a `stamp(path)` helper that
 * appends the param to an outgoing href/route.
 *
 * Anywhere code builds a navigation target by hand
 * (`router.push("/scholar/${id}")`, `<Link href="/scholar/...">`,
 * etc.) it should call `stamp(path)` so the teacher's remote-mode
 * context survives the navigation. Drop-in `<RemoteLink>` does the
 * same for the `<Link>` shape.
 */
export function useRemote() {
  const params = useSearchParams();
  const remote = params?.get("remote") ?? null;

  const stamp = useCallback(
    (path: string): string => {
      if (!remote) return path;
      // Split off the hash so we can stamp the query without burying
      // the param inside the fragment. Browsers treat everything after
      // '#' as the fragment, so `/x#section?remote=…` would put the
      // param in the fragment and useSearchParams() would never see it.
      const hashIdx = path.indexOf("#");
      const base = hashIdx >= 0 ? path.slice(0, hashIdx) : path;
      const hash = hashIdx >= 0 ? path.slice(hashIdx) : "";
      // Don't double-stamp. Anchored on the query-param boundary so
      // false-positive matches (e.g. /foo/remote-detail, ?remoteId=…)
      // don't accidentally suppress stamping.
      if (/[?&]remote=/.test(base)) return path;
      const sep = base.includes("?") ? "&" : "?";
      return `${base}${sep}remote=${remote}${hash}`;
    },
    [remote],
  );

  return useMemo(() => ({ remote, stamp }), [remote, stamp]);
}
