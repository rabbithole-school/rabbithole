"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Heading,
  HStack,
  IconButton,
  Input,
  Separator,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { FirstAid, Warning, Plus, Trash } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { PRIMARY_INSTITUTION_BRAND } from "@/lib/primaryInstitutionBrand";
import { guardianRelationshipLabel } from "@/shared/guardianRelationships";
import {
  developmentalConditionOptions,
  supportPlanOptions,
} from "@/components/parent/healthFormState";

/**
 * Marks a slot whose document was filed by a staff member rather than attached
 * by the family. The record is parent-SIGNED, so the distinction matters: the
 * guardian attested to their own uploads, and never saw this one. Driven by a
 * flag on the document (recorded at upload time), so nothing here has to guess
 * at the uploader's role after the fact.
 */
function StaffFiledBadge({ document }: { document?: { uploadedByStaff: boolean } | null }) {
  if (!document?.uploadedByStaff) return null;
  return (
    <Badge
      alignSelf="start"
      bg="orange.100"
      color="orange.800"
      fontSize="2xs"
      title="Filed by school staff — not attached by a guardian."
    >
      Added by staff
    </Badge>
  );
}

// The document view shape returned by getHealthRecordForStaff / healthDocumentView.
type ReviewableDocument = {
  fileId: Id<"healthRecordFiles">;
  reviewStatus: "accepted" | "needs_replacement" | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  medicationExpirations: { name: string; expiresAt: number }[];
};

const REVIEW_BADGE: Record<
  "pending" | "accepted" | "needs_replacement",
  { bg: string; color: string; label: string }
> = {
  pending: { bg: "cyan.100", color: "cyan.800", label: "Pending review" },
  accepted: { bg: "green.100", color: "green.800", label: "Accepted" },
  needs_replacement: {
    bg: "yellow.100",
    color: "yellow.900",
    label: "Needs replacement",
  },
};

