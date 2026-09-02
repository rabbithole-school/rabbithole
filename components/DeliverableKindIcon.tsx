"use client";

import { Box } from "@chakra-ui/react";
import {
  Camera,
  Code,
  FileText,
  MapTrifold,
  Microphone,
  Minus,
  Slideshow,
} from "@phosphor-icons/react";
import type { DeliverableKind } from "@/lib/deliverablePanelContext";

export function DeliverableKindIcon({
  kind,
  size = 18,
  color = "charcoal.400",
}: {
  kind: DeliverableKind | "none";
  size?: number;
  color?: string;
}) {
  const Icon =
    kind === "text"
      ? FileText
      : kind === "artifact"
        ? Code
        : kind === "photo"
          ? Camera
          : kind === "slides"
            ? Slideshow
            : kind === "audio"
              ? Microphone
              : kind === "map"
                ? MapTrifold
              : Minus;

  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      color={color}
      flexShrink={0}
    >
      <Icon size={size} weight="regular" />
    </Box>
  );
}
