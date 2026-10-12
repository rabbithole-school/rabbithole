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

/** Match the homework surface's institution-local absolute due-date wording. */
export function offlineHomeworkDueText(
  dueAt: number | null,
  timeZone: string,
): string {
  if (dueAt == null) return "No due date";
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(dueAt));
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(dueAt));
  return `Due ${date} at ${time}`;
}

/**
 * The finish block (TRA-458) — one wording for web and native. The scholar's
 * own mark is visible to their teacher, so the copy says so up front rather
 * than implying the work was checked.
 */
export function offlineHomeworkFinishCopy(teacherName: string | null): {
  prompt: string;
  detail: string;
  paperLine: string;
} {
  const teacher = teacherName ?? "Your teacher";
  const giveTo = teacherName ?? "your teacher";
  return {
    prompt: "Finished this at home?",
    detail: `Mark it done and it leaves your Home. ${teacher} will see you marked it.`,
    paperLine: `Paper to hand in? Give it to ${giveTo}. It shows up here once it's scanned.`,
  };
}

/** "Tue, Sep 29 · Ms. Rivera can see it" under "You marked this done". */
export function offlineHomeworkMarkedText(
  completedAt: number,
  timeZone: string,
  teacherName: string | null,
): string {
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone,
  }).format(new Date(completedAt));
  return `${date} · ${teacherName ?? "Your teacher"} can see it`;
}
