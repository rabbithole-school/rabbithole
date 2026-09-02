import {
  StaleRevisionError,
  batchUpdate,
  getDocument,
  type GoogleDocument,
} from "./googleDocsApi";
import {
  buildInsertRequests,
  buildReplaceRequests,
  findExactlyOne,
  flattenTabBody,
  type FlattenedTabBody,
  type GoogleDocsBatchRequest,
  type GoogleDocsDocument,
  type GoogleDocsTextRefusalReason,
} from "./googleDocsText";

const MAX_VIEW_CHARACTERS = 100_000;
const MAX_POST_EDIT_CHARACTERS = 2_000;
const POST_EDIT_CONTEXT_LINES = 3;

export type GoogleDocsEditorCommand =
  | {
      command: "view";
      path: string;
      view_range?: number[];
    }
  | {
      command: "create";
      path: string;
      file_text: string;
    }
  | {
      command: "str_replace";
      path: string;
      old_str: string;
      new_str: string;
    }
  | {
      command: "insert";
      path: string;
      insert_line: number;
      insert_text: string;
    };

interface DocumentTarget {
  documentId: string;
  requestedTabId?: string;
}

interface DocumentEditSession {
  documentId: string;
  tabId?: string;
  revisionId: string;
  flat: FlattenedTabBody;
  truncated: boolean;
}

type OperationRecord =
  | {
      fingerprint: string;
      status: "pending";
    }
  | {
      fingerprint: string;
      status: "completed";
      result: string;
    };

export interface GoogleDocsEditorOptions {
  create?: (args: {
    token: string;
    title: string;
    fileText: string;
    toolUseId: string;
  }) => Promise<string>;
}

/**
 * One instance belongs to one aide tool loop. Its in-memory state binds every
 * write to the exact document projection and revision returned by a prior view.
 */
export class GoogleDocsEditor {
  private readonly sessions = new Map<string, DocumentEditSession>();
  private readonly operations = new Map<string, OperationRecord>();

  constructor(private readonly options: GoogleDocsEditorOptions = {}) {}

  async execute(
    token: string,
    input: GoogleDocsEditorCommand,
    context: { toolUseId: string },
  ): Promise<string> {
    const toolUseId = context.toolUseId.trim();
    if (!toolUseId) {
      return "IDEMPOTENCY_KEY_MISSING: the editor requires the tool_use id.";
    }

    const fingerprint = commandFingerprint(input);
    const prior = this.operations.get(toolUseId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return "IDEMPOTENCY_CONFLICT: this tool_use id was already used for a different command.";
      }
      if (prior.status === "completed") return prior.result;
      return "IDEMPOTENCY_UNCERTAIN: this operation may or may not have been applied; view the document to check before retrying. This call will not be replayed.";
    }

    if (input.command === "view") {
      const result = await this.view(token, input);
      this.operations.set(toolUseId, {
        fingerprint,
        status: "completed",
        result,
      });
      return result;
    }

