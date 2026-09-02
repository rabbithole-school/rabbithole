"use client";

import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { Box, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { SlackLogo } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  previewableMessageLink,
  tokenizeMessageLinks,
} from "@/lib/messageLinks";
import {
  INITIAL_RETRY_DELAY_MS,
  nextPendingPreviewRetryDelay,
  pendingPreviewRetryDelay,
} from "@/lib/messageLinkPreviewRetry";

type Preview = {
  url: string;
  hostname: string;
  title: string;
  description: string | null;
};

export function MessageBody({
  body,
  mine,
  messageId,
  surface,
  source,
}: {
  body: string;
  mine: boolean;
  messageId: Id<"parentMessages">;
  surface?: "parent" | "staff";
  source?: string | null;
}) {
  const linkColor = mine ? "white" : "navy.600";
  const previewUrl = previewableMessageLink(body);
  const loadPreview = useAction(api.messageLinkPreviews.previewForMessage);
  const [preview, setPreview] = useState<Preview | null | undefined>(undefined);

  useEffect(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = INITIAL_RETRY_DELAY_MS;
    if (!previewUrl) return;

    const load = () => {
      void loadPreview({
        messageId,
        url: previewUrl,
        ...(surface ? { as: surface } : {}),
      })
        .then((result) => {
          if (!active) return;
          if (
            result &&
            "status" in result &&
            result.status === "pending"
          ) {
            retryTimer = setTimeout(
              load,
              pendingPreviewRetryDelay(result.retryAfterMs, retryDelay),
            );
            retryDelay = nextPendingPreviewRetryDelay(retryDelay);
            return;
          }
          setPreview(result && "status" in result ? null : result);
        })
        .catch(() => {
          if (active) setPreview(null);
        });
    };

    load();
    return () => {
      active = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [loadPreview, messageId, previewUrl, surface]);

  const visibleTokens = tokenizeMessageLinks(body).filter(
    (token) => token.type !== "url" || !preview || token.value !== previewUrl,
  );
  const hasVisibleContent = visibleTokens.some((token) => token.value.trim().length > 0);

  return (
    <>
      {hasVisibleContent && (
        <Box
          bg={mine ? "violet.500" : "gray.100"}
          color={mine ? "white" : "charcoal.700"}
          px={3.5}
          py={2.5}
          borderRadius="2xl"
          borderBottomRightRadius={mine ? "sm" : "2xl"}
          borderBottomLeftRadius={mine ? "2xl" : "sm"}
        >
          <Text
            as="div"
            fontFamily="body"
            fontSize="sm"
            lineHeight="1.5"
            whiteSpace="pre-wrap"
          >
            {visibleTokens.map((token, index) =>
              token.type === "url" ? (
                <a
                  key={`${token.value}-${index}`}
                  href={token.value}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                  style={{ color: linkColor, textDecoration: "underline" }}
                >
                  {token.value}
                </a>
              ) : (
                token.value
              ),
            )}
          </Text>
          {previewUrl && preview === undefined && (
            <HStack mt={2} gap={2} color={mine ? "whiteAlpha.700" : "charcoal.400"}>
              <Spinner size="xs" />
              <Text fontFamily="body" fontSize="xs">
                Loading link preview
              </Text>
            </HStack>
          )}
          {source === "slack" && (
            <HStack
              gap={1}
              mt={1}
              justify={mine ? "flex-end" : "flex-start"}
              color={mine ? "whiteAlpha.700" : "charcoal.300"}
            >
              <SlackLogo size={11} weight="fill" />
              <Text as="span" fontFamily="heading" fontSize="2xs" fontWeight="500">
                via Slack
              </Text>
            </HStack>
          )}
        </Box>
      )}
      {preview && <MessageLinkPreview preview={preview} />}
    </>
  );
}

function MessageLinkPreview({ preview }: { preview: Preview }) {
  return (
    <Box
      asChild
      display="block"
      maxW="100%"
    >
      <a
        href={preview.url}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        <VStack
          align="stretch"
          gap={1}
          bg="white"
          color="charcoal.700"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="2xl"
          px={3}
          py={2.5}
          _hover={{ borderColor: "gray.300", bg: "gray.50" }}
        >
          <Text
            fontFamily="heading"
            fontSize="sm"
            fontWeight="700"
            lineClamp={2}
          >
            {preview.title}
          </Text>
          {preview.description && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.500" lineClamp={2}>
              {preview.description}
            </Text>
          )}
          <Text fontFamily="body" fontSize="2xs" color="charcoal.400" truncate>
            {preview.hostname}
          </Text>
        </VStack>
      </a>
    </Box>
  );
}
