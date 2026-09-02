/**
 * The in-house slide scene — the ONE document both frontends render, the AI
 * patches, and the exporters read. Framework-agnostic on purpose: no React, no
 * Convex, no DOM, no react-native. Vendored to native via
 * `native/scripts/sync-vendor.js` (native cannot import across the repo root).
 *
 * Design plan: review/slides-in-house-plan.html. The rules that are load-bearing
 * for every consumer, and why:
 *
 *  • FIXED LOGICAL CANVAS (1280x720). Renderers scale uniformly; nothing in the
 *    document is ever expressed in device pixels, so a deck authored on an iPad
 *    lays out identically on the web and in a .pptx.
 *  • TOP-LEFT ORIGIN, +x right, +y down. Rotation is CLOCKWISE DEGREES about
 *    the element's own centre.
 *  • w/h ARE CANONICAL. Never store scaleX/scaleY — exporters need real
 *    dimensions, and deriving them back from a scale factor is lossy.
 *  • Z-ORDER IS `elementIds` ORDER (back to front). There is deliberately no
 *    `z` field: two orderings that can disagree is a bug generator.
 *  • ASSETS BY REFERENCE. Photos and videos carry an `assetId` into Convex file storage,
 *    never base64 — a scene must stay small enough to sit in an LLM context and
 *    to ship in a Convex document.
 *  • TEXT AND VIDEO ARE AXIS-ALIGNED IN v1. `rotation` stays on the type, but
 *    `normalizeElement` pins it to 0 for both. Text stays axis-aligned so the
 *    editors position a plain TextInput/textarea over a text box instead of
 *    placing a caret inside a rotated, scaled coordinate space; PowerPoint
 *    media has no rotation support, so video stays axis-aligned for export parity.
 *  • STYLE IS A CLOSED VOCABULARY. Not arbitrary CSS, not RN style objects —
 *    every renderer and every exporter must be able to honour all of it.
 */

export const SLIDES_SCHEMA_VERSION = 1 as const;

/** The logical canvas. Every coordinate below is in these units. */
export const CANVAS_W = 1280;
export const CANVAS_H = 720;

/** Smallest element edge, logical units — below this it can't be grabbed. */
export const MIN_ELEMENT_SIZE = 24;

/** Guardrails so one bad tool call can't produce an unusable deck. */
export const MAX_SLIDES_PER_DECK = 100;
export const MAX_ELEMENTS_PER_SLIDE = 60;
export const MAX_TEXT_LENGTH = 4000;
export const MAX_OPS_PER_BATCH = 50;

/** Revisions wrap here rather than saturating at the float ceiling. */
export const MAX_REVISION = 2 ** 40;

export type ElementType = "text" | "image" | "video" | "rect" | "ellipse" | "line";

export type Frame = {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Clockwise degrees about the box centre. Always 0 for text in v1. */
  rotation: number;
};

export type TextAlign = "left" | "center" | "right";
export type VerticalAlign = "top" | "middle" | "bottom";

export type TextStyle = {
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: TextAlign;
  verticalAlign: VerticalAlign;
};

export type ShapeStyle = {
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
};

export type TextElement = {
  id: string;
  type: "text";
  frame: Frame;
  text: string;
  style: TextStyle;
};

export type ImageElement = {
  id: string;
  type: "image";
  frame: Frame;
  /** Convex file-storage id. Never inline bytes. */
  assetId: string;
  alt: string;
};

export type VideoElement = {
  id: string;
  type: "video";
  frame: Frame;
  /** Convex file-storage id. Never inline bytes. */
  assetId: string;
  alt: string;
};

export type ShapeElement = {
  id: string;
  type: "rect" | "ellipse" | "line";
  frame: Frame;
  style: ShapeStyle;
};

export type SlideElement = TextElement | ImageElement | VideoElement | ShapeElement;

export type Slide = {
  id: string;
  background: string;
  /** Back to front. THE z-order. */
  elementIds: string[];
  elements: Record<string, SlideElement>;
  speakerNotes?: string;
};

export type Deck = {
  schemaVersion: typeof SLIDES_SCHEMA_VERSION;
  title: string;
  width: typeof CANVAS_W;
  height: typeof CANVAS_H;
  slides: Slide[];
  /** Bumped once per accepted mutation batch; the AI's staleness check. */
  revision: number;
};

// ─── Defaults ────────────────────────────────────────────────────────────

const DEFAULT_TEXT_STYLE: TextStyle = {
  fontSize: 28,
  bold: false,
  italic: false,
  color: "#222656",
  align: "left",
  verticalAlign: "top",
};

const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  fill: "#AD60BF",
  stroke: null,
  strokeWidth: 0,
};

const HEX = /^#[0-9a-fA-F]{6}$/;

// ─── Normalization ───────────────────────────────────────────────────────

function clampNum(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : fallback;
  return Math.min(hi, Math.max(lo, v));
}

function normColor(c: unknown, fallback: string): string {
  return typeof c === "string" && HEX.test(c) ? c : fallback;
}

/**
 * Bring a frame into range. Deliberately CLAMPS rather than rejects: an AI that
 * puts a box slightly off-canvas should get a usable slide, not an error. Sizes
 * are clamped before position so a huge box can still be placed.
 */
export function normalizeFrame(
  input: Partial<Frame> | undefined,
  axisAligned: boolean,
): Frame {
  const w = clampNum(input?.w, MIN_ELEMENT_SIZE, CANVAS_W * 2, 300);
  const h = clampNum(input?.h, MIN_ELEMENT_SIZE, CANVAS_H * 2, 150);
  // Keep a grabbable sliver on-canvas. The old range let an element sit
  // ENTIRELY outside 1280x720; with no layers list and no undo, a child who
  // flicked something off the edge had simply lost it (found by review).
  const x = clampNum(input?.x, MIN_ELEMENT_SIZE - w, CANVAS_W - MIN_ELEMENT_SIZE, 0);
  const y = clampNum(input?.y, MIN_ELEMENT_SIZE - h, CANVAS_H - MIN_ELEMENT_SIZE, 0);
  // Text and video stay axis-aligned. PowerPoint media has no rotation support,
  // so accepting rotated video would make an export silently change the deck.
  const rawRot = clampNum(input?.rotation, -3600, 3600, 0);
  const rotation = axisAligned ? 0 : ((rawRot % 360) + 360) % 360;
  return { x, y, w, h, rotation };
}

/**
 * Normalize an untrusted element (AI output, a client patch, a seed fixture)
 * into a canonical one. Returns null when the input can't be salvaged — an
 * unknown type, or an image with no asset.
 */
export function normalizeElement(raw: unknown, id: string): SlideElement | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const type = o.type;

  if (type === "text") {
    const st = (o.style ?? {}) as Record<string, unknown>;
    return {
      id,
      type: "text",
      frame: normalizeFrame(o.frame as Partial<Frame>, true),
      text: String(o.text ?? "").slice(0, MAX_TEXT_LENGTH),
      style: {
        fontSize: clampNum(st.fontSize, 8, 200, DEFAULT_TEXT_STYLE.fontSize),
        bold: st.bold === true,
        italic: st.italic === true,
        color: normColor(st.color, DEFAULT_TEXT_STYLE.color),
        align: (["left", "center", "right"] as const).includes(st.align as TextAlign)
          ? (st.align as TextAlign)
          : DEFAULT_TEXT_STYLE.align,
        verticalAlign: (["top", "middle", "bottom"] as const).includes(
          st.verticalAlign as VerticalAlign,
        )
          ? (st.verticalAlign as VerticalAlign)
          : DEFAULT_TEXT_STYLE.verticalAlign,
      },
    };
  }

  if (type === "image" || type === "video") {
    const assetId = typeof o.assetId === "string" ? o.assetId.trim() : "";
    // Media with no asset would render as a hole — reject rather than ship it.
    if (!assetId) return null;
    return {
      id,
      type,
      frame: normalizeFrame(o.frame as Partial<Frame>, type === "video"),
      assetId,
      alt: String(o.alt ?? "").slice(0, 500),
    };
  }

  if (type === "rect" || type === "ellipse" || type === "line") {
    const st = (o.style ?? {}) as Record<string, unknown>;
    const fill = st.fill === null ? null : normColor(st.fill, DEFAULT_SHAPE_STYLE.fill!);
    const stroke = st.stroke == null ? null : normColor(st.stroke, "#222656");
    return {
      id,
      type,
      frame: normalizeFrame(o.frame as Partial<Frame>, false),
      style: {
        // A line with no stroke is invisible; give it one rather than a fill.
        fill: type === "line" ? null : fill,
        stroke: type === "line" && stroke === null ? "#222656" : stroke,
        strokeWidth: clampNum(st.strokeWidth, 0, 64, type === "line" ? 4 : 0),
      },
    };
  }

  return null;
}

