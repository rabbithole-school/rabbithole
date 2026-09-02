function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(
      `Missing required deployment config: ${name}. Set ${name} for this Convex deployment.`,
    );
  }
  return value;
}

function optionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function familyFacingAddress(address: string): string {
  const [local, domain] = address.split("@");
  return local.toLowerCase() === "no-reply"
    ? `families@${domain}`
    : address;
}

/** Absolute app origin for links emitted by this Convex deployment. */
export function appBaseUrl(): string {
  return requiredEnv("SITE_URL");
}

/** Optional app origin for surfaces that may omit links in local/plane mode. */
export function appBaseUrlOrNull(): string | null {
  return optionalEnv("SITE_URL");
}

/** Stable Google Drive push target, intentionally independent of app links. */
export function driveWebhookUrl(): string {
  const base = requiredEnv("DRIVE_WEBHOOK_BASE_URL");
  if (!/^https?:\/\//.test(base)) {
    throw new Error(
      "Invalid deployment config: DRIVE_WEBHOOK_BASE_URL must be an absolute HTTP(S) URL.",
    );
  }
  return `${base.replace(/\/+$/, "")}/api/drive/webhook`;
}

/** Full Resend From identity for system-generated email. */
export function authEmailFrom(): string {
  return requiredEnv("AUTH_EMAIL_FROM");
}

/**
 * Mailbox address used with contextual parent-message display names.
 *
 * Authentication email can appropriately use a no-reply mailbox. Parent
 * messages, however, carry a per-thread Reply-To that accepts replies, so give
 * them a corresponding family-facing sender by default.
 */
export function parentMessageFromAddress(): string {
  const identity = authEmailFrom();
  const override =
    process.env.PARENT_MESSAGE_FROM ??
    process.env.AUTH_EMAIL_FROM_ADDRESS;
  if (override?.trim()) {
    const address = override.trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
      const name =
        process.env.PARENT_MESSAGE_FROM !== undefined
          ? "PARENT_MESSAGE_FROM"
          : "AUTH_EMAIL_FROM_ADDRESS";
      throw new Error(
        `Invalid deployment config: ${name} must be a mailbox address.`,
      );
    }
    return familyFacingAddress(address);
  }

  const trimmed = identity.trim();
  const address = (
    trimmed.match(/<\s*([^<>]+)\s*>\s*$/)?.[1] ?? trimmed
  ).trim();
  if (!/^[^\s@]+@[^\s@]+$/.test(address)) {
    throw new Error(
      "Invalid deployment config: AUTH_EMAIL_FROM must be an email address or a full identity such as Rabbithole <no-reply@example.org>.",
    );
  }
  return familyFacingAddress(address);
}
