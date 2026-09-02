// The ONE table that decides (a) what a role may upload and (b) what its
// dropdown offers. The server gate and the client menu read the same rows, so
// the UI can never promise something the server would refuse.
//
// Deliberately NOT a general "record type registry": it exists because two
// concrete consumers must not drift. If it ever has only one consumer, delete
// it and inline it.
//
// The `store` column is the whole design. Scholar documents land in
// `scholarDocuments` and run the extract/redact pipeline whose output reaches
// the scholar-facing tutor. Health documents land in `healthRecordFiles` and
// have NO ingestion pipeline — a custody document or a medication
// authorization must never enter one. Merging the two LISTS is a presentation
// choice; merging the two TABLES would be a safety bug.

import { isScholarAdminRole, isTeacherRole, type Role } from "./roles";

export type DocumentStore = "scholarDocuments" | "healthRecordFiles";
export type DocumentCapability = "teacher" | "scholar_admin";
export type DocumentKindGroup = "Scholar documents" | "Health record";

export const DOCUMENT_KINDS = [
  // → scholarDocuments (sensitive; runs the extract/redact pipeline).
  // `teacher_report` is absent on purpose: it is only reachable via "Write
  // text", never an upload.
  { kind: "assessment", group: "Scholar documents", label: "Cognitive assessment", store: "scholarDocuments", capability: "teacher" },
  { kind: "iep", group: "Scholar documents", label: "IEP / 504 plan", store: "scholarDocuments", capability: "teacher" },
  { kind: "report_card", group: "Scholar documents", label: "Report card", store: "scholarDocuments", capability: "teacher" },
  { kind: "identity_document", group: "Scholar documents", label: "Identity document", store: "scholarDocuments", capability: "teacher" },
  { kind: "parent_email", group: "Scholar documents", label: "Parent email / note", store: "scholarDocuments", capability: "teacher" },
  { kind: "observation", group: "Scholar documents", label: "Observation", store: "scholarDocuments", capability: "teacher" },
  { kind: "other", group: "Scholar documents", label: "Other", store: "scholarDocuments", capability: "teacher" },

  // → healthRecordFiles (typed slots on the signed health record; NO ingestion
  // pipeline, ever). Readable by every scholar-admin role today — this map
  // grants the matching WRITE.
  { kind: "immunization_record", group: "Health record", label: "Immunization record", store: "healthRecordFiles", capability: "scholar_admin" },
  { kind: "medication_authorization", group: "Health record", label: "Medication authorization", store: "healthRecordFiles", capability: "scholar_admin" },
  { kind: "action_plan_document", group: "Health record", label: "Healthcare action plan", store: "healthRecordFiles", capability: "scholar_admin" },
  { kind: "action_plan_document_allergy", group: "Health record", label: "Food allergy action plan", store: "healthRecordFiles", capability: "scholar_admin" },
  { kind: "action_plan_document_asthma", group: "Health record", label: "Asthma action plan", store: "healthRecordFiles", capability: "scholar_admin" },
  { kind: "custody_document", group: "Health record", label: "Custody document", store: "healthRecordFiles", capability: "scholar_admin" },
  { kind: "support_plan_document", group: "Health record", label: "Support plan document", store: "healthRecordFiles", capability: "scholar_admin" },
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

/** Identity files stay staff-only and are never sent through document AI. */
export function documentKindUsesExtraction(kind: string): boolean {
  const spec = documentKindSpec(kind);
  return spec?.store === "scholarDocuments" && kind !== "identity_document";
}

function roleHasCapability(
  role: Role | undefined | null,
  capability: DocumentCapability,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): boolean {
  return capability === "teacher"
    ? isTeacherRole(role)
    : isScholarAdminRole(role) ||
        hasSchoolOperationsAccess ||
        hasHealthManagementAccess;
}

/**
 * Client: the kinds this role may upload, in menu order. An operations staffer gets the
 * Health Record group only — not filtered in the browser, but never offered
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