/**
 * What each "insert a …" affordance drops onto the slide.
 *
 * SHARED because the two editors must insert byte-identical elements — a web
 * rectangle and an iPad rectangle that differ in size or colour is a
 * scholar-facing parity gap, and keeping the presets in each frontend made that
 * drift a matter of discipline rather than construction. Centred-ish on the
 * 1280x720 canvas so a fresh element lands somewhere visible.
 */
export const NEW_ELEMENT_PRESETS = {
  text: () => ({
    type: "text" as const,
    frame: { x: 440, y: 300, w: 400, h: 120, rotation: 0 },
    text: "Text",
  }),
  rect: () => ({
    type: "rect" as const,
    frame: { x: 490, y: 260, w: 300, h: 200, rotation: 0 },
  }),
  ellipse: () => ({
    type: "ellipse" as const,
    frame: { x: 490, y: 260, w: 300, h: 200, rotation: 0 },
  }),
  line: () => ({
    type: "line" as const,
    frame: { x: 440, y: 346, w: 400, h: 48, rotation: 0 },
    style: { stroke: "#222656", strokeWidth: 4 },
  }),
  image: (assetId: string) => ({
    type: "image" as const,
    assetId,
    alt: "Photo",
    frame: { x: 390, y: 160, w: 500, h: 380, rotation: 0 },
  }),
  video: (assetId: string) => ({
    type: "video" as const,
    assetId,
    alt: "Video",
    frame: { x: 320, y: 120, w: 640, h: 480, rotation: 0 },
  }),
} as const;

/** The insert affordances, in the order both toolbars present them. */
export const INSERT_KINDS = ["text", "rect", "ellipse", "line"] as const;
export type InsertKind = (typeof INSERT_KINDS)[number];

/** ONE label per action, so the two surfaces cannot word it differently. */
export const SLIDES_COPY = {
  insert: { text: "Text", rect: "Rectangle", ellipse: "Ellipse", line: "Line" },
  sketch: "Sketch",
  sketchBusy: "Adding sketch…",
  media: "Media",
  mediaBusy: "Adding media…",
  // "Image", not "Photo"/"Picture" — the noun is standardized across every
  // slide media source (Andy, 2026-08-25). Literal camera actions on native
  // ("Take photo") legitimately keep "photo": there it names the artifact a
  // camera makes, not the element type.
  photo: "Image",
  photoBusy: "Adding image…",
  addSlide: "Add slide",
  addSlideBefore: "Add before",
  addSlideAfter: "Add after",
  slideTitle: (slideNumber: number) => `Slide ${slideNumber}`,
  deleteSlide: "Delete slide",
  deleteElement: "Delete",
  speakerNotes: "Speaker notes",
  present: "Present",
  printNotes: "Print notes",
  undo: "Undo",
  redo: "Redo",
  deleteSlideConfirmTitle: "Delete this slide?",
  deleteSlideConfirmBody: "This slide still has things on it. You can undo right after.",
  cancel: "Cancel",
  corruptDeck: "These slides couldn't be opened. Ask your teacher for help.",
  saveFailed: "That change didn't save — try again.",
} as const;

/**
 * "Make a picture" — the scholar-authored illustration source.
 *
 * WHY THIS LIVES IN `shared/`: the native and web editors were built in
 * parallel and independently invented DIFFERENT wording for the same six
 * strings ("Make it" vs "Make a picture", "Making…" vs "Making your
 * picture…", two different placeholders) plus two different alt-text rules.
 * Scholar-facing parity is the EXPERIENCE, not just the feature's existence
 * (CLAUDE.md), so the copy and the alt derivation live here once and both
 * surfaces import them — the same reason SLIDES_COPY above exists.
 *
 * Copy notes: "Make an image" is the illustration engine and "Find an image"
 * (FIND_IMAGE_COPY below) is the web search — the two sources deliberately
 * share the noun "image" (Andy, 2026-08-25: "image" everywhere, never
 * picture/photo) and split on the verb. The help line sets a seconds-long
 * expectation on purpose, because a kid staring at an unexplained pause taps
 * again.
 */
export const MAKE_PICTURE_MAX_PROMPT = 500;
export const MAKE_PICTURE_MAX_ALT = 120;

export const MAKE_PICTURE_COPY = {
  action: "Make an image",
  label: "Describe the image you want to make",
  placeholder: "e.g. a friendly robot watering a garden",
  help: "Your words become the image, so include what you want people to see.",
  submit: "Make it",
  busy: "Making your image…",
  cancel: SLIDES_COPY.cancel,
  errorFallback: "That image didn't work. Try describing it a different way.",
  altFallback: "An image",
} as const;

export type MakePictureResult =
  | {
      status: "generated";
      storageId: string;
      width?: number;
      height?: number;
    }
  | { status: "error"; error: string };

export type MakePictureOutcome =
  | {
      status: "success";
      assetId: string;
      alt: string;
      width?: number;
      height?: number;
    }
  | { status: "error"; message: string };

/**
 * Alt text for a generated image, derived from the scholar's own prompt.
 * Every generated image MUST carry this — the shared NEW_ELEMENT_PRESETS.image
 * default is "Photo", which is both wrong and useless to a screen reader.
 * Capped at a word boundary so alt stays a caption, not a paragraph.
 */
export function deriveSlideImageAlt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (!collapsed) return MAKE_PICTURE_COPY.altFallback;
  let capped = collapsed.slice(0, MAKE_PICTURE_MAX_ALT);
  if (collapsed.length > MAKE_PICTURE_MAX_ALT) {
    const lastSpace = capped.lastIndexOf(" ");
    if (lastSpace > 0) capped = capped.slice(0, lastSpace);
  }
  capped = capped.trimEnd();
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

/** Fold the server contract into the two states both slide editors handle. */
export function resolveMakePictureResult(
  result: MakePictureResult,
  prompt: string,
): MakePictureOutcome {
  if (result.status === "generated") {
    return {
      status: "success",
      assetId: result.storageId,
      alt: deriveSlideImageAlt(prompt),
      width: result.width,
      height: result.height,
    };
  }
  return {
    status: "error",
    message: result.error.trim() || MAKE_PICTURE_COPY.errorFallback,
  };
}

/**
 * Whether the submit affordance may fire: a non-empty prompt, and no
 * generation already in flight. This is what makes a double-tap (or a second
 * Enter) a no-op rather than a second billed request.
 */
export function canSubmitMakePicture(prompt: string, busy: boolean): boolean {
  return !busy && prompt.trim().length > 0;
}

/**
 * "Find an image" — the web image search source (Brave Image Search behind a
 * Convex action; see review/slides-web-image-search-plan.html).
 *
 * Lives in `shared/` for the same reason MAKE_PICTURE_COPY does: the copy,
 * the request/result contract, and the submit gating must be identical on web
 * and native, and the two surfaces have already proven they diverge when left
 * to word the same feature independently.
 *
 * Copy notes: "Find" is the verb that separates this source from "Make an
 * image" (the illustration engine above); both share the noun "image". The
 * capped/unavailable strings mirror the tone of the generation flow's
 * kid-facing errors — calm, blame-free, retry-oriented.
 */
export const FIND_IMAGE_MAX_QUERY = 200;

export const FIND_IMAGE_COPY = {
  action: "Find an image",
  label: "Search the web for an image",
  placeholder: "e.g. Saturn V rocket launch",
  submit: "Search",
  busy: "Searching…",
  // Shown in the (fixed-height) results area before the first search, so the
  // panel never resizes when the grid arrives.
  idleHint: "Search the web, then tap an image to add it to your slide.",
  empty: "No images found — try different words.",
  // Shown when a shape filter hides every result of the current search.
  emptyForShape: "No images of that shape — try a different shape or search.",
  more: "More images",
  inserting: "Adding your image…",
  capped: "Image search is taking a break right now. Try again later.",
  unavailable: "Image search isn't available right now.",
  errorFallback: "That search didn't work. Try again.",
  insertErrorFallback: "That image couldn't be added. Try a different one.",
  cancel: SLIDES_COPY.cancel,
  altFallback: "An image",
  shapeLabel: "Shape",
  shapeAny: "Any",
  shapeSquare: "Square",
  shapeWide: "Wide",
  shapeTall: "Tall",
} as const;