    this.operations.set(toolUseId, { fingerprint, status: "pending" });
    const result =
      input.command === "create"
        ? await this.create(token, input, toolUseId)
        : await this.write(token, input);
    this.operations.set(toolUseId, {
      fingerprint,
      status: "completed",
      result,
    });
    return result;
  }

  private async view(
    token: string,
    input: Extract<GoogleDocsEditorCommand, { command: "view" }>,
  ): Promise<string> {
    if (input.view_range !== undefined) {
      return "VIEW_RANGE_UNSUPPORTED: view the full document before editing so the executor can check every exact match.";
    }

    const target = parseDocumentTarget(input.path);
    if (typeof target === "string") return target;

    const session = await fetchDocumentSession(token, target);
    this.sessions.set(target.documentId, session);
    return formatView(session);
  }

  private async create(
    token: string,
    input: Extract<GoogleDocsEditorCommand, { command: "create" }>,
    toolUseId: string,
  ): Promise<string> {
    if (!this.options.create) {
      return "CREATE_UNAVAILABLE: use create_shared_doc to create a Google Doc.";
    }
    const title = input.path.trim();
    if (!title) return "INVALID_TITLE: provide a non-empty document title.";
    if (!input.file_text.trim()) {
      return "INVALID_CONTENT: provide non-empty initial document content.";
    }
    return await this.options.create({
      token,
      title,
      fileText: input.file_text,
      toolUseId,
    });
  }

  private async write(
    token: string,
    input: Extract<
      GoogleDocsEditorCommand,
      { command: "str_replace" | "insert" }
    >,
  ): Promise<string> {
    const target = parseDocumentTarget(input.path);
    if (typeof target === "string") return target;

    const session = this.sessions.get(target.documentId);
    if (!session) {
      return "READ_REQUIRED: view this document in the current edit session before changing it.";
    }
    if (
      target.requestedTabId !== undefined &&
      target.requestedTabId !== session.tabId
    ) {
      return "READ_REQUIRED: view this document tab in the current edit session before changing it.";
    }
    if (session.truncated) {
      return "DOCUMENT_TOO_LARGE: the prior view was truncated, so this document cannot be edited safely.";
    }

    let requests;
    let focusLine: number;
    let expectedText: string;
    if (input.command === "str_replace") {
      const match = findExactlyOne(session.flat, input.old_str);
      if (match.kind === "none") {
        return "NOT_FOUND: old_str does not occur in the last viewed document.";
      }
      if (match.kind === "many") {
        return `AMBIGUOUS_MATCH: old_str occurs ${match.count} times in the last viewed document; provide a uniquely identifying string.`;
      }
      if (match.kind === "invalid") {
        return mapperRefusal(match.reason);
      }

      requests = buildReplaceRequests(
        session.flat,
        match.index,
        input.old_str.length,
        input.new_str,
      );
      focusLine = lineNumberAt(session.flat.text, match.index);
      expectedText =
        session.flat.text.slice(0, match.index) +
        input.new_str +
        session.flat.text.slice(match.index + input.old_str.length);
    } else {
      const insertText = normalizeLineEndings(input.insert_text);
      requests = buildInsertRequests(
        session.flat,
        input.insert_line,
        insertText,
      );
      focusLine = input.insert_line + 1;
      expectedText = expectedInsertText(
        session.flat.text,
        input.insert_line,
        insertText,
      );
    }

    if ("kind" in requests) return mapperRefusal(requests.reason);
    if (session.tabId === undefined) {
      requests = omitTabIds(requests);
    }

    try {
      await batchUpdate(token, target.documentId, requests, {
        requiredRevisionId: session.revisionId,
      });
    } catch (error) {
      if (error instanceof StaleRevisionError) {
        this.sessions.delete(target.documentId);
        return "STALE_DOCUMENT: view again";
      }
      throw error;
    }

    let refreshed: DocumentEditSession;
    try {
      refreshed = await fetchDocumentSession(token, {
        documentId: target.documentId,
        ...(session.tabId ? { requestedTabId: session.tabId } : {}),
      });
    } catch (error) {
      this.sessions.delete(target.documentId);
      const detail = error instanceof Error ? error.message : String(error);
      return `WRITE_APPLIED_REFRESH_FAILED: the edit was accepted, but the updated document could not be read (${detail}). View again before another edit.`;
    }

    if (refreshed.flat.text !== expectedText) {
      this.sessions.delete(target.documentId);
      return "EDIT_VERIFY_FAILED: Google Docs accepted the write, but the refetched document did not contain the expected edit. View again before another edit.";
    }

    this.sessions.set(target.documentId, refreshed);
    return formatPostEdit(refreshed, focusLine);
  }
}

