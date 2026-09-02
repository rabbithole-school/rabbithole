// Pure decision helper for the scholar deliverable panel (SessionInterface →
// ArtifactPanel). Extracted so the "which surface does an auto-mode photo get
// while its rubric is still generating?" edge is unit-testable without mounting
// the whole streaming chat component.

export type DeliverableKind =
  | "photo"
  | "artifact"
  | "slides"
  | "text"
  | "audio"
  | "map";
export type DeliverableMode = "manual" | "auto" | "none";

export type DeliverableContextGateInput = {
  hasSession: boolean;
  /** activity.deliverable, or null/undefined when unresolved / absent. */
  deliverable: { kind: DeliverableKind; mode: DeliverableMode } | null | undefined;
  /** deliverableSnapshot query has resolved (!== undefined). */
  snapshotLoaded: boolean;
  /** deliverableSnapshot.status ("pending" | "ready" | "error" | null). */
  snapshotStatus: string | null | undefined;
  /** deliverableSnapshot.criteria is non-empty. */
  snapshotHasCriteria: boolean;
};

/**
 * Whether to thread `deliverableContext` into ArtifactPanel — which is what
 * lets the panel render its KIND-AWARE empty state (photo capture; honest
 * slides/audio state) instead of the generic "No documents yet / Add Document".
 *
 * The rule differs by kind on purpose:
 *
 * - **text / artifact**: always provide context once the snapshot query resolves.
 *   The panel owns the honest pending/error state as well as the eventual
 *   "Submit & check" action; hiding the whole context leaves a scholar with no
 *   visible way to submit.
 *
 * - **photo / slides / audio**: the kind-aware surface does NOT depend on the
 *   rubric — photo capture works with no criteria (the "Check against the goal"
 *   button is itself gated on criteria.length), and slides/audio are static
 *   honest states. So provide context immediately, independent of auto-criteria
 *   readiness OR snapshot load. Gating these on criteria-ready was the bug: an
 *   auto-mode photo whose criteria are still generating — or permanently, if
 *   generation errored — fell through to the generic text panel and could trap
 *   the scholar behind an "Add Document" CTA that doesn't fit a photo task.
 */
export function shouldProvideDeliverableContext(
  input: DeliverableContextGateInput,
): boolean {
  const { hasSession, deliverable } = input;
  if (!hasSession || !deliverable) return false;

  const isCaptureKind =
    deliverable.kind === "photo" ||
    deliverable.kind === "slides" ||
    deliverable.kind === "audio" ||
    deliverable.kind === "map";
  // Capture/honest-state kinds never wait on the rubric snapshot.
  if (isCaptureKind) return true;

  // text / artifact: the panel renders rubric loading/error states itself.
  if (!input.snapshotLoaded) return false;
  return true;
}
