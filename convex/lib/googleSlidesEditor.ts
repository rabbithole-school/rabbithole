import {
  StalePresentationRevisionError,
  batchUpdatePresentation,
  getPresentation,
  type GoogleSlidesPage,
  type GoogleSlidesPageElement,
  type GoogleSlidesPresentation,
} from "./googleSlidesApi";

const MAX_VIEW_CHARACTERS = 60_000;

export type GoogleSlidesEditorCommand =
  | {
      command: "replace_text";
      base_revision: string;
      slide_object_id: string;
      object_id: string;
      expected_text: string;
      new_text: string;
    }
  | {
      command: "set_speaker_notes";
      base_revision: string;
      slide_object_id: string;
      expected_text: string;
      new_text: string;
    }
  | {
      command: "append_slide";
      base_revision: string;
      layout_from_slide_object_id: string;
      after_slide_object_id?: string;
      placeholders: { title?: string; body?: string };
    };

type BatchRequest =
  | {
      deleteText: {
        objectId: string;
        textRange: { type: "ALL" };
      };
    }
  | {
      insertText: {
        objectId: string;
        insertionIndex: 0;
        text: string;
      };
    }
  | {
      createSlide: {
        objectId: string;
        insertionIndex: number;
        slideLayoutReference: { layoutId: string };
        placeholderIdMappings: Array<{
          layoutPlaceholder: { type: string; index: number };
          objectId: string;
        }>;
      };
    };

interface TextTarget {
  objectId: string;
  role: "title" | "body" | "text";
  text: string;
  editable: boolean;
  refusal?: "MIXED_STYLE_TEXT" | "NOT_EDITABLE_HERE";
}

interface SlideProjection {
  slideObjectId: string;
  layoutId?: string;
  textTargets: TextTarget[];
  speakerNotesObjectId?: string;
  speakerNotes: string;
  speakerNotesEditable: boolean;
  speakerNotesRefusal?: "MIXED_STYLE_TEXT" | "NOT_EDITABLE_HERE";
  unsupported: Map<string, number>;
}

interface PresentationSession {
  presentationId: string;
  principalKey: string;
  revisionId: string;
  truncated: boolean;
  title?: string;
  slides: SlideProjection[];
  layouts: Map<string, GoogleSlidesPage>;
}

type OperationRecord =
  | { fingerprint: string; status: "pending" }
  | { fingerprint: string; status: "completed"; result: string };

export class GoogleSlidesEditor {
  private readonly sessions = new Map<string, PresentationSession>();
  private readonly operations = new Map<string, OperationRecord>();

  async view(
    token: string,
    presentationId: string,
    principalKey: string,
  ): Promise<string> {
    const session = await fetchSession(token, presentationId, principalKey);
    this.sessions.set(presentationId, session);
    return formatView(session);
  }