export function parseGoogleDocsEditorInput(
  value: unknown,
): GoogleDocsEditorCommand {
  if (!isRecord(value) || typeof value.command !== "string") {
    throw new Error("Google Docs editor input must include a command.");
  }
  const path = requireString(value.path, "path");

  switch (value.command) {
    case "view":
      if (
        value.view_range !== undefined &&
        (!Array.isArray(value.view_range) ||
          !value.view_range.every(Number.isInteger))
      ) {
        throw new Error("view_range must be an array of line numbers.");
      }
      return {
        command: "view",
        path,
        ...(value.view_range !== undefined
          ? { view_range: value.view_range as number[] }
          : {}),
      };
    case "create":
      return {
        command: "create",
        path,
        file_text: requireString(value.file_text, "file_text"),
      };
    case "str_replace":
      return {
        command: "str_replace",
        path,
        old_str: requireString(value.old_str, "old_str"),
        new_str: requireString(value.new_str, "new_str"),
      };
    case "insert":
      if (!Number.isInteger(value.insert_line)) {
        throw new Error("insert_line must be an integer.");
      }
      return {
        command: "insert",
        path,
        insert_line: value.insert_line as number,
        insert_text: requireString(value.insert_text, "insert_text"),
      };
    default:
      throw new Error(
        "Unsupported Google Docs editor command. Use view, create, str_replace, or insert.",
      );
  }
}

function parseDocumentTarget(path: string): DocumentTarget | string {
  const input = path.trim();
  if (!input) {
    return "INVALID_DOCUMENT: provide a Google Docs URL or document ID.";
  }

  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      return "INVALID_DOCUMENT: provide a valid Google Docs URL or document ID.";
    }
    if (url.hostname !== "docs.google.com") {
      return "INVALID_DOCUMENT: only docs.google.com document URLs are supported.";
    }
    const match = url.pathname.match(
      /^\/document\/(?:u\/\d+\/)?d\/([^/]+)(?:\/|$)/,
    );
    const documentId = match?.[1];
    if (!documentId || !isDocumentId(documentId)) {
      return "INVALID_DOCUMENT: the Google Docs URL does not contain a valid document ID.";
    }
    const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
    const requestedTabId =
      url.searchParams.get("tab") ?? hashParams.get("tab") ?? undefined;
    return { documentId, requestedTabId };
  }

  if (!isDocumentId(input)) {
    return "INVALID_DOCUMENT: provide a Google Docs URL or document ID.";
  }
  return { documentId: input };
}

async function fetchDocumentSession(
  token: string,
  target: DocumentTarget,
): Promise<DocumentEditSession> {
  const document = await getDocument(token, target.documentId, {
    includeTabsContent: true,
  });
  if (!document.revisionId) {
    throw new Error("Google Docs did not return a revisionId");
  }

  const mappedDocument = document as unknown as GoogleDocsDocument;
  const tabId = target.requestedTabId ?? firstTabId(document);
  const flat = flattenTabBody(mappedDocument, tabId ?? "");
  return {
    documentId: target.documentId,
    tabId,
    revisionId: document.revisionId,
    flat,
    truncated: flat.text.length > MAX_VIEW_CHARACTERS,
  };
}

function firstTabId(document: GoogleDocument): string | undefined {
  const visit = (tabs: unknown[]): string | undefined => {
    for (const tab of tabs) {
      if (!isRecord(tab)) continue;
      const properties = tab.tabProperties;
      if (
        isRecord(properties) &&
        typeof properties.tabId === "string" &&
        properties.tabId
      ) {
        return properties.tabId;
      }
      if (Array.isArray(tab.childTabs)) {
        const childId = visit(tab.childTabs);
        if (childId) return childId;
      }
    }
    return undefined;
  };
  return Array.isArray(document.tabs) ? visit(document.tabs) : undefined;
}

function formatView(session: DocumentEditSession): string {
  const visibleText = truncateAtUtf16Boundary(
    session.flat.text,
    MAX_VIEW_CHARACTERS,
  );
  const rendered = [
    `Document: ${session.documentId}`,
    `Tab: ${session.tabId ?? "legacy body"}`,
    `Revision: ${session.revisionId}`,
    `Truncated: ${session.truncated}`,
    numberLines(visibleText),
    ...(session.truncated
      ? [
          `VIEW_TRUNCATED: showing the first ${MAX_VIEW_CHARACTERS} characters.`,
        ]
      : []),
  ].join("\n");
  // Headers + line numbers are added on top of the capped body text, so the
  // rendered view can exceed the tool's max_characters contract on its own —
  // hard-cap the final string too (edits on a truncated view are refused
  // upstream, so clipping here loses nothing actionable).
  if (rendered.length <= MAX_VIEW_CHARACTERS) return rendered;
  return `${truncateAtUtf16Boundary(rendered, MAX_VIEW_CHARACTERS - 60)}\nVIEW_TRUNCATED: output capped at ${MAX_VIEW_CHARACTERS} characters.`;
}

