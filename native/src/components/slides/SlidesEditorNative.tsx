/**
 * SlidesEditorNative — the native (React Native) slide editor, the inline twin
 * of the web `components/slides/SlidesEditor.tsx`. Both drive the SAME document
 * (`vendor/shared/slidesScene`), exactly as GeoMapNative and the web GeoMap
 * implement one shared spec: no webview, native gestures, native keyboard.
 *
 * Grown out of the `/dev-slides` spike, which existed to answer the only
 * question that mattered — does touch-first slide manipulation feel right on an
 * iPad? Two defects the spike surfaced are fixed here at the root, and both are
 * easy to reintroduce:
 *
 *  1. SHARED VALUES HOLD ABSOLUTE GEOMETRY, and are the single source of truth
 *     while a gesture is in flight. The spike stored deltas and reset them in
 *     the gesture's onEnd worklet right after committing; the reset landed a
 *     frame before React did, so the element snapped back and then jumped
 *     forward. Absolute values mean there is nothing to reset and no window
 *     where the two disagree.
 *  2. POSITION COMES FROM `transform`, NEVER `left`/`top`. Those are layout
 *     props: animating them forces a layout pass per frame and the view falls
 *     progressively behind the finger. translateX/translateY are composited on
 *     the UI thread and stay glued to the touch.
 *
 * The component is CONTROLLED and emits OPERATIONS, not decks. It never mutates
 * the deck locally: gestures drive shared values for immediate feedback, and on
 * gesture END it emits an id-addressed op batch. The host sends that to Convex,
 * which is authoritative (it mints ids and bumps `revision`), and the new deck
 * arrives back through the existing reactive subscription. Applying edits
 * locally would fork ids between client and server.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  ScrollView as RNGHScrollView,
} from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";

import {
  CANVAS_H,
  CANVAS_W,
  INSERT_KINDS,
  MAX_TEXT_LENGTH,
  MIN_ELEMENT_SIZE,
  NEW_ELEMENT_PRESETS,
  SLIDES_COPY,
  applySlideOps,
  canRedo,
  canUndo,
  createHistory,
  isBlankSlideText,
  makeDeckIdFactory,
  nextInsertFrame,
  pushHistory,
  redo as redoStep,
  textCommitOps,
  undo as undoStep,
  type Deck,
  type Frame,
  type SlideHistory,
  type SlideElement,
  type SlideOp,
} from "../../../vendor/shared/slidesScene";
import {
  clipsOverflow,
  verticalAlignToJustify,
} from "../../../vendor/shared/slidesRenderContract";
import {
  MAKE_PICTURE_COPY,
  FIND_IMAGE_COPY,
} from "../../../vendor/shared/slidesScene";
import {
  placeholderFrameForSlot,
  resolvedImageFrame,
  nextCascadeSlot,
} from "./makePicture";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { ScribbleIcon } from "phosphor-react-native";
import { fonts, useColors } from "@/theme";
import {
  CommandTextInput,
  isCommandTextInputAvailable,
} from "@/lib/commandTextInput";
import { useHardwareKeyboard } from "@/lib/hardwareKeyboard";
import {
  KeyCaptureView,
  isKeyCaptureAvailable,
  isKeyCaptureChordAvailable,
} from "@/lib/keyCapture";
import { SlideElementContentNative } from "./SlideElementContentNative";

/** Visible knob vs. its touch target — the manipulatives-kit rule (kit.tsx). */
const HANDLE_VISUAL = 20;
const HANDLE_HIT = 52;
/**
 * How long a text draft may sit untyped-in before it is written through.
 * Long enough that a normal pause between words doesn't hit the network,
 * short enough that a scholar who walks away mid-sentence keeps their words.
 */
const DRAFT_AUTOSAVE_MS = 2000;
const TEXT_SIZE_OPTIONS = [
  { label: "Small", fontSize: 28 },
  { label: "Medium", fontSize: 40 },
  { label: "Large", fontSize: 56 },
] as const;

const INSERT_SYMBOLS: Record<
  (typeof INSERT_KINDS)[number],
  SymbolViewProps["name"]
> = {
  text: "textformat",
  rect: "rectangle",
  ellipse: "circle",
  line: "line.diagonal",
};

/**
 * RNGH types `blocksExternalGesture` narrowly; the manipulatives kit casts at
 * each call site (kit.tsx:408). Name the cast once.
 */
type BlockRef = Parameters<
  ReturnType<typeof Gesture.Pan>["blocksExternalGesture"]
>[0];

