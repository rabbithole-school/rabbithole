export {
  GOOGLE_DRIVE_COMMENT_CREATED_EVENT,
  GOOGLE_DRIVE_REPLY_CREATED_EVENT,
} from "./googleDocsEventsConstants";

type JsonRecord = Record<string, unknown>;

export type GoogleEventsPushEvent = {
  messageId: string;
  eventId: string;
  eventType: string;
  documentId?: string;
  commentId?: string;
  replyId?: string;
  mentionedEmails: string[];
  authorEmail?: string;
};

export type GoogleOidcVerifier = (
  jwt: string,
  audience: string,
  authorizedEmail: string,
) => Promise<boolean>;

let cachedJwks:
  | { expiresAt: number; keys: Array<JsonWebKey & { kid?: string }> }
  | undefined;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as JsonRecord)
    : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeJsonPart(value: string): JsonRecord {
  return JSON.parse(new TextDecoder().decode(base64UrlBytes(value))) as JsonRecord;
}

async function googleJwks(): Promise<
  Array<JsonWebKey & { kid?: string }>
> {
  const now = Date.now();
  if (cachedJwks && cachedJwks.expiresAt > now) return cachedJwks.keys;
  const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
  if (!response.ok) {
    throw new Error(`Google JWKS request failed (${response.status})`);
  }
  const body = (await response.json()) as {
    keys?: Array<JsonWebKey & { kid?: string }>;
  };
  if (!body.keys?.length) throw new Error("Google JWKS response had no keys");
  const maxAge = Number(
    response.headers
      .get("cache-control")
      ?.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1] ?? 3600,
  );
  cachedJwks = {
    keys: body.keys,
    expiresAt: now + Math.max(60, maxAge) * 1000,
  };
  return body.keys;
}

export async function verifyGoogleOidcJwt(
  jwt: string,
  audience: string,
  authorizedEmail: string,
): Promise<boolean> {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = decodeJsonPart(encodedHeader);
    const payload = decodeJsonPart(encodedPayload);
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;

    const key = (await googleJwks()).find((candidate) => candidate.kid === header.kid);
    if (!key) return false;
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const validSignature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      base64UrlBytes(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!validSignature) return false;

    const now = Math.floor(Date.now() / 1000);
    const aud = payload.aud;
    const audienceMatches =
      aud === audience ||
      (Array.isArray(aud) && aud.some((candidate) => candidate === audience));
    return (
      (payload.iss === "https://accounts.google.com" ||
        payload.iss === "accounts.google.com") &&
      audienceMatches &&
      typeof payload.exp === "number" &&
      payload.exp > now &&
      (typeof payload.iat !== "number" || payload.iat <= now + 300) &&
      (typeof payload.nbf !== "number" || payload.nbf <= now + 300) &&
      payload.email_verified === true &&
      payload.email === authorizedEmail
    );
  } catch {
    return false;
  }
}

function secretsMatch(actual: string | null, expected: string): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function authorizeGoogleEventsPush(
  request: Request,
  expectedSecret: string | undefined,
  authorizedEmail: string | undefined,
  verifyJwt: GoogleOidcVerifier = verifyGoogleOidcJwt,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!expectedSecret?.trim() || !authorizedEmail?.trim()) {
    return { ok: false, status: 503, message: "Google events not configured" };
  }
  const url = new URL(request.url);
  if (!secretsMatch(url.searchParams.get("secret"), expectedSecret)) {
    return { ok: false, status: 401, message: "unauthorized" };
  }
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (
    !match ||
    !(await verifyJwt(match[1], request.url, authorizedEmail.trim()))
  ) {
    return { ok: false, status: 401, message: "unauthorized" };
  }
  return { ok: true };
}

function decodePubSubData(value: unknown): JsonRecord {
  if (typeof value !== "string" || !value) {
    throw new Error("Pub/Sub message data is missing");
  }
  const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as JsonRecord;
}

export function parseGoogleEventsEnvelope(value: unknown): GoogleEventsPushEvent {
  const envelope = record(value);
  const message = record(envelope?.message);
  if (!envelope || !message) throw new Error("Invalid Pub/Sub envelope");
  const messageId = stringValue(message.messageId, message.message_id);
  if (!messageId) throw new Error("Pub/Sub message id is missing");

  const cloudEvent = decodePubSubData(message.data);
  const attributes = record(message.attributes);
  const eventData = record(cloudEvent.data) ?? cloudEvent;
  const comment = record(eventData.comment);
  const reply = record(eventData.reply);
  const resource = reply ?? comment;
  const mentioned = resource?.mentionedEmailAddresses ??
    resource?.mentioned_email_addresses;
  const author = record(resource?.author);

  return {
    messageId,
    eventId:
      stringValue(cloudEvent.id, attributes?.["ce-id"], messageId) ?? messageId,
    eventType:
      stringValue(
        cloudEvent.type,
        attributes?.["ce-type"],
        eventData.eventType,
        eventData.event_type,
      ) ?? "",
    documentId: stringValue(
      reply?.fileId,
      reply?.file_id,
      comment?.fileId,
      comment?.file_id,
    ),
    commentId: stringValue(reply?.commentId, reply?.comment_id, comment?.id),
    replyId: stringValue(reply?.id),
    mentionedEmails: Array.isArray(mentioned)
      ? mentioned.filter((email): email is string => typeof email === "string")
      : [],
    authorEmail: stringValue(author?.emailAddress, author?.email_address),
  };
}
