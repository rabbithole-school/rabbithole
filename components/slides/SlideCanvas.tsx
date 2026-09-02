"use client";

/**
 * SlideCanvas — the plain-DOM/SVG renderer + direct-manipulation surface for a
 * single {@link Slide}. Chrome (Chakra) lives in SlidesEditor; everything here
 * is deliberately framework-light so the geometry stays honest.
 *
 * Rendering: the logical 1280x720 canvas is drawn at its real size and uniformly
 * `transform: scale()`-d to fit the measured container, so every child can be
 * positioned in LOGICAL units (element frames as-is, a textarea overlay that
 * lines up with its box). Elements draw axis-aligned then `rotate()` about their
 * centre — the same clockwise/y-down sense the model stores.
 *
 * Interaction is mouse-first (the iPad has its own native editor): click selects,
 * drag moves, corner handles resize (in the box's LOCAL space via
 * {@link resizeFrame}), and a rotate handle turns non-text elements. A gesture
 * updates a local `liveFrame` per frame for a smooth follow, and commits to
 * `onFrameChange` ONCE, on pointer-up — never per mousemove.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Spinner } from "@chakra-ui/react";
import { Image as ImageIcon } from "@phosphor-icons/react";
import { shouldRenderSlideImage } from "@/shared/slideImageFallback";
import type { Frame, Slide, SlideElement } from "@/shared/slidesScene";
import { MAKE_PICTURE_COPY, FIND_IMAGE_COPY } from "@/shared/slidesScene";
import {
  CANVAS_W,
  CANVAS_H,
} from "@/shared/slidesScene";
import {
  lineStrokeLogical,
  TEXT_LINE_HEIGHT_RATIO,
  TEXT_PADDING,
  verticalAlignToJustify,
} from "@/shared/slidesRenderContract";
import {
  computeLayout,
  frameCentre,
  resizeFrame,
  rotationFromPointer,
  screenToLogical,
  translateFrame,
  type CanvasLayout,
  type Corner,
  type Point,
} from "./geometry";

const CYAN = "var(--chakra-colors-cyan-500, #2ECCDF)";
const SLIDE_FONT_FAMILY =
  "var(--font-hanken-grotesk), system-ui, sans-serif";
/** Visible handle size, in SCREEN pixels (kept constant regardless of zoom). */
const HANDLE_PX = 12;
/** Transparent grab radius behind the visible knob (screen px). */
const HANDLE_HIT_PX = 28;
const ROTATE_GAP = 36; // logical units above the top edge

type Gesture =
  | { kind: "move"; id: string; startFrame: Frame; startPointer: { x: number; y: number } }
  | { kind: "movePlaceholder"; id: string; startFrame: Frame; startPointer: { x: number; y: number } }
  | { kind: "resize"; id: string; corner: Corner; startFrame: Frame }
  | { kind: "rotate"; id: string; startFrame: Frame };

/** The new frame for a gesture given the current logical pointer position. */
function computeGestureFrame(g: Gesture, p: Point): Frame {
  if (g.kind === "move" || g.kind === "movePlaceholder") {
    return translateFrame(g.startFrame, p.x - g.startPointer.x, p.y - g.startPointer.y);
  }
  if (g.kind === "resize") {
    return resizeFrame(g.startFrame, g.corner, p);
  }
  return { ...g.startFrame, rotation: rotationFromPointer(frameCentre(g.startFrame), p) };
}

interface SlideCanvasProps {
  slide: Slide;
  readOnly: boolean;
  selectedId: string | null;
  editingTextId: string | null;
  onSelect: (id: string | null) => void;
  onStartTextEdit: (id: string) => void;
  /**
   * Commit an edited text box. `touched` is whether the scholar changed
   * anything in THIS session — the owner needs it because "text equals what is
   * stored" is not the same question (deleting a blank box back to blank is a
   * real edit).
   */
  onCommitTextEdit: (id: string, text: string, touched: boolean) => void;
  onCancelTextEdit: () => void;
  /**
   * Publishes a live handle on the in-flight text draft (and null when the
   * editor closes). The textarea owns its value, so this is the only way an
   * owner can flush what has been typed but not yet committed — see
   * SlidesEditor's visibilitychange flush. Must be referentially stable.
   */
  registerTextDraft?: (draft: { id: string; read: () => string } | null) => void;
  /** Commit a moved/resized/rotated frame — called ONCE at gesture end. */
  onFrameChange: (id: string, frame: Frame) => void;
  /** Resolve an image element's assetId to a URL; null renders a placeholder. */
  resolveAsset?: (assetId: string) => string | null;
  /**
   * In-flight "Make a picture" placeholders for THIS slide — a client-side
   * overlay (never persisted into the deck) drawn at the frame the finished
   * image will occupy, so the scholar sees which picture is coming and where.
   */
  placeholders?: SlidePicturePlaceholder[];
  /**
   * Commit a dragged placeholder's new position (logical x/y) — called ONCE at
   * gesture end, mirroring native's `moveImagePlaceholder`. The finished image
   * then lands on that moved frame.
   */
  onMovePlaceholder?: (id: string, x: number, y: number) => void;
}

