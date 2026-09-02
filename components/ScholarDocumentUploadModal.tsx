"use client";

import { useMemo, useState } from "react";
import { useMutation, useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  VStack,
  Text,
  Spinner,
  Button,
  Input,
  Dialog,
  Portal,
} from "@chakra-ui/react";
import { Upload } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  DOCUMENT_KIND_GROUPS,
  documentKindSpec,
  visibleUploadKinds,
  type DocumentKindSpec,
} from "@/convex/lib/documentKinds";
import {
  HEALTH_DOCUMENT_ACCEPT,
  validateHealthDocumentFile,
} from "@/shared/healthDocuments";

/**
 * The one upload modal for a scholar's documents, whichever store the chosen
 * kind belongs to.
 *
 * Two groups, two very different destinations. A Scholar Document is filed in
 * `scholarDocuments` and runs the extract/redact pipeline whose output reaches
 * the scholar-facing tutor. A Health Record document is attached to a typed
 * slot on the family's SIGNED health record and has no pipeline at all — a
 * custody document must never be summarized for a child to read. The kind's
 * `store` decides which path runs; the menu itself is built from the same
 * capability map the server gates on, so a role is never offered a kind that
 * would be refused.
 *
 * Health uploads are attach-in-place: only the slot's pointer and its delivery
 * flag change. The guardian's signature, revision and answers are untouched,
 * and an audit entry records who filed what.
 */

function formatBytes(bytes: number | undefined): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const SELECT_STYLE = {
  padding: "6px 8px",
  borderRadius: "6px",
  border: "1px solid #e2e8f0",
  fontSize: "14px",
  fontFamily: "inherit",
  width: "100%",
  background: "#f7fafc",
} as const;

