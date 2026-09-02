"use client";

/**
 * /teacher/markers — a dev "playground" to inspect the learning-record marker
 * system in one place: the MasteryMarker family (four-stop colour + Phosphor
 * check glyphs), the neutral BloomLadder at each depth, the neutral
 * automaticity lightning, and mock feed rows showing them in context. Not linked
 * from the nav — a reference surface for design review.
 */

import { Box, Flex, HStack, VStack, Text, Heading, SimpleGrid } from "@chakra-ui/react";
import { MasteryMarker, type MasteryStop } from "@/components/MasteryMarker";
import { BloomLadder } from "@/components/BloomLadder";
import { Automaticity } from "@/components/Automaticity";
import { bloomLabel } from "@/lib/bloom";

const STOPS: { stop: MasteryStop | null; label: string }[] = [
  { stop: "notyet", label: "not yet" },
  { stop: "approaching", label: "approaching" },
  { stop: "met", label: "met the standard" },
  { stop: "beyond", label: "beyond" },
  { stop: null, label: "mastered, no standard" },
];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={5}>
      <Text fontSize="xs" fontWeight="800" letterSpacing="0.05em" textTransform="uppercase" color="charcoal.400" mb={3}>
        {title}
      </Text>
      {children}
    </Box>
  );
}

// A faithful mock of a ScholarFeed row (marker + lead + neutral meta glyphs).
function FeedRow({
  marker,
  lead,
  meta,
  bloomLevel,
  fluencyLevel,
  fluencySource,
  chip,
}: {
  marker: React.ReactNode;
  lead: React.ReactNode;
  meta: string;
  bloomLevel?: number;
  fluencyLevel?: number;
  fluencySource?: string;
  chip?: string;
}) {
  const bloom = bloomLevel != null ? bloomLabel(bloomLevel) : null;
  return (
    <Flex gap={3} align="flex-start" bg="white" borderWidth="1px" borderColor="charcoal.100" borderRadius="xl" px={3} py={2.5} boxShadow="0 1px 2px rgba(34,38,86,.05)">
      {marker}
      <Box flex={1} minW={0}>
        <Text fontSize="sm" color="charcoal.600" lineHeight="1.3">{lead}</Text>
        <HStack gap={2} mt="1px" flexWrap="wrap">
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">{meta} · 53m ago</Text>
          {bloom && (
            <HStack gap={1}>
              <BloomLadder level={bloomLevel} size={10} />
              <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" textTransform="lowercase">{bloom}</Text>
            </HStack>
          )}
          {fluencyLevel ? <Automaticity level={fluencyLevel} source={fluencySource} size={10} /> : null}
          {chip && (
            <Text fontSize="2xs" fontWeight="700" color="violet.700" bg="violet.50" borderWidth="1px" borderColor="violet.100" borderRadius="md" px="6px" py="1px" fontFamily="heading">{chip}</Text>
          )}
        </HStack>
      </Box>
    </Flex>
  );
}

export default function MarkersPlayground() {
  return (
    <Box maxW="1000px" mx="auto" p={8}>
      <Heading size="lg" fontFamily="heading" color="navy.600" mb={1}>Learning-record markers</Heading>
      <Text color="charcoal.400" fontSize="sm" mb={6}>
        Colour is reserved for the four-stop mastery scale (met / beyond vs the standard&apos;s own bar). Depth is a neutral
        Bloom ladder; automaticity is neutral lightning. Markers use Phosphor glyphs — dash (not yet), tilde
        (approaching), Check (met / mastered), double-Check (beyond), Warning (misconception).
      </Text>

      <VStack align="stretch" gap={5}>
        <Card title="Mastery marker — the four-stop family">
          <SimpleGrid columns={{ base: 2, md: 5 }} gap={4}>
            {STOPS.map(({ stop, label }) => (
              <VStack key={label} gap={2}>
                <MasteryMarker kind="mastery" stop={stop} size={44} />
                <Text fontSize="xs" color="charcoal.500" textAlign="center" fontWeight="600">{label}</Text>
              </VStack>
            ))}
          </SimpleGrid>
          <Text fontSize="xs" color="charcoal.400" mt={4}>
            not yet → dash · approaching → tilde · met → single check · beyond → double-check. Square (Tree cell shape), never a status orb.
          </Text>
        </Card>

        <Card title="Misconception marker">
          <HStack gap={4}>
            <MasteryMarker kind="misconception" size={44} />
            <Text fontSize="sm" color="charcoal.500">Rose square + Warning — same learning-record family as mastery, kept loud.</Text>
          </HStack>
        </Card>

        <Card title="Bloom ladder — neutral depth (no colour)">
          <HStack gap={6} flexWrap="wrap">
            {[1, 2, 3, 4, 5].map((lvl) => (
              <VStack key={lvl} gap={2}>
                <BloomLadder level={lvl} size={20} />
                <Text fontSize="xs" color="charcoal.500" textTransform="lowercase">{bloomLabel(lvl)}</Text>
              </VStack>
            ))}
          </HStack>
        </Card>

        <Card title="Automaticity (lightning = speed) — neutral, honesty-gated">
          <HStack gap={8} flexWrap="wrap">
            <VStack gap={1}><Automaticity level={1} source="teacher" size={14} /><Text fontSize="xs" color="charcoal.500">effortful · teacher</Text></VStack>
            <VStack gap={1}><Automaticity level={2} source="teacher" size={14} /><Text fontSize="xs" color="charcoal.500">fluent · teacher</Text></VStack>
            <VStack gap={1}><Automaticity level={3} source="teacher" size={14} /><Text fontSize="xs" color="charcoal.500">automatic · teacher</Text></VStack>
            <VStack gap={1}><Automaticity level={3} source="external practice" size={14} /><Text fontSize="xs" color="charcoal.500">automatic · opportunistic</Text></VStack>
          </HStack>
        </Card>

        <Card title="In context — feed rows">
          <VStack align="stretch" gap={2.5}>
            <FeedRow
              marker={<MasteryMarker kind="mastery" stop="beyond" size={34} />}
              lead={<>Demonstrated <b>1.G.1 — Distinguish defining vs non-defining attributes of shapes</b></>}
              meta="Mathematics"
              bloomLevel={4.8}
              fluencyLevel={2}
              fluencySource="teacher"
            />
            <FeedRow
              marker={<MasteryMarker kind="mastery" stop="met" size={34} />}
              lead={<>Demonstrated <b>1.MD.1 — Order three objects by length; compare indirectly</b></>}
              meta="Mathematics"
              bloomLevel={3.0}
            />
            <FeedRow
              marker={<MasteryMarker kind="mastery" stop="approaching" size={34} />}
              lead={<>Demonstrated <b>W.2.1 — Write an opinion with reasons</b></>}
              meta="Writing"
              bloomLevel={2.4}
            />
            <FeedRow
              marker={<MasteryMarker kind="mastery" stop={null} size={34} />}
              lead={<>Demonstrated <b>Vampire-bat reciprocity</b> (no standard)</>}
              meta="Biology"
              bloomLevel={4.2}
            />
            <FeedRow
              marker={<MasteryMarker kind="misconception" size={34} />}
              lead={<><b>Misconception</b> surfaced — “heavier things fall faster”</>}
              meta="Physics"
              chip="un-teach"
            />
          </VStack>
        </Card>
      </VStack>
    </Box>
  );
}
