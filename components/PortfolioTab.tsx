"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Flex,
  VStack,
  HStack,
  Text,
  Badge,
  Spinner,
  Button,
  Input,
  IconButton,
  Dialog,
  Portal,
  SimpleGrid,
  chakra,
} from "@chakra-ui/react";
import { Plus, Trash, FileText, Upload, ArrowSquareOut, Sparkle } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { formatTimeAgo } from "@/lib/relativeTime";
import { openExternal } from "@/lib/native";

/**
 * Per-scholar portfolio — the scholar's body of WORK (scanned worksheets,
 * drawings, projects). Teacher/admin only, mounted in ScholarProfile's
 * Records tab next to Documents. Most items arrive automatically from the
 * classroom printer via Drive; this tab also supports manual upload.
 */

interface PortfolioTabProps {
  scholarId: string;
}

type ProcessingStatus = "pending" | "extracting" | "matching" | "ready" | "error";

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function StatusPill({ status }: { status: ProcessingStatus }) {
  const map: Record<ProcessingStatus, { bg: string; color: string; label: string }> = {
    ready: { bg: "green.100", color: "green.700", label: "Ready" },
    error: { bg: "red.100", color: "red.700", label: "Error" },
    pending: { bg: "gray.100", color: "gray.600", label: "Queued" },
    extracting: { bg: "blue.100", color: "blue.700", label: "Reading..." },
    matching: { bg: "violet.100", color: "violet.700", label: "Matching..." },
  };
  const c = map[status];
  const spinning = status === "pending" || status === "extracting" || status === "matching";
  return (
    <Badge bg={c.bg} color={c.color} fontSize="2xs" fontFamily="heading">
      {spinning && <Spinner size="xs" mr={1} />}
      {c.label}
    </Badge>
  );
}

// ─── Upload Modal (manual) ──────────────────────────────────────────────

