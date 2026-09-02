// Base URL for Convex HTTP Actions (/project-stream, /tts, /parent-api, …).
//
// In the cloud the HTTP-actions host derives mechanically from the deployment
// URL (foo.convex.cloud → foo.convex.site). A LOCAL Convex backend (plane
// mode — see "Local Convex backend" in CLAUDE.md) serves HTTP actions on a
// separate localhost port that can't be derived, so worktree-up.sh publishes
// it as NEXT_PUBLIC_CONVEX_SITE_URL.
export function convexSiteUrl(): string {
  const cloudUrl = process.env.NEXT_PUBLIC_CONVEX_URL!;
  if (cloudUrl.includes(".convex.cloud")) {
    return cloudUrl.replace(".convex.cloud", ".convex.site");
  }
  return process.env.NEXT_PUBLIC_CONVEX_SITE_URL ?? cloudUrl;
}
