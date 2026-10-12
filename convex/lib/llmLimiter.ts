// Calibrated human ceilings, not typical traffic:
// - The UI can legitimately hold one tutor stream plus one practice/story
//   surface; a third concurrent stream from one account is never expected.
// - Forty starts in ten minutes is one message about every 15 seconds for the
//   whole window, well above a sustained human pace.
// - Sixty concurrent calls exceeds the largest roster all streaming at once.
// - Five minutes is longer than a legitimate stream and bounds crashed leases.
export const PER_USER_CONCURRENT = 2;
export const PER_USER_STARTS_PER_WINDOW = 40;
export const WINDOW_MS = 10 * 60 * 1000;
export const PLATFORM_CONCURRENT = 60;
export const LEASE_TTL_MS = 5 * 60 * 1000;
export const CONCURRENCY_RETRY_AFTER_SEC = 5;

// Calls made from inside a sandboxed app (a character's line, a judge's
// verdict — convex/appAiActions.ts) are short, cheap, and come at game pace:
// a brisk round trades a line every few seconds. They are a pool of their
// own, so a lively game can neither exhaust the tutor's allowances nor be
// refused because the tutor is streaming:
// - starts: 60 per 10 minutes, counted only against other app-AI starts;
// - concurrency: PER_USER_CONCURRENT app-AI calls at once, counted only
//   against other app-AI calls (the tutor stream and an app call may overlap);
// - platform: APP_AI_PLATFORM_CONCURRENT app-AI calls at once across every
//   school, counted only against other app-AI calls. A Haiku line returns in
//   a second or two, so 20 in flight is a whole class sending a line in the
//   same couple of seconds; the cap exists so one class's game can never take
//   the tutor's 60 slots, and app-AI leases are invisible to that ceiling.
// Every other surface ignores app-AI leases, so its decisions are unchanged.
export const APP_AI_LLM_SURFACE = "app-ai";
export const APP_AI_STARTS_PER_WINDOW = 60;
export const APP_AI_PLATFORM_CONCURRENT = 20;

// A tutor turn the APP opened with nothing to answer (a zero-ask
// sessions.startAppUpdateTurn: "something happened in the game"). It is a
// full tutor stream, so it shares the tutor's concurrency and platform
// ceilings, but its STARTS are their own window: a game played for ten
// minutes must never spend the scholar's typed-message allowance, or their
// next real question gets a 429. Not the app-AI pool either — that one paces
// the game's own calls, and a burst of director turns must not stall the
// character mid-scene. Thirty is one per 20 seconds for the whole window, the
// pace the app-update queue is held to. An update that carries an ask is a
// scholar-initiated tap and stays on the tutor's own surface.
export const APP_UPDATE_LLM_SURFACE = "app-update";
export const APP_UPDATE_STARTS_PER_WINDOW = 30;

export { LLM_BUSY_MESSAGE } from "../../shared/llmLimiter";

export type LlmLimitReason = "user-concurrent" | "user-window" | "platform";

export type LlmLimitDecision =
  | { ok: true }
  | { ok: false; reason: LlmLimitReason; retryAfterSec: number };

export type LlmLeaseSnapshot<TLeaseId> = {
  leaseId: TLeaseId;
  startedAt: number;
  active: boolean;
  surface?: string;
};

export type LlmPlatformLease = { startedAt: number; surface?: string };

/** Which start window a surface draws on. */
function startPool(surface: string | undefined): "app-ai" | "app-update" | "tutor" {
  if (surface === APP_AI_LLM_SURFACE) return "app-ai";
  if (surface === APP_UPDATE_LLM_SURFACE) return "app-update";
  return "tutor";
}

/** Which concurrency ceilings (per user and platform) a surface counts toward. */
function concurrencyPool(surface: string | undefined): "app-ai" | "tutor" {
  return surface === APP_AI_LLM_SURFACE ? "app-ai" : "tutor";
}

export function decideLlmLease<TLeaseId>({
  now,
  userLeases,
  platformActiveLeases,
  surface,
}: {
  now: number;
  userLeases: readonly LlmLeaseSnapshot<TLeaseId>[];
  /** Every active lease across the platform, with its surface. */
  platformActiveLeases: readonly LlmPlatformLease[];
  /** The surface asking; only the app surfaces above change its pools. */
  surface?: string;
}): {
  decision: LlmLimitDecision;
  staleUserLeaseIds: TLeaseId[];
} {
  const leaseCutoff = now - LEASE_TTL_MS;
  const windowCutoff = now - WINDOW_MS;
  const staleUserLeaseIds = userLeases
    .filter((lease) => lease.active && lease.startedAt <= leaseCutoff)
    .map((lease) => lease.leaseId);
  const starts = startPool(surface);
  const concurrency = concurrencyPool(surface);
  const startsPerWindow =
    starts === "app-ai"
      ? APP_AI_STARTS_PER_WINDOW
      : starts === "app-update"
        ? APP_UPDATE_STARTS_PER_WINDOW
        : PER_USER_STARTS_PER_WINDOW;
  const platformCap =
    concurrency === "app-ai" ? APP_AI_PLATFORM_CONCURRENT : PLATFORM_CONCURRENT;
  const activeUserCount = userLeases.filter(
    (lease) =>
      concurrencyPool(lease.surface) === concurrency &&
      lease.active &&
      lease.startedAt > leaseCutoff,
  ).length;
  const inWindowStarts = userLeases.filter(
    (lease) =>
      startPool(lease.surface) === starts && lease.startedAt > windowCutoff,
  );
  const activePlatformCount = platformActiveLeases.filter(
    (lease) =>
      concurrencyPool(lease.surface) === concurrency &&
      lease.startedAt > leaseCutoff,
  ).length;

  if (activeUserCount >= PER_USER_CONCURRENT) {
    return {
      decision: {
        ok: false,
        reason: "user-concurrent",
        retryAfterSec: CONCURRENCY_RETRY_AFTER_SEC,
      },
      staleUserLeaseIds,
    };
  }

  if (inWindowStarts.length >= startsPerWindow) {
    const oldestStart = Math.min(...inWindowStarts.map((lease) => lease.startedAt));
    return {
      decision: {
        ok: false,
        reason: "user-window",
        retryAfterSec: Math.max(
          1,
          Math.ceil((oldestStart + WINDOW_MS - now) / 1000),
        ),
      },
      staleUserLeaseIds,
    };
  }

  if (activePlatformCount >= platformCap) {
    return {
      decision: {
        ok: false,
        reason: "platform",
        retryAfterSec: CONCURRENCY_RETRY_AFTER_SEC,
      },
      staleUserLeaseIds,
    };
  }

  return { decision: { ok: true }, staleUserLeaseIds };
}
