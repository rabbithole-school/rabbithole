// The Workshop Code Explorer — SCHOLAR-facing tools that let the reflection
// chat (/meta-stream) read Rabbithole's OWN, PUBLIC code and make it
// intelligible to a coding-curious kid. See CODE_EXPLORER_SPEC.md.
//
// QB architecture decisions, implemented here:
//   - Fetch is UNAUTHENTICATED + public-only. Rabbithole's repo is public, so
//     all tools fetch from it with NO credential — nothing to leak into a kid
//     surface, and it works on every deployment (no App token / PAT):
//       * read_rabbithole_file  → raw.githubusercontent.com/<repo>/master/<path>
//       * list_rabbithole_files → GitHub's public git-trees API (recursive) —
//         the DISCOVERY primitive (the public /search/code API needs a sign-in,
//         so it 401s unauthenticated; git-trees works and is ~60 req/hr).
//       * search_rabbithole_code → GitHub's public /search/code REST API.
//   - Read hygiene (public data, but keep the chat healthy): normalize paths;
//     reject anything outside the repo (`..`, absolute, URL schemes, backslashes);
//     text-y extensions only; truncate big files with a clear "…truncated"
//     marker; a friendly 404.
//   - On a rate-limit / unavailable response NEVER dump an error — return a
//     warm, kid-safe line and let the model pivot to reading a specific file.
//
// Gating: the WHOLE feature is behind the WORKSHOP_CODE_EXPLORER_ENABLED
// deployment env var (absent = OFF). `isCodeExplorerEnabled()` gates BOTH the
// tools wiring in http.ts AND the prompt section in metaPrompts.ts, so the two
// can never drift. Default off everywhere — this ships dark.
//
// NEVER register these on a staff aide surface (assembleCurriculumTools) — they
// are scholar-facing and used ONLY by /meta-stream. Staff have their own repo
// tools (lib/introspectionTools.ts), which are credentialed and teacher-gated.
//
// The pure helpers (path validation, extension gate, truncation, error mapping,
// URL building) are split out and exported so they're unit-testable with no
// network, per .claude/rules/rabbithole-test-strategy.md. The two fetch helpers
// use ONLY global `fetch` (no ctx, no Convex query) so the eval harness can
// import and run them unchanged — no forked fetch logic anywhere.

import type { AideEmit } from "./aideStream";

// ─── Flag ────────────────────────────────────────────────────────────────
/**
 * The Code Explorer kill-switch. Absent/garbage → OFF (ships dark). Accepts the
 * same truthy spellings as isIntrospectionEnabled so a deployment can flip it
 * with `npx convex env set WORKSHOP_CODE_EXPLORER_ENABLED true`.
 */
export function isCodeExplorerEnabled(): boolean {
  const raw = (process.env.WORKSHOP_CODE_EXPLORER_ENABLED ?? "")
    .trim()
    .toLowerCase();
  return raw === "true" || raw === "on" || raw === "1";
}

/**
 * Cost-sanity cap on the /meta-stream tool loop (spec §"Cost sanity":
 * "a small iteration cap (≤4 tool rounds per turn)"). `max_iterations` counts
 * API requests in the toolRunner loop; capping at 5 leaves room for up to ~4
 * rounds of tool use followed by a final synthesis turn, so a curious back-and-
 * forth can't run away on cost. Only applied when the flag is on.
 */
export const CODE_EXPLORER_MAX_ITERATIONS = 5;

/**
 * The /meta-stream loop knobs, derived from the flag. Pure so a test can prove
 * the OFF path is a behavioral no-op — no tools wired and no iteration cap, i.e.
 * exactly today's tool-less behavior (spec §5 "/meta-stream validation helper:
 * flag off → no tools"). ON → wire the Code Explorer tools + the cost cap.
 */
export function codeExplorerLoopConfig(enabled: boolean): {
  withTools: boolean;
  maxIterations: number | undefined;
} {
  return enabled
    ? { withTools: true, maxIterations: CODE_EXPLORER_MAX_ITERATIONS }
    : { withTools: false, maxIterations: undefined };
}

