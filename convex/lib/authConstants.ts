/**
 * Auth constants shared by server (convex/auth.ts) and client
 * (components/AuthForm.tsx). Kept in its own zero-import module so the
 * client can import the provider id without pulling server-only auth code
 * into the browser bundle.
 */

/** Provider id for passwordless magic-link (email) sign-in. */
export const MAGIC_LINK_PROVIDER_ID = "magic-link";
