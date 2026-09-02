/**
 * Anthropic model IDs used across the backend.
 *
 * Keep this as the single source of truth so model bumps are a one-line change.
 *
 * - SONNET: main tutor (streaming chat), observer analysis, all reasoning-heavy
 *   flows. Currently Sonnet 5.
 * - HAIKU: lightweight classification / title generation / standards mapping.
 *   Currently Haiku 4.5.
 * - OPUS: highest-quality reasoning, opt-in per call site for flows where output
 *   quality matters most and latency/cost are tolerable (observer, curriculum
 *   design, deliverable/rubric generation). Currently Opus 4.8. Do NOT use in
 *   the live tutor stream (latency-sensitive) without a deliberate decision.
 * - FABLE: Anthropic's most capable model (Mythos-class tier above Opus).
 *   Always-on thinking — expect a long (~10-30s) pause before the first
 *   visible token and thinking billed as output tokens, so pair it with a
 *   raised max_tokens (see lib/aideModel.aideMaxTokens). The staff-aide
 *   DEFAULT (see lib/aideModel.resolveAideModel + users.aideModel — teacher
 *   reasoning is upstream of everything, so staff get the strongest model
 *   unless they pin a cheaper one); NEVER the tutor.
 */
export const MODELS = {
  SONNET: "claude-sonnet-5" as const,
  HAIKU: "claude-haiku-4-5-20251001" as const,
  OPUS: "claude-opus-4-8" as const,
  FABLE: "claude-fable-5" as const,
} as const;

/** Eval-selected live model for pad-grounded one-line/step hint cells. */
export const PRACTICE_PAD_HINT_MODEL = MODELS.SONNET;

/** Weekly teacher-facing SEL synthesis; Sonnet is the pre-eval baseline. */
export const SEL_SYNTHESIS_MODEL = MODELS.SONNET;

/**
 * World Automata are weak interpreters by design: scholars author the prompt,
 * Haiku executes inside code-owned physics, and the scholar verifies the run.
 * Keep the role named so a future model change is deliberate and centralized.
 */
export const AUTOMATON_MODEL = MODELS.HAIKU;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];

/**
 * Frozen scoring ruler for the eval harnesses (evals/). Deliberately SEPARATE
 * from MODELS.OPUS: bumping MODELS.OPUS must never silently re-baseline
 * historical eval scores. Bump JUDGE_MODEL only as a deliberate act, and when
 * you do, re-score a reference set old-vs-new and note the shift in the
 * relevant evals FINDINGS.md (judge-drift canary).
 * In-product judging (e.g. curriculum Rehearse scorecards) intentionally
 * stays on MODELS.OPUS — this constant is for offline eval comparability.
 */
export const JUDGE_MODEL = "claude-opus-4-8" as const;

/**
 * Friendly display labels for the raw model ids above.
 *
 * Kid-/parent-facing surfaces — e.g. the "What the tutor actually is" identity
 * card on /me — must show a human label ("Claude Sonnet 5"), never the raw
 * `claude-sonnet-5` slug. Kept next to MODELS so a model bump updates the id
 * and its label together (single source of truth).
 */
export const MODEL_DISPLAY: Record<ModelId, string> = {
  [MODELS.SONNET]: "Claude Sonnet 5",
  [MODELS.HAIKU]: "Claude Haiku 4.5",
  [MODELS.OPUS]: "Claude Opus 4.8",
  [MODELS.FABLE]: "Claude Fable 5",
};

/**
 * Who makes the model — a plain fact for the transparency card. Anthropic is a
 * public-benefit corporation, hence "PBC".
 */
export const MODEL_MAKER = "Anthropic PBC" as const;

/**
 * Knowledge cutoff for the live tutor model (MODELS.SONNET), co-located here so
 * a model bump updates the id and its training date together.
 *
 * `null` = "not confidently confirmed" → the UI shows an evergreen, always-true
 * line ("it learned from information up to a while ago…") instead of a specific
 * date. Source the real value from Anthropic's official model card before
 * setting a date: a confidently-wrong cutoff would undercut the curtain's
 * companion message that a computer can sound sure and still be wrong.
 *
 * TODO: confirm exact knowledge cutoff for claude-sonnet-5 from the Anthropic
 * model card (docs.anthropic.com models overview) and set it here.
 */
export const TUTOR_KNOWLEDGE_CUTOFF: string | null = null;

/**
 * Google Gemini image model ("Nano Banana Pro"). Used for both text-to-image
 * (`generate_image` tutor tool) and image+instruction editing (Magic
 * Annotations). Kept separate from MODELS so the Anthropic-only `ModelId`
 * union stays clean. Called via the Generative Language REST API with
 * GEMINI_API_KEY.
 */
export const GEMINI_IMAGE_MODEL = "gemini-3-pro-image-preview" as const;

/**
 * Previous-generation image model ("Nano Banana 2"). Theme-icon and Flair-art
 * generation fall back to this model only when the primary model reports
 * exhausted quota. Other image surfaces keep their existing primary-only
 * behavior.
 */
export const GEMINI_IMAGE_QUOTA_FALLBACK_MODEL = "gemini-3.1-flash-image-preview" as const;

export const GEMINI_IMAGE_MODELS = [
  GEMINI_IMAGE_MODEL,
  GEMINI_IMAGE_QUOTA_FALLBACK_MODEL,
] as const;
export type GeminiImageModel = (typeof GEMINI_IMAGE_MODELS)[number];
