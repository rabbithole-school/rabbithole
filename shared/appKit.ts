export const APP_KIT_V1_SCRIPT_FILES = [
  "konva.min.js",
  "cytoscape.min.js",
  "chart.umd.min.js",
  "matter.min.js",
] as const;

export const APP_KIT_V2_SCRIPT_FILES = [
  "p5.min.js",
  "fraction.min.js",
  "katex.min.js",
  "jsxgraph.min.js",
  "math.min.js",
  "three.iife.min.js",
  "rh-expression-editor.js",
] as const;

export const APP_KIT_STYLESHEET_FILES = [
  "katex.inline.css",
  "jsxgraph.min.css",
  "rh-expression-editor.css",
] as const;

export const APP_KIT_SCRIPT_FILES = [
  ...APP_KIT_V1_SCRIPT_FILES,
  ...APP_KIT_V2_SCRIPT_FILES,
] as const;

export const APP_KIT_V1_FILES = [...APP_KIT_V1_SCRIPT_FILES] as const;
export const APP_KIT_V2_FILES = [
  "p5.min.js",
  "fraction.min.js",
  "katex.min.js",
  "katex.inline.css",
  "jsxgraph.min.js",
  "jsxgraph.min.css",
  "math.min.js",
  "three.iife.min.js",
  "rh-expression-editor.js",
  "rh-expression-editor.css",
] as const;
export const APP_KIT_FILES = [
  ...APP_KIT_V1_FILES,
  ...APP_KIT_V2_FILES,
] as const;

export type AppKitFile = (typeof APP_KIT_FILES)[number];
export type AppKitSourceResolver = (file: AppKitFile) => string | undefined;
export type AsyncAppKitSourceResolver = (
  file: AppKitFile,
) => Promise<string | undefined>;

type AppKitAsset = {
  file: AppKitFile;
  kind: "script" | "stylesheet";
};

const APP_KIT_PATH_PREFIX = "/app-kit/";
const APP_KIT_ASSETS = new Map<string, AppKitAsset>([
  ...APP_KIT_V1_SCRIPT_FILES.map(
    (file) =>
      [`/app-kit/v1/${file}`, { file, kind: "script" }] as const,
  ),
  ...APP_KIT_V2_SCRIPT_FILES.map(
    (file) =>
      [`/app-kit/v2/${file}`, { file, kind: "script" }] as const,
  ),
  ...APP_KIT_STYLESHEET_FILES.map(
    (file) =>
      [`/app-kit/v2/${file}`, { file, kind: "stylesheet" }] as const,
  ),
]);
const SCRIPT_TAG = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const LINK_TAG = /<link\b([^>]*)>/gi;
const SCRIPT_SRC = /\bsrc\s*=\s*(["'])([^"']+)\1/i;
const LINK_HREF = /\bhref\s*=\s*(["'])([^"']+)\1/i;
const LINK_REL = /\brel\s*=\s*(["'])([^"']+)\1/i;
const SCRIPT_TYPE =
  /(?:^|\s)type(?:\s*=\s*(?:(["'])(.*?)\1|([^\s"'=<>`]+)))?(?=\s|$)/i;
const INLINED_SCRIPT_EXECUTION_ATTRIBUTES =
  /(?:^|\s)(?:type|defer|async)(?:\s*=\s*(?:(["'])(.*?)\1|[^\s"'=<>`]+))?(?=\s|$)/gi;

function appKitAssetFromPath(path: string): AppKitAsset | null {
  return APP_KIT_ASSETS.get(path) ?? null;
}

export function requestedAppKitFiles(html: string): AppKitFile[] {
  const requested = new Set<AppKitFile>();
  for (const match of html.matchAll(SCRIPT_TAG)) {
    const src = match[1].match(SCRIPT_SRC)?.[2];
    if (!src) continue;
    const asset = appKitAssetFromPath(src);
    if (asset?.kind === "script") requested.add(asset.file);
  }
  for (const match of html.matchAll(LINK_TAG)) {
    const href = match[1].match(LINK_HREF)?.[2];
    if (!href) continue;
    const asset = appKitAssetFromPath(href);
    if (asset?.kind === "stylesheet") requested.add(asset.file);
  }
  return [...requested];
}

export function inlineAppKitScripts(
  html: string,
  resolveSource: AppKitSourceResolver,
): string {
  const withScripts = html.replace(
    SCRIPT_TAG,
    (tag, attributes: string) => {
      const srcMatch = attributes.match(SCRIPT_SRC);
      if (!srcMatch) return tag;
      const requestedPath = srcMatch[2];
      if (!requestedPath.startsWith(APP_KIT_PATH_PREFIX)) return tag;
      const asset = appKitAssetFromPath(requestedPath);
      if (asset?.kind !== "script") {
        return `<script>console.error(${JSON.stringify(
          `Unsupported app-kit script: ${requestedPath}`,
        )})</script>`;
      }
      const typeMatch = attributes.match(SCRIPT_TYPE);
      const scriptType = typeMatch?.[2] ?? typeMatch?.[3] ?? "";
      if (scriptType.trim() !== "") {
        return `<script>console.error(${JSON.stringify(
          `Unsupported app-kit script type: ${scriptType}`,
        )})</script>`;
      }

      const source = resolveSource(asset.file);
      if (source === undefined) {
        throw new Error(`Missing bundled app-kit source: ${asset.file}`);
      }
      const remainingAttributes = attributes
        .replace(srcMatch[0], "")
        .replace(INLINED_SCRIPT_EXECUTION_ATTRIBUTES, "")
        .trim();
      const openTag = remainingAttributes
        ? `<script ${remainingAttributes}>`
        : "<script>";
      return `${openTag}${source.replace(/<\/script/gi, "<\\/script")}</script>`;
    },
  );

  return withScripts.replace(LINK_TAG, (tag, attributes: string) => {
    const hrefMatch = attributes.match(LINK_HREF);
    if (!hrefMatch) return tag;
    const requestedPath = hrefMatch[2];
    if (!requestedPath.startsWith(APP_KIT_PATH_PREFIX)) return tag;
    const relMatch = attributes.match(LINK_REL);
    const asset = appKitAssetFromPath(requestedPath);
    if (
      asset?.kind !== "stylesheet" ||
      relMatch?.[2].toLowerCase() !== "stylesheet"
    ) {
      return `<script>console.error(${JSON.stringify(
        `Unsupported app-kit stylesheet: ${requestedPath}`,
      )})</script>`;
    }

    const source = resolveSource(asset.file);
    if (source === undefined) {
      throw new Error(`Missing bundled app-kit source: ${asset.file}`);
    }
    const remainingAttributes = attributes
      .replace(hrefMatch[0], "")
      .replace(relMatch[0], "")
      .trim();
    const openTag = remainingAttributes
      ? `<style ${remainingAttributes}>`
      : "<style>";
    return `${openTag}${source.replace(/<\/style/gi, "<\\/style")}</style>`;
  });
}
