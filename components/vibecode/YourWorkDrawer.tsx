"use client";

/**
 * YourWorkDrawer — the session's own work (its writing, slides, map, photo…)
 * reachable from inside the full-screen app builder (TRA-519, one app
 * surface). It hosts the SAME `ArtifactPanel` the chat's document panel uses,
 * filtered to everything but the app, with the session's deliverable context,
 * so the editors and Check my work here are the chat's, not a second copy.
 * The native twin is `native/src/components/vibecode/YourWorkSheet.tsx`.
 *
 * The Drawer.Root stays mounted and only toggles `open`; the panel inside is
 * rendered only while open, so its editors mount fresh on each open without
 * remounting the Ark scope (the body-lock leak in engineering-principles.md).
 */

import { useCallback, useState } from "react";
import { Drawer, Flex, IconButton, Portal, Text } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { useMutation } from "convex/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  ArtifactPanel,
  flushAllArtifactSaves,
} from "@/components/ArtifactPanel";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import type { SessionDeliverableContext } from "@/hooks/useSessionDeliverable";
import { APP_SURFACE_COPY } from "@/shared/appSurface";
import { toaster } from "@/lib/toaster";

type WorkArtifact = Parameters<typeof ArtifactPanel>[0]["artifacts"][number];

export function YourWorkDrawer({
  open,
  onClose,
  sessionId,
  artifacts,
  deliverableContext,
  readOnly,
  isStreaming,
  isAiCheckingRubric,
  onSubmitArtifact,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  /** The session's artifacts other than its app. */
  artifacts: WorkArtifact[];
  deliverableContext: SessionDeliverableContext | undefined;
  /** The viewer is not the session's owner (a teacher watching). */
  readOnly: boolean;
  isStreaming: boolean;
  isAiCheckingRubric: boolean;
  onSubmitArtifact: (artifact: WorkArtifact, shouldCheck: boolean) => Promise<void>;
}) {
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const saveArtifact = useMutation(api.artifacts.scholarUpdate);
  const createArtifact = useMutation(api.artifacts.scholarCreate);
  const deleteArtifact = useMutation(api.artifacts.deleteArtifact);

  // Closing unmounts the editors, which would drop a pending edit: save it
  // first, and stay open if the save can't land.
  const close = useCallback(() => {
    flushAllArtifactSaves()
      .then(onClose)
      .catch((error: unknown) => {
        console.error("[your work] save before closing failed", error);
        toaster.error({
          title: "Finish saving your work",
          description:
            "Choose a saved version or retry the save before closing.",
        });
      });
  }, [onClose]);

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) close();
      }}
      placement="end"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          {/* Portaled overlays don't inherit the body's safe-area padding. */}
          <Drawer.Content
            bg="gray.50"
            maxW="560px"
            w="100%"
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            <Flex
              align="center"
              px={4}
              py={2}
              gap={2}
              bg="white"
              borderBottom="1px solid"
              borderColor="gray.200"
              flexShrink={0}
            >
              <Text
                fontFamily="heading"
                fontWeight="600"
                color="navy.500"
                fontSize="sm"
                flex={1}
              >
                {APP_SURFACE_COPY.yourWork}
              </Text>
              <IconButton
                aria-label="Close your work"
                variant="ghost"
                size="sm"
                onClick={close}
              >
                <X />
              </IconButton>
            </Flex>
            <Flex flex={1} minH={0} flexDir="column">
              {open && (
                <ErrorBoundary fallbackMessage="Something went wrong in your work">
                  <ArtifactPanel
                    artifacts={artifacts}
                    activeArtifactId={activeArtifactId}
                    onSelectArtifact={setActiveArtifactId}
                    onSave={(artifactId, updates) =>
                      saveArtifact({
                        artifactId: artifactId as Id<"artifacts">,
                        ...updates,
                      })
                    }
                    onCreateArtifact={() => {
                      void createArtifact({ sessionId })
                        .then((id) => setActiveArtifactId(id))
                        .catch((error: unknown) => {
                          console.error("[your work] create failed", error);
                          toaster.error({ title: "Couldn't add a document" });
                        });
                    }}
                    onDeleteArtifact={async (id) => {
                      await deleteArtifact({ artifactId: id as Id<"artifacts"> });
                    }}
                    mapReadOnly={readOnly}
                    isStreaming={isStreaming}
                    isAiCheckingRubric={isAiCheckingRubric}
                    onSubmitArtifact={onSubmitArtifact}
                    deliverableContext={deliverableContext}
                    animateFlairArrivals={!readOnly}
                  />
                </ErrorBoundary>
              )}
            </Flex>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}
