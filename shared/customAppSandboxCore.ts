import {
  inlineAppKitScripts,
  type AppKitSourceResolver,
} from "./appKit";
import {
  appAssetSources,
  inlineAppAssetScripts,
  requestedAppAssetIds,
  resolveAppAssetRefs,
  type AppAssetUrlResolver,
} from "./appAssets";

type AppStateSdkInjector = (html: string) => string;

/**
 * Runtime kits an app may opt into with
 * `<meta name="rabbithole-kit" content="pyodide@314.0.7">`. Unlike the
 * inlined /app-kit/ libraries, a kit is too big to inline (Pyodide's core wasm
 * is 9.6 MB), so the host serves it from its own web origin and widens the CSP
 * of THAT app only. Every other app keeps APP_SANDBOX_CSP byte for byte.
 */
export const PYODIDE_KIT_VERSION = "314.0.7";
export const PYODIDE_KIT_ID = `pyodide@${PYODIDE_KIT_VERSION}`;
export const PYODIDE_KIT_PATH = `/app-kit/pyodide/${PYODIDE_KIT_VERSION}/`;

// The opt-in is read from the document's head prologue only, under a strict
// grammar, so the scanner never has to agree with a browser about anything
// subtle. From the start of the document it accepts, in any order:
// whitespace, a doctype, an <html> or <head> start tag, a well-formed <meta>
// and a <title> holding plain text. The first token that is anything else
// (a comment, a script, a stray character, a malformed tag) ends the scan.
// Every `rabbithole-kit` meta must therefore come before any of those, which
// is where it belongs. A tag with a repeated attribute, an `&` in a value, or
// anything the grammar does not cover is not read, so every ambiguity fails
// closed. Each pattern is sticky and backtracks over a bounded alternation,
// so the scan is linear in the prologue's length.
// HTML whitespace only. JS `\s` also matches U+00A0, \v, U+2028 and more,
// which the HTML tokenizer treats as ordinary characters.
const WS = String.raw`[\t\n\f\r ]`;
const ATTR = String.raw`${WS}+([a-zA-Z][a-zA-Z0-9_:-]*)(?:${WS}*=${WS}*(?:"([^"<>&\0]*)"|'([^'<>&\0]*)'|([^\t\n\f\r "'=<>\x60&\0]+)))?`;
const PROLOGUE_TOKEN = new RegExp(
  [
    String.raw`(${WS}+)`,
    String.raw`(<!doctype[^<>]*>)`,
    String.raw`<(html|head|meta)((?:${ATTR})*)${WS}*/?>`,
    String.raw`(<title>[^<&]*</title${WS}*>)`,
  ].join("|"),
  "iy",
);
const ATTR_EACH = new RegExp(ATTR, "g");

