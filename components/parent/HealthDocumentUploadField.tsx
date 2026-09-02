"use client";

import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  Badge,
  HStack,
  Image,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  Camera,
  FileArrowUp,
  FilePdf,
  ImageSquare,
  Trash,
} from "@phosphor-icons/react";

import type { Id } from "@/convex/_generated/dataModel";
import {
  HEALTH_DOCUMENT_ACCEPT,
  HEALTH_DOCUMENT_CAMERA_ACCEPT,
  HEALTH_DOCUMENT_MAX_IMAGE_PAGES,
  removeHealthDocumentFile,
  selectHealthDocumentFiles,
} from "@/shared/healthDocuments";
import { prepareHealthDocumentUpload } from "./healthDocumentUpload";

export type HealthDocumentInfo = {
  fileId: Id<"healthRecordFiles">;
  fileName: string;
  contentType: "application/pdf" | "image/jpeg" | "image/png";
  size: number;
  uploadedAt: number;
  url?: string;
  reviewStatus?: "accepted" | "needs_replacement" | null;
  reviewNote?: string | null;
};

export type HealthDocumentUploadResult =
  | { ok: true }
  | { ok: false; message: string };

type StagedFile = {
  file: File;
  previewUrl: string | null;
};

function formatFileSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function stagedFiles(files: readonly File[]): StagedFile[] {
  return files.map((file) => ({
    file,
    previewUrl: file.type.startsWith("image/")
      ? URL.createObjectURL(file)
      : null,
  }));
}

function revokePreviews(files: readonly StagedFile[]) {
  for (const item of files) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
}

