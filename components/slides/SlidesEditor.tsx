"use client";

/**
 * SlidesEditor — the web slide editor. A CONTROLLED component: it never holds
 * the deck as its own source of truth. Every edit is expressed as a
 * {@link SlideOp} batch, run through `applySlideOps(deck, ops, mintId)` from
 * shared/slidesScene, and the resulting deck is handed back via `onChange`. The
 * only local state is ephemeral UI selection (current slide, selected element,
 * which text box is being edited).
 *
 * Chrome is Chakra; the canvas itself (SlideCanvas) is plain DOM/SVG. Selection
 * is CYAN, matching the app convention.
 *
 * This component is the EDITING surface and nothing else — it is mounted
 * full-size (a cover dialog from the scholar's slide list, the curriculum
 * designer's deck dialog), never inside the narrow chat panel. Read-only
 * viewing is {@link ./SlideList}, which draws the same slides through the same
 * SlideCanvas.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  closestCenter,
  defaultDropAnimationSideEffects,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { Box, Button, Dialog, Flex, Heading, IconButton, Input, Menu, Portal, Text, Textarea } from "@chakra-ui/react";
import {
  DotsThree,
  Plus,
  Trash,
  TextT,
  Square,
  Circle,
  Minus,
  ImageSquare,
  Sparkle,
  MagnifyingGlass,
  DownloadSimple,
  ArrowCounterClockwise,
  ArrowClockwise,
  PencilSimple,
} from "@phosphor-icons/react";
import {
  applySlideOps,
  makeDeckIdFactory,
  createHistory,
  pushHistory,
  undo as undoStep,
  redo as redoStep,
  canUndo,
  canRedo,
  INSERT_KINDS,
  isBlankSlideText,
  NEW_ELEMENT_PRESETS,
  nextInsertFrame,
  resolvedImageFrame,
  SLIDES_COPY,
  SLIDE_TEXT_COLORS,
  SLIDE_BACKGROUND_COLORS,
  SLIDE_TEXT_SIZES,
  resolveSlideCursor,
  textCommitOps,
  textDraftTarget,
  type ApplyResult,
  type Deck,
  type Frame,
  type InsertKind,
  type SlideCursor,
  type SlideHistory,
  type SlideOp,
} from "@/shared/slidesScene";
import {
  copySlidesToClipboard,
  getSlideClipboardSnapshot,
  planSlidePaste,
  slidesOnClipboard,
  subscribeSlideClipboard,
} from "@/shared/slideClipboard";
import { SketchDialog } from "@/components/SketchDialog";
import { SlideStyleControl } from "./SlideStyleControl";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { SlideCanvas } from "./SlideCanvas";
import { pickImageFile } from "./imageFilePicker";
import { matchHistoryShortcut, slideHasContent, framesEqual } from "./geometry";
import {
  canMakePicture,
  nextCascadeSlot,
  MAKE_PICTURE_MAX_PROMPT,
  placeholderFrame,
  resolveMakePictureResult,
  type MakePictureResult,
} from "./slideImagePrompt";
import { MAKE_PICTURE_COPY } from "@/shared/slidesScene";
import {
  FindImageDialog,
  EMPTY_IMAGE_SEARCH_SNAPSHOT,
  type ImageSearchSnapshot,
} from "./FindImageDialog";
import {
  FIND_IMAGE_COPY,
  deriveFoundImageAlt,
  type WebImageSearchResponse,
  type WebImageSearchResult,
  type WebImagePickResult,
} from "./findImage";

const INERT = () => {};

/**
 * Width of the fixed contextual slot at the toolbar's end, held CONSTANT across
 * every selection state ([Slide background] / [Text style][Delete text] /
 * [Delete]) so the toolbar's wrap — and thus its height — never depends on the
 * selection. Sized to the widest variant, [Text style][Delete text].
 */
const CONTEXT_SLOT_WIDTH = "248px";

/** How long "Copied 2 slides…" / "There isn't room…" stays on screen. */
const CLIPBOARD_NOTICE_MS = 4000;

type ClipboardNotice = { text: string; tone: "info" | "error" };

/** What a filmstrip thumbnail's slide menu can do. Absent = no menu. */
type FilmstripClipboard = {
  /** Slides this user can paste right now; 0 hides the paste item. */
  pasteCount: number;
  /** Copy one slide by id, or every slide when `null`. */
  onCopy: (slideId: string | null) => void;
  onPasteAfter: (slideId: string) => void;
};

interface SlidesEditorProps {
  deck: Deck;
  /** Slide to open on — the one the caller's list was clicked at. */
  initialSlideIndex?: number;
  onChange?: (next: Deck) => void;
  /**
   * Persist an id-addressed op batch. When supplied the SERVER is authoritative
   * (it mints ids and bumps `revision`) and the editor does NOT apply locally —
   * the updated deck arrives back through the caller's subscription. Prefer
   * this over `onChange` anywhere a backend is involved; `onChange` is for
   * local hosts such as the dev harness.
   */
  onOps?: (ops: SlideOp[]) => void;
  /** Resolve an image element's assetId to a URL; null renders a placeholder. */
  resolveAsset?: (assetId: string) => string | null;
  /** Upload image bytes and resolve to a slide-safe storage id. */
  onUploadImage?: (file: File) => Promise<string | null>;
  /**
   * Generate an illustration from a short scholar-typed prompt, resolving to the
   * stored image's id (the same `assetId` shape {@link onUploadImage} returns) or a
   * kid-readable error. Absent = no "Make an image" button. This is an
   * illustration engine, never a web/photo search.
   */
  onGeneratePicture?: (
    prompt: string,
  ) => Promise<MakePictureResult>;
  /**
   * "Find an image" — web image search. Both callbacks together enable the
   * toolbar button; either absent hides it. `onSearchImages` runs the search
   * (Brave behind a Convex action); `onPickImage` re-hosts the tapped result
   * server-side and resolves to the same `assetId` shape a generated image
   * yields, so a found image lands through the exact same insert path.
   */
  onSearchImages?: (query: string) => Promise<WebImageSearchResponse>;
  onPickImage?: (
    query: string,
    image: WebImageSearchResult,
  ) => Promise<WebImagePickResult>;
  /**
   * The last "Find an image" search snapshot + a setter, owned by the host so it
   * survives this editor (and the picker) unmounting — reopening the picker
   * restores the previous query + grid + shape. Mirrors native's
   * `imageSearchSnapshot` on `SlidesDeliverable`.
   */
  imageSearchSnapshot?: ImageSearchSnapshot;
  onImageSearchSnapshot?: (snapshot: ImageSearchSnapshot) => void;
  /** Render the deck to a real file. Absent = no export affordance. */
  onExport?: (format: "pptx" | "pdf") => Promise<void>;
  /**
   * The signed-in user's id, which owns the in-app slide clipboard
   * (`shared/slideClipboard`). Present = each filmstrip thumbnail gets a slide
   * menu to copy that slide or the whole deck and paste copied slides after it,
   * so a scholar can bring earlier nights' slides into one deck. Absent or null
   * = no copy/paste UI at all.
   */
  clipboardOwnerId?: string | null;
}

const INSERT_ICONS: Record<InsertKind, React.ReactNode> = {
  text: <TextT weight="bold" />,
  rect: <Square weight="fill" />,
  ellipse: <Circle weight="fill" />,
  line: <Minus weight="bold" />,
};

