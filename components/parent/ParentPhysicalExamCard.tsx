"use client";

import { useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Heading,
  HStack,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Stethoscope } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { HEALTH_DOCUMENT_ACCEPT } from "@/shared/healthDocuments";
import { FormCompletionBadge } from "./FormCompletionBadge";
import { ParentFormCardShell } from "./ParentFormCardShell";
import { prepareHealthDocumentUpload } from "./healthDocumentUpload";
import { describePhysicalExam } from "./parentPhysicalExamCardState";

/**
 * The physician-completed physical exam, as a standalone card in the parent
 * Forms list — a sibling of the annual participation form and the Cooking Lab
 * waiver, not a step inside the signed health record. The school reviews what
 * the parent uploads, so the card carries a review state the signed forms
 * don't have.
 */
export function ParentPhysicalExamCard({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const exam = useQuery(api.scholarHealthRecords.getPhysicalExamForGuardian, {
    scholarId,
  });
  const generateUploadUrl = useMutation(
    api.scholarHealthRecords.generatePhysicalExamUploadUrl,
  );
  const finalizeUpload = useAction(
    api.scholarHealthRecords.finalizeHealthDocumentUpload,
  );
  const discardUpload = useMutation(
    api.scholarHealthRecords.discardHealthDocumentUpload,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFiles(files: readonly File[]) {
    if (files.length === 0) return;
    let pendingFileId: Id<"healthRecordFiles"> | null = null;
    let uploaded = false;
    setUploading(true);
    try {
      // Merges several photographed pages into one PDF; a physical exam form
      // is very often a handful of phone photos.
      const file = await prepareHealthDocumentUpload(files);
      const upload = await generateUploadUrl({ scholarId });
      pendingFileId = upload.fileId;
      const response = await fetch(upload.uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
      const { storageId } = (await response.json()) as {
        storageId: Id<"_storage">;
      };
      const finalized = await finalizeUpload({
        fileId: upload.fileId,
        storageId,
        fileName: file.name,
      });
      if (!finalized.ok) throw new Error(finalized.error);
      uploaded = true;
      toaster.success({ title: "Document uploaded" });
    } catch (error) {
      if (pendingFileId && !uploaded) {
        await discardUpload({ fileId: pendingFileId }).catch(() => undefined);
      }
      toaster.error({
        title: "Upload failed",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  if (exam === undefined) return <Spinner size="sm" color="violet.400" />;

  const state = describePhysicalExam(exam, (uploadedAt) =>
    new Date(uploadedAt).toLocaleDateString(),
  );

  return (
    <ParentFormCardShell>
      <Stack
        direction={{ base: "column", md: "row" }}
        align={{ base: "stretch", md: "center" }}
        justify="space-between"
        gap={4}
      >
        <HStack gap={3} align="start">
          <Box
            flexShrink={0}
            position="relative"
            p={2}
            borderRadius="lg"
            bg={state.complete ? "green.50" : "bg.subtle"}
            color={state.complete ? "green.700" : "fg.muted"}
          >
            <Stethoscope size={24} weight="duotone" />
            {state.complete && <FormCompletionBadge />}
          </Box>
          <Box>
            <Heading size="sm" color="navy.500">
              Current physical
            </Heading>
            <Text fontSize="sm" color="fg.muted" mt={1}>
              {state.subtitle}
            </Text>
            {state.note && (
              <Text fontSize="sm" color="fg.muted" mt={1}>
                {state.note}
              </Text>
            )}
          </Box>
        </HStack>
        <HStack
          gap={2}
          flexWrap="wrap"
          alignSelf={{ base: "stretch", md: "center" }}
          justify={{ base: "flex-start", md: "flex-end" }}
        >
          {exam?.url && (
            <Button size="sm" variant="ghost" asChild>
              <a href={exam.url} target="_blank" rel="noopener noreferrer">
                View document
              </a>
            </Button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={HEALTH_DOCUMENT_ACCEPT}
            multiple
            hidden
            disabled={uploading}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              void handleFiles(files);
            }}
          />
          <Button
            size="sm"
            variant={state.actionVariant}
            colorPalette="violet"
            loading={uploading}
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            {state.actionLabel}
          </Button>
        </HStack>
      </Stack>
    </ParentFormCardShell>
  );
}
