"use client";

import { useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  IconButton,
  Portal,
  Spinner,
  Text,
  VisuallyHidden,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowSquareOut,
  FileText,
  X,
} from "@phosphor-icons/react";
import { formatRelative } from "@/lib/relativeTime";
import { openExternal } from "@/lib/native";
import {
  isVideoMedia,
  viewerIndexForKey,
} from "./parentPortfolioViewerLogic";
import { MapArtifactView } from "@/components/geomap/MapArtifactView";
import { TutorTranscriptionChip } from "@/components/TutorTranscriptionChip";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? null;

export interface ParentPortfolioItem {
  _id: string;
  _creationTime: number;
  kind: "file" | "map" | "text";
  title: string;
  content?: string;
  fileMimeType?: string;
  aiCaption?: string;
  activityTitle?: string | null;
  thumbUrl?: string | null;
  hasFile: boolean;
  fileUrl?: string | null;
  pageRange?: { start: number; end: number };
  attributionCount: number;
  hasTutorTranscription?: boolean;
}

export function ParentPortfolioViewer({
  items,
  activeIndex,
  fileUrl,
  onIndexChange,
  onClose,
}: {
  items: ParentPortfolioItem[];
  activeIndex: number;
  fileUrl: string | null | undefined;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[activeIndex];
  const [failedMediaKey, setFailedMediaKey] = useState<string | null>(null);
  const hasPrevious = activeIndex > 0;
  const hasNext = activeIndex < items.length - 1;
  const video =
    item?.kind === "file" && isVideoMedia(item.fileMimeType);
  const image =
    item?.kind === "file" &&
    (item.fileMimeType?.startsWith("image/") ?? false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const nextIndex = viewerIndexForKey(
        event.key,
        activeIndex,
        items.length,
      );
      if (nextIndex !== null) {
        event.preventDefault();
        onIndexChange(nextIndex);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, items.length, onClose, onIndexChange]);

  if (!item) return null;

  const mediaKey = `${item._id}:${fileUrl ?? ""}`;
  const mediaFailed = failedMediaKey === mediaKey;
  const move = (index: number) => {
    if (index >= 0 && index < items.length) onIndexChange(index);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(details) => {
        if (!details.open) onClose();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.700" />
        <Dialog.Positioner p={{ base: 2, md: 6 }}>
          <Dialog.Content
            bg="white"
            borderRadius={{ base: "xl", md: "2xl" }}
            maxW={{ base: "calc(100vw - 16px)", md: "5xl" }}
            maxH={{ base: "calc(100dvh - 16px)", md: "90dvh" }}
            overflow="hidden"
            shadow="xl"
          >
            <Flex
              align="center"
              borderBottomWidth="1px"
              borderColor="gray.100"
              gap={3}
              px={{ base: 3, md: 5 }}
              py={3}
            >
              <Box flex={1} />
              <VisuallyHidden aria-live="polite">
                Item {activeIndex + 1} of {items.length}: {item.title}
              </VisuallyHidden>
              <Text
                color="charcoal.500"
                flexShrink={0}
                fontFamily="heading"
                fontSize="xs"
              >
                {activeIndex + 1} of {items.length}
              </Text>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close portfolio viewer"
                  size="sm"
                  variant="ghost"
                  onClick={onClose}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Flex>

            <Box
              bg="gray.50"
              minH={{ base: "min(55dvh, 460px)", md: "min(62dvh, 620px)" }}
              position="relative"
            >
              <Flex
                align="center"
                h="full"
                justify="center"
                minH="inherit"
                px={{ base: 2, md: 14 }}
              >
                {item.kind === "map" && item.content ? (
                  <Box
                    h={{ base: "min(55dvh, 460px)", md: "min(62dvh, 620px)" }}
                    w="full"
                  >
                    <MapArtifactView
                      content={item.content}
                      token={MAPBOX_TOKEN}
                      readOnly
                    />
                  </Box>
                ) : item.kind === "text" && item.content ? (
                  <Box
                    alignSelf="stretch"
                    maxH="min(62dvh, 620px)"
                    overflowY="auto"
                    p={{ base: 6, md: 10 }}
                    w="full"
                  >
                    <Text
                      color="charcoal.700"
                      fontFamily="body"
                      fontSize={{ base: "sm", md: "md" }}
                      lineHeight="1.75"
                      whiteSpace="pre-wrap"
                    >
                      {item.content}
                    </Text>
                  </Box>
                ) : fileUrl === undefined ? (
                  <Spinner color="violet.400" />
                ) : image && fileUrl && !mediaFailed ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Convex signed storage URL is dynamic.
                  <img
                    src={fileUrl ?? ""}
                    alt={item.aiCaption || item.title}
                    onError={() => setFailedMediaKey(mediaKey)}
                    style={{
                      display: "block",
                      maxHeight: "min(62dvh, 620px)",
                      maxWidth: "100%",
                      objectFit: "contain",
                    }}
                  />
                ) : video && fileUrl && !mediaFailed ? (
                  <video
                    controls
                    preload="metadata"
                    onError={() => setFailedMediaKey(mediaKey)}
                    style={{
                      display: "block",
                      maxHeight: "min(62dvh, 620px)",
                      maxWidth: "100%",
                    }}
                  >
                    {fileUrl && <source src={fileUrl} type={item.fileMimeType} />}
                    Your browser cannot play this video.
                  </video>
                ) : (
                  <VStack gap={3} p={8} textAlign="center">
                    <FileText size={40} color="#6B7280" />
                    <Text color="charcoal.500" fontFamily="body" fontSize="sm">
                      {mediaFailed
                        ? "This media is no longer available."
                        : "Preview this work in its original file."}
                    </Text>
                  </VStack>
                )}
              </Flex>

              <IconButton
                aria-label="Previous portfolio item"
                disabled={!hasPrevious}
                left={{ base: 2, md: 4 }}
                onClick={() => move(activeIndex - 1)}
                position="absolute"
                size={{ base: "sm", md: "md" }}
                top="50%"
                transform="translateY(-50%)"
                variant="solid"
              >
                <ArrowLeft />
              </IconButton>
              <IconButton
                aria-label="Next portfolio item"
                disabled={!hasNext}
                onClick={() => move(activeIndex + 1)}
                position="absolute"
                right={{ base: 2, md: 4 }}
                size={{ base: "sm", md: "md" }}
                top="50%"
                transform="translateY(-50%)"
                variant="solid"
              >
                <ArrowRight />
              </IconButton>
            </Box>

            <VStack
              align="stretch"
              gap={2}
              maxH={{ base: "30dvh", md: "none" }}
              overflowY="auto"
              px={{ base: 4, md: 6 }}
              py={4}
            >
              <Flex align="baseline" gap={3} justify="space-between">
                <Dialog.Title
                  color="navy.500"
                  fontFamily="heading"
                  fontSize={{ base: "md", md: "lg" }}
                >
                  {item.title}
                </Dialog.Title>
                <Text color="charcoal.400" flexShrink={0} fontSize="xs">
                  {formatRelative(item._creationTime)}
                </Text>
              </Flex>
              {item.activityTitle && (
                <Text color="charcoal.500" fontFamily="heading" fontSize="xs">
                  {item.activityTitle}
                </Text>
              )}
              {item.attributionCount > 1 && (
                <Text
                  alignSelf="flex-start"
                  bg="violet.50"
                  borderRadius="full"
                  color="violet.700"
                  fontFamily="heading"
                  fontSize="xs"
                  px={2.5}
                  py={1}
                >
                  Shared work · {item.attributionCount} scholars
                </Text>
              )}
              {item.aiCaption && (
                <Text color="charcoal.600" fontFamily="body" fontSize="sm">
                  {item.aiCaption}
                </Text>
              )}
              {item.hasTutorTranscription && (
                <TutorTranscriptionChip size="xs" />
              )}
              {item.kind === "file" && !image && !video && fileUrl && (
                <Button
                  alignSelf="flex-start"
                  onClick={() => openExternal(fileUrl)}
                  size="sm"
                  variant="outline"
                >
                  <ArrowSquareOut /> Open file
                </Button>
              )}
            </VStack>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
