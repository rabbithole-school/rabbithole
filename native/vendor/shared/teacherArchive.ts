// Teacher archive for scholar-built apps (review/teacher-archive-scholar-apps.html).
//
// A teacher can put away an app a scholar built. The stamp lives on the
// session (`sessions.teacherArchivedAt`, always set with `isArchived: true`)
// and only a teacher can lift it. One predicate and one set of copy, shared
// by the server, web and the iPad (vendored by native/scripts/sync-vendor.js)
// so the scholar sees the same words on both surfaces.

export function isTeacherArchived(session: {
  teacherArchivedAt?: number | null;
}): boolean {
  return session.teacherArchivedAt != null;
}

export const TEACHER_ARCHIVE_COPY = {
  // Scholar-facing (web + iPad).
  scholarLabel: "Archived by your teacher",
  scholarExplain: "Your teacher archived this. Ask them if you want it back.",
  backHome: "Back to Home",
  // The server's refusal when a scholar path hits a teacher-archived session.
  refusal: "Your teacher archived this app.",
  // Teacher-facing (web).
  archiveAction: "Archive app",
  restoreAction: "Restore app",
  archivedLabel: "Archived",
  confirmTitle: (name: string) => `Archive "${name}"?`,
  confirmBody:
    "The scholar won't be able to open, play, or change it, and opening the activity again won't start a fresh copy, until a teacher restores it. Nothing is deleted. You can restore it from their profile.",
  archivedToast: "App archived",
  restoredToast: "App restored",
} as const;
