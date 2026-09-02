"use client";

/**
 * FindImageDialog — the web "Find an image" picker: a search box over a
 * responsive thumbnail grid of Brave-proxied web-image results. Picking a tile
 * hands the result back to {@link ./SlidesEditor}, which drops the SAME
 * placeholder cascade "Make an image" uses and re-hosts the pick server-side.
 *
 * ⚠️ BODY-LOCK LEAK (see .claude/rules/engineering-principles.md "Chakra/Ark
 * Dialog Gotchas"): the slides editor itself is a full-screen Ark Dialog, and
 * this picker opens ON TOP of it. Ark will not release the body lock while an
 * underlying dialog scope is still open, so a modal inner dialog leaves the
 * whole page with `pointer-events: none` after close. Two rules keep us clear:
 *   1. `modal={false}` + an explicit `<Dialog.Backdrop onClick={onClose}>` (a
 *      non-modal dialog loses Ark's outside-click dismiss, so we restore it).
 *   2. `Dialog.Root` stays STABLY MOUNTED — only `open` toggles, never a
 *      changing `key`. Per-open state (query, results) is re-seeded by mounting
 *      the inner {@link FindImageBody} via `{open && <FindImageBody/>}`, so it
 *      gets a fresh mount without ever remounting the Ark scope.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Grid,
  Heading,
  Input,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import {
  FIND_IMAGE_COPY,
  FIND_IMAGE_MAX_QUERY,
  IMAGE_SEARCH_PAGE_SIZE,
  WEB_IMAGE_SHAPES,
  canSubmitImageSearch,
  filterImagesByShape,
  hasMoreResults,
  nextShownCount,
  webImageShapeLabel,
  type WebImageSearchResponse,
  type WebImageSearchResult,
  type WebImageShape,
} from "./findImage";

/** Stable empty tuple so `results` keeps a constant identity between renders. */
const NO_RESULTS: WebImageSearchResult[] = [];

/**
 * What persists across the picker being closed and reopened — the host stores it
 * and hands it back as `initial`, mirroring native's `ImageSearchSnapshot` so a
 * scholar who reopens to change their mind sees their last query + grid + shape.
 * Transient states (busy/error/capped) deliberately do NOT persist.
 */
export type ImageSearchSnapshot = {
  query: string;
  /** The query that produced `results` — the pick + its alt derive from THIS. */
  activeQuery: string;
  results: WebImageSearchResult[];
  shape: WebImageShape;
};

export const EMPTY_IMAGE_SEARCH_SNAPSHOT: ImageSearchSnapshot = {
  query: "",
  activeQuery: "",
  results: NO_RESULTS,
  shape: "any",
};

/** The fixed-height states the body folds to. Kept in this file (the web twin of
 *  native's FindImageSheet `Phase`) so the panel never resizes between them. */
type Phase =
  | "idle"
  | "busy"
  | "results"
  | "empty"
  | "capped"
  | "unavailable"
  | "error";

interface FindImageDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * The last search snapshot, restored so reopening the picker shows the
   * previous query + grid + shape instead of an empty box. Mirrors native's
   * `initial` — the host owns it so it survives this dialog unmounting.
   */
  initial: ImageSearchSnapshot;
  /** Persist the current snapshot up to the host as it changes. */
  onSnapshot: (snapshot: ImageSearchSnapshot) => void;
  /** Run the web search for a query. Resolves to the folded response contract. */
  onSearch: (query: string) => Promise<WebImageSearchResponse>;
  /**
   * The scholar tapped a result. This CLOSES the dialog and hands off to the
   * editor, which owns the placeholder cascade + the re-host (`pickWebImage`).
   * Fire-and-forget by design — the insert lifecycle lives on the canvas, not
   * in this dialog. `query` is the search that produced the grid (activeQuery),
   * so the editor derives honest alt from it, not the live input.
   */
  onPick: (image: WebImageSearchResult, query: string) => void;
}