  async execute(
    token: string,
    presentationId: string,
    principalKey: string,
    input: GoogleSlidesEditorCommand,
    context: { toolUseId: string },
  ): Promise<string> {
    const toolUseId = context.toolUseId.trim();
    if (!toolUseId) return "IDEMPOTENCY_KEY_MISSING: the editor requires the tool_use id.";
    const fingerprint = JSON.stringify([presentationId, principalKey, input]);
    const prior = this.operations.get(toolUseId);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        return "IDEMPOTENCY_CONFLICT: this tool_use id was already used for a different command.";
      }
      if (prior.status === "completed") return prior.result;
      return "IDEMPOTENCY_UNCERTAIN: this operation may or may not have been applied; view the presentation to check before retrying. This call will not be replayed.";
    }
    this.operations.set(toolUseId, { fingerprint, status: "pending" });
    const result = await this.write(token, presentationId, principalKey, input);
    this.operations.set(toolUseId, { fingerprint, status: "completed", result });
    return result;
  }

  private async write(
    token: string,
    presentationId: string,
    principalKey: string,
    input: GoogleSlidesEditorCommand,
  ): Promise<string> {
    const session = this.sessions.get(presentationId);
    if (!session || session.principalKey !== principalKey) {
      return "READ_REQUIRED: view this presentation as this principal in the current edit session before changing it.";
    }
    if (session.truncated) {
      return "READ_REQUIRED: the prior presentation view was TRUNCATED, so it cannot be edited safely.";
    }
    if (input.base_revision !== session.revisionId) return "STALE_DECK: view again";

    const prepared = prepareWrite(session, input);
    if (typeof prepared === "string") return prepared;
    try {
      await batchUpdatePresentation(
        token,
        presentationId,
        prepared.requests,
        session.revisionId,
      );
    } catch (error) {
      if (error instanceof StalePresentationRevisionError) {
        this.sessions.delete(presentationId);
        return "STALE_DECK: view again";
      }
      throw error;
    }

    let refreshed: PresentationSession;
    try {
      refreshed = await fetchSession(token, presentationId, principalKey);
    } catch (error) {
      this.sessions.delete(presentationId);
      const detail = error instanceof Error ? error.message : String(error);
      return `WRITE_APPLIED_REFRESH_FAILED: the edit was accepted, but the updated presentation could not be read (${detail}). View again before another edit.`;
    }
    if (!prepared.verify(refreshed)) {
      this.sessions.delete(presentationId);
      return "EDIT_VERIFY_FAILED: Google Slides accepted the write, but the refetched presentation did not contain the expected edit. View again before another edit.";
    }
    this.sessions.set(presentationId, refreshed);
    return `EDIT_APPLIED\nRevision: ${refreshed.revisionId}`;
  }
}

export function parseGoogleSlidesEditorInput(value: unknown): GoogleSlidesEditorCommand {
  if (!isRecord(value) || typeof value.command !== "string") {
    throw new Error("Google Slides editor input must include a command.");
  }
  const base = requireString(value.base_revision, "base_revision");
  switch (value.command) {
    case "replace_text":
      return {
        command: "replace_text", base_revision: base,
        slide_object_id: requireString(value.slide_object_id, "slide_object_id"),
        object_id: requireString(value.object_id, "object_id"),
        expected_text: requireString(value.expected_text, "expected_text"),
        new_text: requireString(value.new_text, "new_text"),
      };
    case "set_speaker_notes":
      return {
        command: "set_speaker_notes", base_revision: base,
        slide_object_id: requireString(value.slide_object_id, "slide_object_id"),
        expected_text: requireString(value.expected_text, "expected_text"),
        new_text: requireString(value.new_text, "new_text"),
      };
    case "append_slide":
      if (!isRecord(value.placeholders)) throw new Error("placeholders must be an object.");
      return {
        command: "append_slide", base_revision: base,
        layout_from_slide_object_id: requireString(value.layout_from_slide_object_id, "layout_from_slide_object_id"),
        ...(value.after_slide_object_id === undefined ? {} : { after_slide_object_id: requireString(value.after_slide_object_id, "after_slide_object_id") }),
        placeholders: optionalPlaceholders(value.placeholders),
      };
    default:
      throw new Error("Unsupported Google Slides editor command.");
  }
}