/** Aspect-ratio filter for the results grid — a CLIENT-side filter over each
 * result's Brave-reported dimensions, because Brave has no shape request param. */
export type WebImageShape = "any" | "square" | "wide" | "tall";

export const WEB_IMAGE_SHAPES: readonly WebImageShape[] = [
  "any",
  "square",
  "wide",
  "tall",
] as const;

export function webImageShapeLabel(shape: WebImageShape): string {
  switch (shape) {
    case "square":
      return FIND_IMAGE_COPY.shapeSquare;
    case "wide":
      return FIND_IMAGE_COPY.shapeWide;
    case "tall":
      return FIND_IMAGE_COPY.shapeTall;
    default:
      return FIND_IMAGE_COPY.shapeAny;
  }
}

/** Square is within ~15% of 1:1; beyond that it's wide (landscape) or tall
 * (portrait). Tuned so ordinary 4:3 / 3:4 photos read as wide / tall. */
const SQUARE_RATIO_TOLERANCE = 0.18;

export function classifyWebImageShape(
  result: Pick<WebImageSearchResult, "width" | "height">,
): Exclude<WebImageShape, "any"> | null {
  const { width, height } = result;
  if (!width || !height || width <= 0 || height <= 0) return null;
  const ratio = width / height;
  if (ratio >= 1 - SQUARE_RATIO_TOLERANCE && ratio <= 1 + SQUARE_RATIO_TOLERANCE) {
    return "square";
  }
  return ratio > 1 ? "wide" : "tall";
}

/**
 * Filter results to a shape. "any" passes everything; a specific shape keeps
 * only results whose dimensions classify to it — results with no dimensions are
 * unclassifiable, so they appear only under "any" (never silently miscategorized).
 */
export function filterImagesByShape(
  results: readonly WebImageSearchResult[],
  shape: WebImageShape,
): WebImageSearchResult[] {
  if (shape === "any") return [...results];
  return results.filter((r) => classifyWebImageShape(r) === shape);
}

/**
 * One result in the picker grid. `thumbnailUrl` is Brave's image-proxy
 * rendition and is what the grid renders — the source site never sees a
 * request from the child's device. `imageUrl` is the original full-size URL;
 * only the SERVER dereferences it (download → Convex storage → assetId), with
 * `proxyUrl` (Brave's ~500px rendition) as the download fallback when the
 * origin refuses us. Dimensions are Brave-reported and feed
 * {@link imageFrameForSize} when the element lands.
 */
export type WebImageSearchResult = {
  resultId: string;
  thumbnailUrl: string;
  imageUrl: string;
  proxyUrl?: string;
  width?: number;
  height?: number;
  title?: string;
  sourceHost?: string;
  /**
   * Opaque server-issued HMAC over this result's downloadable URLs. The client
   * echoes it back to pickWebImage unchanged; the server fetches ONLY the URLs
   * signed inside it, never a client-supplied one — so pickWebImage cannot be
   * turned into an arbitrary-URL fetch proxy (SSRF). Treat it as a bearer
   * token: pass it through, never construct or edit it.
   */
  pickToken: string;
};

/** The search action's contract, folded to the states both dialogs render. */
export type WebImageSearchResponse =
  | { status: "results"; results: WebImageSearchResult[] }
  | { status: "capped" }
  | { status: "unavailable" }
  | { status: "error"; error: string };

/**
 * The pick action's contract. Mirrors MakePictureResult's "generated" arm so
 * both sources converge on the same insert path: the client receives a
 * registered storage id and emits an ordinary addElement op with it.
 */
export type WebImagePickResult =
  | { status: "inserted"; storageId: string; width?: number; height?: number }
  | { status: "error"; error: string };

/** Same double-submit protection as canSubmitMakePicture, search-side. */
export function canSubmitImageSearch(query: string, busy: boolean): boolean {
  return !busy && query.trim().length > 0;
}

/**
 * Alt text for a found image: the scholar's query, capped exactly like a
 * generation prompt. The query says what the kid was looking for, which is
 * honest alt; a page title from a stranger's website frequently is not. The
 * empty-query fallback ("An image") is shared with generation by design, so
 * this is deliberately the same derivation under a search-specific name.
 */
export function deriveFoundImageAlt(query: string): string {
  return deriveSlideImageAlt(query);
}

/**
 * The frame for an inserted image of known pixel size.
 *
 * The `NEW_ELEMENT_PRESETS.image` box is a fixed 500x380, and the canvas draws
 * images with `object-fit: contain`, so any image whose aspect differs renders
 * LETTERBOXED inside its own frame — a generated 1408x768 illustration showed
 * ~53px of white above and below. Fitting the frame to the image's real aspect
 * (inside the preset box, on the same centre) makes the element exactly the
 * picture, with no bands, whatever the model returns.
 *
 * Callers that cannot measure the image fall back to the preset box.
 */
export function imageFrameForSize(
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number; rotation: number } {
  const preset = NEW_ELEMENT_PRESETS.image("").frame;
  const centreX = preset.x + preset.w / 2;
  const centreY = preset.y + preset.h / 2;
  if (!(width > 0) || !(height > 0)) return { ...preset };

  const scale = Math.min(preset.w / width, preset.h / height);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  return {
    x: Math.round(centreX - w / 2),
    y: Math.round(centreY - h / 2),
    w,
    h,
    rotation: 0,
  };
}

/**
 * How far each additional in-flight "Make a picture" placeholder is offset.
 *
 * Submitting is optimistic and non-blocking, so a scholar can start a second
 * picture while the first is still generating. Without a cascade the two
 * placeholders (and then the two images) would sit exactly on top of each
 * other. Both frontends MUST cascade identically — the native and web lanes
 * independently chose 36px and 44px, which is precisely the drift this shared
 * module exists to prevent.
 */
export const PLACEHOLDER_CASCADE_STEP = 40;

/**
 * Where the Nth concurrent placeholder sits: the preset image box, cascaded by
 * its slot and clamped inside the canvas so a later slot cannot march off the
 * edge. The generated image's aspect is unknowable until the bytes arrive, so a
 * placeholder is always the full preset box; the finished element is fitted by
 * {@link resolvedImageFrame}.
 */
export function placeholderFrameForSlot(
  slot: number,
): { x: number; y: number; w: number; h: number; rotation: number } {
  const preset = NEW_ELEMENT_PRESETS.image("").frame;
  const step = Math.max(0, Math.floor(slot)) * PLACEHOLDER_CASCADE_STEP;
  return {
    x: Math.min(preset.x + step, Math.max(0, CANVAS_W - preset.w)),
    y: Math.min(preset.y + step, Math.max(0, CANVAS_H - preset.h)),
    w: preset.w,
    h: preset.h,
    rotation: 0,
  };
}

/**
 * The frame for the finished image: fitted to its real aspect (which is what
 * kills the white letterbox) but re-centred on the placeholder that stood in
 * for it, so it lands where the spinner was instead of snapping back to the
 * preset centre — which would make two concurrent images collide. An unknown
 * pixel size falls back to the preset box, so the element simply takes the
 * placeholder's frame.
 */
/**
 * The cascade slot a new picture should take.
 *
 * A slot is only "in flight" while its placeholder exists, so counting just
 * those makes every SEQUENTIAL generation reuse slot 0 — the second picture
 * lands exactly on top of the first and reads as "nothing happened" (observed
 * live: an urchin and an anemone stacked pixel-for-pixel). Images already on
 * the slide therefore occupy the leading slots too, so pictures made one after
 * another step down the canvas just like simultaneous ones.
 *
 * Placement only, and deliberately forgiving: if the scholar moves or deletes
 * an image the count drifts, which costs nothing but a different offset.
 */
export function nextCascadeSlot(
  inFlightSlots: readonly number[],
  existingImageCount: number,
): number {
  const used = new Set<number>(inFlightSlots);
  for (let i = 0; i < Math.max(0, existingImageCount); i++) used.add(i);
  let slot = 0;
  while (used.has(slot)) slot++;
  return slot;
}

/**
 * How close two frames have to be before a new insert treats a slot as taken.
 * Presets are integers, so this only forgives sub-pixel rounding.
 */
const INSERT_SLOT_TOLERANCE = 2;

