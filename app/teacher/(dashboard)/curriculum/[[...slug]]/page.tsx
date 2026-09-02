/**
 * Stub. The Curriculum surface lives in the parent layout
 * (`app/teacher/curriculum/layout.tsx`) so it doesn't remount as the slug
 * (`/<unitId>/<pane>`) changes — that's what keeps the column-view slide
 * and unit→unit switching from flashing. This optional catch-all just makes
 * `/teacher/curriculum` and its nested paths resolve to a route.
 */
export default function CurriculumSlugPage() {
  return null;
}
