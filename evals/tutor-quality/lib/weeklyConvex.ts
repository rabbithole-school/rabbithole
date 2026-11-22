import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function runJson(fn: string, args: Record<string, unknown>): unknown {
  let raw: string;
  try {
    raw = execFileSync("npx", ["convex", "run", fn, JSON.stringify(args)], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      // Candidate pools contain full transcripts, not just the sampled rows.
      // Leave headroom above Convex's result limit, including pretty printing.
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // Node's child-process error contains stdout, stderr AND argv (including
    // evidence being persisted). None of those belong in a public CI log.
    const code = error instanceof Error && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code : "command_failed";
    const status = error instanceof Error && "status" in error &&
      typeof error.status === "number" ? `, exit ${error.status}` : "";
    throw new Error(`Weekly Convex call ${fn} failed (${code}${status}); output withheld.`);
  }
  try {
    return JSON.parse(raw.trim());
  } catch {
    // Preserve the CLI's historical leading-log tolerance without printing
    // the response if it is truncated or malformed.
    const start = raw.search(/^[\[{]/m);
    if (start !== -1) {
      try {
        return JSON.parse(raw.slice(start).trim());
      } catch {
        // Report only the operation, never its transcript-bearing output.
      }
    }
    throw new Error(`Weekly Convex call ${fn} returned invalid JSON; output withheld.`);
  }
}

export function fetchWeeklyCandidates<T>(
  fn: string,
  args: Record<string, unknown>,
): T[] {
  const result = runJson(fn, args);
  if (!Array.isArray(result)) {
    throw new Error(`Weekly Convex call ${fn} did not return a candidate array.`);
  }
  return result as T[];
}

export function persistWeeklySample(
  fn: string,
  args: Record<string, unknown>,
): { skipped: boolean } {
  const result = runJson(fn, args);
  if (
    typeof result !== "object" || result === null ||
    !("skipped" in result) || typeof result.skipped !== "boolean"
  ) {
    throw new Error(`Weekly Convex call ${fn} did not confirm persistence.`);
  }
  return { skipped: result.skipped };
}