/**
 * Where a toolbar-inserted element should land.
 *
 * {@link NEW_ELEMENT_PRESETS} are FIXED frames, so tapping "Rectangle" twice
 * used to stack two rectangles pixel-for-pixel: the second looked like nothing
 * had happened, and the pair was then impossible to separate by touch. Cascade
 * the preset by the same step the image placeholders use, skipping slots an
 * element already occupies, and clamp inside the canvas so a later slot cannot
 * march off the edge.
 *
 * Only the two TOOLBAR insert paths call this. `applySlideOps`'s addElement case
 * stays verbatim — the AI places elements at deliberate coordinates, and moving
 * them would break every deliberate layout it composes.
 */
export function nextInsertFrame(slide: Slide, preset: Frame): Frame {
  const maxX = Math.max(0, CANVAS_W - preset.w);
  const maxY = Math.max(0, CANVAS_H - preset.h);
  const occupied = slide.elementIds
    .map((id) => slide.elements[id])
    .filter((element): element is SlideElement => Boolean(element))
    .map((element) => element.frame);
  for (let slot = 0; ; slot += 1) {
    const step = slot * PLACEHOLDER_CASCADE_STEP;
    const x = Math.min(preset.x + step, maxX);
    const y = Math.min(preset.y + step, maxY);
    const taken = occupied.some(
      (frame) =>
        Math.abs(frame.x - x) <= INSERT_SLOT_TOLERANCE &&
        Math.abs(frame.y - y) <= INSERT_SLOT_TOLERANCE,
    );
    // Once both axes are clamped the cascade has nowhere further to go, so stop
    // rather than spin looking for a free slot that can no longer exist.
    if (!taken || (x >= maxX && y >= maxY)) return { ...preset, x, y };
  }
}

export function resolvedImageFrame(
  placeholder: { x: number; y: number; w: number; h: number },
  width?: number,
  height?: number,
): { x: number; y: number; w: number; h: number; rotation: number } {
  const fitted = imageFrameForSize(width ?? 0, height ?? 0);
  const centreX = placeholder.x + placeholder.w / 2;
  const centreY = placeholder.y + placeholder.h / 2;
  return {
    x: Math.round(centreX - fitted.w / 2),
    y: Math.round(centreY - fitted.h / 2),
    w: fitted.w,
    h: fitted.h,
    rotation: 0,
  };
}

export function emptySlide(id: string): Slide {
  return { id, background: "#ffffff", elementIds: [], elements: {} };
}

export function emptyDeck(title: string, firstSlideId: string): Deck {
  return {
    schemaVersion: SLIDES_SCHEMA_VERSION,
    title: title.trim().slice(0, 200) || "Untitled slides",
    width: CANVAS_W,
    height: CANVAS_H,
    slides: [emptySlide(firstSlideId)],
    revision: 0,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────

export type ValidationResult = { ok: true; deck: Deck } | { ok: false; errors: string[] };

/**
 * Normalize ONE raw slide (untrusted map + order) into a canonical `Slide`,
 * reporting anything it had to drop. The single home for the slide-shaping rules
 * so `validateDeckCore` (lenient, salvages) and `applySlideOps`'s `addSlide`
 * content path (strict, refuses on any drop — used to restore a removed slide)
 * cannot drift apart. The passed `sid` is authoritative; `raw.id` is ignored.
 */
function normalizeSlideFromRaw(raw: unknown, sid: string): { slide: Slide; errors: string[] } {
  const errors: string[] = [];
  const s = (raw ?? {}) as Record<string, unknown>;
  const elementsRaw = (s.elements ?? {}) as Record<string, unknown>;
  const orderRaw = Array.isArray(s.elementIds) ? (s.elementIds as unknown[]) : [];

  // Null-prototype: a JSON key of `__proto__` on a normal object literal hits
  // the legacy prototype setter instead of creating an own property, so the
  // element vanished from JSON.stringify while surviving in elementIds —
  // accepted-write data loss (reproduced by review).
  const elements: Record<string, SlideElement> = Object.create(null);
  const elementIds: string[] = [];
  const seenElementIds = new Set<string>();

  // Order is authoritative, but tolerate an element present in the map and
  // missing from the order (append it) rather than silently dropping work.
  // Duplicate order entries render and EXPORT the same element twice.
  const ordered = Array.from(new Set(orderRaw.filter((x): x is string => typeof x === "string")));
  const extra = Object.keys(elementsRaw).filter((k) => !ordered.includes(k));
  for (const eid of [...ordered, ...extra]) {
    if (elementIds.length >= MAX_ELEMENTS_PER_SLIDE) {
      errors.push(`slide "${sid}" exceeds ${MAX_ELEMENTS_PER_SLIDE} elements`);
      break;
    }
    if (seenElementIds.has(eid)) continue;
    // `__proto__` / `constructor` / `prototype` cannot be safe own keys here.
    if (eid === "__proto__" || eid === "constructor" || eid === "prototype") {
      errors.push(`slide "${sid}": reserved element id "${eid}" dropped`);
      continue;
    }
    const norm = normalizeElement(
      Object.prototype.hasOwnProperty.call(elementsRaw, eid) ? elementsRaw[eid] : undefined,
      eid,
    );
    if (!norm) {
      errors.push(`slide "${sid}": element "${eid}" is invalid and was dropped`);
      continue;
    }
    elements[eid] = norm;
    elementIds.push(eid);
    seenElementIds.add(eid);
  }

  // Empty speaker notes are canonicalized to ABSENT (not ""), so "clear the
  // notes" and "never had notes" are one state — which is what lets
  // `setSpeakerNotes` be exactly invertible (see the op + `invertOps`).
  const notes = typeof s.speakerNotes === "string" ? s.speakerNotes.slice(0, MAX_TEXT_LENGTH) : "";
  const slide: Slide = {
    id: sid,
    background: normColor(s.background, "#ffffff"),
    elementIds,
    elements,
    ...(notes ? { speakerNotes: notes } : {}),
  };
  return { slide, errors };
}

/**
 * Validate + normalize a whole deck. This is the server-side gate: nothing
 * reaches storage without passing through here, mirroring the GeoMap artifact's
 * `validateSpec`. It repairs what it safely can and reports what it cannot.
 */
function validateDeckCore(raw: unknown): { deck: Deck | null; errors: string[] } {
  const errors: string[] = [];
  if (!raw || typeof raw !== "object") return { deck: null, errors: ["deck must be an object"] };
  const o = raw as Record<string, unknown>;

  const slidesRaw = Array.isArray(o.slides) ? o.slides : null;
  if (!slidesRaw) return { deck: null, errors: ["deck.slides must be an array"] };
  if (slidesRaw.length === 0) return { deck: null, errors: ["a deck needs at least one slide"] };
  if (slidesRaw.length > MAX_SLIDES_PER_DECK) {
    errors.push(`deck has ${slidesRaw.length} slides (max ${MAX_SLIDES_PER_DECK})`);
  }

  const seenSlideIds = new Set<string>();
  const slides: Slide[] = [];

  for (let i = 0; i < Math.min(slidesRaw.length, MAX_SLIDES_PER_DECK); i++) {
    const s = slidesRaw[i] as Record<string, unknown>;
    const sid = typeof s?.id === "string" && s.id.trim() ? s.id : `s${i}`;
    if (seenSlideIds.has(sid)) {
      errors.push(`duplicate slide id "${sid}"`);
      continue;
    }
    seenSlideIds.add(sid);

    const { slide, errors: slideErrors } = normalizeSlideFromRaw(s, sid);
    errors.push(...slideErrors);
    slides.push(slide);
  }

  if (slides.length === 0) {
    return { deck: null, errors: errors.length ? errors : ["no valid slides"] };
  }

  const deck: Deck = {
    schemaVersion: SLIDES_SCHEMA_VERSION,
    title: String(o.title ?? "").trim().slice(0, 200) || "Untitled slides",
    width: CANVAS_W,
    height: CANVAS_H,
    slides,
    // Revision is SERVER-OWNED. Importing a caller-supplied value let a model
    // create a deck at MAX_SAFE_INTEGER, after which `revision + 1` clamped back
    // to the same number forever — every stale write then passed its
    // baseRevision check and the guard was silently dead (found by review).
    // A wrap keeps it monotonic-enough for staleness without ever saturating.
    revision: Number.isSafeInteger(o.revision) && (o.revision as number) >= 0
      ? (o.revision as number) % MAX_REVISION
      : 0,
  };

  return { deck, errors };
}

/**
 * Validate for WRITING. A structural error means content was DISCARDED, so this
 * REFUSES rather than persisting a silently-truncated deck — a duplicate slide
 * id used to drop a whole slide while `aiCreateSlidesDeck` reported success and
 * told the caller nothing (reproduced by review).
 */
export function validateDeck(raw: unknown): ValidationResult {
  const { deck, errors } = validateDeckCore(raw);
  if (!deck || errors.length > 0) {
    return { ok: false, errors: errors.length ? errors : ["deck is not valid"] };
  }
  return { ok: true, deck };
}

/**
 * Validate for READING. Identical to `validateDeck` but returns the salvaged
 * deck even when parts were dropped, because a mostly-good deck on screen beats
 * an error page for a kid. WRITES must use `validateDeck`, which refuses to
 * persist a deck it had to truncate.
 */
export function validateDeckLenient(raw: unknown): Deck | null {
  return validateDeckCore(raw).deck;
}

// ─── The AI / editor operation language ──────────────────────────────────

/**
 * The op vocabulary. Two fields exist ONLY so an edit can be exactly reversed
 * (see `invertOps`), and are inert for the AI/editor happy path:
 *
 *  • `addElement.id` / `addSlide.id` — a REQUESTED id, honoured only when it is
 *    free (and not a reserved prototype key), otherwise a fresh id is minted.
 *    `applySlideOps` stays the single id authority; this just lets undo re-add a
 *    removed thing under the SAME id instead of a new one. New ids are still the
 *    canonical `sl<N>`/`el<N>` because they still come from the factory.
 *  • `addElement.afterId` / `addSlide.afterSlideId` accept `null` = "at the very
 *    back/front" (index 0), matching `moveElement`, so a removed element/slide
 *    can be restored to z/position 0. `undefined` still means "append to the
 *    end" (unchanged for existing callers).
 *  • `addSlide.slide` — full slide content to restore (background, elements,
 *    order, notes). Absent = a blank slide (unchanged). Normalized strictly:
 *    if any of it would be dropped the whole op fails, so a restore is exact.
 */
export type SlideOp =
  | { op: "addElement"; slideId: string; afterId?: string | null; id?: string; element: unknown }
  | { op: "patchElement"; slideId: string; id: string; frame?: Partial<Frame>; text?: string; style?: Record<string, unknown> }
  | { op: "removeElement"; slideId: string; id: string }
  | { op: "moveElement"; slideId: string; id: string; afterId?: string | null }
  | { op: "addSlide"; afterSlideId?: string | null; id?: string; slide?: unknown }
  | { op: "removeSlide"; slideId: string }
  | { op: "setBackground"; slideId: string; color: string }
  | { op: "setSpeakerNotes"; slideId: string; notes: string }
  | { op: "setTitle"; title: string };

export type ApplyResult =
  | { ok: true; deck: Deck; createdIds: string[] }
  | { ok: false; error: string };

/** Deterministic id minting so a caller (Convex mutation, test) controls ids. */
export type IdFactory = (kind: "slide" | "element") => string;

/**
 * The ONLY id shape we mint or seed from: `sl1`, `el42`. Deliberately strict.
 *
 * A permissive `Number(suffix)` parse accepted forms the format never
 * produces — `el007` seeds 7, `el1e3` seeds 1000 — and, worse, an id at the
 * float ceiling (`el9007199254740992`) made `++seed` a NO-OP, so the factory
 * re-minted an id that already existed: `addElement` then overwrote the element
 * in place AND pushed a duplicate into `elementIds`. Reproduced by review.
 */
const CANONICAL_ID = /^(sl|el)([1-9][0-9]*)$/;

/** Highest existing suffix per kind, ignoring anything not canonical. */
export function seedFromDeck(deck: Deck): { slide: number; element: number } {
  const seed = { slide: 0, element: 0 };
  const bump = (id: string) => {
    const m = CANONICAL_ID.exec(id);
    if (!m) return;
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n)) return;
    const kind = m[1] === "sl" ? "slide" : "element";
    if (n > seed[kind]) seed[kind] = n;
  };
  for (const s of deck.slides) {
    bump(s.id);
    for (const e of s.elementIds) bump(e);
  }
  return seed;
}

