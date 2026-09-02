"use client";

/**
 * TeacherDeckEditor — the teacher-facing surfaces for an activity's Rabbit
 * Slides resource. Two exports, one shared renderer:
 *
 *  • {@link TeacherDeckEditor} — the editing host. Mirrors the scholar's
 *    {@link ./SlidesArtifactView} but persists via the ACTIVITY, not an artifact.
 *    `SlidesEditor` is a controlled component: it applies each edit locally and
 *    hands back the whole `Deck` through `onChange`; this host holds that deck
 *    as an optimistic overlay and stores it via `activities.saveTeacherSlidesDeck`.
 *    It also renders its own compact top bar with the deck's EDITABLE title —
 *    the one canonical title editor, because the title is deck state and shares
 *    the same compare-and-set save chain as every other edit. A host that has
 *    chrome of its own (a dialog's close control) passes it as `headerEnd` so
 *    the surface has ONE top bar, not a static title above an editable one.
 *  • {@link TeacherDeckPresenter} — the projector. It reuses the SHARED
 *    {@link ./SlideCanvas} renderer (never a second geometry) full-bleed, one
 *    slide at a time, with next/previous + keyboard arrows.
 *
 * A failed save surfaces an honest inline banner rather than pretending it saved.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Center, Flex, IconButton, Input, Text } from "@chakra-ui/react";
import { CaretLeft, CaretRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  applySlideOps,
  makeDeckIdFactory,
  validateDeck,
  validateDeckLenient,
  type Deck,
} from "@/shared/slidesScene";
import {
  reconcileDeckWrite,
  titleEditBase,
  type DeckWriteState,
} from "./deckWriteQueue";
import { SlidesEditor } from "./SlidesEditor";
import { SlideCanvas } from "./SlideCanvas";
import { useSlideImageUpload } from "./useSlideImageUpload";

/**
 * The teacher's whole-deck save API, `activities.saveTeacherSlidesDeck`.
 *
 * It takes a `baseRevision` and REFUSES a stale write. A whole-deck save is the
 * one operation that can destroy concurrent work, and the Curriculum Bot writes
 * this same Rabbit Slides resource — so saving from a stale view would silently discard whatever
 * the bot authored while the teacher had the editor open. Convex's
 * serializability does not protect against that.
 */
type SaveDeckResult =
  | { ok: true; revision: number; slideCount: number }
  | { ok: false; error: string; staleRevision?: number };

