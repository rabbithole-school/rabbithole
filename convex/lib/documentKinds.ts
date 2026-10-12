// The ONE table that decides (a) what a role may upload and (b) what its
// dropdown offers. The server gate and the client menu read the same rows, so
// the UI can never promise something the server would refuse.
//
// Deliberately NOT a general "record type registry": it exists because two
// concrete consumers must not drift. If it ever has only one consumer, delete
// it and inline it.
//
// The `store` column is the whole design. Scholar documents land in
// `scholarDocuments` and (when `pipeline` is "extract") run the extract/redact
// pipeline whose output reaches the scholar-facing tutor. Health documents land
// in `healthRecordFiles` and have NO ingestion pipeline — a custody document or
// a medication authorization must never enter one. Merging the two LISTS is a
// presentation choice; merging the two TABLES would be a safety bug.
//
// The `capability` column is the access policy, for READS as well as writes:
// an operations staffer may see, download and delete exactly the
// `scholarDocuments` kinds they may file (`roleMayHandleKind`), and never a
// teacher-only kind such as a cognitive assessment. See
// `scholarDocuments.requireDocumentAccess`.

import { isScholarAdminRole, isTeacherRole, type Role } from "./roles";

export type DocumentStore = "scholarDocuments" | "healthRecordFiles";
/**
 *   teacher       — teacher / school_admin / platform_admin only.
 *   operations    — teacher roles OR staff holding `school:operations` at the
 *                   scholar's institution (administrative records: the front
 *                   office files these from the scanner).
 *   scholar_admin — scholar-admin roles OR either staff capability grant.
 */
export type DocumentCapability = "teacher" | "operations" | "scholar_admin";
export type DocumentKindGroup = "Scholar documents" | "Health record";
/** Whether an upload of this kind enters the extract → redact pipeline. */
export type DocumentPipeline = "extract" | "none";

export const DOCUMENT_KINDS = [
  // → scholarDocuments (sensitive; runs the extract/redact pipeline).
  // `teacher_report` is absent on purpose: it is only reachable via "Write
  // text", never an upload.
  { kind: "assessment", group: "Scholar documents", label: "Cognitive assessment", store: "scholarDocuments", capability: "teacher", pipeline: "extract" },
  { kind: "iep", group: "Scholar documents", label: "IEP / 504 plan", store: "scholarDocuments", capability: "teacher", pipeline: "extract" },
  // A report card is the front office's "academic / progress record" —
  // administrative, not clinical — so operations staff may file it too.
  { kind: "report_card", group: "Scholar documents", label: "Report card", store: "scholarDocuments", capability: "operations", pipeline: "extract" },
  // Identity files stay staff-only and are never sent through document AI.
  { kind: "identity_document", group: "Scholar documents", label: "Identity document", store: "scholarDocuments", capability: "teacher", pipeline: "none" },
  { kind: "parent_email", group: "Scholar documents", label: "Parent email / note", store: "scholarDocuments", capability: "teacher", pipeline: "extract" },
  { kind: "observation", group: "Scholar documents", label: "Observation", store: "scholarDocuments", capability: "teacher", pipeline: "extract" },
  // Administrative records the front office files from the scanner (asked for
  // 2026-08-26). Incident reports and doctor's notes never enter the pipeline:
  // their content (discipline, medical) has no classroom value and must not
  // get near the scholar-facing tutor even in redacted form. Transfer records
  // and conference notes are the same class of material as a report card or a
  // parent note and are summarized for teachers the same way.
  { kind: "incident_report", group: "Scholar documents", label: "Incident report", store: "scholarDocuments", capability: "operations", pipeline: "none" },
  { kind: "transfer_record", group: "Scholar documents", label: "Transfer / release record", store: "scholarDocuments", capability: "operations", pipeline: "extract" },
  { kind: "conference_notes", group: "Scholar documents", label: "Conference notes", store: "scholarDocuments", capability: "operations", pipeline: "extract" },
  { kind: "doctor_note", group: "Scholar documents", label: "Doctor's note", store: "scholarDocuments", capability: "operations", pipeline: "none" },
  { kind: "other", group: "Scholar documents", label: "Other", store: "scholarDocuments", capability: "teacher", pipeline: "extract" },

  // → healthRecordFiles (typed slots on the signed health record; NO ingestion
  // pipeline, ever). Readable by every scholar-admin role today — this map
  // grants the matching WRITE.
  { kind: "immunization_record", group: "Health record", label: "Immunization record", store: "healthRecordFiles", capability: "scholar_admin", pipeline: "none" },
  { kind: "medication_authorization", group: "Health record", label: "Medication authorization", store: "healthRecordFiles", capability: "scholar_admin", pipeline: "none" },
  { kind: "action_plan_document", group: "Health record", label: "Healthcare action plan", store: "healthRecordFiles", capability: "scholar_admin", pipeline: "none" },
  { kind: "action_plan_document_allergy", group: "Health record", label: "Food allergy action plan", store: "healthRecordFiles", capability: "scholar_admin", pipeline: "none" },
  { kind: "action_plan_document_asthma", group: "Health record", label: "Asthma action plan", store: "healthRecordFiles", capability: "scholar_admin", pipeline: "none" },
  { kind: "custody_document", group: "Health record", label: "Custody document", store: "healthRecordFiles", capability: "scholar_admin", pipeline: "none" },
  { kind: "support_plan_document", group: "Health record", label: "Support plan document", store: "healthRecordFiles", capability: "scholar_admin", pipeline: "none" },
  // `physical_exam_document` (the "Current physical") is deliberately ABSENT.
  // Every kind listed here is offered by the staff upload dialog, and the
  // physical has no staff upload path: it is standalone rather than a
  // signed-record slot (see the schema comment on `healthRecordFiles.kind`),
  // so the slot-bound staff mutation would refuse it. Listing it would put a
  // permanently disabled option in the dropdown — exactly the promise/refusal
  // drift this table exists to prevent. Add it here only together with a
  // non-slot staff upload mutation.
] as const satisfies readonly {
  kind: string;
  group: DocumentKindGroup;
  label: string;
  store: DocumentStore;
  capability: DocumentCapability;
  pipeline: DocumentPipeline;
}[];

