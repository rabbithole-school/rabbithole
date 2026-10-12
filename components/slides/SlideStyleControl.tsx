/**
 * SlideStyleControl — the web editor's one contextual style control, the twin of
 * `native/src/components/slides/SlideStyleControlNative.tsx`. Two shapes, one
 * component so the surfaces never fork:
 *
 *  • Text selected → "Text style": an "Aa" glyph + a dot showing the text's
 *    color. Its Popover holds a Size row (Small/Medium/Large) then the text
 *    swatches. Picking a size keeps the popover OPEN; picking a color closes it.
 *  • Nothing selected → "Slide background": a dot showing the slide background
 *    and a swatch-only popover.
 *
 * Sizes/palettes/copy come from the shared `slidesScene` module.
 */
import { useState } from "react";
import { Box, Button, ButtonGroup, Popover, Portal, SimpleGrid, Text, VStack } from "@chakra-ui/react";

type Swatch = { label: string; value: string };
type SizeOption = { label: string; fontSize: number };

export function SlideStyleControl({
  controlLabel,
  swatchNoun,
  glyph,
  currentColor,
  colors,
  onSelectColor,
  sizes,
  currentSize,
  onSelectSize,
  sizeLabel,
  colorLabel,
}: {
  /** aria-label + purpose of the trigger, e.g. "Text style". */
  controlLabel: string;
  /** Swatch aria-label suffix, e.g. "text" → "Navy text". */
  swatchNoun: string;
  /** Optional leading glyph on the trigger, e.g. "Aa" for the text control. */
  glyph?: string;
  currentColor: string;
  colors: readonly Swatch[];
  onSelectColor: (value: string) => void;
  /** When present, the popover gains a Size row above the color swatches. */
  sizes?: readonly SizeOption[];
  currentSize?: number;
  onSelectSize?: (fontSize: number) => void;
  sizeLabel?: string;
  colorLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(details) => setOpen(details.open)}
      positioning={{ placement: "bottom" }}
    >
      <Popover.Trigger asChild>
        <Button
          size="sm"
          variant="ghost"
          fontFamily="heading"
          fontWeight="600"
          color="charcoal.600"
          aria-label={controlLabel}
        >
          {glyph ? (
            <Text as="span" fontFamily="heading" fontWeight="700" fontSize="sm">
              {glyph}
            </Text>
          ) : null}
          <Box
            w="18px"
            h="18px"
            borderRadius="full"
            bg={currentColor}
            borderWidth="1px"
            borderColor="gray.300"
          />
          {controlLabel}
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content w="auto" bg="white" borderColor="gray.200" shadow="lg" borderRadius="lg">
            <Popover.Arrow />
            <Popover.Body p={3}>
              <VStack align="stretch" gap={3}>
                {sizes && onSelectSize ? (
                  <VStack align="stretch" gap={1.5}>
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      fontSize="2xs"
                      letterSpacing="0.04em"
                      textTransform="uppercase"
                      color="charcoal.400"
                    >
                      {sizeLabel}
                    </Text>
                    <ButtonGroup size="sm" variant="outline" attached>
                      {sizes.map(({ label, fontSize }) => {
                        const selected = currentSize === fontSize;
                        return (
                          <Button
                            key={fontSize}
                            flex="1"
                            fontFamily="heading"
                            fontWeight="600"
                            aria-label={`${label} text`}
                            aria-pressed={selected}
                            bg={selected ? "cyan.50" : undefined}
                            color={selected ? "cyan.700" : "charcoal.600"}
                            onClick={() => {
                              if (!selected) onSelectSize(fontSize);
                            }}
                          >
                            {label}
                          </Button>
                        );
                      })}
                    </ButtonGroup>
                  </VStack>
                ) : null}
                <VStack align="stretch" gap={1.5}>
                  {sizes ? (
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      fontSize="2xs"
                      letterSpacing="0.04em"
                      textTransform="uppercase"
                      color="charcoal.400"
                    >
                      {colorLabel}
                    </Text>
                  ) : null}
                  <SimpleGrid columns={4} gap={1}>
                    {colors.map(({ label, value }) => {
                      const selected = value.toLowerCase() === currentColor.toLowerCase();
                      return (
                        <Box
                          as="button"
                          key={value}
                          aria-label={`${label} ${swatchNoun}`}
                          aria-pressed={selected}
                          onClick={() => {
                            if (!selected) onSelectColor(value);
                            setOpen(false);
                          }}
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          w="44px"
                          h="44px"
                          borderRadius="full"
                          borderWidth="2px"
                          borderColor={selected ? "cyan.500" : "transparent"}
                        >
                          <Box
                            w="28px"
                            h="28px"
                            borderRadius="full"
                            bg={value}
                            borderWidth="1px"
                            borderColor="gray.300"
                          />
                        </Box>
                      );
                    })}
                  </SimpleGrid>
                </VStack>
              </VStack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