/** Tolerant parse for RENDER (a mostly-good deck beats an error card). */
export function parseActivityDeck(json: string | undefined | null): Deck | null {
  if (!json) return null;
  try {
    return validateDeckLenient(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Resolve every media assetId a deck references to a URL, in ONE query. Hooks
 * can't run in a loop, so a per-image `files.getUrl` isn't expressible in the
 * renderer — the same reason SlidesArtifactView resolves in bulk.
 */
export function useDeckAssetResolver(
  deck: Deck | null,
): (assetId: string) => string | null {
  const assetIds = useMemo(() => {
    if (!deck) return [] as Id<"_storage">[];
    const ids = new Set<string>();
    for (const slide of deck.slides) {
      for (const eid of slide.elementIds) {
        const el = slide.elements[eid];
        if (el?.type === "image" || el?.type === "video") ids.add(el.assetId);
      }
    }
    return Array.from(ids) as Id<"_storage">[];
  }, [deck]);

  const assetUrls = useQuery(
    api.files.getUrls,
    assetIds.length > 0 ? { storageIds: assetIds } : "skip",
  );

  return useCallback(
    (assetId: string) =>
      assetUrls?.find((a) => a.storageId === assetId)?.url ?? null,
    [assetUrls],
  );
}

export function TeacherDeckEditor({
  activityId,
  headerEnd,
  onTitleEditingChange,
}: {
  activityId: Id<"activities">;
  /** Host chrome (e.g. a dialog's close control) rendered at the top bar's end. */
  headerEnd?: ReactNode;
  /**
   * Fires while the title has an uncommitted draft. A dialog host uses it to
   * hold Escape: the key is a document-level capture listener in the dialog
   * layer, so the input itself cannot stop it, and without this a half-typed
   * rename would take the whole editor down with it.
   */
  onTitleEditingChange?: (editing: boolean) => void;
}) {
  const presentations = useQuery(
    api.activityResources.presentationsForActivity,
    { activityId },
  );
  const saveDeck = useMutation(api.activities.saveTeacherSlidesDeck);
  const uploadImage = useSlideImageUpload();

  const rabbitPresentation = presentations?.find(
    (presentation) => presentation.source.kind === "rabbit_slides",
  );
  const serverDeck = useMemo(
    () =>
      rabbitPresentation?.source.kind === "rabbit_slides"
        ? parseActivityDeck(rabbitPresentation.source.deck)
        : null,
    [rabbitPresentation],
  );

  // SlidesEditor is controlled: it applies each edit and hands back the whole
  // deck. We hold that as an optimistic overlay so edits show instantly. It's
  // preferred only while it's AHEAD of the server; once the reactive query
  // catches up to (or past) what we saved — or the bot edits — the server deck
  // wins again. Derived, so there's no setState-in-effect reconciliation.
  const [optimistic, setOptimistic] = useState<Deck | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  /**
   * The revision the SERVER last accepted from us, and a one-at-a-time chain.
   *
   * `baseRevision` cannot be the revision we happen to be rendering: two quick
   * edits would both compute a base the server has not reached yet, and the
   * second would be refused — reintroducing exactly the silent-edit-loss this
   * guard exists to prevent. Tracking what the server actually accepted, and
   * serialising saves so only one is ever in flight, makes consecutive edits
   * safe while still catching a genuine concurrent write by the bot.
   */
  const acceptedRevision = useRef<number | null>(null);
  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * What is in flight, for {@link reconcileDeckWrite}. `lastQueued` is the
   * newest deck handed to the chain; `pendingTitle` is a rename that has been
   * committed but not yet stored. Both writers into `onChange` — the slide
   * editor and the top bar's title — compute from a render-time copy of the
   * deck, so within a tick either can hand back a deck that has already been
   * superseded by the other.
   */
  const writeState = useRef<DeckWriteState>({
    lastQueued: null,
    pendingTitle: null,
  });

  const deck =
    optimistic && (!serverDeck || serverDeck.revision < optimistic.revision)
      ? optimistic
      : serverDeck;
  const resolveAsset = useDeckAssetResolver(deck);

  const onChange = useCallback(
    (next: Deck) => {
      // Carry forward a rename this write couldn't have seen, and keep queued
      // revisions strictly increasing, before anything is persisted.
      const reconciled = reconcileDeckWrite(next, writeState.current);
      // Strict validate before we claim it saved: never persist a deck the
      // writer would have to truncate.
      const validated = validateDeck(reconciled);
      if (!validated.ok) {
        setSaveError("That change couldn't be saved.");
        return;
      }
      writeState.current.lastQueued = reconciled;
      setOptimistic(reconciled);
      setSaveError(null);
      const observedServerRevision = serverDeck?.revision ?? 0;
      saveChain.current = saveChain.current.then(() => {
        const baseRevision = Math.max(
          acceptedRevision.current ?? observedServerRevision,
          observedServerRevision,
        );
        return saveDeck({
          id: activityId,
          deckJson: JSON.stringify(reconciled),
          baseRevision,
        }).then(
          (res: SaveDeckResult) => {
            if (res?.ok) {
              acceptedRevision.current = res.revision;
              // The stored deck carries this title now, so later writes no
              // longer need it forced back in.
              if (writeState.current.pendingTitle === reconciled.title) {
                writeState.current.pendingTitle = null;
              }
              return;
            }
            // The overlay is gone, so nothing is queued any more: a refused
            // write must not leave a revision floor above the server's, and a
            // rename the teacher was told failed must not be forced back onto
            // the next write.
            writeState.current = { lastQueued: null, pendingTitle: null };
            setOptimistic(null);
            setSaveError(res?.error ?? "That change didn't save — try again.");
          },
          () => {
            writeState.current = { lastQueued: null, pendingTitle: null };
            setOptimistic(null);
            setSaveError("That change didn't save — try again.");
          },
        );
      });
    },
    [saveDeck, activityId, serverDeck?.revision],
  );

  const commitTitle = useCallback(() => {
    if (titleDraft === null) return;
    // Apply to whichever deck is furthest ahead: a slide edit emitted in this
    // same tick may already have superseded the one we rendered with, and
    // renaming the older copy would drop that edit.
    const base = titleEditBase(deck, writeState.current.lastQueued);
    const title = titleDraft.trim();
    setTitleDraft(null);
    if (!base || !title || title === base.title) return;
    const result = applySlideOps(
      base,
      [{ op: "setTitle", title }],
      makeDeckIdFactory(base),
    );
    if (!result.ok) {
      setSaveError("That title couldn’t be saved.");
      return;
    }
    // Hold the rename until its save lands, so a slide edit computed from a
    // pre-rename deck can't write the old title back over it.
    writeState.current.pendingTitle = title;
    onChange(result.deck);
  }, [deck, onChange, titleDraft]);

  const titleEditing = titleDraft !== null;
  useEffect(() => {
    onTitleEditingChange?.(titleEditing);
    // Unmounting mid-rename must not leave the host guarding Escape forever.
    return () => onTitleEditingChange?.(false);
  }, [titleEditing, onTitleEditingChange]);

  const body =
    presentations === undefined ? (
      <Center h="100%" w="100%" bg="gray.100">
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Loading slides…
        </Text>
      </Center>
    ) : !deck ? (
      <Center h="100%" w="100%" bg="white" p={6}>
        <Text
          fontFamily="body"
          fontSize="sm"
          color="charcoal.400"
          textAlign="center"
        >
          {presentations.some(
            (presentation) => presentation.source.kind === "rabbit_slides",
          )
            ? "This Rabbit Slides deck couldn't be opened."
            : "No Rabbit Slides deck is attached to this activity."}
        </Text>
      </Center>
    ) : (
      <SlidesEditor
        deck={deck}
        onChange={onChange}
        resolveAsset={resolveAsset}
        onUploadImage={uploadImage}
      />
    );

  return (
    <Flex direction="column" h="100%" w="100%" minH={0}>
      {/*
        The one top bar. The title reads as the surface's heading and edits in
        place, so there's no static copy of it above and no labelled "Deck
        title" row below — and `headerEnd` keeps the host's close control on
        this same line. Rendered even while loading or unreadable, so the host's
        chrome never disappears.
      */}
      <Flex
        align="center"
        gap={2}
        px={4}
        py={2}
        borderBottomWidth="1px"
        borderColor="gray.200"
        bg="white"
        flexShrink={0}
      >
        {deck ? (
          <Input
            value={titleDraft ?? deck.title}
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                // Revert the draft. The host holds the dialog open for us (see
                // `onTitleEditingChange`) so the editor doesn't vanish too.
                setTitleDraft(null);
              }
            }}
            aria-label="Deck title"
            placeholder="Untitled slides"
            title="Rename this deck"
            maxLength={200}
            flex="1 1 auto"
            minW={0}
            maxW="640px"
            h={9}
            px={2}
            fontFamily="heading"
            fontSize="md"
            fontWeight="700"
            color="navy.500"
            bg="transparent"
            borderColor="transparent"
            _hover={{ borderColor: "gray.200" }}
            _focus={{
              borderColor: "violet.400",
              bg: "white",
              boxShadow: "none",
            }}
          />
        ) : (
          <Text
            fontFamily="heading"
            fontSize="md"
            fontWeight="700"
            color="navy.500"
            h={9}
            px={2}
            display="flex"
            alignItems="center"
            truncate
          >
            Rabbit Slides
          </Text>
        )}
        {headerEnd && (
          <Box ml="auto" flexShrink={0}>
            {headerEnd}
          </Box>
        )}
      </Flex>
      {saveError && (
        <Text
          fontFamily="body"
          fontSize="sm"
          color="red.600"
          bg="red.50"
          px={4}
          py={2}
          role="alert"
          flexShrink={0}
        >
          {saveError}
        </Text>
      )}
      <Box flex={1} minH={0}>
        {body}
      </Box>
    </Flex>
  );
}

