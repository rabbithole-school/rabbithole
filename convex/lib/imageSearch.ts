/**
 * Web image search + safe image download, shared by every surface that puts a
 * real photograph or diagram in front of a scholar.
 *
 * This is the provider and transport layer only — Brave Image Search
 * (safesearch=strict), the signed pick token, and the SSRF-guarded download.
 * It deliberately knows nothing about *why* an image was wanted, so the two
 * callers can differ in everything above it:
 *
 *   - `slidesImageSearch.ts` — a scholar types a query, browses a grid, and
 *     taps one; the pick lands as a slide asset.
 *   - `lib/tutorSessionTools.ts` (`search_image`) — the tutor asks for one
 *     image mid-conversation and the top result lands on a tool row.
 *
 * Extracted verbatim from `slidesImageSearch.ts` (design:
 * review/slides-web-image-search-plan.html) when the tutor gained its own
 * search tool. Every guard below was written for the slides path and is load
 * bearing for both: safesearch, the signed token that stops this being an
 * arbitrary-URL fetch proxy, the private-network refusal, the redirect
 * refusal, and the streaming byte ceiling.
 */
import { readStateSecret, signState, verifyState } from "./google";
import type { WebImageSearchResult } from "../../shared/slidesScene";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** How long a pick token stays valid after its search. Long enough for a kid to
 * browse the grid and choose, short enough that a leaked token doesn't linger. */
const PICK_TOKEN_TTL_MS = 60 * 60 * 1000;
const BRAVE_IMAGE_SEARCH_URL =
  "https://api.search.brave.com/res/v1/images/search";

/** The URLs a pick is allowed to fetch, sealed into the pickToken at search time. */
export type PickTokenPayload = { imageUrl: string; proxyUrl?: string };

export async function issuePickToken(payload: PickTokenPayload): Promise<string> {
  return signState(payload, readStateSecret());
}

export async function verifyPickToken(
  token: string,
): Promise<PickTokenPayload | null> {
  const parsed = await verifyState<PickTokenPayload & { iat?: number }>(
    token,
    readStateSecret(),
  );
  if (!parsed) return null;
  if (typeof parsed.iat === "number" && Date.now() - parsed.iat > PICK_TOKEN_TTL_MS) {
    return null;
  }
  const imageUrl = httpUrl(parsed.imageUrl);
  if (!imageUrl) return null;
  return { imageUrl, proxyUrl: httpUrl(parsed.proxyUrl) };
}

