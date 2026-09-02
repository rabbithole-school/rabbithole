// Shared deliverable-shape helpers. Centralizes the rubric/criteria
// data shape so every write path (manual teacher edits, Curriculum
// Bot, quest designer bot, seed scripts) produces identical, normalized
// rows.
//
// A deliverable's "rubric" is always an array of criteria. Each criterion
// has a short label + an optional longer description. For a holistic
// single-standard rubric, callers pass a one-element array (the helpers
// here build that from a string for convenience).

import { v } from "convex/values";
import type { ActivityKind } from "../../lib/activityKinds";
import { rubricStarsEarned } from "../../shared/rubricScore";

const deliverableKindValidator = v.union(
  v.literal("photo"),
  v.literal("artifact"),
  v.literal("slides"),
  v.literal("text"),
  v.literal("audio"),
  v.literal("map"),
);

const criterionValidator = v.object({
  id: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
});

// "manual" — teacher writes the private criteria array; every scholar
//             is judged against the same map. A full criterion becomes
//             scholar-visible flair with its label and description.
// "auto"   — teacher writes `notes`; the AI generates per-scholar
//             criteria at project start, calibrated to reading level;
//             criteria become flair when earned.
// "none"   — deliverable still has a kind + prompt (so the scholar
//             gets work to fill in), but NO rubric. The AI
//             tutor doesn't grade; the activity completes when the
//             teacher or scholar marks it done.
const deliverableModeValidator = v.union(
  v.literal("manual"),
  v.literal("auto"),
  v.literal("none"),
);

export const deliverableValidator = v.object({
  kind: deliverableKindValidator,
  prompt: v.string(),
  mode: deliverableModeValidator,
  notes: v.optional(v.string()),
  criteria: v.array(criterionValidator),
});

// The advance ("ready to move on") CHAT rubric: the same criteria shape
// as a deliverable, but graded against the CONVERSATION instead of a
// submitted artifact (see the `advanceRubric` field in schema.ts). An
// online activity that carries one needs NO document — the tutor scores
// the discussion + interactive surface (map pins, predictions) and a
// full pass marks the activity complete.
export const advanceRubricValidator = v.object({
  criteria: v.array(criterionValidator),
});

export type DeliverableKind =
  | "photo"
  | "artifact"
  | "slides"
  | "text"
  | "audio"
  | "map";

export type DeliverableMode = "manual" | "auto" | "none";

export interface DeliverableCriterion {
  id: string;
  label: string;
  description?: string;
}

export interface DeliverableSpec {
  kind: DeliverableKind;
  prompt: string;
  mode: DeliverableMode;
  notes?: string;
  criteria: DeliverableCriterion[];
}

export interface AdvanceRubricSpec {
  criteria: DeliverableCriterion[];
}

/**
 * Normalize a criteria array: trim labels, drop empties, assign +
 * dedupe ids (slug-from-label when blank). Shared by both the
 * deliverable rubric and the advance (conversation) rubric so ID
 * assignment has one definition. Throws on a blank label.
 */
function normalizeCriteriaArray(
  input: Array<{ id?: string; label: string; description?: string }>,
): DeliverableCriterion[] {
  const seen = new Set<string>();
  const normalized: DeliverableCriterion[] = [];
  for (const c of input) {
    const label = c.label.trim();
    if (!label) {
      throw new Error("criterion.label must be non-empty");
    }
    const desc = c.description?.trim() || undefined;
    let id = (c.id ?? slugify(label)).trim();
    if (!id) id = slugify(label);
    // Disambiguate duplicates by appending a suffix.
    let suffix = 2;
    const base = id;
    while (seen.has(id)) {
      id = `${base}-${suffix++}`;
    }
    seen.add(id);
    normalized.push({ id, label, description: desc });
  }
  return normalized;
}

/**
 * Normalize a deliverable: trim strings, dedupe + assign criterion IDs,
 * reject empty/garbage rubrics. Single source of truth for "is this
 * deliverable valid before we write it." Throws on bad input.
 *
 * Mode-conditional validation:
 *   - "manual": criteria array must be non-empty.
 *   - "auto":   criteria array may be empty (the generator fills it in
 *               at project-creation time). `notes` is optional but
 *               recommended — the teacher's intent for the AI.
 *   - "none":   criteria + notes are dropped. The scholar gets a
 *               document to fill in but no AI grading; the activity
 *               completes when the teacher (or scholar) marks it done.
 */
