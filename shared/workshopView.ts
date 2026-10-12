/**
 * Pure derivations for the App designer's code viewer view state. Extracted
 * from CodeArtifactViewer so rendering and app-snapshot-capture registration
 * share ONE source of truth and can be unit-tested without the client-only
 * component (N2: keying capture on the raw `view` desynced it from the
 * `effectiveView` used for rendering, disabling capture after a Code→Play
 * switch).
 */

export type WorkshopView = "preview" | "code";

// Read-only (Play) hides the Code toggle, so the editor can never be reached —
// the effective view is always Preview regardless of stale `view` state.
export function effectiveWorkshopView(
  readOnly: boolean,
  view: WorkshopView,
): WorkshopView {
  return readOnly ? "preview" : view;
}

// Whether the app-snapshot capture should be registered for this view. Only a
// non-empty Preview renders the iframe the capture reads; an empty artifact or
// the Code editor exposes no snapshot.
export function snapshotCaptureForView<T>(
  effectiveView: WorkshopView,
  isEmpty: boolean,
  capture: T,
): T | null {
  return effectiveView === "preview" && !isEmpty ? capture : null;
}