export function HealthDocumentUploadField({
  inputId,
  label,
  help,
  document,
  uploading,
  busyElsewhere = false,
  onUpload,
  onRemove,
}: {
  inputId: string;
  label: string;
  help: string;
  document: HealthDocumentInfo | null;
  uploading: boolean;
  /**
   * Another document on this step is uploading. A step can show several of
   * these at once (up to three healthcare action plans), and since choosing a
   * file now uploads it with no confirm click, picking the second one while the
   * first is still in flight is the natural motion — so the widgets take turns.
   * Kept separate from `uploading` so a sibling greys out without also claiming
   * to be uploading something.
   */
  busyElsewhere?: boolean;
  onUpload: (file: File) => Promise<HealthDocumentUploadResult>;
  onRemove: () => Promise<void>;
}) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stagedRef = useRef<StagedFile[]>([]);
  const [staged, setStaged] = useState<StagedFile[]>([]);
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const busy = preparing || uploading || busyElsewhere;

  useEffect(
    () => () => {
      revokePreviews(stagedRef.current);
    },
    [],
  );

  const replaceStaged = (files: readonly File[]) => {
    revokePreviews(stagedRef.current);
    const next = stagedFiles(files);
    stagedRef.current = next;
    setStaged(next);
  };

  const uploadSelection = async (
    files: readonly File[] = stagedRef.current.map((item) => item.file),
  ) => {
    setPreparing(true);
    setError(null);
    setStatus("Preparing document for upload.");
    try {
      const file = await prepareHealthDocumentUpload(files);
      const result = await onUpload(file);
      if (!result.ok) {
        setError(result.message);
        setStatus(null);
        return;
      }
      replaceStaged([]);
      setStatus(document ? "Replacement uploaded." : "Document uploaded.");
    } catch (uploadError) {
      setError(
        uploadError instanceof Error
          ? uploadError.message
          : "We couldn't prepare this document. Try again.",
      );
      setStatus(null);
    } finally {
      setPreparing(false);
    }
  };

  const applySelection = async (
    source: "camera" | "file",
    incoming: readonly File[],
  ) => {
    const result = selectHealthDocumentFiles(
      stagedRef.current.map((item) => item.file),
      incoming,
      source,
    );
    if (result.error) {
      setError(result.error);
      setStatus(null);
      return;
    }
    if (!result.changed) return;
    replaceStaged(result.files);
    setError(null);
    if (source === "file") {
      // A file-picker selection is finished the moment the picker closes —
      // there is nothing left for a confirm button to confirm, so send it. The
      // staged panel stays behind only when the upload fails, where its button
      // becomes a retry. Photographed pages are genuinely different: each
      // capture is ONE page, so only the parent knows when the document is
      // complete, and those keep an explicit upload.
      await uploadSelection(result.files);
      return;
    }
    setStatus(
      result.files.length === 1
        ? `${result.files[0].name} added. Take another page or upload.`
        : `${result.files.length} pages added. Take another page or upload.`,
    );
  };

  const removeStaged = (index: number) => {
    const next = removeHealthDocumentFile(
      stagedRef.current.map((item) => item.file),
      index,
    );
    replaceStaged(next);
    setError(null);
    setStatus(
      next.length === 0
        ? "Selection cleared."
        : `${next.length} image page${next.length === 1 ? "" : "s"} ready to upload.`,
    );
  };

  const clearStaged = () => {
    replaceStaged([]);
    setError(null);
    setStatus("Selection cleared.");
  };

  return (
    <Box
      as="section"
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="lg"
      p={{ base: 4, md: 5 }}
      aria-labelledby={`${inputId}-label`}
      aria-busy={busy}
    >
      <Stack gap={4}>
        <Box>
          <Text id={`${inputId}-label`} fontWeight="semibold">
            {label}
          </Text>
          <Text id={`${inputId}-help`} fontSize="sm" color="fg.muted">
            {help}
          </Text>
        </Box>

        {document ? (
          <Stack
            direction={{ base: "column", md: "row" }}
            justify="space-between"
            align={{ base: "stretch", md: "center" }}
            gap={3}
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="md"
            p={3}
          >
            <HStack align="center" gap={3} minW={0}>
              {document.url && document.contentType.startsWith("image/") ? (
                <Image
                  src={document.url}
                  alt={`${label} preview`}
                  boxSize="56px"
                  borderRadius="md"
                  objectFit="cover"
                  flexShrink={0}
                />
              ) : (
                <Box color="fg.muted" flexShrink={0}>
                  <FilePdf size={32} />
                </Box>
              )}
              <Box minW={0}>
                <Text fontSize="sm" fontWeight="medium" wordBreak="break-word">
                  {document.fileName}
                </Text>
                <Text fontSize="xs" color="fg.muted">
                  {formatFileSize(document.size)} · Uploaded{" "}
                  {new Date(document.uploadedAt).toLocaleDateString()}
                </Text>
                {document.reviewStatus === "needs_replacement" ? (
                  <Stack gap={0.5} mt={1}>
                    <Badge colorPalette="red" size="sm" width="fit-content">
                      Needs replacement
                    </Badge>
                    {document.reviewNote && (
                      <Text fontSize="xs" color="fg.error" wordBreak="break-word">
                        {document.reviewNote}
                      </Text>
                    )}
                  </Stack>
                ) : document.reviewStatus === "accepted" ? (
                  <Badge colorPalette="green" size="sm" width="fit-content" mt={1}>
                    Accepted by staff
                  </Badge>
                ) : (
                  <Badge colorPalette="gray" size="sm" width="fit-content" mt={1}>
                    Pending staff review
                  </Badge>
                )}
              </Box>
            </HStack>
            <HStack gap={2} flexWrap="wrap">
              {document.url && (
                <Button size="sm" variant="outline" asChild>
                  <a
                    href={document.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View
                  </a>
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                colorPalette="red"
                disabled={busy}
                onClick={() => void onRemove()}
                aria-label={`Remove ${label.toLowerCase()}`}
              >
                <Trash size={16} />
                Remove
              </Button>
            </HStack>
          </Stack>
        ) : (
          <Text fontSize="sm" color="fg.muted">
            No document uploaded yet.
          </Text>
        )}

        <Stack direction={{ base: "column", sm: "row" }} gap={2}>
          <Button
            variant="outline"
            colorPalette="violet"
            disabled={busy}
            onClick={() => cameraInputRef.current?.click()}
            flex={{ base: "1", sm: "initial" }}
          >
            <Camera size={18} />
            Take a photo
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            flex={{ base: "1", sm: "initial" }}
          >
            <FileArrowUp size={18} />
            Choose a file
          </Button>
        </Stack>
        <input
          ref={cameraInputRef}
          id={`${inputId}-camera`}
          type="file"
          accept={HEALTH_DOCUMENT_CAMERA_ACCEPT}
          capture="environment"
          hidden
          disabled={busy}
          aria-describedby={`${inputId}-help`}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void applySelection("camera", files);
          }}
        />
        <input
          ref={fileInputRef}
          id={`${inputId}-file`}
          type="file"
          accept={HEALTH_DOCUMENT_ACCEPT}
          multiple
          hidden
          disabled={busy}
          aria-describedby={`${inputId}-help`}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            void applySelection("file", files);
          }}
        />
        <Text fontSize="xs" color="fg.muted">
          Choosing a file uploads it straight away — up to{" "}
          {HEALTH_DOCUMENT_MAX_IMAGE_PAGES} JPEG/PNG pages at once, or one PDF.
          Photos upload once you&rsquo;ve taken every page. The finished document
          must be 10 MB or smaller. On browsers without direct camera capture,
          Take a photo opens an image picker instead.
        </Text>

        {staged.length > 0 && (
          <Box
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="md"
            p={3}
          >
            <Stack gap={3}>
              <Text fontSize="sm" fontWeight="semibold">
                {error
                  ? "Not uploaded yet"
                  : document
                    ? "Replacement ready"
                    : "Ready to upload"}
              </Text>
              {staged.map((item, index) => (
                <Stack
                  key={`${item.file.name}-${item.file.lastModified}-${index}`}
                  direction={{ base: "column", sm: "row" }}
                  align={{ base: "stretch", sm: "center" }}
                  justify="space-between"
                  gap={3}
                >
                  <HStack gap={3} minW={0}>
                    {item.previewUrl ? (
                      <Image
                        src={item.previewUrl}
                        alt={`Preview of page ${index + 1}: ${item.file.name}`}
                        boxSize="56px"
                        borderRadius="md"
                        objectFit="cover"
                        flexShrink={0}
                      />
                    ) : item.file.type === "application/pdf" ? (
                      <FilePdf size={32} aria-hidden />
                    ) : (
                      <ImageSquare size={32} aria-hidden />
                    )}
                    <Box minW={0}>
                      <Text
                        fontSize="sm"
                        fontWeight="medium"
                        wordBreak="break-word"
                      >
                        {staged.length > 1 ? `Page ${index + 1}: ` : ""}
                        {item.file.name}
                      </Text>
                      <Text fontSize="xs" color="fg.muted">
                        {formatFileSize(item.file.size)}
                      </Text>
                    </Box>
                  </HStack>
                  <Button
                    size="sm"
                    variant="ghost"
                    colorPalette="red"
                    alignSelf={{ base: "start", sm: "center" }}
                    disabled={busy}
                    onClick={() => removeStaged(index)}
                    aria-label={`Remove ${item.file.name} from upload`}
                  >
                    <Trash size={16} />
                    Remove
                  </Button>
                </Stack>
              ))}
              <HStack gap={2} flexWrap="wrap">
                <Button
                  colorPalette="violet"
                  disabled={busy}
                  loading={preparing || uploading}
                  loadingText={preparing ? "Preparing" : "Uploading"}
                  onClick={() => void uploadSelection()}
                >
                  {preparing || uploading ? (
                    <Spinner size="xs" />
                  ) : (
                    <FileArrowUp size={18} />
                  )}
                  {error
                    ? "Try again"
                    : staged.length > 1
                      ? `Upload ${staged.length} pages`
                      : document
                        ? "Replace document"
                        : "Upload document"}
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={clearStaged}
                >
                  Cancel
                </Button>
              </HStack>
            </Stack>
          </Box>
        )}

        <Box minH="5">
          {error && (
            <Text role="alert" fontSize="sm" color="fg.error">
              {error}
            </Text>
          )}
          {!error && status && (
            <Text aria-live="polite" fontSize="sm" color="fg.muted">
              {status}
            </Text>
          )}
        </Box>
      </Stack>
    </Box>
  );
}
