"use client";

/**
 * The scholar scope on the teacher Apps page (review/teacher-apps-v2-sketch.html
 * §4). The choice lives in the URL (`?scope=` pool, `?scholar=` focused
 * scholar), so a reload or a shared link keeps it, and every tab reads it.
 *
 * The pool and focus follow ScholarScopePicker's vocabulary: "" = all
 * scholars, "mine" = my scholars, otherwise a scholarGroup id.
 */

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import type { ScopeFocusScholar } from "@/components/ScholarScopePicker";
import { MAX_SCOPE_SCHOLARS } from "@/shared/teacherAppsScope";

export function useAppsScope() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const scopeKey = searchParams.get("scope") ?? "";
  const focusId = searchParams.get("scholar") ?? "";

  const { scholars, groups, myScholarIds, isLoading } = useScholarRoster();

  const visibleScholarIds = scholars.map((s) => s.id);
  const hasMine = visibleScholarIds.some((id) => myScholarIds.has(id));
  const scopeGroup = groups.find((g) => g.id === scopeKey);
  const inScope = (id: string) =>
    scopeKey === ""
      ? true
      : scopeKey === "mine"
        ? myScholarIds.has(id)
        : (scopeGroup?.scholarIds.includes(id) ?? false);
  const scopedScholarIds = visibleScholarIds.filter(inScope);
  const focused = scholars.find((s) => s.id === focusId && inScope(s.id));
  const focusScholar: ScopeFocusScholar | undefined = focused
    ? { id: focused.id, name: focused.name, image: focused.image }
    : undefined;

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

  const write = useCallback(
    (next: { scope?: string; scholar?: string }) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(next)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // Scope and focus both narrow the pool; switching the pool drops a focused
  // scholar who is not in the new one (the Quests board's rule).
  const selectScope = (key: string) => {
    const nextGroup = groups.find((g) => g.id === key);
    const keepsFocus =
      !focusScholar ||
      key === "" ||
      (key === "mine"
        ? myScholarIds.has(focusScholar.id)
        : nextGroup?.scholarIds.includes(focusScholar.id) === true);
    write({ scope: key, scholar: keepsFocus ? focusId : "" });
  };

  return {
    isLoading,
    groups,
    scopeKey,
    hasMine,
    visibleScholarIds,
    scopedScholarIds,
    focusScholar,
    scholarIds,
    truncatedTo,
    isWholePool,
    scopeLabel,
    selectScope,
    focus: (id: string | null) => write({ scholar: id ?? "" }),
  };
}

export type AppsScope = ReturnType<typeof useAppsScope>;
