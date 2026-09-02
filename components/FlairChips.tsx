"use client";

import { Button, Box, HStack, Image, Popover, Portal, Stack, Text } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { useState } from "react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { flairChipDelayMs } from "@/shared/flairMotion";
import { useFlairArrivals } from "@/shared/useFlairArrivals";

import { FLAIR_MOTION_CSS } from "./flairMotionCss";

export interface FlairEarned {
  criterionId: string;
  earnedAt: number;
  /** Scholar-facing sentence about the work that earned this mark. */
  note?: string;
}

interface FlairChipsProps {
  /** The permanent flair awarded on this specific deliverable. */
  flairEarned?: FlairEarned[];
  /** The active deliverable's criteria, including auto-generated snapshots. */
  criteria: Array<{ id: string; label: string; description?: string }>;
  /** True once the deliverable query behind `flairEarned` has answered — a
   *  deliverable with no flair yet has the field ABSENT, so `undefined` alone
   *  cannot tell "still loading" (baselining now would replay the session's
   *  existing flair) from "resolved, nothing earned yet" (baselining now is
   *  exactly right, and skipping it swallows the first award on every
   *  deliverable). Required so a new call site has to answer the question. */
  resolved: boolean;
  /** Whether a newly arriving chip may play its entrance. False for the teacher
   *  remote view — the award is the scholar's live event, not the observer's. */
  animateArrivals?: boolean;
  /** Enriches the immediate initial fallback with art scoped to this deliverable. */
  deliverableId?: Id<"deliverables"> | null;
}

/**
 * Earned-only Flair for one deliverable. The current compact popover interaction
 * stays intact while a Bold mark replaces the old emoji. Art warms
 * asynchronously, so the complete initial mark owns the same 36px geometry
 * until the image is ready.
 *
 * A criterion earned while this instance is mounted enters on a fixed delay, so
 * it lands just after the transcript notice that announced it has settled. Flair
 * that was already there when the instance mounted is static, forever.
 */
export function FlairChips({
  flairEarned,
  criteria,
  resolved,
  animateArrivals = true,
  deliverableId,
}: FlairChipsProps) {
  // Baseline off the raw earned ids, not the rendered chips: criteria and the
  // generated art can resolve after the deliverable does, and baselining on what
  // happens to be renderable would replay every existing award when they land.
  const arriving = useFlairArrivals(
    resolved ? (flairEarned ?? []).map((flair) => flair.criterionId) : undefined,
  );
  const art = useQuery(
    api.flairArt.forDeliverable,
    deliverableId ? { deliverableId } : "skip",
  );

  if (!flairEarned || flairEarned.length === 0) return null;

  const criterionById = new Map(
    criteria.map((criterion) => [criterion.id, criterion]),
  );
  const artByCriterionId = new Map(
    (art ?? []).map((item) => [item.criterionId, item]),
  );
  const chips = flairEarned.flatMap((flair) => {
    const criterion = criterionById.get(flair.criterionId);
    if (!criterion) return [];
    const generated = artByCriterionId.get(flair.criterionId);
    return [
      {
        key: flair.criterionId,
        label: criterion.label,
        // The criterion's `description` is GRADER-facing rubric text (the
        // criteria generator calls it "a private map for the AI tutor"), and
        // teacher/bot-authored rubrics phrase it as FULL/HALF/NOT instructions.
        // The scholar reads the awarding note instead — the one sentence about
        // their own work — and nothing at all when there isn't one.
        note: flair.note ?? generated?.note,
        initial: generated?.initial ?? flairInitial(criterion.label),
        imageUrl: generated?.imageUrl ?? null,
      },
    ];
  });

  if (chips.length === 0) return null;

  const anyEntering = animateArrivals && arriving.length > 0;

  return (
    <HStack gap={2} wrap="wrap">
      {anyEntering ? (
        <style dangerouslySetInnerHTML={{ __html: FLAIR_MOTION_CSS }} />
      ) : null}
      {chips.map((chip) => {
        const arrivingIndex = animateArrivals
          ? arriving.indexOf(chip.key)
          : -1;
        const entering = arrivingIndex >= 0;
        return (
          // The wrapper carries the entrance so the trigger button — and the
          // popover anchored to it — are untouched. It is always present, so a
          // later award never changes this chip's tree shape.
          <Box
            key={chip.key}
            display="inline-flex"
            className={entering ? "rh-flair-chip" : undefined}
            style={
              entering
                ? { animationDelay: `${flairChipDelayMs(arrivingIndex)}ms` }
                : undefined
            }
          >
            <Popover.Root positioning={{ placement: "top", gutter: 6 }}>
              <Popover.Trigger asChild>
                <Button
                  size="md"
                  minW={10}
                  w={10}
                  h={10}
                  p={0}
                  variant="plain"
                  bg="transparent"
                  aria-label={`Flair earned: ${chip.label}. Tap to reveal details.`}
                  _hover={{ bg: "transparent" }}
                >
                  <FlairMark imageUrl={chip.imageUrl} initial={chip.initial} />
                </Button>
              </Popover.Trigger>
              <Portal>
                <Popover.Positioner>
                  <Popover.Content
                    w="auto"
                    maxW="280px"
                    borderColor="border"
                    shadow="md"
                  >
                    <Popover.Arrow />
                    <Popover.Body>
                      <Stack gap={1}>
                        <Text
                          fontSize="sm"
                          fontFamily="heading"
                          fontWeight="600"
                          color="fg"
                        >
                          {chip.label}
                        </Text>
                        {chip.note ? (
                          <Text fontSize="sm" color="fg.muted" lineHeight="1.4">
                            {chip.note}
                          </Text>
                        ) : null}
                      </Stack>
                    </Popover.Body>
                  </Popover.Content>
                </Popover.Positioner>
              </Portal>
            </Popover.Root>
          </Box>
        );
      })}
    </HStack>
  );
}

export function FlairMark({
  imageUrl,
  initial,
}: {
  imageUrl: string | null;
  initial: string;
}) {
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const imageLoaded = imageUrl !== null && loadedUrl === imageUrl;

  return (
    <Box
      pos="relative"
      boxSize="36px"
      aria-hidden
      flexShrink={0}
      borderRadius="full"
      overflow="hidden"
    >
      <Box
        pos="absolute"
        inset={0}
        display="grid"
        placeItems="center"
        border="3px solid"
        borderColor="#17171C"
        borderRadius="full"
        bg="linear-gradient(135deg, #FFC64D 0%, #FFC64D 49.9%, #FF6B57 50.1%, #FF6B57 100%)"
        color="#17171C"
        fontFamily="heading"
        fontWeight="700"
        fontSize="md"
        lineHeight="1"
        opacity={imageLoaded ? 0 : 1}
      >
        {initial}
      </Box>
      {imageUrl ? (
        <Image
          src={imageUrl}
          alt=""
          pos="absolute"
          inset={0}
          boxSize="36px"
          objectFit="contain"
          opacity={imageLoaded ? 1 : 0}
          transition="opacity 160ms ease"
          onLoad={() => setLoadedUrl(imageUrl)}
          onError={() => setLoadedUrl(null)}
        />
      ) : null}
    </Box>
  );
}

function flairInitial(label: string): string {
  return Array.from(label.trim())[0]?.toLocaleUpperCase() ?? "?";
}
