export const APP_ASSET_PATH_PREFIX = "/app-assets/";
export const MAX_APP_ASSETS = 8;
export const MAX_APP_ASSET_BYTES = 300 * 1024;
export const MAX_APP_ASSET_DIMENSION = 1024;

export type AppAssetUrlResolver = (assetId: string) => string | undefined;

const APP_ASSET_REFERENCE = /\/app-assets\/([A-Za-z0-9_-]+)/g;

// Script assets (charm_model's 3D models) resolve to a data: URL carrying the
// script text instead of a storage URL. The sandbox CSP admits only inline
// scripts, so the host inlines them the way it inlines /app-kit/ scripts.
const APP_ASSET_SCRIPT_URL_PREFIX = "data:text/javascript;charset=utf-8,";
const APP_ASSET_SCRIPT_TAG =
  /<script\b[^>]*\bsrc\s*=\s*(["'])\/app-assets\/([A-Za-z0-9_-]+)\1[^>]*>\s*<\/script\s*>/gi;

/** The resolved "URL" of a script asset: its source, carried inline. */
export function appAssetScriptUrl(source: string): string {
  return `${APP_ASSET_SCRIPT_URL_PREFIX}${encodeURIComponent(source)}`;
}

/**
 * Replace each <script src="/app-assets/<id>"></script> whose asset resolved
 * to a script with an inline <script> holding its source. Image assets and
 * unresolved ids are left for resolveAppAssetRefs.
 */
export function inlineAppAssetScripts(
  html: string,
  resolveUrl: AppAssetUrlResolver,
): string {
  return html.replace(APP_ASSET_SCRIPT_TAG, (tag, _quote, assetId: string) => {
    const url = resolveUrl(assetId);
    if (!url?.startsWith(APP_ASSET_SCRIPT_URL_PREFIX)) return tag;
    const source = decodeURIComponent(url.slice(APP_ASSET_SCRIPT_URL_PREFIX.length));
    return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
}

export function appAssetRef(assetId: string): string {
  return `${APP_ASSET_PATH_PREFIX}${assetId}`;
}

export function requestedAppAssetIds(html: string): string[] {
  const requested = new Set<string>();
  for (const match of html.matchAll(APP_ASSET_REFERENCE)) {
    requested.add(match[1]);
  }
  return [...requested];
}

export function resolveAppAssetRefs(
  html: string,
  resolveUrl: AppAssetUrlResolver,
): string {
  return html.replace(APP_ASSET_REFERENCE, (reference, assetId: string) => {
    const url = resolveUrl(assetId);
    if (url === undefined) {
      throw new Error(`Missing app asset URL: ${assetId}`);
    }
    return url;
  });
}

export function appAssetSources(urls: Iterable<string>): string[] {
  return [
    ...new Set(
      // Inline script assets need no network origin.
      [...urls].filter((url) => !url.startsWith("data:")).map((url) => {
        const resolved = new URL(url);
        return `${resolved.origin}${resolved.pathname.slice(
          0,
          resolved.pathname.lastIndexOf("/") + 1,
        )}`;
      }),
    ),
  ].sort();
}

export function rewriteAppAssetRefs(
  html: string,
  replacements: ReadonlyMap<string, string>,
): string {
  return html.replace(APP_ASSET_REFERENCE, (reference, assetId: string) => {
    const replacement = replacements.get(assetId);
    return replacement === undefined ? reference : appAssetRef(replacement);
  });
}
