/**
 * Anthropic model IDs used across the backend.
 *
 * Keep this as the single source of truth so model bumps are a one-line change.
 *
 * - SONNET: most reasoning-heavy background flows. Currently Sonnet 5. (It
 *   was the scholar tutor until TRA-409; the tutor's model now lives in
 *   lib/tutorModel.TUTOR_DEFAULT_MODEL.)
 * - SONNET_5_5: the admissions email-suggestion classifier at effort `low`
 *   (lib/admissionsSignals). Matched Opus 5.5 on the spike's eval at half the
 *   cost and latency. Kept apart from SONNET so that bump stays deliberate.
 * - HAIKU: lightweight classification / title generation / standards mapping.
 *   Currently Haiku 4.5.
 * - OPUS: highest-quality reasoning, opt-in per call site for flows where output
 *   quality matters most and latency/cost are tolerable (curriculum design,
 *   deliverable/rubric generation). Currently Opus 4.8. Do NOT use in
 *   the live tutor stream (latency-sensitive) without a deliberate decision.
 * - OPUS_5_5: the staff-aide DEFAULT (see lib/aideModel.resolveAideModel),
 *   what the aide picker's "Opus" pin resolves to, and the scholar tutor's
 *   default at effort `low` (lib/tutorModel.TUTOR_DEFAULT_MODEL, TRA-409). Kept apart from OPUS on
 *   purpose: Opus 5.5 rejects forced `tool_choice` (`tool`/`any`) and can't
 *   disable thinking, and the curriculum-sim judge forces a tool call on
 *   MODELS.OPUS. Migrate those deliberately; don't bump OPUS to 5.5.
 *   Always-on adaptive thinking, like Fable: it bills as output and needs the
 *   raised max_tokens + explicit effort in lib/aideModel.
 * - FABLE: Anthropic's most capable model (Mythos-class tier above Opus).
 *   Currently Fable 5.1. Always-on thinking — expect a pause before the first
 *   visible token and thinking billed as output tokens, so pair it with a
 *   raised max_tokens (see lib/aideModel.aideMaxTokens) and an explicit
 *   effort dial (lib/aideModel.aideEffort). Staff opt into it with the aide
 *   picker's "Fable" pin; the aide default is OPUS_5_5. For the SCHOLAR
 *   tutor it is opt-in per activity only
 *   (activities.tutorModel = "fable", resolved in lib/tutorModel) — built for
 *   vibecode/build-an-app work where the tutor must reason about code AND
 *   sequence conceptual discovery; the fleet tutor default is OPUS_5_5.
 * - SONNET_5_5: the session observer (OBSERVER_MODEL; an `auto` tool call)
 *   and the in-app character and judge (APP_AI_MODEL: fast enough for a
 *   child's turn, far better judgment than Haiku; replies through
 *   structured outputs since forced tool use is unavailable). Kept apart from
 *   SONNET for the same reason as OPUS_5_5: it rejects forced `tool_choice`
 *   and disabled thinking, which SONNET's call sites rely on.
 */
export const MODELS = {
  SONNET: "claude-sonnet-5" as const,
  SONNET_5_5: "claude-sonnet-5-5" as const,
  HAIKU: "claude-haiku-4-5-20251001" as const,
  OPUS: "claude-opus-4-8" as const,
  OPUS_5_5: "claude-opus-5-5" as const,
  FABLE: "claude-fable-5-1" as const,
} as const;

/** Weekly teacher-facing SEL synthesis; Sonnet is the pre-eval baseline. */
export const SEL_SYNTHESIS_MODEL = MODELS.SONNET;

/**
 * World Automata are weak interpreters by design: scholars author the prompt,
 * Haiku executes inside code-owned physics, and the scholar verifies the run.
 * Keep the role named so a future model change is deliberate and centralized.
 */
export const AUTOMATON_MODEL = MODELS.HAIKU;

/**
 * The sandboxed-app character and judge (convex/appAiActions.ts). Opus 5.5
 * answered as well but took 5–12 s a line (its thinking cannot be turned
 * off); Sonnet 5.5 took under 3.5 s, which is what a waiting child can bear.
 */
export const APP_AI_MODEL = MODELS.SONNET_5_5;

/**
 * The session observer (convex/observer.ts) and its replay
 * (convex/masteryReDerive.ts). Moved off Opus 4.8 (then set per deployment by
 * an OBSERVER_MODEL env var) to a code constant, so a model change is one
 * reviewed line like every other id here. Sonnet 5.5 rejects forced tool use,
 * so the observer's tool is offered with `tool_choice: auto` — see
 * lib/observerShared.buildObserverRequest for why not structured outputs.
 * Eval: evals/observer/FINDINGS.md.
 */
export const OBSERVER_MODEL = MODELS.SONNET_5_5;

