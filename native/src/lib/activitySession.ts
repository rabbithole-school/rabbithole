// What tapping an activity in a unit map does, and which existing session it
// reopens. The native twin of web's `handleSelectFromTree` /
// `existingSessionForActivity` (components/SessionActivityNav.tsx): web and
// game activities launch their hosts, offline / share-back activities are run
// by the teacher in class (an explanation, no chat), the activity you are
// already in just closes the map, and every chat-backed kind reuses the
// scholar's session for that activity or creates one.

export type ActivityTapAction =
  | "web"
  | "game"
  | "in-class"
  | "current"
  | "session"
  | "none";

/** Activity kinds whose work happens in a tutor chat session. */
const SESSION_KINDS = new Set(["online", "simulator", "vibecode"]);

export function activityTapAction({
  kind,
  activityId,
  sessionActivityId,
}: {
  kind: string;
  activityId: string;
  /** The activity THIS session is for — null in a unit-level session. */
  sessionActivityId: string | null | undefined;
}): ActivityTapAction {
  if (kind === "web") return "web";
  if (kind === "game") return "game";
  if (kind === "offline" || kind === "shareBack") return "in-class";
  if (!SESSION_KINDS.has(kind)) return "none";
  if (sessionActivityId && String(sessionActivityId) === String(activityId)) {
    return "current";
  }
  return "session";
}

/**
 * The scholar's existing session for `activityId` in the same assignment
 * context (an unassigned session only matches when there is no assignment),
 * so a tap reopens their work instead of starting a duplicate chat.
 */
export function findActivitySession<
  S extends {
    id: string;
    activityId?: string | null;
    assignmentId?: string | null;
  },
>(
  sessions: readonly S[] | null | undefined,
  activityId: string,
  assignmentId: string | null | undefined,
): S["id"] | null {
  const match = (sessions ?? []).find(
    (s) =>
      !!s.activityId &&
      String(s.activityId) === String(activityId) &&
      (assignmentId
        ? String(s.assignmentId ?? "") === String(assignmentId)
        : s.assignmentId == null),
  );
  return match ? match.id : null;
}
