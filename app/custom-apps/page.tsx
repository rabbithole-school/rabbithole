// /custom-apps?token=… — the ONE launcher url every bot-installed custom app
// resolves through (see convex/customApps.ts + convex/lib/customAppTools.ts).
//
// The `token` is an unguessable bearer secret; `resolveByToken` is token-gated
// (no user session needed — this renders inside the locked webview AND in a
// plain browser). Two live shapes:
//   • static → the app's self-contained HTML, rendered in a SANDBOXED iframe.
//     `sandbox="allow-scripts"` WITHOUT `allow-same-origin` puts the app in an
//     opaque origin, so a vibecoded app can never read this origin's cookies or
//     call our authed APIs. (The flip side — no localStorage/persistence — is
//     exactly why anything that needs storage is a "coded" app instead.)
//   • coded → redirect to the in-repo route the dispatched PR built (which
//     enforces its own Convex auth).
// A still-building coded app shows a placeholder; a bad/archived token 404s.

import { notFound, redirect } from "next/navigation";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { injectAppStateSdk } from "@/lib/appStateBridge.mjs";
import { CustomAppHost } from "./CustomAppHost";

// The token → app lookup must run per-request, never be statically cached.
export const dynamic = "force-dynamic";

const STATIC_APP_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'";

function withStaticAppCsp(html: string): string {
  if (
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy\b/i.test(html)
  ) {
    return html;
  }
  const meta = `<meta http-equiv="Content-Security-Policy" content="${STATIC_APP_CSP}">`;
  // srcDoc CSP support varies, so inject a matching meta policy as a fallback.
  return /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${meta}`)
    : `${meta}${html}`;
}

async function resolve(token: string) {
  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return null;
  try {
    return await new ConvexHttpClient(convexUrl).query(
      api.customApps.resolveByToken,
      { token },
    );
  } catch {
    return null;
  }
}

function CenteredNote({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        padding: 24,
        textAlign: "center",
        color: "#334155",
        background: "#f9fafa",
        fontFamily: "var(--font-hanken-grotesk), system-ui, sans-serif",
      }}
    >
      <div style={{ fontSize: 20, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 15, maxWidth: 420, color: "#64748b" }}>{body}</div>
    </div>
  );
}

export default async function CustomAppPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token: raw } = await searchParams;
  const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!token) notFound();

  const app = await resolve(token);
  if (!app) notFound();

  if (app.kind === "coded") {
    if (app.status === "live" && app.routePath) {
      redirect(app.routePath);
    }
    return (
      <CenteredNote
        title={`${app.name} is being built`}
        body="This app was handed to a coding agent. It'll appear here automatically once the pull request is reviewed and merged."
      />
    );
  }

  if (app.status !== "live" || app.html == null) notFound();

  return (
    <CustomAppHost
      token={token}
      name={app.name}
      srcDoc={injectAppStateSdk(withStaticAppCsp(app.html))}
      csp={STATIC_APP_CSP}
    />
  );
}
