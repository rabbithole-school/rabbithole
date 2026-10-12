// The Workshop Code Explorer — SCHOLAR-facing tools that let the reflection
// chat (/meta-stream) read Rabbithole's OWN, PUBLIC code and make it
// intelligible to a coding-curious kid. See CODE_EXPLORER_SPEC.md.
//
// QB architecture decisions, implemented here:
//   - Fetch is UNAUTHENTICATED + public-only. Rabbithole's repo is public, so
//     all tools fetch from it with NO credential — nothing to leak into a kid
//     surface, and it works on every deployment (no App token / PAT):
//       * read_rabbithole_file  → raw.githubusercontent.com/<repo>/<ref>/<path>
//       * list_rabbithole_files → GitHub's public git-trees API (recursive) —
//         the DISCOVERY primitive, ~60 req/hr unauthenticated.
//
//   - Code SEARCH is the one exception, and it is CREDENTIALED + CONDITIONAL.
//     GitHub's /search/code requires a sign-in. From 2026-07-04 to 2026-09-16
//     this file called it unauthenticated anyway and got 401 on every single
//     call ever made (TRA-305) — shipped as "graceful degradation, a bonus
//     when available", never once available. The fix is not to delete the
//     capability but to authenticate it, through the App token
//     `convex/github.ts` already mints for the staff tools:
//       * search_rabbithole_code → internal.github.searchCode, repo pinned to
//         CODE_EXPLORER_REPO (the PUBLIC mirror, never the private working
//         repo — that one still holds the institution-private sections
//         /publish-foundation strips, which must not reach a kid or a parent).
//     It is registered ONLY when the App env is present
//     (codeSearchCredentialsPresent). Worktree dev + Vercel preview backends
//     have no GITHUB_APP_* on purpose: scripts/worktree-up.sh copies only the
//     AI keys, so a token that can write PRs and dispatch agents is not spread
//     across ~50 ephemeral deployments. There the surface simply has two
//     tools. THAT is how this degrades — by losing a tool, never by keeping a
//     dead one in the list for the model to waste a round on.
//
//     The query is caller text, so it reaches a write-capable credential;
//     bounded (one GET, fixed endpoint, server-pinned repo) and tracked in
//     TRA-307. Both surfaces wrap these tools in guardCodeToolArguments so a
//     person's name can never travel in a query or a path.
//   - Read hygiene (public data, but keep the chat healthy): normalize paths;
//     reject anything outside the repo (`..`, absolute, URL schemes, backslashes);
//     text-y extensions only; truncate big files with a clear "…truncated"
//     marker; a friendly 404.
//   - On a rate-limit / unavailable response NEVER dump an error — return a
//     warm, kid-safe line and let the model pivot to reading a specific file.
//
// Always on: every Workshop chat (Today's reflection AND Ask Rabbithole) carries
// these tools and the matching prompt section in metaPrompts.ts. There used to
// be a WORKSHOP_CODE_EXPLORER_ENABLED env flag; it was never set on prod, so
// "what programming language are you written in?" got a deflection — removed
// 2026-09-11 per the no-unrequested-flags rule (engineering-principles.md).
//
// NEVER register these on a staff aide surface (assembleCurriculumTools) — they
// are lay-audience tools, registered on /meta-stream (scholars) and
// /parent-chat-stream (parents asking "how does Rabbithole decide…"). Staff
// have their own repo tools (lib/introspectionTools.ts), which are credentialed
// and teacher-gated.
//
// WHICH REPO: the reads go to the PUBLIC Foundation mirror
// (rabbithole-school/rabbithole, default branch `main`) — never the private
// working repo. The working repo went private on 2026-08-25, and an
// unauthenticated raw read of it 404s, so from then until 2026-09-16 every
// explorer call on prod returned the friendly not-found line. The mirror is
// the same code with institution-private sections stripped, published by
// /publish-foundation, so it lags the working repo by however long since the
// last publish — fine for "how does this work" tours.
//
// The pure helpers (path validation, extension gate, truncation, error mapping,
// URL building) are split out and exported so they're unit-testable with no
// network, per .claude/rules/rabbithole-test-strategy.md. The two fetch helpers
// use ONLY global `fetch` (no ctx, no Convex query) so the eval harness can
// import and run them unchanged — no forked fetch logic anywhere.

import type { AideEmit } from "./aideStream";
import { internal } from "../_generated/api";
import type { FunctionReference } from "convex/server";

