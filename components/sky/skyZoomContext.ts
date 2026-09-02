"use client";

/**
 * SkyZoomContext — the live zoom `scale` + a `didMove()` tap-guard, read by
 * SkyStar to drive level-of-detail. Kept in its own tiny module so a zooming
 * viewport and skyVisuals can import it without a cycle.
 *
 * No web surface provides it today (every star surface that ships is static),
 * so the default below is what actually renders: scale 1, no movement — base
 * labels show, zoom-gated detail stays hidden.
 */

import { createContext, useContext } from "react";

export type SkyZoom = { scale: number; didMove: () => boolean };

export const SkyZoomContext = createContext<SkyZoom>({
  scale: 1,
  didMove: () => false,
});

export function useSkyZoom(): SkyZoom {
  return useContext(SkyZoomContext);
}
