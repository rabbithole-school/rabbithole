export const APP_ASSET_PATH_PREFIX = "/app-assets/";
export const MAX_APP_ASSETS = 8;
export const MAX_APP_ASSET_BYTES = 300 * 1024;
export const MAX_APP_ASSET_DIMENSION = 1024;

export type AppAssetUrlResolver = (assetId: string) => string | undefined;

const APP_ASSET_REFERENCE = /\/app-assets\/([A-Za-z0-9_-]+)/g;

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
      [...urls].map((url) => {
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
