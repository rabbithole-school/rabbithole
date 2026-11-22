/**
 * Stub. The Curriculum surface lives in the parent layout
 * (`app/teacher/curriculum/layout.tsx`) so it doesn't remount as the slug
 * (`/<unitId>/<pane>`) changes — that's what keeps the column-view slide
 * and unit→unit switching from flashing. This optional catch-all just makes
 * `/teacher/curriculum` and its nested paths resolve to a route.
 */
import type { Metadata } from "next";

// The tab title for this route (the surface itself renders from the layout).
export const metadata: Metadata = { title: "Units" };

export default function CurriculumSlugPage() {
  return null;
}
