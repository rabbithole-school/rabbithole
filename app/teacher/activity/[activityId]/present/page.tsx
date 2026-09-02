"use client";

import { use, useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Flex, Spinner, Text, VStack } from "@chakra-ui/react";
import {
  parseActivityDeck,
  TeacherDeckPresenter,
} from "@/components/slides/TeacherDeckEditor";

/**
 * The activity projector presents its canonical presentation resources:
 *
 *  • Rabbit Slides — presented here, full-bleed,
 *    via the shared slide renderer with next/previous + keyboard arrows.
 *  • an attached Google Slides deck — has its own presenter, so we redirect to
 *    it in Slides' present mode.
 *
 * Rabbit Slides is preferred when both kinds are present.
 */
export default function ActivityPresenterPage({
  params,
}: {
  params: Promise<{ activityId: string }>;
}) {
  const { activityId } = use(params);
  const presentations = useQuery(
    api.activityResources.presentationsForActivity,
    { activityId: activityId as Id<"activities"> },
  );
  const rabbitPresentation = presentations?.find(
    (presentation) => presentation.source.kind === "rabbit_slides",
  );
  const googlePresentation = presentations?.find(
    (presentation) => presentation.source.kind === "google_slides",
  );
  const rabbitDeck =
    rabbitPresentation?.source.kind === "rabbit_slides"
      ? parseActivityDeck(rabbitPresentation.source.deck)
      : null;
  const googleUrl =
    googlePresentation?.source.kind === "google_slides"
      ? googlePresentation.source.url
      : null;
  // Prefer a valid Rabbit deck, but do not strand the presenter when a corrupt
  // Rabbit resource sits beside a usable Google deck.
  const redirectToGoogle = !rabbitDeck && !!googleUrl;

  useEffect(() => {
    if (redirectToGoogle && googleUrl) {
      // Append /present so the deck opens in Slides' presenter mode, not the editor.
      window.location.replace(googleUrl.replace(/\/edit.*$/, "/present"));
    }
  }, [redirectToGoogle, googleUrl]);

  if (rabbitDeck) {
    return <TeacherDeckPresenter deck={rabbitDeck} />;
  }

  return (
    <Flex w="100vw" h="100vh" align="center" justify="center" bg="black">
      <VStack gap={3}>
        {(presentations === undefined || redirectToGoogle) && (
          <Spinner size="lg" color="violet.400" />
        )}
        {redirectToGoogle && (
          <Text color="whiteAlpha.700" fontFamily="body" fontSize="sm">
            Opening Google Slides…
          </Text>
        )}
        {presentations && !rabbitPresentation && !googleUrl && (
          <Text color="white" fontFamily="heading">
            No slides deck attached to this activity.
          </Text>
        )}
        {rabbitPresentation && !rabbitDeck && (
          <Text color="white" fontFamily="heading">
            This Rabbit Slides deck couldn&rsquo;t be opened.
          </Text>
        )}
      </VStack>
    </Flex>
  );
}
