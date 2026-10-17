/**
 * The scholar tutor's app editor: Anthropic's built-in text editor tool
 * (`text_editor_20250728`, named `str_replace_based_edit_tool`) pointed at the
 * session's CODE artifacts. The model is trained on this tool — it is how
 * Claude Code edits files — so app edits use it instead of the custom
 * `edit_document` str_replace/insert commands they used before.
 *
 * Pure helpers only (no Convex ctx): the tool itself is assembled in
 * `tutorSessionTools.ts`, which runs these against `internal.artifacts.*`.
 *
 * The contract, as implemented:
 *
 * - PATHS. Every app is one file at `/apps/<Document ID>.html` — derived from
 *   the artifact id, so it never changes when the app is renamed. `/apps` is
 *   the directory (view lists the session's apps). Nothing else is a path:
 *   a scholar's writing box has no path, and a text document's id under
 *   `/apps/` is refused before any write (see SCHOLAR_WRITING_REFUSAL).
 * - COMMANDS. `view` (optional `view_range` [start, end], 1-indexed, end -1 =
 *   last line), `str_replace` (old_str must occur exactly once), `insert`
 *   (after `insert_line`, 0 = top). `create` is refused: a new app is
 *   `create_code` (which carries the Quest build lock), and overwriting a
 *   whole app is not an edit.
 * - CONFLICTS. The tool has no revision parameter, so the executor holds it:
 *   each write is bound to the revision of the app the model last SAW — the
 *   DOCUMENTS section at turn start, a `view`, or its own previous edit
 *   (`SeenRevisions`). If the app changed in between (the scholar typed in the
 *   Code view), the write is refused with STALE_FILE and the model must view
 *   it again. Same guarantee `base_revision` gave, without asking the model to
 *   copy a number.
 */

export const CODE_EDITOR_TOOL_NAME = "str_replace_based_edit_tool" as const;
export const CODE_EDITOR_TOOL_TYPE = "text_editor_20250728" as const;

/**
 * The name the clients see for this tool's toolStart/toolComplete events.
 * Both frontends key the build-stage indicator, the "Working on the document"
 * chip and the app builder's in-flight state on `edit_document`, and a native
 * change reaches an iPad only through /ipad-release — so the stream keeps the
 * old wire name rather than make every shipped iPad hide the chip.
 */
export const CODE_EDITOR_CLIENT_TOOL_NAME = "edit_document" as const;

export function clientToolName(name: string): string;
export function clientToolName(name: string | undefined): string | undefined;
export function clientToolName(name: string | undefined): string | undefined {
  return name === CODE_EDITOR_TOOL_NAME ? CODE_EDITOR_CLIENT_TOOL_NAME : name;
}

export const APPS_DIRECTORY = "/apps";

export function codeArtifactPath(artifactId: string): string {
  return `${APPS_DIRECTORY}/${artifactId}.html`;
}

export const PATH_FORMAT_HINT =
  "An app's path is /apps/<Document ID>.html, as shown for each LIVE APP in DOCUMENTS; view /apps to list them.";

export type CodeEditorTarget =
  | { kind: "directory" }
  | { kind: "file"; artifactId: string }
  | { kind: "invalid"; error: string };

export function parseCodeArtifactPath(raw: string): CodeEditorTarget {
  const path = raw.trim().replace(/^\/+/, "/");
  const normalized = path.startsWith("/") ? path : `/${path}`;
  if (normalized === APPS_DIRECTORY || normalized === `${APPS_DIRECTORY}/`) {
    return { kind: "directory" };
  }
  const match = normalized.match(/^\/apps\/([A-Za-z0-9_-]+)\.html$/);
  if (!match) {
    return {
      kind: "invalid",
      error: `INVALID_PATH: ${raw.trim() || "(empty)"} is not an app. ${PATH_FORMAT_HINT}`,
    };
  }
  return { kind: "file", artifactId: match[1]! };
}

/** The artifact a code-tool call targets, for the render check. */
export function requestedArtifactIdFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  if (typeof record.document_id === "string") return record.document_id;
  if (typeof record.path === "string") {
    const target = parseCodeArtifactPath(record.path);
    return target.kind === "file" ? target.artifactId : null;
  }
  return null;
}

export const SCHOLAR_WRITING_REFUSAL =
  "This is the scholar's writing. You can't write in it — they type or dictate into the box themselves. Point them to the box once, then keep the conversation going.";

/**
 * How a document is shown to the model, everywhere it is viewed: every line is
 * prefixed `N: `. The note says so inside the tool_result, so the model never
 * has to work out (and say out loud, where the scholar can read it) whether
 * the space after the colon is part of the code. Live 2026-10-08: a vibecode
 * turn wrote "Lines start with one space." into the scholar-visible
 * transcript, between a view and the edit that followed it.
 */
export const VIEW_LINE_NUMBER_NOTE =
  "Each line below starts with its line number, a colon and one space (`N: `). That prefix is not part of the code: leave it out of old_str and new_str.";

export function numberDocumentLines(
  content: string,
  startLine = 1,
): {
  lineCount: number;
  numbered: string;
} {
  const lines = content.split("\n");
  return {
    lineCount: lines.length,
    numbered: lines.map((l, i) => `${i + startLine}: ${l}`).join("\n"),
  };
}

export type CodeEditorCommand =
  | { command: "view"; path: string; view_range?: [number, number] }
  | { command: "create"; path: string }
  | { command: "str_replace"; path: string; old_str: string; new_str: string }
  | {
      command: "insert";
      path: string;
      insert_line: number;
      insert_text: string;
    };

/**
 * Validate the model's input. A throw here becomes an `is_error` tool_result
 * (the SDK tool runner catches parse errors), so the model can correct itself.
 */
