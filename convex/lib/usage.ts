/**
 * Pure helpers for AI token-usage accounting (no ctx, no node) — shared by
 * the recorder in convex/usage.ts and the streaming loops in
 * convex/lib/aideStream.ts + convex/http.ts.
 *
 * The four counts mirror Anthropic's `usage` object so the weekly cost
 * report (convex/lib/usageReport.ts) can price each independently:
 *   - inputTokens      → base (uncached) input
 *   - cacheWriteTokens → cache_creation_input_tokens (5-min ephemeral write)
 *   - cacheReadTokens  → cache_read_input_tokens (cache hit)
 *   - outputTokens     → output (for Fable, includes always-on thinking)
 *
 * Unit-tested in convex/lib/__tests__/usage.test.ts.
 */

/** The subset of Anthropic's `usage` object we read (non-streaming + streaming). */
export interface AnthropicUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Our normalized, storable token breakdown. */
export interface UsageBreakdown {
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export function emptyUsage(): UsageBreakdown {
  return {
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
  };
}

const n = (x: number | null | undefined): number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0;

/** Normalize a non-streaming `response.usage` into our breakdown. */
export function normalizeAnthropicUsage(
  u: AnthropicUsage | null | undefined,
): UsageBreakdown {
  if (!u) return emptyUsage();
  return {
    inputTokens: n(u.input_tokens),
    cacheWriteTokens: n(u.cache_creation_input_tokens),
    cacheReadTokens: n(u.cache_read_input_tokens),
    outputTokens: n(u.output_tokens),
  };
}

/**
 * Fold a streaming `message_start` usage (which carries the input + cache
 * counts for that message) into an accumulator. Output is intentionally
 * NOT taken here — it arrives incrementally on `message_delta` (see
 * addDeltaOutput) so the two never double-count. Across a tool-loop's
 * several messages the input/cache counts sum correctly (each message has
 * its own prefill).
 */
export function addStartUsage(
  acc: UsageBreakdown,
  u: AnthropicUsage | null | undefined,
): void {
  if (!u) return;
  acc.inputTokens += n(u.input_tokens);
  acc.cacheWriteTokens += n(u.cache_creation_input_tokens);
  acc.cacheReadTokens += n(u.cache_read_input_tokens);
}

/** Fold a streaming `message_delta` output count into an accumulator. */
export function addDeltaOutput(
  acc: UsageBreakdown,
  outputTokens: number | null | undefined,
): void {
  acc.outputTokens += n(outputTokens);
}

/** True when any dimension is nonzero (skip recording no-op events). */
export function hasUsage(u: UsageBreakdown): boolean {
  return (
    u.inputTokens > 0 ||
    u.cacheWriteTokens > 0 ||
    u.cacheReadTokens > 0 ||
    u.outputTokens > 0
  );
}