export type DocumentKindSpec = (typeof DOCUMENT_KINDS)[number];
export type UploadableDocumentKind = DocumentKindSpec["kind"];
export type ScholarDocumentUploadKind = Extract<
  DocumentKindSpec,
  { store: "scholarDocuments" }
>["kind"];
export type HealthDocumentKind = Extract<
  DocumentKindSpec,
  { store: "healthRecordFiles" }
>["kind"];

/** Ordered groups, for a dropdown that renders one `<optgroup>` per group. */
export const DOCUMENT_KIND_GROUPS: readonly DocumentKindGroup[] = [
  "Scholar documents",
  "Health record",
];

const KIND_BY_NAME = new Map<string, DocumentKindSpec>(
  DOCUMENT_KINDS.map((spec) => [spec.kind, spec]),
);

export function documentKindSpec(kind: string): DocumentKindSpec | null {
  return KIND_BY_NAME.get(kind) ?? null;
}

/** Whether an upload of this kind enters the extract → redact pipeline. */
export function documentKindUsesExtraction(kind: string): boolean {
  const spec = documentKindSpec(kind);
  return spec?.store === "scholarDocuments" && spec.pipeline === "extract";
}

function roleHasCapability(
  role: Role | undefined | null,
  capability: DocumentCapability,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): boolean {
  switch (capability) {
    case "teacher":
      return isTeacherRole(role);
    case "operations":
      return isTeacherRole(role) || hasSchoolOperationsAccess;
    case "scholar_admin":
      return (
        isScholarAdminRole(role) ||
        hasSchoolOperationsAccess ||
        hasHealthManagementAccess
      );
  }
}

/**
 * Server: may this role handle (read, download, delete) an EXISTING row of
 * this kind? Same table, same answer as the upload menu — a kind you may file
 * is a kind you may see. Unknown kinds (e.g. the write-only `teacher_report`)
 * are teacher-only.
 */
export function roleMayHandleKind(
  role: Role | undefined | null,
  kind: string,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): boolean {
  if (isTeacherRole(role)) return true;
  const spec = documentKindSpec(kind);
  return (
    !!spec &&
    roleHasCapability(
      role,
      spec.capability,
      hasSchoolOperationsAccess,
      hasHealthManagementAccess,
    )
  );
}

/**
 * Client: the kinds this role may upload, in menu order. An operations
 * staffer gets the administrative Scholar-documents kinds plus (with
 * `health:manage`) the Health record group — never a teacher-only kind such
 * as a cognitive assessment. Not filtered in the browser, but never offered
 * and rejected if requested (see `requireKindAccess`).
 */
export function uploadableKinds(
  role: Role | undefined | null,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): readonly DocumentKindSpec[] {
  return DOCUMENT_KINDS.filter((spec) =>
    roleHasCapability(
      role,
      spec.capability,
      hasSchoolOperationsAccess,
      hasHealthManagementAccess,
    ),
  );
}

/**
 * Client: hide health-record kinds when the target scholar's institution does
 * not have the underlying forms feature.
 */
export function visibleUploadKinds(
  role: Role | undefined | null,
  healthFormsAvailable: boolean,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): readonly DocumentKindSpec[] {
  return uploadableKinds(
    role,
    hasSchoolOperationsAccess,
    hasHealthManagementAccess,
  ).filter(
    (spec) => healthFormsAvailable || spec.store !== "healthRecordFiles",
  );
}

/**
 * Server: throws unless this role may write this kind. Call it FIRST in every
 * upload mutation, before any scholar lookup, so a hand-crafted request with a
 * kind the UI never offered is refused on the same table that built the menu.
 */
export function requireKindAccess(
  role: Role | undefined | null,
  kind: string,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): DocumentKindSpec {
  const spec = documentKindSpec(kind);
  if (
    !spec ||
    !roleHasCapability(
      role,
      spec.capability,
      hasSchoolOperationsAccess,
      hasHealthManagementAccess,
    )
  ) {
    throw new Error("Forbidden: you may not upload this kind of document");
  }
  return spec;
}