// ─── Constants ───────────────────────────────────────────────────────────
/** The public repo the tools read. No credential is ever attached. */
export let CODE_EXPLORER_REPO = "rabbithole-school/rabbithole";
/** The branch the raw-file reads pin to. */
export const CODE_EXPLORER_REF = "master";
const RAW_BASE = `https://raw.githubusercontent.com/${CODE_EXPLORER_REPO}/${CODE_EXPLORER_REF}/`;

/** Roughly 48KB. Bigger files come back truncated with a clear marker so a
 * giant file can't blow up the chat's context (spec: "~48KB"). Measured in
 * characters — close enough to bytes for the source we read, and deterministic
 * for the unit test. */
export const MAX_FILE_CHARS = 48 * 1024;

/** Sane cap on a path length so a pathological input can't be huge. */
const MAX_PATH_LENGTH = 400;

/** Max file paths returned by list_rabbithole_files in one call. The repo tree
 * is ~1.8k entries; capping the listing keeps a single tool result small and
 * nudges the model to narrow with a prefix rather than swallow the whole tree.
 */
export const MAX_LIST_ENTRIES = 200;

/** Only text-y source files (spec's allow-list). Anything else is refused — no
 * binaries, images, or lockfiles dumped into a kid chat. */
export const CODE_EXPLORER_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "mjs",
  "json",
  "md",
  "yml",
  "css",
  "sh",
  "html",
]);

// ─── Kid-facing messages (warm, plain, never an error dump) ────────────────
/** 403 (secondary rate limit) / 429 — transient; invite a retry. */
export const CODE_EXPLORER_RATE_LIMIT_MESSAGE =
  "The code library needs a minute to catch its breath — let's try that again in a moment.";

/** Search unavailable for a NON rate-limit reason (e.g. the public search API
 * needs a sign-in). Pivots the model to the file reader, which always works. */
export const CODE_EXPLORER_SEARCH_UNAVAILABLE_MESSAGE =
  "I can't search the whole code library right now — but if you tell me which part you're curious about, I can open the actual file and we can look at it together.";

/** A missing file — offer to search instead. */
export function codeExplorerNotFoundMessage(path: string): string {
  return `I couldn't find a file at "${path}" in Rabbithole's code — want me to search for it instead?`;
}

/** A path that points outside the repo / isn't a readable source file. */
export function codeExplorerRejectedPathMessage(rawPath: string): string {
  return `"${rawPath}" doesn't look like a file inside Rabbithole's code. I can only open text source files from the public repo — try a repo path like "convex/schema.ts".`;
}

// ─── Pure: path validation + extension gate ────────────────────────────────
export type RepoPathCheck =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** The final segment's lowercase extension, or "" when there is none. */
export function fileExtension(path: string): string {
  const seg = path.split("/").pop() ?? "";
  const dot = seg.lastIndexOf(".");
  if (dot <= 0) return ""; // no dot, or a dotfile like ".gitignore"
  return seg.slice(dot + 1).toLowerCase();
}

/** True when a path ends in one of the allowed text-y extensions. */
export function hasAllowedExtension(path: string): boolean {
  return CODE_EXPLORER_TEXT_EXTENSIONS.has(fileExtension(path));
}

/**
 * Normalize + validate a repo-relative path. Rejects (public data, but keep the
 * chat healthy):
 *   - empty / over-long input
 *   - URL schemes ("http://", "file:", …) and protocol-relative ("//host")
 *   - backslashes (Windows separators)
 *   - absolute paths (leading "/")
 *   - traversal (any ".." segment)
 *   - non-text extensions (must be in the allow-list)
 * Drops "./" and redundant "." segments. Returns the clean repo-relative path.
 */
export function validateRepoPath(rawPath: string): RepoPathCheck {
  if (typeof rawPath !== "string") {
    return { ok: false, reason: "not a string" };
  }
  const trimmed = rawPath.trim();
  if (!trimmed) return { ok: false, reason: "empty path" };
  if (trimmed.length > MAX_PATH_LENGTH) return { ok: false, reason: "path too long" };
  if (trimmed.includes("\\")) return { ok: false, reason: "backslash not allowed" };
  // A URL scheme like "https:" / "file:" (also catches Windows drive "C:").
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return { ok: false, reason: "url scheme not allowed" };
  }
  if (trimmed.includes("://")) return { ok: false, reason: "url not allowed" };
  if (trimmed.startsWith("/")) return { ok: false, reason: "absolute path not allowed" };

  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    return { ok: false, reason: "path traversal not allowed" };
  }
  if (segments.length === 0) return { ok: false, reason: "empty path" };

  const path = segments.join("/");
  if (!hasAllowedExtension(path)) {
    return { ok: false, reason: "not a readable text source file" };
  }
  return { ok: true, path };
}

