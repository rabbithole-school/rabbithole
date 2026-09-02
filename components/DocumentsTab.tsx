"use client";

import { useState, useEffect } from "react";
import { useQuery, useMutation, useConvex } from "convex/react";
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
  Textarea,
  IconButton,
  Dialog,
  Portal,
} from "@chakra-ui/react";
import {
  Trash,
  FileText,
  NotePencil,
  FileDoc,
  PencilSimple,
  ArrowSquareOut,
  Eye,
  EyeSlash,
  WarningCircle,
  CheckCircle,
  DownloadSimple,
} from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { ProposalDiffModal } from "@/components/ProposalDiffModal";
import { ScholarDocumentUploadModal } from "@/components/ScholarDocumentUploadModal";
import { formatTimeAgo } from "@/lib/relativeTime";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { PRIMARY_INSTITUTION_BRAND } from "@/lib/primaryInstitutionBrand";
import {
  documentKindSpec,
  documentKindUsesExtraction,
} from "@/convex/lib/documentKinds";

/**
 * Phase 2 — per-scholar document upload, redacted summary view, and
 * proposal-approval flow. Teacher/admin-only tab inside ScholarProfile.
 *
 * SAFETY: every field exposed in this component is either metadata or the
 * AI-produced teacher summary + key findings. The raw extractedText is
 * gated behind an explicit "Show extracted text" toggle that logs
 * view_extracted via api.scholarDocuments.logExtractedView. Never render
 * raw text by default.
 */

interface DocumentsTabProps {
  scholarId: string;
  /**
   * The caller's active institution lens. Forwarded to every server call so
   * the merged list and any upload are checked against the same boundary this
   * surface was rendered with.
   */
  institutionScope?: string;
  /** Add intent forwarded from the header "+ Add" menu. */
  openAdd?: "report" | "file" | null;
  onOpenAddConsumed?: () => void;
}

type DocumentKind =
  | "teacher_report"
  | "assessment"
  | "iep"
  | "report_card"
  | "identity_document"
  | "parent_email"
  | "observation"
  | "other";
// Kinds valid for an UPLOAD (the redaction pipeline's sensitive-source list);
// excludes teacher_report, which is only reachable via "Write text".
type DocumentFormat = "text" | "file" | "gdoc";
type ProcessingStatus = "pending" | "extracting" | "redacting" | "ready" | "error";

// Kinds a teacher can choose when WRITING text or LINKING a Google Doc (the
// teacher-authored documents). Uploads keep the full sensitive-source list.
type TextKind = "teacher_report" | "observation" | "other";
const TEXT_KINDS: { value: TextKind; label: string }[] = [
  { value: "teacher_report", label: "Teacher report" },
  { value: "observation", label: "Observation" },
  { value: "other", label: "Other" },
];

const KIND_COLOR: Record<DocumentKind, { bg: string; color: string }> = {
  teacher_report: { bg: "violet.100", color: "violet.700" },
  assessment: { bg: "purple.100", color: "purple.700" },
  iep: { bg: "orange.100", color: "orange.700" },
  report_card: { bg: "blue.100", color: "blue.700" },
  identity_document: { bg: "gray.100", color: "gray.700" },
  parent_email: { bg: "cyan.100", color: "cyan.700" },
  observation: { bg: "green.100", color: "green.700" },
  other: { bg: "gray.100", color: "gray.700" },
};

function documentKindLabel(kind: DocumentKind): string {
  if (kind === "teacher_report") return "Teacher report";
  return documentKindSpec(kind)?.label ?? "Other";
}

/** Leading glyph by how the document was entered. */
function FormatGlyph({ format }: { format: DocumentFormat }) {
  if (format === "text") return <NotePencil color="#a960bc" weight="fill" />;
  if (format === "gdoc") return <FileDoc color="#1a73e8" weight="fill" />;
  return <FileText color="#AD60BF" />;
}

// timeAgo dropped — use formatTimeAgo from lib/relativeTime

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Write / Edit Report Modal (text documents) ─────────────────────

