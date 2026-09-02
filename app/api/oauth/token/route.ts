// OAuth 2.1 token endpoint for the MCP connector.
//
// Both grants resolve to the stock @convex-dev/auth machinery — the MCP
// access token IS a normal Convex Auth JWT, so Convex queries called with
// it run as the real user and every existing gate applies:
//
//   - authorization_code → auth:signIn with the "mcp" credentials
//     provider (convex/auth.ts), which consumes the one-shot code from
//     mcpOauth.approve and verifies PKCE.
//   - refresh_token → auth:signIn { refreshToken } (the same call the
//     web client uses to refresh a session; tokens rotate).

import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import {
  oauthJson,
  parseFormOrJsonBody,
  corsPreflight,
} from "@/lib/oauthHttp";

const envUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!envUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL environment variable is required");
}
const CONVEX_CLOUD_URL: string = envUrl;

/** Convex Auth JWT validity (library default: 1 hour). */
const ACCESS_TOKEN_TTL_SECONDS = 3600;

function tokenError(error: string, description?: string): Response {
  return oauthJson(
    { error, ...(description ? { error_description: description } : {}) },
    400,
  );
}

function tokenSuccess(tokens: { token: string; refreshToken: string }): Response {
  return oauthJson({
    access_token: tokens.token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: tokens.refreshToken,
  });
}

/**
 * Record the freshly-minted MCP session in the management sidecar so the
 * user can see + revoke it (Account Details → "Connect Claude"). We
 * authenticate a throwaway client AS the new session, so the mutation reads
 * its own sessionId — there's no way to register a session you don't hold.
 * Pass `clientId` on the initial exchange; omit on refresh (just bumps
 * lastSeen). Best-effort: a tracking hiccup must never fail token issuance.
 */
async function recordSession(
  accessToken: string,
  clientId?: string,
): Promise<void> {
  try {
    const authed = new ConvexHttpClient(CONVEX_CLOUD_URL);
    authed.setAuth(accessToken);
    await authed.mutation(
      api.mcpOauth.recordMySession,
      clientId ? { clientId } : {},
    );
  } catch {
    // Non-fatal — the connection still works; it just won't appear in the list.
  }
}

export async function POST(request: Request) {
  let body: Record<string, string>;
  try {
    body = await parseFormOrJsonBody(request);
  } catch {
    return tokenError("invalid_request", "Unparseable body");
  }

  const convex = new ConvexHttpClient(CONVEX_CLOUD_URL);

  try {
    switch (body.grant_type) {
      case "authorization_code": {
        const { code, code_verifier, client_id, redirect_uri } = body;
        if (!code || !code_verifier || !client_id || !redirect_uri) {
          return tokenError(
            "invalid_request",
            "code, code_verifier, client_id and redirect_uri are required",
          );
        }
        const result = await convex.action(api.auth.signIn, {
          provider: "mcp",
          params: {
            code,
            codeVerifier: code_verifier,
            clientId: client_id,
            redirectUri: redirect_uri,
          },
        });
        if (!result.tokens) {
          return tokenError("invalid_grant", "Authorization code rejected");
        }
        await recordSession(result.tokens.token, client_id);
        return tokenSuccess(result.tokens);
      }

      case "refresh_token": {
        if (!body.refresh_token) {
          return tokenError("invalid_request", "refresh_token is required");
        }
        const result = await convex.action(api.auth.signIn, {
          refreshToken: body.refresh_token,
        });
        if (!result.tokens) {
          return tokenError("invalid_grant", "Refresh token rejected");
        }
        await recordSession(result.tokens.token);
        return tokenSuccess(result.tokens);
      }

      default:
        return tokenError("unsupported_grant_type");
    }
  } catch {
    // signIn throws on a consumed/expired/forged code or revoked session —
    // all map to invalid_grant (the client restarts the flow).
    return tokenError("invalid_grant", "Grant rejected");
  }
}

export async function OPTIONS() {
  return corsPreflight();
}
