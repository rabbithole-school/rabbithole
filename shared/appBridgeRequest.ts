// Host-side routing for the bridge's server-backed AI calls
// (`rabbithole.character.say` / `rabbithole.judge`, contract in
// shared/appAiPolicy.ts). Both hosts parse a frame `request`, hand it here with
// the Convex actions they can reach, and post back whatever this returns — so
// web and native answer every request with the same codes and the same
// child-facing messages, and the app never sees server-only fields (`turnId`).
// Pure TS; vendored into native/ by `native/scripts/sync-vendor.js`.

import {
  APP_REQUEST_TIMEOUT_MS,
  type AppAiContext,
  type AppBridgeErrorCode,
  type AppBridgeResponsePayload,
  type CharacterReply,
  type JudgeReply,
} from "./appAiPolicy";
import { TimeoutError, withTimeout } from "./withTimeout";

/** The parsed frame request (structurally `AppStateBridgeRequestMessage`). */
export type AppBridgeRequest =
  | { method: "character.say"; params: { text: string; context?: AppAiContext } }
  | {
      method: "judge";
      params: { judgeId: string; answer: string; context?: AppAiContext };
    };

type ServerFailure = {
  ok: false;
  code: "unavailable" | "busy" | "timeout" | "invalid" | "failed";
  retryAfterSec?: number;
};

/** `api.appAiActions.say`'s return union. */
export type SayResult =
  | { ok: true; line: string; mood: string; verdict?: string; turnId: unknown }
  | ServerFailure;

/** `api.appAiActions.judge`'s return union. */
export type JudgeResult =
  | { ok: true; verdict: string; feedback?: string; turnId: unknown }
  | ServerFailure;

/** A missing handler means this host has no scope for the call (a custom-app
 *  tile has no session, tutor, or teacher-readable record). `context` is the
 *  parser-normalized app context, absent when the app sent none. */
export type AppBridgeRequestHandlers = {
  say?: (text: string, context?: AppAiContext) => Promise<SayResult>;
  judge?: (
    judgeId: string,
    answer: string,
    context?: AppAiContext,
  ) => Promise<JudgeResult>;
};

/** Shorter than the SDK's own deadline so a slow call reaches the app as the
 *  host's `timeout` reply rather than the SDK giving up first. */
export const APP_HOST_REQUEST_TIMEOUT_MS = APP_REQUEST_TIMEOUT_MS - 2_000;

// Apps may show these to a child verbatim; keep them plain and actionable.
const ERROR_MESSAGES: Record<Exclude<AppBridgeErrorCode, "needs-gesture">, string> = {
  unavailable: "This isn't available right now.",
  busy: "Too many tries for now. Wait a little and try again.",
  timeout: "That took too long. Try again.",
  invalid: "That didn't work. Try saying it a different way.",
  failed: "Something went wrong. Try again.",
};

/** The reply for a request this host could not route. */
export function appBridgeFailure(
  code: Exclude<AppBridgeErrorCode, "needs-gesture">,
  retryAfterSec?: number,
): AppBridgeResponsePayload {
  const message =
    code === "busy" && retryAfterSec !== undefined && retryAfterSec > 0
      ? `Too many tries for now. Try again in ${Math.ceil(retryAfterSec)} seconds.`
      : ERROR_MESSAGES[code];
  return { ok: false, error: { code, message } };
}

function characterReply(result: SayResult): AppBridgeResponsePayload {
  if (!result.ok) return appBridgeFailure(result.code, result.retryAfterSec);
  const reply: CharacterReply = { line: result.line, mood: result.mood };
  if (result.verdict !== undefined) reply.verdict = result.verdict;
  return { ok: true, result: reply };
}

function judgeReply(result: JudgeResult): AppBridgeResponsePayload {
  if (!result.ok) return appBridgeFailure(result.code, result.retryAfterSec);
  const reply: JudgeReply = { verdict: result.verdict };
  if (result.feedback !== undefined) reply.feedback = result.feedback;
  return { ok: true, result: reply };
}

/**
 * Hand a routed reply to the app, unless the frame that asked is gone (it
 * reloaded: its SDK no longer holds the request). The tutor hears about an
 * exchange only when the app actually received its success — never after the
 * host already answered `timeout`, and never for a dropped reply — so it is
 * not told about a character line the child never saw.
 */
export function deliverAppBridgeReply(
  payload: AppBridgeResponsePayload,
  {
    isCurrent,
    post,
    onAppAiTurn,
  }: {
    isCurrent: () => boolean;
    post: (payload: AppBridgeResponsePayload) => void;
    onAppAiTurn?: () => void;
  },
): void {
  if (!isCurrent()) return;
  post(payload);
  if (payload.ok) onAppAiTurn?.();
}

/** Answer one frame request. Never rejects: every outcome is a payload. */
export async function routeAppBridgeRequest(
  request: AppBridgeRequest,
  handlers: AppBridgeRequestHandlers,
  timeoutMs: number = APP_HOST_REQUEST_TIMEOUT_MS,
): Promise<AppBridgeResponsePayload> {
  const { say, judge } = handlers;
  let call: (() => Promise<AppBridgeResponsePayload>) | null = null;
  if (request.method === "character.say") {
    const { text, context } = request.params;
    if (say) call = () => say(text, context).then(characterReply);
  } else {
    const { judgeId, answer, context } = request.params;
    if (judge) call = () => judge(judgeId, answer, context).then(judgeReply);
  }
  if (!call) return appBridgeFailure("unavailable");
  try {
    // A queued Convex action never rejects on its own while the socket is
    // down; the deadline turns that into a reply the app can act on.
    return await withTimeout(
      Promise.resolve().then(call),
      timeoutMs,
      "App bridge request timed out",
    );
  } catch (error) {
    return appBridgeFailure(
      error instanceof TimeoutError ? "timeout" : "failed",
    );
  }
}
