import type { AppAssetUrlResolver } from "./appAssets";
import { requestedAppKitFiles } from "./appKit";
import { prepareCustomAppSandboxWithSources } from "./customAppSandboxCore";

export {
  APP_SANDBOX_CSP,
  PYODIDE_KIT_ID,
  PYODIDE_KIT_PATH,
  PYODIDE_KIT_VERSION,
  appSandboxCsp,
  pyodideKitBase,
  requestedAppKits,
  withAppSandboxCsp,
} from "./customAppSandboxCore";

type AppStateSdkInjector = (html: string) => string;

const NO_APP_KIT_SOURCE = () => undefined;
const NO_APP_ASSET_URL = () => undefined;

export async function prepareCustomAppSandbox(
  html: string,
  injectAppStateSdk: AppStateSdkInjector,
  resolveAssetUrl: AppAssetUrlResolver = NO_APP_ASSET_URL,
  /** Web origin that serves /app-kit/pyodide/; see PYODIDE_KIT_PATH. */
  kitOrigin?: string,
): Promise<{ csp: string; srcDoc: string }> {
  const requestedFiles = requestedAppKitFiles(html);
  const resolveSource =
    requestedFiles.length === 0
      ? NO_APP_KIT_SOURCE
      : (await import("./appKitSources.generated"))
          .resolveBundledAppKitSource;

  return prepareCustomAppSandboxWithSources(
    html,
    injectAppStateSdk,
    resolveSource,
    resolveAssetUrl,
    kitOrigin,
  );
}