/** An optimistic "Make a picture" placeholder rendered on the canvas. */
export interface SlidePicturePlaceholder {
  id: string;
  frame: Frame;
  /** The scholar's own prompt text, shown so it's obvious which picture lands. */
  prompt: string;
  /**
   * Which image source spawned this placeholder, so the busy announcement uses
   * the matching copy: generation ("Making your image…") vs web search
   * ("Adding your image…").
   */
  source: "generate" | "find";
}

export function SlideCanvas({
  slide,
  readOnly,
  selectedId,
  editingTextId,
  onSelect,
  onStartTextEdit,
  onCommitTextEdit,
  onCancelTextEdit,
  registerTextDraft,
  onFrameChange,
  resolveAsset,
  placeholders,
  onMovePlaceholder,
}: SlideCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const layout = computeLayout(size.w, size.h);

  const gestureRef = useRef<Gesture | null>(null);
  const [liveFrame, setLiveFrame] = useState<{ id: string; frame: Frame } | null>(null);

  // Measure the container so the logical canvas can be scaled to fit it.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const clientToLogical = useCallback(
    (clientX: number, clientY: number, layoutNow: CanvasLayout) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return screenToLogical({ x: clientX - rect.left, y: clientY - rect.top }, layoutNow);
    },
    [],
  );

  // "Latest ref" mirrors so the lifetime-stable listeners below read current
  // values without re-binding. Synced in an effect (never during render).
  const layoutRef = useRef(layout);
  const onFrameChangeRef = useRef(onFrameChange);
  const onMovePlaceholderRef = useRef(onMovePlaceholder);
  useEffect(() => {
    layoutRef.current = layout;
    onFrameChangeRef.current = onFrameChange;
    onMovePlaceholderRef.current = onMovePlaceholder;
  });

  // ── Gesture plumbing ──────────────────────────────────────────────────
  // A single, lifetime-stable pair of window listeners. They no-op unless a
  // gesture is active (gestureRef), so there's no add/remove churn to get wrong,
  // and the commit fires exactly once, on pointer-up. The final frame is derived
  // straight from the pointer-up coordinates, not from render-timed state.
  useEffect(() => {
    // Read-only previews never start gestures. Avoid giving every filmstrip or
    // list thumbnail its own pair of global pointer listeners.
    if (readOnly) return;
    const onMove = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      const p = clientToLogical(e.clientX, e.clientY, layoutRef.current);
      setLiveFrame({ id: g.id, frame: computeGestureFrame(g, p) });
    };
    const onUp = (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      gestureRef.current = null;
      const p = clientToLogical(e.clientX, e.clientY, layoutRef.current);
      const frame = computeGestureFrame(g, p);
      if (g.kind === "movePlaceholder") {
        onMovePlaceholderRef.current?.(g.id, frame.x, frame.y);
      } else {
        onFrameChangeRef.current(g.id, frame);
      }
      setLiveFrame(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [clientToLogical, readOnly]);

  const beginGesture = useCallback((g: Gesture) => {
    gestureRef.current = g;
    setLiveFrame({ id: g.id, frame: g.startFrame });
  }, []);

  const startMove = useCallback(
    (e: React.PointerEvent, el: SlideElement) => {
      if (readOnly) return;
      if (editingTextId === el.id) return; // don't drag the box you're typing in
      e.stopPropagation();
      onSelect(el.id);
      const p = clientToLogical(e.clientX, e.clientY, layout);
      beginGesture({ kind: "move", id: el.id, startFrame: el.frame, startPointer: p });
    },
    [readOnly, editingTextId, onSelect, clientToLogical, beginGesture, layout],
  );

  const startResize = useCallback(
    (e: React.PointerEvent, el: SlideElement, corner: Corner) => {
      if (readOnly) return;
      e.stopPropagation();
      onSelect(el.id);
      beginGesture({ kind: "resize", id: el.id, corner, startFrame: el.frame });
    },
    [readOnly, onSelect, beginGesture],
  );

  const startRotate = useCallback(
    (e: React.PointerEvent, el: SlideElement) => {
      if (readOnly) return;
      e.stopPropagation();
      onSelect(el.id);
      beginGesture({ kind: "rotate", id: el.id, startFrame: el.frame });
    },
    [readOnly, onSelect, beginGesture],
  );

  const startMovePlaceholder = useCallback(
    (e: React.PointerEvent, ph: SlidePicturePlaceholder) => {
      if (readOnly) return;
      e.stopPropagation();
      const p = clientToLogical(e.clientX, e.clientY, layout);
      beginGesture({
        kind: "movePlaceholder",
        id: ph.id,
        startFrame: ph.frame,
        startPointer: p,
      });
    },
    [readOnly, clientToLogical, beginGesture, layout],
  );

  const effectiveFrame = (el: SlideElement): Frame =>
    liveFrame && liveFrame.id === el.id ? liveFrame.frame : el.frame;

  const ready = layout.scale > 0;

  return (
    <div
      ref={containerRef}
      // `touchAction: none` protects the drag/resize gestures, but a READ-ONLY
      // canvas has no gestures to protect and lives inside a scrolling list
      // (SlideList) — claiming the touch there would trap the scroll.
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", touchAction: readOnly ? "auto" : "none" }}
      onPointerDown={() => {
        if (editingTextId) onCancelTextEdit();
        onSelect(null);
      }}
    >
      {ready && (
        <div
          // The logical canvas, drawn at true size then scaled to fit.
          style={{
            position: "absolute",
            left: layout.offsetX,
            top: layout.offsetY,
            width: CANVAS_W,
            height: CANVAS_H,
            transform: `scale(${layout.scale})`,
            transformOrigin: "top left",
            background: slide.background,
            boxShadow: "0 1px 4px rgba(0,0,0,0.14)",
            userSelect: "none",
          }}
          onPointerDown={(e) => {
            // Clicks that reach the canvas (not an element) deselect.
            e.stopPropagation();
            if (editingTextId) onCancelTextEdit();
            onSelect(null);
          }}
        >
          {slide.elementIds.map((id) => {
            const el = slide.elements[id];
            if (!el) return null;
            const frame = effectiveFrame(el);
            const isEditing = editingTextId === id;
            return (
              <ElementBox
                resolveAsset={resolveAsset}
                key={id}
                el={el}
                frame={frame}
                onPointerDown={(e) => startMove(e, el)}
                onDoubleClick={
                  el.type === "text" && !readOnly ? () => onStartTextEdit(el.id) : undefined
                }
                hidden={isEditing}
                readOnly={readOnly}
              />
            );
          })}

          {/* Optimistic "Make a picture" placeholders — CLIENT-SIDE only, never
              persisted. They sit under the selection/text overlays and are
              DRAGGABLE, so the scholar can place the spinner where the finished
              image should land (mirrors the native DraggablePlaceholder). */}
          {placeholders?.map((p) => {
            const phFrame =
              liveFrame && liveFrame.id === p.id ? liveFrame.frame : p.frame;
            return (
              <PicturePlaceholder
                key={p.id}
                frame={phFrame}
                prompt={p.prompt}
                source={p.source}
                readOnly={readOnly}
                onPointerDown={(e) => startMovePlaceholder(e, p)}
              />
            );
          })}

          {/* Text editing overlay */}
          {editingTextId &&
            slide.elements[editingTextId]?.type === "text" &&
            (() => {
              const el = slide.elements[editingTextId] as Extract<SlideElement, { type: "text" }>;
              return (
                <TextEditor
                  key={`edit-${editingTextId}`}
                  id={el.id}
                  frame={el.frame}
                  initial={el.text}
                  style={el.style}
                  onCommit={(t, touched) => onCommitTextEdit(el.id, t, touched)}
                  onCancel={onCancelTextEdit}
                  register={registerTextDraft}
                />
              );
            })()}

          {/* Selection handles — hidden in readOnly and while editing text */}
          {!readOnly &&
            selectedId &&
            editingTextId !== selectedId &&
            slide.elements[selectedId] && (
              <SelectionOverlay
                el={slide.elements[selectedId]}
                frame={effectiveFrame(slide.elements[selectedId])}
                scale={layout.scale}
                onResizeStart={(e, corner) => startResize(e, slide.elements[selectedId], corner)}
                onRotateStart={(e) => startRotate(e, slide.elements[selectedId])}
              />
            )}
        </div>
      )}
    </div>
  );
}

// ─── Element rendering ──────────────────────────────────────────────────

function boxTransform(frame: Frame): React.CSSProperties {
  return {
    position: "absolute",
    left: frame.x,
    top: frame.y,
    width: frame.w,
    height: frame.h,
    transform: `rotate(${frame.rotation}deg)`,
    transformOrigin: "center center",
  };
}

function ElementBox({
  resolveAsset,
  el,
  frame,
  onPointerDown,
  onDoubleClick,
  hidden,
  readOnly,
}: {
  el: SlideElement;
  frame: Frame;
  onPointerDown: (e: React.PointerEvent) => void;
  onDoubleClick?: () => void;
  hidden?: boolean;
  resolveAsset?: (assetId: string) => string | null;
  readOnly: boolean;
}) {
  return (
    <div
      style={{ ...boxTransform(frame), cursor: "move", visibility: hidden ? "hidden" : "visible" }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      <SlideCanvasElementContent el={el} readOnly={readOnly} resolveAsset={resolveAsset} />
    </div>
  );
}

export function SlideCanvasElementContent({
  el,
  readOnly,
  resolveAsset,
}: {
  el: SlideElement;
  readOnly: boolean;
  resolveAsset?: (assetId: string) => string | null;
}) {
  if (el.type === "text") {
    const s = el.style;
    return (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: verticalAlignToJustify(s.verticalAlign),
          overflow: "hidden",
          padding: TEXT_PADDING,
          boxSizing: "border-box",
          fontFamily: SLIDE_FONT_FAMILY,
          fontSize: s.fontSize,
          fontWeight: s.bold ? 700 : 400,
          fontStyle: s.italic ? "italic" : "normal",
          color: s.color,
          textAlign: s.align,
          lineHeight: TEXT_LINE_HEIGHT_RATIO,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {el.text}
      </div>
    );
  }

  if (el.type === "image") {
    // Asset resolution belongs to the host (it owns the Convex subscription);
    // an unresolved id renders the labelled placeholder rather than a hole.
    const src = resolveAsset?.(el.assetId) ?? null;
    const alt = el.alt.trim();
    if (src) return <SlideImage src={src} alt={alt} frame={el.frame} />;
    return <ImagePlaceholder alt={alt} frame={el.frame} />;
  }

  if (el.type === "video") {
    const src = resolveAsset?.(el.assetId) ?? null;
    const alt = el.alt.trim();
    if (!src) return <ImagePlaceholder alt={alt || "Video"} frame={el.frame} />;
    return (
      <video
        aria-label={alt || "Video"}
        controls={readOnly}
        onPointerDown={(event) => {
          if (readOnly) event.stopPropagation();
        }}
        playsInline
        preload="metadata"
        src={src}
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    );
  }

  if (el.type === "line") {
    const { stroke, strokeWidth } = el.style;
    return (
      <svg width="100%" height="100%" viewBox={`0 0 ${el.frame.w} ${el.frame.h}`} preserveAspectRatio="none">
        <line
          x1={0}
          y1={el.frame.h / 2}
          x2={el.frame.w}
          y2={el.frame.h / 2}
          stroke={stroke ?? "#222656"}
          strokeWidth={lineStrokeLogical(strokeWidth)}
        />
      </svg>
    );
  }

  // rect / ellipse
  const { fill, stroke, strokeWidth } = el.style;
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        boxSizing: "border-box",
        background: fill ?? "transparent",
        border: stroke ? `${strokeWidth}px solid ${stroke}` : "none",
        borderRadius: el.type === "ellipse" ? "50%" : 0,
      }}
    />
  );
}

