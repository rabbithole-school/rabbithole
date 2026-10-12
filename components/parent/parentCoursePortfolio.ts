/** Pure helpers for the family course portfolio — tile meta lines, session
 *  breadcrumbs and the scheduled-date label. Kept out of the components so
 *  the wording is testable. */

/** "3 pieces of work · 5 sessions" — either half is dropped when it is zero,
 *  and an empty course returns null so the tile stays quiet. */
export function courseTileMeta(
  workCount: number,
  sessionCount: number,
): string | null {
  const parts: string[] = [];
  if (workCount > 0) {
    parts.push(
      `${workCount} ${workCount === 1 ? "piece of work" : "pieces of work"}`,
    );
  }
  if (sessionCount > 0) {
    parts.push(`${sessionCount} ${sessionCount === 1 ? "session" : "sessions"}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** "Fractions · Equal shares · Fold and label" — a handout-only session has
 *  no unit or lesson, so it renders as just its own title. */
export function sessionBreadcrumb(session: {
  unitTitle: string | null;
  lessonTitle: string | null;
  activityTitle: string;
}): string {
  return [session.unitTitle, session.lessonTitle, session.activityTitle]
    .filter((part): part is string => !!part && part.trim().length > 0)
    .join(" · ");
}

/**
 * What the family portal says about the media release, per consent state.
 * The two states are NOT the same notice: with no form at all the existing
 * sharing gate withholds every piece of work, not just photos, so promising
 * that "other shared work shows up either way" would be a lie. Returns null
 * for the states that need no notice.
 */
export function mediaReleaseNoticeCopy(
  status: "not_applicable" | "granted" | "not_granted" | "form_missing",
): { body: string; linkLabel: string } | null {
  if (status === "form_missing") {
    return {
      body: "Shared work and photos can appear here once the visiting-student form is completed.",
      linkLabel: "Open the visiting-student form",
    };
  }
  if (status === "not_granted") {
    return {
      body: "Photos and videos aren’t shared because the media release in the visiting-student form wasn’t granted. Other shared work and the teacher’s resources still appear here.",
      linkLabel: "Update the visiting-student form",
    };
  }
  return null;
}

/** "Mon, Dec 21" for a scheduled session; null when it has no date. */
export function sessionDateLabel(scheduledAt: number | null): string | null {
  if (typeof scheduledAt !== "number" || !Number.isFinite(scheduledAt)) {
    return null;
  }
  return new Date(scheduledAt).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
