/**
 * WebAuthn relying-party configuration + the global enforcement switch.
 *
 * rpID / origin are bound to the domain a credential was created under. Prod
 * retains its established credential domain as its RP ID while allowing the related
 * rabbithole.school origin; dev uses localhost. Drive them from Convex
 * dashboard env vars — a credential registered against `localhost` will never
 * verify against the prod RP ID. See .claude/rules/rabbithole-passkeys.md.
 *
 * Env vars (set per-deployment in the Convex dashboard):
 *   PASSKEY_RP_ID            e.g. "credentials.example.invalid" (prod) / "localhost" (dev)
 *   PASSKEY_ORIGIN           e.g. "https://credentials.example.invalid,https://app.example.invalid"
 *                            (prod) / "http://localhost:1041" (dev)
 *                            (comma-separate to allow multiple origins)
 *   PASSKEY_RP_NAME          human label shown in the OS prompt (default "Rabbithole")
 *
 * There is intentionally NO enforcement env var. Passwordless is
 * self-migrating: a staffer with a passkey is blocked from password login
 * (convex/auth.ts), and a staffer with none is forced to enroll on next
 * login (the /setup-passkey gate). See .claude/rules/rabbithole-passkeys.md.
 */

export interface PasskeyConfig {
  rpID: string;
  rpName: string;
  /** All origins accepted during server-side WebAuthn verification. */
  origins: string[];
}

export function getPasskeyConfig(): PasskeyConfig {
  const rpID = process.env.PASSKEY_RP_ID ?? "localhost";
  const rpName = process.env.PASSKEY_RP_NAME ?? "Rabbithole";
  const originEnv =
    process.env.PASSKEY_ORIGIN ?? "http://localhost:1041,http://localhost:1042";
  const origins = originEnv
    .split(",")
    .map((o: string) => o.trim())
    .filter(Boolean);
  return { rpID, rpName, origins };
}

/** Challenge lifetime: a ceremony must complete within this window. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Enrollment-token lifetime. */
export const ENROLLMENT_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
