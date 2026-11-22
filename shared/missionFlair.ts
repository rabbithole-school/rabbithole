// An app activity's mission, shown to its scholar and earned as flair
// (TRA-612, Andy 2026-11-08: "plain words plus earned flair").
//
// The mission's MUST BE TRUE lines (activities.buildContract.invariants) reach
// the scholar through the chat rubric path, not a path of their own: the
// per-session criteria generator writes one criterion per line, whose label
// names what the line is about and never the rule the scholar is meant to
// discover, and the builder awards flair with the same scoring tool a chat
// tutor uses. These helpers are the one place web, native and the backend
// agree on which criteria are mission lines and which activities have them.
//
// A mission app keeps "Finish and send" (Andy, 2026-11-08): its flair arrives
// while the scholar builds, so the button under the app never checks.

export const YOUR_MISSION_LABEL = "Your mission";

/** A mission criterion's id: one per MUST BE TRUE line, 1-based, source order. */
export function missionCriterionId(index: number): string {
  return `mission-${index + 1}`;
}

export function isMissionCriterionId(id: string): boolean {
  return /^mission-[1-9]\d*$/.test(id);
}

/** The mission lines a scholar reads: this session's mission criteria labels,
 * in order. Empty while the criteria are still being written, and for any
 * rubric that is not a mission's (a teacher's own, a Quest's maker
 * explanation), so the caller renders nothing. */
export function missionLines(
  criteria: readonly { id: string; label: string }[] | null | undefined,
): string[] {
  return (criteria ?? [])
    .filter((criterion) => isMissionCriterionId(criterion.id))
    .map((criterion) => criterion.label.trim())
    .filter((label) => label.length > 0);
}

/** A contract has a mission when at least one MUST BE TRUE line is not blank. */
export function hasMissionLines(
  invariants: readonly string[] | null | undefined,
): boolean {
  return (invariants ?? []).some((invariant) => invariant.trim().length > 0);
}
