/**
 * Staff-aide model resolution — "vote with your feet".
 *
 * Every staff-aide surface (the /aide-stream Chat tab, the unit-designer
 * Curriculum Bot, and the Slack bot) resolves its Anthropic model through
 * resolveAideModel so a staff member's per-user preference
 * (users.aideModel: "sonnet" | "opus" | "fable" | absent) wins over the
 * fleet default. Precedence:
 *
 *   1. the user's own preference ("sonnet" → Sonnet 5, "opus" → Opus 4.8,
 *      "fable" → Fable 5) — an explicit pin, absent = the fleet default
 *   2. the AIDE_MODEL env var (fleet-wide default override, must be a
 *      known model id — anything else is ignored, fail-open to the code
 *      default). This is the INSTANT REVERT LEVER: set
 *      AIDE_MODEL=claude-sonnet-5 on prod to cut fleet aide spend without a
 *      deploy if Fable's cost runs hot.
 *   3. MODELS.FABLE — the code default. Teacher reasoning is upstream of
 *      everything else, so the staff aide defaults to Anthropic's most
 *      capable model; individuals can pin cheaper models (Sonnet/Opus) via
 *      the picker, and the env lever above reverts the whole fleet.
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
  if (pref === "opus") return MODELS.OPUS;
  if (pref === "sonnet") return MODELS.SONNET;
  const envDefault =
    typeof process !== "undefined" ? process.env.AIDE_MODEL : undefined;
  if (
    envDefault &&
    (Object.values(MODELS) as string[]).includes(envDefault)
  ) {
    return envDefault as ModelId;
  }
  return MODELS.FABLE;
}

/**
 * Fable's always-on thinking bills as OUTPUT tokens and counts against
 * max_tokens — a 4096 cap tuned for Sonnet can be eaten by thinking and
 * truncate the visible answer. All aide runners stream, so a raised cap
 * costs nothing when unused.
 */
export function aideMaxTokens(model: ModelId, base: number): number {
  return model === MODELS.FABLE ? Math.max(base, 16000) : base;
}
