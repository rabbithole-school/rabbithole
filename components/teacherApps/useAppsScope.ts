"use client";

/**
 * The scholar scope on the teacher Apps page (review/teacher-apps-v2-sketch.html
 * §4): the URL scope (hooks/useUrlScholarScope.ts) narrowed to what one read
 * takes. A focused scholar narrows every tab's reads to that one scholar.
 */

import { useUrlScholarScope } from "@/hooks/useUrlScholarScope";
import { MAX_SCOPE_SCHOLARS } from "@/shared/teacherAppsScope";

export function useAppsScope() {
  const scope = useUrlScholarScope();
  const { scopeKey, scopeGroup, focusScholar, scopedScholarIds } = scope;

  /** The scholars every read narrows to, capped at what one read takes. */
  const pool = focusScholar ? [focusScholar.id] : scopedScholarIds;
  const scholarIds = pool.slice(0, MAX_SCOPE_SCHOLARS);
  /** Set when the cap cut the pool: pages say "Showing the first N". */
  const truncatedTo = pool.length > MAX_SCOPE_SCHOLARS ? MAX_SCOPE_SCHOLARS : null;
  /** True when nothing narrows the pool: reads show the whole tenant. */
  const isWholePool = scopeKey === "" && !focusScholar;
  /** How a page names the current scope ("the Seals", "Oliver M."). */
  const scopeLabel = focusScholar
    ? focusScholar.name
    : scopeKey === ""
      ? null
      : scopeKey === "mine"
        ? "my scholars"
        : (scopeGroup?.name ?? null);

  return {
    isLoading: scope.isLoading,
    groups: scope.groups,
    scopeKey,
    hasMine: scope.hasMine,
    visibleScholarIds: scope.visibleScholarIds,
    scopedScholarIds,
    focusScholar,
    scholarIds,
    truncatedTo,
    isWholePool,
    scopeLabel,
    selectScope: scope.selectScope,
    focus: scope.focus,
  };
}

export type AppsScope = ReturnType<typeof useAppsScope>;
