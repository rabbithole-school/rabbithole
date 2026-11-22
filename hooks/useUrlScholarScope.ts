"use client";

/**
 * A ScholarScopePicker scope kept in the URL: `?scope=` is the pool ("" = all
 * scholars, "mine" = my scholars, otherwise a scholarGroup id) and `?scholar=`
 * a scholar picked inside it. A reload or a shared link keeps both.
 *
 * Shared by the teacher Apps page (components/teacherApps/useAppsScope.ts,
 * which narrows its reads to the focused scholar) and School › Screen time
 * (which highlights the picked scholar in a scope it still shows whole).
 */

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import type { ScopeFocusScholar } from "@/components/ScholarScopePicker";

export function useUrlScholarScope() {
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

  /** The scope's own name, as the picker's rows name it. */
  const scopeName =
    scopeKey === ""
      ? "All scholars"
      : scopeKey === "mine"
        ? "My scholars"
        : (scopeGroup?.name ?? "All scholars");

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

  // Switching the pool drops a picked scholar who is not in the new one (the
  // Quests board's rule).
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
    scholars,
    groups,
    scopeKey,
    scopeGroup,
    scopeName,
    hasMine,
    visibleScholarIds,
    scopedScholarIds,
    focusScholar,
    selectScope,
    focus: (id: string | null) => write({ scholar: id ?? "" }),
  };
}

export type UrlScholarScope = ReturnType<typeof useUrlScholarScope>;
