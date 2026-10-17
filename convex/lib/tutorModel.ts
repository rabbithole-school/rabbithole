import { aideEffort, aideMaxTokens, type AideEffort } from "./aideModel";
import { MODELS, type ModelId } from "./models";

export type TutorModelPref = "sonnet" | "fable";

/**
 * The scholar tutor's fleet default, and the one place it is named. Every
 * surface that says which model the tutor runs on reads this, never a
 * MODELS.* literal.
 *
 * Opus 5.5 at effort `low` since TRA-409 (2026-09-27): blind reads of real
 * sessions preferred it clearly (it teaches when a kid is stuck instead of
 * asking question after question), for about +2.5s per reply and ~1.9x the
 * Sonnet 5 tutor cost. The stored "sonnet" preference predates the switch and
 * means "follow the default".
 */
export const TUTOR_DEFAULT_MODEL = MODELS.OPUS_5_5;

export function normalizeStoredTutorModel(
  pref: TutorModelPref | null | undefined,
): "fable" | undefined {
  return pref === "fable" ? "fable" : undefined;
}

export function resolveTutorModel(
  pref: TutorModelPref | null | undefined,
): ModelId {
  return pref === "fable" ? MODELS.FABLE : TUTOR_DEFAULT_MODEL;
}

/**
 * The beta header for Anthropic's server-side refusal fallback, in its
 * `fallbacks: "default"` form (Anthropic picks the fallback model per refusal
 * category, so we never maintain a model list).
 */
export const TUTOR_REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/**
 * Should this tutor request opt into the server-side refusal fallback?
 *
 * Fable 5.1 and Opus 5.5 run pre-output safety classifiers (cyber, bio; Opus
 * 5.5 also `reasoning_extraction`) that Sonnet 5 does not. A decline comes
 * back as `stop_reason: "refusal"` with no text. The tutor stream has no retry
 * of its own, so without this a false positive leaves a scholar with no
 * answer mid-lesson. With it, the API re-runs the declined request on its
 * recommended fallback model inside the same call. Anthropic's Opus 5.5
 * migration guide lists this opt-in as blocking ("ship the opt-in from day
 * one"). Sonnet 5 has nothing to fall back from, so it sends no param.
 */
export function tutorRefusalFallback(model: string): boolean {
  return model === MODELS.FABLE || model === MODELS.OPUS_5_5;
}

/**
 * The tutor's effort dial. Opus 5.5 runs at `low`: that is the setting the
 * TRA-409 blind reads and latency runs measured, and the scholar is waiting
 * on every reply. (The staff aide runs Opus 5.5 at `high`; see
 * lib/aideModel.aideEffort.) Every other model keeps the aide's dial.
 */
export function tutorEffort(model: string): AideEffort | undefined {
  return model === MODELS.OPUS_5_5 ? "low" : aideEffort(model);
}

export function tutorRuntime(
  model: ModelId,
  // A turn that builds an app (TRA-519: any session with builder features)
  // gets the big budget, so a whole HTML app fits in one tool call.
  opts: { appBuild?: boolean } = {},
): {
  maxTokens: number;
  effort: AideEffort | undefined;
  refusalFallback: boolean;
} {
  return {
    maxTokens:
      (model === MODELS.FABLE || model === MODELS.OPUS_5_5) &&
      opts.appBuild === true
        ? 64000
        : aideMaxTokens(model, 4096),
    effort: tutorEffort(model),
    refusalFallback: tutorRefusalFallback(model),
  };
}

/**
 * Can this tutor request carry a mid-conversation `role: "system"` message
 * (the per-turn session state, sessionStreamHelpers.layoutTutorRequest)?
 *
 * The tutor runs Opus 5.5 or Fable 5.1 (resolveTutorModel), and the refusal
 * fallback (`fallbacks: "default"`) re-runs a declined request on Opus 5 or
 * Opus 4.8. Anthropic documents all four as accepting mid-conversation system
 * messages with no beta header, and Sonnet 5 as rejecting them with a 400, so
 * the list is explicit: a model not on it gets the same text as user-turn
 * context instead of a request the API may refuse. Probed live 2026-10-14 on
 * all four, including the tool loop (user → system → assistant(tool_use) →
 * user(tool_result)).
 */
const MID_CONVERSATION_SYSTEM_MODELS: ReadonlySet<string> = new Set([
  MODELS.OPUS_5_5,
  MODELS.FABLE,
  "claude-opus-5",
  MODELS.OPUS,
]);

export function supportsMidConversationSystem(model: string): boolean {
  return MID_CONVERSATION_SYSTEM_MODELS.has(model);
}
