// Shared helpers for the OAuth endpoints that front the MCP connector
// (app/api/oauth/* and app/api/mcp). Server-side only.

/**
 * The externally visible origin of THIS deployment, honoring proxy
 * headers (Vercel sets x-forwarded-*). Used to build issuer/endpoint
 * URLs in the OAuth metadata — they must match what the client can
 * actually reach.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const proto =
    request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    url.host;
  return `${proto}://${host}`;
}

/**
 * Permissive CORS for the OAuth metadata/registration/token endpoints —
 * browser-based MCP clients (e.g. the MCP inspector) fetch these
 * cross-origin. They carry no cookies; bearer auth only.
 */
export const OAUTH_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
};

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

/** JSON response with the no-store caching OAuth requires (RFC 6749 §5.1). */
export function oauthJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      ...OAUTH_CORS_HEADERS,
    },
  });
}

/**
 * OAuth clients POST the token endpoint as application/x-www-form-urlencoded
 * (RFC 6749 §4.1.3); some toolings send JSON. Accept both.
 */
export async function parseFormOrJsonBody(
  request: Request,
): Promise<Record<string, string>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const raw = (await request.json()) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  const text = await request.text();
  return Object.fromEntries(new URLSearchParams(text));
}
