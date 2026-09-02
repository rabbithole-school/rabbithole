/**
 * Charm art for a Species (plan §7.4) — the native twin of the web
 * `components/workbench/useSimulatorSpeciesIcon.ts`. Reuses the whole live manipulative
 * theme-icon pipeline verbatim via the native `useThemeIcon`; the cache is keyed
 * by a normalized string label, so we compose the SAME namespaced
 * `world:<setting phrase>:<species>` key the web hook does — via the shared
 * `composeSpeciesIconLabel` (vendored from `lib/simulator/helpers.ts`). The
 * pipeline template (`convex/lib/themeIconArt.ts`) reads that `world:` prefix to
 * give a species the CHARM CAMERA (a three-quarter isometric sprite, facing
 * left, grounded for a tile center) and the setting-phrase referent steering, so
 * the generator draws a fitting creature. Identical key ⇒ web and native share
 * key ⇒ web and native share one generated asset (the icon is a hosted URL, so
 * react-native-svg `<Image href={{ uri }}>` paints the exact web pixels — iPad
 * ↔ web parity).
 *
 * Returns `undefined` until the asset is `ready`; the caller falls back to a
 * plain colored dot (never a gray blank — the plan's whole point).
 */

import { useThemeIcon } from "@/components/manipulatives/useThemeIcon";
import { composeSpeciesIconLabel } from "../../../vendor/simulator/helpers";

export function useSimulatorSpeciesIcon(
  worldTemplate: string,
  speciesLabel: string,
): string | undefined {
  const label = composeSpeciesIconLabel(worldTemplate, speciesLabel);
  return useThemeIcon({ fill: { label } });
}