/**
 * The one id factory every caller uses — server mutations, both editors, tests.
 * Three hand-written copies had already drifted, and one of them is what made
 * the collision above reachable. Probes for availability so a non-canonical or
 * saturated existing id can never be re-minted.
 */
export function makeDeckIdFactory(deck: Deck): IdFactory {
  const seed = seedFromDeck(deck);
  const taken = new Set<string>();
  for (const s of deck.slides) {
    taken.add(s.id);
    for (const e of s.elementIds) taken.add(e);
    for (const k of Object.keys(s.elements)) taken.add(k);
  }
  return (kind) => {
    const prefix = kind === "slide" ? "sl" : "el";
    let n = seed[kind];
    let id: string;
    do {
      n += 1;
      if (!Number.isSafeInteger(n)) {
        throw new Error("slide id space exhausted");
      }
      id = `${prefix}${n}`;
    } while (taken.has(id));
    seed[kind] = n;
    taken.add(id);
    return id;
  };
}

function findSlide(deck: Deck, slideId: string): Slide | undefined {
  return deck.slides.find((s) => s.id === slideId);
}

/** Is `id` used ANYWHERE in the deck — as a slide id, an element key, or in any
 *  z-order? A restored id must be globally unused, matching what the factory
 *  guarantees for minted ids, so honouring one can never create a collision. */
function idExists(deck: Deck, id: string): boolean {
  for (const s of deck.slides) {
    if (s.id === id) return true;
    if (s.elementIds.includes(id)) return true;
    if (Object.prototype.hasOwnProperty.call(s.elements, id)) return true;
  }
  return false;
}

/**
 * Pick the id for a newly-inserted element/slide. A caller-`requested` id is
 * honoured ONLY when it is a non-empty, non-reserved string that is currently
 * free in `deck`; otherwise a fresh canonical id is minted. This is the whole
 * mechanism that lets undo restore a removed thing under its original id without
 * ever weakening the "minted ids are canonical and unique" invariant.
 */
/** Ids a caller may PIN: ordinary identifier characters, bounded length. */
const PINNABLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Reserved separately from the charset — `__proto__`, `constructor` and
 * `prototype` are all ordinary identifier characters, so a charset alone lets
 * them straight through (caught by a test).
 */
const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Honour a caller-pinned id when it is syntactically safe and currently FREE —
 * otherwise mint.
 *
 * Pinning exists for exactly one reason: undo must restore a removed element at
 * the id it had, or every reference to it breaks. It is deliberately NOT
 * restricted to the canonical `sl<N>`/`el<N>` shape — `emptyDeck` takes a
 * caller-supplied first-slide id, so older decks legitimately hold ids we did
 * not mint, and refusing to restore those would make deleting a slide in such a
 * deck unrecoverable (caught by a round-trip test).
 *
 * What actually needed guarding was never the SHAPE:
 *   - collisions — refused here (`idExists`) and by the factory's own probe, so
 *     a pinned id can never overwrite or duplicate an existing element;
 *   - prototype keys — excluded by the charset, alongside the null-prototype
 *     element map.
 * A merely unusual-looking id is harmless; minting stays the default.
 */
function resolveNewId(deck: Deck, requested: string | undefined, mint: () => string): string {
  if (typeof requested !== "string") return mint();
  if (!PINNABLE_ID.test(requested)) return mint();
  if (RESERVED_IDS.has(requested)) return mint();
  if (idExists(deck, requested)) return mint();
  return requested;
}

/**
 * Apply a batch of operations to a deck, addressed by STABLE ID.
 *
 * Why an op list rather than a whole-deck replacement or RFC-6902 paths: a
 * model emits a small, checkable intent; a stale whole-deck write would clobber
 * edits the scholar made while the model was thinking, and array-index paths
 * break the moment anything is reordered.
 *
 * All-or-nothing: a bad op fails the batch so a partially-applied edit can
 * never leave the deck in a state the model didn't intend.
 */
