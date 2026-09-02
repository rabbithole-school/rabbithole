"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Button, HStack, Image, Spinner, Text, Textarea, VStack } from "@chakra-ui/react";
import { File, PaperPlaneRight } from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";
import { GuardianFacepile } from "./GuardianFacepile";
import { MessageBody } from "./MessageBody";
import {
  MessageAttachmentPicker,
  useFamilyMessageAttachments,
} from "./MessageAttachmentPicker";

/**
 * Shared teacher↔parent thread view. Used by BOTH the parent portal and the
 * teacher Messages panel. `surface` is explicit because staff can also be
 * guardians: /parent must act as the parent participant, while /teacher stays
 * staff. Marks the thread read on open.
 */
type ThreadSurface = "parent" | "staff";

function hasPortfolioScholarId(
  value: unknown,
): value is { scholarId: Id<"users"> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "scholarId" in value &&
    typeof value.scholarId === "string"
  );
}

async function downloadAttachment(url: string, fileName: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  } catch (error) {
    console.error("Attachment download failed", error);
    toaster.create({
      title: "Couldn't download the attachment",
      description: "Please try again.",
      type: "error",
    });
  }
}

export function MessageThread({
  threadId,
  surface,
}: {
  threadId: Id<"parentThreads">;
  surface?: ThreadSurface;
}) {
  const thread = useQuery(
    api.parentMessages.getThread,
    surface ? { threadId, as: surface } : { threadId },
  );
  const threadAttachments = useQuery(
    api.parentMessages.getThreadAttachments,
    surface ? { threadId, as: surface } : { threadId },
  );
  const reply = useMutation(api.parentMessages.replyInThread);
  const markRead = useMutation(api.parentMessages.markThreadRead);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const attachmentState = useFamilyMessageAttachments();
  const endRef = useRef<HTMLDivElement>(null);

  const msgCount = thread?.messages.length ?? 0;

  useEffect(() => {
    markRead(surface ? { threadId, as: surface } : { threadId }).catch(() => {});
  }, [threadId, surface, markRead, msgCount]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgCount]);

  if (thread === undefined) {
    return (
      <HStack justify="center" py={10}>
        <Spinner size="sm" color="violet.400" />
      </HStack>
    );
  }
  if (thread === null) {
    return (
      <Text fontFamily="body" color="charcoal.300" p={4}>
        This conversation is no longer available.
      </Text>
    );
  }
  const portfolioScholarId =
    surface === "staff" &&
    thread.viewer === "teacher" &&
    hasPortfolioScholarId(thread)
      ? thread.scholarId
      : undefined;

  const send = async () => {
    const body = draft.trim();
    if (
      (!body && attachmentState.attachmentIds.length === 0) ||
      busy ||
      attachmentState.uploading
    ) {
      return;
    }
    setBusy(true);
    try {
      await reply({
        threadId,
        body,
        attachmentIds: attachmentState.attachmentIds,
        ...(surface ? { as: surface } : {}),
      });
      setDraft("");
      attachmentState.clearClaimed();
    } catch (e) {
      console.error("reply failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack align="stretch" gap={0} h="100%">
      {surface === "staff" && (
        <HStack
          gap={2}
          px={4}
          pt={4}
          pb={3}
          borderBottomWidth="1px"
          borderColor="gray.100"
        >
          {thread.viewer === "teacher" && <GuardianFacepile guardians={thread.guardians} />}
          <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm" truncate>
            {thread.parentName}
          </Text>
          {thread.scholarName && (
            <Text fontFamily="body" color="charcoal.400" fontSize="xs" truncate>
              about {thread.scholarName}
            </Text>
          )}
        </HStack>
      )}
      <VStack align="stretch" gap={3} flex={1} overflowY="auto" px={4} py={3}>
        {thread.messages.length === 0 && (
          <Text fontFamily="body" fontSize="sm" color="charcoal.300" textAlign="center" py={8}>
            No messages yet.
          </Text>
        )}
        {thread.messages.map((m) => {
          const mine =
            (thread.viewer === "parent" && m.authorType === "parent") ||
            (thread.viewer === "teacher" && m.authorType === "teacher");
          const attachments =
            threadAttachments?.filter(
              (attachment) => attachment.messageId === m._id,
            ) ?? [];
          return (
            <HStack
              key={m._id}
              justify={mine ? "flex-end" : "flex-start"}
              align="flex-end"
              gap={2}
            >
              <VStack
                align={mine ? "flex-end" : "flex-start"}
                gap={1}
                maxW="78%"
              >
                {!mine && (
                  <Text
                    fontFamily="heading"
                    fontSize="2xs"
                    fontWeight="700"
                    color="charcoal.400"
                   px={1}
                  >
                    {labelFor(thread.viewer, m.authorType, m.authorName)}
                  </Text>
                )}
                {m.body ? (
                  <MessageBody
                   body={m.body}
                   mine={mine}
                   messageId={m._id}
                   surface={surface}
                   source={m.source}
                  />
                ) : null}
                {attachments.map((attachment) => {
                  if (!attachment.url) return null;
                  if (attachment.mimeType.startsWith("image/")) {
                   return (
                     <Box
                       key={attachment._id}
                       asChild
                       display="block"
                       maxW="100%"
                       bg="white"
                       borderWidth="1px"
                       borderColor="gray.200"
                       borderRadius="2xl"
                       overflow="hidden"
                       cursor="pointer"
                       _hover={{ borderColor: "gray.300" }}
                     >
                       <button
                         type="button"
                         aria-label={`Download ${attachment.fileName}`}
                         onClick={() =>
                           void downloadAttachment(
                             attachment.url!,
                             attachment.fileName,
                           )
                         }
                       >
                          <Image
                            src={attachment.url}
                            alt={attachment.fileName}
                            maxH="280px"
                            maxW="100%"
                            objectFit="contain"
                            borderRadius="inherit"
                            bg="white"
                          />
                       </button>
                     </Box>
                   );
                  }
                  return (
                    <HStack
                     key={attachment._id}
                     asChild
                     gap={2}
                     bg="white"
                     color="charcoal.700"
                     borderWidth="1px"
                     borderColor="gray.200"
                     borderRadius="2xl"
                     px={3}
                     py={2}
                     cursor="pointer"
                     _hover={{ borderColor: "gray.300", bg: "gray.50" }}
                    >
                     <button
                       type="button"
                       aria-label={`Download ${attachment.fileName}`}
                       onClick={() =>
                         void downloadAttachment(
                           attachment.url!,
                           attachment.fileName,
                         )
                       }
                     >
                       <File size={18} weight="duotone" />
                       <Box minW={0}>
                         <Text
                           fontFamily="heading"
                           fontSize="xs"
                           fontWeight="700"
                           truncate
                         >
                           {attachment.fileName}
                         </Text>
                         <Text
                           fontFamily="body"
                           fontSize="2xs"
                           color="charcoal.400"
                         >
                           {formatFileSize(attachment.sizeBytes)}
                         </Text>
                       </Box>
                     </button>
                    </HStack>
                  );
                })}
              </VStack>
            </HStack>
          );
        })}
        <div ref={endRef} />
      </VStack>

      <Box px={4} pt={2} pb={4} borderTopWidth="1px" borderColor="gray.100">
        <MessageAttachmentPicker
          attachments={attachmentState.attachments}
          uploading={attachmentState.uploading}
          error={attachmentState.error}
          disabled={busy}
          onAddFiles={attachmentState.addFiles}
          portfolioScholarId={portfolioScholarId}
          onAddPortfolioItem={
            portfolioScholarId
              ? (item) =>
                  void attachmentState.addPortfolioItem(
                    item._id,
                    portfolioScholarId,
                  )
              : undefined
          }
          onRemove={attachmentState.remove}
        >
          <Textarea
            flex={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Write a message…"
            rows={1}
            resize="none"
            fontFamily="body"
            fontSize="sm"
            bg="gray.50"
            maxH="120px"
          />
          <Button
            aria-label="Send message"
            onClick={send}
            disabled={
              busy ||
              attachmentState.uploading ||
              (!draft.trim() && attachmentState.attachmentIds.length === 0)
            }
            loading={busy}
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            px={4}
          >
            <PaperPlaneRight weight="fill" />
          </Button>
        </MessageAttachmentPicker>
      </Box>
    </VStack>
  );
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function labelFor(
  viewer: "parent" | "teacher",
  author: "teacher" | "parent",
  authorName: string,
): string {
  if (author === "teacher") return authorName;
  return viewer === "teacher" ? authorName : "You";
}
