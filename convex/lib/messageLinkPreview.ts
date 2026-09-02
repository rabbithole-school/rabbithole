"use node";

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getPreviewFromContent } from "link-preview-js/node";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";

const FETCH_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REDIRECTS = 2;
const MAX_TITLE_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 500;

export type MessageLinkPreview = {
  url: string;
  hostname: string;
  title: string;
  description: string | null;
};

type ResolvedAddress = { address: string; family: 4 | 6 };
type PreviewFetch = typeof undiciFetch;

export function validatePreviewUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "443") ||
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("URL is not eligible for a preview");
  }
  return url;
}

function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
    ? octets
    : null;
}

function parseIPv6(address: string): number[] | null {
  const value = address.toLowerCase().split("%")[0];
  const ipv4 = /(.+:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  const normalized = ipv4
    ? (() => {
        const octets = parseIPv4(ipv4[2]);
        if (!octets) return null;
        return `${ipv4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
      })()
    : value;
  if (!normalized) return null;

  const pieces = normalized.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return null;
  const hextets = [...left, ...Array(missing).fill("0"), ...right].map((part) =>
    /^[\da-f]{1,4}$/.test(part) ? Number.parseInt(part, 16) : Number.NaN,
  );
  return hextets.some(Number.isNaN) ? null : hextets;
}

/**
 * Reject every non-public address class before opening a socket. The v5 Node
 * entrypoint can validate and pin connections too, but its high-level fetch has
 * no response-size cap. We use its Node parser after this equivalent pinned,
 * size-bound fetch so neither safety property is weakened.
 */
export function isPublicInternetAddress(address: string): boolean {
  const v4 = parseIPv4(address);
  if (v4) {
    const [a, b, c] = v4;
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const v6 = parseIPv6(address);
  if (!v6) return false;
  const mappedV4 =
    v6.slice(0, 5).every((part) => part === 0) &&
    (v6[5] === 0 || v6[5] === 0xffff)
      ? `${v6[6] >> 8}.${v6[6] & 255}.${v6[7] >> 8}.${v6[7] & 255}`
      : null;
  const nat64EmbedsV4 =
    (v6[0] === 0x64 &&
      v6[1] === 0xff9b &&
      ((v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0) ||
        v6[2] === 1));
  const nat64V4 = nat64EmbedsV4
    ? `${v6[6] >> 8}.${v6[6] & 255}.${v6[7] >> 8}.${v6[7] & 255}`
    : null;
  const sixToFourV4 =
    v6[0] === 0x2002
      ? `${v6[1] >> 8}.${v6[1] & 255}.${v6[2] >> 8}.${v6[2] & 255}`
      : null;
  return !(
    v6.every((part) => part === 0) ||
    (v6.slice(0, 7).every((part) => part === 0) && v6[7] === 1) ||
    (v6[0] & 0xfe00) === 0xfc00 ||
    (v6[0] & 0xffc0) === 0xfe80 ||
    (v6[0] & 0xff00) === 0xff00 ||
    (v6[0] === 0x2001 && v6[1] === 0x0db8) ||
    (mappedV4 !== null && !isPublicInternetAddress(mappedV4)) ||
    (nat64V4 !== null && !isPublicInternetAddress(nat64V4)) ||
    (sixToFourV4 !== null && !isPublicInternetAddress(sixToFourV4))
  );
}

async function resolvePublicHost(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) =>
        (address.family !== 4 && address.family !== 6) ||
        !isPublicInternetAddress(address.address),
    )
  ) {
    throw new Error("Host did not resolve to a public address");
  }
  return addresses as ResolvedAddress[];
}

function truncateText(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, limit) : null;
}

async function readBoundedBody(response: UndiciResponse): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = MAX_RESPONSE_BYTES - size;
      chunks.push(value.slice(0, remaining));
      size += Math.min(value.byteLength, remaining);
      if (value.byteLength >= remaining) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function isCanonicalRedirect(source: URL, destination: URL): boolean {
  const withoutWww = (hostname: string) => hostname.toLowerCase().replace(/^www\./, "");
  return (
    source.hostname.toLowerCase() === destination.hostname.toLowerCase() ||
    withoutWww(source.hostname) === withoutWww(destination.hostname)
  );
}

function isAuthenticationUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname.startsWith("accounts.") ||
    hostname.startsWith("login.") ||
    /\/(?:login|sign-in|signin|oauth|authorize)(?:\/|$)/i.test(url.pathname)
  );
}

function redirectTarget(response: UndiciResponse, source: URL): URL {
  const location = response.headers.get("location");
  if (!location) throw new Error("Preview redirect was missing a location");

  const destination = validatePreviewUrl(new URL(location, source).toString());
  if (!isCanonicalRedirect(source, destination) || isAuthenticationUrl(destination)) {
    throw new Error("Preview redirect target is not eligible");
  }
  return destination;
}

async function fetchPinned(
  url: URL,
  deps: {
    lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
    fetch?: PreviewFetch;
  },
): Promise<{ response: UndiciResponse; dispatcher: Agent }> {
  const addresses = await (deps.lookup ?? resolvePublicHost)(url.hostname);
  if (addresses.length === 0 || addresses.some((address) => !isPublicInternetAddress(address.address))) {
    throw new Error("Host did not resolve to a public address");
  }
  const pinned = addresses[0];
  const dispatcher = new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (hostname.toLowerCase().replace(/\.$/, "") !== url.hostname.toLowerCase()) {
          callback(
            new Error("Preview hostname changed after validation"),
            "",
            0,
          );
          return;
        }
        if (options.all) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
    },
  });

  try {
    const response = await (deps.fetch ?? undiciFetch)(url, {
      dispatcher,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "RabbitholeLinkPreview/1.0",
      },
    });
    return { response, dispatcher };
  } catch (error) {
    await dispatcher.close().catch(() => dispatcher.destroy());
    throw error;
  }
}

export async function fetchMessageLinkPreview(
  value: string,
  deps: {
    lookup?: (hostname: string) => Promise<ResolvedAddress[]>;
    fetch?: PreviewFetch;
  } = {},
): Promise<MessageLinkPreview | null> {
  let url = validatePreviewUrl(value);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const { response, dispatcher } = await fetchPinned(url, deps);
    try {
      if (response.status >= 300 && response.status < 400) {
        if (redirects === MAX_REDIRECTS) {
          throw new Error("Preview exceeded its redirect limit");
        }
        const destination = redirectTarget(response, url);
        await response.body?.cancel();
        url = destination;
        continue;
      }
      if (!response.ok) throw new Error(`Preview request failed (${response.status})`);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/html")) {
        throw new Error("Preview response was not HTML");
      }

      const parsed = await getPreviewFromContent({
        url: url.toString(),
        data: await readBoundedBody(response),
        headers: { "content-type": contentType },
      });
      const title = truncateText("title" in parsed ? parsed.title : null, MAX_TITLE_LENGTH);
      if (!title) return null;
      return {
        url: url.toString(),
        hostname: url.hostname,
        title,
        description: truncateText(
          "description" in parsed ? parsed.description : null,
          MAX_DESCRIPTION_LENGTH,
        ),
      };
    } finally {
      await dispatcher.close().catch(() => dispatcher.destroy());
    }
  }
  return null;
}
