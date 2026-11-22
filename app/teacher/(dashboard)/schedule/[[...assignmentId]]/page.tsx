/**
 * Stub. The Assignments surface lives in the parent layout
 * (`app/teacher/(dashboard)/schedule/layout.tsx`) so it doesn't remount
 * as the `/<assignmentId>` selection segment changes — the list-detail and
 * docked aide stay mounted instead of flashing. This optional catch-all just
 * makes `/teacher/schedule` and `/teacher/schedule/<assignmentId>`
 * resolve to a route.
 */
import type { Metadata } from "next";

// The tab title for this route (the surface itself renders from the layout).
export const metadata: Metadata = { title: "Schedule" };

export default function ScheduleStubPage() {
  return null;
}
