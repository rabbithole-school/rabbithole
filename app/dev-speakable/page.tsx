"use client";

/**
 * Manual-verification surface for the SpeakableLabel primitive (unlinked; visit
 * /dev-speakable directly). There's no automated audio test — this page is where
 * you tap the speakers on a dev server and confirm the label reads itself aloud
 * through the existing /tts path. Mirrors the unlinked dev-page convention
 * (client component, no nav entry).
 *
 * Requires a signed-in scholar with ttsEnabled (the default) — SpeakableLabel
 * renders its children unadorned when TTS is off.
 */

import { Box, Heading, Text, VStack, HStack } from "@chakra-ui/react";
import { SpeakableLabel } from "@/components/SpeakableLabel";

function Row({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text
        fontSize="xs"
        fontWeight="bold"
        color="charcoal.300"
        mb={1}
        textTransform="uppercase"
        letterSpacing="wide"
      >
        {title}
      </Text>
      {children}
    </Box>
  );
}

export default function DevSpeakable() {
  return (
    <Box maxW="640px" mx="auto" p={8}>
      <Heading size="lg" mb={2}>
        SpeakableLabel demo
      </Heading>
      <Text color="charcoal.400" mb={6} fontSize="sm">
        Tap a speaker to hear the label. Only one plays at a time; tapping a new
        one stops the previous. Tapping the same one while it speaks stops it.
      </Text>

      <VStack align="stretch" gap={6}>
        <Row title="Tile name (icon after — default)">
          <SpeakableLabel text="My sessions">
            <Text fontSize="2xl" fontWeight="semibold">
              My sessions
            </Text>
          </SpeakableLabel>
        </Row>

        <Row title="Icon before">
          <SpeakableLabel
            iconPlacement="before"
            text="Good morning! Tap what you want to do."
          >
            <Text fontSize="xl">Good morning! Tap what you want to do.</Text>
          </SpeakableLabel>
        </Row>

        <Row title="Seed / star hook (tap anywhere)">
          <Box
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="xl"
            p={4}
            _hover={{ bg: "violet.50" }}
          >
            <SpeakableLabel
              tapAnywhere
              text="Spiders have eight legs. Is that better than six?"
            >
              <HStack gap={3}>
                <Text fontSize="3xl">🕷️</Text>
                <Text fontSize="lg" fontWeight="medium">
                  Spiders have EIGHT legs. Is that better than six?
                </Text>
              </HStack>
            </SpeakableLabel>
          </Box>
        </Row>

        <Row title="Card title (whole row taps; icon still visible)">
          <SpeakableLabel tapAnywhere iconPlacement="before" text="Aquaponics QUEST">
            <Text fontSize="2xl" fontWeight="bold" color="navy.500">
              Aquaponics QUEST
            </Text>
          </SpeakableLabel>
        </Row>

        <Row title="Text-only (no children) — renders the text + speaker">
          <SpeakableLabel text="Show me a picture" />
        </Row>

        <Row title="Plain-string child (auto-derives the spoken text)">
          <Box fontSize="xl">
            <SpeakableLabel>Say it again</SpeakableLabel>
          </Box>
        </Row>
      </VStack>
    </Box>
  );
}
