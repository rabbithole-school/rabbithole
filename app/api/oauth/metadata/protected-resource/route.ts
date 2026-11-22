// RFC 9728 protected-resource metadata for the MCP connector.
// Served at /.well-known/oauth-protected-resource[/api/mcp | /api/mcp/read]
// via the rewrites in next.config.js. The 401 from either connector URL
// points clients here; this points them at the authorization server (same
// origin). `resource` must name the URL the client connected to (RFC 9728
// §3.3), so the read-only connector gets its own answer.

import {
  requestOrigin,
  oauthJson,
  corsPreflight,
  mcpResourcePath,
} from "@/lib/oauthHttp";

export async function GET(request: Request) {
  const origin = requestOrigin(request);
  return oauthJson({
    resource: `${origin}${mcpResourcePath(request)}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
  });
}

export async function OPTIONS() {
  return corsPreflight();
}