function rotatePoint(dx: number, dy: number, deg: number) {
  "worklet";
  const r = (deg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

export type SlidesEditorNativeProps = {
  deck: Deck;
  /** Emitted on gesture END / edit commit. The host persists; it never round-trips per frame. */
  onOps?: (ops: SlideOp[]) => boolean | void | Promise<boolean | void>;
  readOnly?: boolean;
  /** Render the vertical read-only right-panel slide list instead of the full editor layout. */
  compact?: boolean;
  /** Controlled slide index, so a host can drive the pager (e.g. from a tool call). */
  slideIndex?: number;
  onSlideIndexChange?: (i: number) => void;
  /** In compact read-only mode, tapping a slide opens the full editor on that slide. */
  onCanvasPress?: () => void;
  /**
   * Resolve an image element's `assetId` to a displayable URL. The scene stores
   * ids, never bytes, so resolution belongs to the host (which owns the Convex
   * subscription). Returning null renders the labelled placeholder.
   */
  resolveAsset?: (assetId: string) => string | null;
  /**
   * Capture, pick, or generate media, then upload/store it. Absent = no media
   * button. A generated image carries prompt-derived `alt`; a picked photo omits
   * it and falls back to the preset label.
   */
  onAddMedia?: () => Promise<SlideMedia | null>;
  /** Open the shared Scratchpad, upload its PNG, and return it as slide media. */
  onAddSketch?: () => Promise<SlideMedia | null>;
  /** Render the deck to a real file and hand it off. Absent = no export. */
  onExport?: (format: "pptx" | "pdf") => Promise<void>;
  /**
   * NO `onPresent`. Present is a HOST action with one canonical home: the
   * surrounding chrome's header (`SlidesDeliverable`'s modal header on the real
   * scholar surface, the harness's own header on `/dev-slides`). A second
   * labelled Present inside this toolbar rendered only for the harness, which
   * made the dev surface misrepresent what a scholar actually sees. Hosts drive
   * it through the ref: `await commitPendingEdit()`, then present.
   */
  /** Controlled top-level editor view. Omit to let compact viewers manage it locally. */
  gridOpen?: boolean;
  onGridOpenChange?: (open: boolean) => void;
};

export type SlideMedia = {
  type: "image" | "video";
  assetId: string;
  alt?: string;
};

export type SlidesEditorNativeHandle = {
  commitPendingEdit: () => Promise<boolean>;
  /**
   * Optimistic "Make a picture": drop a spinner placeholder on the CURRENT slide
   * and return its id. The placeholder is client-only (never persisted) — the
   * real image element is written by `resolveImagePlaceholder` once the bytes
   * exist, so a tab closed mid-generation strands no ghost element in the deck.
   */
  startImagePlaceholder: (
    prompt: string,
    source?: "generate" | "find",
  ) => string;
  /** Generation finished: replace the placeholder with the real image element. */
  resolveImagePlaceholder: (
    id: string,
    media: { assetId: string; alt: string; width?: number; height?: number },
  ) => void;
  /** Generation failed or was abandoned: remove the placeholder, write nothing. */
  failImagePlaceholder: (id: string) => void;
  /**
   * The slide a generation started on. The host captures this at submit time so
   * a picture that finishes AFTER the editor closed can still be written to the
   * right slide instead of being stranded (it is already paid for).
   */
  currentSlideId: () => string | null;
  /** The cascade slot a placeholder holds, so a host fallback can reuse it. */
  slotForPlaceholder: (id: string) => number | null;
};

/** A client-side spinner standing in for an image still being generated. */
type ImagePlaceholder = {
  id: string;
  slideId: string;
  slot: number;
  prompt: string;
  frame: Frame;
  // Which image source spawned this placeholder, so the busy announcement uses
  // the matching copy: generation ("Making your image…") vs web search
  // ("Adding your image…"). Both surfaces share the same cascade otherwise.
  source: "generate" | "find";
};

export const SlidesEditorNative = forwardRef<
  SlidesEditorNativeHandle,
  SlidesEditorNativeProps
>(function SlidesEditorNative(
  {
    deck,
    onOps,
    readOnly = false,
    compact = false,
    slideIndex,
    onSlideIndexChange,
    onCanvasPress,
    resolveAsset,
    onAddMedia,
    onAddSketch,
    onExport,
    gridOpen: controlledGridOpen,
    onGridOpenChange,
  },
  ref,
) {
  const colors = useColors();
  const hardwareKeyboard = useHardwareKeyboard();
  const scrollRef = useRef<unknown>(null);
  const [internalIndex, setInternalIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The in-flight text. RN's multiline onBlur carries a TargetedEvent with no
  // `text`, so the draft is tracked here rather than read off the event.
  const [draft, setDraft] = useState("");
  // Whether THIS edit session actually changed the text. A pre-existing blank
  // box that is opened and closed again must be left exactly as it was found,
  // so the whitespace-removal rule only applies to a session the scholar typed
  // in (see `commitTextEdit`).
  const draftDirty = useRef(false);
  const [notesDraft, setNotesDraft] = useState("");
  const notesFocused = useRef(false);
  const notesSlideId = useRef<string | null>(null);
  const notesSaved = useRef("");
  const pendingNotes = useRef(new Map<string, string>());
  const notesCommitInFlight = useRef<Promise<boolean> | null>(null);
  const notesSaveFailed = useRef(false);
  const cancelTextBlur = useRef(false);
  // Set when an insert was sent; cleared by selecting the element that lands
  // (inserts append, so it is the last one). The server mints the id, so it is
  // not known synchronously.
  const [insertPending, setInsertPending] = useState(false);
  const [boxW, setBoxW] = useState(0);
  const [boxH, setBoxH] = useState(0);
  const [internalGridOpen, setInternalGridOpen] = useState(false);
  const gridOpen = controlledGridOpen ?? internalGridOpen;
  const setGridOpen = useCallback(
    (open: boolean) => {
      if (onGridOpenChange) onGridOpenChange(open);
      else setInternalGridOpen(open);
    },
    [onGridOpenChange],
  );
  const lastThumbnailTap = useRef<{ index: number; at: number } | null>(null);
  const [history, setHistory] = useState<SlideHistory>(() => createHistory());
  // Render the local scene until Convex confirms it. The server-backed `deck`
  // prop still contains the prior revision between an edit and its subscription
  // update; rendering that snapshot after blur makes edited text briefly revert.
  const [visibleDeck, setVisibleDeck] = useState(deck);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- this reconciles an authoritative subscription snapshot.
    setVisibleDeck((current) => (deck.revision >= current.revision ? deck : current));
  }, [deck]);

  const index = Math.min(
    slideIndex ?? internalIndex,
    Math.max(0, visibleDeck.slides.length - 1),
  );
  const slide = visibleDeck.slides[index];
  // Read the current slide from imperative-handle callbacks without stale
  // closures — `startImagePlaceholder` runs long after the render that created it.
  // The deck as this editor currently sees it, readable from async work: a
  // generation that finishes after its slide was deleted must not write to it.
  const visibleDeckRef = useRef(visibleDeck);
  useEffect(() => {
    visibleDeckRef.current = visibleDeck;
  }, [visibleDeck]);
  const slideRef = useRef(slide);
  useEffect(() => {
    slideRef.current = slide;
  }, [slide]);
  const scale =
    boxW > 0 && boxH > 0
      ? Math.min(boxW / CANVAS_W, boxH / CANVAS_H)
      : 0;

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setBoxW(e.nativeEvent.layout.width);
    setBoxH(e.nativeEvent.layout.height);
  }, []);

  const emit = useCallback(
    (ops: SlideOp[]) => {
      if (readOnly || !onOps || ops.length === 0) return true;
      return onOps(ops);
    },
    [onOps, readOnly],
  );

  // Two mutations can land in ONE tick — adding a slide also commits the text
  // edit that was in flight — so the base deck is read from the ref, not from
  // state that React has not re-rendered yet. Reading the state here made the
  // second op apply to the pre-first-op deck and drop it from the local view.
  const mutate = useCallback((ops: SlideOp[], record = true) => {
    if (readOnly) return true;
    const before = visibleDeckRef.current;
    const result = applySlideOps(before, ops, makeDeckIdFactory(before));
    if (!result.ok) return false;
    visibleDeckRef.current = result.deck;
    setVisibleDeck(result.deck);
    if (record) setHistory((h) => pushHistory(h, before, ops, result.createdIds));
    return emit(ops);
  }, [emit, readOnly]);

  const commitSpeakerNotes = useCallback(async () => {
    const slideId = notesSlideId.current;
    notesFocused.current = false;
    notesSlideId.current = null;
    const hasNewDraft = Boolean(slideId && notesDraft !== notesSaved.current);
    if (slideId && hasNewDraft) pendingNotes.current.set(slideId, notesDraft);

    if (!hasNewDraft && notesCommitInFlight.current) {
      const inFlightSaved = await notesCommitInFlight.current;
      if (inFlightSaved) return true;
    }

    if (!hasNewDraft && !notesSaveFailed.current) return true;

    const pendingOps = Array.from(pendingNotes.current, ([pendingSlideId, notes]) => ({
      op: "setSpeakerNotes" as const,
      slideId: pendingSlideId,
      notes,
    }));
    if (pendingOps.length === 0) return true;

    const previousCommit = notesCommitInFlight.current;
    const commit = (async () => {
      await (previousCommit ?? true);
      const saved = await mutate(pendingOps);
      return saved !== false;
    })();
    notesCommitInFlight.current = commit;
    const saved = await commit;
    if (notesCommitInFlight.current === commit) notesCommitInFlight.current = null;
    notesSaveFailed.current = !saved;
    return saved;
  }, [mutate, notesDraft]);

  useEffect(() => {
    if (notesFocused.current && notesSlideId.current !== slide?.id) {
      void commitSpeakerNotes();
    }
    if (!notesFocused.current) {
      const saved = slide?.speakerNotes ?? "";
      const pending = slide ? pendingNotes.current.get(slide.id) : undefined;
      if (slide && pending === saved) {
        pendingNotes.current.delete(slide.id);
        if (pendingNotes.current.size === 0) notesSaveFailed.current = false;
      }
      setNotesDraft(pending ?? saved);
      notesSaved.current = saved;
    }
  }, [commitSpeakerNotes, slide]);

  /**
   * End the edit session and write the result. This is the DEFOCUS path — blur,
   * slide switch, deselect, chord, the host's close/present/export — and the
   * only one that may delete a box the scholar left blank.
   */
  const commitTextEdit = useCallback(() => {
    if (cancelTextBlur.current) {
      cancelTextBlur.current = false;
      return true;
    }
    if (!editingId) return true;
    const el = slide?.elements[editingId];
    const touched = draftDirty.current;
    cancelTextBlur.current = true;
    draftDirty.current = false;
    setEditingId(null);
    if (el?.type !== "text" || !touched) return true;
    // The idle auto-save may already have written this exact text, so an
    // unchanged draft normally has nothing left to do — but a blank box still
    // has to be removed, and by then its blank text IS what is stored.
    if (draft === el.text && !isBlankSlideText(draft)) return true;
    return mutate(textCommitOps(slide.id, editingId, draft));
  }, [draft, editingId, mutate, slide]);

  /**
   * Write the in-flight draft WITHOUT ending the edit session: the idle
   * auto-save, the backgrounding flush and the unmount backstop all use this.
   * It deliberately leaves the overlay open (the scholar is still typing, and
   * closing it under them would eat the next keystroke) and never touches a
   * blank draft: there are no words to save, and writing the blank through
   * would make the eventual defocus look like an unchanged commit and leave the
   * invisible box behind.
   */
  const persistTextDraft = useCallback(() => {
    if (!editingId || isBlankSlideText(draft)) return;
    // Read the slide from the ref: this runs from a timer or an AppState
    // callback, long after the render that created the closure.
    const current = slideRef.current;
    const el = current?.elements[editingId];
    if (el?.type !== "text" || draft === el.text) return;
    mutate([
      { op: "patchElement", slideId: current.id, id: editingId, text: draft },
    ]);
  }, [draft, editingId, mutate]);

  useEffect(() => {
    if (!editingId) return;
    const timer = setTimeout(persistTextDraft, DRAFT_AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [editingId, persistTextDraft]);

  const commitDraftsNow = useCallback(() => {
    void commitSpeakerNotes();
    persistTextDraft();
  }, [commitSpeakerNotes, persistTextDraft]);
  const commitDraftsNowRef = useRef(commitDraftsNow);
  useEffect(() => {
    commitDraftsNowRef.current = commitDraftsNow;
  }, [commitDraftsNow]);

  // The editor holds the ONLY copy of an in-flight draft, and nothing else
  // flushes it when the app goes away: force-quitting from the app switcher
  // never fires a blur, so typed text was lost permanently. Both listeners read
  // the current commit through a ref so neither re-subscribes per keystroke.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "inactive" || state === "background") {
        commitDraftsNowRef.current();
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => () => commitDraftsNowRef.current(), []);

  const setIndex = useCallback(
    (i: number) => {
      void commitSpeakerNotes();
      // The text overlay unmounts with the slide, so its `onBlur` is not a
      // reliable commit point here — a scholar who typed and then tapped
      // another slide lost the draft. Commit it on this path, exactly as the
      // Present/export path (`commitPendingEdit`) does.
      commitTextEdit();
      setSelectedId(null);
      setEditingId(null);
      if (onSlideIndexChange) onSlideIndexChange(i);
      else setInternalIndex(i);
    },
    [commitSpeakerNotes, commitTextEdit, onSlideIndexChange],
  );

  const undo = useCallback(() => {
    const step = undoStep(history);
    if (!step) return;
    setHistory(step.history);
    mutate(step.ops, false);
  }, [history, mutate]);
  const redo = useCallback(() => {
    const step = redoStep(history);
    if (!step) return;
    setHistory(step.history);
    mutate(step.ops, false);
  }, [history, mutate]);

  const commitFrame = useCallback(
    (id: string, frame: Frame) => {
      mutate([{ op: "patchElement", slideId: slide.id, id, frame }]);
    },
    [mutate, slide],
  );

  const editing = editingId ? slide?.elements[editingId] : null;
  const selectedElement = selectedId ? slide?.elements[selectedId] : null;

  /** Seed the draft from the element whenever an edit session opens. */
  const beginEdit = useCallback(
    (id: string) => {
      const el = slide?.elements[id];
      cancelTextBlur.current = false;
      draftDirty.current = false;
      setDraft(el && el.type === "text" ? el.text : "");
      setEditingId(id);
    },
    [slide],
  );

  const onDraftChange = useCallback((text: string) => {
    draftDirty.current = true;
    setDraft(text);
  }, []);

  const [addingMedia, setAddingMedia] = useState(false);
  const [exporting, setExporting] = useState<null | "pptx" | "pdf">(null);

  // "Make a picture" placeholders. Client-only overlays (never persisted) that
  // stand in for images still generating; a mirror ref lets the imperative
  // handle read the live set synchronously without a stale closure.
  const [placeholders, setPlaceholdersState] = useState<ImagePlaceholder[]>([]);
  const placeholdersRef = useRef<ImagePlaceholder[]>([]);
  const placeholderCounter = useRef(0);
  const setPlaceholders = useCallback(
    (updater: (prev: ImagePlaceholder[]) => ImagePlaceholder[]) => {
      setPlaceholdersState((prev) => {
        const next = updater(prev);
        placeholdersRef.current = next;
        return next;
      });
    },
    [],
  );

  const startImagePlaceholder = useCallback(
    (prompt: string, source: "generate" | "find" = "generate"): string => {
      const id = `imgph_${placeholderCounter.current++}`;
      const slideId = slideRef.current?.id;
      if (!slideId) return id;
      // Cascade into a free slot so a second generation doesn't land on top of
      // the first. Images ALREADY on the slide occupy the leading slots too —
      // a slot frees the moment its placeholder resolves, so counting only
      // in-flight ones makes sequential pictures stack pixel-for-pixel.
      const slide = slideRef.current;
      const imagesOnSlide = slide
        ? slide.elementIds.filter(
            (elementId) => slide.elements[elementId]?.type === "image",
          ).length
        : 0;
      const slot = nextCascadeSlot(
        placeholdersRef.current
          .filter((p) => p.slideId === slideId)
          .map((p) => p.slot),
        imagesOnSlide,
      );
      setPlaceholders((prev) => [
        ...prev,
        {
          id,
          slideId,
          slot,
          prompt,
          source,
          frame: placeholderFrameForSlot(slot),
        },
      ]);
      return id;
    },
    [setPlaceholders],
  );

  const failImagePlaceholder = useCallback(
    (id: string) => {
      setPlaceholders((prev) => prev.filter((p) => p.id !== id));
    },
    [setPlaceholders],
  );

  // A scholar can drag the in-flight spinner to where they want the picture to
  // land; the finished image then resolves onto this moved frame (see
  // resolveImagePlaceholder, which reads ph.frame).
  const moveImagePlaceholder = useCallback(
    (id: string, x: number, y: number) => {
      setPlaceholders((prev) =>
        prev.map((p) =>
          p.id === id ? { ...p, frame: { ...p.frame, x, y } } : p,
        ),
      );
    },
    [setPlaceholders],
  );

  const resolveImagePlaceholder = useCallback(
    (
      id: string,
      media: { assetId: string; alt: string; width?: number; height?: number },
    ) => {
      const ph = placeholdersRef.current.find((p) => p.id === id);
      setPlaceholders((prev) => prev.filter((p) => p.id !== id));
      if (!ph) return;
      // The scholar may have deleted the target slide while this generated.
      // Writing to a slide that no longer exists fails the op, so drop it
      // rather than surfacing an internal error on a child's work surface.
      if (!visibleDeckRef.current.slides.some((s) => s.id === ph.slideId)) return;
      // Land the real image where the spinner sat (fitted to its true aspect, so
      // no letterbox), on the placeholder's OWN slide — the scholar may have
      // paged away while it generated. `addElement` mints the id server-side, the
      // same path a picked photo takes.
      const preset = NEW_ELEMENT_PRESETS.image(media.assetId);
      mutate([
        {
          op: "addElement",
          slideId: ph.slideId,
          element: {
            ...preset,
            alt: media.alt,
            frame: resolvedImageFrame(ph.frame, media.width, media.height),
          },
        },
      ]);
    },
    [mutate, setPlaceholders],
  );

  // Export parity: a deck a kid cannot hand to anyone is the lock-in this whole
  // feature exists to remove, and the iPad is the PRIMARY scholar surface.
  const runExport = useCallback(
    async (format: "pptx" | "pdf") => {
      if (!onExport || exporting) return;
      setExporting(format);
      try {
        await onExport(format);
      } finally {
        setExporting(null);
      }
    },
    [onExport, exporting],
  );

  /**
   * Insert an element. Presets come from the SHARED scene module, so a
   * rectangle a kid drops on the iPad is byte-identical to one dropped on the
   * web — the parity is structural, not a matter of keeping two lists in step.
   */
  const insertElement = useCallback(
    (kind: (typeof INSERT_KINDS)[number]) => {
      if (!slide) return;
      const preset = NEW_ELEMENT_PRESETS[kind]();
      // Occupancy must come from the deck as it stands RIGHT NOW, not from the
      // render closure. `mutate` updates visibleDeckRef synchronously but the
      // rendered `slide` only catches up on the next render, so two quick taps
      // both measured the pre-first-insert slide and picked the same free slot
      // — re-creating, in the fast path, the exact stacking this cascade exists
      // to prevent.
      const current =
        visibleDeckRef.current.slides.find((s) => s.id === slide.id) ?? slide;
      mutate([
        {
          op: "addElement",
          slideId: current.id,
          element: { ...preset, frame: nextInsertFrame(current, preset.frame) },
        },
      ]);
      setInsertPending(true);
    },
    [mutate, slide],
  );

  const deleteSelected = useCallback(() => {
    if (!slide || !selectedId) return;
    mutate([{ op: "removeElement", slideId: slide.id, id: selectedId }]);
    setSelectedId(null);
  }, [mutate, slide, selectedId]);

  const addSlideAt = useCallback(
    (afterSlideId: string | null | undefined, nextIndex: number) => {
      mutate([{ op: "addSlide", afterSlideId }]);
      setIndex(nextIndex);
      setGridOpen(false);
    },
    [mutate, setGridOpen, setIndex],
  );

  const removeSlideAt = useCallback(
    (slideId: string, slideIndex: number) => {
      if (visibleDeck.slides.length <= 1) return;
      const remove = () => {
        pendingNotes.current.delete(slideId);
        if (notesSlideId.current === slideId) {
          notesFocused.current = false;
          notesSlideId.current = null;
        }
        if (pendingNotes.current.size === 0) notesSaveFailed.current = false;
        mutate([{ op: "removeSlide", slideId }]);
        setIndex(
          slideIndex < index
            ? index - 1
            : slideIndex === index
              ? Math.max(0, index - 1)
              : index,
        );
      };
      const target = visibleDeck.slides[slideIndex];
      if (target?.elementIds.length) {
        Alert.alert(
          SLIDES_COPY.deleteSlideConfirmTitle,
          SLIDES_COPY.deleteSlideConfirmBody,
          [
            { text: SLIDES_COPY.cancel, style: "cancel" },
            { text: SLIDES_COPY.deleteSlide, style: "destructive", onPress: remove },
          ],
        );
      } else {
        remove();
      }
    },
    [visibleDeck.slides, index, mutate, setIndex],
  );

  const showSlideMenu = useCallback(
    (slideIndex: number) => {
      const target = visibleDeck.slides[slideIndex];
      if (!target) return;
      Alert.alert(SLIDES_COPY.slideTitle(slideIndex + 1), undefined, [
        {
          text: SLIDES_COPY.addSlideBefore,
          onPress: () =>
            addSlideAt(
              slideIndex === 0 ? null : visibleDeck.slides[slideIndex - 1].id,
              slideIndex,
            ),
        },
        {
          text: SLIDES_COPY.addSlideAfter,
          onPress: () => addSlideAt(target.id, slideIndex + 1),
        },
        ...(visibleDeck.slides.length > 1
          ? [
              {
                text: SLIDES_COPY.deleteSlide,
                style: "destructive" as const,
                onPress: () => removeSlideAt(target.id, slideIndex),
              },
            ]
          : []),
        { text: SLIDES_COPY.cancel, style: "cancel" },
      ]);
    },
    [addSlideAt, visibleDeck.slides, removeSlideAt],
  );

  /**
   * Insert captured or picked media. The upload happens FIRST and the element is
   * only added once an assetId exists — a media element with no asset is rejected
   * by the scene
   * validator, and a placeholder the kid could move around before the upload
   * finished would be a lie about what is saved.
   */
  const addMedia = useCallback(async (
    loadMedia: (() => Promise<SlideMedia | null>) | undefined,
  ) => {
    if (!loadMedia || addingMedia) return;
    setAddingMedia(true);
    try {
      const media = await loadMedia();
      if (!media) return;
      const preset = NEW_ELEMENT_PRESETS[media.type](media.assetId);
      mutate([
        {
          op: "addElement",
          slideId: slide.id,
          // A generated image labels itself from the scholar's prompt; a picked
          // photo keeps the preset's fallback label.
          element: media.alt ? { ...preset, alt: media.alt } : preset,
        },
      ]);
    } finally {
      setAddingMedia(false);
    }
  }, [addingMedia, mutate, slide?.id]);

  const onChord = useCallback((chord: "Escape" | "Cmd+Enter") => {
    if (chord === "Escape") {
      cancelTextBlur.current = true;
      draftDirty.current = false;
      setEditingId(null);
      setSelectedId(null);
    } else if (editingId) {
      // Cmd+Enter is a defocus like any other, so it goes through the one
      // commit path rather than hand-rolling its own patch.
      commitTextEdit();
    }
  }, [commitTextEdit, editingId]);

  const commitPendingEdit = useCallback(async () => {
    const notesSavedSuccessfully = await commitSpeakerNotes();
    if (!notesSavedSuccessfully) return false;
    return (await commitTextEdit()) !== false;
  }, [commitSpeakerNotes, commitTextEdit]);

  useImperativeHandle(
    ref,
    () => ({
      commitPendingEdit,
      startImagePlaceholder,
      resolveImagePlaceholder,
      failImagePlaceholder,
      currentSlideId: () => slideRef.current?.id ?? null,
      slotForPlaceholder: (id: string) =>
        placeholdersRef.current.find((p) => p.id === id)?.slot ?? null,
    }),
    [
      commitPendingEdit,
      startImagePlaceholder,
      resolveImagePlaceholder,
      failImagePlaceholder,
    ],
  );

  useEffect(() => {
    if (!insertPending) return;
    const ids = slide?.elementIds;
    if (!ids || ids.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server mints the inserted id, so selection waits for its subscription echo.
    setSelectedId(ids[ids.length - 1]);
    setInsertPending(false);
  }, [slide, insertPending]);

  /**
   * Deselect lives on a BACKDROP rendered behind the elements, not on the
   * canvas itself. A canvas-level Tap recognises on the FIRST tap and beat the
   * element's double-tap, which broke tap-to-edit (caught on device).
   *
   * This DOES fire while a text overlay is open — probed on a leased sim
   * (2026-08-31): tapping empty canvas mid-edit ran this handler with the live
   * `editingId`, committed, and closed the overlay. The custom UITextView does
   * not swallow the outside tap, so a "tap away does nothing" report is a sign
   * the tap landed on an invisible element instead of the backdrop.
   */
  const deselect = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- React Native Gesture Handler invokes this callback outside React render.
      Gesture.Tap().runOnJS(true).onEnd(() => {
        void commitTextEdit();
        setSelectedId(null);
      }),
    [commitTextEdit],
  );

  if (!slide) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={[styles.emptyText, { fontFamily: fonts.regular, color: colors.fgMuted }]}>
          This deck has no slides yet.
        </Text>
      </View>
    );
  }

  if (compact) {
    return (
      <CompactSlidesViewer
        deck={visibleDeck}
        onGo={setIndex}
        onOpenEditor={onCanvasPress}
        resolveAsset={resolveAsset}
      />
    );
  }

  return (
    <RNGHScrollView
      ref={scrollRef as never}
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={styles.body}
      keyboardShouldPersistTaps="handled"
      scrollEnabled={false}
      bounces={false}
      alwaysBounceVertical={false}
    >
      {!isCommandTextInputAvailable && isKeyCaptureChordAvailable && !readOnly && (
        <KeyCaptureView
          active
          onKey={() => undefined}
          onChord={onChord}
          style={styles.keyCapture}
        />
      )}
      {/* Hardware-keyboard shortcuts for a SELECTED (not being-edited) element:
          Backspace deletes it, Enter edits it if it's a text box. Active only
          during a bare selection, so it takes first responder from the notes
          field (enforcing the notes ⊥ selection exclusivity) and never competes
          with the text-editing input. */}
      {isKeyCaptureAvailable && !readOnly && !!selectedId && !editingId && (
        <KeyCaptureView
          active
          onKey={(key) => {
            if (key === "\u{232B}") deleteSelected();
          }}
          onSubmit={() => {
            if (selectedId && slide?.elements[selectedId]?.type === "text") {
              beginEdit(selectedId);
            }
          }}
          style={styles.keyCapture}
        />
      )}
      {!readOnly && !gridOpen && (
        <View style={[styles.toolbar, { borderColor: colors.border }]}>
          <Pressable
            accessibilityLabel={SLIDES_COPY.undo}
            disabled={!canUndo(history)}
            onPress={undo}
            testID="slides-toolbar-undo"
            style={[
              styles.toolBtn,
              { borderColor: colors.border, opacity: canUndo(history) ? 1 : 0.4 },
            ]}
          >
            <SymbolView name="arrow.uturn.backward" size={16} tintColor={colors.fg} />
            <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>{SLIDES_COPY.undo}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel={SLIDES_COPY.redo}
            disabled={!canRedo(history)}
            onPress={redo}
            testID="slides-toolbar-redo"
            style={[
              styles.toolBtn,
              { borderColor: colors.border, opacity: canRedo(history) ? 1 : 0.4 },
            ]}
          >
            <SymbolView name="arrow.uturn.forward" size={16} tintColor={colors.fg} />
            <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>{SLIDES_COPY.redo}</Text>
          </Pressable>
          {INSERT_KINDS.map((kind) => (
            <Pressable
              key={kind}
              accessibilityLabel={`Insert ${SLIDES_COPY.insert[kind]}`}
              onPress={() => insertElement(kind)}
              testID={`slides-toolbar-insert-${kind}`}
              style={[styles.toolBtn, { borderColor: colors.border }]}
            >
              <SymbolView
                name={INSERT_SYMBOLS[kind]}
                size={16}
                tintColor={colors.fg}
              />
              <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>
                {SLIDES_COPY.insert[kind]}
              </Text>
            </Pressable>
          ))}
          {onAddMedia && (
            <Pressable
              accessibilityLabel={SLIDES_COPY.media}
              // Stays a normal, active button while its picker/modal is open —
              // re-entry is already prevented inside addMedia (the addingMedia
              // guard), so the button doesn't need to look disabled or swap its
              // label to "Adding media…" for the whole time the sheet is up.
              onPress={() => void addMedia(onAddMedia)}
              testID="slides-toolbar-add-media"
              style={[styles.toolBtn, { borderColor: colors.border }]}
            >
              <SymbolView name="camera" size={16} tintColor={colors.fg} />
              <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>
                {SLIDES_COPY.media}
              </Text>
            </Pressable>
          )}
          {onAddSketch && (
            <Pressable
              accessibilityLabel={`Insert ${SLIDES_COPY.sketch}`}
              disabled={addingMedia}
              onPress={() => void addMedia(onAddSketch)}
              testID="slides-toolbar-insert-sketch"
              style={[
                styles.toolBtn,
                { borderColor: colors.border, opacity: addingMedia ? 0.4 : 1 },
              ]}
            >
              <ScribbleIcon size={16} color={colors.fg} />
              <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>
                {SLIDES_COPY.sketch}
              </Text>
            </Pressable>
          )}
          <View style={styles.toolbarSpacer} />
          {onExport && (
            <>
              <Pressable
                accessibilityLabel="Export PowerPoint"
                onPress={exporting ? undefined : () => runExport("pptx")}
                testID="slides-toolbar-export-pptx"
                style={[
                  styles.toolBtn,
                  { borderColor: colors.border, opacity: exporting ? 0.5 : 1 },
                ]}
              >
                <SymbolView name="doc.badge.arrow.up" size={16} tintColor={colors.fg} />
                <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>
                  {exporting === "pptx" ? "Exporting…" : "PowerPoint"}
                </Text>
              </Pressable>
              <Pressable
                accessibilityLabel="Export PDF"
                onPress={exporting ? undefined : () => runExport("pdf")}
                testID="slides-toolbar-export-pdf"
                style={[
                  styles.toolBtn,
                  { borderColor: colors.border, opacity: exporting ? 0.5 : 1 },
                ]}
              >
                <SymbolView name="doc.richtext" size={16} tintColor={colors.fg} />
                <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>
                  {exporting === "pdf" ? "Exporting…" : "PDF"}
                </Text>
              </Pressable>
            </>
          )}
          {selectedElement?.type === "text" && (
            <View
              accessibilityLabel="Text size"
              style={[styles.textSizeControl, { borderColor: colors.border }]}
            >
              {TEXT_SIZE_OPTIONS.map(({ label, fontSize }, optionIndex) => {
                const selected = selectedElement.style.fontSize === fontSize;
                return (
                  <Pressable
                    key={fontSize}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${label} text`}
                    onPress={() =>
                      mutate([
                        {
                          op: "patchElement",
                          slideId: slide.id,
                          id: selectedElement.id,
                          style: { fontSize },
                        },
                      ])
                    }
                    style={({ pressed }) => [
                      styles.textSizeButton,
                      optionIndex > 0 && { borderLeftWidth: StyleSheet.hairlineWidth },
                      {
                        borderLeftColor: colors.border,
                        backgroundColor: selected ? colors.cyanSubtle : "transparent",
                        opacity: pressed ? 0.65 : 1,
                      },
                    ]}
                  >
                    <Text style={[styles.textSizeLabel, { fontFamily: fonts.medium, color: colors.fg }]}>
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          )}
          {selectedId && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={SLIDES_COPY.deleteElement}
              onPress={deleteSelected}
              testID="slides-toolbar-delete-element"
              style={[styles.toolBtn, { borderColor: colors.border }]}
            >
              <SymbolView name="trash" size={16} tintColor={colors.fg} />
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.editorWorkspace}>
        {!gridOpen && (
          <RNGHScrollView
            style={[styles.thumbnailRail, { borderColor: colors.border }]}
            contentContainerStyle={styles.thumbnailRailContent}
            showsVerticalScrollIndicator={false}
          >
            {visibleDeck.slides.map((railSlide, railIndex) => (
            <Pressable
              key={railSlide.id}
              accessibilityRole="button"
              accessibilityLabel={`Open slide ${railIndex + 1}`}
              onPress={() => {
                const now = Date.now();
                const previous = lastThumbnailTap.current;
                lastThumbnailTap.current = { index: railIndex, at: now };
                if (previous?.index === railIndex && now - previous.at < 350) {
                  showSlideMenu(railIndex);
                } else {
                  setIndex(railIndex);
                  setGridOpen(false);
                }
              }}
              onLongPress={() => showSlideMenu(railIndex)}
              testID={`slides-thumbnail-${railSlide.id}`}
              style={[
                styles.railThumb,
                {
                  borderColor: railIndex === index ? colors.cyan : colors.border,
                },
              ]}
            >
              <StaticSlidePreview slide={railSlide} resolveAsset={resolveAsset} />
              <View style={[styles.railNumber, { backgroundColor: colors.bg }]}>
                <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.fg }}>
                  {railIndex + 1}
                </Text>
              </View>
            </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add slide"
              onPress={() =>
                addSlideAt(
                  visibleDeck.slides[visibleDeck.slides.length - 1]?.id,
                  visibleDeck.slides.length,
                )
              }
              testID="slides-add-slide"
              style={[styles.addSlideTile, { borderColor: colors.border }]}
            >
              <SymbolView name="plus" size={22} tintColor={colors.fgMuted} />
              <Text style={{ fontFamily: fonts.medium, fontSize: 12, color: colors.fgMuted }}>
                {SLIDES_COPY.addSlide}
              </Text>
            </Pressable>
          </RNGHScrollView>
        )}
        <View style={styles.editorMain}>
          {gridOpen ? (
            <SlideGrid
              deck={visibleDeck}
              selectedIndex={index}
              onSelect={(nextIndex) => {
                setIndex(nextIndex);
                setGridOpen(false);
              }}
              resolveAsset={resolveAsset}
            />
          ) : (
            <View style={styles.canvasWrap} onLayout={onLayout}>
              <View
                testID="slides-canvas"
                style={[
                  styles.canvas,
                  {
                    width: scale * CANVAS_W,
                    height: scale * CANVAS_H,
                    backgroundColor: slide.background,
                    borderColor: colors.border,
                  },
                ]}
              >
          <GestureDetector gesture={deselect}>
            <View style={styles.backdrop} />
          </GestureDetector>

          {scale > 0 &&
            slide.elementIds.map((eid) => {
              const el = slide.elements[eid];
              if (!el) return null;
              return (
                <ElementView
                  key={eid}
                  el={el}
                  scale={scale}
                  selected={selectedId === eid}
                  editing={editingId === eid}
                  readOnly={readOnly}
                  scrollRef={scrollRef as React.RefObject<unknown>}
                  onSelect={setSelectedId}
                  onBeginEdit={beginEdit}
                  onCommit={commitFrame}
                  resolveAsset={resolveAsset}
                />
              );
            })}

          {/* In-flight image placeholders: client-only spinners at the frame the
              finished image will occupy, so the scholar sees WHICH picture is
              coming and WHERE. Draggable — the finished image lands wherever the
              scholar moved the spinner (resolveImagePlaceholder reads its frame). */}
          {scale > 0 &&
            placeholders
              .filter((p) => p.slideId === slide.id)
              .map((p) => (
                <DraggablePlaceholder
                  key={p.id}
                  placeholder={p}
                  scale={scale}
                  readOnly={readOnly}
                  scrollRef={scrollRef as React.RefObject<unknown>}
                  onMove={moveImagePlaceholder}
                />
              ))}

          {/* Text overlay. Axis-aligned by construction — the model pins
              rotation to 0 for text — so the native editor can sit directly
              over the rendered element rather than putting a caret in rotated
              or scaled coordinates. */}
          {editing && editing.type === "text" && scale > 0 && !readOnly && (
            <CommandTextInput
              accessibilityLabel="Slide text"
              autoFocus
              captureEditorCommands
              contentInsetHorizontal={0}
              contentInsetVertical={0}
              fontName={
                editing.style.bold
                  ? "HankenGrotesk-Bold"
                  : "HankenGrotesk-Regular"
              }
              fontSize={editing.style.fontSize * scale}
              maxLength={MAX_TEXT_LENGTH}
              onCommandReturn={() => onChord("Cmd+Enter")}
              value={draft}
              onChangeText={onDraftChange}
              onEscape={() => onChord("Escape")}
              onBlur={() => void commitTextEdit()}
              showSoftInputOnFocus={!hardwareKeyboard}
              textColor={editing.style.color}
              style={{
                position: "absolute",
                left: editing.frame.x * scale,
                top: editing.frame.y * scale,
                width: editing.frame.w * scale,
                height: editing.frame.h * scale,
                backgroundColor: colors.cyanSubtle,
              }}
            />
          )}
          {readOnly && onCanvasPress && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Edit slide ${index + 1}`}
              onPress={onCanvasPress}
              style={styles.canvasOpenTarget}
            />
          )}
              </View>
            </View>
          )}
        </View>
      </View>

      {!gridOpen && (!readOnly || Boolean(slide.speakerNotes)) && (
        <View style={[styles.notesSurface, { borderColor: colors.border }]}>
          {/* The notes field is ALWAYS mounted at a stable height — it does not
              collapse to a disclosure and expand on tap. Collapsing on focus
              reflowed the editor (the 44pt disclosure jumped to a 96pt input)
              AND clipped the placeholder while the freshly-mounted native input
              settled its layout. Keeping it mounted means focusing just places
              a cursor: no layout shift, no placeholder clip. */}
          <Text style={[styles.notesLabel, { fontFamily: fonts.medium, color: colors.fg }]}>
            {SLIDES_COPY.speakerNotes}
          </Text>
          {/* No placeholder: the label above already says what this is, and the
              native input's own placeholder rendered oddly (a vertically-centred
              UILabel below the top-aligned cursor). */}
          <CommandTextInput
            accessibilityLabel={SLIDES_COPY.speakerNotes}
            editable={!readOnly}
            contentInsetHorizontal={12}
            contentInsetVertical={10}
            fontName="HankenGrotesk-Regular"
            fontSize={16}
            maxLength={MAX_TEXT_LENGTH}
            value={readOnly ? slide.speakerNotes ?? "" : notesDraft}
            onChangeText={(notes) => {
              setNotesDraft(notes);
              pendingNotes.current.set(slide.id, notes);
            }}
            onFocus={() => {
              notesFocused.current = true;
              notesSlideId.current = slide.id;
              notesSaved.current = slide.speakerNotes ?? "";
              // Editing notes and having a slide element selected are mutually
              // exclusive — otherwise a keypress is ambiguous (type into notes,
              // or delete the selected element?). Focusing notes drops the
              // selection; selecting an element blurs notes via the selection
              // KeyCaptureView taking first responder.
              setSelectedId(null);
              setEditingId(null);
            }}
            onBlur={commitSpeakerNotes}
            showSoftInputOnFocus={!hardwareKeyboard}
            textColor={colors.fg}
            style={[
              styles.notesInput,
              {
                borderColor: colors.border,
                backgroundColor: colors.bg,
              },
            ]}
          />
        </View>
      )}
    </RNGHScrollView>
  );
});

function CompactSlidesViewer({
  deck,
  onGo,
  onOpenEditor,
  resolveAsset,
}: {
  deck: Deck;
  onGo: (index: number) => void;
  onOpenEditor?: () => void;
  resolveAsset?: (assetId: string) => string | null;
}) {
  const colors = useColors();

  return (
    <View style={styles.compactViewer}>
      {/*
       * Deliberately NOT a ScrollView: every caller already renders this inside
       * a vertical scroller (DeliverablePanel's ScrollView, DeliverableCard's
       * inverted chat FlatList). Nesting a same-axis scroller there traps
       * gestures and is what made this panel jump; the list simply grows and
       * the panel scrolls it.
       */}
      <View style={styles.compactList}>
        {deck.slides.map((slide, i) => {
          const frame = (
            <View style={[styles.compactFrame, { borderColor: colors.border }]}>
              <StaticSlidePreview slide={slide} resolveAsset={resolveAsset} />
              {Boolean(slide.speakerNotes?.trim()) && (
                // Parity with the web panel's list: an indication that
                // notes exist, inset over the slide, never a second
                // target — the notes themselves live in the editor.
                <View pointerEvents="none" style={styles.notesHint}>
                  <Text
                    numberOfLines={1}
                    style={{ fontFamily: fonts.regular, fontSize: 11, color: colors.fgMuted }}
                  >
                    {slide.speakerNotes?.trim()}
                  </Text>
                </View>
              )}
            </View>
          );

          return (
            <View key={slide.id} style={styles.compactRow}>
              <Text style={[styles.compactNumber, { fontFamily: fonts.medium, color: colors.fgMuted }]}>
                {i + 1}
              </Text>
              {onOpenEditor ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Edit slide ${i + 1}`}
                  onPress={() => {
                    onGo(i);
                    onOpenEditor();
                  }}
                  style={styles.compactFrameWrap}
                >
                  {frame}
                </Pressable>
              ) : (
                <View style={styles.compactFrameWrap}>{frame}</View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

function SlideGrid({
  deck,
  selectedIndex,
  onSelect,
  resolveAsset,
}: {
  deck: Deck;
  selectedIndex: number;
  onSelect: (index: number) => void;
  resolveAsset?: (assetId: string) => string | null;
}) {
  const colors = useColors();
  return (
    <View style={styles.grid}>
      {deck.slides.map((gridSlide, gridIndex) => (
        <Pressable
          key={gridSlide.id}
          accessibilityRole="button"
          accessibilityLabel={`Open slide ${gridIndex + 1}`}
          onPress={() => onSelect(gridIndex)}
          style={[
            styles.gridCell,
            {
              borderColor: gridIndex === selectedIndex ? colors.cyan : colors.border,
            },
          ]}
        >
          <StaticSlidePreview slide={gridSlide} resolveAsset={resolveAsset} />
          <View style={[styles.gridNumber, { backgroundColor: colors.bg }]}>
            <Text style={{ fontFamily: fonts.medium, fontSize: 11, color: colors.fg }}>
              {gridIndex + 1}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function StaticSlidePreview({
  slide,
  resolveAsset,
}: {
  slide: Deck["slides"][number];
  resolveAsset?: (assetId: string) => string | null;
}) {
  const [width, setWidth] = useState(0);
  const scale = width / CANVAS_W;
  return (
    <View
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.staticSlide, { backgroundColor: slide.background }]}
    >
      {scale > 0 &&
        slide.elementIds.map((elementId) => {
          const element = slide.elements[elementId];
          if (!element) return null;
          const frameStyle = {
            position: "absolute" as const,
            left: element.frame.x * scale,
            top: element.frame.y * scale,
            width: element.frame.w * scale,
            height: element.frame.h * scale,
            transform: [{ rotate: `${element.frame.rotation}deg` }],
          };
          return (
            <View
              key={elementId}
              style={[
                frameStyle,
                clipsOverflow(element.type) && { overflow: "hidden" },
                element.type === "text" && {
                  justifyContent: verticalAlignToJustify(element.style.verticalAlign),
                },
              ]}
            >
              <SlideElementContentNative
                accessible={false}
                element={element}
                renderVideo={false}
                resolveAsset={resolveAsset}
                scale={scale}
              />
            </View>
          );
        })}
    </View>
  );
}

// ─── One element ─────────────────────────────────────────────────────────

function ElementView({
  el,
  scale,
  selected,
  editing,
  readOnly,
  scrollRef,
  onSelect,
  onBeginEdit,
  onCommit,
  resolveAsset,
}: {
  el: SlideElement;
  scale: number;
  selected: boolean;
  editing: boolean;
  readOnly: boolean;
  scrollRef: React.RefObject<unknown>;
  onSelect: (id: string) => void;
  onBeginEdit: (id: string) => void;
  onCommit: (id: string, frame: Frame) => void;
  resolveAsset?: (assetId: string) => string | null;
}) {
  const colors = useColors();
  const [activeHandle, setActiveHandle] = useState<"resize" | "rotate" | null>(null);

  // LIVE geometry, absolute (never deltas) — see the header.
  const sx = useSharedValue(el.frame.x);
  const sy = useSharedValue(el.frame.y);
  const sw = useSharedValue(el.frame.w);
  const sh = useSharedValue(el.frame.h);
  const srot = useSharedValue(el.frame.rotation);

  // Anchors captured at touch-down, so translation is never accumulated.
  const ax = useSharedValue(0);
  const ay = useSharedValue(0);
  const aw = useSharedValue(0);
  const ah = useSharedValue(0);
  const arot = useSharedValue(0);

  // Re-sync when the frame changes from OUTSIDE a gesture (an AI edit, undo,
  // the server echoing our own commit back). A no-op on the common path.
  useEffect(() => {
    sx.set(el.frame.x);
    sy.set(el.frame.y);
    sw.set(el.frame.w);
    sh.set(el.frame.h);
    srot.set(el.frame.rotation);
  }, [el.frame.x, el.frame.y, el.frame.w, el.frame.h, el.frame.rotation, sx, sy, sw, sh, srot]);

  const commit = useCallback(
    (x: number, y: number, w: number, h: number, rot: number) => {
      onCommit(el.id, {
        x: Math.round(x),
        y: Math.round(y),
        w: Math.round(w),
        h: Math.round(h),
        rotation: Math.round(rot),
      });

    },
    [el.id, onCommit],
  );

  const select = useCallback(() => onSelect(el.id), [el.id, onSelect]);
  const beginEdit = useCallback(() => onBeginEdit(el.id), [el.id, onBeginEdit]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!readOnly)
        .blocksExternalGesture(scrollRef as BlockRef)
        // Track from the first millimetre; the default activation distance also
        // delays the gesture behind the double-tap recogniser. Indirect-pointer
        // clicks carry a few points of trackpad jitter, though, so zero lets Pan
        // win the race before a double-click can complete.
        .minDistance(4)
        .onBegin(() => {
          ax.set(sx.get());
          ay.set(sy.get());
          runOnJS(select)();
        })
        .onUpdate((e) => {
          sx.set(ax.get() + e.translationX / scale);
          sy.set(ay.get() + e.translationY / scale);
        })
        .onEnd(() => {
          // No reset — sx/sy already hold the final geometry.
          runOnJS(commit)(sx.get(), sy.get(), sw.get(), sh.get(), srot.get());
        }),
    [scale, readOnly, commit, select, scrollRef, sx, sy, sw, sh, srot, ax, ay],
  );

  const dbl = useMemo(
    () =>
      Gesture.Tap()
        .enabled(!readOnly && el.type === "text")
        .numberOfTaps(2)
        .maxDistance(12)
        .onEnd(() => runOnJS(beginEdit)()),
    [beginEdit, readOnly, el.type],
  );

  // RACE, not Exclusive: Exclusive makes every drag wait for the double-tap
  // recogniser to fail, which reads as start-up lag.
  const composed = useMemo(() => Gesture.Race(dbl, pan), [dbl, pan]);

  const resize = useMemo(
    () =>
      Gesture.Pan()
        .blocksExternalGesture(scrollRef as BlockRef)
        .minDistance(0)
        .onBegin(() => {
          aw.set(sw.get());
          ah.set(sh.get());
          runOnJS(setActiveHandle)("resize");
        })
        .onUpdate((e) => {
          // Project into the element's OWN axes so a rotated box grows along
          // its edges, not the screen's.
          const local = rotatePoint(
            e.translationX / scale,
            e.translationY / scale,
            srot.get(),
          );
          sw.set(Math.max(MIN_ELEMENT_SIZE, aw.get() + local.x));
          sh.set(Math.max(MIN_ELEMENT_SIZE, ah.get() + local.y));
        })
        .onEnd(() => {
          runOnJS(commit)(sx.get(), sy.get(), sw.get(), sh.get(), srot.get());
        })
        .onFinalize(() => runOnJS(setActiveHandle)(null)),
    [scale, commit, scrollRef, sx, sy, sw, sh, srot, aw, ah],
  );

  const rotate = useMemo(
    () =>
      Gesture.Pan()
        .blocksExternalGesture(scrollRef as BlockRef)
        .minDistance(0)
        .onBegin(() => {
          arot.set(srot.get());
          runOnJS(setActiveHandle)("rotate");
        })
        .onUpdate((e) => {
          srot.set(arot.get() + e.translationX / 3);
        })
        .onEnd(() => {
          runOnJS(commit)(sx.get(), sy.get(), sw.get(), sh.get(), srot.get());
        })
        .onFinalize(() => runOnJS(setActiveHandle)(null)),
    [commit, scrollRef, sx, sy, sw, sh, srot, arot],
  );

  const boxStyle = useAnimatedStyle(() => ({
    width: sw.get() * scale,
    height: sh.get() * scale,
    transform: [
      { translateX: sx.get() * scale },
      { translateY: sy.get() * scale },
      { rotate: `${srot.get()}deg` },
    ],
  }));

  const isText = el.type === "text";
  const isRotatable = el.type !== "text" && el.type !== "video";

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        testID={`slides-element-${el.id}`}
        style={[
          styles.el,
          boxStyle,
        ]}
      >
        <View
          style={[
            styles.elementContent,
            // Honour verticalAlign. Native ignored it, so an AI- or web-authored
            // deck visibly re-laid-out on the child's iPad (found by review).
            clipsOverflow(el.type) && { overflow: "hidden" },
            isText && {
              justifyContent: verticalAlignToJustify(el.style.verticalAlign),
            },
          ]}
        >
          <SlideElementContentNative
            element={el}
            hideText={editing}
            resolveAsset={resolveAsset}
            scale={scale}
            testID={`slides-element-${el.id}`}
          />
        </View>

        {selected && !readOnly && (
          <>
            <View
              pointerEvents="none"
              style={[styles.selRing, { borderColor: colors.cyan }]}
            />
            <GestureDetector gesture={resize}>
              <View style={[styles.hit, styles.hitBR]}>
                <View
                  style={[
                    styles.knob,
                    activeHandle === "resize" && styles.activeKnob,
                    { backgroundColor: colors.cyan, borderColor: colors.white },
                  ]}
                />
              </View>
            </GestureDetector>
            {/* PowerPoint media cannot rotate, so videos stay axis-aligned too. */}
            {isRotatable && (
              <GestureDetector gesture={rotate}>
                <View style={[styles.hit, styles.hitTR]}>
                  <View
                    style={[
                      styles.knob,
                      activeHandle === "rotate" && styles.activeKnob,
                      { backgroundColor: colors.orange, borderColor: colors.white },
                    ]}
                  />
                </View>
              </GestureDetector>
            )}
          </>
        )}
      </Animated.View>
    </GestureDetector>
  );
}

/**
 * The in-flight image spinner, draggable. Position lives on the UI thread
 * (shared values) during the drag for smoothness; on release it commits the
 * canvas-space x/y back to the placeholder's frame in JS state, so the finished
 * image lands where the scholar left the spinner (resolveImagePlaceholder reads
 * that frame). Mirrors ElementView's pan so the feel is identical.
 */
function DraggablePlaceholder({
  placeholder,
  scale,
  readOnly,
  scrollRef,
  onMove,
}: {
  placeholder: ImagePlaceholder;
  scale: number;
  readOnly: boolean;
  scrollRef: React.RefObject<unknown>;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const colors = useColors();
  const { id, frame, prompt, source } = placeholder;
  const sx = useSharedValue(frame.x);
  const sy = useSharedValue(frame.y);
  const ax = useSharedValue(0);
  const ay = useSharedValue(0);

  // Re-seed if the frame changes from outside a drag (e.g. a cascade reflow).
  useEffect(() => {
    sx.set(frame.x);
    sy.set(frame.y);
  }, [frame.x, frame.y, sx, sy]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!readOnly)
        .blocksExternalGesture(scrollRef as BlockRef)
        .minDistance(4)
        .onBegin(() => {
          ax.set(sx.get());
          ay.set(sy.get());
        })
        .onUpdate((e) => {
          sx.set(ax.get() + e.translationX / scale);
          sy.set(ay.get() + e.translationY / scale);
        })
        .onEnd(() => {
          runOnJS(onMove)(id, sx.get(), sy.get());
        }),
    [scale, readOnly, scrollRef, id, onMove, sx, sy, ax, ay],
  );

  const animatedStyle = useAnimatedStyle(() => ({
    left: sx.get() * scale,
    top: sy.get() * scale,
    width: frame.w * scale,
    height: frame.h * scale,
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        accessible
        accessibilityLabel={`${
          source === "find" ? FIND_IMAGE_COPY.inserting : MAKE_PICTURE_COPY.busy
        } ${prompt}`}
        testID={`slides-image-placeholder-${id}`}
        style={[
          styles.imagePlaceholder,
          animatedStyle,
          { borderColor: colors.border, backgroundColor: colors.bgSubtle },
        ]}
      >
        <ActivityIndicator color={colors.violet} />
        <Text
          numberOfLines={3}
          style={{
            color: colors.fgMuted,
            fontFamily: fonts.regular,
            fontSize: 13,
            lineHeight: 18,
            textAlign: "center",
          }}
        >
          {prompt}
        </Text>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  body: { flexGrow: 1, padding: 16 },
  emptyWrap: { padding: 24, alignItems: "center" },
  emptyText: { fontSize: 14 },
  canvasWrap: {
    flex: 1,
    width: "100%",
    minHeight: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  addSlideTile: {
    width: 120,
    aspectRatio: CANVAS_W / CANVAS_H,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  canvas: { borderRadius: 10, borderWidth: 1, overflow: "hidden" },
  imagePlaceholder: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    padding: 12,
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 8,
  },
  canvasOpenTarget: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  compactViewer: { paddingHorizontal: 12, paddingBottom: 12 },
  compactList: { gap: 16 },
  compactRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  compactNumber: {
    width: 20,
    paddingTop: 4,
    fontSize: 12,
    textAlign: "right",
  },
  compactFrameWrap: { flex: 1, minWidth: 0 },
  compactFrame: {
    width: "100%",
    aspectRatio: CANVAS_W / CANVAS_H,
    borderWidth: 1,
    borderRadius: 10,
    overflow: "hidden",
  },
  notesHint: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 8,
    paddingVertical: 4,
    backgroundColor: "rgba(255,255,255,0.92)",
  },
  staticSlide: { width: "100%", aspectRatio: CANVAS_W / CANVAS_H, overflow: "hidden" },
  grid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    paddingVertical: 8,
  },
  gridCell: {
    width: "31%",
    aspectRatio: CANVAS_W / CANVAS_H,
    borderWidth: 2,
    borderRadius: 8,
    overflow: "hidden",
  },
  gridNumber: {
    position: "absolute",
    left: 4,
    bottom: 4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  editorWorkspace: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    alignItems: "stretch",
    gap: 14,
  },
  thumbnailRail: {
    width: 130,
    flexGrow: 0,
    flexShrink: 0,
    marginTop: -46,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  thumbnailRailContent: { gap: 10, paddingRight: 4, paddingBottom: 8 },
  railThumb: {
    width: 120,
    aspectRatio: CANVAS_W / CANVAS_H,
    borderWidth: 2,
    borderRadius: 8,
    overflow: "hidden",
  },
  railNumber: {
    position: "absolute",
    left: 4,
    bottom: 4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  editorMain: { flex: 1, minWidth: 0, minHeight: 0 },
  backdrop: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  // Laid out at the ORIGIN; position comes from the animated transform.
  // Selection chrome lives here and may extend outside its element frame.
  el: {
    position: "absolute",
    left: 0,
    top: 0,
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  // Keep content clipping separate from selection chrome so corner handles
  // remain fully visible outside the element's frame.
  elementContent: {
    width: "100%",
    height: "100%",
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },
  selRing: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    borderWidth: 2,
    borderRadius: 4,
    borderStyle: "dashed",
  },
  hit: {
    position: "absolute",
    width: HANDLE_HIT,
    height: HANDLE_HIT,
    alignItems: "center",
    justifyContent: "center",
  },
  hitBR: { right: -HANDLE_HIT / 2, bottom: -HANDLE_HIT / 2 },
  hitTR: { right: -HANDLE_HIT / 2, top: -HANDLE_HIT / 2 },
  knob: {
    width: HANDLE_VISUAL,
    height: HANDLE_VISUAL,
    borderRadius: HANDLE_VISUAL / 2,
    borderWidth: 3,
  },
  activeKnob: {
    borderWidth: 4,
    transform: [{ scale: 1.35 }],
  },
  toolbar: {
    marginLeft: 144,
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
    paddingBottom: 12,
  },
  toolbarSpacer: { flex: 1 },
  toolBtn: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  textSizeControl: {
    minHeight: 34,
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  textSizeButton: {
    minWidth: 56,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  textSizeLabel: { fontSize: 12 },
  notesSurface: {
    marginTop: 14,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  notesLabel: { fontSize: 15 },
  notesInput: {
    minHeight: 96,
    borderWidth: 1,
    borderRadius: 8,
  },
  keyCapture: { position: "absolute", width: 1, height: 1, opacity: 0 },
});
