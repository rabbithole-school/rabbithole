/**
 * Stub. The Scholars surface (rail + per-scholar detail + aide) lives in the
 * parent layout (`app/teacher/(dashboard)/scholars/layout.tsx`) so it doesn't
 * remount as the `/<scholarId>/<subTab>` segments change — switching scholars
 * or sub-tabs slides instead of flashing. This optional catch-all just makes
 * `/teacher/scholars` and its nested paths resolve to a route.
 */
export default function ScholarsStubPage() {
  return null;
}
