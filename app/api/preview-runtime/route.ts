// GET /api/preview-runtime — the browser-visible values of THIS Vercel Preview,
// plus the commit it was built from, so Merge Marshal's iOS smoke job can point
// a simulator at the preview's own Convex backend. A 404 on every deployment
// except a Preview. It adds no exposure: all of it already ships in a Preview's
// public JS bundle, and the dev-login secret exists only on Previews and dev.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  if (process.env.VERCEL_ENV !== "preview") {
    return new NextResponse(null, { status: 404 });
  }
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? null;
  return NextResponse.json(
    {
      commitSha: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      convexUrl,
      convexSiteUrl: convexUrl?.replace(/\.convex\.cloud$/, ".convex.site") ?? null,
      devLoginSecret: process.env.NEXT_PUBLIC_DEV_LOGIN_SECRET ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
