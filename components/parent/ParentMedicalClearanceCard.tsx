"use client";

import { useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Heading,
  HStack,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { FirstAid, Printer, Upload } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import {
  HEALTH_DOCUMENT_ACCEPT,
  validateHealthDocumentFile,
} from "@/shared/healthDocuments";

const CLEARANCE_TEMPLATE_HREF = "/print/forms/medical-clearance";

type ClearanceStatus =
  | "open"
  | "pending_review"
  | "needs_replacement"
  | "cleared"
  | "cancelled"
  | "superseded";

type ClearanceRequestView = {
  id: Id<"medicalClearanceRequests">;
  status: ClearanceStatus;
  reason: string;
  requestedAt: number;
  reviewNote: string | null;
  document: {
    fileId: Id<"healthRecordFiles">;
    fileName: string;
    url: string;
  } | null;
};

const STATUS_LINE: Record<
  "open" | "pending_review" | "needs_replacement",
  { label: string; bg: string; color: string; help: string }
> = {
  open: {
    label: "Action needed",
    bg: "yellow.100",
    color: "yellow.900",
    help: "Upload the physician's clearance so your child can return to activity.",
  },
  pending_review: {
    label: "Under review",
    bg: "cyan.100",
    color: "cyan.800",
    help: "Thanks — the school is reviewing the clearance you uploaded.",
  },
  needs_replacement: {
    label: "New document needed",
    bg: "yellow.100",
    color: "yellow.900",
    help: "The school asked for a replacement clearance document.",
  },
};

function ClearanceRequestRow({
  request,
}: {
  request: ClearanceRequestView;
}) {
  const generateUploadUrl = useMutation(
    api.scholarHealthRecords.generateMedicalClearanceUploadUrl,
  );
  const finalizeUpload = useAction(
    api.scholarHealthRecords.finalizeHealthDocumentUpload,
  );
  const attachDocument = useMutation(
    api.scholarHealthRecords.attachMedicalClearanceDocument,
  );
  const discardUpload = useMutation(
    api.scholarHealthRecords.discardHealthDocumentUpload,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const canUpload =
    request.status === "open" || request.status === "needs_replacement";
  const line =
    request.status === "open" ||
    request.status === "pending_review" ||
    request.status === "needs_replacement"
      ? STATUS_LINE[request.status]
      : null;

  async function handleFile(file: File) {
    const validationError = validateHealthDocumentFile(file);
    if (validationError) {
      toaster.error({ title: "Document not accepted", description: validationError });
      return;
    }
    let pendingFileId: Id<"healthRecordFiles"> | null = null;
    let uploadCompleted = false;
    setUploading(true);
    try {
      const upload = await generateUploadUrl({ requestId: request.id });
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
      uploadCompleted = true;
      const finalized = await finalizeUpload({
        fileId: upload.fileId,
        storageId,
        fileName: file.name,
      });
      if (!finalized.ok) throw new Error(finalized.error);
      await attachDocument({ requestId: request.id, fileId: upload.fileId });
      toaster.success({ title: "Clearance uploaded" });
    } catch (error) {
      if (pendingFileId && !uploadCompleted) {
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

  return (
    <Box
      p={3}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      bg="gray.50"
    >
      <HStack justify="space-between" gap={2} wrap="wrap" mb={1}>
        <Text fontSize="sm" fontWeight="600" color="charcoal.700">
          {request.reason}
        </Text>
        {line && (
          <Badge bg={line.bg} color={line.color} fontSize="2xs">
            {line.label}
          </Badge>
        )}
      </HStack>
      <Text fontSize="xs" color="charcoal.500" mb={2}>
        Requested {new Date(request.requestedAt).toLocaleDateString()}
        {line ? ` — ${line.help}` : ""}
      </Text>
      {request.status === "needs_replacement" && request.reviewNote && (
        <Text fontSize="xs" color="charcoal.600" mb={2}>
          School note: {request.reviewNote}
        </Text>
      )}

      <HStack gap={2} wrap="wrap">
        {canUpload && (
          <Button size="xs" variant="outline" asChild>
            <a
              href={CLEARANCE_TEMPLATE_HREF}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Printer />
              Clearance template
            </a>
          </Button>
        )}
        {canUpload && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={HEALTH_DOCUMENT_ACCEPT}
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleFile(file);
              }}
            />
            <Button
              size="xs"
              colorPalette="violet"
              loading={uploading}
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              <Upload />
              {request.status === "needs_replacement"
                ? "Upload replacement"
                : "Upload clearance"}
            </Button>
          </>
        )}
        {request.document && (
          <Button size="xs" variant="ghost" asChild>
            <a
              href={request.document.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              View uploaded document
            </a>
          </Button>
        )}
      </HStack>
    </Box>
  );
}

/**
 * Parent-facing medical-clearance card. Intentionally NOT always visible: it
 * renders only while the school has an open clearance request for the scholar
 * (returning from an injury, illness, or procedure). Uploads ride the same
 * pipeline as the annual physician forms.
 */
export function ParentMedicalClearanceCard({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const requests = useQuery(
    api.scholarHealthRecords.listMedicalClearanceRequestsForGuardian,
    { scholarId },
  );

  if (requests === undefined) return <Spinner size="sm" color="violet.400" />;
  if (requests.length === 0) return null;

  return (
    <Box
      as="section"
      bg="white"
      borderWidth="1px"
      borderColor="yellow.200"
      borderRadius="xl"
      p={{ base: 4, md: 5 }}
      aria-labelledby="medical-clearance-heading"
    >
      <Stack gap={3}>
        <HStack gap={3} align="start">
          <Box
            flexShrink={0}
            display="inline-flex"
            p={2}
            bg="yellow.100"
            borderRadius="lg"
            color="yellow.900"
          >
            <FirstAid size={24} weight="duotone" />
          </Box>
          <VStack gap={0.5} align="stretch">
            <Heading
              id="medical-clearance-heading"
              size="sm"
              fontFamily="heading"
              color="navy.500"
            >
              Medical clearance requested
            </Heading>
            <Text fontSize="sm" fontFamily="body" color="charcoal.500">
              The school needs a physician&apos;s clearance before your child returns
              to activity.
            </Text>
          </VStack>
        </HStack>
        <VStack align="stretch" gap={2}>
          {requests.map((request) => (
            <ClearanceRequestRow
              key={request.id}
              request={request as ClearanceRequestView}
            />
          ))}
        </VStack>
      </Stack>
    </Box>
  );
}
