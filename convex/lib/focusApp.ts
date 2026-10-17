// TRA-519 one app surface: which of a session's apps a turn acts on.
//
// A session can hold more than one app (a code artifact). The builder opens
// one of them — the newest, or an older one its chat card's Open named — and
// sends that app's id with the turn. Every server site that reads or writes
// "the app" for a turn (the prompt's open-app line, the app state the tutor
// reads, the version baseline and recorder, the character/judge director)
// resolves it here, so the AI and the screen agree on which app is open.
//
// The id is only a preference: one that is not a code artifact of THIS
// session (stale, deleted, another session's, a document) falls back to the
// newest app, exactly as before the id existed. An absent id — an older
// client — is the old behavior.

import type { Id } from "../_generated/dataModel";

type AppCandidate = {
  _id: Id<"artifacts">;
  _creationTime: number;
  sessionId: Id<"sessions">;
  type?: string;
};

/** The session's apps (code artifacts), newest first. */
export function codeAppsNewestFirst<T extends AppCandidate>(
  artifacts: readonly T[],
  sessionId: Id<"sessions">,
): T[] {
  return artifacts
    .filter((a) => a.type === "code" && a.sessionId === sessionId)
    .sort((a, b) => b._creationTime - a._creationTime);
}

/**
 * The app a turn acts on: `focusId` when it names a code artifact of this
 * session, else the session's newest app, else null.
 */
export function pickFocusApp<T extends AppCandidate>(
  artifacts: readonly T[],
  sessionId: Id<"sessions">,
  focusId: Id<"artifacts"> | string | null | undefined,
): T | null {
  const apps = codeAppsNewestFirst(artifacts, sessionId);
  if (focusId) {
    const focused = apps.find((a) => String(a._id) === String(focusId));
    if (focused) return focused;
  }
  return apps[0] ?? null;
}

/**
 * The app the turn's version recorder versions. An app created DURING the
 * turn (create_code) is the turn's app — whichever app was open. Otherwise
 * the focused app (pickFocusApp).
 */
export function pickTurnRecordApp<T extends AppCandidate>(
  artifacts: readonly T[],
  sessionId: Id<"sessions">,
  focusId: Id<"artifacts"> | string | null | undefined,
  turnStartedAt: number | null,
): T | null {
  const apps = codeAppsNewestFirst(artifacts, sessionId);
  if (turnStartedAt !== null && apps[0] && apps[0]._creationTime > turnStartedAt) {
    return apps[0];
  }
  return pickFocusApp(artifacts, sessionId, focusId);
}