export function SlidesEditor({
  deck,
  initialSlideIndex = 0,
  onChange,
  onOps,
  resolveAsset,
  onUploadImage,
  onGeneratePicture,
  onSearchImages,
  onPickImage,
  imageSearchSnapshot,
  onImageSearchSnapshot,
  onExport,
  clipboardOwnerId,
}: SlidesEditorProps) {
  const [slideIndex, setSlideIndex] = useState(initialSlideIndex);
  // The slide on screen, by id. The tutor can reorder slides mid-edit, and a
  // bare index would then show (and save the draft onto) a different slide.
  const [slideCursor, setSlideCursor] = useState<SlideCursor | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  // The slide the open text edit belongs to, so its commit lands there even if
  // the slides moved while the scholar was typing.
  const textEditSlideId = useRef<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const notesDraftRef = useRef({ slideId: null as string | null, notes: "", saved: "" });
  const pendingNotes = useRef(new Map<string, string>());
  const notesEditing = useRef(false);
  // Set when an insert was sent server-authoritatively; cleared by selecting
  // the element that lands (inserts append, so it is the last one).
  const [selectPendingInsert, setSelectPendingInsert] = useState(false);
  // Undo/redo history. CLIENT-SIDE and per-session by design: it lives only in
  // this component's state, is never persisted or shared with the tutor, and is
  // reset whenever the editor unmounts. That is fine — see `mutate`.
  const [history, setHistory] = useState<SlideHistory>(() => createHistory());
  // Keep a synchronous working copy for batches emitted before the controlled
  // `deck` prop catches up. Without it, two rapid inserts both mint `el1`
  // locally, so the second undo entry points at the wrong server-created id.
  const workingDeck = useRef(deck);
  // eslint-disable-next-line react-hooks/refs -- The synchronous working copy prevents duplicate IDs across rapid controlled/server-authoritative edits before props catch up.
  if (deck.revision >= workingDeck.current.revision) {
    // eslint-disable-next-line react-hooks/refs -- The synchronous working copy prevents duplicate IDs across rapid controlled/server-authoritative edits before props catch up.
    workingDeck.current = deck;
  }
  // The slide a confirm dialog is guarding the deletion of (non-empty slides
  // only; empty ones and elements delete straight through — trivially undoable).
  const [pendingDeleteSlideId, setPendingDeleteSlideId] = useState<string | null>(null);

  // A slide just inserted (Add slide, Paste, Duplicate) that should open once
  // it arrives. The id is known up front, because `mutate` mints ids with the
  // server's own factory, but on the server-authoritative path the deck prop
  // has no such slide yet. Setting the index right away would pin the cursor
  // to whichever slide sits there now and then follow THAT slide by id, so the
  // editor stays where it is until the new slide is in the deck.
  const [openOnArrival, setOpenOnArrival] = useState<string | null>(null);
  const arrivedAt = openOnArrival ? deck.slides.findIndex((s) => s.id === openOnArrival) : -1;

  // Deck is controlled: follow the slide on screen through a remote reorder,
  // and clamp a stale index into range.
  const currentIndex =
    arrivedAt >= 0 ? arrivedAt : resolveSlideCursor(deck.slides, slideIndex, slideCursor);
  const slide = deck.slides[currentIndex];
  const slideId = slide?.id;

  useEffect(() => {
    if (!slideId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-pins the cursor after the deck or the scholar moved it.
    setSlideCursor((c) =>
      c?.slideId === slideId && c.index === currentIndex ? c : { slideId, index: currentIndex },
    );
    setSlideIndex(currentIndex);
    if (arrivedAt >= 0) setOpenOnArrival(null);
  }, [slideId, currentIndex, arrivedAt]);

  const mutate = useCallback(
    (ops: SlideOp[], record = true): ApplyResult | null => {
      // Apply locally with the SAME factory the server uses (makeDeckIdFactory),
      // so we learn this batch's minted ids without the round-trip. On the
      // server-authoritative (onOps) path the resulting deck is DISCARDED — the
      // real one returns via the caller's subscription — but the createdIds let
      // us record an invertible history entry (and the local path still needs
      // the deck itself).
      const before = workingDeck.current;
      const result = applySlideOps(before, ops, makeDeckIdFactory(before));
      if (record && result.ok) {
        // Store OPS, not a snapshot: an undo re-emits the INVERSE ops through
        // this same path, because the server owns the deck. Predicting
        setHistory((h) => pushHistory(h, before, ops, result.createdIds));
      }
      if (result.ok) workingDeck.current = result.deck;
      // Server-authoritative path: emit and wait for the deck to come back.
      if (onOps) {
        onOps(ops);
        return null;
      }
      if (!onChange) return null;
      if (result.ok) {
        onChange(result.deck);
        return result;
      }
      // A rejected batch is a programmer error here (the UI only emits valid
      // ops); surface it in dev without corrupting the deck.
      if (process.env.NODE_ENV !== "production") {
        console.warn("SlidesEditor: applySlideOps rejected:", result.error, ops);
      }
      return null;
    },
    [onChange, onOps],
  );

  // The ref retains the slide id that owns a draft. A slide switch may render
  // before the textarea blur runs, so committing against `slide.id` would put
  // the previous slide's notes on the newly selected slide.
  const commitSpeakerNotes = useCallback(() => {
    const draft = notesDraftRef.current;
    if (!draft.slideId || draft.notes === draft.saved) return;
    pendingNotes.current.set(draft.slideId, draft.notes);
    mutate([{ op: "setSpeakerNotes", slideId: draft.slideId, notes: draft.notes }]);
  }, [mutate]);

  // Undo/redo hand back the ops to APPLY (never a deck); we route them through
  // `mutate` with record=false — the entry has already moved between the past
  // and future stacks, so re-recording it would double-count.
  const handleUndo = useCallback(() => {
    const step = undoStep(history);
    if (!step) return;
    setHistory(step.history);
    mutate(step.ops, false);
    setSelectedId(null);
    setEditingTextId(null);
  }, [history, mutate]);

  const handleRedo = useCallback(() => {
    const step = redoStep(history);
    if (!step) return;
    setHistory(step.history);
    mutate(step.ops, false);
    setSelectedId(null);
    setEditingTextId(null);
  }, [history, mutate]);

  useEffect(() => {
    if (!selectPendingInsert) return;
    const ids = deck.slides[currentIndex]?.elementIds;
    if (!ids || ids.length === 0) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- selects an insertion only after the newly created deck element materializes.
    setSelectedId(ids[ids.length - 1]);
    setSelectPendingInsert(false);
  }, [deck, currentIndex, selectPendingInsert]);

  const selectSlide = useCallback((i: number) => {
    commitSpeakerNotes();
    setOpenOnArrival(null);
    setSlideIndex(i);
    setSelectedId(null);
    setEditingTextId(null);
  }, [commitSpeakerNotes]);

  // Drag-to-reorder in the filmstrip. One `moveSlide` op, so a single undo puts
  // the slide back; the cursor follows the slide by id (see resolveSlideCursor).
  const moveSlide = useCallback(
    (slideId: string, afterSlideId: string | null) => {
      commitSpeakerNotes();
      mutate([{ op: "moveSlide", slideId, afterSlideId }]);
    },
    [commitSpeakerNotes, mutate],
  );

  const openInsertedSlide = useCallback((id: string | undefined) => {
    if (!id) return;
    setOpenOnArrival(id);
    setSelectedId(null);
    setEditingTextId(null);
  }, []);

  const addSlide = useCallback(() => {
    commitSpeakerNotes();
    const before = workingDeck.current;
    mutate([{ op: "addSlide", afterSlideId: slide?.id }]);
    if (workingDeck.current === before) return;
    // The new slide sits directly after the current one in the working copy.
    openInsertedSlide(workingDeck.current.slides[currentIndex + 1]?.id);
  }, [commitSpeakerNotes, mutate, slide?.id, currentIndex, openInsertedSlide]);

  const performDeleteSlide = useCallback(
    (id: string) => {
      if (deck.slides.length <= 1) return;
      commitSpeakerNotes();
      mutate([{ op: "removeSlide", slideId: id }]);
      setSlideIndex((i) => Math.max(0, Math.min(i, deck.slides.length - 2)));
      setSelectedId(null);
      setEditingTextId(null);
    },
    [commitSpeakerNotes, mutate, deck.slides.length],
  );

  // Deleting a slide that still has content is a big, disorienting loss even
  // with undo available, so it gets a confirm. A blank slide loses nothing and
  // deletes straight through.
  const requestDeleteSlide = useCallback(
    (id: string) => {
      if (deck.slides.length <= 1) return;
      const target = deck.slides.find((s) => s.id === id);
      if (target && slideHasContent(target)) {
        setPendingDeleteSlideId(id);
        return;
      }
      performDeleteSlide(id);
    },
    [deck.slides, performDeleteSlide],
  );

  const confirmDeleteSlide = useCallback(() => {
    if (pendingDeleteSlideId) performDeleteSlide(pendingDeleteSlideId);
    setPendingDeleteSlideId(null);
  }, [pendingDeleteSlideId, performDeleteSlide]);

  // Slide copy/paste. The clipboard is module-level so it outlives this editor:
  // a scholar copies in one night's deck and pastes in another session's.
  const clipboardSnapshot = useSyncExternalStore(
    subscribeSlideClipboard,
    getSlideClipboardSnapshot,
    getSlideClipboardSnapshot,
  );
  const pasteCount = slidesOnClipboard(clipboardSnapshot, clipboardOwnerId).length;
  const [clipboardNotice, setClipboardNotice] = useState<ClipboardNotice | null>(null);
  // Each notice is a fresh object, so copying again restarts the timer; the
  // cleanup also clears it if the editor closes mid-notice.
  useEffect(() => {
    if (!clipboardNotice) return;
    const timer = window.setTimeout(() => setClipboardNotice(null), CLIPBOARD_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [clipboardNotice]);

  // Copy from the synchronous working copy, not the `deck` prop: an edit made
  // a moment ago (including the notes committed just below) may not have come
  // back from the server yet, and the copy should hold what the scholar sees.
  const copySlides = useCallback(
    (slideId: string | null) => {
      if (!clipboardOwnerId) return;
      commitSpeakerNotes();
      const source = workingDeck.current.slides;
      const slides = slideId === null ? source : source.filter((s) => s.id === slideId);
      const count = copySlidesToClipboard(clipboardOwnerId, slides);
      if (count > 0) {
        setClipboardNotice({ text: SLIDES_COPY.copiedSlides(count), tone: "info" });
      }
    },
    [clipboardOwnerId, commitSpeakerNotes],
  );

  const pasteSlidesAfter = useCallback(
    (afterSlideId: string) => {
      if (!clipboardOwnerId) return;
      commitSpeakerNotes();
      const target = workingDeck.current;
      const anchorIndex = target.slides.findIndex((s) => s.id === afterSlideId);
      if (anchorIndex < 0) return;
      // Read the clipboard at click time rather than from the render that drew
      // the menu, so a copy made since then is what pastes.
      const plan = planSlidePaste(
        target,
        slidesOnClipboard(getSlideClipboardSnapshot(), clipboardOwnerId),
        afterSlideId,
      );
      if (!plan.ok) {
        if (plan.reason === "noRoom") {
          setClipboardNotice({ text: SLIDES_COPY.pasteNoRoom, tone: "error" });
        }
        return;
      }
      // ONE batch through `mutate`, so a single undo removes the whole paste.
      mutate(plan.ops);
      // `mutate` advances the working copy only when the batch applied; if it
      // was refused, stay on the current slide rather than jump to a stranger.
      if (workingDeck.current === target) return;
      // The pasted slides start right after the anchor in the working copy.
      openInsertedSlide(workingDeck.current.slides[anchorIndex + 1]?.id);
    },
    [clipboardOwnerId, commitSpeakerNotes, mutate, openInsertedSlide],
  );

  // A copy of one slide, directly after it, through the same plan as a paste
  // (new slide and element ids, one undo step). Unlike the clipboard it never
  // leaves this deck, so every deck offers it.
  const duplicateSlide = useCallback(
    (slideId: string) => {
      commitSpeakerNotes();
      const target = workingDeck.current;
      const slideIndex = target.slides.findIndex((s) => s.id === slideId);
      if (slideIndex < 0) return;
      const plan = planSlidePaste(target, [target.slides[slideIndex]], slideId);
      if (!plan.ok) {
        if (plan.reason === "noRoom") {
          setClipboardNotice({ text: SLIDES_COPY.pasteNoRoom, tone: "error" });
        }
        return;
      }
      mutate(plan.ops);
      if (workingDeck.current === target) return;
      openInsertedSlide(workingDeck.current.slides[slideIndex + 1]?.id);
    },
    [commitSpeakerNotes, mutate, openInsertedSlide],
  );

  const insertElement = useCallback(
    (kind: InsertKind) => {
      if (!slide) return;
      const preset = NEW_ELEMENT_PRESETS[kind]();
      // Occupancy must come from the deck as it stands RIGHT NOW. `mutate`
      // updates `workingDeck` synchronously but the controlled `deck` prop
      // only catches up a render later, so two quick clicks both measured the
      // pre-first-insert slide and picked the same free slot — re-creating, in
      // the fast path, the exact stacking this cascade exists to prevent.
      const current =
        workingDeck.current.slides.find((s) => s.id === slide.id) ?? slide;
      const element = { ...preset, frame: nextInsertFrame(current, preset.frame) };
      const res = mutate([{ op: "addElement", slideId: current.id, element }]);
      if (res && res.ok && res.createdIds.length > 0) {
        setSelectedId(res.createdIds[0]);
      } else if (onOps) {
        // Server-authoritative: the id is not known yet. An inserted element is
        // appended, so select whatever lands last once the deck comes back.
        setSelectPendingInsert(true);
      }
    },
    [mutate, slide, onOps],
  );

  const [addingImage, setAddingImage] = useState<null | "photo" | "sketch">(null);
  const [sketchOpen, setSketchOpen] = useState(false);
  const [exporting, setExporting] = useState<null | "pptx" | "pdf">(null);
  const [imageError, setImageError] = useState<string | null>(null);

  /**
   * A deck a kid cannot hand to anyone else is a lock-in, which is the whole
   * reason this feature exists — so the export path needs a way in, not just a
   * backend action.
   */
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
   * Upload FIRST, then insert. An image element with no assetId is rejected by
   * the scene validator, and a placeholder the kid could move before the upload
   * finished would misrepresent what is actually saved.
   */
  const addImage = useCallback(async (
    getFile: () => Promise<File | null>,
    alt: string,
    source: "photo" | "sketch",
  ) => {
    if (!onUploadImage || !slide || addingImage) return;
    setAddingImage(source);
    setImageError(null);
    try {
      const file = await getFile();
      if (!file) return;
      const assetId = await onUploadImage(file);
      if (!assetId) return;
      const preset = NEW_ELEMENT_PRESETS.image(assetId);
      mutate([
        {
          op: "addElement",
          slideId: slide.id,
          element: { ...preset, alt },
        },
      ]);
    } catch (e) {
      setImageError(e instanceof Error ? e.message : "That image didn't upload.");
    } finally {
      setAddingImage(null);
    }
  }, [onUploadImage, slide, addingImage, mutate]);

  const addPhoto = useCallback(
    () => addImage(pickImageFile, "Photo", "photo"),
    [addImage],
  );

  const addSketch = useCallback(
    (file: File, preview: string) => {
      URL.revokeObjectURL(preview);
      void addImage(async () => file, "Sketch", "sketch");
    },
    [addImage],
  );

  // "Make an image": a scholar types a short description and the backend
  // generates an illustration. Submitting is INSTANT and OPTIMISTIC — a
  // client-side placeholder (spinner + the prompt text) lands on the canvas at
  // the frame the finished image will occupy, the prompt bar closes, and the
  // kid keeps working; when the bytes exist the real image element is inserted
  // through the EXACT same path as an uploaded photo. The placeholder is NEVER
  // persisted (that would pollute undo history and could strand a ghost element
  // if the tab closed mid-generation), so it lives only in this local state.
  //
  // The prompt is collected inline (below the toolbar), mirroring the inline
  // title/notes idiom, so we never nest an Ark Dialog inside the editor's own
  // cover dialog (the body-lock leak in .claude/rules/engineering-principles.md).
  const [pictureOpen, setPictureOpen] = useState(false);
  const [picturePrompt, setPicturePrompt] = useState("");
  const [pictureError, setPictureError] = useState<string | null>(null);
  // In-flight placeholders. Each has its own id + cascade SLOT + target slide,
  // so several generations can run at once without stacking or overwriting each
  // other. Rendered on the canvas only for the slide they belong to. The ref is
  // the synchronous source of truth (so a slot is picked deterministically even
  // when two submits land in the same tick); the state mirrors it for rendering.
  const [pendingPictures, setPendingPictures] = useState<
    Array<{ id: string; slideId: string; slot: number; prompt: string; source: "generate" | "find"; frame: Frame }>
  >([]);
  const pendingPicturesRef = useRef(pendingPictures);
  // Mirror of the prompt read synchronously in makePicture: a double-click (or a
  // double Enter) fires two handlers before React re-renders, and both would
  // read the same non-empty state. Clearing the ref on the first pass makes the
  // second a no-op, so an accidental double-tap never bills two generations.
  const picturePromptRef = useRef("");
  const pictureOpenRef = useRef(false);
  const placeholderSeq = useRef(0);

  // "Find an image" web search. The picker dialog is its own component; this
  // editor owns the placeholder cascade + the insert, so a found image and a
  // generated one land through the EXACT same machinery.
  const [findImageOpen, setFindImageOpen] = useState(false);
  const [findImageError, setFindImageError] = useState<string | null>(null);

  /**
   * Drop an optimistic placeholder on a slide and return its cascade slot plus a
   * remover. Shared by "Make an image" and "Find an image" so both sources
   * cascade against the SAME in-flight set — a second insert while one is in
   * flight steps down the canvas instead of stacking, whichever source it came
   * from. The slot logic (leading slots occupied by existing images + in-flight
   * placeholders, counted from the WORKING deck so a just-resolved image is seen
   * before the subscription catches up) is the behaviour proven live for
   * generation; found images reuse it verbatim.
   */
  const beginPlaceholder = useCallback(
    (
      slideId: string,
      label: string,
      source: "generate" | "find" = "generate",
    ): { id: string; slot: number; remove: () => void } => {
      const workingSlide = workingDeck.current.slides.find((s) => s.id === slideId);
      const target = workingSlide ?? deck.slides.find((s) => s.id === slideId);
      const imagesOnSlide = target
        ? target.elementIds.filter(
            (elementId) => target.elements[elementId]?.type === "image",
          ).length
        : 0;
      const slot = nextCascadeSlot(
        pendingPicturesRef.current
          .filter((p) => p.slideId === slideId)
          .map((p) => p.slot),
        imagesOnSlide,
      );
      const id = `ph-${placeholderSeq.current++}`;
      pendingPicturesRef.current = [
        ...pendingPicturesRef.current,
        { id, slideId, slot, prompt: label, source, frame: placeholderFrame(slot) },
      ];
      setPendingPictures(pendingPicturesRef.current);
      const remove = () => {
        pendingPicturesRef.current = pendingPicturesRef.current.filter(
          (p) => p.id !== id,
        );
        setPendingPictures(pendingPicturesRef.current);
      };
      return { id, slot, remove };
    },
    [deck.slides],
  );

  /**
   * A scholar can drag the in-flight spinner to where the picture should land;
   * the finished image then resolves onto this moved frame (the resolve paths in
   * makePicture / insertFoundImage read the placeholder's CURRENT frame from the
   * ref). Mirrors native's `moveImagePlaceholder`.
   */
  const movePlaceholder = useCallback((id: string, x: number, y: number) => {
    pendingPicturesRef.current = pendingPicturesRef.current.map((p) =>
      p.id === id ? { ...p, frame: { ...p.frame, x, y } } : p,
    );
    setPendingPictures(pendingPicturesRef.current);
  }, []);

  /** The placeholder's current (possibly dragged) frame, read at resolve time. */
  const placeholderFrameNow = useCallback(
    (id: string, slot: number): Frame =>
      pendingPicturesRef.current.find((p) => p.id === id)?.frame ??
      placeholderFrame(slot),
    [],
  );

  const makePicture = useCallback(() => {
    const prompt = picturePromptRef.current.trim();
    if (!onGeneratePicture || !slide || prompt.length === 0) return;
    // Consume the prompt synchronously so a second synchronous submit no-ops.
    picturePromptRef.current = "";

    const slideId = slide.id;
    const { id: placeholderId, slot, remove: removePlaceholder } = beginPlaceholder(slideId, prompt);

    // Return the bar to rest immediately — the scholar is not blocked.
    setPicturePrompt("");
    setPictureError(null);
    pictureOpenRef.current = false;
    setPictureOpen(false);

    void (async () => {
      try {
        const outcome = resolveMakePictureResult(
          await onGeneratePicture(prompt),
          prompt,
        );
        if (outcome.status === "error") {
          // The deck is left untouched; drop the placeholder and surface the
          // backend's kid-readable sentence (fallback only for an empty error).
          removePlaceholder();
          setPictureError(outcome.message);
          return;
        }
        // The kid may have deleted this slide while the picture was generating.
        // Sending the op anyway fails server-side and surfaces a raw "unknown
        // slide" string on a child's own work surface, so check first and say
        // something a nine-year-old can read instead.
        if (!workingDeck.current.slides.some((s) => s.id === slideId)) {
          removePlaceholder();
          setPictureError(MAKE_PICTURE_COPY.errorFallback);
          return;
        }
        // Size the element to the REAL image (no white letterbox) and land it
        // where its placeholder sat — including if the scholar DRAGGED the
        // spinner — then drop the placeholder.
        mutate([
          {
            op: "addElement",
            slideId,
            element: {
              type: "image",
              assetId: outcome.assetId,
              // Every generated image gets alt text, derived from the prompt.
              alt: outcome.alt,
              frame: resolvedImageFrame(
                placeholderFrameNow(placeholderId, slot),
                outcome.width,
                outcome.height,
              ),
            },
          },
        ]);
        removePlaceholder();
      } catch (e) {
        removePlaceholder();
        setPictureError(
          e instanceof Error ? e.message : MAKE_PICTURE_COPY.errorFallback,
        );
      }
    })();
  }, [
    beginPlaceholder,
    placeholderFrameNow,
    mutate,
    onGeneratePicture,
    slide,
  ]);

  const closePicturePrompt = useCallback(() => {
    pictureOpenRef.current = false;
    setPictureOpen(false);
    setPictureError(null);
  }, []);

  const togglePicturePrompt = useCallback(() => {
    if (pictureOpenRef.current) {
      closePicturePrompt();
      return;
    }
    setPictureError(null);
    pictureOpenRef.current = true;
    setPictureOpen(true);
  }, [closePicturePrompt]);

  // A picked web-image result: close the picker, drop an optimistic placeholder
  // on the current slide (same cascade as "Make an image"), then re-host the
  // image server-side. On success the element lands through the SAME path a
  // finished generation takes — fitted to the reported pixels (falling back to
  // the preset box), alt derived from the query. On failure the placeholder is
  // removed and the shared insert-error copy is surfaced like a picture error.
  const insertFoundImage = useCallback(
    (query: string, image: WebImageSearchResult) => {
      if (!onPickImage || !slide) return;
      setFindImageOpen(false);
      setFindImageError(null);
      const slideId = slide.id;
      const { id: placeholderId, slot, remove: removePlaceholder } = beginPlaceholder(
        slideId,
        query,
        "find",
      );

      void (async () => {
        try {
          const result = await onPickImage(query, image);
          if (result.status === "error") {
            removePlaceholder();
            setFindImageError(FIND_IMAGE_COPY.insertErrorFallback);
            return;
          }
          // The kid may have deleted this slide while the pick was re-hosting.
          if (!workingDeck.current.slides.some((s) => s.id === slideId)) {
            removePlaceholder();
            setFindImageError(FIND_IMAGE_COPY.insertErrorFallback);
            return;
          }
          mutate([
            {
              op: "addElement",
              slideId,
              element: {
                type: "image",
                assetId: result.storageId,
                // Every found image gets alt text, derived from the query.
                alt: deriveFoundImageAlt(query),
                // Land where the spinner sat — including if it was dragged.
                frame: resolvedImageFrame(
                  placeholderFrameNow(placeholderId, slot),
                  result.width,
                  result.height,
                ),
              },
            },
          ]);
          removePlaceholder();
        } catch {
          removePlaceholder();
          setFindImageError(FIND_IMAGE_COPY.insertErrorFallback);
        }
      })();
    },
    [onPickImage, slide, beginPlaceholder, placeholderFrameNow, mutate],
  );

  const deleteSelected = useCallback(() => {
    if (!slide || !selectedId) return;
    mutate([{ op: "removeElement", slideId: slide.id, id: selectedId }]);
    setSelectedId(null);
    setEditingTextId(null);
  }, [mutate, slide, selectedId]);

  const handleFrameChange = useCallback(
    (id: string, frame: Frame) => {
      if (!slide) return;
      // A click that doesn't move still fires a pointer-up that commits a move
      // gesture, so skip the resulting no-op patch: it would otherwise hit the
      // server AND land in the undo history as an invisible step (a child
      // pressing undo would see nothing happen). Pre-existing behaviour that
      // only became user-visible once edits are recorded.
      const current = slide.elements[id]?.frame;
      if (current && framesEqual(current, frame)) return;
      mutate([{ op: "patchElement", slideId: slide.id, id, frame }]);
    },
    [mutate, slide],
  );

  const startTextEdit = useCallback(
    (id: string | null) => {
      textEditSlideId.current = id ? (slideId ?? null) : null;
      setEditingTextId(id);
    },
    [slideId],
  );

  const handleCommitText = useCallback(
    (id: string, text: string, touched: boolean) => {
      setEditingTextId(null);
      const target = textDraftTarget(workingDeck.current, textEditSlideId.current, id);
      textEditSlideId.current = null;
      // `touched` comes from the textarea, NOT from comparing text to the
      // element: a scholar who types into a blank box and deletes it all back
      // to blank has genuinely emptied it, and inferring "untouched" from
      // equality left that invisible box behind on web while native removed it.
      // Untouched leaves a pre-existing blank box exactly as it was found.
      if (!target || !touched) return;
      const el = target.element;
      // An unchanged non-blank draft has nothing to write — but a blank one
      // still has to be REMOVED, and by then blank IS what is stored.
      if (text === el.text && !isBlankSlideText(text)) return;
      mutate(textCommitOps(target.slide.id, id, text));
    },
    [mutate],
  );

  // The in-flight text draft lives inside the canvas's textarea, so the editor
  // keeps a live handle on it — nothing else can read a textarea mid-edit.
  const textDraftRef = useRef<{ id: string; read: () => string } | null>(null);
  const registerTextDraft = useCallback(
    (draft: { id: string; read: () => string } | null) => {
      textDraftRef.current = draft;
    },
    [],
  );

  // Commits here are fire-and-forget and there is no unload hook, so a tab
  // hidden mid-edit (switching tabs, closing the laptop) took the typed text
  // with it. This PERSISTS only: the edit session stays open, and a blank draft
  // is left alone so the eventual blur can still remove the box — the same
  // split the native editor makes between its flush and its defocus commit.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState !== "hidden") return;
      commitSpeakerNotes();
      const draft = textDraftRef.current;
      if (!draft) return;
      const target = textDraftTarget(workingDeck.current, textEditSlideId.current, draft.id);
      const text = draft.read();
      if (!target || text === target.element.text || isBlankSlideText(text)) return;
      mutate([{ op: "patchElement", slideId: target.slide.id, id: draft.id, text }]);
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [commitSpeakerNotes, mutate]);

  useEffect(() => {
    const draft = notesDraftRef.current;
    if (draft.slideId !== slide?.id) {
      commitSpeakerNotes();
      const saved = slide?.speakerNotes ?? "";
      const pending = slide ? pendingNotes.current.get(slide.id) : undefined;
      if (slide && pending === saved) pendingNotes.current.delete(slide.id);
      const notes = pending ?? saved;
      notesDraftRef.current = { slideId: slide?.id ?? null, notes, saved };
      setNotesDraft(notes);
      return;
    }
    // Accept remote changes only when this field has no local in-flight edit.
    if (!notesEditing.current) {
      const saved = slide?.speakerNotes ?? "";
      const pending = slide ? pendingNotes.current.get(slide.id) : undefined;
      if (slide && pending === saved) pendingNotes.current.delete(slide.id);
      const notes = pending ?? saved;
      notesDraftRef.current = { ...draft, notes, saved };
      setNotesDraft(notes);
    }
  }, [commitSpeakerNotes, slide]);

  // Keyboard: undo/redo, and Delete/Backspace to remove the selection. NONE of
  // it fires while a text element is being edited — the textarea owns undo then.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (editingTextId || notesEditing.current) return;
      const shortcut = matchHistoryShortcut(e);
      // Enter/Delete on a focused toolbar or popover button belong to that
      // button (React portals still bubble here), not to the selected element.
      const buttonKey = e.key === "Enter" || e.key === "Delete" || e.key === "Backspace";
      if (buttonKey && (e.target as HTMLElement).closest?.("button") != null) return;
      if (shortcut) {
        e.preventDefault();
        if (shortcut === "undo") handleUndo();
        else handleRedo();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelected();
      } else if (
        e.key === "Enter" &&
        selectedId &&
        slide?.elements[selectedId]?.type === "text"
      ) {
        // Enter edits the selected text box (matches native). Newlines inside
        // an edit are handled by the textarea, which owns keys once editing.
        e.preventDefault();
        startTextEdit(selectedId);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    },
    [editingTextId, selectedId, slide, deleteSelected, handleUndo, handleRedo, startTextEdit],
  );

  const selectedType = selectedId ? slide?.elements[selectedId]?.type : undefined;
  const selectedElement = selectedId ? slide?.elements[selectedId] : undefined;

  return (
    <Flex
      direction="column"
      h="100%"
      w="100%"
      bg="gray.100"
      outline="none"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {/* Toolbar */}
      <Flex
        align="center"
        gap={1}
        px={3}
        py={2}
        bg="white"
        borderBottomWidth="1px"
        borderColor="gray.200"
        flexShrink={0}
        flexWrap="wrap"
      >
        <IconButton
          aria-label={SLIDES_COPY.undo}
          title={SLIDES_COPY.undo}
          size="sm"
          variant="ghost"
          color="charcoal.600"
          disabled={!canUndo(history)}
          onClick={handleUndo}
        >
          <ArrowCounterClockwise weight="bold" />
        </IconButton>
        <IconButton
          aria-label={SLIDES_COPY.redo}
          title={SLIDES_COPY.redo}
          size="sm"
          variant="ghost"
          color="charcoal.600"
          disabled={!canRedo(history)}
          onClick={handleRedo}
        >
          <ArrowClockwise weight="bold" />
        </IconButton>
        <Box w="1px" h="24px" bg="gray.200" mx={1} flexShrink={0} />
        {INSERT_KINDS.map((kind) => (
          <Button
            key={kind}
            size="sm"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.600"
            onClick={() => insertElement(kind)}
          >
            {INSERT_ICONS[kind]}
            {SLIDES_COPY.insert[kind]}
          </Button>
        ))}
        {onUploadImage && (
          <Button
            size="sm"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.600"
            disabled={addingImage !== null}
            onClick={() => void addPhoto()}
          >
            <ImageSquare weight="bold" />
            {addingImage === "photo" ? SLIDES_COPY.photoBusy : SLIDES_COPY.photo}
          </Button>
        )}
        {onUploadImage && (
          <Button
            size="sm"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.600"
            disabled={addingImage !== null}
            aria-haspopup="dialog"
            aria-expanded={sketchOpen}
            onClick={() => setSketchOpen(true)}
          >
            <PencilSimple weight="bold" />
            {addingImage === "sketch" ? SLIDES_COPY.sketchBusy : SLIDES_COPY.sketch}
          </Button>
        )}
        {imageError && (
          <Text fontFamily="body" fontSize="xs" color="red.600" role="alert" px={2}>
            {imageError}
          </Text>
        )}
        {onGeneratePicture && (
          <Button
            size="sm"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.600"
            aria-expanded={pictureOpen}
            onClick={togglePicturePrompt}
          >
            <Sparkle weight="bold" />
            {MAKE_PICTURE_COPY.action}
          </Button>
        )}
        {pictureError && (
          <Text fontFamily="body" fontSize="xs" color="red.600" role="alert" px={2}>
            {pictureError}
          </Text>
        )}
        {onSearchImages && onPickImage && (
          <Button
            size="sm"
            variant="ghost"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.600"
            aria-haspopup="dialog"
            aria-expanded={findImageOpen}
            onClick={() => {
              setFindImageError(null);
              setFindImageOpen(true);
            }}
          >
            <MagnifyingGlass weight="bold" />
            {FIND_IMAGE_COPY.action}
          </Button>
        )}
        {findImageError && (
          <Text fontFamily="body" fontSize="xs" color="red.600" role="alert" px={2}>
            {findImageError}
          </Text>
        )}
        <Box flex={1} />
        {onExport && (
          <>
            <Button
              size="sm"
              variant="ghost"
              fontFamily="heading"
              fontWeight="600"
              color="charcoal.600"
              disabled={exporting !== null}
              onClick={() => void runExport("pptx")}
            >
              <DownloadSimple weight="bold" />
              {exporting === "pptx" ? "Exporting…" : "PowerPoint"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              fontFamily="heading"
              fontWeight="600"
              color="charcoal.600"
              disabled={exporting !== null}
              onClick={() => void runExport("pdf")}
            >
              <DownloadSimple weight="bold" />
              {exporting === "pdf" ? "Exporting…" : "PDF"}
            </Button>
          </>
        )}
        <Flex
          w={CONTEXT_SLOT_WIDTH}
          minH="32px"
          align="center"
          justify="flex-end"
          gap={1}
          flexShrink={0}
        >
          {selectedElement?.type === "text" && (
            <SlideStyleControl
              controlLabel={SLIDES_COPY.textStyle}
              glyph="Aa"
              swatchNoun="text"
              currentColor={selectedElement.style.color}
              colors={SLIDE_TEXT_COLORS}
              onSelectColor={(color) =>
                mutate([
                  { op: "patchElement", slideId: slide.id, id: selectedElement.id, style: { color } },
                ])
              }
              sizes={SLIDE_TEXT_SIZES}
              currentSize={selectedElement.style.fontSize}
              onSelectSize={(fontSize) =>
                mutate([
                  { op: "patchElement", slideId: slide.id, id: selectedElement.id, style: { fontSize } },
                ])
              }
              sizeLabel={SLIDES_COPY.textSize}
              colorLabel={SLIDES_COPY.color}
            />
          )}
          {!selectedElement && slide && (
            <SlideStyleControl
              controlLabel={SLIDES_COPY.backgroundColor}
              swatchNoun="background"
              currentColor={slide.background}
              colors={SLIDE_BACKGROUND_COLORS}
              onSelectColor={(color) => mutate([{ op: "setBackground", slideId: slide.id, color }])}
            />
          )}
          {selectedElement && (
            <Button
              size="sm"
              variant="ghost"
              fontFamily="heading"
              fontWeight="600"
              color="red.500"
              _hover={{ bg: "red.50" }}
              onClick={deleteSelected}
            >
              <Trash />
              {selectedType === "text" ? "Delete text" : "Delete"}
            </Button>
          )}
        </Flex>
      </Flex>

      {/*
        The "Make an image" prompt bar. Inline (not a nested dialog) so it can't
        trip the Ark body-lock leak inside the editor's own cover dialog. It
        mirrors the inline title/notes editing idiom already in this surface.
      */}
      {onGeneratePicture && pictureOpen && (
        <Flex
          direction="column"
          gap={2}
          px={3}
          py={2}
          bg="white"
          borderBottomWidth="1px"
          borderColor="gray.200"
          flexShrink={0}
        >
          <Flex align="center" gap={2}>
            <Input
              autoFocus
              value={picturePrompt}
              onChange={(e) => {
                setPicturePrompt(e.target.value);
                // Keep the synchronous mirror in step so a double-submit no-ops.
                picturePromptRef.current = e.target.value;
              }}
              onKeyDown={(e) => {
                // Keep typing out of the editor's element shortcuts — an
                // unguarded Backspace here would delete the selected element.
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  makePicture();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closePicturePrompt();
                }
              }}
              placeholder={MAKE_PICTURE_COPY.placeholder}
              aria-label={MAKE_PICTURE_COPY.label}
              maxLength={MAKE_PICTURE_MAX_PROMPT}
              size="sm"
              flex="1 1 auto"
              minW={0}
              maxW="520px"
              fontFamily="body"
            />
            <Button
              size="sm"
              variant="solid"
              fontFamily="heading"
              fontWeight="600"
              disabled={!canMakePicture(picturePrompt, false)}
              onClick={makePicture}
            >
              {MAKE_PICTURE_COPY.submit}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              fontFamily="heading"
              fontWeight="600"
              color="charcoal.600"
              onClick={closePicturePrompt}
            >
              Cancel
            </Button>
          </Flex>
          <Text fontFamily="body" fontSize="xs" color="charcoal.400">
            {MAKE_PICTURE_COPY.help}
          </Text>
        </Flex>
      )}
      <Flex flex={1} minH={0}>
        <SlideFilmstrip
          deck={deck}
          currentIndex={currentIndex}
          resolveAsset={resolveAsset}
          onSelect={selectSlide}
          onDelete={requestDeleteSlide}
          onAdd={addSlide}
          onMove={moveSlide}
          onDuplicate={duplicateSlide}
          clipboard={
            clipboardOwnerId
              ? { pasteCount, onCopy: copySlides, onPasteAfter: pasteSlidesAfter }
              : null
          }
        />

        <Flex direction="column" flex={1} minW={0} minH={0}>
          {/* Canvas stage */}
          <Box flex={1} minH={0} position="relative" p={4}>
            {slide ? (
              <SlideCanvas
                key={slide.id}
                slide={slide}
                readOnly={false}
                selectedId={selectedId}
                editingTextId={editingTextId}
                onSelect={setSelectedId}
                onStartTextEdit={startTextEdit}
                onCommitTextEdit={handleCommitText}
                onCancelTextEdit={() => setEditingTextId(null)}
                registerTextDraft={registerTextDraft}
                onFrameChange={handleFrameChange}
                resolveAsset={resolveAsset}
                placeholders={pendingPictures.filter((p) => p.slideId === slide.id)}
                onMovePlaceholder={movePlaceholder}
              />
            ) : null}
            {/* The copy/paste notice floats over the stage's corner next to the
                filmstrip, where the action happened. Overlaid rather than added
                to the toolbar so it never reflows the toolbar or the canvas, and
                the live region stays mounted so the message is announced. */}
            {clipboardOwnerId && (
              <Box
                position="absolute"
                left={4}
                bottom={4}
                zIndex={1}
                maxW="calc(100% - 32px)"
                pointerEvents="none"
                role="status"
                aria-live="polite"
              >
                {clipboardNotice && (
                  <Text
                    fontFamily="body"
                    fontSize="sm"
                    color={clipboardNotice.tone === "error" ? "red.600" : "charcoal.700"}
                    bg="white"
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="md"
                    shadow="sm"
                    px={3}
                    py={1.5}
                  >
                    {clipboardNotice.text}
                  </Text>
                )}
              </Box>
            )}
          </Box>

          {slide && (
            <Box
              px={3}
              py={2}
              bg="white"
              borderTopWidth="1px"
              borderColor="gray.200"
              flexShrink={0}
            >
              {/* The notes field is ALWAYS mounted at a stable height — it no
                  longer collapses to a button that expands on click. Collapsing
                  reflowed the editor on focus (a one-line button jumped to a
                  multi-row textarea); keeping it mounted means focusing just
                  places a cursor, with no layout shift. Mirrors the native
                  always-mounted notes field. */}
              <Text
                fontFamily="heading"
                fontSize="sm"
                fontWeight="600"
                color="charcoal.700"
                mb={1}
              >
                {SLIDES_COPY.speakerNotes}
              </Text>
              <Textarea
                aria-label={SLIDES_COPY.speakerNotes}
                value={notesDraft}
                maxLength={4000}
                rows={3}
                resize="vertical"
                fontFamily="body"
                fontSize="sm"
                onFocus={() => {
                  notesEditing.current = true;
                  // Editing notes and having an element selected are mutually
                  // exclusive — otherwise a keypress is ambiguous. Focusing
                  // notes drops the selection; selecting an element blurs notes.
                  setSelectedId(null);
                  setEditingTextId(null);
                }}
                onChange={(event) => {
                  const notes = event.target.value;
                  notesDraftRef.current.notes = notes;
                  pendingNotes.current.set(slide.id, notes);
                  setNotesDraft(notes);
                }}
                onBlur={() => {
                  notesEditing.current = false;
                  commitSpeakerNotes();
                }}
              />
            </Box>
          )}
        </Flex>
      </Flex>

      {/* "Find an image" web-search picker. A NON-MODAL Ark dialog (modal={false}
          + explicit backdrop dismiss) opened over the editor's own full-screen
          Dialog — the body-lock discipline in engineering-principles.md. */}
      {onSearchImages && onPickImage && (
        <FindImageDialog
          open={findImageOpen}
          onClose={() => setFindImageOpen(false)}
          initial={imageSearchSnapshot ?? EMPTY_IMAGE_SEARCH_SNAPSHOT}
          onSnapshot={onImageSearchSnapshot ?? INERT}
          onSearch={onSearchImages}
          onPick={(image, query) => insertFoundImage(query, image)}
        />
      )}

      {sketchOpen && (
        <SketchDialog
          onAttach={addSketch}
          onClose={() => setSketchOpen(false)}
          submitLabel="Insert sketch"
        />
      )}

      {/* Confirm deleting a slide that still has content (non-empty slides only). */}
      <Dialog.Root
        open={pendingDeleteSlideId !== null}
        onOpenChange={(d) => {
          if (!d.open) setPendingDeleteSlideId(null);
        }}
        placement="center"
        motionPreset="slide-in-bottom"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="sm">
              <Dialog.Header px={6} pt={6} pb={2}>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  {SLIDES_COPY.deleteSlideConfirmTitle}
                </Heading>
              </Dialog.Header>
              <Dialog.Body px={6} pb={2} pt={2}>
                <Text fontFamily="body" color="charcoal.600">
                  {SLIDES_COPY.deleteSlideConfirmBody}
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={6} pt={4} gap={2}>
                <Button
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => setPendingDeleteSlideId(null)}
                >
                  {SLIDES_COPY.cancel}
                </Button>
                <Button
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  onClick={confirmDeleteSlide}
                >
                  {SLIDES_COPY.deleteSlide}
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Flex>
  );
}

