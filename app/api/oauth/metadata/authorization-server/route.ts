// RFC 8414 authorization-server metadata for the MCP connector.
// Served at /.well-known/oauth-authorization-server (and any path-inserted
// variant) via the rewrites in next.config.js — MCP clients discover the
// authorize/token/registration endpoints here after the 401 from /api/mcp.

import {
  requestOrigin,
  oauthJson,
  corsPreflight,
} from "@/lib/oauthHttp";

export async function GET(request: Request) {
  const origin = requestOrigin(request);
  return oauthJson({
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
  });
}

export async function OPTIONS() {
  return corsPreflight();
}
