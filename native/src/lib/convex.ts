import { ConvexReactClient } from "convex/react";

// Single Convex client for the native app, pointed at the same dev deployment
// the web app uses (EXPO_PUBLIC_CONVEX_URL, set in native/.env).
const url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url) {
  throw new Error("EXPO_PUBLIC_CONVEX_URL is not set (see native/.env)");
}

export const convex = new ConvexReactClient(url, {
  unsavedChangesWarning: false,
});

// HTTP-action host (tutor SSE lives at `${convexSiteUrl}/project-stream`). The
// .site host serves Convex HTTP actions; .cloud serves queries/mutations.
export const convexSiteUrl =
  process.env.EXPO_PUBLIC_CONVEX_SITE_URL ??
  url.replace(".convex.cloud", ".convex.site");

// The SHARED Convex backend API — generated in the repo root and bundled via
// the metro monorepo config (watchFolders → ../convex). This is the whole
// point of the spike: the native app reuses the exact same typed API + domain
// logic as the web app, rewriting only the UI.
// The SHARED Convex backend API. TS resolves `@convex/*` to the real
// convex/_generated (full type-safety, via tsconfig paths); metro resolves
// `@convex/api` to the vendored copy (see metro.config.js) so Release builds
// work. Same typed `api` + `Id`/`Doc` as the web app — zero backend duplication.
export { api } from "@convex/api";
export type { Id, Doc } from "@convex/dataModel";
