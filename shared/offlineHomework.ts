import { HOMEWORK_DONE_LABEL } from "./homeworkFraming";
import { dueStatus } from "./institutionDay";

export type OfflineHomeworkContext = {
  unitTitle: string | null;
  unitEmoji: string | null;
  lessonTitle: string | null;
  teacherName: string | null;
};

/** The compact provenance line shared by web and native offline homework. */
export function offlineHomeworkContext({
  unitTitle,
  unitEmoji,
  lessonTitle,
  teacherName,
}: OfflineHomeworkContext): string | null {
  if (unitTitle) {
    return `${unitEmoji ? `${unitEmoji} ` : ""}${unitTitle}${
      lessonTitle ? ` · ${lessonTitle}` : ""
    }`;
  }
  return teacherName ? `From ${teacherName}` : null;
}

/**
 * The due line on an offline homework page, in the one due-date wording
 * (`dueStatus`): "Due tomorrow", "Due Thu, Nov 5", "Was due Fri, Oct 16".
 */
export function offlineHomeworkDueText(
  dueAt: number | null,
  nowMs: number,
  timeZone: string,
): string {
  const phrase = dueStatus(dueAt, nowMs, timeZone)?.phrase;
  if (!phrase) return "No due date";
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * The finish block (TRA-458) — one wording for web and native. The scholar's
 * own mark is visible to their teacher, so the copy says so up front rather
 * than implying the work was checked. Offline work given "Open until a date"
 * (`isHomework` false) gets the same block, worded for the class list it
 * sits on rather than for home.
 */
export function offlineHomeworkFinishCopy(
  teacherName: string | null,
  { isHomework = true }: { isHomework?: boolean } = {},
): {
  prompt: string;
  detail: string;
  paperLine: string;
} {
  const teacher = teacherName ?? "Your teacher";
  const giveTo = teacherName ?? "your teacher";
  return {
    prompt: isHomework ? "Finished this at home?" : "Finished this?",
    detail: `Tap “${HOMEWORK_DONE_LABEL}” and it leaves your ${isHomework ? "homework" : "list"}. ${teacher} will see it.`,
    paperLine: `Paper to hand in? Give it to ${giveTo}. It shows up here once it's scanned.`,
  };
}

/**
 * "Marked Tue, Sep 29" under the shared receipt (`HOMEWORK_DONE_CONFIRMED`,
 * "Done — your teacher can see it."), which already names who sees it.
 */
export function offlineHomeworkMarkedText(
  completedAt: number,
  timeZone: string,
): string {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(completedAt));
  return `Marked ${date}`;
}