function prepareWrite(
  session: PresentationSession,
  input: GoogleSlidesEditorCommand,
): { requests: BatchRequest[]; verify: (session: PresentationSession) => boolean } | string {
  if (input.command === "append_slide") return prepareAppend(session, input);
  const slide = session.slides.find((candidate) => candidate.slideObjectId === input.slide_object_id);
  if (!slide) return "NOT_EDITABLE_HERE: the slide was not in the last viewed presentation.";
  const target = input.command === "replace_text"
    ? slide.textTargets.find((candidate) => candidate.objectId === input.object_id)
    : slide.speakerNotesObjectId
      ? {
          objectId: slide.speakerNotesObjectId,
          text: slide.speakerNotes,
          editable: slide.speakerNotesEditable,
          refusal: slide.speakerNotesRefusal,
        }
      : undefined;
  if (!target) return "NOT_EDITABLE_HERE: that target was not editable in the last viewed presentation.";
  if (!target.editable) {
    const refusal = "refusal" in target ? target.refusal : undefined;
    return `${refusal ?? "NOT_EDITABLE_HERE"}: this text box cannot be safely replaced.`;
  }
  if (target.text !== input.expected_text) return "TEXT_MISMATCH: expected_text does not exactly match the last viewed text.";
  if (target.text === input.new_text) return `NO_CHANGE\nRevision: ${session.revisionId}`;
  const requests = replaceRequests(target.objectId, target.text, input.new_text);
  return {
    requests,
    verify: (refreshed) => {
      const refreshedSlide = refreshed.slides.find((candidate) => candidate.slideObjectId === slide.slideObjectId);
      if (!refreshedSlide) return false;
      if (input.command === "set_speaker_notes") return refreshedSlide.speakerNotes === input.new_text;
      return refreshedSlide.textTargets.some(
        (candidate) => candidate.objectId === target.objectId && candidate.text === input.new_text,
      );
    },
  };
}

function prepareAppend(
  session: PresentationSession,
  input: Extract<GoogleSlidesEditorCommand, { command: "append_slide" }>,
): { requests: BatchRequest[]; verify: (session: PresentationSession) => boolean } | string {
  const source = session.slides.find((slide) => slide.slideObjectId === input.layout_from_slide_object_id);
  const layoutId = source?.layoutId;
  const layout = layoutId ? session.layouts.get(layoutId) : undefined;
  if (!layoutId || !layout) return "LAYOUT_NOT_SUPPORTED: the source slide does not have a supported layout.";
  const insertionIndex = input.after_slide_object_id === undefined
    ? session.slides.length
    : session.slides.findIndex((slide) => slide.slideObjectId === input.after_slide_object_id) + 1;
  if (insertionIndex === 0) return "LAYOUT_NOT_SUPPORTED: after_slide_object_id was not in the last viewed presentation.";
  const mappings: Array<{ role: "title" | "body"; objectId: string; type: string; index: number; text: string }> = [];
  for (const role of ["title", "body"] as const) {
    const text = input.placeholders[role];
    if (text === undefined) continue;
    const placeholder = findLayoutPlaceholder(layout, role);
    if (!placeholder) return `LAYOUT_NOT_SUPPORTED: this layout has no ${role} placeholder.`;
    mappings.push({ role, objectId: mintedObjectId(), text, ...placeholder });
  }
  const newSlideObjectId = mintedObjectId();
  const requests: BatchRequest[] = [{
    createSlide: {
      objectId: newSlideObjectId,
      insertionIndex,
      slideLayoutReference: { layoutId },
      placeholderIdMappings: mappings.map(({ objectId, type, index }) => ({
        layoutPlaceholder: { type, index }, objectId,
      })),
    },
  }];
  for (const mapping of mappings) requests.push(...replaceRequests(mapping.objectId, "", mapping.text));
  return {
    requests,
    verify: (refreshed) => {
      const slide = refreshed.slides.find((candidate) => candidate.slideObjectId === newSlideObjectId);
      return refreshed.slides.length === session.slides.length + 1 &&
        !!slide &&
        slide.layoutId === layoutId &&
        mappings.every((mapping) =>
        slide.textTargets.some((target) => target.objectId === mapping.objectId && target.text === mapping.text),
      );
    },
  };
}

function replaceRequests(objectId: string, oldText: string, newText: string): BatchRequest[] {
  return [
    ...(oldText === "" ? [] : [{ deleteText: { objectId, textRange: { type: "ALL" as const } } }]),
    ...(newText === "" ? [] : [{ insertText: { objectId, insertionIndex: 0 as const, text: newText } }]),
  ];
}

async function fetchSession(token: string, presentationId: string, principalKey: string): Promise<PresentationSession> {
  const presentation = await getPresentation(token, presentationId);
  if (!presentation.revisionId) throw new Error("Google Slides did not return a revisionId");
  return projectPresentation(presentation, presentationId, principalKey);
}