/**
 * SSRF guard: refuse URLs whose host is an IP literal in a private / loopback /
 * link-local range (the cloud-metadata 169.254.169.254 endpoint included).
 * Hostnames that resolve to internal IPs are additionally defended by
 * redirect:"manual" + the brave-proxied fallback below — we never follow a hop
 * we didn't validate.
 */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6 loopback / unique-local / link-local.
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true; // private / loopback / this-host
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  return false;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? value as UnknownRecord
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function httpUrl(value: unknown): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function sourceHost(value: unknown): string | undefined {
  const url = httpUrl(value);
  if (!url) return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

export async function mapBraveResults(
  body: unknown,
): Promise<WebImageSearchResult[]> {
  const results = asRecord(body)?.results;
  if (!Array.isArray(results)) return [];

  const mapped = await Promise.all(
    results.map(async (rawItem, index): Promise<WebImageSearchResult | null> => {
      const item = asRecord(rawItem);
      const thumbnail = asRecord(item?.thumbnail);
      const properties = asRecord(item?.properties);
      const thumbnailUrl = httpUrl(thumbnail?.src);
      const imageUrl = httpUrl(properties?.url) ?? thumbnailUrl;
      if (!thumbnailUrl || !imageUrl) return null;

      // Seal the downloadable URLs into a signed token; the pick path fetches
      // only what it can verify came from here, never a caller-chosen URL.
      const pickToken = await issuePickToken({ imageUrl, proxyUrl: thumbnailUrl });

      return {
        resultId: `brave-${index}`,
        thumbnailUrl,
        imageUrl,
        proxyUrl: thumbnailUrl,
        width: positiveNumber(item?.width) ?? positiveNumber(properties?.width),
        height: positiveNumber(item?.height) ?? positiveNumber(properties?.height),
        title: nonEmptyString(item?.title),
        sourceHost: sourceHost(item?.url),
        pickToken,
      };
    }),
  );
  return mapped.filter((r): r is WebImageSearchResult => r !== null);
}

export async function fetchWithTimeout(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read a response body with a running byte ceiling, so a body with no (or a
 * lying) Content-Length cannot buffer multiple GB into the isolate before the
 * size check — the OOM vector a header-only pre-check misses.
 */
async function readCappedBytes(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error("Downloaded image is too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Downloaded image has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Downloaded image is too large");
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function downloadImage(url: string): Promise<Blob> {
  const safeUrl = httpUrl(url);
  if (!safeUrl) throw new Error("Unsupported image URL");
  if (isBlockedHost(new URL(safeUrl).hostname)) {
    throw new Error("Refusing to fetch a private-network address");
  }

  // redirect:"manual" so a public URL that 302s to an internal host is NOT
  // followed to an unvalidated hop; a redirect surfaces as a non-ok status and
  // the caller falls back to the brave-proxied URL (always brave-hosted).
  const response = await fetchWithTimeout(safeUrl, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("Image URL redirected; refusing to follow");
  }
  if (!response.ok) throw new Error(`Image download failed (${response.status})`);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("Downloaded content is not an image");
  }

  const bytes = await readCappedBytes(response);
  if (bytes.byteLength === 0) {
    throw new Error("Downloaded image has an invalid size");
  }

  return new Blob([bytes as BlobPart], {
    type: contentType.split(";", 1)[0]?.trim(),
  });
}

export async function downloadWithProxyFallback(
  imageUrl: string,
  proxyUrl?: string,
): Promise<Blob> {
  try {
    return await downloadImage(imageUrl);
  } catch (originalError) {
    if (!proxyUrl || proxyUrl === imageUrl) throw originalError;
    return await downloadImage(proxyUrl);
  }
}

/**
 * Image hosts that serve watermarked, copyright-encumbered previews.
 *
 * Not a safety list — a quality and rights one. These sites rank well for
 * exactly the queries a tutor asks (clean labeled scientific diagrams), and
 * what they return is a preview with a vendor watermark stamped across it.
 * Storing one puts someone's licensed stock art in a child's transcript, and
 * showing one teaches a nine-year-old that a watermark is part of the diagram.
 *
 * This is applied by callers that pick BLIND (the tutor's search_image, which
 * takes the first result that downloads). The slides picker deliberately does
 * NOT filter: a human is looking at the grid and can see a watermark for
 * themselves, so the choice is theirs to make.
 */
const WATERMARKED_STOCK_HOSTS = [
  "dreamstime.com",
  "shutterstock.com",
  "istockphoto.com",
  "gettyimages.com",
  "alamy.com",
  "123rf.com",
  "depositphotos.com",
  "vectorstock.com",
  "canstockphoto.com",
  "stockadobe.com",
  "adobestock.com",
];

/** True when a result's host is a watermarked-stock vendor (see the list). */
export function isWatermarkedStockHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalized = host.trim().toLowerCase().replace(/^www\./, "");
  return WATERMARKED_STOCK_HOSTS.some(
    (stock) => normalized === stock || normalized.endsWith(`.${stock}`),
  );
}

/**
 * The window the per-user image-search budget is counted over.
 *
 * Lives here rather than in either caller because the budget itself is shared:
 * the slides deck and the tutor's search_image tool draw from one hourly
 * allowance (`artifacts.claimSlideImageSearchAttempt`), since what is being
 * limited is "this person made the server fetch a picture from the open web",
 * not which surface asked. Two copies of the window would let the two surfaces
 * silently disagree about how long an hour is.
 */
export const IMAGE_SEARCH_WINDOW_MS = 60 * 60 * 1000;

export type BraveSearchOutcome =  | { status: "results"; results: WebImageSearchResult[] }
  | { status: "unavailable" }
  | { status: "error" };

/**
 * One Brave Image Search call with safesearch forced on.
 *
 * `count` defaults high because the slides grid filters by shape client-side
 * (Brave has no server-side shape param) and needs material for the rarer
 * shapes. The tutor tool asks for far fewer, since it takes the top hit.
 */
export async function braveImageSearch(
  query: string,
  opts?: { count?: number },
): Promise<BraveSearchOutcome> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) return { status: "unavailable" };

  try {
    const url = new URL(BRAVE_IMAGE_SEARCH_URL);
    url.searchParams.set("q", query);
    url.searchParams.set("safesearch", "strict");
    url.searchParams.set("count", String(opts?.count ?? 100));
    const response = await fetchWithTimeout(url.toString(), {
      method: "GET",
      headers: {
        "X-Subscription-Token": apiKey,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      console.error("[imageSearch] Brave image search failed:", response.status);
      return { status: "error" };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      console.error("[imageSearch] Brave returned invalid JSON:", error);
      return { status: "error" };
    }
    return { status: "results", results: await mapBraveResults(body) };
  } catch (error) {
    console.error("[imageSearch] Brave image search failed:", error);
    return { status: "error" };
  }
}