export function FindImageDialog({
  open,
  onClose,
  initial,
  onSnapshot,
  onSearch,
  onPick,
}: FindImageDialogProps) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      // modal={false} + explicit backdrop dismiss: see the file header. Without
      // this, opening over the editor's own Dialog leaks the Ark body lock and
      // the page goes dead to clicks after close.
      modal={false}
      placement="center"
      size="lg"
    >
      {/* NO Portal — deliberately. The editor's own cover dialog is MODAL and
          traps focus to its DOM subtree; a Portal would render this picker on
          document.body, OUTSIDE that subtree, so the editor's focus trap would
          yank focus off the search box on every keystroke (a child could not
          type). Rendered inline, the picker lives inside the editor dialog's
          focus scope, so the trap is satisfied and the input keeps focus. The
          Positioner is position:fixed, so it still overlays the whole viewport.
          modal={false} keeps this from leaking the Ark body lock (the reason we
          don't just make it modal). */}
      {/* pointerEvents="auto": under modal={false} Ark leaves the backdrop
          click-through (pointer-events: none), which makes outside-click dismiss
          a no-op. Re-enabling it on the backdrop alone restores click-to-dismiss
          without the body lock. */}
      <Dialog.Backdrop onClick={onClose} style={{ pointerEvents: "auto" }} />
      <Dialog.Positioner>
        <StyledDialogContent maxW="2xl" w="min(92vw, 40rem)">
          {/* Re-seed per-open state by remounting the BODY, never the Root. */}
          {open && (
            <FindImageBody
              initial={initial}
              onSnapshot={onSnapshot}
              onSearch={onSearch}
              onPick={onPick}
              onClose={onClose}
            />
          )}
        </StyledDialogContent>
      </Dialog.Positioner>
    </Dialog.Root>
  );
}

