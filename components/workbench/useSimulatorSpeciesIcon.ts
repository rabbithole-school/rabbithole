"use client";

/**
 * Charm art for a Species (plan §7.4). Reuses the whole live manipulative
 * theme-icon pipeline verbatim — the cache is keyed by a normalized string
 * label, so we compose a namespaced `world:<setting phrase>:<species>` key
 * (via the shared `composeSpeciesIconLabel`). The pipeline template
 * (`convex/lib/themeIconArt.ts`) reads that `world:` prefix to give a species
 * the charm camera (a three-quarter isometric sprite, facing left, grounded for
 * a tile center) plus the setting-phrase referent steering — "coral reef
 * ecosystem grazers" draws a fish, not a cow. No schema or pipeline-shape
 * change; the icon warms on first sight and pops in reactively. Pending/failed →
 * caller falls back to a colored dot.
 */

import { useThemeIcon } from "@/hooks/useThemeIcon";
import { composeSpeciesIconLabel } from "@/lib/simulator/helpers";

export function useSimulatorSpeciesIcon(
  simulatorTemplate: string,
  speciesLabel: string,
): string | undefined {
  const label = composeSpeciesIconLabel(simulatorTemplate, speciesLabel);
  return useThemeIcon({ fill: { label } });
}
