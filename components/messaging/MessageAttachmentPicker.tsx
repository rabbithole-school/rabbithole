"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Menu,
  Portal,
  Spinner,
  Text,
} from "@chakra-ui/react";
import {
  Camera,
  Folder,
  Paperclip,
  Plus,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CameraCaptureDialog } from "@/components/CameraCaptureDialog";
import { COMPOSER_ATTACH_TRIGGER_STYLE } from "@/components/ui/composerAttachTrigger";
import { uploadMessageAttachment } from "@/lib/uploadMessageAttachment";
import {
  MESSAGE_ATTACHMENT_ACCEPT,
  validateMessageAttachmentSelection,
  type MessageAttachment,
} from "@/shared/messageAttachments";

export type PendingFamilyMessageAttachment =
  MessageAttachment<Id<"_storage">> & {
    attachmentId: Id<"parentMessageAttachments">;
  };

export function useFamilyMessageAttachments() {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const registerUpload = useMutation(
    api.parentMessages.registerAttachmentUpload,
  );
  const discardUpload = useMutation(
    api.parentMessages.discardAttachmentUpload,
  );
  const registerPortfolioAttachment = useMutation(
    api.parentMessages.registerPortfolioAttachment,
  );
  const [attachments, setAttachments] = useState<
    PendingFamilyMessageAttachment[]
  >([]);
  const pendingRef = useRef<PendingFamilyMessageAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  const addFiles = useCallback(
    async (selected: FileList | File[] | null) => {
      const files = selected ? Array.from(selected) : [];
      if (files.length === 0 || uploading) return;
      const validationError = validateMessageAttachmentSelection(
        attachments.length,
        files,
        attachments.reduce(
          (total, attachment) => total + (attachment.sizeBytes ?? 0),
          0,
        ),
      );
      if (validationError) {
        setError(validationError);
        return;
      }

      setUploading(true);
      setError("");
      try {
        for (const file of files) {
          const upload = await uploadMessageAttachment<Id<"_storage">>(
            file,
            generateUploadUrl,
          );
          const { attachmentId } = await registerUpload(upload);
          setAttachments((current) => {
            const next = [...current, { ...upload, attachmentId }];
            pendingRef.current = next;
            return next;
          });
        }
      } catch (uploadError) {
        setError(
          uploadError instanceof Error
            ? uploadError.message
            : "The attachment could not be uploaded.",
        );
      } finally {
        setUploading(false);
      }
    },
    [attachments, generateUploadUrl, registerUpload, uploading],
  );

  const remove = useCallback(
    async (attachmentId: Id<"parentMessageAttachments">) => {
      try {
        await discardUpload({ attachmentId });
        setAttachments((current) => {
          const next = current.filter(
            (attachment) => attachment.attachmentId !== attachmentId,
          );
          pendingRef.current = next;
          return next;
        });
        setError("");
      } catch (discardError) {
        setError(
          discardError instanceof Error
            ? discardError.message
            : "The attachment could not be removed.",
        );
      }
    },
    [discardUpload],
  );

  const addPortfolioItem = useCallback(
    async (
      portfolioItemId: Id<"portfolioItems">,
      scholarId: Id<"users">,
    ) => {
      if (uploading) return;
      setUploading(true);
      setError("");
      try {
        const attachment = await registerPortfolioAttachment({
          portfolioItemId,
          scholarId,
        });
        setAttachments((current) => {
          const next = [...current, attachment];
          pendingRef.current = next;
          return next;
        });
      } catch (attachmentError) {
        setError(
          attachmentError instanceof Error
            ? attachmentError.message
            : "The portfolio item could not be attached.",
        );
      } finally {
        setUploading(false);
      }
    },
    [registerPortfolioAttachment, uploading],
  );

  const discardAll = useCallback(async () => {
    const pending = pendingRef.current;
    pendingRef.current = [];
    setAttachments([]);
    await Promise.allSettled(
      pending.map((attachment) =>
        discardUpload({ attachmentId: attachment.attachmentId }),
      ),
    );
  }, [discardUpload]);

  const clearClaimed = useCallback(() => {
    pendingRef.current = [];
    setAttachments([]);
    setError("");
  }, []);

  useEffect(
    () => () => {
      const pending = pendingRef.current;
      pendingRef.current = [];
      void Promise.allSettled(
        pending.map((attachment) =>
          discardUpload({ attachmentId: attachment.attachmentId }),
        ),
      );
    },
    [discardUpload],
  );

  return {
    attachments,
    attachmentIds: attachments.map(
      (attachment) => attachment.attachmentId,
    ),
    uploading,
    error,
    addFiles,
    addPortfolioItem,
    remove,
    discardAll,
    clearClaimed,
  };
}

