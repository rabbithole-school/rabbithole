"use client";

import { Box, Button, HStack } from "@chakra-ui/react";

/**
 * The flat web answer surface's fraction `/` key — parity with the native pad,
 * which always offers a way to ENTER a fraction (a wide "/ (fraction)" key on a
 * decimal item, the grid `/` on a fraction/expression item). On web the flat
 * surface has no on-screen number grid (the hardware keyboard is the pad), so a
 * scholar on a touch or embedded (webview) device otherwise has no way to type a
 * slash. Shown for flat fraction/decimal/expression items only; a 2-D
 * (fraction/power/root) item uses the `ExpressionKeypad` glyph instead.
 *
 * The grader compares numeric answers by VALUE (3/4 ≡ 0.75), so entering a
 * fraction must never be gated by representation — this key removes that gate.
 * Styled to match `UnitKeys` / `ExpressionKeypad` so the flat surface's
 * accessory keys read as one keypad idiom.
 */
export function FractionKey({ onPick }: { onPick: () => void }) {
  return (
    <HStack w="100%" gap={3} justify="center">
      <Button
        h="56px"
        minW="76px"
        variant="outline"
        bg="#f1ede4"
        aria-label="Insert a fraction bar"
        onClick={onPick}
        userSelect="none"
        style={{
          WebkitUserSelect: "none",
          WebkitTouchCallout: "none",
          touchAction: "manipulation",
        }}
        _active={{ bg: "#e4dcc9", transform: "scale(0.95)" }}
        transition="transform 0.06s ease-out, background 0.06s ease-out"
      >
        <Box as="span" style={{ fontSize: 20, fontWeight: 600 }}>
          a/b
        </Box>
      </Button>
    </HStack>
  );
}
