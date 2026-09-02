/**
 * An activity VARIANT — a candidate edit to the mutable parts of an activity
 * (its systemPrompt + deliverable framing). The learningGoal is fixed: it's the
 * target the loop optimizes toward, never something the loop is allowed to move
 * (otherwise "improvement" could mean "make the goal easier"). Mirrors the
 * `curriculumVariants` row in the product plan, with lineage for the loop.
 */
import type { SimActivity } from "./types";

export type VariantOrigin = "baseline" | "ai-proposed" | "teacher-edited";

export interface ActivityVariant {
  id: string;
  parentId: string | null;
  generation: number;
  origin: VariantOrigin;
  systemPrompt: string | null;
  deliverablePrompt?: string | null;
  rationale: string | null;
}

let counter = 0;
export function newVariantId(prefix = "v"): string {
  return `${prefix}${++counter}`;
}

/** Seed a generation-0 baseline variant from the current activity. */
export function baselineVariant(activity: SimActivity): ActivityVariant {
  return {
    id: newVariantId(),
    parentId: null,
    generation: 0,
    origin: "baseline",
    systemPrompt: activity.systemPrompt,
    deliverablePrompt: activity.deliverablePrompt ?? null,
    rationale: null,
  };
}

/** Apply a variant's mutable fields onto the base activity to get a runnable activity. */
export function applyVariant(base: SimActivity, variant: ActivityVariant): SimActivity {
  return {
    ...base,
    systemPrompt: variant.systemPrompt,
    deliverablePrompt: variant.deliverablePrompt ?? base.deliverablePrompt ?? null,
  };
}
