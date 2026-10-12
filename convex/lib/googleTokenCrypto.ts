// At-rest encryption for the per-user Google OAuth tokens in `googleAccounts`.
//
// Format: `v1:<iv>:<ciphertext>` — AES-256-GCM via Web Crypto, base64url
// segments, 96-bit random IV, 128-bit tag appended to the ciphertext by GCM.
// The version prefix names the KEY, so a rotation adds `v2` (with its own env
// var) next to `v1` instead of rewriting this format. See
// `.claude/rules/rabbithole-google-token-encryption.md`.
//
// Lives outside `"use node"` and uses only Web Crypto, so queries, mutations,
// actions and HTTP actions can all call it.
//
// Migration state (widen → migrate → narrow):
//   WIDEN (now): readers accept legacy plaintext OR `v1:`; writers write `v1:`.
//   MIGRATE:     `migrations:runEncryptGoogleAccountTokens` encrypts old rows.
//   NARROW (later, not done): `openGoogleToken` rejects plaintext.

import type { Doc } from "../_generated/dataModel";

export const GOOGLE_TOKEN_KEY_ENV = "GOOGLE_TOKEN_ENCRYPTION_KEY";

/** Key version → env var holding that key. Add `v2` here to rotate. */
const KEY_ENV_BY_VERSION = {
  v1: GOOGLE_TOKEN_KEY_ENV,
} as const;
type KeyVersion = keyof typeof KEY_ENV_BY_VERSION;
/** The version every writer uses. */
const CURRENT_VERSION: KeyVersion = "v1";

/** Binds ciphertext to this table so a blob can't be replayed into another
 *  encrypted column that shares the key. */
const ADDITIONAL_DATA = new TextEncoder().encode("rabbithole:googleAccounts:token");

const IV_BYTES = 12;
const KEY_BYTES = 32;

export class GoogleTokenKeyMissingError extends Error {
  constructor(version: string) {
    const envName =
      KEY_ENV_BY_VERSION[version as KeyVersion] ?? `${GOOGLE_TOKEN_KEY_ENV} (${version})`;
    super(
      `Google token encryption key is not configured. Set ${envName} ` +
        "(base64, 32 bytes) in the Convex dashboard.",
    );
    this.name = "GoogleTokenKeyMissingError";
  }
}

export class GoogleTokenDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleTokenDecryptError";
  }
}

// ── base64url ────────────────────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

// ── keys ─────────────────────────────────────────────────────────────────

const keyCache = new Map<string, Promise<CryptoKey>>();

function rawKeyFor(version: KeyVersion): string | undefined {
  const raw = process.env[KEY_ENV_BY_VERSION[version]]?.trim();
  return raw ? raw : undefined;
}

async function importKey(rawBase64: string): Promise<CryptoKey> {
  let cached = keyCache.get(rawBase64);
  if (!cached) {
    cached = (async () => {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = fromBase64(rawBase64);
      } catch {
        throw new Error(`${GOOGLE_TOKEN_KEY_ENV} is not valid base64.`);
      }
      if (bytes.length !== KEY_BYTES) {
        throw new Error(
          `${GOOGLE_TOKEN_KEY_ENV} must decode to ${KEY_BYTES} bytes (got ${bytes.length}).`,
        );
      }
      return await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    })();
    keyCache.set(rawBase64, cached);
    // A bad key should not be cached forever — let a corrected env var retry.
    cached.catch(() => keyCache.delete(rawBase64));
  }
  return await cached;
}

async function keyFor(version: KeyVersion): Promise<CryptoKey> {
  const raw = rawKeyFor(version);
  if (!raw) throw new GoogleTokenKeyMissingError(version);
  return await importKey(raw);
}

// ── deployment guard ─────────────────────────────────────────────────────

/** The explicit dev opt-in. Set `ADMISSIONS_DEV_MODE=1` on a hosted dev or
 *  prototype deployment to allow plaintext Google tokens without a key and
 *  the platform-admin Admissions gate bypass. Never set it on production. */
export const ADMISSIONS_DEV_MODE_ENV = "ADMISSIONS_DEV_MODE";