function UploadModal({
  scholarId,
  open,
  onClose,
}: {
  scholarId: string;
  open: boolean;
  onClose: () => void;
}) {
  const generateUploadUrl = useMutation(api.portfolio.generateUploadUrl);
  const registerUpload = useMutation(api.portfolio.registerUpload);

  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle("");
    setFile(null);
    setError(null);
    setIsUploading(false);
  };
  const handleClose = () => {
    if (isUploading) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    if (!file) {
      setError("Please choose a file");
      return;
    }
    setIsUploading(true);
    setError(null);
    try {
      const url = await generateUploadUrl();
      const putRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
      const { storageId } = (await putRes.json()) as { storageId: Id<"_storage"> };
      await registerUpload({
        scholarId: scholarId as Id<"users">,
        title:
          title.trim() ||
          file.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim(),
        fileStorageId: storageId,
        fileMimeType: file.type || undefined,
        fileSizeBytes: file.size,
      });
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && handleClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                Add Portfolio Item
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack gap={3} align="stretch">
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Title
                  </Text>
                  <Input
                    size="sm"
                    placeholder="e.g. Volcano diagram"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={isUploading}
                    bg="gray.50"
                    fontFamily="body"
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    File (PDF or image)
                  </Text>
                  <input
                    type="file"
                    accept="application/pdf,image/*"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    disabled={isUploading}
                    style={{ fontSize: "13px" }}
                  />
                  {file && (
                    <Text fontSize="xs" color="charcoal.400" mt={1}>
                      {file.name} · {formatBytes(file.size)}
                    </Text>
                  )}
                </Box>
                {error && (
                  <Text fontSize="sm" color="red.500" fontFamily="body">
                    {error}
                  </Text>
                )}
                <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                  We&apos;ll auto-caption the work. Most items arrive automatically
                  from the classroom scanner.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button size="sm" variant="ghost" fontFamily="heading" onClick={handleClose} disabled={isUploading}>
                Cancel
              </Button>
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={handleSubmit}
                disabled={isUploading || !file}
              >
                {isUploading ? (
                  <>
                    <Spinner size="xs" mr={2} /> Uploading...
                  </>
                ) : (
                  <>
                    <Upload style={{ display: "inline", marginRight: "4px" }} /> Add
                  </>
                )}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─── Item card ──────────────────────────────────────────────────────────

function PortfolioCard({
  item,
}: {
  item: {
    _id: Id<"portfolioItems">;
    _creationTime: number;
    title: string;
    aiCaption?: string;
    documentHeading?: string;
    label?: string;
    fileMimeType?: string;
    fileSizeBytes?: number;
    processingStatus: ProcessingStatus;
    source:
      | "google_drive"
      | "upload"
      | "photo"
      | "manual"
      | "capture_station";
    pageRange?: { start: number; end: number };
    thumbUrl?: string | null;
    thumbStatus?: "pending" | "ready" | "error";
    hasMagic?: boolean;
    magicInstruction?: string | null;
    magicThumbUrl?: string | null;
  };
}) {
  const removeItem = useMutation(api.portfolio.deleteItem);
  const fileUrl = useQuery(api.portfolio.getFileUrl, { itemId: item._id });
  // Magic Annotations: the full Gemini-redrawn file (for "open"), fetched only
  // when present.
  const magicUrl = useQuery(
    api.portfolio.getMagicFileUrl,
    item.hasMagic ? { itemId: item._id } : "skip"
  );
  // Magic is ON by default: the card previews the redraw, and the badge toggles
  // back to the original.
  const [showMagic, setShowMagic] = useState(true);
  // Inline preview of the magic version: the magic THUMBNAIL, or — for items
  // processed before magic thumbnails existed — the full redraw image, which
  // only renders inline for an IMAGE item (a magic PDF's redraw is a PDF).
  const isImageItem = (item.fileMimeType ?? "").startsWith("image/");
  const magicInlineUrl =
    item.magicThumbUrl ?? (isImageItem ? (magicUrl ?? null) : null);
  const canToggleInline = !!item.hasMagic && !!magicInlineUrl;
  const showingMagic = canToggleInline && showMagic;
  const previewUrl = showingMagic ? magicInlineUrl : item.thumbUrl;
  // When the magic version can't be shown inline (a magic PDF with no
  // thumbnail), the badge OPENS the full magic file instead of toggling — so
  // it's never a dead button. magicUrl is undefined only while it loads.
  const magicOpenUrl = item.hasMagic && !canToggleInline ? (magicUrl ?? null) : null;
  // A thumbnail is still rendering if the file pipeline is done but the thumb
  // hasn't landed yet (covers both images and PDFs).
  const thumbPending =
    item.processingStatus === "ready" &&
    !item.thumbUrl &&
    item.thumbStatus !== "error";
  const [confirming, setConfirming] = useState(false);

  return (
    <Box
      bg="white"
      borderRadius="lg"
      overflow="hidden"
      shadow="xs"
      borderWidth="1px"
      borderColor="gray.200"
      _hover={{ borderColor: "violet.400", shadow: "sm" }}
    >
      {/* Preview */}
      <Box
        h="140px"
        bg="gray.50"
        position="relative"
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt={item.title}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : thumbPending ? (
          <Spinner size="sm" color="violet.400" />
        ) : (
          <FileText size={36} color="#AD60BF" />
        )}
        <Box position="absolute" top={2} left={2}>
          <StatusPill status={item.processingStatus} />
        </Box>
        {item.hasMagic && (() => {
          // Filled violet = the magic version is what you'd see (either shown
          // inline, or one click away to open). Outline = currently showing the
          // original (only possible when an inline toggle exists).
          const filled = showingMagic || !canToggleInline;
          // Enabled when we can toggle, or when the open-url has loaded.
          const enabled = canToggleInline || !!magicOpenUrl;
          return (
            <chakra.button
              type="button"
              onClick={() => {
                if (canToggleInline) setShowMagic((v) => !v);
                else if (magicOpenUrl) openExternal(magicOpenUrl);
              }}
              disabled={!enabled}
              position="absolute"
              top={2}
              right={2}
              display="flex"
              alignItems="center"
              gap={1}
              bg={filled ? "violet.500" : "whiteAlpha.900"}
              color={filled ? "white" : "violet.600"}
              borderWidth="1px"
              borderColor="violet.500"
              borderRadius="full"
              px={2}
              py={0.5}
              cursor={enabled ? "pointer" : "default"}
              _hover={enabled ? { bg: filled ? "violet.600" : "violet.50" } : {}}
              title={
                canToggleInline
                  ? showingMagic
                    ? "Showing the magic version — click to see the original"
                    : "Showing the original — click to see the magic version"
                  : "Open the magic version"
              }
            >
              <Sparkle size={12} weight={filled ? "fill" : "regular"} />
              <Text fontSize="2xs" fontFamily="heading" fontWeight="600">
                {canToggleInline && !showingMagic ? "Original" : "Magic"}
              </Text>
            </chakra.button>
          );
        })()}
      </Box>

      <Box p={3}>
        {/* The work's name — the teacher-assigned label when present, else its
            own printed heading ("Learning Print", "Exit Ticket") — how a
            teacher refers to the item, distinct from the filename/caption-
            derived title below. */}
        {(item.label || item.documentHeading) && (
          <Text
            fontSize="2xs"
            fontWeight="700"
            fontFamily="heading"
            color="charcoal.400"
            textTransform="uppercase"
            letterSpacing="0.05em"
            truncate
          >
            {item.label || item.documentHeading}
          </Text>
        )}
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm" truncate>
          {item.title}
        </Text>
        {item.aiCaption && (
          <Text
            fontSize="xs"
            color="charcoal.500"
            fontFamily="body"
            lineHeight="1.4"
            mt={1}
            lineClamp={2}
          >
            {item.aiCaption}
          </Text>
        )}
        <HStack justify="space-between" mt={2}>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="heading">
            {formatTimeAgo(item._creationTime)}
            {item.source === "google_drive" ? " · scanned" : ""}
            {item.pageRange && item.pageRange.end > item.pageRange.start
              ? ` · ${item.pageRange.end - item.pageRange.start + 1}pp`
              : ""}
          </Text>
          <HStack gap={1}>
            {fileUrl && (
              <IconButton
                aria-label={showingMagic ? "Open magic version" : "Open file"}
                title={showingMagic ? "Open the magic version" : "Open the file"}
                size="2xs"
                variant="ghost"
                color={showingMagic ? "violet.500" : "charcoal.400"}
                _hover={{ bg: showingMagic ? "violet.50" : "gray.100", color: showingMagic ? "violet.600" : "navy.500" }}
                onClick={() =>
                  openExternal(showingMagic && magicUrl ? magicUrl : fileUrl)
                }
              >
                <ArrowSquareOut />
              </IconButton>
            )}
            <IconButton
              aria-label="Delete"
              size="2xs"
              variant="ghost"
              color="red.400"
              _hover={{ bg: "red.50", color: "red.600" }}
              onClick={() => setConfirming(true)}
            >
              <Trash />
            </IconButton>
          </HStack>
        </HStack>
      </Box>

      <Dialog.Root open={confirming} onOpenChange={(e) => setConfirming(e.open)} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  Delete item
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  Delete <strong>{item.title}</strong>? This removes the stored file.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button size="sm" variant="ghost" fontFamily="heading" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  onClick={async () => {
                    await removeItem({ itemId: item._id });
                    setConfirming(false);
                  }}
                >
                  Delete
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}

// ─── Main ───────────────────────────────────────────────────────────────

export function PortfolioTab({ scholarId }: PortfolioTabProps) {
  const items = useQuery(api.portfolio.listForScholar, {
    scholarId: scholarId as Id<"users">,
  });
  const [showUpload, setShowUpload] = useState(false);

  if (items === undefined) {
    return (
      <Flex justify="center" py={8}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  return (
    <VStack gap={4} align="stretch">
      <HStack justify="space-between">
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
          Portfolio
        </Text>
        <Button
          size="xs"
          bg="violet.500"
          color="white"
          _hover={{ bg: "violet.600" }}
          fontFamily="heading"
          onClick={() => setShowUpload(true)}
        >
          <Plus style={{ marginRight: "3px" }} /> Add item
        </Button>
      </HStack>

      {items.length === 0 ? (
        <Box bg="gray.50" borderRadius="lg" p={6}>
          <Text fontSize="sm" color="charcoal.400" fontFamily="body" textAlign="center">
            No portfolio items yet. Scanned work auto-files here once the printer
            drops it in the Drive folder — or add one manually.
          </Text>
        </Box>
      ) : (
        <SimpleGrid columns={{ base: 2, md: 3 }} gap={3}>
          {items.map((item) => (
            <PortfolioCard key={item._id} item={item} />
          ))}
        </SimpleGrid>
      )}

      <UploadModal scholarId={scholarId} open={showUpload} onClose={() => setShowUpload(false)} />
    </VStack>
  );
}
