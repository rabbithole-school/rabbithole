/**
 * Presentation + routing helpers for a Preflight `PreflightResult` (see
 * `convex/lib/curriculumPreflightResult.ts`). Pure functions only — no
 * Convex/React imports — so they're trivial to unit test and reusable
 * anywhere a finding needs to be labeled or routed to its editor.
 *
 * Deliberately does NOT recover the certification/binding-claim or
 * debrief-grounding-comparison helpers from the reference PR (#2375) — those
 * belong to a separate, larger, unshipped feature. This module is scoped to
 * exactly what TODO.html's `#preflight-findings-ux-extraction` asks for:
 * rendering findings and routing "Fix this" to an existing editor.
 */
import type { PreflightResult } from "@/convex/lib/curriculumPreflightResult";
import { DIMENSION_LABELS } from "@/convex/lib/curriculumDimensions";

export type PreflightFinding = PreflightResult["findings"][number];

function checkLabel(dimension: string): string {
  return (
    DIMENSION_LABELS[dimension as keyof typeof DIMENSION_LABELS] ?? dimension
  );
}

/** The four EXISTING activity editors a finding can be routed to. */
export type RehearseFixField =
  | "resources"
  | "deliverable"
  | "duration"
  | "tutorPrompt";

/**
 * Which existing editor a finding's "Fix this" action should open/focus.
 * `null` means the finding isn't about an editable activity field (e.g. a
 * cast-level "rehearse again" finding) — there's nothing to route to.
 */
export function fixFieldForFinding(
  finding: PreflightFinding,
): RehearseFixField | null {
  switch (finding.targetSurface) {
    case "activity-resources":
      return "resources";
    case "activity-deliverable":
      return "deliverable";
    case "activity-duration":
      return "duration";
    case "activity-tutor-prompt":
      return "tutorPrompt";
    case "rehearse":
      return null;
  }
}

/**
 * Whether "Fix this" should be shown at all. A "needs-action" finding always
 * names something concrete to change. A "not-observed" finding (the run
 * couldn't check it) is only actionable if the missing context is exactly the
 * layer its own target surface edits — i.e. we already KNOW structurally that
 * layer was withheld, so the advice ("add resources", "set a deliverable") is
 * still sound even without fresh evidence.
 */
export function canFixFinding(
  result: PreflightResult,
  finding: PreflightFinding,
): boolean {
  if (finding.targetSurface === "rehearse") return false;
  if (finding.status !== "not-observed") return true;
  const missing = (finding.contextDependencies ?? []).filter(
    (layer) => result.coverage.context[layer] !== "included",
  );
  return (
    (finding.targetSurface === "activity-resources" &&
      missing.includes("resources")) ||
    (finding.targetSurface === "activity-deliverable" &&
      missing.includes("deliverableScoring"))
  );
}

/** Short "Limited · X withheld" badge text for a not-observed finding. */
export function findingCoverageLabel(
  result: PreflightResult,
  finding: PreflightFinding,
): string | null {
  if (finding.status !== "not-observed") return null;
  const missing = (finding.contextDependencies ?? [])
    .filter((layer) => result.coverage.context[layer] !== "included")
    .map((layer) =>
      layer === "deliverableScoring" ? "deliverable scoring" : layer,
    );
  return `Limited · ${missing.join(", ") || "required context"} withheld`;
}

const TARGET_LABEL: Record<PreflightResult["findings"][number]["targetSurface"], string> = {
  "activity-resources": "Resources",
  "activity-deliverable": "Deliverable",
  "activity-duration": "Duration",
  "activity-tutor-prompt": "Tutor prompt",
  rehearse: "Preflight",
};

/**
 * Caveat copy shown next to a finding that a teacher acted on: what to expect
 * next (a needed rerun), so "Fix this" never implies the finding auto-clears.
 */
export function findingHandoffCaveat(
  finding: PreflightFinding,
  context: PreflightResult["coverage"]["context"] | undefined,
): string {
  if (finding.status !== "not-observed") {
    return "After changing the activity, rerun Preflight. This finding stays open until a new run checks the revision.";
  }
  const target = TARGET_LABEL[finding.targetSurface];
  const layerLabel = (layer: string) =>
    layer === "deliverableScoring" ? "deliverable scoring" : layer;
  const missing = (finding.contextDependencies ?? [])
    .filter((layer) => context?.[layer] !== "included")
    .map(
      (layer) => `${layerLabel(layer)} (${context?.[layer] ?? "not recorded"})`,
    );
  const reason = missing.length
    ? `required context was incomplete: ${missing.join(", ")}`
    : "required evidence context was not recorded";
  return `This run cannot verify a ${target} repair because ${reason}. Readiness stays incomplete until a fresh run observes the revision.`;
}

/**
 * "Needs rerun" notice when the protected-dimension checks a certified run
 * requires weren't all evaluated by this run (e.g. an older record).
 */
export function protectedCoverageNotice(result: PreflightResult): string | null {
  const unchecked = result.coverage.uncheckedProtectedDims;
  if (unchecked === undefined) {
    return "Needs rerun: this historical run did not record coverage for the current protected checks.";
  }
  if (unchecked.length === 0) return null;
  return `Needs rerun · checks not run: ${unchecked.map(checkLabel).join(", ")}.`;
}

const SEVERITY_ORDER: Record<PreflightFinding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Findings sorted highest-severity first (stable for equal severities). */
export function sortedFindings(result: PreflightResult): PreflightFinding[] {
  return [...result.findings].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );
}
