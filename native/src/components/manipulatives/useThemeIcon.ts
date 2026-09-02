/**
 * Native twin of the web `useThemeIcon` hook — resolves a manipulative's
 * generative charm theme (`theme.fill.label`, or the legacy `fillIcon`) to a
 * ready icon URL from Convex storage, warming a fresh label on first sight.
 * Returns `undefined` until the asset is `ready` (renderer falls back to the
 * plain shape). Same cache/pipeline as web — the asset is a hosted URL, so
 * `react-native-svg` `<Image href={{ uri }}>` and RN `<Image source={{ uri }}>`
 * render the exact same pixels the browser does (iPad ↔ web parity).
 */
import { useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/lib/convex";
import {
  resolveThemeLabel,
  type ManipulativeTheme,
} from "../../../vendor/manipulative/types";

export function useThemeIcon(theme?: ManipulativeTheme): string | undefined {
  const label = resolveThemeLabel(theme);
  const resolved = useQuery(
    api.manipulativeThemeIcons.getByLabel,
    label ? { label } : "skip",
  );
  const ensure = useMutation(api.manipulativeThemeIcons.ensure);
  const missing = resolved === null;
  useEffect(() => {
    if (label && missing) ensure({ label }).catch(() => {});
  }, [label, missing, ensure]);
  return resolved?.url ?? undefined;
}
