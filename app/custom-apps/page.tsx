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

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { injectAppStateSdk } from "@/lib/appStateBridge.mjs";
import { prepareCustomAppSandbox } from "@/shared/customAppSandbox";
import { CustomAppHost } from "./CustomAppHost";
import { resolveCustomAppByToken } from "./customAppData";
import { buildCustomAppMetadata } from "./customAppMetadata";

// The token → app lookup must run per-request, never be statically cached.
export const dynamic = "force-dynamic";

type CustomAppPageProps = {
  searchParams: Promise<{ token?: string | string[] }>;
};

function tokenFrom(
  searchParams: { token?: string | string[] },
): string | undefined {
  const raw = searchParams.token;
  return (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;
}

export async function generateMetadata({
  searchParams,
}: CustomAppPageProps): Promise<Metadata> {
  const token = tokenFrom(await searchParams);
  const app = token ? await resolveCustomAppByToken(token) : null;
  return buildCustomAppMetadata(app, token ?? "");
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
}: CustomAppPageProps) {
  const token = tokenFrom(await searchParams);
  if (!token) notFound();

  const app = await resolveCustomAppByToken(token);
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
  const assetUrls = new Map(
    app.appAssets.map((asset) => [asset.id, asset.url]),
  );
  const sandbox = await prepareCustomAppSandbox(
    app.html,
    injectAppStateSdk,
    (assetId) => assetUrls.get(assetId),
  );

  return (
    <CustomAppHost
      token={token}
      name={app.name}
      srcDoc={sandbox.srcDoc}
      csp={sandbox.csp}
    />
  );
}
