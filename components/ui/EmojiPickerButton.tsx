"use client";

// Shared emoji-picker trigger: an outline button showing the current
// emoji (or a clear dashed "empty" box when none), which pops open the
// emoji-picker-react grid. Used by the dimension editor and the scholar-
// groups dialog so neither has to hand-roll an emoji field — a bare text
// input with an emoji *placeholder* reads like a saved value and groups
// end up with no emoji while looking like they have one.

import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { Box, Button, Spinner, Text } from "@chakra-ui/react";
import type { EmojiClickData } from "emoji-picker-react";

const EmojiPicker = lazy(() => import("emoji-picker-react"));

export function EmojiPickerButton({
  value,
  onChange,
  label,
  ariaLabel,
  height = "48px",
  minW = "64px",
  fontSize = "2xl",
}: {
  value: string;
  onChange: (emoji: string) => void;
  /** Optional label rendered above the trigger. Omit to render your own. */
  label?: string;
  /** Accessible name for the trigger. An empty trigger renders only a dashed
   *  box, so without this it would reach screen readers unnamed. */
  ariaLabel?: string;
  height?: string;
  minW?: string;
  fontSize?: string;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPicker) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPicker]);

  return (
    <Box ref={containerRef} position="relative">
      {label ? (
        <Text fontSize="sm" fontWeight="600" fontFamily="heading" color="navy.500" mb={1}>
          {label}
        </Text>
      ) : null}
      <Button
        variant="outline"
        size="lg"
        minW={minW}
        h={height}
        fontSize={fontSize}
        aria-label={ariaLabel ?? label ?? "Choose an emoji"}
        onClick={() => setShowPicker((v) => !v)}
        fontFamily="body"
      >
        {value || (
          <Box
            as="span"
            w="20px"
            h="20px"
            border="2px dashed"
            borderColor="charcoal.300"
            borderRadius="sm"
            display="inline-block"
          />
        )}
      </Button>
      {showPicker && (
        <Box position="absolute" top="100%" left={0} zIndex={1500} mt={1}>
          <Suspense fallback={<Spinner size="sm" />}>
            <EmojiPicker
              onEmojiClick={(emojiData: EmojiClickData) => {
                onChange(emojiData.emoji);
                setShowPicker(false);
              }}
              width={300}
              height={350}
              skinTonesDisabled
              searchPlaceholder="Search emoji..."
            />
          </Suspense>
        </Box>
      )}
    </Box>
  );
}