/** The slice of the action ctx the search tool needs — structural so the pure
 * helpers above stay importable by the eval with no Convex runtime. */
type RunSearchAction = (
  ref: FunctionReference<"action", "internal", { query: string; repo?: string }>,
  args: { query: string; repo?: string },
) => Promise<{ totalCount: number; items: Array<{ path: string }> }>;

/**
 * Cost-sanity cap on the /meta-stream tool loop (spec §"Cost sanity":
 * "a small iteration cap (≤4 tool rounds per turn)"). `max_iterations` counts
 * API requests in the toolRunner loop; capping at 5 leaves room for up to ~4
 * rounds of tool use followed by a final synthesis turn, so a curious back-and-
 * forth can't run away on cost.
 */
export const CODE_EXPLORER_MAX_ITERATIONS = 5;

// ─── Constants ───────────────────────────────────────────────────────────
/** The public repo the tools read. No credential is ever attached. See the
 * WHICH REPO note above: this is the Foundation mirror, not the working repo. */
export const CODE_EXPLORER_REPO = "rabbithole-school/rabbithole";
/** The branch the raw-file reads pin to — the mirror's default branch. */
export const CODE_EXPLORER_REF = "main";
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

/** A read or listing failed for a NON rate-limit reason (a 5xx, a network
 * blip). Warm, never an error dump; invites naming the part to look at. */
export const CODE_EXPLORER_UNAVAILABLE_MESSAGE =
  "The code library isn't answering right now — but if you tell me which part you're curious about, I can try opening that file and we can look at it together.";

/** A missing file — offer the listing, which is how you find the real path. */
export function codeExplorerNotFoundMessage(path: string): string {
  return `I couldn't find a file at "${path}" in Rabbithole's code — want me to list what's in that folder instead?`;
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

/** Public git-trees URL for the repo at its default branch, recursive
 * (unauthenticated). Lists every path in the tree in one call — the discovery
 * primitive, and the only one, since code search needs a credential. */
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
 * Map a failed read/listing response to a kid-safe line — NEVER an error dump.
 * 429, or 403 with an exhausted rate-limit budget → the "catch its breath"
 * message; anything else (a 5xx, an unexpected status) → the try-a-file line.
 */
export function friendlyFetchError(
  status: number,
  rateLimitRemaining: string | null,
): string {
  if (status === 429 || (status === 403 && rateLimitRemaining === "0")) {
    return CODE_EXPLORER_RATE_LIMIT_MESSAGE;
  }
  return CODE_EXPLORER_UNAVAILABLE_MESSAGE;
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
    return CODE_EXPLORER_UNAVAILABLE_MESSAGE;
  }

  if (res.status === 404) return codeExplorerNotFoundMessage(check.path);
  if (!res.ok) {
    return friendlyFetchError(
      res.status,
      res.headers.get("x-ratelimit-remaining"),
    );
  }

  const body = await res.text();
  const { text, truncated } = truncateForModel(body);
  const header = `File: ${check.path}${truncated ? " (truncated)" : ""}\n\n`;
  return header + text;
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
    return CODE_EXPLORER_UNAVAILABLE_MESSAGE;
  }

  if (!res.ok) {
    return friendlyFetchError(
      res.status,
      res.headers.get("x-ratelimit-remaining"),
    );
  }

  let data: { tree?: TreeEntry[] };
  try {
    data = (await res.json()) as { tree?: TreeEntry[] };
  } catch {
    return CODE_EXPLORER_UNAVAILABLE_MESSAGE;
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
/** The line a guarded tool returns instead of sending a protected name to
 * GitHub. Worded for the model: it should rephrase, not apologize to the user. */
export const CODE_EXPLORER_PROTECTED_TERM_MESSAGE =
  "Refused: that path or query contains a person's name. The code explorer reads Rabbithole's public source, which never mentions individual people — rephrase with a file path, folder, or code word instead.";

/** Names ≥ this many characters are guarded; shorter fragments ("Al", "Bo")
 * would refuse ordinary code words. */
const PROTECTED_TERM_MIN_CHARS = 3;

/**
 * Split people's display names into the tokens the guard checks — each
 * whitespace-separated part, lowercased, at least PROTECTED_TERM_MIN_CHARS.
 */
export function protectedTermsFromNames(names: ReadonlyArray<string>): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const part of name.split(/\s+/)) {
      const term = part.trim().toLowerCase();
      if (term.length >= PROTECTED_TERM_MIN_CHARS) out.add(term);
    }
  }
  return [...out];
}

