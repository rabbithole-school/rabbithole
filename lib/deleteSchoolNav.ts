// Where the Delete-school flow sends the admin once the deletion is scheduled.
//
// The deletion itself runs server-side (a scheduled internal action) and is
// uninterruptible — navigating away cannot abort it. So this is purely about
// where the *browser* lands after the request is accepted:
//
//   • deletingSelf — the admin just deleted their own account too, so they must
//     be signed out. Land them on the unauthenticated confirmation page rather
//     than /sign-in, so they get a plain "this is done" message instead of a
//     login form (or a spinner racing a vanished session).
//   • otherwise — a platform admin deleting someone else's school (or a
//     multi-institution admin) stays signed in. A platform admin returns to the
//     platform Institutions console (the home of institution lifecycle); anyone
//     else goes to their home.

export const SCHOOL_DELETED_ROUTE = "/school-deleted";

export function postDeleteRedirect(opts: {
  deletingSelf: boolean;
  isPlatformAdmin: boolean;
}): string {
  if (opts.deletingSelf) return SCHOOL_DELETED_ROUTE;
  return opts.isPlatformAdmin ? "/admin/institutions" : "/";
}