/**
 * Thinking depth for OBSERVER_MODEL (`output_config.effort`). `high` is also
 * the API default, sent explicitly so a future default change can't move it.
 * It judged best of low/medium/high on the observer fixtures (4.50 vs
 * 4.17/4.30 overall, Opus 4.8 4.37) for ~8% more cost than low.
 */
export const OBSERVER_EFFORT = "high" as const;

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
 * The tutor-quality judge (evals/tutor-quality, and czi-crosscheck through
 * its judge seam). It grades tutor MODELS against each other, so it follows
 * one rule JUDGE_MODEL doesn't need: never judge with a model weaker than
 * either model being compared (enforced by assertJudgeNotWeaker in
 * evals/tutor-quality/lib/judgeEngine.ts). Opus 4.8 judging Opus 5.5 called a
 * bake-off a wash that a blind read called 10-0 (TRA-408), so this sits on
 * the top tier. Opus 5.5 since 2026-10-18: on 400 expert-labeled classroom
 * exchanges it tracked the experts as well as Fable 5.1 and agreed with it
 * within one point on 96-100% of turns (evals/uptake-repro/FINDINGS.md), for
 * less money and time. A comparison involving a Fable tutor still needs
 * JUDGE_MODEL=claude-fable-5-1; assertJudgeNotWeaker refuses otherwise.
 */
export const TUTOR_JUDGE_MODEL = MODELS.OPUS_5_5;

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
  [MODELS.SONNET_5_5]: "Claude Sonnet 5.5",
  [MODELS.HAIKU]: "Claude Haiku 4.5",
  [MODELS.OPUS]: "Claude Opus 4.8",
  [MODELS.OPUS_5_5]: "Claude Opus 5.5",
  [MODELS.FABLE]: "Claude Fable 5.1",
};

/**
 * Who makes the model — a plain fact for the transparency card. Anthropic is a
 * public-benefit corporation, hence "PBC".
 */
export const MODEL_MAKER = "Anthropic PBC" as const;

/**
 * Human label for a raw model id, for any string a USER will read — the
 * staff-aide model picker, the `set_aide_model` tool's description and
 * result, the refusal-retry disclosure.
 *
 * Always derive; never hand-write "Claude Fable 5" into a sentence. The
 * hand-synced copy in `set_aide_model` sat a full version behind MODELS for
 * the whole Fable 5 → 5.1 bump, telling staff the default was a model that no
 * longer ran. An unknown id falls back to the raw slug rather than throwing —
 * a stale id in a historical row must not break a render.
 */
export function modelLabel(id: string): string {
  return MODEL_DISPLAY[id as ModelId] ?? id;
}

/**
 * Knowledge cutoff for the live tutor model (lib/tutorModel.TUTOR_DEFAULT_MODEL),
 * co-located here so a model bump updates the id and its training date together.
 *
 * `null` = "not confidently confirmed" → the UI shows an evergreen, always-true
 * line ("it learned from information up to a while ago…") instead of a specific
 * date. Source the real value from Anthropic's official model card before
 * setting a date: a confidently-wrong cutoff would undercut the curtain's
 * companion message that a computer can sound sure and still be wrong.
 *
 * TODO: confirm exact knowledge cutoff for claude-opus-5-5 from the Anthropic
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

/**
 * OpenAI GPT-Image-2.5 — the CHARM layer's image model (manipulative theme
 * icons, world species sprites, earned flair, quest badges). Chosen over Gemini
 * for exactly one property those four pipelines need and Gemini lacks: it can
 * return a real transparent alpha channel (`background: "transparent"`), so a
 * sprite no longer has to be rendered on a chroma screen and keyed out
 * afterwards. Called via the Images API with OPENAI_API_KEY; see
 * lib/openaiImage.ts.
 *
 * "Flare" is the fast tier; "Sunburst" is the precision tier, meaningfully
 * slower (measured 18.6s vs 12.3s on the same species prompt) for no visible
 * gain on flat sprite art, so it is not wired up.
 */
export const OPENAI_IMAGE_MODEL = "gpt-image-2.5-flare" as const;

export const OPENAI_IMAGE_MODELS = [OPENAI_IMAGE_MODEL] as const;
export type OpenAIImageModel = (typeof OPENAI_IMAGE_MODELS)[number];

/**
 * Usage-ledger keys for the image model. Cost per image depends on the quality
 * tier as much as on the model — "medium" is 2.2x "low" in image-output tokens
 * — so the ledger records the TIER, not just the model id, and lib/usageReport
 * prices each one. Recording both tiers under the bare model id would silently
 * halve every badge's reported cost.
 */
export function openaiImageUsageKey(
  model: OpenAIImageModel,
  quality: "low" | "medium" | "high",
): string {
  return `${model}@${quality}`;
}
