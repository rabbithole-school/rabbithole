/**
 * The rules for `sessions.pendingWhisper`, the one-turn private note a teacher
 * leaves for a session's tutor or app builder. Two writers share it: the
 * remote-mode whisper box (`sessions.update`) and the Slack bot's
 * whisper_to_session tool (`sessionHelpers.queueTeacherWhisper`). The stream
 * reads it once per turn and `sessionHelpers.clearPendingWhisper` removes what
 * that turn read.
 *
 * A teacher's whisper is never silently replaced or wiped (Andy, 2026-11-08):
 * a new one goes after whatever is waiting, and the end-of-turn clear leaves
 * anything that arrived while the AI was answering. The slot is teacher-only;
 * automated notes reach the AI some other way.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { canUserReadScholarWork } from "./access";
import { isTeacherRole } from "./roles";
import { scholarInstitutionId } from "./scholarEnrollment";

/** Whispers queued one after another are joined with a blank line. */
export const WHISPER_SEPARATOR = "\n\n";

/** One Slack whisper, and everything waiting on a session at once. */
export const MAX_WHISPER_CHARS = 1000;
export const MAX_WAITING_WHISPER_CHARS = 4000;

/** The slot after `text` is queued: after whatever is waiting, never over it. */
export function appendWhisper(pending: string | undefined, text: string): string {
  if (!pending || pending === text) return text;
  return pending + WHISPER_SEPARATOR + text;
}

/**
 * Whether `text` is one whole whisper in `slot`, not merely a substring of a
 * longer one ("Slow down." is not in "Slow down. Check units first.").
 */
export function slotHasWhisper(slot: string | undefined, text: string): boolean {
  if (!slot) return false;
  return (
    slot === text ||
    slot.startsWith(text + WHISPER_SEPARATOR) ||
    slot.endsWith(WHISPER_SEPARATOR + text) ||
    slot.includes(WHISPER_SEPARATOR + text + WHISPER_SEPARATOR)
  );
}

/**
 * What stays in the slot once a turn has used `consumed`. A whisper that
 * arrived while the turn was streaming (appended after it, or a replacement)
 * survives to the next turn; the old unconditional clear wiped it unseen.
 */
export function whisperLeftAfterTurn(
  pending: string | undefined,
  consumed: string,
): string | undefined {
  if (pending === undefined || pending === consumed) return undefined;
  if (pending.startsWith(consumed + WHISPER_SEPARATOR)) {
    return pending.slice(consumed.length + WHISPER_SEPARATOR.length) || undefined;
  }
  return pending;
}

/**
 * Why `caller` may not whisper to `session` from Slack, or null when they may.
 * Teachers, school admins and platform admins only, judged by their membership
 * at the scholar's own school (operations staff can reach a scholar's account,
 * never their learning). First-party only: the Slack workspace belongs to the
 * primary institution, so a session outside it is refused rather than
 * half-served.
 */
export async function slackWhisperRefusal(
  ctx: QueryCtx | MutationCtx,
  caller: Doc<"users"> | null,
  session: Doc<"sessions">,
): Promise<string | null> {
  if (
    !caller ||
    !isTeacherRole(caller.role) ||
    caller._id === session.userId ||
    !(await canUserReadScholarWork(ctx, caller, session.userId))
  ) {
    return "whispering to a scholar's AI needs a teacher or admin account at that scholar's school.";
  }
  const institutionId = await scholarInstitutionId(ctx, session.userId);
  const institution = institutionId ? await ctx.db.get(institutionId) : null;
  if (!institution?.isPrimary) {
    return "Slack whispers only reach scholars at the school this Slack workspace belongs to.";
  }
  return null;
}