export function MessageAttachmentPicker({
  attachments,
  uploading,
  error,
  disabled,
  onAddFiles,
  portfolioScholarId,
  onAddPortfolioItem,
  onRemove,
  children,
}: {
  attachments: PendingFamilyMessageAttachment[];
  uploading: boolean;
  error: string;
  disabled?: boolean;
  onAddFiles: (files: FileList | File[] | null) => void;
  portfolioScholarId?: Id<"users">;
  onAddPortfolioItem?: (
    item: {
      _id: Id<"portfolioItems">;
      title: string;
      fileMimeType?: string;
      fileSizeBytes?: number;
    },
  ) => void;
  onRemove: (attachmentId: Id<"parentMessageAttachments">) => void;
  children: ReactNode;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [showPortfolio, setShowPortfolio] = useState(false);
  const portfolioItems = useQuery(
    api.portfolio.listForScholar,
    portfolioScholarId ? { scholarId: portfolioScholarId } : "skip",
  );
  const eligiblePortfolioItems =
    portfolioItems?.filter(
      (item) => item.hasFile && item.processingStatus === "ready",
    ) ?? [];

  return (
    <Flex direction="column" align="stretch" gap={2}>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={MESSAGE_ATTACHMENT_ACCEPT}
        hidden
        onChange={(event) => {
          onAddFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <CameraCaptureDialog
        open={showCamera}
        onClose={() => setShowCamera(false)}
        onCapture={(file) => onAddFiles([file])}
        overlayPosition="fixed"
      />
      <HStack gap={2} align="flex-end">
        <Menu.Root positioning={{ placement: "top-start" }}>
          <Menu.Trigger asChild>
            <IconButton
              aria-label={
                uploading ? "Adding photos or files" : "Add photos or files"
              }
              title="Add photos or files"
              type="button"
              size="sm"
              flexShrink={0}
              {...COMPOSER_ATTACH_TRIGGER_STYLE}
              disabled={disabled || uploading}
            >
              {uploading ? <Spinner size="xs" /> : <Plus weight="bold" />}
            </IconButton>
          </Menu.Trigger>
          <Portal>
            <Menu.Positioner>
              <Menu.Content minW="180px">
                <Menu.Item
                  value="camera"
                  cursor="pointer"
                  onClick={() => setShowCamera(true)}
                >
                  <Camera />
                  Take photo
                </Menu.Item>
                <Menu.Item
                  value="upload"
                  cursor="pointer"
                  onClick={() => inputRef.current?.click()}
                >
                  <UploadSimple />
                  Choose photos or files
                </Menu.Item>
                {portfolioScholarId && onAddPortfolioItem ? (
                  <Menu.Item
                    value="portfolio"
                    cursor="pointer"
                    onClick={() => setShowPortfolio(true)}
                  >
                    <Folder />
                    Choose from portfolio
                  </Menu.Item>
                ) : null}
              </Menu.Content>
            </Menu.Positioner>
          </Portal>
        </Menu.Root>
        {children}
      </HStack>
      <Dialog.Root
        open={showPortfolio}
        onOpenChange={(details) => setShowPortfolio(details.open)}
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="lg">
              <Dialog.Header>
                <Dialog.Title>Choose from portfolio</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body>
                {portfolioItems === undefined ? (
                  <Spinner size="sm" />
                ) : eligiblePortfolioItems.length === 0 ? (
                  <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                    No ready portfolio files are available for this scholar.
                  </Text>
                ) : (
                  <Flex direction="column" gap={2}>
                    {eligiblePortfolioItems.map((item) => (
                      <Box
                        asChild
                        key={item._id}
                        textAlign="left"
                        borderWidth="1px"
                        borderColor="gray.200"
                        borderRadius="md"
                        px={3}
                        py={2}
                        _hover={{ bg: "gray.50", borderColor: "gray.300" }}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            onAddPortfolioItem?.(item);
                            setShowPortfolio(false);
                          }}
                        >
                          <Text fontFamily="heading" fontSize="sm" fontWeight="700">
                            {item.title}
                          </Text>
                          <Text fontFamily="body" fontSize="xs" color="charcoal.500">
                            {item.fileMimeType ?? "File"}
                          </Text>
                        </button>
                      </Box>
                    ))}
                  </Flex>
                )}
              </Dialog.Body>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
      {attachments.length > 0 ? (
        <Flex gap={2} wrap="wrap" align="center">
          {attachments.map((attachment) => (
            <Flex
              key={attachment.attachmentId}
              align="center"
              gap={1.5}
              borderWidth="1px"
              borderColor="gray.300"
              borderRadius="lg"
              bg="white"
              pl={2.5}
              pr={1}
              py={1}
              maxW="240px"
            >
              <Paperclip
                size={14}
                weight="bold"
                color="var(--chakra-colors-charcoal-400)"
              />
              <Text
                fontFamily="body"
                fontSize="xs"
                color="charcoal.600"
                truncate
                title={attachment.fileName}
              >
                {attachment.fileName}
              </Text>
              <IconButton
                aria-label={`Remove ${attachment.fileName}`}
                size="2xs"
                variant="ghost"
                color="charcoal.300"
                disabled={disabled}
                onClick={() => onRemove(attachment.attachmentId)}
              >
                <X size={12} weight="bold" />
              </IconButton>
            </Flex>
          ))}
        </Flex>
      ) : null}
      {error ? (
        <Text fontFamily="body" fontSize="xs" color="red.600">
          {error}
        </Text>
      ) : null}
    </Flex>
  );
}
