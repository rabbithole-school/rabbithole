import {
  findExactlyOneLiteral,
  type ExactTextMatchResult,
} from "./exactTextMatch";

export interface GoogleDocsDocument {
  body?: DocsBody;
  tabs?: DocsTab[];
  [key: string]: unknown;
}

interface DocsBody {
  content?: DocsStructuralElement[];
}

interface DocsTab {
  tabProperties?: {
    tabId?: string;
  };
  documentTab?: {
    body?: DocsBody;
  };
  childTabs?: DocsTab[];
}

interface DocsStructuralElement {
  startIndex?: number;
  endIndex?: number;
  paragraph?: DocsParagraph;
  [key: string]: unknown;
}

interface DocsParagraph {
  elements?: DocsParagraphElement[];
  bullet?: unknown;
  paragraphStyle?: {
    namedStyleType?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface DocsParagraphElement {
  startIndex?: number;
  endIndex?: number;
  textRun?: {
    content?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type GoogleDocsTextSegment =
  | {
      kind: "text";
      flatStart: number;
      flatEnd: number;
      tabId: string;
      segmentId: "body";
      docsStartIndex: number;
      docsEndIndex: number;
    }
  | {
      kind: "protected";
      flatStart: number;
      flatEnd: number;
      tabId: string;
      segmentId: "body";
      docsStartIndex: number;
      docsEndIndex: number;
      reason: string;
    }
  | {
      kind: "boundary";
      flatStart: number;
      flatEnd: number;
      tabId: string;
      segmentId: "body";
      docsStartIndex: number;
      docsEndIndex: number;
      reason: string;
    };

export interface FlattenedTabBody {
  text: string;
  segments: GoogleDocsTextSegment[];
}

export type GoogleDocsBatchRequest =
  | {
      deleteContentRange: {
        range: {
          tabId: string;
          startIndex: number;
          endIndex: number;
        };
      };
    }
  | {
      insertText: {
        location: {
          tabId: string;
          index: number;
        };
        text: string;
      };
    };

export type GoogleDocsTextRefusalReason =
  | "empty_needle"
  | "invalid_range"
  | "invalid_control_character"
  | "invalid_utf16_boundary"
  | "invalid_utf16_text"
  | "structural_boundary"
  | "multiple_segments"
  | "non_contiguous_range"
  | "final_body_newline"
  | "invalid_line"
  | "trailing_newline"
  | "missing_paragraph_boundary"
  | "adjacent_structure";

export interface GoogleDocsTextRefusal {
  kind: "refused";
  reason: GoogleDocsTextRefusalReason;
}

export type FindExactlyOneResult = ExactTextMatchResult;

const SEGMENT_ID = "body" as const;

/**
 * JavaScript string offsets and Google Docs indexes are both UTF-16 code-unit
 * offsets. Mapping by String#length is therefore exact, including astral emoji.
 */
export function flattenTabBody(
  document: GoogleDocsDocument,
  tabId: string,
): FlattenedTabBody {
  const content = selectBodyContent(document, tabId);
  const segments: GoogleDocsTextSegment[] = [];
  let text = "";

  const appendMappedText = (
    value: string,
    docsStartIndex: number,
    kind: "text" | "protected" = "text",
    reason?: string,
  ) => {
    if (value.length === 0) return;
    const docsEndIndex = docsStartIndex + value.length;
    const flatStart = text.length;
    text += value;
    const base = {
      flatStart,
      flatEnd: text.length,
      tabId,
      segmentId: SEGMENT_ID,
      docsStartIndex,
      docsEndIndex,
    };
    segments.push(
      kind === "text"
        ? { kind, ...base }
        : { kind, ...base, reason: reason ?? "protected text" },
    );
  };

  const appendBoundary = (
    reason: string,
    docsStartIndex: number,
    docsEndIndex: number,
    trailingNewlines = 0,
  ) => {
    const marker =
      `[[UNEDITABLE:${reason}@${docsStartIndex}-${docsEndIndex}]]` +
      "\n".repeat(trailingNewlines);
    const flatStart = text.length;
    text += marker;
    segments.push({
      kind: "boundary",
      flatStart,
      flatEnd: text.length,
      tabId,
      segmentId: SEGMENT_ID,
      docsStartIndex,
      docsEndIndex,
      reason,
    });
  };

  for (const [elementIndex, element] of content.entries()) {
    const { startIndex, endIndex } = requireSourceRange(
      element,
      "structural element",
    );

    if (!element.paragraph) {
      if (
        elementIndex === 0 &&
        element.sectionBreak &&
        startIndex === 0 &&
        endIndex === 1
      ) {
        continue;
      }
      appendBoundary(
        structuralElementLabel(element),
        startIndex,
        endIndex,
        1,
      );
      continue;
    }

    const paragraph = element.paragraph;
    const paragraphMetadata = { ...paragraph, elements: undefined };
    if (containsSuggestionMetadata(paragraphMetadata)) {
      appendBoundary("SUGGESTION", startIndex, endIndex, 1);
      continue;
    }

    const protectTerminator =
      paragraph.bullet !== undefined ||
      (paragraph.paragraphStyle?.namedStyleType !== undefined &&
        paragraph.paragraphStyle.namedStyleType !== "NORMAL_TEXT");

    for (const paragraphElement of paragraph.elements ?? []) {
      const elementRange = requireSourceRange(
        paragraphElement,
        "paragraph element",
      );
      const run = paragraphElement.textRun;
      if (!run) {
        appendBoundary(
          paragraphElementLabel(paragraphElement),
          elementRange.startIndex,
          elementRange.endIndex,
        );
        continue;
      }

      const contentValue = run.content;
      if (typeof contentValue !== "string") {
        throw new Error("Google Docs text run is missing content");
      }
      if (contentValue.length !== elementRange.endIndex - elementRange.startIndex) {
        throw new Error(
          "Google Docs text run length does not match its UTF-16 source range",
        );
      }

      if (containsSuggestionMetadata(run)) {
        appendBoundary(
          "SUGGESTION",
          elementRange.startIndex,
          elementRange.endIndex,
          countTrailingNewlines(contentValue),
        );
        continue;
      }

      if (protectTerminator && contentValue.endsWith("\n")) {
        appendMappedText(
          contentValue.slice(0, -1),
          elementRange.startIndex,
        );
        appendMappedText(
          "\n",
          elementRange.endIndex - 1,
          "protected",
          "paragraph terminator carries structural style",
        );
      } else {
        appendMappedText(contentValue, elementRange.startIndex);
      }
    }
  }

  return { text, segments };
}

/**
 * Counts case-sensitive, non-overlapping literal matches. Pass the flattened
 * body rather than only its text when matching a Docs projection so opaque
 * boundary-marker text is excluded from cardinality.
 */
export function findExactlyOne(
  source: string | FlattenedTabBody,
  needle: string,
): FindExactlyOneResult {
  const text = typeof source === "string" ? source : source.text;
  return findExactlyOneLiteral(
    text,
    needle,
    typeof source === "string"
      ? undefined
      : (index, end) => !("kind" in mapFlatRange(source, index, end)),
  );
}

export function buildReplaceRequests(
  flat: FlattenedTabBody,
  matchIndex: number,
  oldLength: number,
  newText: string,
): GoogleDocsBatchRequest[] | GoogleDocsTextRefusal {
  const matchEnd = matchIndex + oldLength;
  if (oldLength === 0) {
    return refused("empty_needle");
  }
  if (
    !Number.isInteger(matchIndex) ||
    !Number.isInteger(oldLength) ||
    matchIndex < 0 ||
    oldLength < 0 ||
    matchEnd > flat.text.length
  ) {
    return refused("invalid_range");
  }
  if (
    !isUtf16Boundary(flat.text, matchIndex) ||
    !isUtf16Boundary(flat.text, matchEnd)
  ) {
    return refused("invalid_utf16_boundary");
  }
  if (!isWellFormedUtf16(newText)) {
    return refused("invalid_utf16_text");
  }
  if (containsDisallowedControlCharacter(newText)) {
    return refused("invalid_control_character");
  }

  const mapped = mapFlatRange(flat, matchIndex, matchEnd);
  if ("kind" in mapped) return mapped;

  const bodyEndIndex = flat.segments.reduce(
    (maximum, segment) => Math.max(maximum, segment.docsEndIndex),
    0,
  );
  if (
    flat.text[matchEnd - 1] === "\n" &&
    mapped.endIndex === bodyEndIndex
  ) {
    return refused("final_body_newline");
  }

  const requests: GoogleDocsBatchRequest[] = [
    {
      deleteContentRange: {
        range: {
          tabId: mapped.tabId,
          startIndex: mapped.startIndex,
          endIndex: mapped.endIndex,
        },
      },
    },
  ];
  if (newText.length > 0) {
    requests.push({
      insertText: {
        location: {
          tabId: mapped.tabId,
          index: mapped.startIndex,
        },
        text: newText,
      },
    });
  }
  return requests;
}

export function buildInsertRequests(
  flat: FlattenedTabBody,
  insertLine: number,
  insertText: string,
): GoogleDocsBatchRequest[] | GoogleDocsTextRefusal {
  if (!Number.isInteger(insertLine) || insertLine < 0) {
    return refused("invalid_line");
  }

  if (containsDisallowedControlCharacter(insertText)) {
    return refused("invalid_control_character");
  }
  if (insertText.endsWith("\n")) {
    return refused("trailing_newline");
  }
  if (!isWellFormedUtf16(insertText)) {
    return refused("invalid_utf16_text");
  }

  const newlineIndexes: number[] = [];
  for (let index = flat.text.indexOf("\n"); index >= 0; ) {
    newlineIndexes.push(index);
    index = flat.text.indexOf("\n", index + 1);
  }
  if (newlineIndexes.length === 0 || insertLine > newlineIndexes.length) {
    return refused("invalid_line");
  }

  const lineStart =
    insertLine <= 1 ? 0 : newlineIndexes[insertLine - 2] + 1;
  const lineEnd =
    insertLine === 0 ? newlineIndexes[0] + 1 : newlineIndexes[insertLine - 1] + 1;
  if (rangeTouchesStructure(flat, lineStart, lineEnd)) {
    return refused("structural_boundary");
  }

  const flatIndex = insertLine === 0 ? 0 : newlineIndexes[insertLine - 1];
  const source = segmentAt(flat, flatIndex);
  if (!source || source.kind !== "text") {
    return refused("missing_paragraph_boundary");
  }
  if (
    !isUtf16Boundary(flat.text, flatIndex) ||
    source.segmentId !== SEGMENT_ID
  ) {
    return refused("invalid_utf16_boundary");
  }

  const next = segmentAt(flat, flatIndex + 1);
  if (next && next.kind !== "text") {
    return refused("adjacent_structure");
  }

  const index =
    source.docsStartIndex + (flatIndex - source.flatStart);
  return [
    {
      insertText: {
        location: {
          tabId: source.tabId,
          index,
        },
        text:
          insertLine === 0
            ? `${insertText}\n`
            : `\n${insertText}`,
      },
    },
  ];
}

function selectBodyContent(
  document: GoogleDocsDocument,
  tabId: string,
): DocsStructuralElement[] {
  if (document.tabs && document.tabs.length > 0) {
    const tab = findTab(document.tabs, tabId);
    if (!tab) throw new Error(`Google Docs tab not found: ${tabId}`);
    if (!tab.documentTab?.body) {
      throw new Error(`Google Docs tab has no included body content: ${tabId}`);
    }
    return tab.documentTab.body.content ?? [];
  }
  if (!document.body) {
    throw new Error("Google Docs document has no body content");
  }
  return document.body.content ?? [];
}

function findTab(tabs: DocsTab[], tabId: string): DocsTab | undefined {
  for (const tab of tabs) {
    if (tab.tabProperties?.tabId === tabId) return tab;
    const child = findTab(tab.childTabs ?? [], tabId);
    if (child) return child;
  }
  return undefined;
}

function requireSourceRange(
  value: { startIndex?: number; endIndex?: number },
  label: string,
): { startIndex: number; endIndex: number } {
  const startIndex = value.startIndex ?? 0;
  const endIndex = value.endIndex;
  if (
    !Number.isInteger(startIndex) ||
    typeof endIndex !== "number" ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex < startIndex
  ) {
    throw new Error(`Google Docs ${label} has an invalid source range`);
  }
  return { startIndex, endIndex };
}

function structuralElementLabel(element: DocsStructuralElement): string {
  if (element.table) return "TABLE";
  if (element.tableOfContents) return "TABLE_OF_CONTENTS";
  if (element.sectionBreak) return "SECTION_BREAK";
  return "STRUCTURAL_ELEMENT";
}

function paragraphElementLabel(element: DocsParagraphElement): string {
  if (element.inlineObjectElement) return "INLINE_OBJECT";
  if (element.footnoteReference) return "FOOTNOTE";
  if (element.pageBreak) return "PAGE_BREAK";
  if (element.columnBreak) return "COLUMN_BREAK";
  if (element.autoText) return "AUTO_TEXT";
  if (element.equation) return "EQUATION";
  return "PARAGRAPH_ELEMENT";
}

function containsSuggestionMetadata(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some(containsSuggestionMetadata);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key.startsWith("suggested")) return true;
    if (containsSuggestionMetadata(nested)) return true;
  }
  return false;
}

function countTrailingNewlines(value: string): number {
  let count = 0;
  for (let index = value.length - 1; index >= 0 && value[index] === "\n"; index -= 1) {
    count += 1;
  }
  return count;
}

function mapFlatRange(
  flat: FlattenedTabBody,
  flatStart: number,
  flatEnd: number,
):
  | {
      tabId: string;
      segmentId: "body";
      startIndex: number;
      endIndex: number;
    }
  | GoogleDocsTextRefusal {
  const overlapping = flat.segments.filter(
    (segment) => segment.flatStart < flatEnd && segment.flatEnd > flatStart,
  );
  if (overlapping.length === 0) return refused("invalid_range");
  if (overlapping.some((segment) => segment.kind !== "text")) {
    return refused("structural_boundary");
  }

  let cursor = flatStart;
  let docsCursor: number | undefined;
  let docsStart: number | undefined;
  let tabId: string | undefined;
  let segmentId: "body" | undefined;

  for (const segment of overlapping) {
    if (segment.kind !== "text") return refused("structural_boundary");
    const partStart = Math.max(flatStart, segment.flatStart);
    const partEnd = Math.min(flatEnd, segment.flatEnd);
    if (partStart !== cursor) return refused("non_contiguous_range");

    const partDocsStart =
      segment.docsStartIndex + (partStart - segment.flatStart);
    const partDocsEnd =
      segment.docsStartIndex + (partEnd - segment.flatStart);
    if (tabId !== undefined) {
      if (tabId !== segment.tabId || segmentId !== segment.segmentId) {
        return refused("multiple_segments");
      }
      if (docsCursor !== partDocsStart) {
        return refused("non_contiguous_range");
      }
    } else {
      tabId = segment.tabId;
      segmentId = segment.segmentId;
      docsStart = partDocsStart;
    }
    docsCursor = partDocsEnd;
    cursor = partEnd;
  }

  if (
    cursor !== flatEnd ||
    docsStart === undefined ||
    docsCursor === undefined ||
    tabId === undefined ||
    segmentId === undefined
  ) {
    return refused("non_contiguous_range");
  }
  return {
    tabId,
    segmentId,
    startIndex: docsStart,
    endIndex: docsCursor,
  };
}

function rangeTouchesStructure(
  flat: FlattenedTabBody,
  flatStart: number,
  flatEnd: number,
): boolean {
  return flat.segments.some(
    (segment) =>
      segment.kind !== "text" &&
      segment.flatStart < flatEnd &&
      segment.flatEnd > flatStart,
  );
}

function segmentAt(
  flat: FlattenedTabBody,
  flatIndex: number,
): GoogleDocsTextSegment | undefined {
  return flat.segments.find(
    (segment) =>
      segment.flatStart <= flatIndex && flatIndex < segment.flatEnd,
  );
}

function isUtf16Boundary(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) return true;
  const previous = value.charCodeAt(index - 1);
  const current = value.charCodeAt(index);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function containsDisallowedControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x20 && codeUnit !== 0x09 && codeUnit !== 0x0a) {
      return true;
    }
  }
  return false;
}

function refused(
  reason: GoogleDocsTextRefusalReason,
): GoogleDocsTextRefusal {
  return { kind: "refused", reason };
}
