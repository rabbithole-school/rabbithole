/**
 * Which GA4 measurement id, if any, the public pages should load.
 * `null` means render nothing: no id configured (the Foundation default),
 * a local dev build, or a Vercel preview (so preview clicks never land in
 * the production property).
 */
export function analyticsMeasurementId(
  configured: string | null,
  env: { nodeEnv: string | undefined; vercelEnv: string | undefined },
): string | null {
  if (!configured || !/^G-[A-Z0-9]+$/.test(configured)) return null;
  if (env.nodeEnv !== "production") return null;
  if (env.vercelEnv && env.vercelEnv !== "production") return null;
  return configured;
}

/**
 * The paths whose page views may be counted. A second fence behind the
 * mount points: the Vercel script keeps listening after a client-side
 * navigation, so each of its events is checked against this list too.
 */
const PUBLIC_PREFIXES = ["/math-worksheets", "/waitlist", "/davidson"];

export function isPublicAnalyticsPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * True when this browser holds a Rabbithole sign-in, whether or not it has
 * expired. Convex Auth keeps its tokens in localStorage under
 * `__convexAuthJWT_<namespace>` and `__convexAuthRefreshToken_<namespace>`
 * (`@convex-dev/auth/react`, the provider `app/providers.tsx` mounts). A stale
 * token counts as signed in: when in doubt, nobody is counted.
 */
export function browserHoldsSignIn(storage: Pick<Storage, "length" | "key"> | null): boolean {
  if (!storage) return true;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i) ?? "";
    if (key.startsWith("__convexAuthJWT") || key.startsWith("__convexAuthRefreshToken")) return true;
  }
  return false;
}
