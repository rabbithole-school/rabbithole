"use client";

/**
 * BadgeRemixStrip — the shared "Make it yours" control for a quest badge.
 *
 * Preset choices only (a style toggle + a colorway), applied at most
 * MAX_BADGE_REROLLS times — no free-text prompt, so customization stays a
 * delight, never a distraction. Self-contained: owns the picker state + the
 * `customizeBadge` mutation. Dark/gold themed to sit on a dark badge surface.
 * Shared by the completion-moment BadgeCelebration and the persistent
 * BadgeDetailDialog (so a scholar can keep remixing from their trophy shelf,
 * within the same capped budget).
 */

import { useState } from "react";
import { Box, Button, HStack, Text, VStack, Wrap } from "@chakra-ui/react";
import { Sparkle } from "@phosphor-icons/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  BADGE_STYLES,
  BADGE_COLORWAYS,
  type BadgeStyle,
  type BadgeColorway,
} from "@/convex/lib/badgeArt";
import { toaster } from "@/lib/toaster";

// The theme has no `amber` palette (only `yellow`), so badge accents use
// explicit warm-gold hexes — a real award gold on the dark surface.
const GOLD = "#f4c44c";
const GOLD_HOVER = "#f8d177";
const ON_GOLD = "#15203f";

export function BadgeRemixStrip({
  badgeId,
  style: currentStyle,
  colorway: currentColorway,
  rerollsRemaining,
  generating,
}: {
  badgeId: Id<"scholarUnitBadges">;
  style: string | null | undefined;
  colorway: string | null | undefined;
  rerollsRemaining: number;
  generating: boolean;
}) {
  const customize = useMutation(api.badges.customizeBadge);
  const [style, setStyle] = useState<BadgeStyle | null>(null);
  const [colorway, setColorway] = useState<BadgeColorway | null>(null);
  const [busy, setBusy] = useState(false);

  const pickedStyle = (style ?? (currentStyle as BadgeStyle)) ?? "patch";
  const pickedColor = (colorway ?? (currentColorway as BadgeColorway)) ?? "auto";
  const canRemix = rerollsRemaining > 0;
  const changed = pickedStyle !== currentStyle || pickedColor !== currentColorway;

  const onRemix = async () => {
    if (!canRemix || generating) return;
    setBusy(true);
    try {
      await customize({ badgeId, style: pickedStyle, colorway: pickedColor });
      toaster.success({ title: "Remixing your badge…" });
    } catch (e) {
      toaster.error({
        title: "Couldn't remix that",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const controlsDisabled = busy || generating || !canRemix;

  return (
    <VStack gap={3} mt={5} align="stretch">
      <Box borderTopWidth="1px" borderColor="whiteAlpha.200" pt={4}>
        <Text fontSize="xs" color="whiteAlpha.600" mb={2} fontWeight="600" textTransform="uppercase" letterSpacing="wide">
          Make it yours
        </Text>

        {/* Style — styled buttons (not Chakra variants) so the selected state
            is always a high-contrast gold fill. */}
        <HStack gap={2} justify="center" mb={3}>
          {(Object.keys(BADGE_STYLES) as BadgeStyle[]).map((s) => {
            const selected = pickedStyle === s;
            return (
              <Box
                as="button"
                key={s}
                onClick={() => !controlsDisabled && setStyle(s)}
                px={4}
                py={2}
                rounded="lg"
                fontFamily="heading"
                fontWeight="700"
                fontSize="sm"
                bg={selected ? GOLD : "whiteAlpha.100"}
                color={selected ? ON_GOLD : "white"}
                borderWidth="1px"
                borderColor={selected ? GOLD : "whiteAlpha.300"}
                cursor={controlsDisabled ? "default" : "pointer"}
                opacity={controlsDisabled && !selected ? 0.5 : 1}
                _hover={controlsDisabled ? undefined : { bg: selected ? GOLD_HOVER : "whiteAlpha.200" }}
                transition="all .12s"
              >
                {BADGE_STYLES[s].label}
              </Box>
            );
          })}
        </HStack>

        {/* Colorway */}
        <Wrap justify="center" gap={2}>
          {(Object.keys(BADGE_COLORWAYS) as BadgeColorway[]).map((c) => {
            const selected = pickedColor === c;
            const [a, b] = BADGE_COLORWAYS[c].swatch;
            return (
              <Box
                key={c}
                as="button"
                title={BADGE_COLORWAYS[c].label}
                aria-label={BADGE_COLORWAYS[c].label}
                onClick={() => !controlsDisabled && setColorway(c)}
                boxSize="32px"
                rounded="full"
                borderWidth="3px"
                borderColor={selected ? GOLD : "whiteAlpha.400"}
                css={{ background: `linear-gradient(135deg, ${a}, ${b})` }}
                cursor={controlsDisabled ? "default" : "pointer"}
                opacity={controlsDisabled && !selected ? 0.5 : 1}
                transform={selected ? "scale(1.12)" : undefined}
                transition="transform .12s"
              />
            );
          })}
        </Wrap>
      </Box>

      {/* One full-width button in every state — Chakra's loading + disabled keep
          its size constant (idle · designing · no-rerolls left), so the dialog
          never reflows. The label/loadingText swap can't resize a full-width
          button, and loadingText stays a single line. */}
      <Button
        w="full"
        bg={GOLD}
        color={ON_GOLD}
        _hover={{ bg: GOLD_HOVER }}
        fontFamily="heading"
        fontWeight="700"
        onClick={onRemix}
        loading={busy || generating}
        loadingText="Designing your badge…"
        disabled={generating || busy || !canRemix || !changed}
      >
        <Sparkle size={16} weight="fill" />
        {canRemix ? `Remix my badge · ${rerollsRemaining} left` : "No remixes left"}
      </Button>
    </VStack>
  );
}