// ─── Pure: URL builders ────────────────────────────────────────────────────
/** Raw URL for a validated repo path (public, unauthenticated). */
export function rawUrlForPath(path: string): string {
  return RAW_BASE + path.split("/").map(encodeURIComponent).join("/");
}

/** Public code-search URL scoped to the repo (unauthenticated). */
export function codeSearchUrl(query: string): string {
  const q = `${query} repo:${CODE_EXPLORER_REPO}`;
  return `https://api.github.com/search/code?q=${encodeURIComponent(q)}&per_page=8`;
}

/** Public git-trees URL for the repo at `master`, recursive (unauthenticated).
 * Lists every path in the tree in one call — the discovery primitive that
 * search can't be (the public /search/code endpoint needs a sign-in). */
export function treeUrl(): string {
  return `https://api.github.com/repos/${CODE_EXPLORER_REPO}/git/trees/${CODE_EXPLORER_REF}?recursive=1`;
}

/**
 * Normalize an optional listing prefix the same way validateRepoPath cleans a
 * file path — but a prefix is a FOLDER-ish string, so no extension gate and a
 * trailing slash is fine. Returns "" for an absent/empty prefix (list
 * everything), or null when the prefix is unsafe (traversal / absolute / scheme
 * / backslash) so the caller can refuse.
 */
