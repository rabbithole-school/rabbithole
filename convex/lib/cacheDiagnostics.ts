/**
 * Prompt-cache miss diagnostics for one tutor turn (Anthropic cache
 * diagnostics, https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics).
 *
 * Each request carries `diagnostics: { previous_message_id }` — the `id` of the
 * previous API response in the same conversation, or `null` on the first one.
 * The `diagnostics` object is the opt-in: the API stores a fingerprint (hashes
 * and token-count estimates, never prompt text) only for requests that carry
 * it, so EVERY request must send it or the next one gets
 * `previous_message_not_found`. The response's `diagnostics` names the first
 * place the two requests diverged.
 *
 * A tutor turn can be several API requests (the tool runner's iterations). All
 * of them compare against the previous turn's LAST request: a later iteration
 * only appends to the same prefix, so that comparison stays valid without
 * reaching into the runner's params mid-loop. The turn records ONE value, kept
 * on its `usageEvents` row as `cacheMissAt`:
 *
 * - `first`     — no previous response to compare against (first turn, or
 *                 the first turn after this shipped).
 * - `none`      — compared, no divergence. A big cache write on a `none` turn
 *                 is NOT a changed prefix: the cache entry expired, or the
 *                 previous turn appended more than 20 content positions and
 *                 pushed its breakpoint out of the 20-block lookback window.
 * - `pending`   — the comparison had not finished when the response started.
 * - otherwise the API's `cache_miss_reason.type` verbatim: `model_changed`,
 *   `system_changed`, `tools_changed`, `messages_changed`,
 *   `previous_message_not_found`, `unavailable` (an open set — an unknown
 *   type is stored as-is, capped in length).
 *
 * The first `*_changed` seen in the turn wins (it is the actionable one);
 * otherwise the turn's first request decides.
 *
 * The pinned SDK (0.91.1) does not type `diagnostics`, so it travels as a plain
 * body field (like `fallbacks` in http.ts) and is read off `message_start`
 * through `unknown`.
 */

const MAX_TYPE_LENGTH = 40;

/** The value one turn records; see the file header for the vocabulary. */
export type CacheMissAt = string;

/** Classify one response's `diagnostics` field (from `message_start`). */
export function classifyCacheDiagnostics(
  diagnostics: unknown,
  previousMessageId: string | null,
): CacheMissAt | undefined {
  if (!previousMessageId) return "first";
  // Absent: the API returned no field at all (it ignored the opt-in). Record
  // nothing rather than claim a clean comparison.
  if (diagnostics === undefined) return undefined;
  if (diagnostics === null) return "none";
  if (typeof diagnostics !== "object") return undefined;
  const reason = (diagnostics as { cache_miss_reason?: unknown })
    .cache_miss_reason;
  if (reason === null || reason === undefined) return "pending";
  const type = (reason as { type?: unknown }).type;
  if (typeof type !== "string" || !type) return undefined;
  return type.slice(0, MAX_TYPE_LENGTH);
}

function isChanged(value: CacheMissAt | undefined): boolean {
  return !!value && value.endsWith("_changed");
}

export interface CacheDiagnosticsTracker {
  /** Spread into every request body of the turn. */
  readonly requestBody: {
    diagnostics: { previous_message_id: string | null };
  };
  /** Feed each `message_start` event's `message`. */
  observe(message: unknown): void;
  /** The turn's recorded value (undefined when nothing was observed). */
  readonly cacheMissAt: CacheMissAt | undefined;
  /** The last response id seen — the next turn's `previous_message_id`. */
  readonly lastResponseId: string | undefined;
}

export function createCacheDiagnosticsTracker(
  previousMessageId: string | null | undefined,
): CacheDiagnosticsTracker {
  const previous = previousMessageId || null;
  let cacheMissAt: CacheMissAt | undefined;
  let observedAny = false;
  let lastResponseId: string | undefined;
  return {
    requestBody: { diagnostics: { previous_message_id: previous } },
    observe(message) {
      if (!message || typeof message !== "object") return;
      const { id, diagnostics } = message as {
        id?: unknown;
        diagnostics?: unknown;
      };
      if (typeof id === "string" && id) lastResponseId = id;
      const value = classifyCacheDiagnostics(diagnostics, previous);
      if (!observedAny) {
        observedAny = true;
        cacheMissAt = value;
      } else if (!isChanged(cacheMissAt) && isChanged(value)) {
        cacheMissAt = value;
      }
    },
    get cacheMissAt() {
      return cacheMissAt;
    },
    get lastResponseId() {
      return lastResponseId;
    },
  };
}
