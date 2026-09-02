import * as FileSystem from "expo-file-system/legacy";

import {
  serializeByKey,
  type KeyValueStorageAdapter,
} from "../../vendor/shared/practicePersistenceCore";

const directory = FileSystem.documentDirectory
  ? `${FileSystem.documentDirectory}practice-persistence/`
  : null;

function requireDirectory(): string {
  if (!directory) throw new Error("Persistent app storage is unavailable");
  return directory;
}

function stem(key: string): string {
  return `${requireDirectory()}${key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function checksum(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(16);
}

type Envelope = { v: 1; length: number; checksum: string; body: string };
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnvelopeCandidate(value: unknown): value is JsonObject & { v: 1 } {
  if (!isJsonObject(value) || value.v !== 1) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 1 ||
    Object.hasOwn(value, "body") ||
    Object.hasOwn(value, "length") ||
    Object.hasOwn(value, "checksum")
  );
}

function isEnvelope(value: JsonObject & { v: 1 }): value is Envelope {
  return (
    typeof value.body === "string" &&
    typeof value.length === "number" &&
    typeof value.checksum === "string" &&
    value.body.length === value.length &&
    checksum(value.body) === value.checksum
  );
}

function encode(value: string): string {
  return JSON.stringify({
    v: 1,
    length: value.length,
    checksum: checksum(value),
    body: value,
  } satisfies Envelope);
}

/**
 * Accept pre-envelope JSON unchanged, including domain payloads with their own
 * `v: 1`. Envelope fields discriminate this wrapper; the exact torn prefix
 * `{v: 1}` is also reserved so a truncated envelope cannot look like legacy
 * state and silently erase an outbox.
 */
function decode(raw: string, path: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Corrupt practice persistence file at ${path}: ${String(error)}`);
  }
  if (!isEnvelopeCandidate(parsed)) return raw;
  if (!isEnvelope(parsed)) {
    throw new Error(`Corrupt practice persistence file at ${path}: envelope failed validation`);
  }
  return parsed.body;
}

type Artifact =
  | { exists: false }
  | { exists: true; ok: true; value: string }
  | { exists: true; ok: false; error: unknown };

async function artifact(path: string): Promise<Artifact> {
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) return { exists: false };
  try {
    return { exists: true, ok: true, value: decode(await FileSystem.readAsStringAsync(path), path) };
  } catch (error) {
    return { exists: true, ok: false, error };
  }
}

function describe(result: Artifact): string {
  if (!result.exists) return "is absent";
  return result.ok ? "is valid" : `is unreadable (${String(result.error)})`;
}

/**
 * A null result means that every artifact is confirmed absent. If any artifact
 * exists but cannot validate, fail closed; callers must never erase an outbox
 * just because it was unreadable.
 */
async function read(key: string): Promise<string | null> {
  const base = stem(key);
  const primary = await artifact(`${base}.json`);
  if (primary.exists && primary.ok) return primary.value;
  const backup = await artifact(`${base}.bak`);
  if (backup.exists && backup.ok) {
    console.warn("[practice-persistence] recovered from last-known-good backup");
    return backup.value;
  }
  const temp = await artifact(`${base}.tmp`);
  if (temp.exists && temp.ok) {
    console.warn("[practice-persistence] recovered from staged temp");
    return temp.value;
  }
  if (!primary.exists && !backup.exists && !temp.exists) return null;
  throw new Error(
    `Practice persistence is unrecoverable for this key — primary ${describe(primary)}, backup ${describe(backup)}, temp ${describe(temp)}`,
  );
}

/**
 * Stage and independently verify new bytes before rotating the old primary,
 * then promote by same-directory move. The backup and staged file cover the
 * two interrupted-promotion windows; they are intentionally considered on
 * every subsequent read.
 */
async function write(key: string, value: string): Promise<void> {
  await FileSystem.makeDirectoryAsync(requireDirectory(), { intermediates: true });
  const base = stem(key);
  const primary = `${base}.json`;
  const temporary = `${base}.tmp`;
  const backup = `${base}.bak`;
  await FileSystem.writeAsStringAsync(temporary, encode(value));
  let staged: string;
  try {
    staged = decode(await FileSystem.readAsStringAsync(temporary), temporary);
  } catch (error) {
    throw new Error(`Failed to verify staged practice persistence write (${String(error)})`);
  }
  if (staged !== value) {
    throw new Error("Staged practice persistence write did not read back correctly");
  }
  if ((await FileSystem.getInfoAsync(primary)).exists) {
    await FileSystem.deleteAsync(backup, { idempotent: true });
    await FileSystem.copyAsync({ from: primary, to: backup });
  }
  await FileSystem.deleteAsync(primary, { idempotent: true });
  await FileSystem.moveAsync({ from: temporary, to: primary });
}

async function remove(key: string): Promise<void> {
  const base = stem(key);
  await FileSystem.deleteAsync(`${base}.json`, { idempotent: true });
  await FileSystem.deleteAsync(`${base}.bak`, { idempotent: true });
  await FileSystem.deleteAsync(`${base}.tmp`, { idempotent: true });
}

export const nativePracticePersistenceAdapter: KeyValueStorageAdapter = serializeByKey({
  kind: "native-file-system",
  read,
  write,
  remove,
});
