// RFC 9728 protected-resource metadata for the MCP connector.
// Served at /.well-known/oauth-protected-resource[/api/mcp] via the
// rewrites in next.config.js. The 401 from /api/mcp points clients here;
// this points them at the authorization server (same origin).

import {
  requestOrigin,
  oauthJson,
  corsPreflight,
} from "@/lib/oauthHttp";

export async function GET(request: Request) {
  const origin = requestOrigin(request);
  return oauthJson({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  });
}

export async function OPTIONS() {
  return corsPreflight();
}
