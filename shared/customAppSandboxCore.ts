import {
  inlineAppKitScripts,
  type AppKitSourceResolver,
} from "./appKit";
import {
  appAssetSources,
  requestedAppAssetIds,
  resolveAppAssetRefs,
  type AppAssetUrlResolver,
} from "./appAssets";

type AppStateSdkInjector = (html: string) => string;

function buildAppSandboxCsp(assetSources: string[]): string {
  const sources = [...new Set(assetSources)].sort();
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${sources.length > 0 ? ` ${sources.join(" ")}` : ""}`,
    "font-src data:",
    `connect-src ${sources.length > 0 ? sources.join(" ") : "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export const APP_SANDBOX_CSP = buildAppSandboxCsp([]);

export function appSandboxCsp(assetSources: string[]): string {
  return buildAppSandboxCsp(assetSources);
}

export function withAppSandboxCsp(html: string, csp: string): string {
  const withoutAppCsp = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy\b[^>]*>/gi,
    "",
  );
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const doctype = withoutAppCsp.match(/^\s*<!doctype[^>]*>/i);
  if (!doctype) return `${meta}${withoutAppCsp}`;

  const prefix = doctype[0];
  return `${prefix}\n${meta}${withoutAppCsp.slice(prefix.length)}`;
}

export function prepareCustomAppSandboxWithSources(
  html: string,
  injectAppStateSdk: AppStateSdkInjector,
  resolveSource: AppKitSourceResolver,
  resolveAssetUrl: AppAssetUrlResolver,
): { csp: string; srcDoc: string } {
  const resolvedUrls = new Map<string, string>();
  for (const assetId of requestedAppAssetIds(html)) {
    const url = resolveAssetUrl(assetId);
    if (url !== undefined) resolvedUrls.set(assetId, url);
  }
  const csp = appSandboxCsp(appAssetSources(resolvedUrls.values()));
  const preparedHtml = inlineAppKitScripts(
    resolveAppAssetRefs(html, (assetId) => resolvedUrls.get(assetId)),
    resolveSource,
  );
  return {
    csp,
    srcDoc: injectAppStateSdk(withAppSandboxCsp(preparedHtml, csp)),
  };
}