function FindImageBody({
  initial,
  onSnapshot,
  onSearch,
  onPick,
  onClose,
}: {
  initial: ImageSearchSnapshot;
  onSnapshot: (snapshot: ImageSearchSnapshot) => void;
  onSearch: (query: string) => Promise<WebImageSearchResponse>;
  onPick: (image: WebImageSearchResult, query: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initial.query);
  // The query that produced the current grid — the pick and its alt derive from
  // THIS, not the live input the kid may already be retyping.
  const [activeQuery, setActiveQuery] = useState(initial.activeQuery);
  const [results, setResults] = useState<WebImageSearchResult[]>(initial.results);
  const [shape, setShape] = useState<WebImageShape>(initial.shape);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>(
    initial.results.length > 0 ? "results" : "idle",
  );
  // Client-side paging: one Brave call returns up to 50 tiles; reveal a page at
  // a time behind "More images" rather than mounting 50 <img> at once.
  const [shown, setShown] = useState(IMAGE_SEARCH_PAGE_SIZE);
  // Roving-tabindex cursor over the revealed tiles. The search box owns focus
  // until the grid exists; ArrowDown from the box steps into it (combobox idiom,
  // adapted to a grid), and the tiles then carry focus for arrow nav + Enter.
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = "find-image-grid";
  const inputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // A stale in-flight search must not clobber a newer one's results.
  const searchSeq = useRef(0);

  // Persist the durable slice up to the host whenever it settles, so reopening
  // restores the last query + grid + shape. Transient phases don't persist.
  useEffect(() => {
    onSnapshot({ query, activeQuery, results, shape });
  }, [query, activeQuery, results, shape, onSnapshot]);

  // The grid renders results narrowed to the chosen shape (client-side — Brave
  // has no shape param). Paging is over the shaped set.
  const shaped = useMemo(
    () => filterImagesByShape(results, shape),
    [results, shape],
  );
  const visible = useMemo(() => shaped.slice(0, shown), [shaped, shown]);
  const activeClamped = Math.max(0, Math.min(activeIndex, visible.length - 1));

  // A shape filter can hide every result of an otherwise-successful search.
  const shapeHidEverything =
    phase === "results" && results.length > 0 && shaped.length === 0;
  const showingGrid = phase === "results" && !shapeHidEverything;

  const submit = useCallback(() => {
    const trimmed = query.trim();
    if (!canSubmitImageSearch(trimmed, busy)) return;
    const seq = ++searchSeq.current;
    setActiveQuery(trimmed);
    setBusy(true);
    setPhase("busy");
    setShown(IMAGE_SEARCH_PAGE_SIZE);
    setActiveIndex(0);
    void (async () => {
      try {
        const response = await onSearch(trimmed);
        if (seq !== searchSeq.current) return;
        if (response.status === "results") {
          setResults(response.results);
          setPhase(response.results.length > 0 ? "results" : "empty");
        } else if (response.status === "capped") {
          setPhase("capped");
        } else if (response.status === "unavailable") {
          setPhase("unavailable");
        } else {
          setPhase("error");
        }
      } catch {
        if (seq !== searchSeq.current) return;
        setPhase("error");
      } finally {
        if (seq === searchSeq.current) setBusy(false);
      }
    })();
  }, [query, busy, onSearch]);

  const changeShape = useCallback((next: WebImageShape) => {
    setShape(next);
    setShown(IMAGE_SEARCH_PAGE_SIZE);
    setActiveIndex(0);
  }, []);

  const pick = useCallback(
    (image: WebImageSearchResult) => {
      // Derive from the query that produced the grid, never the live input.
      onPick(image, activeQuery.trim());
      onClose();
    },
    [onPick, activeQuery, onClose],
  );

  // Keep the active tile in view and focused as the cursor moves.
  useEffect(() => {
    if (!showingGrid) return;
    const el = document.getElementById(`${listboxId}-opt-${activeClamped}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeClamped, showingGrid]);

  const focusTile = useCallback((index: number) => {
    setActiveIndex(index);
    // Focus after the roving tabindex updates so the tile is focusable.
    requestAnimationFrame(() => {
      document.getElementById(`${listboxId}-opt-${index}`)?.focus();
    });
  }, []);

  /** Columns in the current responsive layout, read from the DOM for Up/Down. */
  const columnCount = useCallback((): number => {
    const grid = gridRef.current;
    if (!grid) return 1;
    const tiles = Array.from(grid.children) as HTMLElement[];
    if (tiles.length === 0) return 1;
    const top = tiles[0].offsetTop;
    let cols = 0;
    for (const tile of tiles) {
      if (tile.offsetTop !== top) break;
      cols++;
    }
    return Math.max(1, cols);
  }, []);

  const onGridKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const last = visible.length - 1;
      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          focusTile(Math.min(activeClamped + 1, last));
          break;
        case "ArrowLeft":
          e.preventDefault();
          focusTile(Math.max(activeClamped - 1, 0));
          break;
        case "ArrowDown":
          e.preventDefault();
          focusTile(Math.min(activeClamped + columnCount(), last));
          break;
        case "ArrowUp": {
          e.preventDefault();
          const up = activeClamped - columnCount();
          if (up < 0) inputRef.current?.focus();
          else focusTile(up);
          break;
        }
        case "Home":
          e.preventDefault();
          focusTile(0);
          break;
        case "End":
          e.preventDefault();
          focusTile(last);
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          if (visible[activeClamped]) pick(visible[activeClamped]);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [visible, activeClamped, focusTile, columnCount, pick, onClose],
  );

  return (
    <>
      <Dialog.Header px={6} pt={6} pb={2}>
        <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
          {FIND_IMAGE_COPY.action}
        </Heading>
      </Dialog.Header>
      <Dialog.Body px={6} pb={2} pt={2}>
        <Flex align="center" gap={2}>
          <Box position="relative" flex="1 1 auto" minW={0}>
            <Box
              position="absolute"
              left={2.5}
              top="50%"
              transform="translateY(-50%)"
              color="charcoal.300"
              pointerEvents="none"
            >
              <MagnifyingGlass size={16} />
            </Box>
            <Input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  onClose();
                } else if (e.key === "ArrowDown" && visible.length > 0) {
                  // Step from the search box into the grid (combobox idiom).
                  e.preventDefault();
                  focusTile(0);
                }
              }}
              placeholder={FIND_IMAGE_COPY.placeholder}
              aria-label={FIND_IMAGE_COPY.label}
              maxLength={FIND_IMAGE_MAX_QUERY}
              size="sm"
              pl={8}
              fontFamily="body"
              role="combobox"
              aria-expanded={visible.length > 0}
              aria-controls={listboxId}
              aria-autocomplete="list"
            />
          </Box>
          <Button
            size="sm"
            variant="solid"
            fontFamily="heading"
            fontWeight="600"
            disabled={!canSubmitImageSearch(query, busy)}
            onClick={submit}
          >
            {FIND_IMAGE_COPY.submit}
          </Button>
        </Flex>

        {/* Shape filter — always present so the body below never shifts. */}
        <Flex align="center" gap={2} mt={3} wrap="wrap">
          <Text
            fontFamily="body"
            fontSize="xs"
            fontWeight="600"
            color="charcoal.500"
            mr={0.5}
          >
            {FIND_IMAGE_COPY.shapeLabel}
          </Text>
          {WEB_IMAGE_SHAPES.map((s) => {
            const selected = s === shape;
            return (
              <Button
                key={s}
                size="xs"
                variant={selected ? "solid" : "outline"}
                borderRadius="full"
                fontFamily="heading"
                fontWeight="600"
                colorPalette={selected ? "violet" : undefined}
                color={selected ? undefined : "charcoal.600"}
                aria-pressed={selected}
                onClick={() => changeShape(s)}
              >
                {webImageShapeLabel(s)}
              </Button>
            );
          })}
        </Flex>

        {/* FIXED height: the panel is the same size idle or full of results, so
            the grid arriving after a search never shifts the layout. */}
        <Box mt={3} h="20rem">
          <FindImageState
            phase={phase}
            shapeHidEverything={shapeHidEverything}
            listboxId={listboxId}
            gridRef={gridRef}
            visible={visible}
            total={shaped.length}
            shown={shown}
            activeIndex={activeClamped}
            onGridKeyDown={onGridKeyDown}
            onHoverTile={setActiveIndex}
            onPick={pick}
            onMore={() => setShown((s) => nextShownCount(s, shaped.length))}
          />
        </Box>
      </Dialog.Body>
      <Dialog.Footer px={6} pb={6} pt={2} gap={2}>
        <Button
          variant="ghost"
          fontFamily="heading"
          fontWeight="600"
          color="charcoal.600"
          onClick={onClose}
        >
          {FIND_IMAGE_COPY.cancel}
        </Button>
      </Dialog.Footer>
    </>
  );
}

function FindImageState({
  phase,
  shapeHidEverything,
  listboxId,
  gridRef,
  visible,
  total,
  shown,
  activeIndex,
  onGridKeyDown,
  onHoverTile,
  onPick,
  onMore,
}: {
  phase: Phase;
  shapeHidEverything: boolean;
  listboxId: string;
  gridRef: React.RefObject<HTMLDivElement | null>;
  visible: WebImageSearchResult[];
  total: number;
  shown: number;
  activeIndex: number;
  onGridKeyDown: (e: React.KeyboardEvent) => void;
  onHoverTile: (index: number) => void;
  onPick: (image: WebImageSearchResult) => void;
  onMore: () => void;
}) {
  // A shape filter can hide every result of an otherwise-successful search.
  if (shapeHidEverything) {
    return <CenteredHint>{FIND_IMAGE_COPY.emptyForShape}</CenteredHint>;
  }
  if (phase === "idle") {
    return <CenteredHint>{FIND_IMAGE_COPY.idleHint}</CenteredHint>;
  }
  if (phase === "busy") {
    return (
      <Flex direction="column" align="center" justify="center" gap={3} h="100%">
        <Spinner size="md" color="violet.500" />
        <Text fontFamily="body" fontSize="sm" color="charcoal.500">
          {FIND_IMAGE_COPY.busy}
        </Text>
      </Flex>
    );
  }
  if (phase === "empty") {
    return <CenteredHint>{FIND_IMAGE_COPY.empty}</CenteredHint>;
  }
  if (phase === "capped") {
    return <CenteredHint>{FIND_IMAGE_COPY.capped}</CenteredHint>;
  }
  if (phase === "unavailable") {
    return <CenteredHint>{FIND_IMAGE_COPY.unavailable}</CenteredHint>;
  }
  if (phase === "error") {
    return <CenteredHint role="alert">{FIND_IMAGE_COPY.errorFallback}</CenteredHint>;
  }

  return (
    <Flex direction="column" gap={3} h="100%" minH={0}>
      <Grid
        ref={gridRef}
        id={listboxId}
        role="listbox"
        aria-label={FIND_IMAGE_COPY.action}
        templateColumns={{ base: "repeat(2, 1fr)", sm: "repeat(3, 1fr)", md: "repeat(4, 1fr)" }}
        gap={2}
        flex={1}
        minH={0}
        overflowY="auto"
        onKeyDown={onGridKeyDown}
      >
        {visible.map((image, index) => (
          <ResultTile
            key={image.resultId}
            optionId={`${listboxId}-opt-${index}`}
            image={image}
            active={index === activeIndex}
            onPick={() => onPick(image)}
            onHover={() => onHoverTile(index)}
          />
        ))}
      </Grid>
      {hasMoreResults(shown, total) && (
        <Flex justify="center" flexShrink={0}>
          <Button
            size="sm"
            variant="outline"
            fontFamily="heading"
            fontWeight="600"
            color="charcoal.600"
            onClick={onMore}
          >
            {FIND_IMAGE_COPY.more}
          </Button>
        </Flex>
      )}
    </Flex>
  );
}

function ResultTile({
  optionId,
  image,
  active,
  onPick,
  onHover,
}: {
  optionId: string;
  image: WebImageSearchResult;
  active: boolean;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <Flex
      as="button"
      role="option"
      id={optionId}
      // Roving tabindex: only the active tile is a tab stop, so Tab leaves the
      // grid in one step while arrows move within it.
      tabIndex={active ? 0 : -1}
      aria-selected={active}
      aria-label={image.title || FIND_IMAGE_COPY.altFallback}
      direction="column"
      overflow="hidden"
      borderRadius="md"
      borderWidth="2px"
      borderColor={active ? "violet.400" : "gray.200"}
      bg="gray.50"
      cursor="pointer"
      transition="border-color 0.1s"
      _hover={{ borderColor: "violet.300" }}
      _focusVisible={{ outline: "2px solid", outlineColor: "violet.500", outlineOffset: "1px" }}
      onClick={onPick}
      onMouseEnter={onHover}
    >
      <Box position="relative" w="100%" pt="75%" bg="gray.100" flexShrink={0}>
        {/* Plain <img> straight from Brave's image proxy — never next/image (the
            proxied URL isn't a configured loader host, and the source site must
            never see a request from the child's device). */}
        {/* eslint-disable-next-line @next/next/no-img-element -- Brave-proxied web result, arbitrary host; next/image can't be domain-configured and must not re-fetch */}
        <img
          src={image.thumbnailUrl}
          alt={image.title || ""}
          loading="lazy"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // Contain, not cover: the scholar sees the full image and can judge
            // its true aspect ratio, over a neutral background (the cell bg).
            objectFit: "contain",
          }}
        />
      </Box>
      {image.sourceHost && (
        <Text
          fontFamily="body"
          fontSize="2xs"
          color="charcoal.400"
          px={1.5}
          py={1}
          truncate
          w="100%"
          textAlign="left"
        >
          {image.sourceHost}
        </Text>
      )}
    </Flex>
  );
}

function CenteredHint({
  children,
  role,
}: {
  children: React.ReactNode;
  role?: string;
}) {
  return (
    <Flex align="center" justify="center" h="100%" px={4}>
      <Text
        role={role}
        fontFamily="body"
        fontSize="sm"
        color="charcoal.400"
        textAlign="center"
      >
        {children}
      </Text>
    </Flex>
  );
}