export function normalizeDeliverable(
  input:
    | {
        kind: DeliverableKind;
        prompt: string;
        mode: DeliverableMode;
        notes?: string;
        criteria?: Array<{ id?: string; label: string; description?: string }>;
      }
    | undefined,
): DeliverableSpec | undefined {
  if (!input) return undefined;
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("deliverable.prompt must be non-empty");
  const mode = input.mode;
  // "none" mode strips rubric data — the deliverable is just a prompt
  // + a document for the scholar to fill in. Criteria + notes get
  // silently dropped so a teacher who switches manual/auto → none
  // doesn't have to manually clear them.
  const inCriteria = mode === "none" ? [] : (input.criteria ?? []);
  if (mode === "manual" && inCriteria.length === 0) {
    throw new Error(
      "deliverable.criteria must be a non-empty array in manual mode. " +
        "Switch mode='auto' to let the AI generate criteria from notes, " +
        "or mode='none' to skip the rubric entirely.",
    );
  }
  const normalized = normalizeCriteriaArray(inCriteria);
  const notes = mode === "none" ? undefined : input.notes?.trim() || undefined;
  return { kind: input.kind, prompt, mode, notes, criteria: normalized };
}

/**
 * Normalize an advance (conversation) rubric. Requires a non-empty
 * criteria array — an empty advance rubric is meaningless (there'd be
 * nothing to grade), so callers that want "no exit bar" pass undefined
 * instead. Returns undefined for undefined input. Throws on a blank
 * label or an empty array.
 */
export function normalizeAdvanceRubric(
  input:
    | { criteria?: Array<{ id?: string; label: string; description?: string }> }
    | undefined,
): AdvanceRubricSpec | undefined {
  if (!input) return undefined;
  const criteria = normalizeCriteriaArray(input.criteria ?? []);
  if (criteria.length === 0) {
    throw new Error(
      "advanceRubric.criteria must be a non-empty array — supply 3-6 " +
        "conversation criteria, or omit advanceRubric entirely.",
    );
  }
  return { criteria };
}

/**
 * Score raw model-supplied verdicts against a rubric's criteria. Shared by
 * BOTH the deliverable rubric (`applyRubricScoreFromTool`) and the chat
 * "advance" rubric (`applyAdvanceRubricScoreFromTool`) so the sanitize +
 * overall + pass math has one definition.
 *
 * Sanitizes the model output: drops verdicts for unknown criteria, collapses
 * duplicates (first wins), and fills any omitted criterion with "not" — so the
 * returned array is a complete, canonical snapshot in criteria order. Overall
 * is "full" only when every criterion is "full" (any "not" → not; else any
 * "half" → half). `passed` === overall "full".
 */
export function scoreRubricVerdicts(
  criteria: DeliverableCriterion[],
  rawVerdicts: Array<{
    criterionId: string;
    level: "not" | "half" | "full";
    note?: string;
  }>,
): {
  verdicts: Array<{
    criterionId: string;
    level: "not" | "half" | "full";
    note?: string;
  }>;
  overall: "not" | "half" | "full";
  passed: boolean;
  earned: number;
  total: number;
} {
  if (criteria.length === 0) {
    throw new Error("Cannot score a rubric before its criteria are ready");
  }
  const validIds = new Set(criteria.map((c) => c.id));
  // The note travels with the level: it is the model's one sentence about
  // THIS submission, and it is what a scholar reads on an earned mark (a
  // criterion's own description is grader-facing rubric text).
  const byId = new Map<
    string,
    { level: "not" | "half" | "full"; note?: string }
  >();
  for (const v of rawVerdicts) {
    if (!validIds.has(v.criterionId)) continue;
    if (byId.has(v.criterionId)) continue;
    byId.set(v.criterionId, {
      level: v.level,
      ...(v.note?.trim() ? { note: v.note.trim() } : {}),
    });
  }
  const verdicts = criteria.map((c) => ({
    criterionId: c.id,
    level: byId.get(c.id)?.level ?? ("not" as const),
    ...(byId.get(c.id)?.note ? { note: byId.get(c.id)!.note } : {}),
  }));
  let anyNot = false;
  let anyHalf = false;
  for (const v of verdicts) {
    if (v.level === "not") anyNot = true;
    else if (v.level === "half") anyHalf = true;
  }
  const overall: "not" | "half" | "full" = anyNot
    ? "not"
    : anyHalf
      ? "half"
      : "full";
  const earned = rubricStarsEarned(verdicts.map((verdict) => verdict.level));
  return { verdicts, overall, passed: overall === "full", earned, total: criteria.length };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "criterion"
  );
}

