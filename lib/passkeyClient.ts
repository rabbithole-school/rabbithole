/**
 * Client-side WebAuthn ceremony helpers (browser side of convex/passkeys.ts).
 *
 * Each helper drives the two-step ceremony: call a Convex action to get
 * options + a challengeId, run the browser ceremony, then call the
 * matching verify step. Components pass in already-bound Convex callables
 * (useAction / useAuthActions) so this file stays React-free.
 */
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  WebAuthnAbortService,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { Id } from "@/convex/_generated/dataModel";

export { browserSupportsWebAuthn };

type StartResult = { options: unknown; challengeId: string };

/** True if the user cancelled / no credential available (not a real error). */
export function isPasskeyCancellation(err: unknown): boolean {
  const name = (err as { name?: string })?.name;
  return name === "NotAllowedError" || name === "AbortError";
}

const NEW_PASSKEY_HOST = "rabbithole.school";
const NEW_PASSKEY_DEV_HOST = "rabbithole.school.localhost";
let LEGACY_PASSKEY_RP_ORIGIN: string | undefined;
LEGACY_PASSKEY_RP_ORIGIN ??= "https://credentials.example.invalid";

/**
 * A Related Origin Request can fail with SecurityError when the browser cannot
 * complete a WebAuthn ceremony for the legacy RP from the new product host.
 */
export function relatedOriginPasskeyFallbackUrl(
  err: unknown,
  location: Pick<Location, "hostname" | "pathname" | "search">,
): string | null {
  if (
    (err as { name?: string })?.name !== "SecurityError" ||
    (location.hostname !== NEW_PASSKEY_HOST &&
      location.hostname !== NEW_PASSKEY_DEV_HOST)
  ) {
    return null;
  }

  const pathname =
    location.pathname.startsWith("/") && !location.pathname.startsWith("//")
      ? location.pathname
      : "/";
  const search = location.search.startsWith("?") ? location.search : "";
  return `${LEGACY_PASSKEY_RP_ORIGIN}${pathname}${search}`;
}

/**
 * Passwordless sign-in. `start` hits passkeys.startAuthentication; `signIn`
 * is from useAuthActions().
 */
export async function runPasskeySignIn(opts: {
  start: () => Promise<StartResult>;
  signIn: (
    provider: string,
    params: Record<string, string>,
  ) => Promise<unknown>;
}): Promise<void> {
  WebAuthnAbortService.cancelCeremony();
  const { options, challengeId } = await opts.start();
  const assertion = await startAuthentication({
    optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
  });
  await opts.signIn("passkey", {
    response: JSON.stringify(assertion),
    challengeId,
  });
}

/**
 * Register a passkey. `start` returns options+challengeId; `finish`
 * verifies + stores. Used for both signed-in self-enroll and token-based
 * first enroll (the caller supplies the right action pair).
 */
export async function runPasskeyRegistration(opts: {
  start: () => Promise<StartResult>;
  finish: (args: {
    challengeId: Id<"webauthnChallenges">;
    response: string;
    label?: string;
  }) => Promise<unknown>;
  label?: string;
}): Promise<void> {
  WebAuthnAbortService.cancelCeremony();
  const { options, challengeId } = await opts.start();
  const reg = await startRegistration({
    optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
  });
  await opts.finish({
    challengeId: challengeId as Id<"webauthnChallenges">,
    response: JSON.stringify(reg),
    label: opts.label,
  });
}

/** A sensible default device label from the user agent. */
export function guessDeviceLabel(): string {
  if (typeof navigator === "undefined") return "Passkey";
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "iPhone/iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows device";
  if (/Android/.test(ua)) return "Android device";
  return "Passkey";
}
