"use client";

/**
 * Resolve a manipulative's generative charm theme to a ready icon URL.
 *
 * Returns the storage URL of the chroma-keyed icon for `theme.fill.label`
 * (or the legacy `fillIcon`) once it's `ready`, else `undefined` — so the
 * renderer falls back to the plain shape while art is pending/failed/hidden.
 * A never-before-seen label is warmed on first sight (`ensure`), then the icon
 * pops in reactively when generation finishes. See
 * `convex/manipulativeThemeIcons.ts` + the design doc.
 */
import { useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { resolveThemeLabel, type ManipulativeTheme } from "@/lib/manipulative/types";

/**
 * A 1×1 transparent pixel used as the initial `href` for a themed icon that
 * hasn't resolved yet. A Mafs `<Image>` only paints reliably when it is present
 * in the canvas's first render, so the tile renderers mount the `<image>` up
 * front with this placeholder (and remount the keyed canvas when the real URL
 * lands) rather than adding the element later, which never repaints. See
 * ArrayManipulative / AreaPerimeterManipulative.
 */
export const THEME_ICON_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";

export function useThemeIcon(theme?: ManipulativeTheme): string | undefined {
  const label = resolveThemeLabel(theme);
  const resolved = useQuery(
    api.manipulativeThemeIcons.getByLabel,
    label ? { label } : "skip",
  );
  const ensure = useMutation(api.manipulativeThemeIcons.ensure);
  const missing = resolved === null; // query ran, no cache row yet
  useEffect(() => {
    if (label && missing) ensure({ label }).catch(() => {});
  }, [label, missing, ensure]);
  return resolved?.url ?? undefined;
}