/**
 * Enforce the "online activities must have an evaluation shape" rule.
 * Single canonical guard for every activity write path — teacher UI,
 * Curriculum Bot (global / unit / quest streams), seed scripts, and
 * test fixtures all funnel through this. Throwing the same REFUSED
 * message means the bot's tool-use loop recovers identically across
 * paths.
 *
 * An online activity satisfies the shape with EITHER:
 *   - a `deliverable` (the scholar checks or sends a document/product, graded
 *     against its private quality map; full criteria award flair but do
 *     not gate completion), OR
 *   - an `advanceRubric` (no document — the tutor grades the
 *     CONVERSATION + interactive surface, e.g. map pins, and a full
 *     pass marks the activity complete).
 * This is what lets an interactive/discovery activity (a map sequence, a
 * Socratic discussion) ship WITHOUT a fabricated noise artifact while
 * still carrying a real, enforced "ready to advance" bar — so the
 * escape hatch the bot used to abuse (an ungraded chat) stays closed.
 *
 * Offline activities are teacher-planned classroom moments — no AI
 * tutor session, so no rubric.
 */
export function requireDeliverableForOnline(
  kind: ActivityKind,
  deliverable: DeliverableSpec | undefined,
  advanceRubric?: AdvanceRubricSpec | undefined,
): void {
  if (kind === "online" && !deliverable && !advanceRubric) {
    throw new Error(
      "REFUSED: online activities must attach one evaluation shape — either a " +
        "deliverable { kind, prompt, criteria: [...] } (the scholar produces " +
        "an artifact; full criteria award flair, but do not gate completion) OR " +
        "an advanceRubric { criteria: [...] } (no artifact; the " +
        "tutor grades the conversation + map interactions). Quality criteria in " +
        "systemPrompt aren't enforced. Re-call this tool with the same title " +
        "and one of the two.",
    );
  }
}

/**
 * Convert a single rubric prose string into a one-element criteria
 * array. Useful for legacy bot call sites that still pass `rubric`
 * (we're migrating them off, but this keeps the door open during the
 * migration window). Returns undefined if the string is empty.
 */
export function rubricStringToCriteria(
  rubric: string | undefined,
): DeliverableCriterion[] | undefined {
  const trimmed = rubric?.trim();
  if (!trimmed) return undefined;
  return [{ id: "overall", label: "Overall", description: trimmed }];
}

/**
 * Render the criteria array as a numbered prose block for the AI
 * rubric-check system prompt. The AI sees this and judges the
 * submission against each numbered criterion.
 */
export function renderCriteriaForRubricCheck(
  criteria: DeliverableCriterion[],
): string {
  return criteria
    .map((c, i) => {
      const head = `${i + 1}. [${c.id}] ${c.label}`;
      return c.description ? `${head}: ${c.description}` : head;
    })
    .join("\n");
}

/**
 * Same as `renderCriteriaForRubricCheck` but for tutor-facing context
 * (no [id] markers — just numbered labels + descriptions for the AI
 * tutor to refer to during the project chat).
 */
export function renderCriteriaForTutor(
  criteria: DeliverableCriterion[],
): string {
  return criteria
    .map((c, i) => {
      const head = `${i + 1}. ${c.label}`;
      return c.description ? `${head}: ${c.description}` : head;
    })
    .join("\n");
}
