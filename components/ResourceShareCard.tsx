"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  IconButton,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  CaretRight,
  File,
  FilePdf,
  Image as ImageIcon,
  Link as LinkIcon,
  Play,
  Video,
  X,
} from "@phosphor-icons/react";

import {
  activityResourceEmbedUrl,
  youtubeVideoId,
} from "@/shared/activityResourceEmbed";

export type ResourceShare = {
  title: string;
  kind: "file" | "link" | "video";
  fileName: string | null;
  mimeType: string | null;
  url: string | null;
};

export function ResourceShareCard({
  resource,
  compact = false,
}: {
  resource: ResourceShare;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const embedUrl = activityResourceEmbedUrl(resource);
  const youtubeId =
    resource.kind === "video" && resource.url
      ? youtubeVideoId(resource.url)
      : null;
  const available = !!embedUrl;
  return (
    <>
      <Flex justify="center" py={compact ? 1 : 2}>
        <Button
          type="button"
          variant="plain"
          aria-label={
            available
              ? `Open ${resource.title}`
              : `${resource.title} is unavailable`
          }
          disabled={!available}
          maxW="440px"
          w="full"
          display="flex"
          alignItems="center"
          gap={compact ? 2.5 : 4}
          textAlign="left"
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius={compact ? "lg" : "xl"}
          px={compact ? 3 : 4}
          py={compact ? 2 : 4}
          cursor={available ? "pointer" : "default"}
          opacity={available ? 1 : 0.65}
          _hover={
            available ? { borderColor: "violet.300", bg: "violet.50" } : undefined
          }
          _focusVisible={{
            outline: "2px solid",
            outlineColor: "violet.300",
            outlineOffset: "2px",
          }}
          onClick={() => setOpen(true)}
        >
          <Box
            w={compact ? "32px" : "40px"}
            h={compact ? "32px" : "40px"}
            flexShrink={0}
            display="flex"
            alignItems="center"
            justifyContent="center"
            bg="violet.50"
            color="violet.600"
            borderRadius="lg"
          >
            <ResourceIcon resource={resource} size={compact ? 18 : 22} />
          </Box>
          <Stack gap={0} flex={1} minW={0}>
            <Text
              fontFamily="heading"
              fontWeight="700"
              fontSize="sm"
              color="navy.600"
              truncate
            >
              {resource.title}
            </Text>
            <Text fontSize="xs" color="charcoal.400" truncate>
              {resourceDetail(resource)}
            </Text>
          </Stack>
          {available && (
            <Box color="violet.500" flexShrink={0}>
              <CaretRight size={18} />
            </Box>
          )}
        </Button>
      </Flex>

      <Dialog.Root
        open={open}
        onOpenChange={(event) => setOpen(event.open)}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop zIndex={2000} />
          <Dialog.Positioner zIndex={2001}>
            <Dialog.Content
              w="min(96vw, 1100px)"
              maxW="1100px"
              h="min(88vh, 760px)"
              borderRadius="xl"
              overflow="hidden"
              display="flex"
              flexDirection="column"
            >
              <Dialog.Header px={5} py={3} borderBottomWidth="1px">
                <Stack gap={0} pr={10}>
                  <Dialog.Title fontFamily="heading" color="navy.600">
                    {resource.title}
                  </Dialog.Title>
                  <Text fontSize="xs" color="charcoal.400">
                    {resourceDetail(resource)}
                  </Text>
                </Stack>
                <Dialog.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close resource"
                    variant="ghost"
                    size="sm"
                    position="absolute"
                    top={3}
                    right={3}
                  >
                    <X />
                  </IconButton>
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body p={0} flex={1} minH={0} bg="black">
                {open && embedUrl && youtubeId ? (
                  <YouTubeResourcePlayer
                    title={resource.title}
                    embedUrl={embedUrl}
                  />
                ) : open && embedUrl ? (
                  <iframe
                    title={resource.title}
                    src={embedUrl}
                    width="100%"
                    height="100%"
                    sandbox="allow-forms allow-presentation allow-same-origin allow-scripts"
                    referrerPolicy="strict-origin-when-cross-origin"
                    style={{ border: 0, display: "block" }}
                  />
                ) : null}
              </Dialog.Body>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function YouTubeResourcePlayer({
  title,
  embedUrl,
}: {
  title: string;
  embedUrl: string;
}) {
  const [playing, setPlaying] = useState(false);
  const [watched, setWatched] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const src = useMemo(() => {
    if (!playing || typeof window === "undefined") return null;
    return (
      `${embedUrl}&enablejsapi=1` +
      `&origin=${encodeURIComponent(window.location.origin)}`
    );
  }, [embedUrl, playing]);

  useEffect(() => {
    if (!src) return;
    const iframeOrigin = new URL(src).origin;
    let duration = 0;
    const finish = () => {
      setPlaying(false);
      setWatched(true);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      let data: { event?: string; info?: unknown };
      try {
        data =
          typeof event.data === "string"
            ? JSON.parse(event.data)
            : (event.data as { event?: string; info?: unknown });
      } catch {
        return;
      }
      if (data.event === "onStateChange" && data.info === 0) {
        finish();
        return;
      }
      if (data.event !== "infoDelivery" || !data.info) return;
      const info = data.info as { currentTime?: unknown; duration?: unknown };
      if (typeof info.duration === "number") duration = info.duration;
      if (
        duration > 0 &&
        typeof info.currentTime === "number" &&
        info.currentTime >= duration - 0.1
      ) {
        finish();
      }
    };
    const command = (func: string) => {
      iframeRef.current?.contentWindow?.postMessage(
        JSON.stringify({ event: "command", func, args: [] }),
        iframeOrigin,
      );
    };

    window.addEventListener("message", onMessage);
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ event: "listening" }),
      iframeOrigin,
    );
    const timer = window.setInterval(() => {
      command("getDuration");
      command("getCurrentTime");
    }, 100);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
    };
  }, [src]);

  return (
    <Box position="relative" w="full" h="full" bg="#202020">
      {src ? (
        <iframe
          ref={iframeRef}
          title={title}
          src={src}
          width="100%"
          height="100%"
          sandbox="allow-presentation allow-same-origin allow-scripts"
          allow="encrypted-media; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          style={{ border: 0, display: "block" }}
        />
      ) : (
        <Button
          type="button"
          aria-label={watched ? "Watch the video again" : "Play video"}
          onClick={() => setPlaying(true)}
          position="absolute"
          inset={0}
          w="full"
          h="full"
          borderRadius={0}
          bg="#202020"
          color="white"
          display="flex"
          flexDirection="column"
          gap={3}
          _hover={{ bg: "#292929" }}
        >
          <Box
            w="64px"
            h="64px"
            borderRadius="full"
            borderWidth="2px"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Play weight="fill" size={28} />
          </Box>
          <Text fontWeight="700">{watched ? "Watch again" : "Tap to play"}</Text>
        </Button>
      )}
    </Box>
  );
}

function resourceDetail(resource: ResourceShare): string | null {
  if (resource.kind === "file") return resource.fileName;
  return resource.kind === "video" ? "Video" : "Website";
}

function ResourceIcon({
  resource,
  size,
}: {
  resource: ResourceShare;
  size: number;
}) {
  if (resource.kind === "link") return <LinkIcon size={size} />;
  if (resource.kind === "video") return <Video size={size} />;
  if (resource.mimeType === "application/pdf") return <FilePdf size={size} />;
  if (resource.mimeType?.startsWith("image/")) return <ImageIcon size={size} />;
  return <File size={size} />;
}
