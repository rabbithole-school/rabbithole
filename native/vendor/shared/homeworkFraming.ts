/**
 * How an at-home (homework) session names itself to the scholar working it.
 *
 * The tonight list is precise about deadlines — `dueStatus()` phrases, and
 * "with <teacher>" for who set the work — and then the session view dropped
 * both the moment the child opened the work, which is exactly when a parent at
 * the kitchen table asks "when is that due?". This composes the SAME two
 * signals into one eyebrow line; it introduces no new deadline vocabulary and
 * no new deadline math (`dueStatus` in shared/institutionDay.ts stays the one
 * homework-deadline primitive).
 *
 * Shared so web (`components/SessionInterface.tsx`) and native
 * (`native/src/app/session/[id].tsx`) say it byte-identically.
 */

/** The label the scholar taps to say they've finished a homework session. */
export const HOMEWORK_DONE_LABEL = "I'm done with this";
/** Shown in its place afterwards — the receipt, not a celebration. */
export const HOMEWORK_DONE_CONFIRMED = "Done — your teacher can see it.";
/** Undo, for the child who tapped it and then thought of one more thing. */
export const HOMEWORK_DONE_UNDO = "Not yet";

/**
 * "Homework · due Tuesday · with Mr. Char".
 *
 * `duePhrase` comes from `dueStatus(dueAt, nowMs, timeZone)?.phrase`, so the
 * overdue variant reads "Homework · was due yesterday · with Mr. Char" without
 * this function knowing anything about calendars. Missing parts are dropped;
 * with neither a deadline nor a teacher it degrades to plain "Homework".
 */
export function homeworkEyebrow(
  duePhrase: string | null | undefined,
  teacherName: string | null | undefined,
): string {
  return [
    "Homework",
    duePhrase ?? null,
    teacherName ? `with ${teacherName}` : null,
  ]
    .filter((part): part is string => !!part)
    .join(" · ");
}