/** No-op event handlers for the read-only presenter (SlideCanvas requires them). */
const NOOP = () => {};

/**
 * The projector. Renders ONE slide full-bleed via the shared {@link SlideCanvas}
 * (readOnly), and owns paging — on-screen next/previous plus keyboard arrows and
 * space. The canvas letterboxes the fixed 1280x720 slide inside the viewport, so
 * a deck looks identical here and in the editor.
 */
export function TeacherDeckPresenter({ deck }: { deck: Deck }) {
  const [index, setIndex] = useState(0);
  const resolveAsset = useDeckAssetResolver(deck);

  const count = deck.slides.length;
  const clamped = Math.min(index, Math.max(0, count - 1));
  const slide = deck.slides[clamped];

  const go = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const next = Math.min(Math.max(0, i + delta), Math.max(0, count - 1));
        return next;
      });
    },
    [count],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Home") {
        e.preventDefault();
        setIndex(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setIndex(Math.max(0, count - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, count]);

  if (!slide) {
    return (
      <Center w="100vw" h="100vh" bg="black">
        <Text color="white" fontFamily="heading">
          This deck has no slides.
        </Text>
      </Center>
    );
  }

  return (
    <Flex
      direction="column"
      w="100vw"
      h="100vh"
      bg="black"
      position="relative"
      overflow="hidden"
    >
      <Box flex={1} minH={0}>
        <SlideCanvas
          key={slide.id}
          slide={slide}
          readOnly
          selectedId={null}
          editingTextId={null}
          onSelect={NOOP}
          onStartTextEdit={NOOP}
          onCommitTextEdit={NOOP}
          onCancelTextEdit={NOOP}
          onFrameChange={NOOP}
          resolveAsset={resolveAsset}
        />
      </Box>

      <Flex
        align="center"
        justify="center"
        gap={5}
        px={5}
        py={3}
        flexShrink={0}
        color="white"
      >
        <IconButton
          aria-label="Previous slide"
          variant="ghost"
          color="white"
          _hover={{ bg: "whiteAlpha.200" }}
          disabled={clamped === 0}
          onClick={() => go(-1)}
        >
          <CaretLeft size={24} />
        </IconButton>
        <Text
          fontFamily="heading"
          fontWeight="600"
          fontSize="md"
          minW="80px"
          textAlign="center"
        >
          {clamped + 1} / {count}
        </Text>
        <IconButton
          aria-label="Next slide"
          variant="ghost"
          color="white"
          _hover={{ bg: "whiteAlpha.200" }}
          disabled={clamped >= count - 1}
          onClick={() => go(1)}
        >
          <CaretRight size={24} />
        </IconButton>
      </Flex>
    </Flex>
  );
}
