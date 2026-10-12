// Client-side resilience for the tutor stream (`/session-stream`).
//
// When the per-user LLM limiter refuses a turn it answers HTTP 429 +
// `Retry-After` (seconds) with an SSE body of `{ error: LLM_BUSY_MESSAGE }`
// (see convex/http.ts). The scholar-facing surfaces must WAIT AND RETRY that
// refusal rather than toast-and-give-up, so a busy backend reads as a slow
// turn, not an evaporated message. This module owns the framework-free
// decision logic so web (hooks/useAgentStream.ts) and native
// (native/src/app/session/[id].tsx) behave identically — it is vendored into
// native/vendor/shared/ byte-for-byte (native/scripts/sync-vendor.js).

// ── Retry budget ──────────────────────────────────────────────────────────
/** Hard ceiling on time spent waiting-then-retrying before giving up. */
export const STREAM_RETRY_BUDGET_MS = 45_000;
/**
 * Wait used when the server sends no (or an unparseable) `Retry-After`, and the
 * floor every retry delay is clamped up to — a concurrency denial sends
 * `Retry-After: 5`, so 5 s is the natural cadence.
 */
export const STREAM_RETRY_DEFAULT_DELAY_MS = 5_000;
/**
 * A retry delay is clamped to this ceiling. It is deliberately BELOW the dead
 * window (STREAM_DEAD_PLACEHOLDER_MS = 20 s): because /session-stream stamps
 * liveness on every 429, a retry that waits ≤ 15 s keeps the placeholder no
 * more than ~15 s stale, so another tab (or retryAssistantTurn) never mistakes
 * a live, still-retrying turn for a dead one.
 */
export const STREAM_RETRY_MAX_DELAY_MS = 15_000;
/**
 * A `Retry-After` ABOVE this means a user-window denial (which can be minutes)
 * — we don't wait that out; we stop and let the surface show the inline retry.
 * Distinct from the delay ceiling above: a 5–30 s `Retry-After` is honored (but
 * capped at the 15 s ceiling), only a longer one aborts the retry loop.
 */
export const STREAM_RETRY_STOP_ABOVE_MS = 30_000;

/**
 * Parse an HTTP `Retry-After` header carrying an integer number of seconds
 * (the only form the tutor stream emits). Returns seconds, or null when the
 * header is absent, empty, non-numeric, or negative.
 */
export function parseRetryAfterSeconds(
  header: string | null | undefined,
): number | null {
  if (header == null) return null;
  const trimmed = header.trim();
  if (trimmed === "") return null;
  const seconds = Number(trimmed);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return seconds;
}

export interface StreamRetryInput {
  /**
   * Was the just-finished attempt a busy refusal — HTTP 429 whose SSE error is
   * the shared LLM_BUSY_MESSAGE? Only busy refusals are retried; a hard error
   * (auth, forbidden, a mid-stream failure) is surfaced, not retried.
   */
  busy: boolean;
  /** Wall-clock ms since the FIRST POST of this turn began. */
  elapsedMs: number;
  /** Parsed `Retry-After` (seconds) from the refusal, or null when absent. */
  retryAfterSec: number | null;
}

export interface StreamRetryPlan {
  retry: boolean;
  /** Milliseconds to wait before the next POST. 0 when `retry` is false. */
  delayMs: number;
}

/**
 * Decide whether to retry a refused tutor turn, and for how long to wait.
 *
 * Policy: retry busy refusals while under the total time budget (45 s), waiting
 * `max(Retry-After, 5 s)` clamped to 15 s (under the 20 s dead window). There is
 * no separate attempt cap — the budget is the only ceiling. A `Retry-After`
 * above 30 s (a user-window denial) stops immediately; there is no point waiting
 * minutes with the scholar staring at a spinner. A wait that would push past the
 * budget also stops.
 */
export function planStreamRetry({
  busy,
  elapsedMs,
  retryAfterSec,
}: StreamRetryInput): StreamRetryPlan {
  const stop: StreamRetryPlan = { retry: false, delayMs: 0 };
  if (!busy) return stop;

  const requestedMs =
    retryAfterSec != null
      ? retryAfterSec * 1000
      : STREAM_RETRY_DEFAULT_DELAY_MS;
  // A user-window denial (Retry-After can be minutes) is not worth waiting out.
  if (requestedMs > STREAM_RETRY_STOP_ABOVE_MS) return stop;

  const delayMs = Math.min(
    Math.max(requestedMs, STREAM_RETRY_DEFAULT_DELAY_MS),
    STREAM_RETRY_MAX_DELAY_MS,
  );
  // Don't begin a wait we can't afford to see through within the budget.
  if (elapsedMs + delayMs > STREAM_RETRY_BUDGET_MS) return stop;

  return { retry: true, delayMs };
}

