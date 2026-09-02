"use client";

import { Box, Button, HStack } from "@chakra-ui/react";
import { unitKeyFamily } from "@/shared/practiceLoop";

/**
 * The unit keys for a unit-bearing item — the only on-screen keys the flat web
 * answer surface offers (digits come from the hardware keyboard; see
 * `useFlatAnswerKeyboard`). Shared by the practice drill and placement so the
 * affordance can't drift between the two surfaces a scholar meets it on.
 *
 * The whole DIMENSION FAMILY is shown (cm / cm² / cm³ for a "cm³" item), never
 * just the expected one: choosing length vs. area vs. volume IS part of the
 * task, so a single pre-filled key would type the answer for the scholar. A tap
 * REPLACES any trailing unit (`applyUnitKey`), so cm² → cm³ is one tap.
 *
 * Styled to match the `ExpressionKeypad` glyph keys — the flat surface's other
 * accessory keys — so a scholar meets one keypad idiom, not two.
 */
export function UnitKeys({
  answerUnit,
  onPick,
}: {
  /** The item's served unit, display form ("cm³"). */
  answerUnit: string;
  /** Receives the tapped unit; the owner of the input applies `applyUnitKey`. */
  onPick: (unit: string) => void;
}) {
  const family = unitKeyFamily(answerUnit);
  if (family.length === 0) return null;
  return (
    <HStack w="100%" gap={3} justify="center">
      {family.map((unit) => (
        <Button
          key={unit}
          h="56px"
          minW="76px"
          variant="outline"
          bg="#f1ede4"
          aria-label={`Add the unit ${unit}`}
          onClick={() => onPick(unit)}
          userSelect="none"
          style={{
            WebkitUserSelect: "none",
            WebkitTouchCallout: "none",
            touchAction: "manipulation",
          }}
          _active={{ bg: "#e4dcc9", transform: "scale(0.95)" }}
          transition="transform 0.06s ease-out, background 0.06s ease-out"
        >
          <Box as="span" style={{ fontSize: 20, fontWeight: 600 }}>{unit}</Box>
        </Button>
      ))}
    </HStack>
  );
}