export function applySlideOps(deck: Deck, ops: SlideOp[], mintId: IdFactory): ApplyResult {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: "no operations supplied" };
  if (ops.length > MAX_OPS_PER_BATCH) {
    return { ok: false, error: `too many operations (${ops.length} > ${MAX_OPS_PER_BATCH})` };
  }

  // Work on a deep copy so a mid-batch failure leaves the caller's deck alone.
  const next: Deck = JSON.parse(JSON.stringify(deck));
  const createdIds: string[] = [];

  for (const op of ops) {
    switch (op?.op) {
      case "addElement": {
        const slide = findSlide(next, op.slideId);
        if (!slide) return { ok: false, error: `unknown slide "${op.slideId}"` };
        if (slide.elementIds.length >= MAX_ELEMENTS_PER_SLIDE) {
          return { ok: false, error: `slide "${op.slideId}" is full (${MAX_ELEMENTS_PER_SLIDE})` };
        }
        const id = resolveNewId(next, op.id, () => mintId("element"));
        const el = normalizeElement(op.element, id);
        if (!el) return { ok: false, error: `addElement: element is not a valid element` };
        slide.elements[id] = el;
        // afterId: undefined → end (default), null → back/front (index 0),
        // string → immediately after that element.
        if (op.afterId === null) {
          slide.elementIds.unshift(id);
        } else if (op.afterId === undefined) {
          slide.elementIds.push(id);
        } else {
          const at = slide.elementIds.indexOf(op.afterId);
          if (at === -1) return { ok: false, error: `unknown afterId "${op.afterId}"` };
          slide.elementIds.splice(at + 1, 0, id);
        }
        createdIds.push(id);
        break;
      }
      case "patchElement": {
        const slide = findSlide(next, op.slideId);
        if (!slide) return { ok: false, error: `unknown slide "${op.slideId}"` };
        const cur = slide.elements[op.id];
        if (!cur) return { ok: false, error: `unknown element "${op.id}"` };
        // Merge onto the CURRENT element, then re-normalize — so a patch can
        // never change `id`/`type` and can never dodge the invariants.
        const merged: Record<string, unknown> = {
          ...(cur as unknown as Record<string, unknown>),
          ...(op.frame ? { frame: { ...cur.frame, ...op.frame } } : {}),
          ...(op.text !== undefined ? { text: op.text } : {}),
          ...(op.style
            ? { style: { ...(cur as { style?: object }).style, ...op.style } }
            : {}),
          type: cur.type,
        };
        const norm = normalizeElement(merged, op.id);
        if (!norm) return { ok: false, error: `patchElement: result is invalid for "${op.id}"` };
        slide.elements[op.id] = norm;
        break;
      }
      case "removeElement": {
        const slide = findSlide(next, op.slideId);
        if (!slide) return { ok: false, error: `unknown slide "${op.slideId}"` };
        if (!slide.elements[op.id]) return { ok: false, error: `unknown element "${op.id}"` };
        delete slide.elements[op.id];
        slide.elementIds = slide.elementIds.filter((x) => x !== op.id);
        break;
      }
      case "moveElement": {
        const slide = findSlide(next, op.slideId);
        if (!slide) return { ok: false, error: `unknown slide "${op.slideId}"` };
        if (!slide.elements[op.id]) return { ok: false, error: `unknown element "${op.id}"` };
        slide.elementIds = slide.elementIds.filter((x) => x !== op.id);
        if (op.afterId === null) {
          slide.elementIds.unshift(op.id); // to the back
        } else if (op.afterId === undefined) {
          slide.elementIds.push(op.id); // to the front/top
        } else {
          const at = slide.elementIds.indexOf(op.afterId);
          if (at === -1) return { ok: false, error: `unknown afterId "${op.afterId}"` };
          slide.elementIds.splice(at + 1, 0, op.id);
        }
        break;
      }
      case "addSlide": {
        if (next.slides.length >= MAX_SLIDES_PER_DECK) {
          return { ok: false, error: `deck is full (${MAX_SLIDES_PER_DECK} slides)` };
        }
        const id = resolveNewId(next, op.id, () => mintId("slide"));
        let slide: Slide;
        if (op.slide !== undefined) {
          // Restore path: full content, all-or-nothing. Refuse rather than
          // silently drop, so an undo can never restore a truncated slide.
          const built = normalizeSlideFromRaw(op.slide, id);
          if (built.errors.length > 0) {
            return { ok: false, error: `addSlide: slide content invalid (${built.errors[0]})` };
          }
          slide = built.slide;
        } else {
          slide = emptySlide(id);
        }
        // afterSlideId: undefined → end (default), null → front (index 0),
        // string → immediately after that slide.
        if (op.afterSlideId === null) {
          next.slides.unshift(slide);
        } else if (op.afterSlideId === undefined) {
          next.slides.push(slide);
        } else {
          const at = next.slides.findIndex((s) => s.id === op.afterSlideId);
          if (at === -1) return { ok: false, error: `unknown afterSlideId "${op.afterSlideId}"` };
          next.slides.splice(at + 1, 0, slide);
        }
        createdIds.push(id);
        break;
      }
      case "removeSlide": {
        if (next.slides.length <= 1) return { ok: false, error: "a deck must keep at least one slide" };
        const at = next.slides.findIndex((s) => s.id === op.slideId);
        if (at === -1) return { ok: false, error: `unknown slide "${op.slideId}"` };
        next.slides.splice(at, 1);
        break;
      }
      case "setBackground": {
        const slide = findSlide(next, op.slideId);
        if (!slide) return { ok: false, error: `unknown slide "${op.slideId}"` };
        slide.background = normColor(op.color, slide.background);
        break;
      }
      case "setSpeakerNotes": {
        const slide = findSlide(next, op.slideId);
        if (!slide) return { ok: false, error: `unknown slide "${op.slideId}"` };
        // Empty ≡ absent (see `normalizeSlideFromRaw`): clearing the notes drops
        // the key, so "set" and "clear" are exact inverses of one another.
        const notes = String(op.notes ?? "").slice(0, MAX_TEXT_LENGTH);
        if (notes) slide.speakerNotes = notes;
        else delete slide.speakerNotes;
        break;
      }
      case "setTitle": {
        next.title = String(op.title ?? "").trim().slice(0, 200) || next.title;
        break;
      }
      default:
        return { ok: false, error: `unknown operation "${String((op as { op?: string })?.op)}"` };
    }
  }

  next.revision = (deck.revision + 1) % MAX_REVISION;
  return { ok: true, deck: next, createdIds };
}

/**
 * A compact projection for the model: enough to reason and address elements by
 * id, without the full style payload eating the context window. This is what
 * `read_deck` returns.
 */
