/** Extract the selected assignment id from a `/teacher/schedule/<id>`
 *  pathname (null on the bare `/teacher/schedule` route). Shared by the
 *  Assignments layout (which owns the surface) and the list-detail within it.
 *  Lives outside the layout file because a Next.js `layout.tsx` may only export
 *  its default component. */
export function assignmentIdFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/teacher\/schedule\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