/** Fails closed: any hosted deployment (`CONVEX_CLOUD_URL` set) counts as
 *  production unless it opts in with `ADMISSIONS_DEV_MODE=1`. Only a local
 *  or test run (no cloud URL) is dev by default. Also decides whether the
 *  Admissions Google gate may be bypassed (googleAccounts.ts). */
export function isProdDeployment(): boolean {
  if (!process.env.CONVEX_CLOUD_URL) return false;
  return process.env[ADMISSIONS_DEV_MODE_ENV] !== "1";
}

export function isGoogleTokenEncryptionConfigured(): boolean {
  return rawKeyFor(CURRENT_VERSION) !== undefined;
}

// ── format ───────────────────────────────────────────────────────────────

function parseEncrypted(
  stored: string,
): { version: KeyVersion; iv: string; ciphertext: string } | null {
  const parts = stored.split(":");
  if (parts.length !== 3) return null;
  const [version, iv, ciphertext] = parts;
  if (!(version in KEY_ENV_BY_VERSION)) return null;
  if (!iv || !ciphertext) return null;
  return { version: version as KeyVersion, iv, ciphertext };
}

/** True for a value in the versioned encrypted format (any known version). */
export function isEncryptedGoogleToken(stored: string): boolean {
  return parseEncrypted(stored) !== null;
}

/** Encrypt one token with the CURRENT key. Throws if the key is missing. */
export async function encryptGoogleToken(plaintext: string): Promise<string> {
  const key = await keyFor(CURRENT_VERSION);
  const iv = new Uint8Array(new ArrayBuffer(IV_BYTES));
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: ADDITIONAL_DATA },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${CURRENT_VERSION}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ciphertext))}`;
}

/**
 * THE read helper. Every code path that USES a stored Google token goes
 * through here (directly or via `openGoogleAccountTokens`).
 *
 * WIDEN phase: a value without a version prefix is legacy plaintext and is
 * returned unchanged. Narrowing removes that branch.
 */
export async function openGoogleToken(stored: string): Promise<string> {
  const parsed = parseEncrypted(stored);
  if (!parsed) {
    if (/^v\d+:/.test(stored)) {
      // Looks versioned but isn't a version we know or is malformed — never
      // hand this to Google as if it were a bearer token.
      throw new GoogleTokenDecryptError("Unrecognised Google token format.");
    }
    return stored; // legacy plaintext (WIDEN phase only)
  }
  const key = await keyFor(parsed.version);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(parsed.iv), additionalData: ADDITIONAL_DATA },
      key,
      fromBase64(parsed.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    throw new GoogleTokenDecryptError(
      "Google token failed to decrypt (wrong key or tampered ciphertext).",
    );
  }
}

/** Decrypt both tokens on a `googleAccounts` row. */
export async function openGoogleAccountTokens(
  row: Pick<Doc<"googleAccounts">, "accessToken" | "refreshToken">,
): Promise<{ accessToken: string; refreshToken: string | undefined }> {
  return {
    accessToken: await openGoogleToken(row.accessToken),
    refreshToken:
      row.refreshToken === undefined ? undefined : await openGoogleToken(row.refreshToken),
  };
}

/**
 * Prepare a token for storage. Every write to `googleAccounts.accessToken` /
 * `refreshToken` goes through here.
 *
 * Without a key: production refuses (the write path does not start); a dev or
 * test deployment stores legacy plaintext with a warning so local Google flows
 * keep working until the key is set. The encrypt migration upgrades those rows.
 */
export async function sealGoogleToken(plaintext: string): Promise<string> {
  if (isEncryptedGoogleToken(plaintext)) {
    // Already sealed (e.g. a caller re-saving a stored value). Re-encrypting
    // would double-wrap it.
    return plaintext;
  }
  if (!isGoogleTokenEncryptionConfigured()) {
    if (isProdDeployment()) throw new GoogleTokenKeyMissingError(CURRENT_VERSION);
    console.warn(
      `[googleTokenCrypto] ${GOOGLE_TOKEN_KEY_ENV} is unset; storing Google token as plaintext (dev only).`,
    );
    return plaintext;
  }
  return await encryptGoogleToken(plaintext);
}
