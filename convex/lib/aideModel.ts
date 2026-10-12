/**
 * Staff-aide model resolution — "vote with your feet".
 *
 * Every staff-aide surface (the /aide-stream Chat tab, the unit-designer
 * Curriculum Bot, and the Slack bot) resolves its Anthropic model through
 * resolveAideModel so a staff member's per-user preference
 * (users.aideModel: "sonnet" | "opus" | "fable" | absent) wins over the
 * fleet default. Precedence is deliberately just TWO rules:
 *
 *   1. the user's own pin ("sonnet" → Sonnet 5, "opus" → Opus 5.5,
 *      "fable" → Fable 5.1) — explicit and clearable; absent = the default
 *   2. MODELS.OPUS_5_5 — the code default (moved off Fable 5.1 on
 *      2026-09-24). Teacher reasoning is upstream of everything else, so the
 *      default is a top-tier model; Fable stays one pin away for anyone who
 *      wants the most capable one, and the same picker's "Default" entry
 *      clears any pin.
 *
 * There is deliberately NO env-var override. An `AIDE_MODEL` lever used to
 * sit BETWEEN those two rules and was documented as an instant fleet revert
 * — but a pin outranked it, so it silently could not reach the pinned users
 * it most needed to reach (2026-09-03 incident). The staff default is a code
 * constant like every other model id, so a fleet revert is the same one-line
 * change + deploy as any model bump, and there is no third rule to reason
 * about.
 *
 * The parent-chat surface deliberately does NOT go through this — parents
 * aren't staff and stay on the Sonnet default.
 *
 * Pure functions, no ctx — unit-tested in convex/__tests__/aideModel.test.ts.
 */

import { MODELS, type ModelId } from "./models";

/** The users.aideModel field values (absent = fleet default). */
export type AideModelPref = "sonnet" | "opus" | "fable";

export function resolveAideModel(
  pref: AideModelPref | null | undefined,
): ModelId {
  if (pref === "fable") return MODELS.FABLE;
  if (pref === "opus") return MODELS.OPUS_5_5;
  if (pref === "sonnet") return MODELS.SONNET;
  return MODELS.OPUS_5_5;
}

/**
 * Which model re-runs a request that the primary model REFUSED — the fix for
 * a false-positive safety-classifier decline, applied to the REQUEST rather
 * than to the person.
 *
 * Fable and Opus 5.5 run extra pre-output safety classifiers (Opus 5.5 adds
 * `bio` and `reasoning_extraction` to `cyber`), and they fire on plainly
 * benign staff asks (the 2026-09-03 incident: "show a picture of a fulcrum
 * and explain it briefly"). Opus 4.8 doesn't run them, so the runner silently
 * retries that ONE request on Opus 4.8 and streams the real answer — see
 * lib/aideStream.
 *
 * This exists because the old remedy was to tell the user to switch models,
 * and the only switch available was a PERMANENT, per-person, all-surfaces
 * pin. A momentary classifier miss became an invisible forever-downgrade off
 * the best model. Handle the moment; leave the person on the default.
 *
 * `null` = don't retry (no better tier to fall back to — a refusal on any
 * other model is a real decline, not a classifier artifact).
 */
export function aideRefusalFallback(model: string): ModelId | null {
  return model === MODELS.FABLE || model === MODELS.OPUS_5_5
    ? MODELS.OPUS
    : null;
}

/**
 * Fable's and Opus 5.5's always-on thinking bills as OUTPUT tokens and counts
 * against max_tokens — a 4096 cap tuned for Sonnet can be eaten by thinking
 * and truncate the visible answer. All aide runners stream, so a raised cap
 * costs nothing when unused.
 */
export function aideMaxTokens(model: ModelId, base: number): number {
  return model === MODELS.FABLE || model === MODELS.OPUS_5_5
    ? Math.max(base, 16000)
    : base;
}

/** The `output_config.effort` levels the API accepts. */
export type AideEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The aide's thinking-depth dial (`output_config.effort`), keyed off the model.
 *
 * Fable 5.1 moved the quality/cost frontier far enough that its MEDIUM effort
 * sits where Fable 5's default (`high`) did, so the aide asks for `medium`
 * explicitly instead of inheriting the API default. Two things get cheaper at
 * once: always-on thinking bills as output tokens ($50/MTok, the priciest
 * line on the rate card — see lib/usageReport.PRICING), and less thinking
 * means less time in the pre-text pause staff watch in AideThread.
 *
 * Opus 5.5 is the opposite case: its API default is `medium` (one level below
 * every earlier Opus), and it sits below Fable, so the aide asks for `high`
 * explicitly. That keeps the default aide at the depth Opus 4.8 pins ran at.
 *
 * `undefined` for every other model = "send no `output_config`", so the
 * Sonnet pin and the Opus 4.8 refusal-retry stay byte-identical to before at
 * the API default (`high`). Bump the Fable value to "high" to revert its dial
 * without touching the model itself.
 */
export function aideEffort(model: string): AideEffort | undefined {
  if (model === MODELS.FABLE) return "medium";
  if (model === MODELS.OPUS_5_5) return "high";
  return undefined;
}

/** The `thinking` param the staff aide sends when it streams reasoning. */
export type AideThinking = { type: "adaptive"; display: "summarized" };

/**
 * The `thinking` request param for an aide run — only when the surface
 * streams reasoning to STAFF (`AideStreamConfig.streamThinking`) AND the
 * active model is one of the always-thinking tiers (Fable 5.1, Opus 5.5).
 *
 * Both always think, but their API default `display` is "omitted": the
 * thinking blocks arrive with empty text, so the inline reasoning accordion
 * (PR #718) opened and never filled. "summarized" is what puts words in
 * `thinking_delta`. Live probes 2026-09-26: Opus 5.5 @ high, default →
 * 1 block / 0 chars, summarized → 92 chars; Fable 5.1 @ medium, default →
 * 1 block / 0 chars, summarized → 659–887 chars.
 *
 * `undefined` everywhere else = "send no `thinking` param", so behavior is
 * byte-identical to before:
 *  - non-staff surfaces (parent chat) never ask — the monologue must not
 *    leave the server for them, so there is nothing to summarize for;
 *  - Opus 4.8 (the refusal-retry fallback) does NOT think by default — the
 *    probe got 0 thinking blocks — so sending adaptive would switch thinking
 *    ON (new cost + latency), not just reveal it;
 *  - Sonnet 5 is unverified here (the probe saw it think sometimes and not
 *    others) — leave it at the API default until measured.
 */
export function aideThinking(
  model: string,
  streamThinking: boolean | undefined,
): AideThinking | undefined {
  return streamThinking &&
    (model === MODELS.FABLE || model === MODELS.OPUS_5_5)
    ? { type: "adaptive", display: "summarized" }
    : undefined;
}