// Convert a ms timestamp to/from the "YYYY-MM-DD" value a native date input
// wants, anchored to UTC so a stored midnight-UTC expiry round-trips without a
// timezone drifting it to the previous day.
function msToDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function dateInputToMs(value: string): number | null {
  if (!value) return null;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Staff verdict controls for a physician document on the signed record. Accept
 * or ask for a replacement, leave a note, and — for the medication
 * authorization — transcribe the per-medication expiry dates that drive the
 * deterministic expiry alert. Writes through setHealthDocumentReviewStatus.
 */
function DocumentReview({
  document,
  institutionScope,
  isMedication = false,
}: {
  document: ReviewableDocument;
  institutionScope?: string;
  isMedication?: boolean;
}) {
  const setReviewStatus = useMutation(
    api.scholarHealthRecords.setHealthDocumentReviewStatus,
  );
  const [note, setNote] = useState(document.reviewNote ?? "");
  const [expirations, setExpirations] = useState<
    { name: string; date: string }[]
  >(() =>
    document.medicationExpirations.map((e) => ({
      name: e.name,
      date: msToDateInput(e.expiresAt),
    })),
  );
  const [saving, setSaving] = useState<
    "accepted" | "needs_replacement" | "pending" | null
  >(null);

  const current = document.reviewStatus ?? "pending";
  const badge = REVIEW_BADGE[current];

  async function submit(
    reviewStatus: "accepted" | "needs_replacement" | "pending",
  ) {
    setSaving(reviewStatus);
    try {
      const medicationExpirations = isMedication
        ? expirations
            .map((row) => ({
              name: row.name.trim(),
              expiresAt: dateInputToMs(row.date),
            }))
            .filter(
              (row): row is { name: string; expiresAt: number } =>
                row.name.length > 0 && row.expiresAt !== null,
            )
        : undefined;
      await setReviewStatus({
        fileId: document.fileId,
        institutionScope,
        reviewStatus,
        reviewNote: note.trim() || undefined,
        medicationExpirations,
      });
      toaster.success({ title: "Review saved" });
    } catch (error) {
      toaster.error({
        title: "Could not save review",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(null);
    }
  }

  return (
    <Box
      mt={2}
      p={3}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      bg="white"
    >
      <HStack justify="space-between" mb={2} gap={2} wrap="wrap">
        <HStack gap={2}>
          <Text fontSize="xs" fontWeight="semibold" color="charcoal.600">
            Staff review
          </Text>
          <Badge bg={badge.bg} color={badge.color} fontSize="2xs">
            {badge.label}
          </Badge>
        </HStack>
        {document.reviewedAt && (
          <Text fontSize="2xs" color="charcoal.400">
            Reviewed {new Date(document.reviewedAt).toLocaleDateString()}
          </Text>
        )}
      </HStack>

      {isMedication && (
        <Box mb={2}>
          <Text fontSize="xs" fontWeight="semibold" color="charcoal.600" mb={1}>
            Per-medication expiry
          </Text>
          <VStack align="stretch" gap={1}>
            {expirations.map((row, index) => (
              <HStack key={index} gap={2}>
                <Input
                  size="xs"
                  flex={1}
                  placeholder="Medication name"
                  value={row.name}
                  onChange={(e) =>
                    setExpirations((prev) =>
                      prev.map((r, i) =>
                        i === index ? { ...r, name: e.target.value } : r,
                      ),
                    )
                  }
                />
                <Input
                  size="xs"
                  type="date"
                  maxW="150px"
                  value={row.date}
                  onChange={(e) =>
                    setExpirations((prev) =>
                      prev.map((r, i) =>
                        i === index ? { ...r, date: e.target.value } : r,
                      ),
                    )
                  }
                />
                <IconButton
                  size="xs"
                  variant="ghost"
                  aria-label="Remove medication"
                  onClick={() =>
                    setExpirations((prev) => prev.filter((_, i) => i !== index))
                  }
                >
                  <Trash />
                </IconButton>
              </HStack>
            ))}
            <Button
              size="xs"
              variant="ghost"
              alignSelf="start"
              onClick={() =>
                setExpirations((prev) => [...prev, { name: "", date: "" }])
              }
            >
              <Plus style={{ marginRight: 4 }} />
              Add medication
            </Button>
          </VStack>
        </Box>
      )}

      <Textarea
        size="xs"
        placeholder="Review note (optional) — e.g. why a replacement is needed"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        mb={2}
        rows={2}
      />
      <HStack gap={2} wrap="wrap">
        <Button
          size="xs"
          colorPalette="green"
          loading={saving === "accepted"}
          disabled={saving !== null}
          onClick={() => submit("accepted")}
        >
          Accept
        </Button>
        <Button
          size="xs"
          colorPalette="yellow"
          variant="outline"
          loading={saving === "needs_replacement"}
          disabled={saving !== null}
          onClick={() => submit("needs_replacement")}
        >
          Needs replacement
        </Button>
        {current !== "pending" && (
          <Button
            size="xs"
            variant="ghost"
            loading={saving === "pending"}
            disabled={saving !== null}
            onClick={() => submit("pending")}
          >
            Clear
          </Button>
        )}
      </HStack>
    </Box>
  );
}

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
  reviewedAt: number | null;
  resolvedAt: number | null;
  document: {
    fileId: Id<"healthRecordFiles">;
    fileName: string;
    url: string;
    uploadedAt: number;
    uploadedByStaff: boolean;
  } | null;
};

const CLEARANCE_BADGE: Record<
  ClearanceStatus,
  { bg: string; color: string; label: string }
> = {
  open: { bg: "cyan.100", color: "cyan.800", label: "Awaiting document" },
  pending_review: { bg: "cyan.100", color: "cyan.800", label: "Pending review" },
  needs_replacement: {
    bg: "yellow.100",
    color: "yellow.900",
    label: "Needs replacement",
  },
  cleared: { bg: "green.100", color: "green.800", label: "Cleared" },
  cancelled: { bg: "gray.100", color: "gray.600", label: "Cancelled" },
  superseded: { bg: "gray.100", color: "gray.600", label: "Superseded" },
};

const CLEARANCE_ACTIVE: ReadonlySet<ClearanceStatus> = new Set<ClearanceStatus>([
  "open",
  "pending_review",
  "needs_replacement",
]);

/**
 * One clearance request: its status, the attached physician document, and — when
 * there is a document awaiting a verdict — the same accept / needs-replacement
 * controls the annual physician forms use. Staff can withdraw a request that is
 * still active.
 */
function ClearanceRequestCard({
  request,
  institutionScope,
}: {
  request: ClearanceRequestView;
  institutionScope?: string;
}) {
  const reviewClearance = useMutation(
    api.scholarHealthRecords.reviewMedicalClearance,
  );
  const cancelClearance = useMutation(
    api.scholarHealthRecords.cancelMedicalClearance,
  );
  const [note, setNote] = useState(request.reviewNote ?? "");
  const [saving, setSaving] = useState<
    "accepted" | "needs_replacement" | "cancel" | null
  >(null);
  const badge = CLEARANCE_BADGE[request.status];
  const isActive = CLEARANCE_ACTIVE.has(request.status);

  async function review(reviewStatus: "accepted" | "needs_replacement") {
    setSaving(reviewStatus);
    try {
      await reviewClearance({
        requestId: request.id,
        reviewStatus,
        reviewNote: note.trim() || undefined,
        institutionScope,
      });
      toaster.success({ title: "Clearance review saved" });
    } catch (error) {
      toaster.error({
        title: "Could not save review",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(null);
    }
  }

  async function cancel() {
    setSaving("cancel");
    try {
      await cancelClearance({ requestId: request.id, institutionScope });
      toaster.success({ title: "Clearance request withdrawn" });
    } catch (error) {
      toaster.error({
        title: "Could not withdraw request",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(null);
    }
  }

  return (
    <Box p={3} borderWidth="1px" borderColor="gray.200" borderRadius="md" bg="white">
      <HStack justify="space-between" mb={1} gap={2} wrap="wrap">
        <Badge bg={badge.bg} color={badge.color} fontSize="2xs">
          {badge.label}
        </Badge>
        <Text fontSize="2xs" color="charcoal.400">
          Requested {new Date(request.requestedAt).toLocaleDateString()}
        </Text>
      </HStack>
      <Text fontSize="sm" color="charcoal.700" mb={2}>
        {request.reason}
      </Text>

      {request.document && (
        <VStack align="stretch" gap={1} mb={2}>
          <StaffFiledBadge document={request.document} />
          <Button size="xs" variant="outline" alignSelf="start" asChild>
            <a
              href={request.document.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Download clearance document
            </a>
          </Button>
        </VStack>
      )}

      {request.reviewNote && !isActive && (
        <Text fontSize="xs" color="charcoal.500" mb={2}>
          Note: {request.reviewNote}
        </Text>
      )}

      {isActive && (
        <>
          {request.document ? (
            <Textarea
              size="xs"
              placeholder="Review note (optional) — e.g. why a replacement is needed"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              mb={2}
              rows={2}
            />
          ) : (
            <Text fontSize="xs" color="charcoal.400" mb={2}>
              Waiting for the family to upload the physician&apos;s clearance.
            </Text>
          )}
          <HStack gap={2} wrap="wrap">
            {request.document && (
              <>
                <Button
                  size="xs"
                  colorPalette="green"
                  loading={saving === "accepted"}
                  disabled={saving !== null}
                  onClick={() => review("accepted")}
                >
                  Accept &amp; clear
                </Button>
                <Button
                  size="xs"
                  colorPalette="yellow"
                  variant="outline"
                  loading={saving === "needs_replacement"}
                  disabled={saving !== null}
                  onClick={() => review("needs_replacement")}
                >
                  Needs replacement
                </Button>
              </>
            )}
            <Button
              size="xs"
              variant="ghost"
              loading={saving === "cancel"}
              disabled={saving !== null}
              onClick={cancel}
            >
              Withdraw
            </Button>
          </HStack>
        </>
      )}
    </Box>
  );
}

/**
 * Medical-clearance surface on the staff health record. Distinct from the
 * signed-record documents above: a clearance is event-triggered, so staff open a
 * request here (a scholar returns from injury/illness/procedure) and review the
 * physician document the family uploads. Renders regardless of whether a signed
 * annual record exists.
 */
function MedicalClearanceStaffSection({
  scholarId,
  institutionScope,
}: {
  scholarId: Id<"users">;
  institutionScope?: string;
}) {
  const requests = useQuery(
    api.scholarHealthRecords.listMedicalClearanceRequestsForStaff,
    { scholarId, institutionScope },
  );
  const requestClearance = useMutation(
    api.scholarHealthRecords.requestMedicalClearance,
  );
  const [reason, setReason] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const cleaned = reason.trim();
    if (!cleaned) return;
    setSubmitting(true);
    try {
      await requestClearance({ scholarId, reason: cleaned, institutionScope });
      toaster.success({ title: "Medical clearance requested" });
      setReason("");
      setShowForm(false);
    } catch (error) {
      toaster.error({
        title: "Could not request clearance",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  }

  const list = requests ?? [];

  return (
    <InfoSection title="Medical clearance">
      <Text fontSize="xs" color="charcoal.500">
        Request a physician&apos;s clearance when a scholar returns from an injury,
        illness, or procedure. The family uploads the document on their Records
        tab; review it here.
      </Text>

      {list.length > 0 && (
        <VStack align="stretch" gap={2} mt={1}>
          {list.map((request) => (
            <ClearanceRequestCard
              key={request.id}
              request={request as ClearanceRequestView}
              institutionScope={institutionScope}
            />
          ))}
        </VStack>
      )}

      {showForm ? (
        <Box mt={2}>
          <Textarea
            size="sm"
            placeholder="Reason (e.g. Return from concussion)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            mb={2}
          />
          <HStack gap={2}>
            <Button
              size="xs"
              colorPalette="violet"
              loading={submitting}
              disabled={submitting || !reason.trim()}
              onClick={submit}
            >
              Request clearance
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={submitting}
              onClick={() => {
                setShowForm(false);
                setReason("");
              }}
            >
              Cancel
            </Button>
          </HStack>
        </Box>
      ) : (
        <Button
          size="xs"
          variant="outline"
          alignSelf="start"
          mt={2}
          onClick={() => setShowForm(true)}
        >
          <Plus style={{ marginRight: 4 }} />
          Request medical clearance
        </Button>
      )}
    </InfoSection>
  );
}

// The list item shape returned by listPhysicalExamsForStaff (newest first).
type PhysicalExamView = {
  fileId: Id<"healthRecordFiles">;
  fileName: string;
  uploadedAt: number;
  url: string | null;
  reviewStatus: "accepted" | "needs_replacement" | null;
  reviewNote: string | null;
  reviewedAt: number | null;
  uploadedByStaff: boolean;
  isCurrent: boolean;
};

/**
 * One physical-exam document row: file name, upload date, the staff-filed
 * badge, and a download link. The current exam additionally gets the same
 * accept / needs-replacement verdict controls as the other physician
 * documents on this record (`DocumentReview`); earlier, superseded exams are
 * shown read-only — badge + optional note — mirroring how
 * `ClearanceRequestCard` renders a resolved clearance request.
 */
function PhysicalExamDocumentBlock({
  exam,
  institutionScope,
  showReview,
}: {
  exam: PhysicalExamView;
  institutionScope?: string;
  showReview: boolean;
}) {
  const badge = REVIEW_BADGE[exam.reviewStatus ?? "pending"];
  return (
    <Box>
      <HStack justify="space-between" gap={2} wrap="wrap" mb={1}>
        <Text fontSize="sm" fontWeight="semibold">
          {exam.fileName}
        </Text>
        <Text fontSize="2xs" color="charcoal.400">
          Uploaded {new Date(exam.uploadedAt).toLocaleString()}
        </Text>
      </HStack>
      <VStack align="stretch" gap={1}>
        <StaffFiledBadge document={exam} />
        {!showReview && (
          <Badge alignSelf="start" bg={badge.bg} color={badge.color} fontSize="2xs">
            {badge.label}
          </Badge>
        )}
        {exam.url ? (
          <Button size="sm" variant="outline" alignSelf="start" asChild>
            <a href={exam.url} target="_blank" rel="noopener noreferrer">
              Download physical exam
            </a>
          </Button>
        ) : (
          <Text fontSize="xs" color="charcoal.400">
            File not available
          </Text>
        )}
        {!showReview && exam.reviewNote && (
          <Text fontSize="xs" color="charcoal.500">
            Note: {exam.reviewNote}
          </Text>
        )}
      </VStack>
      {showReview && (
        <DocumentReview
          key={exam.fileId}
          document={{
            fileId: exam.fileId,
            reviewStatus: exam.reviewStatus,
            reviewedAt: exam.reviewedAt,
            reviewNote: exam.reviewNote,
            medicationExpirations: [],
          }}
          institutionScope={institutionScope}
        />
      )}
    </Box>
  );
}

/**
 * The "Current physical" — the physician-completed physical exam form,
 * uploaded as a standalone document (a sibling of the Annual program
 * participation form, not a slot on the signed Health & Emergency record).
 * Renders regardless of whether a signed record exists, same as
 * `MedicalClearanceStaffSection`. Newest upload is shown prominently with
 * the full review controls; earlier ones are listed underneath as history.
 */
function PhysicalExamStaffSection({
  scholarId,
  institutionScope,
}: {
  scholarId: Id<"users">;
  institutionScope?: string;
}) {
  const exams = useQuery(
    api.scholarHealthRecords.listPhysicalExamsForStaff,
    { scholarId, institutionScope },
  );

  if (exams === undefined) return null;

  const list = exams as PhysicalExamView[];
  const current = list.find((exam) => exam.isCurrent) ?? list[0];
  const history = current
    ? list.filter((exam) => exam.fileId !== current.fileId)
    : [];

  return (
    <InfoSection title="Current physical">
      {!current ? (
        <Text fontSize="xs" color="charcoal.500">
          No physical exam on file yet.
        </Text>
      ) : (
        <VStack align="stretch" gap={3}>
          <PhysicalExamDocumentBlock
            exam={current}
            institutionScope={institutionScope}
            showReview
          />
          {history.length > 0 && (
            <Box>
              <Text
                fontSize="xs"
                fontWeight="semibold"
                color="charcoal.500"
                mb={1}
              >
                Earlier physicals
              </Text>
              <VStack align="stretch" gap={2}>
                {history.map((exam) => (
                  <PhysicalExamDocumentBlock
                    key={exam.fileId}
                    exam={exam}
                    institutionScope={institutionScope}
                    showReview={false}
                  />
                ))}
              </VStack>
            </Box>
          )}
        </VStack>
      )}
    </InfoSection>
  );
}

function InfoSection({
  title,
  children,
  critical,
}: {
  title: string;
  children: React.ReactNode;
  critical?: boolean;
}) {
  return (
    <Box
      as="section"
      p={critical ? 4 : 0}
      bg={critical ? "rose.50" : undefined}
      borderWidth={critical ? "1px" : undefined}
      borderColor={critical ? "rose.200" : undefined}
      borderRadius={critical ? "lg" : undefined}
    >
      <Heading
        as="h4"
        size="sm"
        mb={2}
        color={critical ? "rose.900" : "charcoal.700"}
      >
        {title}
      </Heading>
      <Stack gap={1} fontSize="sm" color="charcoal.700">
        {children}
      </Stack>
    </Box>
  );
}

function InfoField({
  label,
  value,
}: {
  label: string;
  value?: string | number | null;
}) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <Text>
      <Text as="span" fontWeight="semibold">
        {label}:{" "}
      </Text>
      {value}
    </Text>
  );
}

const humanize = (value: string) =>
  value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

export function HealthRecordStaffView({
  scholarId,
  institutionScope,
}: {
  scholarId: Id<"users">;
  institutionScope?: string;
}) {
  const formsAvailable = useQuery(
    api.scholarHealthRecords.scholarFormsAvailableForStaff,
    { scholarId, institutionScope },
  );
  const record = useQuery(
    api.scholarHealthRecords.getHealthRecordForStaff,
    formsAvailable === true ? { scholarId, institutionScope } : "skip",
  );

  if (formsAvailable === undefined) return null;
  if (!formsAvailable) {
    return (
      <Text fontSize="sm" color="charcoal.400">
        Health forms aren&apos;t available for your school yet. These forms are
        specific to {PRIMARY_INSTITUTION_BRAND.schoolName}.
      </Text>
    );
  }
  if (record === undefined) return null;
  if (record === null) {
    return (
      <VStack gap={5} align="stretch">
        <Box p={4} bg="gray.50" borderRadius="md">
          <HStack gap={2} color="charcoal.500">
            <FirstAid size={20} />
            <Text fontSize="sm">No health record on file yet</Text>
          </HStack>
        </Box>
        <PhysicalExamStaffSection
          scholarId={scholarId}
          institutionScope={institutionScope}
        />
        <MedicalClearanceStaffSection
          scholarId={scholarId}
          institutionScope={institutionScope}
        />
      </VStack>
    );
  }

  const hapPlans = [
    record.hap.allergy && "Allergy",
    record.hap.asthma && "Asthma",
    record.hap.diabetes && "Diabetes",
    record.hap.seizure && "Seizure",
    record.hap.behavioralHealth && "Behavioral health",
    record.hap.other && `Other: ${record.hap.otherDesc}`,
  ].filter((value): value is string => Boolean(value));

  const structuredAddress = [
    record.streetAddress,
    record.city,
    [record.state, record.zipCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

  const developmentalLabel = (value: string) =>
    developmentalConditionOptions.find(([key]) => key === value)?.[1] ??
    humanize(value);
  const supportPlanStaffLabel = (value: string) =>
    supportPlanOptions.find(([key]) => key === value)?.[1] ?? humanize(value);

  return (
    <VStack gap={5} align="stretch">
      <InfoSection title="Safety-critical information" critical>
        <HStack gap={2} color="rose.900">
          <Warning size={20} weight="fill" />
          <Text fontWeight="semibold">
            Emergency care{" "}
            {record.emergencyMedAuthAck ? "authorized" : "not authorized"}
          </Text>
        </HStack>
        <Separator borderColor="rose.200" my={2} />
        <Text fontWeight="semibold">Allergies</Text>
        {record.noKnownAllergies ? (
          <Text>No known allergies</Text>
        ) : (
          record.allergies.map((allergy, index) => (
            <Box key={index}>
              <Text fontWeight="semibold">
                {allergy.allergen} — {humanize(allergy.severity)}
                {allergy.epipenOnFile ? " — EpiPen on file" : ""}
              </Text>
              <Text>Reaction: {allergy.reaction}</Text>
              <Text>Treatment: {allergy.emergencyTreatment}</Text>
              <Text>Type: {humanize(allergy.type)}</Text>
            </Box>
          ))
        )}
        {record.allergyNotes && <Text>Notes: {record.allergyNotes}</Text>}
        <Separator borderColor="rose.200" my={2} />
        <Text fontWeight="semibold">Current medications</Text>
        <Text>
          School handling: {humanize(record.schoolMedicationMode || "not recorded")}
        </Text>
        <Text>
          Authorization documentation:{" "}
          {record.medicationDocumentDelivery === "upload"
            ? "Uploaded"
            : record.medicationDocumentDelivery === "provide_separately"
              ? "To be provided separately"
              : record.medicationDocumentDelivery === "not_required"
                ? "Not required"
                : "Not recorded"}
        </Text>
        {record.medicationDocument && (
          <>
            <Text fontSize="xs" color="fg.muted">
              Uploaded{" "}
              {new Date(record.medicationDocument.uploadedAt).toLocaleString()}
            </Text>
            <StaffFiledBadge document={record.medicationDocument} />
            <Button size="sm" variant="outline" alignSelf="start" asChild>
              <a
                href={record.medicationDocument.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download medication authorization
              </a>
            </Button>
            <DocumentReview
              key={record.medicationDocument.fileId}
              document={record.medicationDocument}
              institutionScope={institutionScope}
              isMedication
            />
          </>
        )}
        {record.noCurrentMedications ? (
          <Text>None</Text>
        ) : (
          record.medications.map((medication, index) => (
            <Box key={index}>
              <Text fontWeight="semibold">
                {medication.name} — {medication.dosage},{" "}
                {medication.frequency}
              </Text>
              <Text>Purpose: {medication.purpose}</Text>
              <Text>
                Administration: {medication.administrationInstructions}
              </Text>
            </Box>
          ))
        )}
        <Separator borderColor="rose.200" my={2} />
        <Text fontWeight="semibold">Chronic conditions</Text>
        <Text>
          {record.noChronicConditions
            ? "None"
            : record.chronicConditions.map(humanize).join(", ")}
        </Text>
        {record.chronicConditionDetails && (
          <Text>{record.chronicConditionDetails}</Text>
        )}
        <Text fontWeight="semibold" mt={2}>
          Healthcare action plans
        </Text>
        <Text>{record.hap.none ? "None" : hapPlans.join(", ")}</Text>
        {!record.hap.none && (
          <Text>
            Plan document:{" "}
            {record.hapDocumentDelivery === "upload"
              ? "Uploaded"
              : record.hapDocumentDelivery === "provide_separately"
                ? "To be provided separately"
                : "Not recorded"}
          </Text>
        )}
        {record.actionPlanDocument && (
          <>
            <StaffFiledBadge document={record.actionPlanDocument} />
            <Button size="sm" variant="outline" alignSelf="start" asChild>
              <a
                href={record.actionPlanDocument.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download healthcare action plan
              </a>
            </Button>
            <DocumentReview
              key={record.actionPlanDocument.fileId}
              document={record.actionPlanDocument}
              institutionScope={institutionScope}
            />
          </>
        )}
        {record.allergyActionPlanDocument && (
          <>
            <Text fontWeight="semibold" mt={2}>
              Food allergy action plan
            </Text>
            <StaffFiledBadge document={record.allergyActionPlanDocument} />
            <Button size="sm" variant="outline" alignSelf="start" asChild>
              <a
                href={record.allergyActionPlanDocument.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download food allergy action plan
              </a>
            </Button>
            <DocumentReview
              key={record.allergyActionPlanDocument.fileId}
              document={record.allergyActionPlanDocument}
              institutionScope={institutionScope}
            />
          </>
        )}
        {record.asthmaActionPlanDocument && (
          <>
            <Text fontWeight="semibold" mt={2}>
              Asthma action plan
            </Text>
            <StaffFiledBadge document={record.asthmaActionPlanDocument} />
            <Button size="sm" variant="outline" alignSelf="start" asChild>
              <a
                href={record.asthmaActionPlanDocument.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download asthma action plan
              </a>
            </Button>
            <DocumentReview
              key={record.asthmaActionPlanDocument.fileId}
              document={record.asthmaActionPlanDocument}
              institutionScope={institutionScope}
            />
          </>
        )}
        {record.hap.notes && <Text>{record.hap.notes}</Text>}
      </InfoSection>

      <Separator />
      <InfoSection title="Emergency contacts — call in order">
        {record.emergencyContacts.map((contact, index) => (
          <Box key={index} mb={2}>
            <Text fontWeight="semibold">
              {index + 1}. {contact.name} — {contact.relationship}
            </Text>
            <Text>
              {contact.phone}
              {contact.altPhone ? ` · Alt: ${contact.altPhone}` : ""}
              {contact.canPickUp ? " · Authorized pick-up" : ""}
            </Text>
          </Box>
        ))}
      </InfoSection>

      <Separator />
      <InfoSection title="Child's basic information">
        <SimpleGrid columns={{ base: 1, md: 2 }} gap={1}>
          <InfoField label="Name" value={record.childName} />
          <InfoField
            label="Preferred name / nickname"
            value={record.childPreferredName}
          />
          <InfoField label="Date of birth" value={record.childDob} />
          <InfoField label="Grade / class" value={record.childGrade} />
          <InfoField label="Primary language" value={record.homePrimaryLanguage} />
          <InfoField
            label="Home address"
            value={structuredAddress || record.homeAddress}
          />
          <InfoField label="Physician" value={record.physicianName} />
          <InfoField label="Physician phone" value={record.physicianPhone} />
          <InfoField label="Dentist" value={record.dentistName} />
          <InfoField label="Dentist phone" value={record.dentistPhone} />
          <InfoField label="Insurance plan" value={record.insurancePlan} />
          <InfoField label="Insurance ID / group" value={record.insuranceId} />
        </SimpleGrid>
      </InfoSection>

      <Separator />
      <InfoSection title="Parent or legal guardian contact information">
        <InfoField label="Name" value={record.guardian1Name} />
        <InfoField
          label="Relationship"
          value={guardianRelationshipLabel(
            record.guardian1Relationship,
            record.guardian1RelationshipOther,
          )}
        />
        <InfoField label="Cell phone" value={record.guardian1Phone} />
        <InfoField label="Work phone" value={record.guardian1WorkPhone} />
        <InfoField label="Email" value={record.guardian1Email} />
        <InfoField label="Employer / school" value={record.guardian1Employer} />
        {record.guardian2 && (
          <Box mt={3}>
            <Text fontWeight="semibold">
              Additional parent or legal guardian
            </Text>
            <InfoField label="Name" value={record.guardian2.name} />
            <InfoField
              label="Relationship"
              value={guardianRelationshipLabel(
                record.guardian2.relationship,
                record.guardian2.relationshipOther,
              )}
            />
            <InfoField label="Cell phone" value={record.guardian2.phone} />
            <InfoField label="Work phone" value={record.guardian2.workPhone} />
            <InfoField label="Email" value={record.guardian2.email} />
            <InfoField label="Employer / school" value={record.guardian2.employer} />
          </Box>
        )}
        <InfoField label="Custody / pick-up restrictions" value={record.custodyNotes} />
        {record.custodyDocumentDelivery && (
          <InfoField
            label="Custody document"
            value={
              record.custodyDocumentDelivery === "upload"
                ? "Uploaded"
                : "To be provided separately"
            }
          />
        )}
        {record.custodyDocument && (
          <>
            <StaffFiledBadge document={record.custodyDocument} />
            <Button size="sm" variant="outline" alignSelf="start" asChild>
              <a
                href={record.custodyDocument.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download custody document
              </a>
            </Button>
          </>
        )}
      </InfoSection>

      <Separator />
      <InfoSection title="Immunization record">
        <InfoField
          label="Status"
          value={humanize(record.immunizationStatus)}
        />
        <InfoField
          label="Supporting documentation"
          value={
            record.immunizationDocumentDelivery === "upload"
              ? "Uploaded"
              : record.immunizationDocumentDelivery === "provide_separately"
                ? "To be provided separately"
                : "Not recorded"
          }
        />
        {record.immunizationDocument && (
          <>
            <Text fontSize="xs" color="fg.muted">
              Uploaded{" "}
              {new Date(record.immunizationDocument.uploadedAt).toLocaleString()}
            </Text>
            <StaffFiledBadge document={record.immunizationDocument} />
            <Button size="sm" variant="outline" alignSelf="start" asChild>
              <a
                href={record.immunizationDocument.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download immunization documentation
              </a>
            </Button>
          </>
        )}
        <InfoField label="Notes" value={record.immunizationNotes} />
      </InfoSection>

      <Separator />
      <InfoSection title="Developmental, behavioral & mental health">
        <InfoField
          label="Condition reported"
          value={
            record.developmentalConditionsPresent === "yes"
              ? "Yes"
              : record.developmentalConditionsPresent === "no"
                ? "No"
                : null
          }
        />
        {record.developmentalConditionsPresent === "yes" && (
          <>
            {record.developmentalConditions.length > 0 && (
              <InfoField
                label="Conditions"
                value={record.developmentalConditions
                  .map(developmentalLabel)
                  .join(", ")}
              />
            )}
            <InfoField
              label="Other condition"
              value={record.developmentalConditionsOther}
            />
            <InfoField
              label="What helps at school"
              value={record.developmentalSupportNotes}
            />
            <InfoField
              label="Successful supports"
              value={record.developmentalSuccessfulSupports}
            />
            {record.supportPlans.length > 0 && (
              <InfoField
                label="Support plans"
                value={record.supportPlans
                  .map(supportPlanStaffLabel)
                  .join(", ")}
              />
            )}
            <InfoField
              label="Other support plan"
              value={record.supportPlanOther}
            />
            {record.supportPlanDocumentDelivery && (
              <InfoField
                label="Support plan document"
                value={
                  record.supportPlanDocumentDelivery === "upload"
                    ? "Uploaded"
                    : "To be provided separately"
                }
              />
            )}
            {record.supportPlanDocument && (
              <>
                <StaffFiledBadge document={record.supportPlanDocument} />
                <Button size="sm" variant="outline" alignSelf="start" asChild>
                  <a
                    href={record.supportPlanDocument.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Download support plan
                  </a>
                </Button>
              </>
            )}
          </>
        )}
      </InfoSection>

      <Separator />
      <InfoSection title="Emergency medical authorization">
        <InfoField
          label="Authorized"
          value={record.emergencyMedAuthAck ? "Yes" : "No"}
        />
        <InfoField
          label="Restrictions / instructions"
          value={record.emergencyMedAuthNotes}
        />
      </InfoSection>

      <Separator />
      <InfoSection title="Operational restrictions">
        <InfoField
          label="Field-trip exception"
          value={
            record.fieldTripRestriction
              ? record.fieldTripRestrictionDetails ||
                "Requested — details not recorded"
              : "None requested"
          }
        />
        <InfoField
          label="PE/recess exception"
          value={
            record.peRecessRestriction
              ? record.peRecessRestrictionDetails ||
                "Requested — details not recorded"
              : "None requested"
          }
        />
        <InfoField
          label="Swimming exception"
          value={
            record.swimmingRestriction
              ? record.swimmingRestrictionDetails ||
                "Requested — details not recorded"
              : "None requested"
          }
        />
      </InfoSection>

      <Separator />
      <InfoSection title="Electronic signature">
        <InfoField label="Signed by" value={record.signerName} />
        <InfoField
          label="Signed"
          value={new Date(record.signedAt).toLocaleString()}
        />
        <InfoField
          label="Submitted by"
          value={`${record.guardianName}${record.guardianEmail ? ` (${record.guardianEmail})` : ""}`}
        />
        <InfoField label="Record revision" value={record.revision} />
      </InfoSection>

      <Separator />
      <PhysicalExamStaffSection
        scholarId={scholarId}
        institutionScope={institutionScope}
      />

      <Separator />
      <MedicalClearanceStaffSection
        scholarId={scholarId}
        institutionScope={institutionScope}
      />
    </VStack>
  );
}
