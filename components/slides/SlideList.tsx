"use client";

/**
 * SlideList — the READ-ONLY rendering of a deck: every slide, in order, drawn
 * as a real preview in a vertical list.
 *
 * This is what a scholar (and a teacher watching remotely) sees BESIDE the
 * chat. That panel is a splitter pane — 30% of the window by default, 25%
 * minimum — which is too narrow to edit in: the full editor's toolbar wrapped
 * onto three rows there and left the slide itself a couple of hundred pixels
 * tall. So the panel VIEWS and the editor EDITS, which is the split the iPad
 * app already ships (`native/src/components/slides/SlidesDeliverable.tsx`
 * renders a read-only viewer beside chat and opens the editor full-screen).
 *
 * Structurally read-only: there is no mutation prop on this component, so no
 * edit handler can reach the panel by accident. `onEditSlide` is NAVIGATION —
 * it opens the editor on a slide; it never changes a deck. Omit it and nothing
 * here is interactive at all.
 *
 * The slide itself is drawn by {@link SlideCanvas} in `readOnly` mode — the one
 * canonical single-slide renderer on web. There is deliberately no second
 * thumbnail renderer to drift from it.
 */

import { Box, Flex, Text, chakra } from "@chakra-ui/react";
import type { Deck } from "@/shared/slidesScene";
import { SlideCanvas } from "./SlideCanvas";

/**
 * SlideCanvas takes its interaction callbacks unconditionally, but in
 * `readOnly` it starts no gesture and opens no text editor — only the
 * deselect path can fire, and there is no selection to clear. One shared
 * no-op keeps that honest without handing this surface a real handler.
 */
const INERT = () => {};

/** One frame for the slide, whether or not it is clickable. */
const FRAME = {
  w: "100%",
  css: { aspectRatio: "16 / 9" },
  position: "relative",
  borderWidth: "1px",
  borderColor: "gray.200",
  borderRadius: "md",
  overflow: "hidden",
  bg: "white",
} as const;

interface SlideListProps {
  deck: Deck;
  /** Resolve an image/video element's assetId to a URL; null renders a placeholder. */
  resolveAsset?: (assetId: string) => string | null;
  /**
   * Open the full editor on this slide. This is the same affordance the iPad
   * app uses (press the slide → full-screen editor), not a new CTA. Absent =
   * the deck is not the viewer's to edit and nothing is clickable.
   */
  onEditSlide?: (index: number) => void;
}

export function SlideList({ deck, resolveAsset, onEditSlide }: SlideListProps) {
  return (
    // Deliberately NOT its own scroll container: the artifact panel already
    // scrolls, and a second same-axis scroller here is what makes the list jump
    // when the editor opens and closes. Native takes the same posture.
    <Box as="ol" w="100%" bg="white" px={3} py={3} listStyleType="none">
      {deck.slides.map((slide, index) => {
        const notes = slide.speakerNotes?.trim();
        const canvas = (
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
        );

        return (
          <Flex as="li" key={slide.id} gap={2} align="flex-start" mb={4} _last={{ mb: 0 }}>
            <Text
              flexShrink={0}
              w="1.25rem"
              pt={1}
              textAlign="right"
              fontFamily="heading"
              fontSize="xs"
              color="charcoal.300"
            >
              {index + 1}
            </Text>
            <Box flex={1} minW={0}>
              <Box {...FRAME}>
                {canvas}
                {notes && (
                  <Text
                    position="absolute"
                    bottom={0}
                    left={0}
                    right={0}
                    zIndex={1}
                    p={1}
                    fontFamily="body"
                    fontSize="xs"
                    color="charcoal.500"
                    bg="rgba(255,255,255,0.92)"
                    truncate
                    pointerEvents="none"
                  >
                    {notes}
                  </Text>
                )}
                {onEditSlide && (
                  <chakra.button
                    type="button"
                    aria-label={`Edit slide ${index + 1}`}
                    title={`Edit slide ${index + 1}`}
                    onClick={() => onEditSlide(index)}
                    display="block"
                    position="absolute"
                    inset={0}
                    zIndex={2}
                    p={0}
                    bg="transparent"
                    borderWidth="1px"
                    borderColor="transparent"
                    borderRadius="md"
                    cursor="pointer"
                    // Cyan is the slides surface's existing selection hue
                    // (SlideCanvas draws handles in it) — not a new colour with
                    // a new meaning.
                    _hover={{ borderColor: "cyan.500" }}
                    _focusVisible={{
                      outline: "2px solid",
                      outlineColor: "cyan.500",
                      outlineOffset: "-2px",
                    }}
                  />
                )}
              </Box>
            </Box>
          </Flex>
        );
      })}
    </Box>
  );
}
