/**
 * Stub. The Assignments surface lives in the parent layout
 * (`app/teacher/(dashboard)/schedule/layout.tsx`) so it doesn't remount
 * as the `/<assignmentId>` selection segment changes — the list-detail and
 * docked aide stay mounted instead of flashing. This optional catch-all just
 * makes `/teacher/schedule` and `/teacher/schedule/<assignmentId>`
 * resolve to a route.
 */
export default function ScheduleStubPage() {
  return null;
}
