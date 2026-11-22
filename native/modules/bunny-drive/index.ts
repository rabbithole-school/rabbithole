import { requireOptionalNativeModule } from "expo-modules-core";

export type SpoolRecord = {
  id: string;
  tag: string;
  path: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  capturedAt: number;
};

type BunnyDriveFilesModule = {
  readHolder(): Promise<string | null>;
  writeHolder(json: string): Promise<void>;
  holderTag(holderKey: string): Promise<string>;
  listSpool(): Promise<SpoolRecord[]>;
  stageSpool(id: string, destinationUri: string): Promise<void>;
  /** Removes the record and its bytes only if it still holds this version. */
  removeSpool(id: string, sha256: string): Promise<void>;
  flushLocation(): Promise<void>;
  rescueSaves(): Promise<{ rescued: number; unreadable: number; blocked: number }>;
  evictTaken(): Promise<void>;
  resetLocation(): Promise<void>;
  signal(): Promise<void>;
};

/**
 * Thin wrapper for the app's half of the Bunny Drive location in Files. It makes
 * no decisions: see src/lib/bunnyDrive/filesLocationRunner.ts. Null on a build
 * without the module, where Files simply stays empty.
 */
export const bunnyDriveFiles =
  requireOptionalNativeModule<BunnyDriveFilesModule>("BunnyDriveFiles");