/** True when any string anywhere in the tool input contains a protected term
 * (case-insensitive substring — a false positive only costs the model a
 * rephrase; a false negative would put a child's name in a GitHub request). */
export function inputMentionsProtectedTerm(
  input: unknown,
  protectedTerms: ReadonlyArray<string>,
): boolean {
  if (protectedTerms.length === 0) return false;
  const haystack = JSON.stringify(input ?? "").toLowerCase();
  return protectedTerms.some((term) => haystack.includes(term));
}

/**
 * Wrap the explorer tools so no protected term (a child's or parent's name)
 * can travel to GitHub in a path, prefix, or search query. The tools carry no
 * scholar data themselves, but on a surface that ALSO holds scholar-read
 * tools the model chooses the arguments after seeing that data, so the
 * outbound arguments are the leak channel — this closes it at the boundary
 * rather than trusting the prompt. Pure over the tool objects; the refusal is
 * returned as the tool result so the loop continues normally.
 */
export function guardCodeToolArguments<
  // The SDK's runnable-tool `run` takes (args, context) and may return content
  // blocks; the wrapper only inspects args[0] and otherwise passes through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends { run: (...args: any[]) => unknown },
>(tools: T[], protectedTerms: ReadonlyArray<string>): T[] {
  if (protectedTerms.length === 0) return tools;
  return tools.map(
    (tool) =>
      ({
        ...tool,
        run: (...args: Parameters<T["run"]>) =>
          inputMentionsProtectedTerm(args[0], protectedTerms)
            ? CODE_EXPLORER_PROTECTED_TERM_MESSAGE
            : tool.run(...args),
      }) as T,
  );
}

/**
 * The three env vars `convex/github.ts` needs to mint an App installation
 * token. See the header: absent on dev/preview backends by design, and their
 * absence DROPS the search tool rather than registering a dead one.
 */
export function codeSearchCredentialsPresent(): boolean {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_INSTALLATION_ID,
  );
}

/** Model-facing rendering of a search result: paths to open, nothing else.
 * Pure so the shape is testable without a credential or a network. */
export function formatCodeSearchHits(
  query: string,
  paths: ReadonlyArray<string>,
): string {
  if (paths.length === 0) {
    return `No files in the code matched "${query}". Try a different word, or tell me what you're curious about and I'll open a likely file.`;
  }
  return [
    `Files that mention "${query}":`,
    ...paths.map((p) => `- ${p}`),
    `Open any of these with read_rabbithole_file to see the real code.`,
  ].join("\n");
}

/**
 * Build the Code Explorer tools for one /meta-stream turn. Mirrors
 * makeSuggestionTools' shape (betaTool objects with a `run` handler + an SSE
 * `emit` on completion), but these take NO ctx and NO credential — they call
 * the pure public-fetch helpers directly.
 *
 * A plain builder (no env gate) so
 * the eval can construct the same tools without an env flag.
 */
export async function makeScholarCodeTools(
  emit: AideEmit,
  /** Pass the action ctx to unlock code search. Omitted (or no App env) → the
   * two credential-free tools only. */
  ctx?: { runAction: RunSearchAction },
) {
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

  if (!ctx || !codeSearchCredentialsPresent()) return [listFilesTool, readFileTool];

  const searchCodeTool = betaTool({
    name: "search_rabbithole_code",
    description:
      "Find WHICH file to open by searching Rabbithole's own public source code for a word or symbol (a function, a table, a component name). Returns file paths to open with read_rabbithole_file. Read-only, public code only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string" as const,
          description: 'A word or symbol to look for, e.g. "twinkle" or "StarMap".',
        },
      },
      required: ["query"] as const,
    },
    run: async (input: { query: string }) => {
      const q = (input.query ?? "").trim();
      if (!q) return "Give me a word or symbol to search for.";
      let paths: string[] | null = null;
      if (paths === null) return CODE_EXPLORER_UNAVAILABLE_MESSAGE;
      const hits: string[] = paths;
      emit({
        toolComplete: {
          name: "search_rabbithole_code",
          result: `${hits.length} file(s) mention "${q}"`,
        },
      });
      return formatCodeSearchHits(q, hits);
    },
  });

  return [listFilesTool, readFileTool, searchCodeTool];
}
