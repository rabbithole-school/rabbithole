"use client";

/**
 * The quiet "Your sky" band that closes the Quests tab on web (TRA-699;
 * review/quests-rebuilt-proposal.html, figure 9, note 5). It runs the width
 * of the column, keeps its label on one line, and opens the kid's own sky on
 * its own page (/scholar/map, the Sky lens), whose back link returns here.
 *
 * The little sky drawn behind the label is decoration: two wonders, the faint
 * line between them and a Quest's star. It never shows the kid's real stars
 * or a number.
 *
 * BunnyPad twin: the Quests tab's horizon and pull-down (native/).
 */

import NextLink from "next/link";
import { Box, Flex, Text } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { YOUR_SKY_COLORS, sparklePath } from "@/shared/yourSkyModel";

/** The band opens the sky here; the sky page's back link then returns to the
 *  Quests tab (app/scholar/map/page.tsx). */
const YOUR_SKY_HREF_FROM_QUESTS = "/scholar/map?view=sky&from=quests";

const DUST: [number, number, number][] = [
  [180, 12, 1.1], [240, 48, 1], [300, 20, 1.2], [360, 52, 1], [420, 14, 1.1],
  [470, 40, 1], [530, 22, 1.1], [580, 50, 1], [210, 30, 0.9], [330, 38, 0.9],
];

export function YourSkyBand({ href = YOUR_SKY_HREF_FROM_QUESTS }: { href?: string }) {
  return (
    <NextLink href={href} style={{ textDecoration: "none", display: "block" }}>
      <Flex
        position="relative"
        align="center"
        justify="space-between"
        gap={3}
        minH="56px"
        px={4}
        py={3}
        borderRadius="xl"
        overflow="hidden"
        bg={YOUR_SKY_COLORS.space}
        color={YOUR_SKY_COLORS.label}
        transition="box-shadow 0.15s"
        _hover={{ boxShadow: `0 0 0 2px ${YOUR_SKY_COLORS.nearby}` }}
        _focusVisible={{ outline: "2px solid", outlineColor: "violet.400" }}
      >
        <Box
          as="svg"
          position="absolute"
          inset={0}
          w="100%"
          h="100%"
          aria-hidden
          // @ts-expect-error chakra svg passthrough
          viewBox="0 0 600 64"
          preserveAspectRatio="xMidYMid slice"
          pointerEvents="none"
        >
          {DUST.map(([cx, cy, r]) => (
            <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill={YOUR_SKY_COLORS.dust} />
          ))}
          <path
            d="M262 26 L400 40"
            stroke={YOUR_SKY_COLORS.nearby}
            strokeWidth={1.2}
            strokeDasharray="3 5"
            opacity={0.8}
            fill="none"
          />
          {[
            [262, 26, 2.4],
            [400, 40, 2.2],
          ].map(([cx, cy, r]) => (
            <g key={cx}>
              <circle cx={cx} cy={cy} r={7} fill={YOUR_SKY_COLORS.wonder} opacity={0.14} />
              <circle cx={cx} cy={cy} r={r} fill={YOUR_SKY_COLORS.wonder} />
            </g>
          ))}
          <path d={sparklePath(500, 32, 10)} fill={YOUR_SKY_COLORS.quest} />
        </Box>
        <Flex position="relative" align="center" gap={2} minW={0}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
            <path d={sparklePath(12, 12, 10.5)} fill={YOUR_SKY_COLORS.quest} />
          </svg>
          <Text
            fontFamily="heading"
            fontWeight="700"
            fontSize="md"
            whiteSpace="nowrap"
            color={YOUR_SKY_COLORS.label}
          >
            Your sky
          </Text>
        </Flex>
        <Box position="relative" color={YOUR_SKY_COLORS.labelDim} display="inline-flex">
          <CaretRight size={18} weight="bold" aria-hidden />
        </Box>
      </Flex>
    </NextLink>
  );
}
