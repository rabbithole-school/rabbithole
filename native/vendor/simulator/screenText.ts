/**
 * Model-authored World text is stored verbatim for audit, then screened at
 * every human-facing read seam. This conservative lexical screen is the P1
 * floor, not the final safety system: before peer-to-peer or exhibition use,
 * upgrade this seam to the shared model-based chat safety classifier while
 * keeping the same neutral replacement contract.
 */

export const SCREENED_SIMULATOR_TEXT_PLACEHOLDER = "Content unavailable for display.";

/**
 * Canonical sentinel an opponent's observation is redacted to during a
 * tournament (simulatorRuns.projectChunkForHumans). It is deliberately NOT the
 * empty-observation `"{}"`: a genuine empty observation means "senses quiet —
 * nothing nearby", and rendering a redaction as that copy both misleads the
 * reader and leaks the inference that hidden == quiet. Human-facing surfaces
 * detect this with `isRedactedObservation` and render "Hidden during
 * tournaments" instead. Kept as valid JSON so any `JSON.parse` consumer of the
 * `observationJson` wire field stays well-formed.
 */
export const REDACTED_OBSERVATION_JSON = '{"redacted":true}';

/** True when an observation JSON string is the tournament-redaction sentinel. */
export function isRedactedObservation(json: string | undefined): boolean {
  return json === REDACTED_OBSERVATION_JSON;
}

const UNSAFE_TEXT_PATTERNS = [
  /\b(?:kill yourself|self[- ]harm|suicid(?:e|al))\b/i,
  /\b(?:porn(?:ography|ographic)?|sexual(?:ly)? explicit|nudes?)\b/i,
  /\b(?:email|text|call|message) me at\b/i,
  /\b(?:home address|phone number|meet me (?:at|in))\b/i,
  /\bignore (?:all |the )?(?:previous|system) instructions?\b/i,
  /<script\b|javascript:/i,
  /\b(?:fuck|shit|bitch)\b/i,
] as const;

export function screenWorldText(
  text: string | undefined,
  options: { maxChars: number },
): string | undefined {
  if (text === undefined) return undefined;
  if (
    text.length > options.maxChars ||
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) ||
    UNSAFE_TEXT_PATTERNS.some((pattern) => pattern.test(text.normalize("NFKC")))
  ) {
    return SCREENED_SIMULATOR_TEXT_PLACEHOLDER;
  }
  return text;
}
