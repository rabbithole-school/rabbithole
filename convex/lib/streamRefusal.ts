/**
 * Recording why /session-stream turned a turn away before the tutor started
 * (TRA-472).
 *
 * Seed chats sometimes kept an empty tutor placeholder that the server never
 * touched again, and the stored rows could not say whether the request never
 * arrived or was refused. The stream handler now stamps `streamRefusal` on the
 * placeholder whenever it answers with an error status or throws. These are the
 * pure pieces: which request names which turn, which refusals are worth
 * stamping, and how to read the reason out of a one-line SSE error body.
 */
import { LLM_BUSY_MESSAGE } from "./llmLimiter";

export type StreamTurnRef = {
  sessionId: string;
  assistantMsgId: string;
  streamId: string;
};

/** The turn a stream request names, or null if the body doesn't name one. */
export function streamTurnRefFromBody(body: unknown): StreamTurnRef | null {
  if (!body || typeof body !== "object") return null;
  const { sessionId, assistantMsgId, streamId } = body as Record<string, unknown>;
  if (
    typeof sessionId !== "string" ||
    typeof assistantMsgId !== "string" ||
    typeof streamId !== "string" ||
    !sessionId ||
    !assistantMsgId ||
    !streamId
  ) {
    return null;
  }
  return { sessionId, assistantMsgId, streamId };
}

/**
 * Whether a refusal says something the placeholder doesn't already record.
 * A busy 429 already stamps the placeholder's liveness and the client retries
 * it, so it is not a refusal of the turn.
 */
export function shouldRecordStreamRefusal(status: number, reason: string): boolean {
  if (status < 400) return false;
  if (status === 429 && reason === LLM_BUSY_MESSAGE) return false;
  return true;
}

/** The `error` of a one-line SSE error body, or the raw text when it isn't one. */
export function streamRefusalReason(body: string): string {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const data = JSON.parse(line.slice(6)) as { error?: unknown };
      if (typeof data.error === "string") return data.error.slice(0, 300);
    } catch {
      /* not JSON */
    }
  }
  return body.trim().slice(0, 300) || "(no body)";
}