function projectPresentation(
  presentation: GoogleSlidesPresentation,
  presentationId: string,
  principalKey: string,
): PresentationSession {
  const slides = (presentation.slides ?? []).flatMap((slide) => {
    if (!slide.objectId) return [];
    const projection = projectSlide(slide);
    return [projection];
  });
  const session: PresentationSession = {
    presentationId, principalKey, revisionId: presentation.revisionId!,
    title: presentation.title, truncated: false, slides,
    layouts: new Map((presentation.layouts ?? []).flatMap((layout) => layout.objectId ? [[layout.objectId, layout] as const] : [])),
  };
  session.truncated = renderView(session).length > MAX_VIEW_CHARACTERS;
  return session;
}

function projectSlide(slide: GoogleSlidesPage): SlideProjection {
  const slideUnsupported = new Map<string, number>();
  const textTargets: TextTarget[] = [];
  for (const element of slide.pageElements ?? []) {
    const target = projectTextTarget(element, slideUnsupported);
    if (target) textTargets.push(target);
  }
  const notes = slide.slideProperties?.notesPage;
  const speakerNotesObjectId = notes?.notesProperties?.speakerNotesObjectId;
  const notesElement = (notes?.pageElements ?? []).find((element) => element.objectId === speakerNotesObjectId);
  const noteClassification = speakerNotesObjectId
    ? classifyText(notesElement?.shape?.text?.textElements ?? [])
    : { editable: false, refusal: "NOT_EDITABLE_HERE" as const };
  return {
    slideObjectId: slide.objectId!,
    layoutId: slide.slideProperties?.layoutObjectId,
    textTargets,
    speakerNotesObjectId,
    speakerNotes: notesElement ? textFromElement(notesElement) : "",
    speakerNotesEditable: !!speakerNotesObjectId && noteClassification.editable,
    ...(noteClassification.refusal ? { speakerNotesRefusal: noteClassification.refusal } : {}),
    unsupported: slideUnsupported,
  };
}

function projectTextTarget(element: GoogleSlidesPageElement, unsupported: Map<string, number>): TextTarget | undefined {
  if (!element.objectId || !element.shape) {
    count(unsupported, element.shape ? "shape_without_id" : elementType(element));
    return undefined;
  }
  const textElements = element.shape.text?.textElements ?? [];
  const classification = classifyText(textElements);
  const text = textFromElements(textElements);
  if (!classification.editable || !ordinaryShape(element.shape.shapeType)) {
    count(
      unsupported,
      classification.refusal === "MIXED_STYLE_TEXT" ? "mixed_style_text" :
        classification.refusal === "NOT_EDITABLE_HERE" ? "bulleted_text" :
          element.shape.shapeType ?? "shape",
    );
  }
  return {
    objectId: element.objectId,
    role: roleForPlaceholder(element.shape.placeholder?.type),
    text,
    editable: classification.editable && ordinaryShape(element.shape.shapeType),
    ...(classification.refusal ? { refusal: classification.refusal } :
      !ordinaryShape(element.shape.shapeType) ? { refusal: "NOT_EDITABLE_HERE" as const } : {}),
  };
}

function classifyText(elements: Array<{
  textRun?: { style?: { link?: unknown; [key: string]: unknown } };
  paragraphMarker?: {
    bullet?: unknown;
    style?: Record<string, unknown>;
  };
  autoText?: unknown;
}>): {
  editable: boolean;
  refusal?: "MIXED_STYLE_TEXT" | "NOT_EDITABLE_HERE";
} {
  const runs = elements.filter((item) => item.textRun);
  const paragraphs = elements.filter((item) => item.paragraphMarker);
  if (elements.length === 0) return { editable: true };
  if (
    elements.some((item) => !item.textRun && !item.paragraphMarker) ||
    paragraphs.length === 0 ||
    paragraphs.some((paragraph) => !!paragraph.paragraphMarker?.bullet)
  ) {
    return { editable: false, refusal: "NOT_EDITABLE_HERE" };
  }
  const runStyles = new Set(
    runs.map((run) => canonicalJson(run.textRun?.style ?? {})),
  );
  const paragraphStyles = new Set(
    paragraphs.map((paragraph) =>
      canonicalJson(paragraph.paragraphMarker?.style ?? {}),
    ),
  );
  if (
    runs.some((run) => !!run.textRun?.style?.link) ||
    runStyles.size > 1 ||
    paragraphStyles.size > 1
  ) {
    return { editable: false, refusal: "MIXED_STYLE_TEXT" };
  }
  return { editable: true };
}

