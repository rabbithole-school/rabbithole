// The read-only remote MCP connector: https://rabbithole.school/api/mcp/read
//
// Same handlers as ../route.ts, which offer only the tools that read
// (isReadOnlyToolName in convex/lib/scholarReadPolicy.ts) and refuse any other
// tool by name when the request path is /api/mcp/read. It is for coding
// sessions that debug against live data: the person signs in as themselves,
// so it sees what they can see, and it cannot change anything.

import { MCP_READ_ONLY_PATH } from "@/lib/oauthHttp";
import { POST as handle } from "../route";

export { GET, DELETE, OPTIONS } from "../route";

// Rebuild the request on the canonical read-only path before handing it on,
// so the mode can't depend on how this URL was spelled or routed (an encoded
// segment, a trailing slash, a future rewrite). Anything routed to this file
// is read-only.
export async function POST(request: Request): Promise<Response> {
  return handle(
    new Request(new URL(MCP_READ_ONLY_PATH, request.url), {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
    }),
  );
}
