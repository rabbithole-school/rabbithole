"use client";

import { useState } from "react";
import {
  Button,
  CloseButton,
  Dialog,
  HStack,
  Menu,
  Portal,
} from "@chakra-ui/react";
import { useMutation } from "convex/react";
import { MapTrifold } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MapArtifactView } from "@/components/geomap/MapArtifactView";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? null;

export function DeliverableWorkActions({
  deliverableId,
  scholarName,
  mapContent,
  familyVisibility,
  familyShareable,
}: {
  deliverableId: Id<"deliverables">;
  scholarName: string;
  mapContent?: string | null;
  familyVisibility: "staff_only" | "attributed_families";
  familyShareable: boolean;
}) {
  const setFamilyVisibility = useMutation(
    api.deliverables.setFamilyVisibility,
  );
  const [mapOpen, setMapOpen] = useState(false);
  const [sharing, setSharing] = useState(false);

  const updateFamilySharing = async (
    nextVisibility: "staff_only" | "attributed_families",
  ) => {
    if (sharing) return;
    setSharing(true);
    try {
      await setFamilyVisibility({
        deliverableId,
        familyVisibility: nextVisibility,
      });
    } catch (error) {
      toaster.create({
        title: "Couldn’t update family sharing",
        description: error instanceof Error ? error.message : String(error),
        type: "error",
      });
    } finally {
      setSharing(false);
    }
  };

  return (
    <>
      <HStack gap={1.5} flexShrink={0}>
        {mapContent && (
          <Button
            size="xs"
            variant="ghost"
            colorPalette="violet"
            onClick={() => setMapOpen(true)}
          >
            <MapTrifold />
            View map
          </Button>
        )}
        {familyShareable && familyVisibility === "staff_only" && (
          <Button
            size="xs"
            variant="outline"
            colorPalette="violet"
            disabled={sharing}
            onClick={() => void updateFamilySharing("attributed_families")}
          >
            Share with family
          </Button>
        )}
        {familyShareable && familyVisibility === "attributed_families" && (
          <Menu.Root positioning={{ placement: "bottom-end" }}>
            <Menu.Trigger asChild>
              <Button
                size="xs"
                variant="subtle"
                colorPalette="violet"
                disabled={sharing}
              >
                Shared with family
              </Button>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content>
                  <Menu.Item
                    value="update-family-copy"
                    disabled={sharing}
                    onClick={() =>
                      void updateFamilySharing("attributed_families")
                    }
                  >
                    Update family copy
                  </Menu.Item>
                  <Menu.Item
                    value="hide-from-family"
                    disabled={sharing}
                    onClick={() => void updateFamilySharing("staff_only")}
                  >
                    Hide from family
                  </Menu.Item>
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        )}
      </HStack>

      {mapContent && (
        <Dialog.Root
          open={mapOpen}
          onOpenChange={(details) => setMapOpen(details.open)}
          placement="center"
        >
          <Portal>
            <Dialog.Backdrop />
            <Dialog.Positioner p={{ base: 2, md: 6 }}>
              <StyledDialogContent
                maxW="5xl"
                h={{ base: "calc(100dvh - 16px)", md: "min(80dvh, 760px)" }}
                overflow="hidden"
              >
                <Dialog.Header>
                  <Dialog.Title>{scholarName}&apos;s map</Dialog.Title>
                  <Dialog.CloseTrigger asChild>
                    <CloseButton aria-label="Close map" />
                  </Dialog.CloseTrigger>
                </Dialog.Header>
                <Dialog.Body p={0} minH={0}>
                  <MapArtifactView
                    content={mapContent}
                    token={MAPBOX_TOKEN}
                    readOnly
                  />
                </Dialog.Body>
              </StyledDialogContent>
            </Dialog.Positioner>
          </Portal>
        </Dialog.Root>
      )}
    </>
  );
}