function textFromElement(element: GoogleSlidesPageElement): string {
  return textFromElements(element.shape?.text?.textElements ?? []);
}

function textFromElements(elements: { textRun?: { content?: string } }[]): string {
  return elements.map((element) => element.textRun?.content ?? "").join("").replace(/\n$/, "");
}

function findLayoutPlaceholder(layout: GoogleSlidesPage, role: "title" | "body"): { type: string; index: number } | undefined {
  const validTypes = role === "title" ? new Set(["TITLE", "CENTERED_TITLE"]) : new Set(["BODY"]);
  for (const element of layout.pageElements ?? []) {
    const placeholder = element.shape?.placeholder;
    if (
      placeholder?.type &&
      (placeholder.index === undefined || Number.isInteger(placeholder.index)) &&
      validTypes.has(placeholder.type)
    ) {
      return { type: placeholder.type, index: placeholder.index ?? 0 };
    }
  }
  return undefined;
}

function formatView(session: PresentationSession): string {
  const result = renderView(session);
  return result.length <= MAX_VIEW_CHARACTERS
    ? result
    : `${result.slice(0, MAX_VIEW_CHARACTERS - 52)}\nTRUNCATED: output capped; edits are refused.`;
}

function renderView(session: PresentationSession): string {
  const lines = [
    `Presentation: ${session.presentationId}`,
    ...(session.title ? [`Title: ${session.title}`] : []),
    `Revision: ${session.revisionId}`,
    ...session.slides.flatMap((slide, index) => [
      `Slide ${index + 1}: slide_object_id=${slide.slideObjectId} layout_id=${slide.layoutId ?? "none"}`,
      ...slide.textTargets.filter((target) => target.editable).map((target) =>
        `  ${target.role}: object_id=${target.objectId} text=${JSON.stringify(target.text)}`,
      ),
      `  speaker_notes: ${JSON.stringify(slide.speakerNotes)}`,
      ...(slide.unsupported.size
        ? [`  Unsupported/complex objects: ${[...slide.unsupported].map(([type, countValue]) => `${type}=${countValue}`).join(", ")}`]
        : []),
    ]),
  ];
  return lines.join("\n");
}

function optionalPlaceholders(value: Record<string, unknown>): { title?: string; body?: string } {
  const result: { title?: string; body?: string } = {};
  for (const key of ["title", "body"] as const) {
    if (value[key] !== undefined) result[key] = requireString(value[key], `placeholders.${key}`);
  }
  if (Object.keys(value).some((key) => key !== "title" && key !== "body")) {
    throw new Error("placeholders may include only title and body.");
  }
  return result;
}

function mintedObjectId(): string {
  return `rh_${crypto.randomUUID().replace(/-/g, "")}`;
}
function roleForPlaceholder(type: string | undefined): "title" | "body" | "text" {
  return type === "TITLE" || type === "CENTERED_TITLE" ? "title" : type === "BODY" ? "body" : "text";
}
function ordinaryShape(type: string | undefined): boolean {
  return type === "TEXT_BOX" || type === "RECTANGLE";
}
function elementType(element: GoogleSlidesPageElement): string {
  const kind = [
    "elementGroup",
    "shape",
    "image",
    "video",
    "line",
    "table",
    "wordArt",
    "sheetsChart",
    "speakerSpotlight",
  ].find((key) => key in element);
  return kind ?? "unknown";
}
function count(values: Map<string, number>, key: string, increment = 1) {
  values.set(key, (values.get(key) ?? 0) + increment);
}
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
