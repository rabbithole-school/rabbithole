import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";

import type { AppKitFile } from "../../vendor/shared/appKit";
import {
  APP_KIT_MANIFEST_ASSETS,
  APP_KIT_SOURCE_ASSETS,
  type AppKitVersion,
} from "./appKitAssets.generated";
import { assertAppKitSourceIntegrity } from "./appKitIntegrity";

type AppKitManifest = {
  version: AppKitVersion;
  libraries: Record<string, { sha256: string }>;
};

const manifestPromises = new Map<AppKitVersion, Promise<AppKitManifest>>();
const sourcePromises = new Map<AppKitFile, Promise<string>>();
const resolvedSources = new Map<AppKitFile, string>();

async function readBundledAsset(module: number, label: string): Promise<string> {
  const asset = await Asset.fromModule(module).downloadAsync();
  const uri = asset.localUri ?? asset.uri;
  if (!uri) {
    throw new Error(`Bundled app-kit asset has no readable URI: ${label}`);
  }
  return FileSystem.readAsStringAsync(uri);
}

function loadManifest(version: AppKitVersion): Promise<AppKitManifest> {
  const existing = manifestPromises.get(version);
  if (existing) return existing;

  const pending = readBundledAsset(
    APP_KIT_MANIFEST_ASSETS[version],
    `${version}/manifest.json`,
  ).then((source) => {
    const manifest = JSON.parse(source) as AppKitManifest;
    if (manifest.version !== version || !manifest.libraries) {
      throw new Error(`Invalid bundled app-kit manifest: ${version}`);
    }
    return manifest;
  });
  manifestPromises.set(version, pending);
  return pending;
}

async function loadSource(file: AppKitFile): Promise<string> {
  const asset = APP_KIT_SOURCE_ASSETS[file];
  const [source, manifest] = await Promise.all([
    readBundledAsset(asset.module, `${asset.version}/${file}`),
    loadManifest(asset.version),
  ]);
  const metadata = manifest.libraries[file];
  if (!metadata?.sha256) {
    throw new Error(
      `Bundled app-kit manifest has no integrity entry for ${asset.version}/${file}`,
    );
  }
  assertAppKitSourceIntegrity(file, source, metadata.sha256);
  resolvedSources.set(file, source);
  return source;
}

export function resolveNativeAppKitSource(
  file: AppKitFile,
): Promise<string> {
  const resolved = resolvedSources.get(file);
  if (resolved !== undefined) return Promise.resolve(resolved);

  const existing = sourcePromises.get(file);
  if (existing) return existing;

  const pending = loadSource(file).catch((error: unknown) => {
    sourcePromises.delete(file);
    throw error;
  });
  sourcePromises.set(file, pending);
  return pending;
}
