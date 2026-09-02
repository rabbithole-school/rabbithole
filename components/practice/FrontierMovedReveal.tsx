"use client";

/**
 * FrontierMovedReveal — the calm "⛰ your frontier moved" moment after a scholar
 * CLEARS an above-band challenge round (`challengeFrontierMove` in
 * shared/practiceLoop.ts decides "cleared"; honest "I haven't learned this yet"
 * flags never disqualify). It NAMES the above-band skills she tested into.
 *
 * This is a growth-PORTRAIT line, not a score-flash: no count, no streak, no
 * confetti, no gradient/glow. It reuses the established "frontier moved" visual
 * language (the same flat amber card + even 1px border as ReprobeOffer's reveal),
 * so the two frontier-move surfaces read as one idea. Mirrored 1:1 on native in
 * native/src/components/practice/FrontierMovedReveal.tsx.
 */

import { Box, Text, VStack } from "@chakra-ui/react";
import { superscriptExponents } from "@/shared/mathNotation";

export function FrontierMovedReveal({ skills }: { skills: string[] }) {
  if (skills.length === 0) return null;
  return (
    <Box w="100%" bg="#fff8ee" border="1px solid #f0d58a" borderRadius="14px" p={4}>
      <VStack gap={2} align="stretch">
        <Text fontSize="16px" fontWeight="700" color="#7a5f1c">
          ⛰ Your frontier moved
        </Text>
        <Text fontSize="14px" color="#7a5f1c">
          You reached past your usual work and showed you&apos;ve got:
        </Text>
        {/* A real <ul> so a wrapping skill name keeps its hanging indent
            (marker outside the text column) — matches the "You practiced"
            roll-up on the same done screen. */}
        <Box
          as="ul"
          m={0}
          ps="1.15em"
          listStyleType="disc"
          listStylePosition="outside"
          css={{ "& > li::marker": { color: "#c8a94e" } }}
        >
          {skills.map((label) => (
            <Box
              as="li"
              key={label}
              fontSize="15px"
              lineHeight="1.45"
              fontWeight="600"
              color="#5f4a12"
              mt={1}
              _first={{ mt: 0 }}
            >
              {superscriptExponents(label)}
            </Box>
          ))}
        </Box>
        <Text fontSize="13px" color="#8a6d2a">
          Your next practice builds from here.
        </Text>
      </VStack>
    </Box>
  );
}