/**
 * The lifted thumbnail settles back into its slot instead of vanishing: the
 * ghost left behind fades back in while the overlay glides home.
 */
const THUMB_DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.35" } } }),
};

function SlideFilmstrip({
  deck,
  currentIndex,
  resolveAsset,
  onSelect,
  onDelete,
  onAdd,
  onMove,
  onDuplicate,
  clipboard,
}: {
  deck: Deck;
  currentIndex: number;
  resolveAsset?: (assetId: string) => string | null;
  onSelect: (index: number) => void;
  onDelete: (slideId: string) => void;
  onAdd: () => void;
  onMove: (slideId: string, afterSlideId: string | null) => void;
  onDuplicate: (slideId: string) => void;
  clipboard: FilmstripClipboard | null;
}) {
  const sensors = useSensors(
    // Mouse: a few pixels of travel before a drag starts, so a click still selects.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // Touch: press and hold to pick up, so a swipe still scrolls the filmstrip.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    // Space picks a focused thumbnail up, arrows move it, Space drops, Esc
    // cancels. Enter stays "open this slide".
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space"] },
    }),
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Hold the dropped order until the deck catches up. On the server-authoritative
  // path the reordered deck arrives a round-trip later, and without this the
  // thumbnail would snap back to its old slot and then jump forward again.
  const [pendingOrder, setPendingOrder] = useState<{ ids: string[]; revision: number } | null>(
    null,
  );
  const byId = new Map(deck.slides.map((s) => [s.id, s]));
  const slides =
    pendingOrder &&
    pendingOrder.revision === deck.revision &&
    pendingOrder.ids.length === deck.slides.length &&
    pendingOrder.ids.every((id) => byId.has(id))
      ? pendingOrder.ids.map((id) => byId.get(id)!)
      : deck.slides;
  const ids = slides.map((s) => s.id);
  const activeId = deck.slides[currentIndex]?.id;
  const draggingIndex = draggingId ? ids.indexOf(draggingId) : -1;

  const onDragStart = (event: DragStartEvent) => setDraggingId(String(event.active.id));
  const onDragEnd = (event: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setPendingOrder({ ids: next, revision: deck.revision });
    onMove(String(active.id), to === 0 ? null : next[to - 1]);
  };

  return (
    <Flex
      as="nav"
      aria-label="Slides"
      direction="column"
      align="center"
      gap={2}
      w="112px"
      px={3}
      py={3}
      bg="white"
      borderRightWidth="1px"
      borderColor="gray.200"
      overflowY="auto"
      flexShrink={0}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDraggingId(null)}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {slides.map((slide, index) => (
            <SlideThumb
              key={slide.id}
              slide={slide}
              index={index}
              active={slide.id === activeId}
              deletable={slides.length > 1}
              resolveAsset={resolveAsset}
              onSelect={() => {
                const deckIndex = deck.slides.findIndex((s) => s.id === slide.id);
                if (deckIndex >= 0) onSelect(deckIndex);
              }}
              onDelete={() => onDelete(slide.id)}
              onDuplicate={() => onDuplicate(slide.id)}
              clipboard={clipboard}
            />
          ))}
        </SortableContext>
        <DragOverlay dropAnimation={THUMB_DROP_ANIMATION}>
          {draggingIndex >= 0 ? (
            <ThumbFace
              slide={slides[draggingIndex]}
              index={draggingIndex}
              active={slides[draggingIndex].id === activeId}
              resolveAsset={resolveAsset}
              lifted
            />
          ) : null}
        </DragOverlay>
      </DndContext>
      <IconButton
        aria-label={SLIDES_COPY.addSlide}
        title={SLIDES_COPY.addSlide}
        w="88px"
        h="50px"
        variant="outline"
        colorPalette="gray"
        flexShrink={0}
        onClick={onAdd}
      >
        <Plus />
      </IconButton>
    </Flex>
  );
}

