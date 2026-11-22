"use node";

// Rasterize a chart SVG (shared/screenTimeCharts) to PNG for Slack.
//
// The published copy ships no rasterizer: the one the original deployment uses
// is MPL-2.0, outside this repository's dependency license policy. Until you
// add one, the screen-time charts that follow the Friday check-in roundup are
// skipped (the roundup text still posts). To enable them, implement
// rasterizeChartSvg with a renderer that runs in a Convex "use node" action
// and loads the bundled Hanken Grotesk, since Convex has no system fonts.

/** Twice the SVG's width, so text stays crisp on a Retina screen. */
export const CHART_PIXEL_SCALE = 2;

/** PNG bytes for a chart SVG, scaled to `CHART_PIXEL_SCALE` times `width`. */
export async function rasterizeChartSvg(
  _svg: string,
  _width: number,
): Promise<Uint8Array> {
  throw new Error(
    "Chart rasterizing is not configured in this deployment; see convex/lib/chartRaster.ts.",
  );
}
