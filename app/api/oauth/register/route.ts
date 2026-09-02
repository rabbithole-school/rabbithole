// RFC 7591 dynamic client registration for the MCP connector. Open
// (unauthenticated) by spec — a registered client grants nothing by
// itself; data access requires a real user consenting on /oauth/authorize.
// State lives in Convex (mcpOauthClients); validation (https-or-loopback
// redirect URIs, caps) is in convex/mcpOauth.ts.

import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import { oauthJson, corsPreflight } from "@/lib/oauthHttp";

const envUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!envUrl) {
  throw new Error("NEXT_PUBLIC_CONVEX_URL environment variable is required");
}
const CONVEX_CLOUD_URL: string = envUrl;

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return oauthJson(
      { error: "invalid_client_metadata", error_description: "Body must be JSON" },
      400,
    );
  }

  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    redirectUris.some((u) => typeof u !== "string")
  ) {
    return oauthJson(
      {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris must be a non-empty array of strings",
      },
      400,
    );
  }
  const clientName =
    typeof body.client_name === "string" ? body.client_name : undefined;

  const convex = new ConvexHttpClient(CONVEX_CLOUD_URL);
  try {
    const { clientId } = await convex.mutation(api.mcpOauth.registerClient, {
      clientName,
      redirectUris: redirectUris as string[],
    });
    return oauthJson(
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...(clientName ? { client_name: clientName } : {}),
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Registration failed";
    return oauthJson(
      { error: "invalid_client_metadata", error_description: message },
      400,
    );
  }
}

export async function OPTIONS() {
  return corsPreflight();
}
