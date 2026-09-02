"use client";

/**
 * DEV-ONLY reading-ramp render surface (unlinked; visit /dev-grapheme directly).
 *
 * The manual-verification + design-review surface for the grapheme reading ramp
 * (review/young-learners-plan.html §10) and its fade feel. Renders sample tutor
 * sentences through the real <GraphemeText> component with hardcoded annotator
 * spans, and lets you flip each grapheme team's fade stage
 * (training → fading → graduated) live to feel the scaffold remove itself.
 *
 * Pure presentation — no Convex, no auth, no data. It only exercises the
 * prop-driven render layer, so it's inert and harmless (like the other
 * unlinked /dev-* pages).
 * The Haiku annotator (PR #463) and the per-scholar confidence map + session
 * wiring (post-#400) are the two integration follow-ups; this page proves the
 * component is prop-complete for both.
 */

import { useMemo, useState } from "react";
import { Box, Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { GraphemeText } from "@/components/GraphemeText";
import type {
  GraphemeSpan,
  GraphemeStage,
  GraphemeStages,
} from "@/shared/graphemeSegments";

const STAGES: GraphemeStage[] = ["training", "fading", "graduated"];

// Locate the `nth` (1-based) occurrence of `needle` in `text` and tag it as a
// grapheme-team span. Keeps the sample spans authored-by-substring so the demo
// offsets can't silently drift from the sentences.
function span(text: string, needle: string, team: string, nth = 1): GraphemeSpan {
  let from = -1;
  for (let i = 0; i < nth; i++) from = text.indexOf(needle, from + 1);
  return { start: from, end: from + needle.length, team };
}

type Sample = { text: string; spans: GraphemeSpan[] };

const SENTENCE_1 = "The ship is near the shore.";
const SAMPLES: Sample[] = [
  {
    text: SENTENCE_1,
    spans: [
      span(SENTENCE_1, "sh", "sh", 1),
      span(SENTENCE_1, "th", "th", 1),
      span(SENTENCE_1, "sh", "sh", 2),
    ],
  },
  {
    text: "Look at the sheep in the shade.",
    spans: (() => {
      const t = "Look at the sheep in the shade.";
      return [
        span(t, "oo", "oo"),
        span(t, "th", "th", 1),
        span(t, "sh", "sh", 1),
        span(t, "ee", "ee"),
        span(t, "th", "th", 2),
        span(t, "sh", "sh", 2),
      ];
    })(),
  },
  {
    text: "Please read by the sea.",
    spans: (() => {
      const t = "Please read by the sea.";
      return [
        span(t, "ea", "ea", 1),
        span(t, "ea", "ea", 2),
        span(t, "th", "th"),
        span(t, "ea", "ea", 3),
      ];
    })(),
  },
];

// Every team that appears across the samples, in first-seen order.
const ALL_TEAMS = Array.from(new Set(SAMPLES.flatMap((s) => s.spans.map((sp) => sp.team))));

const STAGE_SWATCH: Record<GraphemeStage, string> = {
  training: "#7c3aed",
  fading: "#9aa0ae",
  graduated: "#364153",
};

export default function DevGrapheme() {
  const [stages, setStages] = useState<GraphemeStages>(() =>
    Object.fromEntries(ALL_TEAMS.map((t) => [t, "training"])),
  );

  const setAll = (stage: GraphemeStage) =>
    setStages(Object.fromEntries(ALL_TEAMS.map((t) => [t, stage])));

  // The §10 sketch: the same sentence at all three confidence stages at once.
  const sketchStageMaps = useMemo(() => {
    const teams = SAMPLES[0].spans.map((s) => s.team);
    return STAGES.map(
      (stage) => Object.fromEntries(teams.map((t) => [t, stage])) as GraphemeStages,
    );
  }, []);

  return (
    <Box maxW="760px" mx="auto" px={6} py={10}>
      <Heading size="lg" mb={1}>
        Reading ramp — grapheme render
      </Heading>
      <Text color="charcoal.400" mb={8}>
        Dev surface for the §10 reading ramp. Flip each team&apos;s stage to feel the
        scaffold fade out, per skill.
      </Text>

      {/* §10 three-stage progression (static, matches the sketch) */}
      <Box borderWidth="1px" borderColor="gray.200" borderRadius="2xl" bg="white" p={6} mb={8}>
        <Text
          fontSize="xs"
          textTransform="uppercase"
          letterSpacing="0.05em"
          color="charcoal.400"
          mb={3}
        >
          §10 progression — same sentence, three stages of the &quot;sh&quot;/&quot;th&quot; teams
        </Text>
        <Stack gap={4}>
          {sketchStageMaps.map((map, i) => (
            <Box key={STAGES[i]}>
              <Text fontSize="xs" color="charcoal.400" mb={1}>
                {STAGES[i]}
              </Text>
              <Text fontSize="2xl" color="charcoal.500" lineHeight="1.5">
                <GraphemeText text={SAMPLES[0].text} spans={SAMPLES[0].spans} stages={map} />
              </Text>
            </Box>
          ))}
        </Stack>
        <Text fontSize="xs" color="charcoal.400" mt={3}>
          Fade is per team, not global — a scholar can have &quot;sh&quot; graduated while another
          team is still full color.
        </Text>
      </Box>

      {/* Live controls */}
      <Box borderWidth="1px" borderColor="gray.200" borderRadius="2xl" bg="white" p={6} mb={8}>
        <Flex justify="space-between" align="center" mb={4} wrap="wrap" gap={2}>
          <Text fontWeight="600">Team stages</Text>
          <Flex gap={2}>
            <Button size="xs" variant="outline" onClick={() => setAll("training")}>
              All training
            </Button>
            <Button size="xs" variant="outline" onClick={() => setAll("fading")}>
              All fading
            </Button>
            <Button size="xs" variant="outline" onClick={() => setAll("graduated")}>
              All graduated
            </Button>
          </Flex>
        </Flex>
        <Stack gap={3}>
          {ALL_TEAMS.map((team) => (
            <Flex key={team} align="center" gap={3}>
              <Text
                minW="48px"
                fontFamily="mono"
                fontSize="lg"
                color="charcoal.500"
                fontWeight="600"
              >
                {team}
              </Text>
              <Flex gap={1}>
                {STAGES.map((stage) => {
                  const active = stages[team] === stage;
                  return (
                    <Button
                      key={stage}
                      size="xs"
                      variant={active ? "solid" : "outline"}
                      colorPalette={active ? "purple" : "gray"}
                      onClick={() => setStages((prev) => ({ ...prev, [team]: stage }))}
                    >
                      <Box
                        as="span"
                        display="inline-block"
                        w="8px"
                        h="8px"
                        borderRadius="full"
                        bg={STAGE_SWATCH[stage]}
                        mr={1.5}
                      />
                      {stage}
                    </Button>
                  );
                })}
              </Flex>
            </Flex>
          ))}
        </Stack>
      </Box>

      {/* Live samples */}
      <Box borderWidth="1px" borderColor="gray.200" borderRadius="2xl" bg="white" p={6}>
        <Text
          fontSize="xs"
          textTransform="uppercase"
          letterSpacing="0.05em"
          color="charcoal.400"
          mb={3}
        >
          Live samples
        </Text>
        <Stack gap={5}>
          {SAMPLES.map((sample) => (
            <Text key={sample.text} fontSize="2xl" color="charcoal.500" lineHeight="1.5">
              <GraphemeText text={sample.text} spans={sample.spans} stages={stages} />
            </Text>
          ))}
        </Stack>
      </Box>
    </Box>
  );
}