function summaryPreview(value: string, maxLength: number): string {
  return value.replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizedSlideText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** A text box with nothing but whitespace in it paints nothing at all. */
export function isBlankSlideText(text: string): boolean {
  return normalizedSlideText(text) === "";
}

/**
 * What committing an edited text box should DO.
 *
 * A text element whose content is whitespace-only paints nothing: it is an
 * invisible rectangle that still wins every touch over whatever sits under it,
 * which is how a scholar ends up unable to select the box they can actually
 * see. So a commit that leaves the box blank REMOVES it instead of persisting
 * it. Undo restores it (`removeElement` inverts to `addElement`).
 *
 * Deliberately not inside `applySlideOps`'s patchElement case: the AI patches
 * text through that same op, and a tool call must never delete an element as a
 * side effect of writing to it.
 */
export function textCommitOps(
  slideId: string,
  id: string,
  text: string,
): SlideOp[] {
  if (isBlankSlideText(text)) return [{ op: "removeElement", slideId, id }];
  return [{ op: "patchElement", slideId, id, text }];
}

function framesOverlap(a: Frame, b: Frame, tolerance = 2): boolean {
  const overlapWidth =
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapHeight =
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapWidth > tolerance && overlapHeight > tolerance;
}

// A stray duplicate box is often a partial copy sitting on the original (the
// prod incident's defect was exactly this), so containment counts too — but
// only for substantial runs of text, or short labels ("Humor") overlapping a
// paragraph that mentions them would false-positive.
const DUPLICATE_CONTAINMENT_MIN_CHARS = 20;

function isDuplicateTextPair(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return (
    shorter.length >= DUPLICATE_CONTAINMENT_MIN_CHARS && longer.includes(shorter)
  );
}

/**
 * Two shapes/images of the same kind sitting on the same frame. Text pairs are
 * judged on their WORDS (a partial copy is still a duplicate); everything else
 * has no content to compare, so an all-but-identical frame is the signal.
 */
const DUPLICATE_FRAME_TOLERANCE = 2;

function framesNearlyIdentical(a: Frame, b: Frame): boolean {
  return (
    Math.abs(a.x - b.x) <= DUPLICATE_FRAME_TOLERANCE &&
    Math.abs(a.y - b.y) <= DUPLICATE_FRAME_TOLERANCE &&
    Math.abs(a.w - b.w) <= DUPLICATE_FRAME_TOLERANCE &&
    Math.abs(a.h - b.h) <= DUPLICATE_FRAME_TOLERANCE
  );
}

function slideDiagnostics(slide: Slide): string {
  const textElements = slide.elementIds
    .map((id) => slide.elements[id])
    .filter((element): element is TextElement => element?.type === "text");
  const wordCount = textElements.reduce((total, element) => {
    const text = normalizedSlideText(element.text);
    return total + (text ? text.split(" ").length : 0);
  }, 0);
  const imageCount = slide.elementIds.filter(
    (id) => slide.elements[id]?.type === "image",
  ).length;
  const fontSizes = textElements.map((element) => element.style.fontSize);
  const fontRange =
    fontSizes.length === 0
      ? "none"
      : `${Math.min(...fontSizes)}-${Math.max(...fontSizes)}`;
  let duplicatePairs = 0;
  for (let i = 0; i < textElements.length; i += 1) {
    const text = normalizedSlideText(textElements[i].text);
    if (!text) continue;
    for (let j = i + 1; j < textElements.length; j += 1) {
      if (
        isDuplicateTextPair(text, normalizedSlideText(textElements[j].text)) &&
        framesOverlap(textElements[i].frame, textElements[j].frame)
      ) {
        duplicatePairs += 1;
      }
    }
  }
  // Stacked rects/ellipses/lines/images were invisible to `read_deck` while
  // this only looked at text, so the model could not see the very pile a
  // scholar was asking it about.
  const otherElements = slide.elementIds
    .map((id) => slide.elements[id])
    .filter(
      (element): element is SlideElement =>
        Boolean(element) && element.type !== "text",
    );
  for (let i = 0; i < otherElements.length; i += 1) {
    for (let j = i + 1; j < otherElements.length; j += 1) {
      if (
        otherElements[i].type === otherElements[j].type &&
        framesNearlyIdentical(otherElements[i].frame, otherElements[j].frame)
      ) {
        duplicatePairs += 1;
      }
    }
  }
  const duplicates =
    duplicatePairs === 0
      ? "no duplicate boxes"
      : `${duplicatePairs} duplicate box pair${duplicatePairs === 1 ? "" : "s"}`;
  return `${wordCount} words · ${imageCount} image${imageCount === 1 ? "" : "s"} · fonts ${fontRange} · ${duplicates}`;
}

/**
 * Compact, id-addressed projection of a deck for the model. `textCap` bounds
 * each text element's preview: the default (60) suits the `edit_slides op:"read"`
 * lookup, which only needs enough to disambiguate ids before patching. The
 * prompt's live DECK section passes a much larger cap so the tutor actually
 * READS the scholar's slide copy each turn rather than a 60-char stub.
 */
export function summarizeDeckForModel(deck: Deck, textCap = 60): string {
  const lines: string[] = [
    `Deck "${deck.title}" — ${deck.slides.length} slide(s), ${CANVAS_W}x${CANVAS_H}, revision ${deck.revision}`,
  ];
  deck.slides.forEach((s, i) => {
    lines.push(`Slide ${i + 1} (id: ${s.id}, background ${s.background})`);
    lines.push(`  [slide stats] ${slideDiagnostics(s)}`);
    if (s.elementIds.length === 0) lines.push("  (empty)");
    for (const eid of s.elementIds) {
      const el = s.elements[eid];
      if (!el) continue;
      const f = el.frame;
      const geom = `x=${Math.round(f.x)} y=${Math.round(f.y)} w=${Math.round(f.w)} h=${Math.round(f.h)}${f.rotation ? ` rot=${Math.round(f.rotation)}` : ""}`;
      if (el.type === "text") {
        const preview = summaryPreview(el.text, textCap);
        lines.push(
          `  ${eid} text ${geom} fontSize=${el.style.fontSize} bold=${el.style.bold} italic=${el.style.italic} "${preview}"`,
        );
      } else if (el.type === "image" || el.type === "video") {
        lines.push(`  ${eid} ${el.type} ${geom} alt="${summaryPreview(el.alt, 80)}"`);
      } else {
        lines.push(`  ${eid} ${el.type} ${geom} fill=${el.style.fill ?? "none"}`);
      }
    }
    if (s.speakerNotes) lines.push(`  notes: ${summaryPreview(s.speakerNotes, 120)}`);
  });
  return lines.join("\n");
}

// ─── Undo / redo: the pure core ──────────────────────────────────────────
//
// FOR THE TWO EDITORS (web + native). Neither had undo, so a stray tap on a
// child's iPad erased composed work with no recovery. Because every op is
// addressed by a stable id and has a computable inverse, undo/redo is a pure
// data problem — no React, no Convex, no DOM, so it lives here beside the writer
// it mirrors and is vendored to native unchanged.
//
// The single writer stays `applySlideOps`. This module NEVER mutates a deck; it
// produces the OPS that, fed back through `applySlideOps`, walk the deck
// backwards or forwards. So `revision` keeps climbing across undo/redo (it is a
// server-owned staleness counter, deliberately not restored) while the slide
// CONTENT is restored exactly — same ids, same z-order, same everything else.

/** JSON deep-clone; embedded restore payloads must not alias the caller's deck. */
function cloneJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * The z-order neighbour to restore `id`/index to. An element/slide at index 0
 * restores to the very back via `null` (there is no left neighbour); otherwise
 * it restores immediately after whatever was on its left. Computed against the
 * PRE-op order, and correct under reverse-order replay because that left
 * neighbour is guaranteed present at the moment the inverse runs.
 */
function priorNeighbour(order: string[], index: number): string | null {
  return index <= 0 ? null : order[index - 1];
}

/**
 * The inverse of ONE op, evaluated against `before` — the deck as it looked
 * immediately BEFORE that op applied. `createdId` is the id the op minted/used
 * (from `ApplyResult.createdIds`) and is required for the two creating ops.
 * Returns the op(s) that undo it, or null if `before` doesn't actually contain
 * what the op referenced (i.e. the batch never cleanly applied here).
 */
function invertOne(before: Deck, op: SlideOp, createdId: string | undefined): SlideOp[] | null {
  switch (op?.op) {
    case "addElement": {
      // Added an element → remove exactly it. Needs the minted id.
      if (createdId === undefined) return null;
      return [{ op: "removeElement", slideId: op.slideId, id: createdId }];
    }
    case "addSlide": {
      // Added a slide → remove exactly it. Needs the minted id.
      if (createdId === undefined) return null;
      return [{ op: "removeSlide", slideId: createdId }];
    }
    case "removeElement": {
      // Re-add the SAME element (id, type, style, text, geometry) at the SAME
      // z-position. `id` is honoured because it is now free; `afterId` pins the
      // z-order; `element` carries the full prior element.
      const slide = findSlide(before, op.slideId);
      if (!slide) return null;
      const el = slide.elements[op.id];
      if (!el) return null;
      const idx = slide.elementIds.indexOf(op.id);
      return [
        {
          op: "addElement",
          slideId: op.slideId,
          id: op.id,
          afterId: priorNeighbour(slide.elementIds, idx),
          element: cloneJson(el),
        },
      ];
    }
    case "removeSlide": {
      // Re-add the whole slide — id, content, and index — via the widened
      // addSlide restore path.
      const idx = before.slides.findIndex((s) => s.id === op.slideId);
      if (idx === -1) return null;
      const slide = before.slides[idx];
      return [
        {
          op: "addSlide",
          id: slide.id,
          afterSlideId: idx <= 0 ? null : before.slides[idx - 1].id,
          slide: cloneJson(slide),
        },
      ];
    }
    case "patchElement": {
      // Patch every field the forward patch could have touched back to its prior
      // value. Merged onto the current element and re-normalized, this restores
      // the element exactly (unpatched fields are set to the same value they
      // already hold, which is a no-op).
      const slide = findSlide(before, op.slideId);
      if (!slide) return null;
      const el = slide.elements[op.id];
      if (!el) return null;
      const inv: Extract<SlideOp, { op: "patchElement" }> = {
        op: "patchElement",
        slideId: op.slideId,
        id: op.id,
        frame: cloneJson(el.frame),
      };
      if (el.type === "text") inv.text = el.text;
      if (el.type === "text" || el.type === "rect" || el.type === "ellipse" || el.type === "line") {
        inv.style = cloneJson(el.style) as unknown as Record<string, unknown>;
      }
      return [inv];
    }
    case "moveElement": {
      // Move it back to the neighbour it had before the move.
      const slide = findSlide(before, op.slideId);
      if (!slide) return null;
      const idx = slide.elementIds.indexOf(op.id);
      if (idx === -1) return null;
      return [
        { op: "moveElement", slideId: op.slideId, id: op.id, afterId: priorNeighbour(slide.elementIds, idx) },
      ];
    }
    case "setBackground": {
      const slide = findSlide(before, op.slideId);
      if (!slide) return null;
      return [{ op: "setBackground", slideId: op.slideId, color: slide.background }];
    }
    case "setSpeakerNotes": {
      const slide = findSlide(before, op.slideId);
      if (!slide) return null;
      // Prior "" restores as "", which clears the key (empty ≡ absent).
      return [{ op: "setSpeakerNotes", slideId: op.slideId, notes: slide.speakerNotes ?? "" }];
    }
    case "setTitle": {
      return [{ op: "setTitle", title: before.title }];
    }
    default:
      return null;
  }
}

/**
 * The inverse of a WHOLE batch: the ops that, applied to the post-batch deck via
 * `applySlideOps`, restore `before` exactly.
 *
 *   const r = applySlideOps(before, ops, mint);           // r.ok
 *   const undo = invertOps(before, ops, r.createdIds);    // SlideOp[] | null
 *   const back = applySlideOps(r.deck, undo!, mint);      // back.deck ≈ before
 *
 * `back.deck` equals `before` in every field except `revision` (see the section
 * header). Pass `before` (the deck BEFORE the batch) and the batch's
 * `createdIds` — the minted ids are needed to name what `addElement`/`addSlide`
 * created. `createdIds` maps 1:1, in order, to the add-ops in the batch (every
 * addElement and addSlide contributes exactly one).
 *
 * Returns null — rather than a wrong guess — when the batch does not cleanly
 * replay against `before` (so it was not the batch that produced the current
 * state) or when `createdIds` don't line up with the add-ops.
 *
 * INVERTIBILITY: with the id/position/content restore fields on
 * addElement/addSlide, and empty≡absent speaker notes, all nine ops are
 * exactly invertible. The only lossy thing is `revision`, which is server-owned
 * and intentionally monotonic; nothing else about a deck is unrecoverable.
 */
export function invertOps(before: Deck, ops: SlideOp[], createdIds: string[]): SlideOp[] | null {
  if (!Array.isArray(ops) || ops.length === 0) return null;
  if (!Array.isArray(createdIds)) return null;

  let running: Deck = before;
  let createdCursor = 0;
  const perOp: SlideOp[][] = [];

  for (const op of ops) {
    const creates = op?.op === "addElement" || op?.op === "addSlide";
    const createdId = creates ? createdIds[createdCursor] : undefined;
    if (creates && createdId === undefined) return null; // createdIds too short

    const inv = invertOne(running, op, createdId);
    if (inv === null) return null;
    perOp.push(inv);

    // Advance `running` by re-applying this single op. A one-shot factory hands
    // back the real created id, so the running deck matches reality exactly and
    // the next op's inverse is computed against the right state.
    const factory: IdFactory = () => {
      if (createdId === undefined) throw new Error("unexpected mint during inversion");
      return createdId;
    };
    const res = applySlideOps(running, [op], factory);
    if (!res.ok) return null;
    running = res.deck;
    if (creates) createdCursor += 1;
  }

  // Reverse the op order; keep each op's own inverse internally ordered.
  return perOp.reverse().flat();
}

/**
 * Pin the created ids onto a batch's add-ops so re-applying it (redo) restores
 * the SAME ids it made the first time, instead of minting new ones. Everything
 * else about the ops is untouched.
 */
function pinCreatedIds(ops: SlideOp[], createdIds: string[]): SlideOp[] {
  let k = 0;
  return ops.map((op) => {
    if (op?.op === "addElement" || op?.op === "addSlide") {
      const id = createdIds[k++];
      return id === undefined ? op : { ...op, id };
    }
    return op;
  });
}

// ─── Undo / redo: the history reducer ────────────────────────────────────
//
// A pure, framework-free stack the editors hold per session. It stores OPS, not
// deck snapshots: entries are tiny, and applying them keeps `applySlideOps` the
// only thing that ever writes a deck. `undo`/`redo` HAND BACK the ops to apply —
// they do not touch a deck themselves — so the caller mints/persists as usual.

/**
 * Undo depth. Op-batch entries are a few hundred bytes each, so this is a memory
 * bound, not a real limit for the user: 50 discrete edits is far more than an
 * 8-year-old composes between saves, while capping a marathon authoring session
 * from growing without end. The editors can raise it via `createHistory(n)`.
 */
export const DEFAULT_HISTORY_LIMIT = 50;

/** One reversible edit: the ops to undo it, and the (id-pinned) ops to redo it. */
export type HistoryEntry = {
  /** Applied to the CURRENT deck, restores the state before this edit. */
  undo: SlideOp[];
  /** Applied to the pre-edit deck, re-performs this edit with identical ids. */
  redo: SlideOp[];
};

/**
 * The undo/redo stacks. `past` is oldest→newest (top = most recent edit);
 * `future` is what redo will replay (top = next redo). Treat as immutable — the
 * reducer functions return a new value and never mutate the input.
 */
export type SlideHistory = {
  past: HistoryEntry[];
  future: HistoryEntry[];
  limit: number;
};

/** A fresh, empty history. `limit` is clamped to at least 1. */
export function createHistory(limit: number = DEFAULT_HISTORY_LIMIT): SlideHistory {
  return { past: [], future: [], limit: Math.max(1, Math.floor(limit)) };
}

export function canUndo(history: SlideHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: SlideHistory): boolean {
  return history.future.length > 0;
}

/**
 * Record a just-applied edit so it can be undone. Pass the deck as it was BEFORE
 * the batch plus the `ops`/`createdIds` from the successful `ApplyResult`.
 *
 *   const r = applySlideOps(before, ops, mint);          // r.ok
 *   history = pushHistory(history, before, ops, r.createdIds);
 *
 * Redo is cleared (a new edit forks the timeline — standard behaviour) and the
 * oldest entry is dropped past `limit`.
 *
 * If the batch is not invertible (`invertOps` → null, e.g. a hand-built batch
 * that doesn't replay against `before`), the WHOLE history is cleared: an edit
 * we cannot reverse is an undo barrier, and clearing is safer than leaving a
 * stack whose top would restore the wrong deck.
 */
export function pushHistory(
  history: SlideHistory,
  before: Deck,
  ops: SlideOp[],
  createdIds: string[],
): SlideHistory {
  const undo = invertOps(before, ops, createdIds);
  if (undo === null) {
    return { past: [], future: [], limit: history.limit };
  }
  const entry: HistoryEntry = { undo, redo: pinCreatedIds(ops, createdIds) };
  const past = [...history.past, entry];
  while (past.length > history.limit) past.shift();
  return { past, future: [], limit: history.limit };
}

/**
 * Take the next undo step. Returns the ops to apply to the CURRENT deck and the
 * advanced history, or null when there is nothing to undo. The caller applies
 * `ops` through `applySlideOps` and persists the result — it must NOT call
 * `pushHistory` for that application; the entry has already moved to `future`.
 */
export function undo(history: SlideHistory): { history: SlideHistory; ops: SlideOp[] } | null {
  if (history.past.length === 0) return null;
  const past = history.past.slice(0, -1);
  const entry = history.past[history.past.length - 1];
  return {
    history: { past, future: [...history.future, entry], limit: history.limit },
    ops: entry.undo,
  };
}

/**
 * Take the next redo step. Mirror of `undo`: returns the ops to re-apply and the
 * advanced history, or null when there is nothing to redo. Same rule — apply the
 * ops, don't `pushHistory` them.
 */
export function redo(history: SlideHistory): { history: SlideHistory; ops: SlideOp[] } | null {
  if (history.future.length === 0) return null;
  const future = history.future.slice(0, -1);
  const entry = history.future[history.future.length - 1];
  return {
    history: { past: [...history.past, entry], future, limit: history.limit },
    ops: entry.redo,
  };
}