/** The attributes of a well-formed tag, or null if any name repeats. */
function prologueAttributes(text: string): Map<string, string> | null {
  const attributes = new Map<string, string>();
  for (const match of text.matchAll(ATTR_EACH)) {
    const name = match[1].toLowerCase();
    if (attributes.has(name)) return null;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

/** Every `rabbithole-kit` value the app's head prologue declares, in order. */
export function requestedAppKits(html: string): string[] {
  // Every app runs through here; one substring check keeps the opt-in free
  // for the apps that don't use it.
  if (!html.includes("rabbithole-kit")) return [];
  const kits: string[] = [];
  PROLOGUE_TOKEN.lastIndex = html.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    const at = PROLOGUE_TOKEN.lastIndex;
    const match = PROLOGUE_TOKEN.exec(html);
    if (!match || match.index !== at || match[0].length === 0) break;
    if (match[3]?.toLowerCase() !== "meta") continue;
    const attributes = prologueAttributes(match[4] ?? "");
    if (!attributes) break;
    if (attributes.get("name") !== "rabbithole-kit") continue;
    // Exactly the value the browser stores: no trimming.
    kits.push(attributes.get("content") ?? "");
  }
  return kits;
}

/**
 * The absolute Pyodide base for a host's web origin, or undefined when the
 * origin is not an http(s) URL. Absolute because srcdoc frames and native
 * WebViews have opaque origins: a relative URL would resolve to nothing.
 */
export function pyodideKitBase(kitOrigin: string | undefined): string | undefined {
  if (!kitOrigin) return undefined;
  let url: URL;
  try {
    url = new URL(kitOrigin);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  // URL parsing lets characters like `"`, `'`, `;` and `,` through in a host.
  // The base lands in a CSP attribute and a script, so admit only a plain
  // DNS name or IPv4 address (the server page builds it from request headers).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(url.hostname)) {
    return undefined;
  }
  return `${url.origin}${PYODIDE_KIT_PATH}`;
}

function buildAppSandboxCsp(
  assetSources: string[],
  pyodideBase?: string,
): string {
  const sources = [...new Set(assetSources)].sort();
  const connectSources = pyodideBase
    ? [...new Set([...sources, pyodideBase])].sort()
    : sources;
  return [
    "default-src 'none'",
    pyodideBase
      ? `script-src 'unsafe-inline' 'wasm-unsafe-eval' ${pyodideBase}`
      : "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob:${sources.length > 0 ? ` ${sources.join(" ")}` : ""}`,
    "font-src data:",
    `connect-src ${connectSources.length > 0 ? connectSources.join(" ") : "'none'"}`,
    // Pyodide 314 runs in a module worker built from a blob: (or, inside an
    // opaque-origin frame, a data:) URL. Such workers inherit this policy.
    ...(pyodideBase ? ["worker-src blob: data:"] : []),
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export const APP_SANDBOX_CSP = buildAppSandboxCsp([]);

export function appSandboxCsp(
  assetSources: string[],
  pyodideBase?: string,
): string {
  return buildAppSandboxCsp(assetSources, pyodideBase);
}

/** Script the host runs before the app's own scripts in an opted-in app. */
function pyodideKitGlobalsScript(pyodideBase: string): string {
  return `<script>window.RABBITHOLE_KIT=Object.freeze({pyodide:Object.freeze({base:${JSON.stringify(
    pyodideBase,
  )}})});</script>`;
}

function kitErrorScript(message: string): string {
  return `<script>console.error(${JSON.stringify(message).replace(
    /</g,
    "\\u003c",
  )})</script>`;
}

type ResolvedAppKits = { pyodideBase?: string; headScript: string };

/**
 * Decide the kit grants from the app author's HTML alone, before the host
 * inlines anything into it, so no host-added text can opt an app in.
 */
function resolveAppKits(
  html: string,
  kitOrigin: string | undefined,
): ResolvedAppKits {
  const kits = requestedAppKits(html);
  if (kits.length === 0) return { headScript: "" };
  const unsupported = kits.filter((kit) => kit !== PYODIDE_KIT_ID);
  if (unsupported.length > 0) {
    return {
      headScript: kitErrorScript(
        `Unsupported rabbithole-kit: ${unsupported.join(", ")}. Supported: ${PYODIDE_KIT_ID}`,
      ),
    };
  }
  const pyodideBase = pyodideKitBase(kitOrigin);
  if (!pyodideBase) {
    return {
      headScript: kitErrorScript(
        `This host cannot serve rabbithole-kit ${PYODIDE_KIT_ID}.`,
      ),
    };
  }
  return { pyodideBase, headScript: pyodideKitGlobalsScript(pyodideBase) };
}

export function withAppSandboxCsp(
  html: string,
  csp: string,
  headScript = "",
): string {
  const withoutAppCsp = html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy\b[^>]*>/gi,
    "",
  );
  // Policies carry no `&` or `"` today; escaping keeps it that way by construction.
  const attribute = csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const meta = `<meta http-equiv="Content-Security-Policy" content="${attribute}">${headScript}`;
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
  kitOrigin?: string,
): { csp: string; srcDoc: string } {
  const kits = resolveAppKits(html, kitOrigin);
  const resolvedUrls = new Map<string, string>();
  for (const assetId of requestedAppAssetIds(html)) {
    const url = resolveAssetUrl(assetId);
    if (url !== undefined) resolvedUrls.set(assetId, url);
  }
  const csp = appSandboxCsp(
    appAssetSources(resolvedUrls.values()),
    kits.pyodideBase,
  );
  const resolveResolved = (assetId: string) => resolvedUrls.get(assetId);
  const preparedHtml = inlineAppKitScripts(
    resolveAppAssetRefs(
      inlineAppAssetScripts(html, resolveResolved),
      resolveResolved,
    ),
    resolveSource,
  );
  return {
    csp,
    srcDoc: injectAppStateSdk(withAppSandboxCsp(preparedHtml, csp, kits.headScript)),
  };
}