export function normalizeListPrefix(rawPrefix: string | undefined): string | null {
  if (rawPrefix === undefined || rawPrefix === null) return "";
  if (typeof rawPrefix !== "string") return null;
  const trimmed = rawPrefix.trim();
  if (!trimmed) return "";
  if (trimmed.length > MAX_PATH_LENGTH) return null;
  if (trimmed.includes("\\")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return null;
  if (trimmed.includes("://")) return null;
  if (trimmed.startsWith("/")) return null;
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  return segments.join("/");
}

/** One raw git-tree entry (only the fields we read). */
export interface TreeEntry {
  path?: string;
  type?: string;
}

/**
 * Pure filter behind list_rabbithole_files: keep text-y source FILES (blobs)
 * under the optional prefix, sorted, capped at MAX_LIST_ENTRIES. `capped` tells
 * the caller to add a "narrow the prefix" hint. Directories and non-source
 * files (binaries, lockfiles, dotfiles) are dropped.
 */
export function filterTreePaths(
  entries: TreeEntry[],
  prefix: string,
  max: number = MAX_LIST_ENTRIES,
): { paths: string[]; capped: boolean; total: number } {
  const matched = entries
    .filter((e) => e.type === "blob" && typeof e.path === "string")
    .map((e) => e.path as string)
    // A prefix is a plain path-prefix match: "components/sky" catches both
    // "components/sky/StarDrawer.tsx" and "components/skyVisuals.tsx" — good
    // enough for a kid narrowing a tour, and predictable.
    .filter((p) => (prefix ? p.startsWith(prefix) : true))
    .filter((p) => hasAllowedExtension(p))
    .sort();
  return {
    paths: matched.slice(0, max),
    capped: matched.length > max,
    total: matched.length,
  };
}

// ─── Pure: truncation ──────────────────────────────────────────────────────
/**
 * Cap a file at ~48KB with a clear "…truncated" marker so the model (and its
 * kid reader) know there's more. Small files pass through untouched.
 */
export function truncateForModel(
  text: string,
  maxChars: number = MAX_FILE_CHARS,
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = text.slice(0, maxChars);
  return {
    text: `${head}\n\n…truncated — this file is longer than I can show at once. Ask me to open a specific part.`,
    truncated: true,
  };
}

// ─── Pure: error mapping ───────────────────────────────────────────────────
/**
 * Map a failed search/read response to a kid-safe line — NEVER an error dump.
 * 429, or 403 with an exhausted rate-limit budget → the "catch its breath"
 * message; anything else (e.g. 401 sign-in-required, 5xx) → the pivot-to-file
 * message.
 */
export function friendlySearchError(
  status: number,
  rateLimitRemaining: string | null,
): string {
  if (status === 429 || (status === 403 && rateLimitRemaining === "0")) {
    return CODE_EXPLORER_RATE_LIMIT_MESSAGE;
  }
  return CODE_EXPLORER_SEARCH_UNAVAILABLE_MESSAGE;
}

// ─── Fetch helpers (global fetch only — imported unchanged by the eval) ─────
type FetchLike = typeof fetch;

/**
 * Read one file from the public repo (unauthenticated). Returns the model-/kid-
 * facing string the tool hands back: the file's real text (truncated if huge),
 * a friendly 404, a friendly path rejection, or a friendly rate-limit line.
 * Never throws for an expected HTTP outcome and never leaks a raw error.
 */
export async function fetchRabbitholeFile(
  rawPath: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const check = validateRepoPath(rawPath);
  if (!check.ok) return codeExplorerRejectedPathMessage(rawPath);

  let res: Response;
  try {
    res = await fetchImpl(rawUrlForPath(check.path));
  } catch {
    return CODE_EXPLORER_SEARCH_UNAVAILABLE_MESSAGE;
  }

  if (res.status === 404) return codeExplorerNotFoundMessage(check.path);
  if (!res.ok) {
    return friendlySearchError(
      res.status,
      res.headers.get("x-ratelimit-remaining"),
    );
  }

  const body = await res.text();
  const { text, truncated } = truncateForModel(body);
  const header = `File: ${check.path}${truncated ? " (truncated)" : ""}\n\n`;
  return header + text;
}

/** One search hit, for the eval + the tool's formatter. */
export interface CodeSearchHit {
  path: string;
}

/**
 * Search the public repo (unauthenticated). Returns a compact, model-facing
 * list of matching file paths, or a friendly line on any failure. Note: at the
 * time of writing GitHub's /search/code endpoint requires a sign-in, so an
 * unauthenticated call returns 401 → the pivot-to-file message. That's the
 * intended graceful degradation: read_rabbithole_file (fully public) carries
 * the feature; search is a bonus when it's available.
 */
export async function searchRabbitholeCode(
  query: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const q = (query ?? "").trim();
  if (!q) return "Give me a word or symbol to search for.";

  let res: Response;
  try {
    res = await fetchImpl(codeSearchUrl(q), {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    return CODE_EXPLORER_SEARCH_UNAVAILABLE_MESSAGE;
  }

  if (!res.ok) {
    return friendlySearchError(
      res.status,
      res.headers.get("x-ratelimit-remaining"),
    );
  }

  let data: { items?: Array<{ path?: string }> };
  try {
    data = (await res.json()) as { items?: Array<{ path?: string }> };
  } catch {
    return CODE_EXPLORER_SEARCH_UNAVAILABLE_MESSAGE;
  }

  const paths = (data.items ?? [])
    .map((it) => it.path)
    .filter((p): p is string => typeof p === "string");

  if (paths.length === 0) {
    return `No files in the code matched "${q}". Try a different word, or tell me what you're curious about and I'll open a likely file.`;
  }
  return [
    `Files that mention "${q}":`,
    ...paths.map((p) => `- ${p}`),
    `Open any of these with read_rabbithole_file to see the real code.`,
  ].join("\n");
}

/**
 * List file paths in the public repo (unauthenticated) via the git-trees API —
 * the DISCOVERY primitive that public code-search can't be (it needs a sign-in).
 * Returns a compact, model-facing list of text-y source paths under an optional
 * folder prefix, or a friendly line on any failure / rate-limit. Unauthenticated
 * git-trees is rate-limited to ~60 req/hr, fine for an experiment.
 */
export async function listRabbitholeFiles(
  rawPrefix: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const prefix = normalizeListPrefix(rawPrefix);
  if (prefix === null) {
    return `"${rawPrefix}" doesn't look like a folder inside Rabbithole's code — try something like "components/sky" or leave it blank to see the top level.`;
  }

  let res: Response;
  try {
    res = await fetchImpl(treeUrl(), {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    return CODE_EXPLORER_SEARCH_UNAVAILABLE_MESSAGE;
  }

  if (!res.ok) {
    return friendlySearchError(
      res.status,
      res.headers.get("x-ratelimit-remaining"),
    );
  }

  let data: { tree?: TreeEntry[] };
  try {
    data = (await res.json()) as { tree?: TreeEntry[] };
  } catch {
    return CODE_EXPLORER_SEARCH_UNAVAILABLE_MESSAGE;
  }

  const { paths, capped } = filterTreePaths(data.tree ?? [], prefix);
  if (paths.length === 0) {
    return prefix
      ? `No source files under "${prefix}". Try a shorter prefix, or leave it blank to see the top level.`
      : "I couldn't list the code files right now — tell me what you're curious about and I'll open a likely file.";
  }

  const header = prefix
    ? `Source files under "${prefix}":`
    : `Source files in Rabbithole's code:`;
  const lines = [header, ...paths.map((p) => `- ${p}`)];
  if (capped) {
    lines.push(
      `…and more — narrow it down with a folder prefix (e.g. "convex/" or "components/sky") to see the rest.`,
    );
  }
  lines.push(`Open any of these with read_rabbithole_file to see the real code.`);
  return lines.join("\n");
}

// ─── Tool builders (the aide-tool shape runAideStream consumes) ─────────────
/**
 * Build the Code Explorer tools for one /meta-stream turn. Mirrors
 * makeSuggestionTools' shape (betaTool objects with a `run` handler + an SSE
 * `emit` on completion), but these take NO ctx and NO credential — they call
 * the pure public-fetch helpers directly.
 *
 * The CALLER gates this behind isCodeExplorerEnabled(); it's a plain builder so
 * the eval can construct the same tools without an env flag.
 */
export async function makeScholarCodeTools(emit: AideEmit) {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const listFilesTool = betaTool({
    name: "list_rabbithole_files",
    description:
      "List the real file paths in Rabbithole's own PUBLIC source code, so you can find WHERE something lives before opening it. Read-only; public code only; no credentials. Pass a folder `prefix` to narrow it (e.g. \"components/sky\" or \"convex/\"), or leave it blank for the top level. Use this to look before you guess — never invent a path.",
    inputSchema: {
      type: "object" as const,
      properties: {
        prefix: {
          type: "string" as const,
          description:
            'Optional folder path prefix, e.g. "components/sky" or "convex/". Blank lists the whole tree (capped).',
        },
      },
      required: [] as const,
    },
    run: async (input: { prefix?: string }) => {
      const result = await listRabbitholeFiles(input.prefix);
      emit({
        toolComplete: {
          name: "list_rabbithole_files",
          result: input.prefix ? input.prefix : "(all)",
        },
      });
      return result;
    },
  });

  const readFileTool = betaTool({
    name: "read_rabbithole_file",
    description:
      "Read one file's real text from Rabbithole's own public source code. Use this when the scholar is curious how something here actually works — the tutor, the Sky, this chat — so you can show them the exact line and translate it into plain language. Read-only; public code only; no credentials. Give a repo-relative path like \"convex/schema.ts\" or \"components/StarMap.tsx\".",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string" as const,
          description:
            'Repo-relative file path, e.g. "convex/metaPrompts.ts". No leading slash, no "..", text source files only.',
        },
      },
      required: ["path"] as const,
    },
    run: async (input: { path: string }) => {
      const result = await fetchRabbitholeFile(input.path);
      emit({
        toolComplete: {
          name: "read_rabbithole_file",
          result: input.path,
        },
      });
      return result;
    },
  });

  const searchCodeTool = betaTool({
    name: "search_rabbithole_code",
    description:
      "Search Rabbithole's own PUBLIC source code for a word or symbol (a function, a table, a component name) to find WHICH file to open. Read-only; public code only; no credentials. If search is unavailable, just open a likely file with read_rabbithole_file instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description: "A word or symbol to look for, e.g. \"twinkle\" or \"StarMap\".",
        },
      },
      required: ["query"] as const,
    },
    run: async (input: { query: string }) => {
      const result = await searchRabbitholeCode(input.query);
      emit({
        toolComplete: {
          name: "search_rabbithole_code",
          result: input.query,
        },
      });
      return result;
    },
  });

  return [listFilesTool, readFileTool, searchCodeTool];
}