/**
 * The picture part of a filmstrip thumbnail: the slide at miniature scale and
 * its number. Shared by the thumbnail in its slot and the lifted copy that
 * follows the pointer during a drag, so the two can't drift apart.
 */
function ThumbFace({
  slide,
  index,
  active,
  resolveAsset,
  lifted = false,
}: {
  slide: Deck["slides"][number];
  index: number;
  active: boolean;
  resolveAsset?: (assetId: string) => string | null;
  lifted?: boolean;
}) {
  return (
    <Box
      position="relative"
      w="88px"
      h="50px"
      borderRadius="md"
      bg="gray.50"
      borderWidth="2px"
      borderColor={active ? "cyan.500" : lifted ? "gray.300" : "gray.200"}
      // Picked up: a little bigger, a soft shadow, a slight tilt.
      transform={lifted ? "scale(1.08) rotate(-2deg)" : undefined}
      shadow={lifted ? "lg" : undefined}
      cursor={lifted ? "grabbing" : undefined}
    >
      <Box position="absolute" inset="0" overflow="hidden" borderRadius="sm" pointerEvents="none">
        <SlideCanvas
          slide={slide}
          readOnly
          selectedId={null}
          editingTextId={null}
          onSelect={INERT}
          onStartTextEdit={INERT}
          onCommitTextEdit={INERT}
          onCancelTextEdit={INERT}
          onFrameChange={INERT}
          resolveAsset={resolveAsset}
        />
      </Box>
      <Text
        position="absolute"
        bottom="0"
        left="4px"
        zIndex={1}
        px={1}
        fontSize="sm"
        fontFamily="heading"
        fontWeight="700"
        color={active ? "cyan.700" : "charcoal.400"}
        bg="rgba(255, 255, 255, 0.86)"
        borderRadius="sm"
      >
        {index + 1}
      </Text>
    </Box>
  );
}

