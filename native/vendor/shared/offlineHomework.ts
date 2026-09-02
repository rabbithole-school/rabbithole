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
