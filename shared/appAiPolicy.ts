// Contract for server-backed AI calls made from inside a sandboxed app through
// the `window.rabbithole` bridge: a conversational character
// (`rabbithole.character.say`) and a one-shot judge (`rabbithole.judge`). Both
// ride one generic request/response message pair in `lib/appStateBridge.mjs`.
// The persona, transcript, and rubric live on the server; the app only ever
// sends the scholar's text and receives a bounded reply. Pure TS: shared by the
// bridge SDK, both hosts (vendored to native), and Convex.

/** The scholar's line to the character, as typed into the app. */
export const MAX_CHARACTER_LINE_CHARS = 500;
/** One character reply line. */
export const MAX_CHARACTER_REPLY_CHARS = 480;
/** The answer an app submits to a judge. */
export const MAX_JUDGE_ANSWER_CHARS = 2_000;
/** A judge's optional feedback sentence. */
export const MAX_JUDGE_FEEDBACK_CHARS = 280;
/** A tutor's standing direction to the character. */
export const MAX_DIRECTION_CHARS = 500;
/**
 * The authored character persona. Room for a sheet that describes each stage
 * of a lesson and what earns each verdict, which is what keeps a character's
 * judgments consistent; a one-paragraph persona needs a fraction of it.
 */
export const MAX_PERSONA_CHARS = 10_000;
/** The author's notes to the tutor who directs the character. */
export const MAX_DIRECTOR_NOTES_CHARS = 2_500;
/** One authored judge rubric. */
export const MAX_RUBRIC_CHARS = 3_000;
export const MAX_MOODS = 6;
export const MAX_VERDICTS = 8;
export const MAX_JUDGES = 4;
/** Client-side ceiling on one bridge request before it rejects `timeout`. */
export const APP_REQUEST_TIMEOUT_MS = 20_000;

/** Same grammar the bridge parser enforces on `judge(judgeId, …)`. */
export const APP_JUDGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/**
 * Optional app-supplied facts sent with `character.say` / `judge`
 * (`{ context: { stage: 4, mode: "rule" } }`): where the scene or task stands,
 * which the app knows exactly and a model would otherwise have to infer from
 * history. Shown to the model as an `<app_state>` block (keys sorted), never
 * as the child's words. Small and flat on purpose: labelled scalars, not app
 * state. Twelve leaves room for a few scene facts plus a short list the
 * character must honour on every call (Teach the robot sends its rulebook as
 * `rule1`…`rule7`).
 */
export const MAX_APP_AI_CONTEXT_KEYS = 12;
export const MAX_APP_AI_CONTEXT_KEY_CHARS = 32;
export const MAX_APP_AI_CONTEXT_VALUE_CHARS = 120;
const APP_AI_CONTEXT_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export type AppAiContext = Record<string, string | number | boolean>;

/**
 * The one normalization every layer applies (bridge parser, server action):
 * a plain object only; identifier-like keys within the length cap; string
 * values trimmed, whitespace-collapsed (so each fact stays one prompt line),
 * and clamped; finite numbers and booleans as-is; anything else dropped. Keeps
 * the first `MAX_APP_AI_CONTEXT_KEYS` valid entries in insertion order.
 * `undefined` when nothing survives.
 */
export function normalizeAppAiContext(value: unknown): AppAiContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return undefined;
  const context: AppAiContext = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (kept >= MAX_APP_AI_CONTEXT_KEYS) break;
    if (
      key.length > MAX_APP_AI_CONTEXT_KEY_CHARS ||
      !APP_AI_CONTEXT_KEY_PATTERN.test(key)
    ) {
      continue;
    }
    let normalized: string | number | boolean;
    if (typeof raw === "string") {
      normalized = raw
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_APP_AI_CONTEXT_VALUE_CHARS)
        .trimEnd();
      if (!normalized) continue;
    } else if (typeof raw === "number" && Number.isFinite(raw)) {
      normalized = raw;
    } else if (typeof raw === "boolean") {
      normalized = raw;
    } else {
      continue;
    }
    context[key] = normalized;
    kept++;
  }
  return kept > 0 ? context : undefined;
}

export const APP_BRIDGE_ERROR_CODES = [
  "unavailable",
  "busy",
  "timeout",
  "invalid",
  "failed",
  "needs-gesture",
] as const;

export type AppBridgeErrorCode = (typeof APP_BRIDGE_ERROR_CODES)[number];

export type AppBridgeMethod = "character.say" | "judge";

export type CharacterReply = {
  line: string;
  mood: string;
  verdict?: string;
};

export type JudgeReply = {
  verdict: string;
  feedback?: string;
};

export type AppBridgeResponsePayload<Result = CharacterReply | JudgeReply> =
  | { ok: true; result: Result }
  | { ok: false; error: { code: AppBridgeErrorCode; message: string } };

/** A line the tutor speaks through the character, delivered on init/update. */
export type CharacterLine = {
  id: string;
  line: string;
  mood?: string;
  verdict?: string;
};
