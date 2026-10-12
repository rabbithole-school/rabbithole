"use client";

import { useRef, useState } from "react";
import { Box, chakra, Flex, Grid, Text } from "@chakra-ui/react";
import { ArrowSquareOut, FileText, MapTrifold } from "@phosphor-icons/react";
import { formatRelative } from "@/lib/relativeTime";
import {
  ParentPortfolioViewer,
  type ParentPortfolioItem,
} from "@/components/parent/ParentPortfolioViewer";
import {
  formatVideoDuration,
  pageCountForRange,
} from "@/components/parent/parentPortfolioViewerLogic";

/**
 * ONE card for a family-visible piece of work — the single rendering used by
 * the portfolio's flat grid AND by each session inside a course view. A PDF
 * opens in a new tab; everything else opens the shared viewer through
 * `onOpen`, which the surrounding grid owns.
 */
export function ParentPortfolioCard({
  item,
  onOpen,
}: {
  item: ParentPortfolioItem;
  onOpen?: (trigger: HTMLButtonElement) => void;
}) {
  const isPdf = item.kind === "file" && item.fileMimeType === "application/pdf";
  const pageCount = pageCountForRange(
    item.kind === "file" ? item.pageRange : undefined,
  );
  const duration = formatVideoDuration(item.videoDurationMs);
  const thumbUrl = item.thumbUrl ?? item.videoThumbUrl ?? null;
  const viewable = item.kind !== "file" || item.hasFile;

  const content = (
    <>
      {item.kind === "map" && (
        <Flex
          align="center"
          bg="violet.50"
          borderRadius="lg"
          color="violet.600"
          direction="column"
          gap={2}
          h={{ base: "180px", md: "220px" }}
          justify="center"
          mb={3}
        >
          <MapTrifold size={44} weight="duotone" />
          <Text fontFamily="heading" fontSize="sm" fontWeight="600">
            View map
          </Text>
        </Flex>
      )}
      {item.kind === "text" && (
        <Box
          bg="gray.50"
          borderRadius="lg"
          h={{ base: "180px", md: "220px" }}
          mb={3}
          overflow="hidden"
          p={5}
          position="relative"
        >
          <FileText size={24} color="#805AD5" />
          <Text
            color="charcoal.500"
            fontFamily="body"
            fontSize="sm"
            lineClamp={6}
            mt={3}
            whiteSpace="pre-wrap"
          >
            {item.content}
          </Text>
        </Box>
      )}
      {thumbUrl && (
        <Box
          bg="gray.50"
          borderRadius="lg"
          h={{ base: "180px", md: "220px" }}
          mb={3}
          overflow="hidden"
          position="relative"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- Convex signed storage URL is dynamic. */}
          <img
            src={thumbUrl}
            alt=""
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
          {(pageCount !== null || duration !== null) && (
            <Text
              bg="blackAlpha.700"
              borderRadius="full"
              bottom={2}
              color="white"
              fontFamily="heading"
              fontSize="xs"
              left={2}
              lineHeight="1"
              position="absolute"
              px={2.5}
              py={1.5}
            >
              {pageCount !== null
                ? `${pageCount} ${pageCount === 1 ? "page" : "pages"}`
                : duration}
            </Text>
          )}
          {isPdf && item.fileUrl && (
            <Flex
              data-new-tab-hint
              align="center"
              bg="whiteAlpha.900"
              borderRadius="full"
              color="charcoal.700"
              fontFamily="heading"
              fontSize="xs"
              gap={1.5}
              opacity={0}
              position="absolute"
              px={2.5}
              py={1.5}
              right={2}
              top={2}
              transform="translateY(-4px)"
              transition="opacity 120ms ease, transform 120ms ease"
            >
              Open in new tab <ArrowSquareOut weight="bold" />
            </Flex>
          )}
        </Box>
      )}
      <Text
        fontFamily="heading"
        fontWeight="600"
        fontSize="sm"
        color="charcoal.600"
      >
        {item.title}
      </Text>
      {item.attributionCount > 1 && (
        <Text color="violet.600" fontFamily="heading" fontSize="xs" mt={1}>
          Shared work · {item.attributionCount} scholars
        </Text>
      )}
      {item.kind === "file" && item.aiCaption && (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={1}>
          {item.aiCaption}
        </Text>
      )}
      <Text fontFamily="body" fontSize="xs" color="charcoal.300" mt={2}>
        {formatRelative(item._creationTime)}
        {item.activityTitle ? ` · ${item.activityTitle}` : ""}
        {viewable
          ? isPdf
            ? " · Opens in new tab"
            : item.kind === "map"
              ? " · View map"
              : " · View work"
          : ""}
      </Text>
    </>
  );

  const interactionStyles = viewable
    ? {
        borderColor: "violet.300",
        "& [data-new-tab-hint]": {
          opacity: 1,
          transform: "translateY(0)",
        },
      }
    : undefined;

  if (isPdf && item.fileUrl) {
    return (
      <chakra.a
        bg="white"
        borderColor="gray.200"
        borderRadius="xl"
        borderWidth="1px"
        cursor="pointer"
        href={item.fileUrl}
        p={4}
        rel="noopener noreferrer"
        role="group"
        target="_blank"
        textAlign="left"
        _focusVisible={{
          outline: "2px solid",
          outlineColor: "violet.400",
          outlineOffset: "2px",
          ...interactionStyles,
        }}
        _hover={interactionStyles}
      >
        {content}
      </chakra.a>
    );
  }

  return (
    <chakra.button
      bg="white"
      borderColor="gray.200"
      borderRadius="xl"
      borderWidth="1px"
      cursor={viewable ? "pointer" : "default"}
      disabled={!viewable}
      onClick={(event) => {
        if (!viewable) return;
        onOpen?.(event.currentTarget);
      }}
      p={4}
      role="group"
      textAlign="left"
      _hover={interactionStyles}
    >
      {content}
    </chakra.button>
  );
}

/**
 * A grid of work cards plus the viewer they open — the flat portfolio grid
 * and each course session's work use this same block, so a piece of work
 * looks and behaves identically wherever a family meets it.
 */
export function ParentPortfolioItemGrid({
  items,
}: {
  items: ParentPortfolioItem[];
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  const modalItems = items.filter(
    (item) => item.kind !== "file" || item.fileMimeType !== "application/pdf",
  );
  const closeViewer = () => {
    setOpenIndex(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <>
      {openIndex !== null && (
        <ParentPortfolioViewer
          activeIndex={openIndex}
          fileUrl={modalItems[openIndex]?.fileUrl}
          items={modalItems}
          onClose={closeViewer}
          onIndexChange={setOpenIndex}
        />
      )}

      <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap={4}>
        {items.map((item) => (
          <ParentPortfolioCard
            key={item._id}
            item={item}
            onOpen={(trigger) => {
              triggerRef.current = trigger;
              setOpenIndex(
                modalItems.findIndex(
                  (modalItem) => modalItem._id === item._id,
                ),
              );
            }}
          />
        ))}
      </Grid>
    </>
  );
}