function formatPostEdit(
  session: DocumentEditSession,
  focusLine: number,
): string {
  return [
    "EDIT_APPLIED",
    `Revision: ${session.revisionId}`,
    "Post-edit excerpt:",
    numberedExcerpt(session.flat.text, focusLine),
  ].join("\n");
}

function numberLines(text: string, startLine = 1): string {
  return numberLineValues(logicalLines(text), startLine);
}

function numberLineValues(lines: string[], startLine = 1): string {
  return lines
    .map((line, index) => `${startLine + index}: ${line}`)
    .join("\n");
}

function numberedExcerpt(text: string, focusLine: number): string {
  const lines = logicalLines(text);
  const boundedFocus = Math.min(Math.max(focusLine, 1), lines.length);
  const start = Math.max(0, boundedFocus - 1 - POST_EDIT_CONTEXT_LINES);
  const end = Math.min(
    lines.length,
    boundedFocus + POST_EDIT_CONTEXT_LINES,
  );
  const excerpt = [
    ...(start > 0 ? ["..."] : []),
    numberLineValues(lines.slice(start, end), start + 1),
    ...(end < lines.length ? ["..."] : []),
  ].join("\n");
  if (excerpt.length <= MAX_POST_EDIT_CHARACTERS) return excerpt;
  return `${truncateAtUtf16Boundary(excerpt, MAX_POST_EDIT_CHARACTERS)}\n[excerpt truncated]`;
}

function logicalLines(text: string): string[] {
  if (text === "") return [""];
  const withoutFinalTerminator = text.endsWith("\n")
    ? text.slice(0, -1)
    : text;
  return withoutFinalTerminator.split("\n");
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text[cursor] === "\n") line += 1;
  }
  return line;
}

function mapperRefusal(reason: GoogleDocsTextRefusalReason): string {
  return `EDIT_REFUSED: ${reason}. The requested edit cannot be mapped safely to editable Google Docs text.`;
}

function truncateAtUtf16Boundary(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const code = text.charCodeAt(maximum - 1);
  const endsWithHighSurrogate = code >= 0xd800 && code <= 0xdbff;
  return text.slice(0, endsWithHighSurrogate ? maximum - 1 : maximum);
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function expectedInsertText(
  text: string,
  insertLine: number,
  insertText: string,
): string {
  const newlineIndexes: number[] = [];
  for (let index = text.indexOf("\n"); index >= 0; ) {
    newlineIndexes.push(index);
    index = text.indexOf("\n", index + 1);
  }
  const flatIndex = insertLine === 0 ? 0 : newlineIndexes[insertLine - 1]!;
  const payload =
    insertLine === 0 ? `${insertText}\n` : `\n${insertText}`;
  return text.slice(0, flatIndex) + payload + text.slice(flatIndex);
}

function omitTabIds(
  requests: GoogleDocsBatchRequest[],
) {
  return requests.map((request) => {
    if ("deleteContentRange" in request) {
      const { tabId: _tabId, ...range } = request.deleteContentRange.range;
      return { deleteContentRange: { range } };
    }
    const { tabId: _tabId, ...location } = request.insertText.location;
    return { insertText: { ...request.insertText, location } };
  });
}

function isDocumentId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function commandFingerprint(input: GoogleDocsEditorCommand): string {
  switch (input.command) {
    case "view":
      return JSON.stringify([
        input.command,
        input.path,
        input.view_range ?? null,
      ]);
    case "create":
      return JSON.stringify([input.command, input.path, input.file_text]);
    case "str_replace":
      return JSON.stringify([
        input.command,
        input.path,
        input.old_str,
        input.new_str,
      ]);
    case "insert":
      return JSON.stringify([
        input.command,
        input.path,
        input.insert_line,
        input.insert_text,
      ]);
  }
}

function requireString(
  value: unknown,
  field: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