export function ScholarDocumentUploadModal({
  scholarId,
  institutionScope,
  open,
  onClose,
  scholarName,
}: {
  scholarId: string;
  /**
   * The caller's active institution lens, forwarded verbatim to the server so
   * the upload is checked against the same boundary the surface was rendered
   * with. Undefined means "my home institution".
   */
  institutionScope?: string;
  open: boolean;
  onClose: () => void;
  scholarName?: string;
}) {
  const { user } = useCurrentUser();

  const generateUploadUrl = useMutation(api.scholarDocuments.generateUploadUrl);
  const registerUpload = useMutation(api.scholarDocuments.registerUpload);
  const generateHealthUploadUrl = useMutation(
    api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
  );
  const finalizeHealthUpload = useAction(
    api.scholarHealthRecords.finalizeStaffHealthDocumentUpload,
  );

  // Only to know whether the Health Record group is offerable for THIS
  // scholar — a staff upload attaches to a signed record, so without one there
  // is no slot. Same query the Documents tab subscribes to, so it costs
  // nothing extra there.
  const staffView = useQuery(
    api.scholarDocuments.listDocumentsForStaff,
    open ? { scholarId: scholarId as Id<"users">, institutionScope } : "skip",
  );
  const healthFormsAvailable = staffView?.healthFormsAvailable ?? false;
  const kinds = useMemo(
    () =>
      visibleUploadKinds(
        user?.role,
        healthFormsAvailable,
        false,
        user?.hasHealthManagementAccess === true,
      ),
    [user?.role, user?.hasHealthManagementAccess, healthFormsAvailable],
  );
  const healthAvailable = staffView?.canUploadHealthDocuments ?? false;
  // Two of the five health slots only exist when the family's own answers call
  // for them (a healthcare action plan, a support plan). The server decides
  // which are live; offering the rest would file a document the record has
  // nowhere to keep.
  const attachableHealthKinds = useMemo(
    () => new Set<string>(staffView?.attachableHealthKinds ?? []),
    [staffView?.attachableHealthKinds],
  );
  const kindIsAttachable = (candidate: string) =>
    documentKindSpec(candidate)?.store !== "healthRecordFiles" ||
    (healthAvailable && attachableHealthKinds.has(candidate));
  // A non-primary school has no health group at all. For a primary scholar, two
  // different reasons can still close it: the lens cannot resolve the scholar's
  // institution, or no guardian has submitted the form yet.
  const healthBlockedReason =
    staffView === undefined || !healthFormsAvailable || healthAvailable
      ? null
      : staffView.healthDocumentsVisible
        ? "Health record documents need a submitted Medical & Emergency form — ask a guardian to complete it first."
        : "Health record documents aren't available on the All institutions view. Select this scholar's institution first.";

  const [kindChoice, setKindChoice] = useState<string>("");
  const [title, setTitle] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The role (and therefore the menu) arrives asynchronously, so fall back to
  // the first offered kind until the user picks one.
  const selectedKind = kinds.some((candidate) => candidate.kind === kindChoice)
    ? kindChoice
    : "";
  const kind = selectedKind || kinds[0]?.kind || "";
  const spec: DocumentKindSpec | null = documentKindSpec(kind);
  const isHealth = spec?.store === "healthRecordFiles";
  const blockedByMissingRecord = isHealth && !kindIsAttachable(kind);
  // The record has the section, but this particular slot isn't live on it.
  const inactiveSlotReason =
    isHealth && healthAvailable && !attachableHealthKinds.has(kind)
      ? kind === "action_plan_document"
        ? "This record has no healthcare action plan selected, so there is no slot to attach to. Ask the family to update their Medical & Emergency form first."
        : "This record has no support plan selected, so there is no slot to attach to. Ask the family to update their Medical & Emergency form first."
      : null;

  const reset = () => {
    setKindChoice("");
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

  const uploadScholarDocument = async (chosen: File) => {
    const url = await generateUploadUrl();
    const putRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": chosen.type || "application/octet-stream" },
      body: chosen,
    });
    if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
    const { storageId } = (await putRes.json()) as {
      storageId: Id<"_storage">;
    };
    await registerUpload({
      scholarId: scholarId as Id<"users">,
      kind: kind as "assessment" | "iep" | "parent_email" | "observation" | "other",
      title:
        title.trim() ||
        chosen.name
          .replace(/\.[^.]+$/, "")
          .replace(/[_-]+/g, " ")
          .trim(),
      fileStorageId: storageId,
      fileMimeType: chosen.type || undefined,
      fileSizeBytes: chosen.size,
    });
  };

  const uploadHealthDocument = async (chosen: File) => {
    const localError = validateHealthDocumentFile({
      name: chosen.name,
      type: chosen.type,
      size: chosen.size,
    });
    if (localError) throw new Error(localError);
    const ticket = await generateHealthUploadUrl({
      scholarId: scholarId as Id<"users">,
      kind: kind as
        | "medication_authorization"
        | "immunization_record"
        | "custody_document"
        | "action_plan_document"
        | "support_plan_document",
      institutionScope,
    });
    const putRes = await fetch(ticket.uploadUrl, {
      method: "POST",
      headers: { "Content-Type": chosen.type },
      body: chosen,
    });
    if (!putRes.ok) throw new Error(`Upload failed (${putRes.status})`);
    const { storageId } = (await putRes.json()) as {
      storageId: Id<"_storage">;
    };
    const result = await finalizeHealthUpload({
      fileId: ticket.fileId,
      storageId,
      fileName: chosen.name,
      institutionScope,
    });
    if (!result.ok) throw new Error(result.error);
  };

  const handleSubmit = async () => {
    if (!file) {
      setError("Please choose a file to upload");
      return;
    }
    if (!spec) {
      setError("Please choose a document kind");
      return;
    }
    setIsUploading(true);
    setError(null);
    try {
      if (isHealth) await uploadHealthDocument(file);
      else await uploadScholarDocument(file);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsUploading(false);
    }
  };

  const groups = DOCUMENT_KIND_GROUPS.map((group) => ({
    group,
    options: kinds.filter((k) => k.group === group),
  })).filter((g) => g.options.length > 0);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && handleClose()}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                Upload document
              </Dialog.Title>
              {scholarName && (
                <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                  for {scholarName}
                </Text>
              )}
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack gap={3} align="stretch">
                <Box>
                  <Text
                    fontSize="xs"
                    color="charcoal.500"
                    mb={1}
                    fontFamily="heading"
                  >
                    Kind
                  </Text>
                  <select
                    value={kind}
                    onChange={(e) => {
                      setKindChoice(e.target.value);
                      setFile(null);
                      setError(null);
                    }}
                    disabled={isUploading}
                    style={SELECT_STYLE}
                  >
                    {groups.map(({ group, options }) => (
                      <optgroup
                        key={group}
                        label={group}
                        // A health slot only exists once a guardian has
                        // submitted the form, so the whole group greys out
                        // rather than offering an upload with nowhere to land.
                        disabled={
                          group === "Health record" && !healthAvailable
                        }
                      >
                        {options.map((option) => (
                          <option
                            key={option.kind}
                            value={option.kind}
                            disabled={!kindIsAttachable(option.kind)}
                          >
                            {option.label}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {(healthBlockedReason || inactiveSlotReason) &&
                    kinds.some((k) => k.group === "Health record") && (
                      <Text
                        fontSize="xs"
                        color="charcoal.400"
                        mt={1}
                        fontFamily="body"
                      >
                        {healthBlockedReason ?? inactiveSlotReason}
                      </Text>
                    )}
                </Box>

                {!isHealth && (
                  <Box>
                    <Text
                      fontSize="xs"
                      color="charcoal.500"
                      mb={1}
                      fontFamily="heading"
                    >
                      Title
                    </Text>
                    <Input
                      size="sm"
                      placeholder="e.g. Neuropsych eval, Feb 2026"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      disabled={isUploading}
                      bg="gray.50"
                      fontFamily="body"
                    />
                  </Box>
                )}

                <Box>
                  <Text
                    fontSize="xs"
                    color="charcoal.500"
                    mb={1}
                    fontFamily="heading"
                  >
                    {isHealth ? "File (PDF, JPEG, or PNG)" : "File (PDF or image)"}
                  </Text>
                  <input
                    type="file"
                    accept={
                      isHealth ? HEALTH_DOCUMENT_ACCEPT : "application/pdf,image/*"
                    }
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setFile(f);
                      setError(
                        f && isHealth
                          ? validateHealthDocumentFile({
                              name: f.name,
                              type: f.type,
                              size: f.size,
                            })
                          : null,
                      );
                    }}
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
                  {isHealth
                    ? "Filed straight onto the health record — no AI reads it. The family's signed answers and signature are left exactly as they are, and this upload is recorded against your name."
                    : "The file will be extracted and redacted automatically. The redacted summary is what downstream AI sees — the raw text stays teacher-only."}
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button
                size="sm"
                variant="ghost"
                fontFamily="heading"
                onClick={handleClose}
                disabled={isUploading}
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
                disabled={
                  isUploading || !file || !spec || blockedByMissingRecord
                }
              >
                {isUploading ? (
                  <>
                    <Spinner size="xs" mr={2} /> Uploading...
                  </>
                ) : (
                  <>
                    <Upload
                      style={{ display: "inline", marginRight: "4px" }}
                    />{" "}
                    Upload
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