function WriteReportModal({
  scholarId,
  open,
  onClose,
  editDoc,
}: {
  scholarId: string;
  open: boolean;
  onClose: () => void;
  editDoc?: {
    _id: Id<"scholarDocuments">;
    title: string;
    bodyText: string;
    kind: DocumentKind;
  } | null;
}) {
  const createTextReport = useMutation(api.scholarDocuments.createTextReport);
  const updateTextReport = useMutation(api.scholarDocuments.updateTextReport);
  const isEdit = !!editDoc;

  const [kind, setKind] = useState<TextKind>("observation");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    // Reset the form to the editing target (or blank) each time the modal opens.
    /* eslint-disable react-hooks/set-state-in-effect */
    setKind((editDoc?.kind as TextKind) ?? "observation");
    setTitle(editDoc?.title ?? "");
    setBody(editDoc?.bodyText ?? "");
    setError(null);
    setIsSaving(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, editDoc]);

  const handleSubmit = async () => {
    if (!title.trim() || !body.trim()) {
      setError("Add a title and some text.");
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      if (isEdit && editDoc) {
        await updateTextReport({
          documentId: editDoc._id,
          title: title.trim(),
          bodyText: body.trim(),
        });
      } else {
        await createTextReport({
          scholarId: scholarId as Id<"users">,
          kind,
          title: title.trim(),
          bodyText: body.trim(),
        });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && !isSaving && onClose()}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                {isEdit ? "Edit document" : "Write a document"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack gap={3} align="stretch">
                {!isEdit && (
                  <Box>
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      Type
                    </Text>
                    <select
                      value={kind}
                      onChange={(e) => setKind(e.target.value as TextKind)}
                      disabled={isSaving}
                      style={{
                        padding: "6px 8px",
                        borderRadius: "6px",
                        border: "1px solid #e2e8f0",
                        fontSize: "14px",
                        fontFamily: "inherit",
                        width: "100%",
                        background: "#f7fafc",
                      }}
                    >
                      {TEXT_KINDS.map((k) => (
                        <option key={k.value} value={k.value}>
                          {k.label}
                        </option>
                      ))}
                    </select>
                    <Text fontSize="xs" color="charcoal.400" mt={1.5}>
                      Writing a term progress report? Use the <b>Reports</b> tab —
                      it pulls the scholar&apos;s evidence and files the finished
                      report here automatically.
                    </Text>
                  </Box>
                )}
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Title
                  </Text>
                  <Input
                    size="sm"
                    placeholder="e.g. Quarter 2 narrative"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={isSaving}
                    bg="gray.50"
                    fontFamily="heading"
                    autoFocus
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Report
                  </Text>
                  <Textarea
                    size="sm"
                    rows={8}
                    placeholder="Write…"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    disabled={isSaving}
                    bg="gray.50"
                    fontFamily="body"
                  />
                </Box>
                <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                  Shown to you exactly as written. It&apos;s automatically redacted
                  before the tutor sees it, so it&apos;s safe to include scores or
                  sensitive notes.
                </Text>
                {error && (
                  <Text fontSize="sm" color="red.500" fontFamily="body">
                    {error}
                  </Text>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button
                size="sm"
                variant="ghost"
                fontFamily="heading"
                onClick={onClose}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={handleSubmit}
                disabled={isSaving || !title.trim() || !body.trim()}
              >
                {isSaving ? (
                  <>
                    <Spinner size="xs" mr={2} /> Saving…
                  </>
                ) : (
                  "Save"
                )}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ─── Status Pill ────────────────────────────────────────────────────

function StatusPill({ status }: { status: ProcessingStatus }) {
  const color =
    status === "ready"
      ? { bg: "green.100", color: "green.700", label: "Ready" }
      : status === "error"
      ? { bg: "red.100", color: "red.700", label: "Error" }
      : status === "pending"
      ? { bg: "gray.100", color: "gray.600", label: "Queued" }
      : status === "extracting"
      ? { bg: "blue.100", color: "blue.700", label: "Extracting..." }
      : { bg: "violet.100", color: "violet.700", label: "Redacting..." };

  const isSpinning = status === "pending" || status === "extracting" || status === "redacting";

  return (
    <Badge bg={color.bg} color={color.color} fontSize="2xs" fontFamily="heading">
      {isSpinning && <Spinner size="xs" mr={1} />}
      {color.label}
    </Badge>
  );
}

/**
 * Format-aware status indicator for cards + detail headers. A linked Google Doc
 * is always "Linked"; a ready document shows whether its (redacted) notes feed
 * the tutor; otherwise we fall back to the processing StatusPill.
 */
function CardStatus({
  format,
  status,
  feedsTutor,
}: {
  format: DocumentFormat;
  status: ProcessingStatus;
  feedsTutor?: boolean;
}) {
  if (format === "gdoc") {
    return (
      <Badge bg="blue.100" color="blue.700" fontSize="2xs" fontFamily="heading">
        Linked
      </Badge>
    );
  }
  if (status === "ready") {
    return feedsTutor ? (
      <Badge bg="violet.100" color="violet.700" fontSize="2xs" fontFamily="heading">
        Feeds tutor
      </Badge>
    ) : (
      <Badge bg="green.100" color="green.700" fontSize="2xs" fontFamily="heading">
        Ready
      </Badge>
    );
  }
  return <StatusPill status={status} />;
}

// ─── Document Detail (redacted summary + actions) ───────────────────

function DocumentDetail({
  documentId,
  onClose,
  onDeleted,
  onEdit,
}: {
  documentId: Id<"scholarDocuments">;
  onClose: () => void;
  onDeleted: () => void;
  onEdit: (doc: {
    _id: Id<"scholarDocuments">;
    title: string;
    bodyText: string;
    kind: DocumentKind;
  }) => void;
}) {
  const doc = useQuery(api.scholarDocuments.get, { documentId });
  const proposal = useQuery(api.scholarDocumentProposals.getLatestProposal, { documentId });

  const logSummaryView = useMutation(api.scholarDocuments.logSummaryView);
  const logExtractedView = useMutation(api.scholarDocuments.logExtractedView);
  const logDownload = useMutation(api.scholarDocuments.logDownload);
  const generateProposal = useMutation(api.scholarDocumentProposals.generateProposal);
  const removeDocument = useMutation(api.scholarDocuments.deleteDocument);
  const convex = useConvex();

  // The raw extracted text is only useful to platform admins (debugging the
  // extract→redact pipeline); everyone else works from the summary.
  const { user } = useCurrentUser();
  const isPlatformAdmin = isPlatformAdminRole(user?.role as Role | undefined);

  const [showExtracted, setShowExtracted] = useState(false);
  const [extractedText, setExtractedText] = useState<string | null>(null);
  const [isLoadingExtracted] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [isGeneratingProposal, setIsGeneratingProposal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Teachers see the full (score-bearing) summary; fall back to redactedSummary
  // for documents processed before the summary/redacted split.
  const teacherSummary = doc?.summary ?? doc?.redactedSummary ?? null;
  const teacherKeyFindings = doc?.keyFindings ?? [];
  const hasSummary = teacherSummary != null;

  // Fire the view_summary audit entry when the component mounts with a doc
  // whose summary is readable.
  useEffect(() => {
    if (hasSummary) {
      logSummaryView({ documentId }).catch(() => {
        /* non-fatal */
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, hasSummary]);

  const getExtractedText = useQuery(
    api.scholarDocuments.getExtractedText,
    showExtracted ? { documentId } : "skip"
  );

  useEffect(() => {
    if (showExtracted && getExtractedText) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing async query result into local state, paired with logging side-effect
      setExtractedText(getExtractedText.extractedText);
      logExtractedView({ documentId }).catch(() => {
        /* non-fatal */
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showExtracted, getExtractedText?._id]);

  if (!doc) {
    return (
      <Flex justify="center" py={6}>
        <Spinner size="sm" color="violet.500" />
      </Flex>
    );
  }

  const handleGenerateProposal = async () => {
    setIsGeneratingProposal(true);
    try {
      await generateProposal({ documentId });
    } catch (err) {
      console.error("generateProposal failed:", err);
    } finally {
      setIsGeneratingProposal(false);
    }
  };

  const handleDelete = async () => {
    try {
      await removeDocument({ documentId });
      setShowDeleteConfirm(false);
      onDeleted();
    } catch (err) {
      console.error("deleteDocument failed:", err);
    }
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const url = await convex.query(api.scholarDocuments.getDownloadUrl, {
        documentId,
      });
      if (!url) return; // file purged by retention policy / missing
      // Record the download in the per-document audit trail before opening.
      logDownload({ documentId }).catch(() => {
        /* non-fatal */
      });
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("getDownloadUrl failed:", err);
    } finally {
      setIsDownloading(false);
    }
  };

  const isReady = doc.processingStatus === "ready";
  const usesExtraction = documentKindUsesExtraction(doc.kind);
  const hasProposal = proposal != null;
  const format = (doc.format ?? "file") as DocumentFormat;
  const hasFile = doc.fileStorageId != null;

  return (
    <Box bg="white" borderRadius="lg" p={4} shadow="sm" borderWidth="1px" borderColor="violet.400">
      <HStack justify="space-between" align="start" mb={2}>
        <VStack align="start" gap={1} flex={1} minW={0}>
          <HStack gap={2}>
            <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="md">
              {doc.title}
            </Text>
            <Badge
              bg={KIND_COLOR[doc.kind].bg}
              color={KIND_COLOR[doc.kind].color}
              fontSize="2xs"
              fontFamily="heading"
            >
              {documentKindLabel(doc.kind)}
            </Badge>
            <StatusPill status={doc.processingStatus} />
          </HStack>
          <Text fontSize="xs" color="charcoal.400" fontFamily="body">
            Added {formatTimeAgo(doc._creationTime)}
            {doc.fileSizeBytes ? ` · ${formatBytes(doc.fileSizeBytes)}` : ""}
          </Text>
        </VStack>
        <IconButton
          aria-label="Close detail"
          size="xs"
          variant="ghost"
          color="charcoal.400"
          onClick={onClose}
        >
          ✕
        </IconButton>
      </HStack>

      {doc.processingError && (
        <Box bg="red.50" borderRadius="md" p={3} my={3}>
          <HStack gap={2} color="red.700">
            <WarningCircle />
            <Text fontSize="sm" fontFamily="body">
              Processing error: {doc.processingError}
            </Text>
          </HStack>
        </Box>
      )}

      {/* Text reports: show the teacher's words verbatim (source of truth). */}
      {format === "text" && doc.bodyText && (
        <Box mt={3}>
          <Text
            fontSize="sm"
            color="charcoal.600"
            fontFamily="body"
            lineHeight="1.6"
            whiteSpace="pre-wrap"
          >
            {doc.bodyText}
          </Text>
        </Box>
      )}

      {/* Linked Google Doc: link only — nothing is stored or read by the tutor. */}
      {format === "gdoc" && (
        <Box mt={3} bg="gray.50" borderRadius="md" p={3}>
          <Text fontSize="sm" color="charcoal.500" fontFamily="body">
            Linked Google Doc — opens in Drive. Its contents aren&apos;t stored or
            read by the tutor.
          </Text>
        </Box>
      )}

      {format === "file" && !isReady && doc.processingStatus !== "error" && (
        <Box bg="gray.50" borderRadius="md" p={3} my={3}>
          <HStack gap={2}>
            <Spinner size="sm" color="violet.500" />
            <Text fontSize="sm" color="charcoal.500" fontFamily="body">
              Extracting + redacting document. This usually takes 1–5 minutes for large PDFs.
            </Text>
          </HStack>
        </Box>
      )}

      {format === "file" && isReady && teacherSummary && (
        <Box mt={3}>
          <Text fontSize="xs" fontWeight="600" fontFamily="heading" color="charcoal.500" mb={1}>
            SUMMARY
          </Text>
          <Text
            fontSize="sm"
            color="charcoal.600"
            fontFamily="body"
            lineHeight="1.6"
            whiteSpace="pre-wrap"
          >
            {teacherSummary}
          </Text>
        </Box>
      )}

      {format === "file" && isReady && teacherKeyFindings.length > 0 && (
        <Box mt={4}>
          <Text fontSize="xs" fontWeight="600" fontFamily="heading" color="charcoal.500" mb={1}>
            KEY FINDINGS
          </Text>
          <VStack align="start" gap={1}>
            {teacherKeyFindings.map((f, i) => (
              <HStack key={i} align="start" gap={2}>
                <Text color="violet.500" fontSize="sm">
                  •
                </Text>
                <Text fontSize="sm" color="charcoal.600" fontFamily="body">
                  {f}
                </Text>
              </HStack>
            ))}
          </VStack>
        </Box>
      )}

      {/* Action bar: Delete is always available (so failed/stuck uploads can be
          removed); the proposal + extracted-text actions only apply once the
          document has been successfully processed. */}
      <Box mt={4} pt={3} borderTop="1px solid" borderColor="gray.100">
        <HStack gap={2} wrap="wrap">
          {format === "text" && (
            <Button
              size="sm"
              variant="ghost"
              fontFamily="heading"
              onClick={() =>
                onEdit({
                  _id: doc._id,
                  title: doc.title,
                  bodyText: doc.bodyText ?? "",
                  kind: doc.kind,
                })
              }
            >
              <PencilSimple style={{ display: "inline", marginRight: "4px" }} /> Edit
            </Button>
          )}
          {format === "gdoc" && doc.link && (
            <Button asChild size="sm" variant="ghost" fontFamily="heading">
              <a href={doc.link.url} target="_blank" rel="noopener noreferrer">
                <ArrowSquareOut style={{ display: "inline", marginRight: "4px" }} />{" "}
                Open in Google Docs
              </a>
            </Button>
          )}
          {format === "file" && isReady && usesExtraction &&
            (hasProposal ? (
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={() => setShowDiff(true)}
              >
                <CheckCircle style={{ display: "inline", marginRight: "4px" }} />
                View proposal
                {proposal?.appliedAt ? " (applied)" : ""}
              </Button>
            ) : (
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={handleGenerateProposal}
                disabled={isGeneratingProposal}
              >
                {isGeneratingProposal ? (
                  <>
                    <Spinner size="xs" mr={2} /> Generating...
                  </>
                ) : (
                  "Generate proposal"
                )}
              </Button>
            ))}

          {format === "file" && isReady && hasFile && (
            <Button
              size="sm"
              variant="ghost"
              fontFamily="heading"
              onClick={handleDownload}
              disabled={isDownloading}
            >
              {isDownloading ? (
                <>
                  <Spinner size="xs" mr={2} /> Preparing...
                </>
              ) : (
                <>
                  <DownloadSimple style={{ display: "inline", marginRight: "4px" }} /> Download original
                </>
              )}
            </Button>
          )}

          {format === "file" && isReady && usesExtraction && isPlatformAdmin && (
            <Button
              size="sm"
              variant="ghost"
              fontFamily="heading"
              onClick={() => setShowExtracted((v) => !v)}
            >
              {showExtracted ? (
                <>
                  <EyeSlash style={{ display: "inline", marginRight: "4px" }} /> Hide extracted text
                </>
              ) : (
                <>
                  <Eye style={{ display: "inline", marginRight: "4px" }} /> Show extracted text
                </>
              )}
            </Button>
          )}

          <Button
            size="sm"
            variant="ghost"
            color="red.500"
            fontFamily="heading"
            _hover={{ bg: "red.50" }}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <Trash style={{ display: "inline", marginRight: "4px" }} /> Delete
          </Button>
        </HStack>
      </Box>

      {showExtracted && (
        <Box mt={4} p={3} bg="yellow.50" borderRadius="md" border="1px solid" borderColor="yellow.200">
          <HStack gap={2} mb={2}>
            <WarningCircle color="#975A16" />
            <Text fontSize="xs" fontWeight="600" fontFamily="heading" color="yellow.800">
              FULL EXTRACTED TEXT (audited)
            </Text>
          </HStack>
          {extractedText === null && isLoadingExtracted ? (
            <Spinner size="sm" color="violet.500" />
          ) : (
            <Text
              fontSize="xs"
              color="charcoal.700"
              fontFamily="mono"
              lineHeight="1.5"
              whiteSpace="pre-wrap"
              maxH="300px"
              overflowY="auto"
            >
              {extractedText ?? "(no text extracted)"}
            </Text>
          )}
        </Box>
      )}

      {showDiff && proposal && (
        <ProposalDiffModal
          documentId={documentId}
          scholarId={doc.scholarId}
          proposal={proposal.proposal}
          appliedAt={proposal.appliedAt ?? null}
          rejectedAt={proposal.rejectedAt ?? null}
          onClose={() => setShowDiff(false)}
        />
      )}

      {/* Delete confirmation */}
      <Dialog.Root
        open={showDeleteConfirm}
        onOpenChange={(e) => setShowDeleteConfirm(e.open)}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  Delete Document
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  Delete <strong>{doc.title}</strong>? This removes the stored
                  file and document row. Audit log entries are retained.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button size="sm" variant="ghost" fontFamily="heading" onClick={() => setShowDeleteConfirm(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  onClick={handleDelete}
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

// ─── Document Card (list item) ──────────────────────────────────────

function DocumentCard({
  doc,
  onClick,
}: {
  doc: {
    _id: Id<"scholarDocuments">;
    _creationTime: number;
    kind: DocumentKind;
    format: DocumentFormat;
    title: string;
    bodyText?: string;
    feedsTutor?: boolean;
    processingStatus: ProcessingStatus;
    fileSizeBytes?: number;
  };
  onClick: () => void;
}) {
  return (
    <Box
      bg="white"
      borderRadius="lg"
      p={3}
      shadow="xs"
      cursor="pointer"
      borderWidth="1px"
      borderColor="gray.200"
      _hover={{ borderColor: "violet.400", shadow: "sm" }}
      onClick={onClick}
    >
      <HStack justify="space-between" align="start" mb={1} gap={2}>
        <HStack gap={2} flex={1} minW={0}>
          <FormatGlyph format={doc.format} />
          <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm" truncate>
            {doc.title}
          </Text>
        </HStack>
        <CardStatus
          format={doc.format}
          status={doc.processingStatus}
          feedsTutor={doc.feedsTutor}
        />
      </HStack>
      {doc.format === "text" && doc.bodyText ? (
        <Text
          fontSize="xs"
          color="charcoal.500"
          fontFamily="body"
          lineClamp={2}
          mt={1}
        >
          {doc.bodyText}
        </Text>
      ) : null}
      <HStack gap={2} mt={1}>
        <Badge
          bg={KIND_COLOR[doc.kind].bg}
          color={KIND_COLOR[doc.kind].color}
          fontSize="2xs"
          fontFamily="heading"
        >
          {documentKindLabel(doc.kind)}
        </Badge>
        <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
          {formatTimeAgo(doc._creationTime)}
        </Text>
        {doc.fileSizeBytes ? (
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
            {formatBytes(doc.fileSizeBytes)}
          </Text>
        ) : null}
      </HStack>
    </Box>
  );
}

// ─── Health Document Card (list item) ───────────────────────────────

/**
 * A health document is a pointer into the family's signed health record — a
 * different table with no extract/redact pipeline behind it. It deliberately
 * does NOT open `DocumentDetail`: there is no summary to read, no extracted
 * text to reveal, and `scholarDocuments.get` would refuse the id anyway. The
 * only actions are "see what it is" and "download it".
 */
function HealthDocumentCard({
  doc,
}: {
  doc: {
    kind: string;
    label: string;
    fileId: string;
    fileName: string;
    size?: number;
    uploadedAt?: number;
    url: string;
    uploadedByStaff: boolean;
  };
}) {
  return (
    <Box
      bg="white"
      borderRadius="lg"
      p={3}
      shadow="xs"
      borderWidth="1px"
      borderColor="gray.200"
    >
      <HStack justify="space-between" align="start" mb={1} gap={2}>
        <HStack gap={2} flex={1} minW={0}>
          <FileText color="#e05252" />
          <Text
            fontWeight="600"
            fontFamily="heading"
            color="navy.500"
            fontSize="sm"
            truncate
          >
            {doc.fileName}
          </Text>
        </HStack>
        <Button
          asChild
          size="xs"
          variant="ghost"
          color="violet.600"
          fontFamily="heading"
        >
          <a href={doc.url} target="_blank" rel="noopener noreferrer">
            <DownloadSimple style={{ display: "inline", marginRight: "4px" }} />
            Download
          </a>
        </Button>
      </HStack>
      <HStack gap={2} mt={1} flexWrap="wrap">
        <Badge bg="red.50" color="red.600" fontSize="2xs" fontFamily="heading">
          {doc.label}
        </Badge>
        {doc.uploadedByStaff && (
          <Badge
            bg="orange.100"
            color="orange.700"
            fontSize="2xs"
            fontFamily="heading"
          >
            Added by staff
          </Badge>
        )}
        {doc.uploadedAt ? (
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
            {formatTimeAgo(doc.uploadedAt)}
          </Text>
        ) : null}
        {doc.size ? (
          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
            {formatBytes(doc.size)}
          </Text>
        ) : null}
      </HStack>
    </Box>
  );
}

// ─── Main component ─────────────────────────────────────────────────

export function DocumentsTab({
  scholarId,
  institutionScope,
  openAdd = null,
  onOpenAddConsumed,
}: DocumentsTabProps) {
  // One merged list, two stores. What comes back depends on the caller's role:
  // an operations staffer gets the health half only, and `scholarDocuments` is never
  // read on their behalf.
  const staffView = useQuery(api.scholarDocuments.listDocumentsForStaff, {
    scholarId: scholarId as Id<"users">,
    institutionScope,
  });

  const [showUpload, setShowUpload] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [editDoc, setEditDoc] = useState<{
    _id: Id<"scholarDocuments">;
    title: string;
    bodyText: string;
    kind: DocumentKind;
  } | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<Id<"scholarDocuments"> | null>(null);

  // Open the matching modal when the header Add menu dispatches an intent.
  useEffect(() => {
    if (!openAdd) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    if (openAdd === "report") setShowWrite(true);
    else if (openAdd === "file") setShowUpload(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    onOpenAddConsumed?.();
  }, [openAdd, onOpenAddConsumed]);

  if (staffView === undefined) {
    return (
      <Flex justify="center" py={8}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  const {
    canReadScholarDocuments,
    healthDocumentsVisible,
    healthFormsAvailable,
    healthDocumentsAvailableForRead,
    documents: docs,
    healthDocuments,
  } = staffView;
  const isEmpty = docs.length === 0 && healthDocuments.length === 0;

  if (!canReadScholarDocuments && !healthFormsAvailable) {
    return (
      <VStack gap={4} align="stretch" maxW="800px">
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
          Documents
        </Text>
        <Text fontSize="xs" color="charcoal.400" fontFamily="body">
          Health forms aren&apos;t available for your school yet. These forms are
          specific to {PRIMARY_INSTITUTION_BRAND.schoolName}.
        </Text>
      </VStack>
    );
  }

  return (
    <VStack gap={4} align="stretch" maxW="800px">
      <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
        Documents
      </Text>

      <Text fontSize="xs" color="charcoal.400" fontFamily="body">
        {canReadScholarDocuments && healthDocumentsAvailableForRead ? (
          <>
            Reports, assessments, IEPs, parent notes, and linked docs for this
            scholar, plus anything attached to the family&apos;s health record.
            Uploaded files are extracted and redacted automatically; everything
            the tutor can see is redacted. Health record documents are never
            read by AI. Add one from the{" "}
            <Text as="span" fontWeight="600" color="violet.600">
              + Add
            </Text>{" "}
            menu up top.
          </>
        ) : canReadScholarDocuments ? (
          <>
            Reports, assessments, IEPs, parent notes, and linked docs for this
            scholar. Uploaded files are extracted and redacted automatically;
            everything the tutor can see is redacted. Add one from the{" "}
            <Text as="span" fontWeight="600" color="violet.600">
              + Add
            </Text>{" "}
            menu up top.
          </>
        ) : (
          <>
            Documents attached to the family&apos;s Medical &amp; Emergency
            record. Nothing here is read by AI. Add one from the{" "}
            <Text as="span" fontWeight="600" color="violet.600">
              + Add
            </Text>{" "}
            menu up top.
          </>
        )}
      </Text>

      {/* An empty health half because we couldn't look must never read as an
          empty health half because nothing is on file — on this data that
          misreading is how someone concludes "no immunization record". Two very
          different reasons close the half: a wrong lens (the All institutions
          view can't resolve one school's health data) vs. a capability denial
          (a school-operations staffer has scholar access but no health:manage).
          Say which — telling a correctly-scoped staffer to "switch institutions"
          sends them chasing a scope problem they don't have. */}
      {healthDocumentsAvailableForRead && !healthDocumentsVisible && (
        <Box
          bg="orange.50"
          borderWidth="1px"
          borderColor="orange.200"
          borderRadius="lg"
          px={4}
          py={3}
        >
          <Text fontSize="xs" color="orange.800" fontFamily="body">
            {institutionScope === "all"
              ? "Health record documents aren't shown on the All institutions view. Select this scholar's institution to see whether any are on file."
              : "You don't have access to this scholar's health records."}
          </Text>
        </Box>
      )}

      {isEmpty ? (
        <Box bg="gray.50" borderRadius="lg" p={6}>
          <Text fontSize="sm" color="charcoal.400" fontFamily="body" textAlign="center">
            {healthDocumentsAvailableForRead && healthDocumentsVisible
              ? "No documents yet"
              : "No scholar documents yet"}{" "}
            — use{" "}
            <Text as="span" fontWeight="600" color="violet.600">+ Add</Text> at
            the top to {canReadScholarDocuments ? "write a report or upload a file" : "upload a file"}.
          </Text>
        </Box>
      ) : (
        <VStack gap={2} align="stretch">
          {docs.map((d) =>
            selectedDocId === d._id ? (
              <DocumentDetail
                key={d._id}
                documentId={d._id}
                onClose={() => setSelectedDocId(null)}
                onDeleted={() => setSelectedDocId(null)}
                onEdit={(ed) => {
                  setEditDoc(ed);
                  setSelectedDocId(null);
                }}
              />
            ) : (
              <DocumentCard
                key={d._id}
                doc={d}
                onClick={() => setSelectedDocId(d._id)}
              />
            )
          )}
          {healthDocuments.map((d) => (
            <HealthDocumentCard key={d.fileId} doc={d} />
          ))}
        </VStack>
      )}

      <ScholarDocumentUploadModal
        scholarId={scholarId}
        institutionScope={institutionScope}
        open={showUpload}
        onClose={() => setShowUpload(false)}
      />
      {canReadScholarDocuments && (
        <WriteReportModal
          scholarId={scholarId}
          open={showWrite || editDoc !== null}
          editDoc={editDoc}
          onClose={() => {
            setShowWrite(false);
            setEditDoc(null);
          }}
        />
      )}
    </VStack>
  );
}
