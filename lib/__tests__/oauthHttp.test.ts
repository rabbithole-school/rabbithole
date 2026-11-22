import { describe, expect, test } from "vitest";
import {
  isReadOnlyMcpRequest,
  mcpResourcePath,
  MCP_PATH,
  MCP_READ_ONLY_PATH,
} from "../oauthHttp";

const at = (url: string) => new Request(url);

describe("isReadOnlyMcpRequest", () => {
  test("only the read-only connector path is read-only", () => {
    expect(isReadOnlyMcpRequest(at("https://rabbithole.school/api/mcp"))).toBe(false);
    expect(isReadOnlyMcpRequest(at("https://rabbithole.school/api/mcp/read"))).toBe(true);
    expect(isReadOnlyMcpRequest(at("https://rabbithole.school/api/mcp/read/"))).toBe(true);
  });

  test("a query string cannot make the full connector read-only, or the reverse", () => {
    expect(isReadOnlyMcpRequest(at("https://rabbithole.school/api/mcp?mode=read"))).toBe(false);
    expect(isReadOnlyMcpRequest(at("https://rabbithole.school/api/mcp/read?mode=full"))).toBe(true);
  });
});

describe("mcpResourcePath", () => {
  // A route handler sees the original path behind the next.config.js rewrite,
  // so the RFC 9728 lookup carries the connector path as its suffix.
  const lookup = (suffix: string) =>
    at(`https://rabbithole.school/.well-known/oauth-protected-resource${suffix}`);

  test("names the read-only connector for its own lookup and its own calls", () => {
    expect(mcpResourcePath(lookup("/api/mcp/read"))).toBe(MCP_READ_ONLY_PATH);
    expect(mcpResourcePath(at("https://rabbithole.school/api/mcp/read"))).toBe(MCP_READ_ONLY_PATH);
  });

  test("keeps the full connector for its own lookup, the bare lookup, and anything else", () => {
    expect(mcpResourcePath(lookup("/api/mcp"))).toBe(MCP_PATH);
    expect(mcpResourcePath(lookup(""))).toBe(MCP_PATH);
    expect(mcpResourcePath(lookup("/api/mcp/readwrite"))).toBe(MCP_PATH);
    expect(mcpResourcePath(at("https://rabbithole.school/api/mcp"))).toBe(MCP_PATH);
  });
});
