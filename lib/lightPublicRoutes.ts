/**
 * Public routes that render without the app's providers (app/RootProviders.tsx):
 * no Convex client, no sign-in code, no Chakra. They are plain server-rendered
 * pages for strangers arriving from search, so they ship only their own
 * JavaScript. A page here must not call useQuery, useCurrentUser or anything
 * else that needs the providers; lib/mathWorksheets/__tests__ checks the
 * worksheet tree for those imports.
 */

const LIGHT_PREFIXES = ["/math-worksheets"];

export function isLightPublicPath(pathname: string | null): boolean {
  if (!pathname) return false;
  return LIGHT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
