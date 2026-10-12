"use client";

import { useState } from "react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Image,
  Menu,
  Portal,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import {
  DotsThree,
  File,
  PencilSimple,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { Id } from "@/convex/_generated/dataModel";
import { formatRelative } from "@/lib/relativeTime";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { toaster } from "@/lib/toaster";
import { editWindowOpen } from "@/shared/messageEditWindow";
import { MessageBody } from "./MessageBody";
import { pasteKeepingLinks } from "./pasteKeepingLinks";

type ThreadSurface = "parent" | "staff";

/**
 * The fields a row renders — the shape BOTH `parentMessages.getThread` (family)
 * and `scholarMessages.getThread` (mentor / workshop) return per message, so
 * one row renders every kind of conversation.
 */
export type MessageRowMessage = {
  _id: Id<"parentMessages">;
  authorName: string;
  body: string;
  createdAt: number;
  editedAt: number | null;
  retracted: boolean;
  /** When the viewer's own live message stops being editable (server-derived,
   *  no clock); null when it never was. Checked against the thread's `now`. */
  editableUntil: number | null;
  source?: string | null;
  offPortalDelivered?: readonly string[];
  /** Family: every channel a copy of this message already left through
   *  (email / sms / whatsapp / slack). Supersedes `offPortalDelivered`. */
  copiedChannels?: readonly string[];
  /** Staff viewer only: what a withdrawn message said (the open door —
   *  adults can always see what was said). Null/absent for everyone else. */
  withdrawnOriginal?: string | null;
  /** Own scholar-thread message already copied out (a mentor email, a
   *  Workshop Slack post) — withdrawing can't recall that copy. */
  copiedOutside?: boolean;
};

export type MessageRowAttachment = {
  _id: Id<"parentMessageAttachments">;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string | null;
  /** Server's say on removing this one attachment (scholar threads). */
  canRetract?: boolean;
  /** Staff viewer only: the attachment was removed/withdrawn. */
  withdrawn?: boolean;
};

/** The mutations a row may call. The thread owns them, so the row stays
 *  agnostic of which API family the conversation belongs to. */
export type MessageRowActions = {
  edit: (messageId: Id<"parentMessages">, body: string) => Promise<unknown>;
  retract: (messageId: Id<"parentMessages">) => Promise<unknown>;
  /** Absent → attachments can't be removed on their own. */
  retractAttachment?: (
    attachmentId: Id<"parentMessageAttachments">,
  ) => Promise<unknown>;
};

type Confirm =
  | { kind: "withdraw" }
  | {
      kind: "attachment";
      attachmentId: Id<"parentMessageAttachments">;
      fileName: string;
    }
  | null;

const CHANNEL_LABELS: Record<string, string> = {
  email: "email",
  whatsapp: "WhatsApp",
  sms: "text message",
  slack: "Slack",
};

function joinChannels(channels: readonly string[]): string {
  const labels = channels.map((channel) => CHANNEL_LABELS[channel] ?? channel);
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function MessageRow({
  message,
  mine,
  authorLabel,
  tombstoneLabel,
  attachments,
  actions,
  surface,
  now,
}: {
  message: MessageRowMessage;
  /** Renders on the right in the author's-side bubble. */
  mine: boolean;
  /** Shown above the bubble; null hides it. */
  authorLabel: string | null;
  /** Who a withdrawn message is attributed to. */
  tombstoneLabel: string;
  attachments: MessageRowAttachment[];
  actions: MessageRowActions;
  /** Family surface for link previews; absent for scholar conversations,
   *  whose previews the action authorizes by the message's own thread. */
  surface?: ThreadSurface;
  /** The thread's clock (one per thread, `useNow`). The query never re-runs
   *  when a window closes, so this is what hides Edit/Withdraw. */
  now: number;
}) {
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);

  // Family rows name the channels a copy already left through; scholar
  // threads only know that one did (a mentor email or a Workshop Slack post).
  const copiedChannels =
    message.copiedChannels ?? message.offPortalDelivered ?? [];
  const copiedOutside = message.copiedOutside === true;
  const withdrawnOriginal = message.withdrawnOriginal ?? null;
  // Withdrawing replaces the message with a notice; the original stays
  // visible to staff (the open door), so never promise it's gone for
  // everyone. A copy that already left Rabbithole can't be recalled at all.
  const dialogHonesty =
    copiedChannels.length > 0
      ? `A copy was already sent by ${joinChannels(copiedChannels)} and can't be recalled.`
      : copiedOutside
        ? "A copy already sent by email or Slack can't be recalled."
        : "";
  const editHonesty =
    copiedChannels.length > 0
      ? `Copies already sent by ${joinChannels(copiedChannels)} won't change.`
      : copiedOutside
        ? "Copies already sent by email or Slack won't change."
        : "";

  const editable = editWindowOpen(message.editableUntil, now);
  const canManage = editable && !editing;

  const startEdit = () => {
    setEditDraft(message.body);
    setEditing(true);
  };

  const saveEdit = async () => {
    const body = editDraft.trim();
    if ((!body && attachments.length === 0) || busy) return;
    setBusy(true);
    try {
      await actions.edit(message._id, body);
      setEditing(false);
    } catch (error) {
      console.error("editMessage failed", error);
      // The server is the authority on the edit window: a refusal (the window
      // closed while the editor was open) says why. The draft stays put.
      toaster.create({
        title: "Couldn't save your edit",
        description: serverErrorMessage(error, "Please try again."),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmRetract = async () => {
    if (!confirm || busy) return;
    const target = confirm;
    setBusy(true);
    setConfirm(null);
    try {
      if (target.kind === "withdraw") {
        await actions.retract(message._id);
      } else {
        await actions.retractAttachment?.(target.attachmentId);
      }
    } catch (error) {
      console.error("retract failed", error);
      toaster.create({
        title: "Couldn't complete that",
        description: serverErrorMessage(error, "Please try again."),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  // One stably-mounted dialog per row, rendered in BOTH the live and tombstone
  // branches so a retract arriving from another client can't unmount an open
  // Ark dialog scope (the body-lock leak in engineering-principles.md).
  const confirmDialog = (
      <Dialog.Root
        open={confirm !== null}
        onOpenChange={(details) => {
          if (!details.open) setConfirm(null);
        }}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md">
              <Dialog.Header>
                <Dialog.Title>
                  {confirm?.kind === "attachment"
                    ? "Remove attachment"
                    : "Withdraw message"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                <VStack align="stretch" gap={2}>
                  <Dialog.Description asChild>
                    <Text fontFamily="body" fontSize="sm" color="charcoal.600">
                      {confirm?.kind === "attachment"
                        ? `This removes “${confirm.fileName}” from the conversation. Staff can still see it.`
                        : "This replaces it with “Message withdrawn.” Staff can still see the original."}
                    </Text>
                  </Dialog.Description>
                  {dialogHonesty && (
                    <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                      {dialogHonesty}
                    </Text>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer>
                <Button
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => setConfirm(null)}
                >
                  Cancel
                </Button>
                <Button
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  loading={busy}
                  onClick={confirmRetract}
                >
                  {confirm?.kind === "attachment" ? "Remove" : "Withdraw"}
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
  );

  const renderAttachment = (attachment: MessageRowAttachment) => {
    if (!attachment.url) return null;
    const url = attachment.url;
    const removable =
      !attachment.withdrawn &&
      mine &&
      editable &&
      !editing &&
      attachment.canRetract !== false &&
      actions.retractAttachment !== undefined;
    const remove = removable ? (
      <IconButton
        data-att-remove=""
        aria-label={`Remove attachment ${attachment.fileName}`}
        size="2xs"
        position="absolute"
        top={1}
        right={1}
        bg="white"
        color="charcoal.500"
        borderWidth="1px"
        borderColor="gray.200"
        boxShadow="sm"
        opacity={0}
        transition="opacity 0.15s"
        _hover={{ bg: "gray.50", color: "red.600" }}
        _focusVisible={{ opacity: 1 }}
        onClick={() =>
          setConfirm({
            kind: "attachment",
            attachmentId: attachment._id,
            fileName: attachment.fileName,
          })
        }
      >
        <X size={12} weight="bold" />
      </IconButton>
    ) : null;

    const node = attachment.mimeType.startsWith("image/") ? (
      <Box
        key={attachment._id}
        position="relative"
        maxW="100%"
        css={{
          "&:hover [data-att-remove], &:focus-within [data-att-remove]":
            { opacity: 1 },
        }}
      >
        <Box
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
            onClick={() => void downloadAttachment(url, attachment.fileName)}
          >
            <Image
              src={url}
              alt={attachment.fileName}
              maxH="280px"
              maxW="100%"
              objectFit="contain"
              borderRadius="inherit"
              bg="white"
            />
          </button>
        </Box>
        {remove}
      </Box>
    ) : (
      <Box
        key={attachment._id}
        position="relative"
        maxW="100%"
        css={{
          "&:hover [data-att-remove], &:focus-within [data-att-remove]": {
            opacity: 1,
          },
        }}
      >
        <HStack
          asChild
          gap={2}
          bg="white"
          color="charcoal.700"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="2xl"
          px={3}
          py={2}
          pr={removable ? 8 : 3}
          cursor="pointer"
          _hover={{ borderColor: "gray.300", bg: "gray.50" }}
        >
          <button
            type="button"
            aria-label={`Download ${attachment.fileName}`}
            onClick={() => void downloadAttachment(url, attachment.fileName)}
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
              <Text fontFamily="body" fontSize="2xs" color="charcoal.400">
                {formatFileSize(attachment.sizeBytes)}
              </Text>
            </Box>
          </button>
        </HStack>
        {remove}
      </Box>
    );
    if (!attachment.withdrawn) return node;
    // Staff only (the server never sends a withdrawn file to a scholar or a
    // guardian): kept visible, muted and labelled, like withdrawn text.
    return (
      <VStack
        key={attachment._id}
        align={mine ? "flex-end" : "flex-start"}
        gap={1}
        maxW="100%"
      >
        <Box opacity={0.55}>{node}</Box>
        <Text
          fontFamily="heading"
          fontSize="2xs"
          fontWeight="700"
          color="charcoal.400"
          px={1}
        >
          Withdrawn — only staff see this
        </Text>
      </VStack>
    );
  };

  if (message.retracted) {
    return (
      <HStack justify={mine ? "flex-end" : "flex-start"} align="flex-end">
        <VStack align={mine ? "flex-end" : "flex-start"} gap={0.5} maxW="78%">
          <Text
            fontFamily="heading"
            fontSize="2xs"
            fontWeight="700"
            color="charcoal.400"
            px={1}
          >
            {tombstoneLabel} · {formatRelative(message.createdAt)}
          </Text>
          <Text
            fontFamily="body"
            fontSize="sm"
            fontStyle="italic"
            color="charcoal.300"
            px={1}
          >
            Message withdrawn
          </Text>
          {withdrawnOriginal && (
            <Text
              fontFamily="body"
              fontSize="xs"
              color="charcoal.400"
              bg="gray.50"
              borderWidth="1px"
              borderStyle="dashed"
              borderColor="gray.200"
              borderRadius="lg"
              px={2.5}
              py={1.5}
              whiteSpace="pre-wrap"
            >
              <Text as="span" fontFamily="heading" fontWeight="700">
                Original (only staff see this):{" "}
              </Text>
              {withdrawnOriginal}
            </Text>
          )}
          {attachments.map(renderAttachment)}
        </VStack>
        {confirmDialog}
      </HStack>
    );
  }


  return (
    <HStack
      justify={mine ? "flex-end" : "flex-start"}
      align="flex-end"
      gap={1}
      css={{
        "&:hover [data-message-menu], &:focus-within [data-message-menu]": {
          opacity: 1,
        },
        // Phones have no hover — parents mostly read the portal on one.
        "@media (hover: none)": {
          "& [data-message-menu], & [data-att-remove]": { opacity: 1 },
        },
      }}
    >
      {mine && canManage && (
        <Menu.Root positioning={{ placement: "left-start" }}>
          <Menu.Trigger asChild>
            <IconButton
              data-message-menu=""
              aria-label="Message actions"
              size="xs"
              variant="ghost"
              color="charcoal.400"
              alignSelf="center"
              opacity={0}
              transition="opacity 0.15s"
              _focusVisible={{ opacity: 1 }}
              _open={{ opacity: 1 }}
            >
              <DotsThree size={18} weight="bold" />
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="180px">
                <Menu.Item value="edit" cursor="pointer" onSelect={startEdit}>
                  <PencilSimple />
                  Edit
                </Menu.Item>
                <Menu.Item
                  value="withdraw"
                  cursor="pointer"
                  color="red.600"
                  _hover={{ bg: "red.50" }}
                  onSelect={() => setConfirm({ kind: "withdraw" })}
                >
                  <Trash />
                  Withdraw message
                </Menu.Item>
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
      )}

      <VStack align={mine ? "flex-end" : "flex-start"} gap={1} maxW="78%">
        {authorLabel && (
          <Text
            fontFamily="heading"
            fontSize="2xs"
            fontWeight="700"
            color="charcoal.400"
            px={1}
          >
            {authorLabel}
          </Text>
        )}

        {editing ? (
          <VStack align="stretch" gap={2} w="320px" maxW="100%">
            <Textarea
              aria-label="Edit message"
              value={editDraft}
              onChange={(event) => setEditDraft(event.target.value)}
              onPaste={(event) => pasteKeepingLinks(event, setEditDraft)}
              rows={3}
              autoFocus
              fontFamily="body"
              fontSize="sm"
              bg="white"
              resize="vertical"
            />
            {editHonesty && (
              <Text fontFamily="body" fontSize="2xs" color="charcoal.400">
                {editHonesty}
              </Text>
            )}
            <HStack justify="flex-end" gap={2}>
              <Button
                size="xs"
                variant="ghost"
                fontFamily="heading"
                onClick={() => setEditing(false)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                loading={busy}
                disabled={!editDraft.trim() && attachments.length === 0}
                onClick={saveEdit}
              >
                Save
              </Button>
            </HStack>
          </VStack>
        ) : message.body ? (
          <MessageBody
            body={message.body}
            mine={mine}
            messageId={message._id}
            surface={surface}
            source={message.source}
            edited={message.editedAt !== null}
          />
        ) : message.editedAt !== null ? (
          <Text
            fontFamily="heading"
            fontSize="2xs"
            fontWeight="500"
            color="charcoal.300"
            px={1}
          >
            edited
          </Text>
        ) : null}

        {attachments.map(renderAttachment)}
      </VStack>

      {confirmDialog}
    </HStack>
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

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
