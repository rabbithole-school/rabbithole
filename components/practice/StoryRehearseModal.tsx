"use client";

import { Dialog, Portal } from "@chakra-ui/react";
import { StoryMomentReveal } from "@/components/practice/StoryMomentCard";
import type { StoryMoment } from "@/components/practice/StoryMomentCard";
import {
  storyMomentForRehearsal,
  type StoryRehearseStory,
} from "@/components/practice/storyRehearse";

/**
 * The Content-view preview renders the scholar's reveal component without a
 * scholar identity or any Convex capability. It is therefore presentation-only:
 * opening, tapping, and closing it can only update local React state.
 */
export function StoryRehearseModal({
  story,
  onClose,
}: {
  story: StoryRehearseStory;
  onClose: () => void;
}) {
  const moment: StoryMoment = storyMomentForRehearsal(story);

  return (
    <Dialog.Root open={true} onOpenChange={(event) => !event.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="552px" bg="#f6f3ec" borderRadius="20px" p={4}>
            <Dialog.Header px={2} pt={2} pb={1}>
              <Dialog.Title fontFamily="heading" fontSize="sm" color="charcoal.600">
                Rehearse · {story.fromLabel}
              </Dialog.Title>
              <Dialog.CloseTrigger />
            </Dialog.Header>
            <Dialog.Body
              px={2}
              py={3}
              maxH="80vh"
              overflowY="auto"
              display="flex"
              justifyContent="center"
              data-testid="story-rehearse-body"
            >
              <StoryMomentReveal moment={moment} />
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