// ── Pending-turn escalation copy ────────────────────────────────────────────
// The "thinking" indicator escalates its wording with elapsed time so a slow
// (or retrying) turn reads as patience, not a stall. Shared so web and native
// say the same words at the same moments.
export const STREAM_PENDING_ESCALATE_MS = 8_000;
export const STREAM_PENDING_LONG_MS = 20_000;

/**
 * The escalated label for a pending turn given how long it has been waiting,
 * or null before the first escalation threshold (the surface shows its own
 * base "…" / typing dots until then). Sentence case.
 */
export function pendingTurnLabel(elapsedMs: number): string | null {
  if (elapsedMs >= STREAM_PENDING_LONG_MS) {
    return "Taking a little longer than usual…";
  }
  if (elapsedMs >= STREAM_PENDING_ESCALATE_MS) {
    return "Still thinking…";
  }
  return null;
}

// ── Server-truth turn state ─────────────────────────────────────────────────
// A turn is "pending" when the server holds an empty assistant placeholder for
// it (messages table). Deriving this from server truth — not only from
// client-local `isStreaming` — keeps the pending indicator visible across a
// remount/reload, and lets a dead placeholder govern OTHER tabs.
//
// Mirrors STREAM_ORPHAN_REAP_AGE_MS in convex/sessions.ts: a placeholder whose
// last stream activity is older than this is treated as no longer in flight.
// Keep the two in sync.
export const STREAM_DEAD_PLACEHOLDER_MS = 20_000;

export interface TurnPlaceholder {
  role: string;
  content: string;
  streamId?: string | null;
  createdAt: number;
  lastStreamActivityAt?: number | null;
  streamTrigger?: "activityKickoff" | "appUpdate" | null;
}

/**
 * An app-update turn (sessions.startAppUpdateTurn) that has not spoken yet.
 * The tutor may end it in silence — the server then deletes the row — so
 * until text arrives it must look like nothing at all: no typing indicator,
 * no empty bubble, no "didn't go through" retry. Once text arrives it is an
 * ordinary tutor message.
 */
export function isQuietAppUpdatePlaceholder(
  message:
    | Pick<TurnPlaceholder, "role" | "content" | "streamTrigger">
    | null
    | undefined,
): boolean {
  return (
    !!message &&
    message.role === "assistant" &&
    message.streamTrigger === "appUpdate" &&
    message.content.trim() === ""
  );
}

export type ServerTurnState = "idle" | "pending" | "dead";

/**
 * Classify the trailing message of a session as an in-flight ("pending"),
 * failed ("dead"), or absent ("idle") tutor turn, from server truth alone.
 * `nowMs` is the current wall clock.
 *
 * An empty assistant row is a live turn placeholder only if it carries a stream
 * marker. Two shapes exist:
 *   • a normal send / rubric-check / kickoff placeholder has a `streamId`;
 *   • a POST-TOOL split placeholder (sessionHelpers.splitStream) has NO
 *     `streamId` but IS stamped with `lastStreamActivityAt`.
 * Both must read as pending while alive — the earlier version required a
 * streamId, so after a reload mid-stream the composer unlocked and a fresh send
 * duplicated the turn. Past the liveness window, only a `streamId`-bearing row
 * becomes a retryable "dead" turn (the server reaps it and a fresh placeholder
 * can replace it); a stale no-streamId post-tool row is "idle" — showing a
 * retry there could duplicate an in-progress split, and the server reaps it on
 * the next send. A quiet app-update placeholder is always "idle" (see
 * isQuietAppUpdatePlaceholder): it is neither visibly pending nor retryable.
 */
export function deriveServerTurnState(
  lastMessage: TurnPlaceholder | null | undefined,
  nowMs: number,
): ServerTurnState {
  if (!lastMessage) return "idle";
  if (lastMessage.role !== "assistant") return "idle";
  if (lastMessage.content.trim() !== "") return "idle";
  if (isQuietAppUpdatePlaceholder(lastMessage)) return "idle";
  const hasStreamId = !!lastMessage.streamId;
  const hasHeartbeat = lastMessage.lastStreamActivityAt != null;
  if (!hasStreamId && !hasHeartbeat) return "idle";
  const activityAt = lastMessage.lastStreamActivityAt ?? lastMessage.createdAt;
  if (nowMs - activityAt < STREAM_DEAD_PLACEHOLDER_MS) return "pending";
  return hasStreamId ? "dead" : "idle";
}