/**
 * A resolved image, with the SAME labelled placeholder as the unresolved case as
 * its fallback. A URL that resolves can still FAIL at request time — the device
 * is offline, or a Convex storage URL has expired — and without an onError path
 * the child is left staring at the browser's broken-image glyph. `onError` flips
 * to the placeholder; the failure is reset when `src` changes so a freshly
 * re-resolved asset gets a clean retry.
 */
function SlideImage({ src, alt, frame }: { src: string; alt: string; frame: Frame }) {
  const [failedSource, setFailedSource] = useState<string | null>(null);

  if (!shouldRenderSlideImage(src, failedSource)) return <ImagePlaceholder alt={alt} frame={frame} />;
  return (
    // Convex storage URLs are remote and short-lived; next/image would need a
    // loader and buys nothing inside a fixed-size slide box.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      draggable={false}
      onError={() => setFailedSource(src)}
      style={{ width: "100%", height: "100%", objectFit: "contain", userSelect: "none" }}
    />
  );
}

/** The labelled fallback shown when an image can't be resolved OR fails to load. */
function ImagePlaceholder({ alt, frame }: { alt: string; frame: Frame }) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        background: "#f1f1f4",
        border: "1px solid #d4d4dd",
        color: "#8a8a99",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <ImageIcon size={Math.min(48, Math.max(20, Math.min(frame.w, frame.h) * 0.3))} />
      {alt ? (
        <span style={{ fontSize: 14, fontFamily: SLIDE_FONT_FAMILY, textAlign: "center", padding: "0 8px" }}>
          {alt}
        </span>
      ) : null}
    </div>
  );
}

