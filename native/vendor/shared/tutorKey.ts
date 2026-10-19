/**
 * The SSE `error` the tutor stream (`/session-stream`) sends, with a 503,
 * when the deployment has no ANTHROPIC_API_KEY (TRA-536). Like
 * LLM_BUSY_MESSAGE it is a protocol sentinel as well as copy: web and native
 * clients recognize the refusal by comparing against this exact string, and an
 * older client that doesn't shows its ordinary failed-turn notice instead.
 */
export const TUTOR_NEEDS_KEY_MESSAGE =
  "The tutor needs an Anthropic API key before it can answer.";

/**
 * Where the key can be added. Only the public local runner (`pnpm
 * local:setup`) serves this page; the stream names it (`addKeyPath`) only on
 * that deployment, and everywhere else the page is a 404.
 */
export const TUTOR_KEY_PATH = "/tutor-key";

/** True when a tutor stream error says the deployment has no Anthropic key. */
export function isTutorNeedsKeyError(error: unknown): boolean {
  return error === TUTOR_NEEDS_KEY_MESSAGE;
}
