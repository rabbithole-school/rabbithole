import {
  requestedAppKitFiles,
  type AsyncAppKitSourceResolver,
  type AppKitFile,
} from "./appKit";
import type { AppAssetUrlResolver } from "./appAssets";
import {
  APP_SANDBOX_CSP,
  appSandboxCsp,
  prepareCustomAppSandboxWithSources,
  withAppSandboxCsp,
} from "./customAppSandboxCore";

export { APP_SANDBOX_CSP, appSandboxCsp, withAppSandboxCsp };

type AppStateSdkInjector = (html: string) => string;
const NO_APP_KIT_SOURCE = () => undefined;
const NO_APP_ASSET_URL = () => undefined;

export async function prepareCustomAppSandbox(
  html: string,
  injectAppStateSdk: AppStateSdkInjector,
  resolveAppKitSource: AsyncAppKitSourceResolver,
  resolveAssetUrl: AppAssetUrlResolver = NO_APP_ASSET_URL,
): Promise<{ csp: string; srcDoc: string }> {
  const requestedFiles = requestedAppKitFiles(html);
  const sources = new Map<AppKitFile, string>();
  await Promise.all(
    requestedFiles.map(async (file) => {
      const source = await resolveAppKitSource(file);
      if (source === undefined) {
        throw new Error(`Missing bundled app-kit source: ${file}`);
      }
      sources.set(file, source);
    }),
  );
  const resolveSource =
    requestedFiles.length === 0
      ? NO_APP_KIT_SOURCE
      : (file: AppKitFile) => sources.get(file);
  return prepareCustomAppSandboxWithSources(
    html,
    injectAppStateSdk,
    resolveSource,
    resolveAssetUrl,
  );
}