// ─── "Make a picture" placeholder (client-side, ephemeral) ──────────────

/**
 * The optimistic overlay for an in-flight generation: a rectangle carrying a
 * Chakra spinner and the scholar's prompt, drawn at the frame the finished
 * image will occupy. It is NEVER written into the deck — the real image element
 * is inserted only once the bytes exist — so it can't pollute undo history or
 * strand a ghost element if the tab closes mid-generation.
 */
function PicturePlaceholder({
  frame,
  prompt,
  source,
  readOnly,
  onPointerDown,
}: {
  frame: Frame;
  prompt: string;
  source: "generate" | "find";
  readOnly: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      style={{
        ...boxTransform(frame),
        // Draggable so the scholar can place the spinner where the finished
        // image should land; a read-only canvas has no gestures to claim.
        pointerEvents: readOnly ? "none" : "auto",
        cursor: readOnly ? "default" : "move",
        touchAction: readOnly ? "auto" : "none",
      }}
      onPointerDown={readOnly ? undefined : onPointerDown}
    >
      <div
        // Announce the pending picture the way the native placeholder does —
        // otherwise a screen-reader user gets silence for the whole generation.
        role="status"
        aria-label={`${
          source === "find" ? FIND_IMAGE_COPY.inserting : MAKE_PICTURE_COPY.busy
        } ${prompt}`.trim()}
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: "0 16px",
          background: "#f1f1f4",
          border: "1px solid #d4d4dd",
          color: "#6a6a7a",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        <Spinner size="lg" color="cyan.500" borderWidth="3px" />
        {prompt ? (
          <span
            style={{
              fontSize: 16,
              fontFamily: SLIDE_FONT_FAMILY,
              textAlign: "center",
              maxHeight: "40%",
              overflow: "hidden",
            }}
          >
            {prompt}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ─── Selection overlay (outline + handles) ──────────────────────────────

function SelectionOverlay({
  el,
  frame,
  scale,
  onResizeStart,
  onRotateStart,
}: {
  el: SlideElement;
  frame: Frame;
  scale: number;
  onResizeStart: (e: React.PointerEvent, corner: Corner) => void;
  onRotateStart: (e: React.PointerEvent) => void;
}) {
  // Handles must stay a constant SCREEN size, so express them in logical units.
  const hz = HANDLE_PX / scale;
  const hit = HANDLE_HIT_PX / scale;
  const corners: Array<{ corner: Corner; cx: number; cy: number; cursor: string }> = [
    { corner: "topLeft", cx: 0, cy: 0, cursor: "nwse-resize" },
    { corner: "topRight", cx: frame.w, cy: 0, cursor: "nesw-resize" },
    { corner: "bottomRight", cx: frame.w, cy: frame.h, cursor: "nwse-resize" },
    { corner: "bottomLeft", cx: 0, cy: frame.h, cursor: "nesw-resize" },
  ];
  const rotatable = el.type !== "text" && el.type !== "video";

  return (
    <div style={{ ...boxTransform(frame), pointerEvents: "none" }}>
      {/* Outline */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          border: `${Math.max(1, 1.5 / scale)}px solid ${CYAN}`,
        }}
      />

      {/* PowerPoint media cannot rotate, so videos stay axis-aligned like text. */}
      {rotatable && (
        <>
          <div
            style={{
              position: "absolute",
              left: frame.w / 2,
              top: 0,
              width: 0,
              height: ROTATE_GAP,
              borderLeft: `${Math.max(1, 1.5 / scale)}px solid ${CYAN}`,
              transform: `translate(0, -${ROTATE_GAP}px)`,
            }}
          />
          <Handle
            left={frame.w / 2}
            top={-ROTATE_GAP}
            size={hz}
            hit={hit}
            round
            cursor="grab"
            onPointerDown={onRotateStart}
          />
        </>
      )}

      {/* Corner resize handles */}
      {corners.map((c) => (
        <Handle
          key={c.corner}
          left={c.cx}
          top={c.cy}
          size={hz}
          hit={hit}
          cursor={c.cursor}
          onPointerDown={(e) => onResizeStart(e, c.corner)}
        />
      ))}
    </div>
  );
}

function Handle({
  left,
  top,
  size,
  hit,
  cursor,
  round,
  onPointerDown,
}: {
  left: number;
  top: number;
  size: number;
  hit: number;
  cursor: string;
  round?: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      // Transparent oversized hit target, centred on the point.
      style={{
        position: "absolute",
        left,
        top,
        width: hit,
        height: hit,
        transform: "translate(-50%, -50%)",
        pointerEvents: "auto",
        cursor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onPointerDown={onPointerDown}
    >
      {/* Visible knob */}
      <div
        style={{
          width: size,
          height: size,
          background: "#ffffff",
          border: `${Math.max(1, size * 0.14)}px solid ${CYAN}`,
          borderRadius: round ? "50%" : 2,
          boxShadow: "0 1px 2px rgba(0,0,0,0.2)",
        }}
      />
    </div>
  );
}

// ─── Text editing overlay ────────────────────────────────────────────────

function TextEditor({
  id,
  frame,
  initial,
  style,
  onCommit,
  onCancel,
  register,
}: {
  id: string;
  frame: Frame;
  initial: string;
  style: Extract<SlideElement, { type: "text" }>["style"];
  onCommit: (text: string, touched: boolean) => void;
  onCancel: () => void;
  register?: (draft: { id: string; read: () => string } | null) => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const valueRef = useRef(initial);
  // Whether this edit session changed anything. The owner cannot infer it from
  // the committed text: emptying a box that was already blank is a real edit
  // that must remove it, while opening and closing that same box must not.
  const touchedRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Publish the live draft so the owner can flush it when the tab is hidden.
  useEffect(() => {
    if (!register) return;
    register({ id, read: () => valueRef.current });
    return () => register(null);
  }, [id, register]);

  // The textarea sits exactly on top of the rendered text, so it has to lay
  // out identically or the words visibly shift the moment you start editing.
  // That means reading the same metrics the renderer does, not copies of them.
  const justify = verticalAlignToJustify(style.verticalAlign);

  return (
    <div
      style={{ ...boxTransform(frame), display: "flex", flexDirection: "column", justifyContent: justify }}
      // Keep clicks inside the editor from bubbling to the canvas deselect.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => {
          touchedRef.current = true;
          valueRef.current = e.target.value;
          setValue(e.target.value);
        }}
        onBlur={() => onCommit(value, touchedRef.current)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onCommit(value, touchedRef.current);
          }
        }}
        style={{
          width: "100%",
          height: "100%",
          resize: "none",
          border: `2px solid ${CYAN}`,
          outline: "none",
          padding: TEXT_PADDING,
          margin: 0,
          boxSizing: "border-box",
          background: "rgba(255,255,255,0.92)",
          fontFamily: SLIDE_FONT_FAMILY,
          fontSize: style.fontSize,
          fontWeight: style.bold ? 700 : 400,
          fontStyle: style.italic ? "italic" : "normal",
          color: style.color,
          textAlign: style.align,
          lineHeight: TEXT_LINE_HEIGHT_RATIO,
        }}
      />
    </div>
  );
}
