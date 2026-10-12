"use client";

/**
 * useWorkshopMode — persists the App designer's Edit | Play screen mode in a
 * `?mode=` search param so a reload keeps the teacher/scholar where they were.
 * The derivation itself lives in `shared/workshopMode.ts` (unit-tested); this
 * hook is the thin Next.js glue that reads the param and rewrites it without a
 * history entry or scroll jump.
 */

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import {
  resolveWorkshopMode,
  WORKSHOP_MODE_PARAM,
  type WorkshopMode,
} from "@/shared/workshopMode";

export function useWorkshopMode({
  fallback,
  editSelectable,
}: {
  /** The derived default mode for this session (see `defaultWorkshopMode`). */
  fallback: WorkshopMode;
  /** Whether the Edit segment can be selected (false ⇒ mode clamps to play). */
  editSelectable: boolean;
}): [WorkshopMode, (next: WorkshopMode) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const mode = resolveWorkshopMode({
    param: searchParams.get(WORKSHOP_MODE_PARAM),
    fallback,
    editSelectable,
  });

  const setMode = useCallback(
    (next: WorkshopMode) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(WORKSHOP_MODE_PARAM, next);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  return [mode, setMode];
}
