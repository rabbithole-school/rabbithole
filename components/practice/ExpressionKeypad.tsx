"use client";

import { Box, Button, SimpleGrid, VStack } from "@chakra-ui/react";
import React from "react";

import {
  RADICAL_KEYPAD_PATH,
  RADICAL_KEYPAD_VIEWBOX,
  radicalMetrics,
} from "@/shared/radicalGeometry";

/**
 * A tiny outlined box — the shared "answer box" motif, shrunk into a keypad
 * glyph so a fraction/exponent key LOOKS like the thing it inserts (never
 * `[]/[]` / `[]^[]` ascii). Mirrors native's glyph keys.
 */
function MiniBox({ w = 12, h = 14 }: { w?: number; h?: number }) {
  return (
    <Box
      as="span"
      display="inline-block"
      style={{ width: w, height: h, border: "1.6px solid #7a746a", borderRadius: 3 }}
    />
  );
}

function FractionGlyph() {
  return (
    <Box as="span" display="inline-flex" flexDirection="column" alignItems="center" gap="2px">
      <MiniBox />
      <Box as="span" style={{ width: 16, height: 2, background: "#4a463f", borderRadius: 1 }} />
      <MiniBox />
    </Box>
  );
}

function PowerGlyph() {
  return (
    <Box as="span" display="inline-flex" alignItems="flex-start">
      <MiniBox />
      <Box as="span" style={{ marginTop: -6, marginLeft: 1 }}>
        <MiniBox w={9} h={11} />
      </Box>
    </Box>
  );
}

function SquareRootGlyph() {
  const metrics = radicalMetrics(26);
  return (
    <svg
      focusable="false"
      aria-hidden="true"
      height="28"
      viewBox={RADICAL_KEYPAD_VIEWBOX}
      width="40"
    >
      <path
        d={RADICAL_KEYPAD_PATH}
        fill="none"
        stroke="#4a463f"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={metrics.strokeWidth}
      />
      <rect
        fill="none"
        height="18"
        rx="3"
        stroke="#7a746a"
        strokeWidth="1.6"
        width="16"
        x="21"
        y="4"
      />
    </svg>
  );
}

function IndexedRootGlyph() {
  const metrics = radicalMetrics(26, true);
  return (
    <svg focusable="false" aria-hidden="true" height="28" viewBox={RADICAL_KEYPAD_VIEWBOX} width="40">
      <path d={RADICAL_KEYPAD_PATH} fill="none" stroke="#4a463f" strokeLinecap="round" strokeLinejoin="round" strokeWidth={metrics.strokeWidth} />
      <text fill="#4a463f" fontSize="9" fontWeight="600" x="1" y="9">n</text>
      <rect fill="none" height="18" rx="3" stroke="#7a746a" strokeWidth="1.6" width="16" x="21" y="4" />
    </svg>
  );
}

function GlyphKey({
  children,
  onClick,
  ariaLabel,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <Button
      h="56px"
      minW="76px"
      w="100%"
      variant="outline"
      bg="#f1ede4"
      aria-label={ariaLabel}
      onClick={onClick}
      userSelect="none"
      style={{
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
        touchAction: "manipulation",
      }}
      _active={{ bg: "#e4dcc9", transform: "scale(0.95)" }}
      transition="transform 0.06s ease-out, background 0.06s ease-out"
    >
      {children}
    </Button>
  );
}

/**
 * The 2-D expression editor's keypad (web). Normal laptop surfaces get only the
 * STRUCTURE glyphs (fraction / exponent, and roots for radical expressions) plus backspace; `showDigits` adds the
 * number grid for touch-only surfaces. When the answer's structure is already
 * scaffolded (`locked`, an L1 skeleton), the structure glyphs are hidden — the
 * shape is fixed and the scholar only fills the boxes.
 *
 * Shared by the practice session and placement (single source of truth), so the
 * 2-D builder looks and behaves identically wherever a scholar meets it.
 */
export function ExpressionKeypad({
  onInsertFraction,
  onInsertPower,
  onInsertSquareRoot,
  onInsertRoot,
  onDelete,
  onDigit,
  locked,
  showRadicals,
  showDigits = false,
}: {
  onInsertFraction: () => void;
  onInsertPower: () => void;
  onInsertSquareRoot: () => void;
  onInsertRoot: () => void;
  onDelete: () => void;
  onDigit?: (digit: string) => void;
  locked: boolean;
  /** Radical keys are only useful for expression items that can contain one. */
  showRadicals: boolean;
  /** Touch-only surfaces can expose the same digits a hardware keyboard supplies. */
  showDigits?: boolean;
}) {
  return (
    <VStack w="100%" gap={3}>
      {showDigits && onDigit && (
        <SimpleGrid columns={3} gap={2} w="100%">
          {["7", "8", "9", "4", "5", "6", "1", "2", "3", "", "0", ""].map(
            (key, index) => (
              <Button
                key={index}
                h="52px"
                fontSize="22px"
                fontWeight="600"
                variant="outline"
                bg="#f1ede4"
                visibility={key === "" ? "hidden" : "visible"}
                onClick={() => key && onDigit?.(key)}
                disabled={key === ""}
                aria-label={key ? `Key ${key}` : undefined}
              >
                {key}
              </Button>
            ),
          )}
        </SimpleGrid>
      )}
      <SimpleGrid columns={2} gap={3} w="100%">
        {!locked && (
          <>
            <GlyphKey ariaLabel="Insert a fraction" onClick={onInsertFraction}>
              <FractionGlyph />
            </GlyphKey>
            <GlyphKey ariaLabel="Insert an exponent" onClick={onInsertPower}>
              <PowerGlyph />
            </GlyphKey>
            {showRadicals && (
              <>
                <GlyphKey ariaLabel="Insert a square root" onClick={onInsertSquareRoot}>
                  <SquareRootGlyph />
                </GlyphKey>
                <GlyphKey ariaLabel="Insert a root with an index" onClick={onInsertRoot}>
                  <IndexedRootGlyph />
                </GlyphKey>
              </>
            )}
          </>
        )}
        <Box gridColumn="span 2">
          <GlyphKey ariaLabel="Delete" onClick={onDelete}>
            <Box as="span" style={{ fontSize: 22 }}>⌫</Box>
          </GlyphKey>
        </Box>
      </SimpleGrid>
    </VStack>
  );
}