export function parseCodeEditorInput(value: unknown): CodeEditorCommand {
  if (!isRecord(value) || typeof value.command !== "string") {
    throw new Error("The editor input must include a command.");
  }
  const path = requireString(value.path, "path");
  switch (value.command) {
    case "view": {
      if (value.view_range === undefined || value.view_range === null) {
        return { command: "view", path };
      }
      const range = value.view_range;
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !range.every(Number.isInteger)
      ) {
        throw new Error(
          "view_range must be two line numbers, [start, end]; use -1 as end for the last line.",
        );
      }
      return {
        command: "view",
        path,
        view_range: [range[0] as number, range[1] as number],
      };
    }
    case "create":
      return { command: "create", path };
    case "str_replace":
      return {
        command: "str_replace",
        path,
        old_str: requireString(value.old_str, "old_str"),
        // Omitting new_str deletes old_str, as in the reference editor.
        new_str:
          value.new_str === undefined || value.new_str === null
            ? ""
            : requireString(value.new_str, "new_str"),
      };
    case "insert": {
      if (!Number.isInteger(value.insert_line)) {
        throw new Error("insert_line must be an integer.");
      }
      // The 20250728 tool names the payload insert_text; accept new_str too.
      const text =
        value.insert_text !== undefined ? value.insert_text : value.new_str;
      return {
        command: "insert",
        path,
        insert_line: value.insert_line as number,
        insert_text: requireString(text, "insert_text"),
      };
    }
    default:
      throw new Error(
        `Unsupported command "${value.command}". Use view, str_replace, or insert.`,
      );
  }
}

export function formatAppView(args: {
  path: string;
  title: string;
  revision: number;
  content: string;
  viewRange?: [number, number];
}): { ok: true; text: string } | { ok: false; error: string } {
  const lines = args.content.split("\n");
  const lineCount = lines.length;
  let start = 1;
  let end = lineCount;
  if (args.viewRange) {
    const [from, to] = args.viewRange;
    const last = to === -1 ? lineCount : to;
    if (from < 1 || from > lineCount || last < from || last > lineCount) {
      return {
        ok: false,
        error: `INVALID_RANGE: view_range [${from}, ${to}] is outside ${args.path}, which has ${lineCount} lines. Use 1-indexed [start, end] with end -1 for the last line.`,
      };
    }
    start = from;
    end = last;
  }
  const { numbered } = numberDocumentLines(
    lines.slice(start - 1, end).join("\n"),
    start,
  );
  const shown =
    start === 1 && end === lineCount
      ? `${lineCount} lines`
      : `lines ${start}-${end} of ${lineCount}`;
  return {
    ok: true,
    text: `${args.path} "${args.title}" (revision ${args.revision}, ${shown})\n${VIEW_LINE_NUMBER_NOTE}\n${numbered}`,
  };
}

export function formatAppDirectory(
  apps: ReadonlyArray<{
    id: string;
    title: string;
    revision: number;
    content: string;
  }>,
): string {
  if (apps.length === 0) {
    return `${APPS_DIRECTORY} is empty: this session has no app yet. Build one with create_code.`;
  }
  return [
    `${APPS_DIRECTORY} (${apps.length} app${apps.length === 1 ? "" : "s"}):`,
    ...apps.map(
      (app) =>
        `${codeArtifactPath(app.id)} "${app.title}" (revision ${app.revision}, ${app.content.split("\n").length} lines)`,
    ),
  ].join("\n");
}

const EDIT_CONTEXT_LINES = 4;
const MAX_EXCERPT_CHARACTERS = 2_000;

/** A numbered excerpt of the edited region, so the next edit has fresh text. */
export function editExcerpt(
  content: string,
  firstLine: number,
  lastLine = firstLine,
): string {
  const lines = content.split("\n");
  const start = Math.max(1, firstLine - EDIT_CONTEXT_LINES);
  const end = Math.min(lines.length, lastLine + EDIT_CONTEXT_LINES);
  const excerpt = numberDocumentLines(
    lines.slice(start - 1, end).join("\n"),
    start,
  ).numbered;
  return excerpt.length <= MAX_EXCERPT_CHARACTERS
    ? excerpt
    : `${excerpt.slice(0, MAX_EXCERPT_CHARACTERS)}\n[excerpt truncated]`;
}

/** 1-indexed line on which `index` (a character offset) falls. */
export function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < text.length; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

export function lineCountOf(text: string): number {
  return text.split("\n").length;
}

/**
 * The revision of each app the model has seen this turn. Seeded from the
 * DOCUMENTS section (the same artifact snapshot the system prompt was built
 * from); advanced by a view or by the model's own successful edit; dropped on
 * a conflict so the next write must follow a fresh view.
 */
export class SeenRevisions {
  private readonly seen = new Map<string, number>();

  constructor(
    seed: Iterable<{ id: string; revision: number; type?: string }> = [],
  ) {
    for (const artifact of seed) {
      if (artifact.type === "code") this.seen.set(artifact.id, artifact.revision);
    }
  }

  get(artifactId: string): number | undefined {
    return this.seen.get(artifactId);
  }

  see(artifactId: string, revision: number): void {
    this.seen.set(artifactId, revision);
  }

  forget(artifactId: string): void {
    this.seen.delete(artifactId);
  }
}

export function staleFileMessage(path: string, revision: number): string {
  return `STALE_FILE: ${path} changed after you last saw it (it is now revision ${revision}), so nothing was changed. View it again, then make your edit against what is there now.`;
}

export function readRequiredMessage(path: string): string {
  return `READ_REQUIRED: view ${path} before changing it.`;
}

export function createRefusalMessage(path: string): string {
  return `CREATE_UNAVAILABLE: ${path} was not written. Start a new app with create_code; change an existing app with str_replace or insert on its path.`;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
