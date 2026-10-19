// The scholar Home's Archived filter (review/home-finished-filter.html).
//
// Archived holds three kinds of session (sessions.finishedForScholar):
//   - work the scholar archived themselves → Unarchive puts it back on Home;
//   - completed work Home has dropped (never archived) → "Keep working on
//     this" (sessions.reopen), labelled `completedLabel`;
//   - an app a teacher archived → locked, TEACHER_ARCHIVE_COPY
//     (shared/teacherArchive.ts), only a teacher restores it.
// One set of words, shared by web and the iPad (vendored by
// native/scripts/sync-vendor.js) so both say the same thing.

export const HOME_ARCHIVE_COPY = {
  activeFilter: "Active",
  archivedFilter: "Archived",
  archiveAction: "Archive",
  unarchiveAction: "Unarchive",
  keepWorkingAction: "Keep working on this",
  completedLabel: "Completed",
  appsYouBuilt: "Apps you built",
  emptyForTab: "Nothing archived here yet.",
  archiveFailed: "Couldn't archive that. Please try again.",
  unarchiveFailed: "Couldn't unarchive that. Please try again.",
} as const;
