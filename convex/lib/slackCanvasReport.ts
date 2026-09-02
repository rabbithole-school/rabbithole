/**
 * Shared "teaser + best-effort canvas link" body composition for the weekly
 * digests that post a Slack canvas (the Quality Pulse and the usage/cost
 * report). The digest ALWAYS posts its short teaser via alerts.raise; the
 * canvas is a best-effort enrichment, so the body degrades cleanly when the
 * canvas couldn't be made:
 *   - canvas link      → teaser + a link to the full report canvas
 *   - missing_scope    → teaser + the explicit scope-naming human-fix line
 *   - other error      → teaser + a generic line carrying the Slack code
 *   - not attempted    → teaser alone (Slack not configured)
 *
 * We deliberately never dump the full report markdown into #rabbithole-alerts
 * as message text — a report-sized wall of markdown is worse than a short
 * teaser + a clear reason the canvas is missing.
 *
 * Unit-tested in convex/lib/__tests__/slackCanvasReport.test.ts.
 */

/**
 * The exact line shown when the canvas can't be created because the Slack app
 * is missing the `canvases:write` scope — names the scope + the fix (a human
 * step: add it in the app config and reinstall).
 */
export const CANVAS_MISSING_SCOPE_LINE =
  "⚠️ Canvas not created: the Rabbithole Slack app is missing the canvases:write scope — add it in the app config and reinstall, then re-run the digest.";

/** Generic one-line canvas error carrying the Slack error code. */
export function canvasErrorLine(code: string): string {
  return `⚠️ Canvas not created (Slack error: ${code}).`;
}

/** How the canvas half resolved — the caller can log/branch on this. */
export type CanvasBodyMode =
  | "canvas" // teaser + a canvas link
  | "canvas_missing_scope" // teaser, canvas failed on missing scope
  | "canvas_error" // teaser, canvas failed for another reason
  | "teaser"; // teaser only (canvas not attempted)

/**
 * Compose the alert body from the teaser + whatever the canvas step returned
 * (see publishReportCanvas in slackApi.ts). `openLabel` is the link text for a
 * successful canvas (e.g. "Open the full cost report →").
 */
export function composeCanvasBody(args: {
  teaser: string;
  canvasUrl: string | null;
  canvasError: string | null;
  openLabel: string;
}): { body: string; mode: CanvasBodyMode } {
  const { teaser, canvasUrl, canvasError, openLabel } = args;
  if (canvasUrl) {
    return { body: `${teaser}\n\n<${canvasUrl}|${openLabel}>`, mode: "canvas" };
  }
  if (canvasError === "missing_scope") {
    return { body: `${teaser}\n\n${CANVAS_MISSING_SCOPE_LINE}`, mode: "canvas_missing_scope" };
  }
  if (canvasError) {
    return { body: `${teaser}\n\n${canvasErrorLine(canvasError)}`, mode: "canvas_error" };
  }
  // Canvas never attempted (Slack not configured) — not a failure; teaser only.
  return { body: teaser, mode: "teaser" };
}
