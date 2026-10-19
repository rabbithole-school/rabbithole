// Server-only helpers for /tutor-key: taking the tutor's Anthropic key from
// the web app on the public local runner (`pnpm local:setup`), TRA-536.
//
// The key ends up as the local Convex backend's ANTHROPIC_API_KEY, set the way
// the runner sets every other variable: the Convex CLI, run from this checkout
// against the anonymous local backend (local/setup.sh). The key goes to the
// CLI on stdin, never on its command line, and is never logged.
//
// Every entry point refuses unless all of these hold:
//   1. this Next server runs against an anonymous local Convex backend on
//      loopback (`.env.local` from local/setup.sh), with no deploy key;
//   2. that backend reports itself as the local runner
//      (convex/tutorKey.ts → lib/deploymentSafety.isLocalRunnerDeployment);
//   3. the request arrived on a loopback Host, and a POST carries a matching
//      same-origin Origin (no other site, and no DNS-rebound name, can post).
import { spawn } from "node:child_process";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

type Env = Record<string, string | undefined>;

function loopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

/** Check 1: this web server is wired to the local runner's backend. */
export function webServerOnLocalRunner(env: Env = process.env): boolean {
  return (
    (env.CONVEX_DEPLOYMENT ?? "").startsWith("anonymous:") &&
    loopbackUrl(env.NEXT_PUBLIC_CONVEX_URL) &&
    !env.CONVEX_DEPLOY_KEY
  );
}

/** Check 3a: the request was addressed to this computer's loopback name. */
export function loopbackHost(headers: Headers): boolean {
  const host = headers.get("host");
  return host ? loopbackUrl(`http://${host}`) : false;
}

/** Check 3b: a POST came from this app's own page, not another site. */
export function sameOriginPost(headers: Headers): boolean {
  const host = headers.get("host");
  const origin = headers.get("origin");
  if (!host || !origin) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  const fetchSite = headers.get("sec-fetch-site");
  return (
    originUrl.protocol === "http:" &&
    originUrl.host === host &&
    (fetchSite === null || fetchSite === "same-origin")
  );
}

export type LocalRunnerKeySetup =
  | { available: false }
  | { available: true };

/** Checks 1 and 2: may this deployment take the key from the app? */
export async function localRunnerKeySetup(
  env: Env = process.env,
): Promise<LocalRunnerKeySetup> {
  if (!webServerOnLocalRunner(env)) return { available: false };
  try {
    const convex = new ConvexHttpClient(env.NEXT_PUBLIC_CONVEX_URL!);
    return await convex.query(api.tutorKey.localRunnerKeySetup, {});
  } catch {
    return { available: false };
  }
}

/** A plausible API key: one token of key characters, nothing that could
 *  break out of a single stdin line. */
export function plausibleAnthropicKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{20,300}$/.test(key);
}

export type KeyCheck = "ok" | "rejected" | "unreachable";

/** Ask Anthropic whether the key works: list models, the cheapest call. */
export async function checkAnthropicKey(
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await fetchImpl("https://api.anthropic.com/v1/models?limit=1", {
      method: "GET",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return "unreachable";
  }
  if (res.ok) return "ok";
  if (res.status === 401 || res.status === 403) return "rejected";
  return "unreachable";
}

/** Store the key as the local backend's ANTHROPIC_API_KEY. */
export function saveKeyToLocalBackend(
  key: string,
  env: Env = process.env,
): Promise<boolean> {
  const childEnv: Env = { ...env, CONVEX_AGENT_MODE: "anonymous" };
  delete childEnv.CONVEX_DEPLOY_KEY;
  delete childEnv.ANTHROPIC_API_KEY;
  return new Promise((resolve) => {
    const child = spawn(
      join(process.cwd(), "node_modules", ".bin", "convex"),
      ["env", "set", "ANTHROPIC_API_KEY"],
      {
        cwd: process.cwd(),
        env: childEnv as NodeJS.ProcessEnv,
        // The CLI's output is discarded unread: nothing of it is logged.
        stdio: ["pipe", "ignore", "ignore"],
        timeout: 60_000,
      },
    );
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.end(key);
  });
}