/**
 * A filmstrip thumbnail — the canonical slide renderer at miniature scale,
 * inside a numbered, focusable slide switcher with its delete badge.
 *
 * Accessibility: the switcher is a focusable `role="button"` (tab-reachable and
 * Enter-operable via `onKeyDown`), with a visible focus ring and
 * `aria-current` marking the active slide. The delete badge appears on thumbnail
 * hover or when it receives keyboard focus, and stays visible on touch-only
 * devices (`@media (hover: none)`), where there is no hover to reveal it with;
 * deleting a non-empty slide is confirmed upstream.
 *
 * When the host enables the clipboard, a "…" badge in the bottom-right corner
 * opens the slide menu (copy this slide, copy all, paste after this slide). It
 * follows the delete badge's reveal rules and stays shown while its menu is
 * open. It sits beside the switcher, not inside it, so opening the menu never
 * selects the slide. The menu is non-modal and never locks the body, so it is
 * safe inside the editor's cover dialog (the body-lock leak in
 * engineering-principles.md).
 *
 * Drag a thumbnail (or press and hold on touch) to reorder; with the keyboard,
 * Space picks it up, arrows move it and Space drops it.
 */
function SlideThumb({
  slide,
  index,
  active,
  deletable,
  resolveAsset,
  onSelect,
  onDelete,
  onDuplicate,
  clipboard,
}: {
  slide: Deck["slides"][number];
  index: number;
  active: boolean;
  deletable: boolean;
  resolveAsset?: (assetId: string) => string | null;
  onSelect: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  clipboard: FilmstripClipboard | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slide.id,
  });
  return (
    // `className="group"` (not just role) is what Chakra v3's `_groupHover`
    // selector keys off — see `.group:is(:hover, [data-hover])` in its preset.
    <Box
      ref={setNodeRef}
      position="relative"
      flexShrink={0}
      role="group"
      className="group"
      // The slot the lifted thumbnail came from stays as a faint ghost, and the
      // neighbours slide aside to make room.
      style={{ transform: CSS.Translate.toString(transform), transition }}
      opacity={isDragging ? 0.35 : 1}
    >
      <Flex
        {...attributes}
        {...listeners}
        role="button"
        tabIndex={0}
        aria-label={`Slide ${index + 1}`}
        aria-current={active ? "true" : undefined}
        borderRadius="md"
        cursor="pointer"
        css={{ touchAction: "manipulation" }}
        _hover={{ "& > div": { borderColor: active ? "cyan.500" : "gray.300" } }}
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "cyan.500",
          outlineOffset: "2px",
        }}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onSelect();
            return;
          }
          // Space (and arrows while lifted) belong to the keyboard sensor.
          listeners?.onKeyDown?.(e);
        }}
      >
        <ThumbFace slide={slide} index={index} active={active} resolveAsset={resolveAsset} />
      </Flex>
      {deletable && (
        <IconButton
          aria-label={`${SLIDES_COPY.deleteSlide} ${index + 1}`}
          size="xs"
          boxSize="22px"
          variant="outline"
          bg="white"
          color="charcoal.600"
          borderColor="gray.200"
          shadow="sm"
          position="absolute"
          top="2px"
          right="2px"
          zIndex={1}
          borderRadius="full"
          opacity={0}
          pointerEvents="none"
          transition="opacity 0.15s ease, color 0.15s ease, border-color 0.15s ease"
          _groupHover={{ opacity: 1, pointerEvents: "auto" }}
          _focusVisible={{ opacity: 1, pointerEvents: "auto", borderColor: "red.300", color: "red.600" }}
          _hover={{ bg: "white", borderColor: "red.300", color: "red.600" }}
          // Hover-gating is only meaningful where a pointer can hover. On a
          // touch-only device there is no hover state to reveal it with, so the
          // badge stays visible — quiet (dark-on-light) rather than hidden.
          css={{ "@media (hover: none)": { opacity: 1, pointerEvents: "auto" } }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <Trash size={12} />
        </IconButton>
      )}
      <Menu.Root
        positioning={{ placement: "bottom-start" }}
        onSelect={(details) => {
          if (details.value === "duplicate") onDuplicate();
          else if (details.value === "copy") clipboard?.onCopy(slide.id);
          else if (details.value === "copy-all") clipboard?.onCopy(null);
          else if (details.value === "paste") clipboard?.onPasteAfter(slide.id);
        }}
      >
        <Menu.Trigger asChild>
          <IconButton
            aria-label={SLIDES_COPY.slideMenu(index + 1)}
            size="xs"
            boxSize="22px"
            variant="outline"
            bg="white"
            color="charcoal.600"
            borderColor="gray.200"
            shadow="sm"
            position="absolute"
            bottom="2px"
            right="2px"
            zIndex={1}
            borderRadius="full"
            opacity={0}
            pointerEvents="none"
            transition="opacity 0.15s ease, border-color 0.15s ease"
            _groupHover={{ opacity: 1, pointerEvents: "auto" }}
            _focusVisible={{ opacity: 1, pointerEvents: "auto" }}
            _open={{ opacity: 1, pointerEvents: "auto" }}
            _hover={{ bg: "white", borderColor: "gray.300" }}
            css={{ "@media (hover: none)": { opacity: 1, pointerEvents: "auto" } }}
          >
            <DotsThree size={14} weight="bold" />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content
              minW="200px"
              // React portals bubble keys to the editor's own shortcuts:
              // Enter on an item would open the selected text box, and
              // Backspace would delete the selected element. The menu's
              // keyboard handling lives on this element, so stopping here
              // keeps it intact.
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Menu.Item value="duplicate" cursor="pointer">
                {SLIDES_COPY.duplicateSlide}
              </Menu.Item>
              {clipboard && (
                <>
                  <Menu.Item value="copy" cursor="pointer">
                    {SLIDES_COPY.copySlide}
                  </Menu.Item>
                  <Menu.Item value="copy-all" cursor="pointer">
                    {SLIDES_COPY.copyAllSlides}
                  </Menu.Item>
                  {clipboard.pasteCount > 0 && (
                    <Menu.Item value="paste" cursor="pointer">
                      {SLIDES_COPY.pasteSlidesAfter(clipboard.pasteCount)}
                    </Menu.Item>
                  )}
                </>
              )}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Box>
  );
}
