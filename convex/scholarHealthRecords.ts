// Scholar health and emergency information.
//
// The signed record is one immutable snapshot per scholar. Each guardian gets
// a separate resumable draft; only an explicit, fully validated submit replaces
// the signed snapshot. Staff reads are always institution-scoped.

import { ConvexError, v } from "convex/values";
import {
  authedAction,
  authedMutation,
  authedQuery,
} from "./lib/customFunctions";
import {
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  assertNotImpersonating,
  getCurrentUser,
  requireGuardianOf,
  requireUser,
} from "./lib/auth";
import {
  assertScholarInstitutionFormsAllowed,
  assertScholarFormsAllowed,
  scholarFormsAllowed,
  viewerFormsAllowed,
} from "./lib/formInstitutionGate";
import { resolveInstitutionLens } from "./lib/institutionLens";
import { isPlatformAdminRole } from "./lib/roles";
import { ENROLLMENT_STANDINGS } from "./lib/enrollmentStanding";
import {
  hasHealthAccessAtInstitution,
  healthInstitutionIds,
} from "./lib/staffCapabilities";
import { requireKindAccess, documentKindSpec } from "./lib/documentKinds";
import { matchScholarByName } from "./lib/scholarReadTools";
import {
  emptyHealthRecordFields,
  healthDocumentIds,
  healthRecordAnswersDiffer,
  healthRecordFields,
  healthRecordBusinessIssues,
  normalizeHealthRecordFields,
  validateHealthFormProgress,
  type HealthRecordFields,
} from "./lib/healthRecord";
import { normalizeEmail } from "./lib/email";
import { raiseAlert } from "./alerts";
import {
  scholarPath,
  scholarSlug,
  siteUrl,
  withBase,
} from "./lib/channels";
import { escapeSlackText } from "./lib/slackApi";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  HEALTH_DOCUMENT_MAX_BYTES,
  healthDocumentContentTypes,
  safeHealthDocumentFileName,
  validateHealthDocumentFile,
  type HealthDocumentContentType,
} from "../shared/healthDocuments";
import {
  type HealthRecordConflictErrorData,
  type HealthRecordValidationErrorData,
} from "../shared/healthRecordValidation";

const healthDocumentKindValidator = v.union(
  v.literal("medication_authorization"),
  v.literal("immunization_record"),
  v.literal("custody_document"),
  v.literal("action_plan_document"),
  v.literal("action_plan_document_allergy"),
  v.literal("action_plan_document_asthma"),
  v.literal("support_plan_document"),
);
const healthDocumentContentTypeValidator = v.union(
  v.literal("application/pdf"),
  v.literal("image/jpeg"),
  v.literal("image/png"),
);
const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1_000;
const UNATTACHED_UPLOAD_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_HEALTH_RECORD_DRAFTS_PER_SCHOLAR = 100;

// A staff upload ATTACHES to the family's signed record — so without one there
// is no slot to attach to and nowhere for the file to show up. Surfaced to the
// staff member verbatim, so keep it actionable.
const NO_SIGNED_RECORD_ERROR =
  "This scholar has no submitted health record yet — a guardian must complete the Medical & Emergency form before staff can attach documents to it.";

type FinalizeHealthDocumentResult =
  | { ok: false; error: string }
  | {
      ok: true;
      document: {
        fileId: Id<"healthRecordFiles">;
        fileName: string;
        contentType: HealthDocumentContentType;
        size: number;
        uploadedAt: number;
      };
    };

const saveArgs = {
  scholarId: v.id("users"),
  ...healthRecordFields,
  expectedDraftVersion: v.number(),
  expectedSignedRevision: v.number(),
  currentStep: v.number(),
  lastCompletedStep: v.number(),
  submit: v.boolean(),
} as const;

function healthFieldsFrom(
  record:
    | Doc<"scholarHealthRecords">
    | Doc<"scholarHealthRecordDrafts">,
): HealthRecordFields {
  return normalizeHealthRecordFields(record);
}

function preservedLegacyCookingWaiverFields(
  signed: Doc<"scholarHealthRecords"> | null,
): Pick<
  HealthRecordFields,
  | "cookingWaiverParentFullName"
  | "cookingWaiverStudentFullName"
  | "cookingWaiverDetails"
  | "cookingWaiverDate"
> {
  return {
    cookingWaiverParentFullName:
      signed?.cookingWaiverParentFullName ?? "",
    cookingWaiverStudentFullName:
      signed?.cookingWaiverStudentFullName ?? "",
    cookingWaiverDetails: signed?.cookingWaiverDetails ?? "",
    cookingWaiverDate: signed?.cookingWaiverDate ?? "",
  };
}

function preservedLegacyAnnualParticipationFields(
  signed: Doc<"scholarHealthRecords"> | null,
): Pick<
  HealthRecordFields,
  | "publicMediaOptOut"
  | "fieldTripRestriction"
  | "fieldTripRestrictionDetails"
  | "peRecessRestriction"
  | "peRecessRestrictionDetails"
  | "swimmingRestriction"
  | "swimmingRestrictionDetails"
> {
  const acknowledged =
    signed?.standardProgramAcknowledgedAt !== undefined;
  return {
    publicMediaOptOut: acknowledged
      ? (signed.publicMediaOptOut ?? false)
      : false,
    fieldTripRestriction: acknowledged
      ? (signed.fieldTripRestriction ?? false)
      : false,
    fieldTripRestrictionDetails: acknowledged
      ? (signed.fieldTripRestrictionDetails ?? "")
      : "",
    peRecessRestriction: acknowledged
      ? (signed.peRecessRestriction ?? false)
      : false,
    peRecessRestrictionDetails: acknowledged
      ? (signed.peRecessRestrictionDetails ?? "")
      : "",
    swimmingRestriction: acknowledged
      ? (signed.swimmingRestriction ?? false)
      : false,
    swimmingRestrictionDetails: acknowledged
      ? (signed.swimmingRestrictionDetails ?? "")
      : "",
  };
}


function prefilledFields(
  scholar: Doc<"users">,
  guardian: Doc<"users">,
): HealthRecordFields {
  return emptyHealthRecordFields({
    childName: scholar.name,
    childDob: scholar.dateOfBirth,
    childGrade: scholar.gradeLevel,
    homeAddress: guardian.address,
    guardianName: guardian.name,
    guardianPhone: guardian.phone,
    guardianEmail: guardian.email,
  });
}

async function canonicalRecord(
  ctx: Parameters<typeof requireGuardianOf>[0],
  scholarId: Id<"users">,
) {
  return await ctx.db
    .query("scholarHealthRecords")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .unique();
}

/** Prefer the standalone annual participation form during its legacy backfill. */
async function annualParticipationAnswers(
  ctx: Parameters<typeof requireGuardianOf>[0],
  scholarId: Id<"users">,
) {
  const submission = await ctx.db
    .query("guardianFormSubmissions")
    .withIndex("by_scholar_form", (q) =>
      q.eq("scholarId", scholarId).eq("formId", "annual_program_participation"),
    )
    .unique();
  return submission?.answers.kind === "annual_program_participation"
    ? { ...submission.answers, submittedAt: submission.submittedAt }
    : null;
}

async function guardianDraft(
  ctx: Parameters<typeof requireGuardianOf>[0],
  scholarId: Id<"users">,
  guardianId: Id<"users">,
) {
  return await ctx.db
    .query("scholarHealthRecordDrafts")
    .withIndex("by_scholar_and_guardian", (q) =>
      q.eq("scholarId", scholarId).eq("guardianId", guardianId),
    )
    .unique();
}

function documentIdForKind(
  fields: HealthRecordFields,
  kind: Doc<"healthRecordFiles">["kind"],
) {
  switch (kind) {
    case "medication_authorization":
      return fields.medicationDocumentId;
    case "immunization_record":
      return fields.immunizationDocumentId;
    case "custody_document":
      return fields.custodyDocumentId;
    case "action_plan_document":
      return fields.actionPlanDocumentId;
    case "action_plan_document_allergy":
      return fields.actionPlanDocumentIds?.allergy ?? null;
    case "action_plan_document_asthma":
      return fields.actionPlanDocumentIds?.asthma ?? null;
    case "support_plan_document":
      return fields.supportPlanDocumentId;
    case "medical_clearance_document":
      // Not a signed-record slot — clearance lives on a request, never on the
      // annual record. It has no pointer field here.
      return null;
    case "physical_exam_document":
      // Not a signed-record slot either — the finalized file IS the record
      // (see the schema comment). No pointer field here.
      return null;
  }
}

// The signed record's slot for each document kind. Written as an exhaustive
// switch rather than a name map so the compiler checks every field —
// especially the healthcare action plan's asymmetry: its pointer is
// `actionPlanDocumentId` but its delivery flag is `hapDocumentDelivery`.
//
// Takes the current `fields` because the two condition-keyed plans share one
// `actionPlanDocumentIds` object: patching one must preserve the sibling.
function healthSlotPatch(
  fields: HealthRecordFields,
  kind: Doc<"healthRecordFiles">["kind"],
  fileId: Id<"healthRecordFiles">,
): Partial<HealthRecordFields> {
  const actionPlanDocumentIds = fields.actionPlanDocumentIds ?? {
    allergy: null,
    asthma: null,
  };
  switch (kind) {
    case "medication_authorization":
      return {
        medicationDocumentId: fileId,
        medicationDocumentDelivery: "upload",
      };
    case "immunization_record":
      return {
        immunizationDocumentId: fileId,
        immunizationDocumentDelivery: "upload",
      };
    case "custody_document":
      return {
        custodyDocumentId: fileId,
        custodyDocumentDelivery: "upload",
      };
    case "action_plan_document":
      return {
        actionPlanDocumentId: fileId,
        hapDocumentDelivery: "upload",
      };
    case "action_plan_document_allergy":
      return {
        actionPlanDocumentIds: { ...actionPlanDocumentIds, allergy: fileId },
      };
    case "action_plan_document_asthma":
      return {
        actionPlanDocumentIds: { ...actionPlanDocumentIds, asthma: fileId },
      };
    case "support_plan_document":
      return {
        supportPlanDocumentId: fileId,
        supportPlanDocumentDelivery: "upload",
      };
    case "medical_clearance_document":
      // Never a signed-record slot; clearance is attached to a request. This
      // arm is unreachable (clearance kinds never enter the slot machinery) and
      // exists only to keep the switch exhaustive.
      throw new Error("medical_clearance_document is not a signed-record slot");
    case "physical_exam_document":
      // Same shape as clearance: the finalized file stands alone, so there is
      // no slot to patch. Unreachable; here for exhaustiveness.
      throw new Error("physical_exam_document is not a signed-record slot");
  }
}

const HEALTH_DOCUMENT_KINDS = [
  "medication_authorization",
  "immunization_record",
  "custody_document",
  "action_plan_document",
  "action_plan_document_allergy",
  "action_plan_document_asthma",
  "support_plan_document",
] as const satisfies readonly Doc<"healthRecordFiles">["kind"][];

/** The inverse of `healthSlotPatch` — empties a slot and its delivery flag. */
function clearHealthSlot(
  fields: HealthRecordFields,
  kind: Doc<"healthRecordFiles">["kind"],
): Partial<HealthRecordFields> {
  const actionPlanDocumentIds = fields.actionPlanDocumentIds ?? {
    allergy: null,
    asthma: null,
  };
  switch (kind) {
    case "medication_authorization":
      return { medicationDocumentId: null, medicationDocumentDelivery: "" };
    case "immunization_record":
      return { immunizationDocumentId: null, immunizationDocumentDelivery: "" };
    case "custody_document":
      return { custodyDocumentId: null, custodyDocumentDelivery: "" };
    case "action_plan_document":
      return { actionPlanDocumentId: null, hapDocumentDelivery: "" };
    case "action_plan_document_allergy":
      return {
        actionPlanDocumentIds: { ...actionPlanDocumentIds, allergy: null },
      };
    case "action_plan_document_asthma":
      return {
        actionPlanDocumentIds: { ...actionPlanDocumentIds, asthma: null },
      };
    case "support_plan_document":
      return { supportPlanDocumentId: null, supportPlanDocumentDelivery: "" };
    case "medical_clearance_document":
      // Unreachable — clearance is never a signed-record slot (see
      // `healthSlotPatch`). Present only for switch exhaustiveness.
      throw new Error("medical_clearance_document is not a signed-record slot");
    case "physical_exam_document":
      // Unreachable for the same reason (see `healthSlotPatch`).
      throw new Error("physical_exam_document is not a signed-record slot");
  }
}

/**
 * Keeps a staff-filed document attached when a guardian submits a form that
 * never knew about it.
 *
 * A staff attachment deliberately does NOT bump `revision` — it changes no
 * parent-attested answer — and a guardian's draft counts as current while
 * `draft.baseRevision === signedRevision`. So a draft started before the
 * attachment stays "current" afterwards while still carrying an empty slot.
 * `saveHealthRecord` then REPLACES the signed record wholesale and garbage
 * collects any file the new field set no longer references, which would unlink
 * the immunization card AND delete the blob — silently, on the one class of
 * data where a silent loss is least acceptable.
 *
 * The guard is narrow on purpose. It restores a slot only when the incoming
 * fields leave it empty AND the signed record's file for that slot was filed by
 * staff. A guardian removing or replacing a document THEY uploaded is
 * untouched, because their form did show them that document and their omission
 * is a real answer. Here it isn't an answer at all — the form never offered
 * them the choice.
 *
 * It also RECONCILES a stale staff pointer. Because the preserved id is written
 * into the guardian's own draft, a later staff replace moves the canonical
 * pointer and strands the draft's copy — and
 * `validateHealthDocumentReference` only tolerates a file the guardian doesn't
 * own while it is the current canonical reference. Without this the guardian's
 * every subsequent save and submit would throw, showing them "try again" for a
 * conflict they can neither see nor resolve.
 */
async function preserveStaffAttachedDocuments(
  ctx: QueryCtx,
  fields: HealthRecordFields,
  signed: Doc<"scholarHealthRecords"> | null,
): Promise<HealthRecordFields> {
  if (!signed) return fields;
  let preserved = fields;
  for (const kind of HEALTH_DOCUMENT_KINDS) {
    const canonicalId = documentIdForKind(healthFieldsFrom(signed), kind);
    const incomingId = documentIdForKind(preserved, kind);
    // A condition the guardian just turned off (e.g. unchecked asthma) has no
    // live slot to hold a document. Never resurrect — or carry forward — a
    // staff pointer into an inactive slot: that would orphan the underlying
    // medical file, hiding it from both normalized reads and the
    // unreferenced-file sweep. Clear any lingering pointer and move on.
    if (!healthSlotIsActive(preserved, kind)) {
      if (incomingId) {
        preserved = { ...preserved, ...clearHealthSlot(preserved, kind) };
      }
      continue;
    }
    if (incomingId) {
      if (incomingId === canonicalId) continue;
      // A pointer the guardian doesn't own that is no longer canonical can
      // only have come from a previous staff attachment, and would be rejected
      // on save. Move it forward to whatever staff filed most recently.
      const stale = await ctx.db.get(incomingId);
      if (stale?.uploadedByStaff !== true) continue;
      preserved = {
        ...preserved,
        ...(canonicalId
          ? healthSlotPatch(preserved, kind, canonicalId)
          : clearHealthSlot(preserved, kind)),
      };
      continue;
    }
    if (!canonicalId) continue;
    const file = await ctx.db.get(canonicalId);
    if (file?.uploadedByStaff !== true) continue;
    preserved = { ...preserved, ...healthSlotPatch(preserved, kind, canonicalId) };
  }
  return preserved;
}

/**
 * Copy the guardian's own delivery answer onto a slot patch.
 *
 * `healthSlotPatch` / `clearHealthSlot` hardcode the delivery value that goes
 * with a slot ("upload" / ""), because staff filing a paper copy have no answer
 * of their own to record. A guardian does — their form is where that answer is
 * set, and it moves with the pointer ("I'll provide it separately" → "uploaded"
 * is the same edit as attaching the file). WHICH field carries it stays derived
 * from those two switches rather than a second name map, so the exhaustiveness
 * check there keeps covering this too.
 */
function withGuardianDelivery(
  patch: Partial<HealthRecordFields>,
  incoming: HealthRecordFields,
): Partial<HealthRecordFields> {
  const result: Record<string, unknown> = { ...patch };
  for (const field of Object.keys(result)) {
    if (field.endsWith("Delivery")) {
      result[field] = incoming[field as keyof HealthRecordFields];
    }
  }
  return result as Partial<HealthRecordFields>;
}

type CommittedSlot = {
  kind: (typeof HEALTH_DOCUMENT_KINDS)[number];
  from: Id<"healthRecordFiles"> | null;
  to: Id<"healthRecordFiles"> | null;
};

/**
 * A guardian's DOCUMENT arriving on (or leaving) an already-signed record,
 * committed to that record IN PLACE — no revision bump, no fresh signature.
 *
 * Same reasoning as a staff attachment (`preserveStaffAttachedDocuments`): a
 * document is not a parent-attested ANSWER. "Adderall, stored at school" is the
 * answer, and it does not change when the physician's authorization form
 * finally arrives — the record just stops being incomplete. Charging a fresh
 * electronic signature for handing over a PDF meant the ordinary case (parent
 * uploads, clicks Save & exit, leaves) filed the document into the guardian's
 * private draft and left the school looking at a record that still showed the
 * form as missing, with nothing on any surface saying so.
 *
 * Two guards, both load-bearing:
 *
 *  - A slot is committed only when it is ACTIVE under the SIGNED record's own
 *    answers. A draft that turns on `hap.asthma` and attaches an asthma plan
 *    HAS changed an answer, and normalization erases a pointer on a record that
 *    still says "no asthma" (see `healthSlotIsActive`) — so that one stays in
 *    the draft, invisible to staff, until it is signed for. That is the same
 *    line `inactiveSlotError` draws for staff.
 *  - Every OTHER guardian's live draft gets the same patch. A draft counts as
 *    current while `baseRevision === signedRevision`, and this write moves no
 *    revision — so without propagation a co-guardian's draft would keep its
 *    now-stale empty slot and silently unlink the document on their next save,
 *    which is the exact failure `preserveStaffAttachedDocuments` was written to
 *    stop. Telling the other drafts is the honest fix: they go stale because
 *    nobody told them.
 */
async function commitGuardianDocumentSlots(
  ctx: MutationCtx,
  {
    signed,
    incoming,
    guardianId,
  }: {
    signed: Doc<"scholarHealthRecords">;
    incoming: HealthRecordFields;
    guardianId: Id<"users">;
  },
): Promise<CommittedSlot[]> {
  const signedFields = healthFieldsFrom(signed);
  const committed: CommittedSlot[] = [];
  let patchedFields = signedFields;
  let patch: Partial<HealthRecordFields> = {};
  for (const kind of HEALTH_DOCUMENT_KINDS) {
    const from = documentIdForKind(signedFields, kind);
    const to = documentIdForKind(incoming, kind);
    if (from === to) continue;
    if (!healthSlotIsActive(signedFields, kind)) continue;
    const slotPatch = withGuardianDelivery(
      to
        ? healthSlotPatch(patchedFields, kind, to)
        : clearHealthSlot(patchedFields, kind),
      incoming,
    );
    patchedFields = { ...patchedFields, ...slotPatch };
    patch = { ...patch, ...slotPatch };
    committed.push({ kind, from, to });
  }
  if (committed.length === 0) return committed;

  await ctx.db.patch(signed._id, patch);

  const siblingDrafts = (
    await ctx.db
      .query("scholarHealthRecordDrafts")
      .withIndex("by_scholar", (q) => q.eq("scholarId", signed.scholarId))
      .take(MAX_HEALTH_RECORD_DRAFTS_PER_SCHOLAR)
  ).filter(
    (candidate) =>
      candidate.guardianId !== guardianId &&
      candidate.baseRevision === signed.revision,
  );
  const now = Date.now();
  for (const sibling of siblingDrafts) {
    const siblingFields = healthFieldsFrom(sibling);
    let siblingPatched = siblingFields;
    let siblingPatch: Partial<HealthRecordFields> = {};
    for (const slot of committed) {
      // The other guardian's own answers may leave this slot inactive (their
      // draft turned the condition off). Writing there would be erased by the
      // next normalized read, so leave their draft to speak for itself.
      if (!healthSlotIsActive(siblingFields, slot.kind)) continue;
      const slotPatch = withGuardianDelivery(
        slot.to
          ? healthSlotPatch(siblingPatched, slot.kind, slot.to)
          : clearHealthSlot(siblingPatched, slot.kind),
        incoming,
      );
      siblingPatched = { ...siblingPatched, ...slotPatch };
      siblingPatch = { ...siblingPatch, ...slotPatch };
    }
    if (Object.keys(siblingPatch).length === 0) continue;
    // Bumping `version` is deliberate: a co-guardian with the form open is now
    // holding a stale slot, and the draft-version conflict tells them to reload
    // instead of letting their next save undo this one.
    await ctx.db.patch(sibling._id, {
      ...siblingPatch,
      version: sibling.version + 1,
      updatedAt: now,
    });
  }
  return committed;
}

async function healthDocumentView(
  ctx: QueryCtx,
  fileId: Id<"healthRecordFiles"> | null,
) {
  if (!fileId) return null;
  const file = await ctx.db.get(fileId);
  if (
    !file?.storageId ||
    !file.fileName ||
    !file.contentType ||
    file.size === undefined ||
    file.finalizedAt === undefined
  ) {
    return null;
  }
  const url = await ctx.storage.getUrl(file.storageId);
  if (!url) return null;
  return {
    fileId: file._id,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.size,
    uploadedAt: file.finalizedAt,
    url,
    // Did a staff member file this (a paper copy handed in at the office), or
    // did the family attach it to the form they signed? A parent-submitted
    // document arrived with the parent's signature around it; a staff-scanned
    // one did not, and nobody should later mistake "the office has a
    // photocopy" for "the family attested to this".
    uploadedByStaff: file.uploadedByStaff === true,
    // Staff review state carried on the document itself. `reviewStatus` absent
    // on a document that is on file means "pending review" — a derived state,
    // not a stored one (see the schema). `medicationExpirations` is only ever
    // populated on `medication_authorization` rows.
    reviewStatus: file.reviewStatus ?? null,
    reviewedAt: file.reviewedAt ?? null,
    reviewNote: file.reviewNote ?? null,
    medicationExpirations: file.medicationExpirations ?? [],
  };
}

async function healthDocumentIsReferenced(
  ctx: MutationCtx,
  file: Doc<"healthRecordFiles">,
): Promise<boolean> {
  const signed = await canonicalRecord(ctx, file.scholarId);
  if (
    signed &&
    healthDocumentIds(healthFieldsFrom(signed)).includes(file._id)
  ) {
    return true;
  }
  // A medical-clearance document lives on a request row, not the signed record.
  // Without this check the 24h unreferenced-upload sweep would delete a
  // physician clearance the moment its own cleanup timer fired, even though a
  // request still points at it.
  const clearanceRequests = await ctx.db
    .query("medicalClearanceRequests")
    .withIndex("by_scholar", (q) => q.eq("scholarId", file.scholarId))
    .collect();
  if (clearanceRequests.some((request) => request.documentId === file._id)) {
    return true;
  }
  // A physical-exam document has NO owning row to point at it — the finalized
  // file IS the record (see the schema comment on `healthRecordFiles.kind`).
  // Nothing else can vouch for it, so finalization itself is the reference: a
  // finalized row is on file with the school and must survive the 24h
  // unreferenced-upload sweep, including the older rows kept as history. A
  // row with no `finalizedAt` is an abandoned or failed upload and is still
  // swept, exactly like every other kind.
  if (file.kind === "physical_exam_document") {
    return file.finalizedAt !== undefined;
  }
  const drafts = await ctx.db
    .query("scholarHealthRecordDrafts")
    .withIndex("by_scholar", (q) => q.eq("scholarId", file.scholarId))
    .take(MAX_HEALTH_RECORD_DRAFTS_PER_SCHOLAR);
  if (drafts.length === MAX_HEALTH_RECORD_DRAFTS_PER_SCHOLAR) {
    return true;
  }
  return drafts.some((draft) =>
    healthDocumentIds(healthFieldsFrom(draft)).includes(file._id),
  );
}

async function deleteHealthDocumentIfUnreferenced(
  ctx: MutationCtx,
  fileId: Id<"healthRecordFiles">,
): Promise<boolean> {
  const file = await ctx.db.get(fileId);
  if (!file || (await healthDocumentIsReferenced(ctx, file))) return false;
  if (file.storageId) await ctx.storage.delete(file.storageId);
  await ctx.db.delete(file._id);
  return true;
}

async function validateHealthDocumentReference(
  ctx: MutationCtx,
  {
    fileId,
    scholarId,
    guardianId,
    kind,
    signed,
  }: {
    fileId: Id<"healthRecordFiles"> | null;
    scholarId: Id<"users">;
    guardianId: Id<"users">;
    kind: Doc<"healthRecordFiles">["kind"];
    signed: Doc<"scholarHealthRecords"> | null;
  },
): Promise<void> {
  if (!fileId) return;
  const file = await ctx.db.get(fileId);
  if (
    !file ||
    file.scholarId !== scholarId ||
    file.kind !== kind ||
    !file.storageId ||
    !file.finalizedAt
  ) {
    throw new Error("The selected health document is unavailable");
  }
  const isCanonicalReference =
    !!signed && documentIdForKind(healthFieldsFrom(signed), kind) === fileId;
  if (file.uploadedBy !== guardianId && !isCanonicalReference) {
    throw new Error("Forbidden: health document belongs to another draft");
  }
}

export function detectHealthDocumentContentType(
  bytes: Uint8Array,
): HealthDocumentContentType | null {
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "application/pdf";
  }
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

/**
 * Attach a staff-owned blob directly to its signed-record slot. This is the
 * non-upload counterpart of `commitStaffHealthDocumentUpload`: callers that
 * already own a freshly copied storage blob (such as scanner refiling) must
 * preserve the same access, active-slot, audit, and replacement semantics.
 */
export async function attachStaffHealthDocumentFromStorage(
  ctx: MutationCtx,
  args: {
    user: Doc<"users">;
    scholarId: Id<"users">;
    kind: (typeof HEALTH_DOCUMENT_KINDS)[number];
    storageId: Id<"_storage">;
    fileName: string;
    declaredContentType?: string;
    detectedContentType: HealthDocumentContentType | null;
    institutionScope?: string;
  },
): Promise<{
  fileId: Id<"healthRecordFiles">;
  fileName: string;
  contentType: HealthDocumentContentType;
  size: number;
}> {
  await requireStaffScholarAccess(
    ctx,
    args.user,
    args.scholarId,
    args.institutionScope,
  );
  requireKindAccess(args.user.role, args.kind, false, true);
  await assertScholarInstitutionFormsAllowed(ctx, args.scholarId);
  const record = await canonicalRecord(ctx, args.scholarId);
  if (!record) throw new Error(NO_SIGNED_RECORD_ERROR);
  if (!healthSlotIsActive(healthFieldsFrom(record), args.kind)) {
    throw new Error(inactiveSlotError(args.kind));
  }

  const metadata = await ctx.db.system.get("_storage", args.storageId);
  const fileName = safeHealthDocumentFileName(args.fileName);
  const contentType = metadata?.contentType || args.declaredContentType || "";
  const validationError = !metadata
    ? "The copied file is unavailable."
    : validateHealthDocumentFile({
        name: fileName,
        type: contentType,
        size: metadata.size,
      }) ??
      (args.detectedContentType !== contentType
        ? "The file contents do not match the selected file type."
        : null);
  if (validationError) throw new Error(validationError);
  if (!metadata) throw new Error("The copied file is unavailable.");

  const now = Date.now();
  const verifiedContentType = contentType as HealthDocumentContentType;
  const fileId = await ctx.db.insert("healthRecordFiles", {
    scholarId: args.scholarId,
    uploadedBy: args.user._id,
    kind: args.kind,
    storageId: args.storageId,
    fileName,
    contentType: verifiedContentType,
    size: metadata.size,
    sha256: metadata.sha256,
    createdAt: now,
    finalizedAt: now,
    uploadedByStaff: true,
  });
  const supersededFileId = documentIdForKind(
    healthFieldsFrom(record),
    args.kind,
  );
  await ctx.db.patch(
    record._id,
    healthSlotPatch(healthFieldsFrom(record), args.kind, fileId),
  );
  await ctx.db.insert("auditLog", {
    actorUserId: args.user._id,
    action: supersededFileId
      ? "health_document.replace"
      : "health_document.upload",
    targetUserId: args.scholarId,
    at: now,
    detail: [
      `kind=${args.kind}`,
      `fileId=${fileId}`,
      ...(supersededFileId ? [`supersededFileId=${supersededFileId}`] : []),
    ].join(" "),
  });
  return {
    fileId,
    fileName,
    contentType: verifiedContentType,
    size: metadata.size,
  };
}

async function staffScholarCandidates(
  ctx: Parameters<typeof requireGuardianOf>[0],
  caller: Doc<"users">,
  institutionScope?: string,
) {
  const allowedInstitutionIds = await healthInstitutionIds(ctx, caller);
  if (allowedInstitutionIds === "all") {
    return await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "scholar"))
      .collect();
  }
  if (allowedInstitutionIds.size === 0) {
    throw new Error("Forbidden: health access required");
  }

  const lens = await resolveInstitutionLens(ctx, caller, institutionScope);
  if (lens.scope !== "institution" || !lens.institution) return [];
  if (
    !allowedInstitutionIds.has(lens.institution._id) ||
    !(await hasHealthAccessAtInstitution(
      ctx,
      caller,
      lens.institution._id,
    ))
  ) {
    throw new Error("Forbidden: health access required");
  }
  const institutionUsers = await ctx.db
    .query("users")
    .withIndex("by_institution", (q) =>
      q.eq("institutionId", lens.institution?._id),
    )
    .collect();
  return institutionUsers.filter((user) => user.role === "scholar");
}

/**
 * The staff/scholar boundary for health data: throws unless `scholarId` is in
 * the caller's institution lens. Exported so every staff-side health read and
 * write — including the merged document list in `scholarDocuments.ts` — goes
 * through exactly this check.
 */
export async function requireStaffScholarAccess(
  ctx: Parameters<typeof requireGuardianOf>[0],
  caller: Doc<"users">,
  scholarId: Id<"users">,
  institutionScope?: string,
) {
  const candidates = await staffScholarCandidates(ctx, caller, institutionScope);
  const scholar = candidates.find((candidate) => candidate._id === scholarId);
  if (!scholar) {
    throw new Error("Forbidden: scholar is not in your current context");
  }
  return scholar;
}

/**
 * The non-throwing sibling of `requireStaffScholarAccess`, for callers that
 * need to DEGRADE rather than fail when a scholar falls outside the active
 * institution lens (the merged document list shows a teacher their
 * scholarDocuments half either way; it just omits the health half).
 * Every WRITE path uses the throwing form.
 */
export async function staffScholarAccessible(
  ctx: Parameters<typeof requireGuardianOf>[0],
  caller: Doc<"users">,
  scholarId: Id<"users">,
  institutionScope?: string,
): Promise<boolean> {
  try {
    const candidates = await staffScholarCandidates(ctx, caller, institutionScope);
    return candidates.some((candidate) => candidate._id === scholarId);
  } catch {
    return false;
  }
}

/**
 * Minimal institution-scoped roster for the canonical health record surface.
 * It intentionally returns only identity needed to select a scholar, never
 * portfolio, account, attendance, or learning-record fields.
 */
export const listHealthScholarsForStaff = authedQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, { institutionScope }) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, institutionScope);
    if (lens.scope !== "institution" || !lens.institution) return [];
    if (
      !(await hasHealthAccessAtInstitution(
        ctx,
        ctx.user,
        lens.institution._id,
      ))
    ) {
      throw new Error("Forbidden: health access required");
    }
    const users = await ctx.db
      .query("users")
      .withIndex("by_institution", (q) =>
        q.eq("institutionId", lens.institution!._id),
      )
      .collect();
    return users
      .filter((user) => user.role === "scholar")
      .map((user) => ({
        id: user._id,
        name: user.name ?? user.username ?? "Scholar",
        // Identity only — enough for the shared scholar picker to render its
        // canonical row (photo, Extended Education standing). No health field
        // crosses this boundary; the record itself stays behind
        // HealthRecordStaffView's own gate.
        image: user.image ?? null,
        enrollmentStanding:
          user.enrollmentStanding ?? ENROLLMENT_STANDINGS.ENROLLED,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
});

/**
 * The five typed health slots on a scholar's SIGNED record, as document view
 * rows — the health half of the merged staff document list
 * (`scholarDocuments.listDocumentsForStaff`). A plain helper, not a Convex
 * function, so the caller reads it inside its own transaction after its own
 * gate. It does NO access control: gate first, then read.
 *
 * Only the canonical record's slots are listed — never every
 * `healthRecordFiles` row for the scholar, which would surface abandoned
 * upload attempts from a guardian's unsubmitted draft.
 */
export async function listHealthDocumentsForStaff(
  ctx: QueryCtx,
  scholarId: Id<"users">,
) {
  const record = await canonicalRecord(ctx, scholarId);
  if (!record) return [];
  const fields = healthFieldsFrom(record);
  const rows = await Promise.all(
    HEALTH_DOCUMENT_KINDS.map(async (kind) => {
      const view = await healthDocumentView(ctx, documentIdForKind(fields, kind));
      if (!view) return null;
      return {
        kind,
        label: documentKindSpec(kind)?.label ?? kind,
        ...view,
      };
    }),
  );
  return rows.filter((row): row is NonNullable<typeof row> => row !== null);
}

/**
 * Has a guardian actually SUBMITTED this scholar's health record? A staff
 * upload attaches to that signed record, so without one there is no slot to
 * attach to — the dropdown greys out the Health Record group rather than
 * offering an upload the server would refuse.
 */
export async function hasSignedHealthRecord(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<boolean> {
  return (await canonicalRecord(ctx, scholarId)) !== null;
}

/**
 * Two of the five slots only EXIST when the family's own answers call for
 * them. `normalizeHealthRecordBusinessFields` clears `actionPlanDocumentId`
 * unless a healthcare action plan is selected, and `supportPlanDocumentId`
 * unless a support plan is — deliberately, so a guardian who later answers
 * "none" can't leave an orphaned upload referenced by the record.
 *
 * Normalization runs on every READ, not just on write. So a raw slot patch
 * against an inactive slot is written and then erased by the next read: the
 * upload reports success and the document is invisible on every surface. That
 * is precisely the case this feature exists for (family answered "no action
 * plan", then handed the office an asthma plan on paper), so it has to fail
 * loudly instead.
 *
 * We refuse rather than repair, because both repairs are worse. Setting the
 * answer would have staff editing a parent's attested medical response, which
 * attach-in-place exists to avoid. Exempting staff pointers from the clearing
 * would leave the record asserting "no action plan" while carrying an action
 * plan document. The honest answer is that the family's form has to say the
 * plan exists before a document for it can hang off the record.
 */
export function healthSlotIsActive(
  fields: HealthRecordFields,
  kind: Doc<"healthRecordFiles">["kind"],
): boolean {
  const normalized = normalizeHealthRecordFields(fields);
  switch (kind) {
    case "action_plan_document":
    case "action_plan_document_allergy":
    case "action_plan_document_asthma":
    case "support_plan_document":
      // Round-trip the slot through normalization with a sentinel: if the
      // pointer survives, the slot is live. Asking the normalizer keeps this
      // from drifting the day its conditions change (the condition-keyed plans
      // ride the same clearing rules keyed on their own `hap.*` flag).
      return (
        documentIdForKind(
          normalizeHealthRecordFields({
            ...normalized,
            ...healthSlotPatch(normalized, kind, SLOT_PROBE_ID),
          }),
          kind,
        ) !== null
      );
    default:
      return true;
  }
}

/** Sentinel for the `healthSlotIsActive` round-trip; never persisted. */
const SLOT_PROBE_ID = "slot_probe" as Id<"healthRecordFiles">;

const inactiveSlotError = (kind: Doc<"healthRecordFiles">["kind"]): string => {
  switch (kind) {
    case "action_plan_document":
      return "This record has no healthcare action plan selected, so there is no action plan slot to attach to. Ask the family to update their Medical & Emergency form first.";
    case "action_plan_document_allergy":
      return "This record does not report a food allergy, so there is no allergy action plan slot to attach to. Ask the family to update their Medical & Emergency form first.";
    case "action_plan_document_asthma":
      return "This record does not report asthma, so there is no asthma action plan slot to attach to. Ask the family to update their Medical & Emergency form first.";
    default:
      return "This record has no support plan selected, so there is no support plan slot to attach to. Ask the family to update their Medical & Emergency form first.";
  }
};

/**
 * Which health kinds can actually be attached to this scholar's record right
 * now. The dropdown is built from this, so it can never offer an upload the
 * server would refuse — the invariant `listDocumentsForStaff` documents.
 */
export async function attachableHealthKinds(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Doc<"healthRecordFiles">["kind"][]> {
  const record = await canonicalRecord(ctx, scholarId);
  if (!record) return [];
  const fields = healthFieldsFrom(record);
  return HEALTH_DOCUMENT_KINDS.filter((kind) =>
    healthSlotIsActive(fields, kind),
  );
}

/**
 * Staff-side health document upload — step 1 of 3.
 *
 * The parent path (`generateHealthDocumentUploadUrl`) is gated on
 * `requireGuardianOf`; this is its staff twin, gated on the kind → capability
 * map plus the institution-scoped staff/scholar boundary. It exists so the
 * front desk can file the paper copy a family said they'd "provide
 * separately" instead of that line sitting on a safety-critical record
 * forever.
 *
 * Fails fast (before any bytes are uploaded) when the scholar has no SIGNED
 * health record: there is no slot to attach to, and a file with nowhere to go
 * would be silently swept by the TTL cleanup.
 */
export const generateStaffHealthDocumentUploadUrl = authedMutation({
  args: {
    scholarId: v.id("users"),
    kind: healthDocumentKindValidator,
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { scholarId, kind, institutionScope }) => {
    await requireStaffScholarAccess(ctx, ctx.user, scholarId, institutionScope);
    requireKindAccess(ctx.user.role, kind, false, true);
    // Health uploads attach to the primary-institution form record. Target
    // institution, not caller role, decides whether that record may exist.
    await assertScholarInstitutionFormsAllowed(ctx, scholarId);
    const record = await canonicalRecord(ctx, scholarId);
    if (!record) throw new Error(NO_SIGNED_RECORD_ERROR);
    if (!healthSlotIsActive(healthFieldsFrom(record), kind)) {
      throw new Error(inactiveSlotError(kind));
    }

    const now = Date.now();
    const fileId = await ctx.db.insert("healthRecordFiles", {
      scholarId,
      uploadedBy: ctx.user._id,
      kind,
      createdAt: now,
      uploadedByStaff: true,
    });
    await ctx.scheduler.runAfter(
      PENDING_UPLOAD_TTL_MS,
      internal.scholarHealthRecords.cleanupHealthRecordFile,
      { fileId, notBefore: now + PENDING_UPLOAD_TTL_MS },
    );
    return {
      fileId,
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
  },
});

export const getStaffHealthDocumentFinalizeContext = internalQuery({
  args: {
    fileId: v.id("healthRecordFiles"),
    storageId: v.id("_storage"),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { fileId, storageId, institutionScope }) => {
    const user = await requireUser(ctx);
    const file = await ctx.db.get(fileId);
    if (
      !file ||
      file.uploadedBy !== user._id ||
      file.storageId ||
      !file.uploadedByStaff
    ) {
      throw new Error("Health document upload is unavailable");
    }
    await requireStaffScholarAccess(ctx, user, file.scholarId, institutionScope);
    requireKindAccess(user.role, file.kind, false, true);
    await assertScholarInstitutionFormsAllowed(ctx, file.scholarId);
    const metadata = await ctx.db.system.get("_storage", storageId);
    return { file, metadata };
  },
});

/**
 * Staff-side health document upload — step 2 of 3. Split into an action so the
 * content-type sniff can read the stored blob (a mutation can't), exactly like
 * the parent path's `finalizeHealthDocumentUpload`.
 */
export const finalizeStaffHealthDocumentUpload = authedAction({
  args: {
    fileId: v.id("healthRecordFiles"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<FinalizeHealthDocumentResult> => {
    const { metadata } = await ctx.runQuery(
      internal.scholarHealthRecords.getStaffHealthDocumentFinalizeContext,
      {
        fileId: args.fileId,
        storageId: args.storageId,
        institutionScope: args.institutionScope,
      },
    );
    const metadataType = metadata?.contentType ?? "";
    const shouldInspectContents =
      !!metadata &&
      metadata.size <= HEALTH_DOCUMENT_MAX_BYTES &&
      (!metadataType ||
        healthDocumentContentTypes.includes(
          metadataType as HealthDocumentContentType,
        ));
    const blob = shouldInspectContents
      ? await ctx.storage.get(args.storageId)
      : null;
    const detectedContentType = blob
      ? detectHealthDocumentContentType(
          new Uint8Array(await blob.arrayBuffer()),
        )
      : null;
    return await ctx.runMutation(
      internal.scholarHealthRecords.commitStaffHealthDocumentUpload,
      {
        ...args,
        storedContentType: blob?.type ?? "",
        detectedContentType,
      },
    );
  },
});

/**
 * Staff-side health document upload — step 3 of 3: validate, then ATTACH IN
 * PLACE.
 *
 * "Attach in place" is the approved answer to the signed-record question: we
 * patch ONLY this slot's document pointer and flip its delivery from
 * "provide_separately" to "upload". `revision`, `signedAt` and every
 * parent-attested answer are left exactly as the guardian signed them, and
 * this never routes through `saveHealthRecord` (which would bump the
 * revision). The audit row is what makes that acceptable: a signed record now
 * carries a field the signer didn't put there, so who put it there is
 * recorded.
 *
 * Replacing an occupied slot is allowed (the wrong page gets scanned); the
 * superseded file row is RETAINED — a hard delete on a safety-critical record
 * is deliberately not offered here — and named in the audit entry.
 */
export const commitStaffHealthDocumentUpload = internalMutation({
  args: {
    fileId: v.id("healthRecordFiles"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    institutionScope: v.optional(v.string()),
    storedContentType: v.string(),
    detectedContentType: v.union(
      v.null(),
      healthDocumentContentTypeValidator,
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await assertNotImpersonating(ctx);
    const file = await ctx.db.get(args.fileId);
    if (
      !file ||
      file.uploadedBy !== user._id ||
      file.storageId ||
      !file.uploadedByStaff
    ) {
      throw new Error("Health document upload is unavailable");
    }
    // Re-derive the capability from the kind server-side, so a hand-crafted
    // request can't smuggle in a kind this role was never offered.
    await requireStaffScholarAccess(
      ctx,
      user,
      file.scholarId,
      args.institutionScope,
    );
    requireKindAccess(user.role, file.kind, false, true);
    await assertScholarInstitutionFormsAllowed(ctx, file.scholarId);
    const record = await canonicalRecord(ctx, file.scholarId);
    if (!record) {
      await ctx.db.delete(file._id);
      throw new Error(NO_SIGNED_RECORD_ERROR);
    }
    // Re-checked at commit: the family could have submitted a form that
    // deselected this plan between the ticket and the upload, and a slot
    // patch that normalization erases would report success and vanish.
    if (!healthSlotIsActive(healthFieldsFrom(record), file.kind)) {
      await ctx.db.delete(file._id);
      throw new Error(inactiveSlotError(file.kind));
    }

    const metadata = await ctx.db.system.get("_storage", args.storageId);
    const duplicate = await ctx.db
      .query("healthRecordFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    const fileName = safeHealthDocumentFileName(args.fileName);
    const contentType = metadata?.contentType ?? args.storedContentType;
    const validationError = !metadata
      ? "The uploaded file is unavailable."
      : duplicate
        ? "The uploaded file is already registered."
        : metadata._creationTime < file.createdAt - 5_000
          ? "The uploaded file does not belong to this upload request."
          : validateHealthDocumentFile({
              name: fileName,
              type: contentType,
              size: metadata.size,
            }) ??
            (args.detectedContentType !== contentType
              ? "The file contents do not match the selected file type."
              : null);
    if (validationError) {
      if (
        metadata &&
        !duplicate &&
        metadata._creationTime >= file.createdAt - 5_000
      ) {
        await ctx.storage.delete(args.storageId);
      }
      await ctx.db.delete(file._id);
      return { ok: false as const, error: validationError };
    }
    if (!metadata) {
      throw new Error("The uploaded file is unavailable");
    }

    const verifiedContentType = contentType as HealthDocumentContentType;
    const now = Date.now();
    await ctx.db.patch(file._id, {
      storageId: args.storageId,
      fileName,
      contentType: verifiedContentType,
      size: metadata.size,
      sha256: metadata.sha256,
      finalizedAt: now,
    });

    const supersededFileId = documentIdForKind(
      healthFieldsFrom(record),
      file.kind,
    );
    await ctx.db.patch(
      record._id,
      healthSlotPatch(healthFieldsFrom(record), file.kind, file._id),
    );

    await ctx.db.insert("auditLog", {
      actorUserId: user._id,
      action: supersededFileId
        ? "health_document.replace"
        : "health_document.upload",
      targetUserId: file.scholarId,
      at: now,
      detail: [
        `kind=${file.kind}`,
        `fileId=${file._id}`,
        ...(supersededFileId ? [`supersededFileId=${supersededFileId}`] : []),
      ].join(" "),
    });

    return {
      ok: true as const,
      document: {
        fileId: file._id,
        fileName,
        contentType: verifiedContentType,
        size: metadata.size,
        uploadedAt: now,
      },
    };
  },
});

const medicationExpirationValidator = v.object({
  name: v.string(),
  expiresAt: v.number(),
});

/**
 * The one genuinely new WRITE path this feature adds. Staff triage of a health
 * document that is already on the scholar's SIGNED record: an `accepted` /
 * `needs_replacement` verdict plus an optional note, and — for the Medication
 * Authorization — the physician-transcribed per-medication expiry rows Slice B
 * reads for its deterministic expiry alert.
 *
 * Scoped exactly like every other staff health read/write. It never touches
 * the parent-attested snapshot (medication answers, hap flags): review state
 * and expiry live on the document row, which staff owns, so no re-signature is
 * implied and no parent answer is edited.
 *
 * Only documents referenced by the canonical record are reviewable — never a
 * stray upload from an abandoned draft — so the verdict always names a document
 * the family actually submitted.
 */
export const setHealthDocumentReviewStatus = authedMutation({
  args: {
    fileId: v.id("healthRecordFiles"),
    institutionScope: v.optional(v.string()),
    // "pending" clears a prior verdict back to the derived pending-review state.
    reviewStatus: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("needs_replacement"),
    ),
    reviewNote: v.optional(v.string()),
    // Only honored on `medication_authorization`; a non-empty array on any
    // other kind is rejected rather than silently dropped.
    medicationExpirations: v.optional(v.array(medicationExpirationValidator)),
  },
  handler: async (
    ctx,
    { fileId, institutionScope, reviewStatus, reviewNote, medicationExpirations },
  ) => {
    const file = await ctx.db.get(fileId);
    if (!file) throw new Error("Health document not found");
    await requireStaffScholarAccess(
      ctx,
      ctx.user,
      file.scholarId,
      institutionScope,
    );
    if (file.kind === "physical_exam_document") {
      // The one reviewable kind that is NOT a signed-record slot: the current
      // physical stands alone, so "is it on the record" has no meaning here.
      // The finalized file IS the record, and the institution gate the
      // guardian uploaded through is what stands in for the slot check.
      await assertScholarFormsAllowed(ctx, ctx.user, file.scholarId);
      if (file.finalizedAt === undefined) {
        throw new Error(
          "This document has not finished uploading, so it cannot be reviewed.",
        );
      }
    } else {
      const record = await canonicalRecord(ctx, file.scholarId);
      if (
        !record ||
        !healthDocumentIds(healthFieldsFrom(record)).includes(file._id)
      ) {
        throw new Error(
          "This document is not on the scholar's signed record, so it cannot be reviewed.",
        );
      }
    }

    const now = Date.now();
    const cleanedNote = reviewNote?.trim() || undefined;
    const patch: {
      reviewStatus?: "accepted" | "needs_replacement";
      reviewedBy?: Id<"users">;
      reviewedAt?: number;
      reviewNote?: string;
      medicationExpirations?: { name: string; expiresAt: number }[];
    } = {
      reviewStatus: reviewStatus === "pending" ? undefined : reviewStatus,
      reviewedBy: reviewStatus === "pending" ? undefined : ctx.user._id,
      reviewedAt: reviewStatus === "pending" ? undefined : now,
      reviewNote: reviewStatus === "pending" ? undefined : cleanedNote,
    };
    if (medicationExpirations !== undefined) {
      const cleaned = medicationExpirations
        .map((row) => ({ name: row.name.trim(), expiresAt: row.expiresAt }))
        .filter((row) => row.name.length > 0);
      if (cleaned.length > 0 && file.kind !== "medication_authorization") {
        throw new Error(
          "Per-medication expiry only applies to the Medication Authorization.",
        );
      }
      patch.medicationExpirations = cleaned;
    }
    await ctx.db.patch(file._id, patch);

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "health_document.review",
      targetUserId: file.scholarId,
      at: now,
      detail: [
        `kind=${file.kind}`,
        `fileId=${file._id}`,
        `reviewStatus=${reviewStatus}`,
        ...(medicationExpirations !== undefined
          ? [`medicationExpirations=${patch.medicationExpirations?.length ?? 0}`]
          : []),
      ].join(" "),
    });

    return { ok: true as const, reviewedAt: patch.reviewedAt ?? null };
  },
});

export const generateHealthDocumentUploadUrl = authedMutation({
  args: {
    scholarId: v.id("users"),
    kind: healthDocumentKindValidator,
  },
  handler: async (ctx, { scholarId, kind }) => {
    await requireGuardianOf(ctx, scholarId);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== "scholar") {
      throw new Error("Scholar not found");
    }
    const now = Date.now();
    const fileId = await ctx.db.insert("healthRecordFiles", {
      scholarId,
      uploadedBy: ctx.user._id,
      kind,
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      PENDING_UPLOAD_TTL_MS,
      internal.scholarHealthRecords.cleanupHealthRecordFile,
      { fileId, notBefore: now + PENDING_UPLOAD_TTL_MS },
    );
    return {
      fileId,
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
  },
});

export const getHealthDocumentFinalizeContext = internalQuery({
  args: {
    fileId: v.id("healthRecordFiles"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, { fileId, storageId }) => {
    const user = await requireUser(ctx);
    const file = await ctx.db.get(fileId);
    if (!file || file.uploadedBy !== user._id || file.storageId) {
      throw new Error("Health document upload is unavailable");
    }
    await requireGuardianOf(ctx, file.scholarId);
    await assertScholarFormsAllowed(ctx, user, file.scholarId);
    const metadata = await ctx.db.system.get("_storage", storageId);
    return { file, metadata };
  },
});

export const finalizeHealthDocumentUpload = authedAction({
  args: {
    fileId: v.id("healthRecordFiles"),
    storageId: v.id("_storage"),
    fileName: v.string(),
  },
  handler: async (ctx, args): Promise<FinalizeHealthDocumentResult> => {
    const { metadata } = await ctx.runQuery(
      internal.scholarHealthRecords.getHealthDocumentFinalizeContext,
      {
        fileId: args.fileId,
        storageId: args.storageId,
      },
    );
    const metadataType = metadata?.contentType ?? "";
    const shouldInspectContents =
      !!metadata &&
      metadata.size <= HEALTH_DOCUMENT_MAX_BYTES &&
      (!metadataType ||
        healthDocumentContentTypes.includes(
          metadataType as HealthDocumentContentType,
        ));
    const blob = shouldInspectContents
      ? await ctx.storage.get(args.storageId)
      : null;
    const detectedContentType = blob
      ? detectHealthDocumentContentType(
          new Uint8Array(await blob.arrayBuffer()),
        )
      : null;
    return await ctx.runMutation(
      internal.scholarHealthRecords.commitHealthDocumentUpload,
      {
        ...args,
        storedContentType: blob?.type ?? "",
        detectedContentType,
      },
    );
  },
});

export const commitHealthDocumentUpload = internalMutation({
  args: {
    fileId: v.id("healthRecordFiles"),
    storageId: v.id("_storage"),
    fileName: v.string(),
    storedContentType: v.string(),
    detectedContentType: v.union(
      v.null(),
      healthDocumentContentTypeValidator,
    ),
  },
  handler: async (ctx, args) => {
    const user = await requireUser(ctx);
    await assertNotImpersonating(ctx);
    const file = await ctx.db.get(args.fileId);
    if (!file || file.uploadedBy !== user._id || file.storageId) {
      throw new Error("Health document upload is unavailable");
    }
    await requireGuardianOf(ctx, file.scholarId);
    await assertScholarFormsAllowed(ctx, user, file.scholarId);
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    const duplicate = await ctx.db
      .query("healthRecordFiles")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    const fileName = safeHealthDocumentFileName(args.fileName);
    const contentType = metadata?.contentType ?? args.storedContentType;
    const validationError = !metadata
      ? "The uploaded file is unavailable."
      : duplicate
        ? "The uploaded file is already registered."
        : metadata._creationTime < file.createdAt - 5_000
          ? "The uploaded file does not belong to this upload request."
          : validateHealthDocumentFile({
              name: fileName,
              type: contentType,
              size: metadata.size,
            }) ??
            (args.detectedContentType !== contentType
              ? "The file contents do not match the selected file type."
              : null);
    if (validationError) {
      if (
        metadata &&
        !duplicate &&
        metadata._creationTime >= file.createdAt - 5_000
      ) {
        await ctx.storage.delete(args.storageId);
      }
      await ctx.db.delete(file._id);
      return { ok: false as const, error: validationError };
    }
    if (!metadata) {
      throw new Error("The uploaded file is unavailable");
    }

    const verifiedContentType = contentType as HealthDocumentContentType;
    const now = Date.now();
    await ctx.db.patch(file._id, {
      storageId: args.storageId,
      fileName,
      contentType: verifiedContentType,
      size: metadata.size,
      sha256: metadata.sha256,
      finalizedAt: now,
    });
    // A standalone document has no later attach step to audit (clearance logs
    // `medical_clearance.attach`), so finalizing IS the moment the school takes
    // custody of a current physical — log it here, on the same table and in the
    // same shape as every other guardian health write.
    if (file.kind === "physical_exam_document") {
      await ctx.db.insert("auditLog", {
        actorUserId: user._id,
        action: "physical_exam.upload",
        targetUserId: file.scholarId,
        at: now,
        detail: `fileId=${file._id}`,
      });
    }
    await ctx.scheduler.runAfter(
      UNATTACHED_UPLOAD_TTL_MS,
      internal.scholarHealthRecords.cleanupHealthRecordFile,
      { fileId: file._id, notBefore: now + UNATTACHED_UPLOAD_TTL_MS },
    );
    return {
      ok: true as const,
      document: {
        fileId: file._id,
        fileName,
        contentType: verifiedContentType,
        size: metadata.size,
        uploadedAt: now,
      },
    };
  },
});

export const discardHealthDocumentUpload = authedMutation({
  args: { fileId: v.id("healthRecordFiles") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.db.get(fileId);
    if (!file) {
      throw new Error("Health document upload is unavailable");
    }
    await requireGuardianOf(ctx, file.scholarId);
    if (file.uploadedBy !== ctx.user._id) {
      return { discarded: false };
    }
    return {
      discarded: await deleteHealthDocumentIfUnreferenced(ctx, fileId),
    };
  },
});

export const cleanupHealthRecordFile = internalMutation({
  args: {
    fileId: v.id("healthRecordFiles"),
    notBefore: v.number(),
  },
  handler: async (ctx, { fileId, notBefore }) => {
    if (Date.now() < notBefore) return false;
    const file = await ctx.db.get(fileId);
    if (!file) return false;
    const eligibleAt =
      file.finalizedAt === undefined
        ? file.createdAt + PENDING_UPLOAD_TTL_MS
        : file.finalizedAt + UNATTACHED_UPLOAD_TTL_MS;
    if (Date.now() < eligibleAt) return false;
    return await deleteHealthDocumentIfUnreferenced(ctx, fileId);
  },
});

export const getHealthRecord = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    await requireGuardianOf(ctx, scholarId);
    // The health/consent forms are primary-institution/Hawaii legal documents (see
    // convex/lib/formInstitutionGate.ts) — never return their field content for
    // a scholar outside the primary institution.
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== "scholar") {
      throw new Error("Scholar not found");
    }
    const signed = await canonicalRecord(ctx, scholarId);
    const draft = await guardianDraft(ctx, scholarId, ctx.user._id);

    const signedRevision = signed?.revision ?? 0;
    const draftIsCurrent = !!draft && draft.baseRevision === signedRevision;
    const sourceFields = draftIsCurrent
      ? healthFieldsFrom(draft)
      : signed
        ? {
            ...healthFieldsFrom(signed),
            signerName: "",
            signerAgreement: false,
          }
        : prefilledFields(scholar, ctx.user);
    const accountContact = {
      name: ctx.user.name?.trim() ?? "",
      email: ctx.user.email?.trim() ?? "",
      phone: ctx.user.phone?.trim() ?? "",
    };
    const canReuseSubmittingSnapshot =
      draftIsCurrent || signed?.guardianId === ctx.user._id;
    const fields = await preserveStaffAttachedDocuments(
      ctx,
      {
        ...sourceFields,
        guardian1Name:
          accountContact.name ||
          (canReuseSubmittingSnapshot ? sourceFields.guardian1Name : ""),
        guardian1Email:
          accountContact.email ||
          (canReuseSubmittingSnapshot ? sourceFields.guardian1Email : ""),
        guardian1Phone:
          accountContact.phone ||
          (canReuseSubmittingSnapshot ? sourceFields.guardian1Phone : ""),
      },
      // A draft started before the office filed a paper copy still shows that
      // slot as empty. Show the guardian what is actually on their child's
      // record, so their next save carries it forward rather than silently
      // contradicting it.
      signed,
    );

    const [
      medicationDocument,
      immunizationDocument,
      custodyDocument,
      actionPlanDocument,
      allergyActionPlanDocument,
      asthmaActionPlanDocument,
      supportPlanDocument,
    ] = await Promise.all([
      healthDocumentView(ctx, fields.medicationDocumentId),
      healthDocumentView(ctx, fields.immunizationDocumentId),
      healthDocumentView(ctx, fields.custodyDocumentId),
      healthDocumentView(ctx, fields.actionPlanDocumentId),
      healthDocumentView(ctx, fields.actionPlanDocumentIds?.allergy ?? null),
      healthDocumentView(ctx, fields.actionPlanDocumentIds?.asthma ?? null),
      healthDocumentView(ctx, fields.supportPlanDocumentId),
    ]);
    return {
      ...fields,
      medicationDocument,
      immunizationDocument,
      custodyDocument,
      actionPlanDocument,
      allergyActionPlanDocument,
      asthmaActionPlanDocument,
      supportPlanDocument,
      accountSignerName: accountContact.name,
      accountContact,
      signedRevision,
      draftVersion: draft?.version ?? 0,
      hasPendingChanges: draftIsCurrent,
      draftWasStale: !!draft && !draftIsCurrent,
      currentStep: draftIsCurrent ? draft.currentStep : signed ? 11 : 0,
      lastCompletedStep: draftIsCurrent
        ? draft.lastCompletedStep
        : signed
          ? 10
          : -1,
      submittedAt: signed?.submittedAt ?? null,
      signedAt: signed?.signedAt ?? null,
      updatedAt: draftIsCurrent ? draft.updatedAt : (signed?.updatedAt ?? null),
    };
  },
});

/**
 * Guardian-facing boolean: may the health/consent forms be produced for this
 * child? Same guardian gate as `getHealthRecord`; the parent wizard calls it
 * FIRST so a guardian of a non-primary-institution child sees a legible refusal
 * instead of an errored form query (see convex/lib/formInstitutionGate.ts).
 */
export const scholarFormsAvailable = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }): Promise<boolean> => {
    await requireGuardianOf(ctx, scholarId);
    if (isPlatformAdminRole(ctx.user.role)) return true;
    return scholarFormsAllowed(ctx, scholarId);
  },
});

/**
 * Staff-side form availability for a specific scholar and institution lens.
 * This reports whether the first-party templates apply to the target scholar;
 * underlying record reads keep their separate platform-admin authorization.
 */
export const scholarFormsAvailableForStaff = authedQuery({
  args: {
    scholarId: v.id("users"),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { scholarId, institutionScope }): Promise<boolean> => {
    await requireStaffScholarAccess(ctx, ctx.user, scholarId, institutionScope);
    return scholarFormsAllowed(ctx, scholarId);
  },
});

/**
 * Public, viewer-scoped boolean for the /print/forms route gate. Returns `true`
 * for an unauthenticated viewer (the blank templates are a public primary-school
 * resource a physician completes) and for anyone tied to the primary
 * institution; `false` for a signed-in non-primary family/staffer. Never
 * throws — a plain query so the public print page can read it.
 */
export const formsAvailableForViewer = query({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const user = await getCurrentUser(ctx);
    return viewerFormsAllowed(ctx, user);
  },
});

export const saveHealthRecord = authedMutation({
  args: saveArgs,
  handler: async (ctx, args) => {
    await requireGuardianOf(ctx, args.scholarId);
    // Never draft or sign a primary-institution/Hawaii legal form for a scholar outside
    // the primary institution (see convex/lib/formInstitutionGate.ts).
    await assertScholarFormsAllowed(ctx, ctx.user, args.scholarId);
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== "scholar") {
      throw new Error("Scholar not found");
    }

    const signed = await canonicalRecord(ctx, args.scholarId);
    const draft = await guardianDraft(ctx, args.scholarId, ctx.user._id);
    const signedRevision = signed?.revision ?? 0;
    const draftVersion = draft?.version ?? 0;

    if (args.expectedSignedRevision !== signedRevision) {
      throw new ConvexError<HealthRecordConflictErrorData>({
        kind: "health_record_conflict",
        code: "signed_revision_conflict",
        message:
          "Another authorized guardian updated this record. Reload to review the latest version before saving.",
      });
    }
    if (args.expectedDraftVersion !== draftVersion) {
      throw new ConvexError<HealthRecordConflictErrorData>({
        kind: "health_record_conflict",
        code: "draft_version_conflict",
        message:
          "This draft changed in another tab. Reload this page before saving again.",
      });
    }

    validateHealthFormProgress(args.currentStep, args.lastCompletedStep);
    const guardianEmail = normalizeEmail(
      ctx.user.email?.trim() || args.guardian1Email,
    );
    const normalized = await preserveStaffAttachedDocuments(
      ctx,
      normalizeHealthRecordFields({
        ...args,
        childName: scholar.name?.trim() ?? args.childName,
        guardian1Name: ctx.user.name?.trim() || args.guardian1Name,
        guardian1Email: guardianEmail,
        guardian1Phone: ctx.user.phone?.trim() || args.guardian1Phone,
      }),
      signed,
    );
    const validationIssue = healthRecordBusinessIssues(
      normalized,
      args.submit,
      ctx.user.name?.trim() || normalized.guardian1Name,
    )[0];
    if (validationIssue) {
      throw new ConvexError<HealthRecordValidationErrorData>({
        kind: "health_record_validation",
        issue: validationIssue,
      });
    }
    await Promise.all([
      validateHealthDocumentReference(ctx, {
        fileId: normalized.medicationDocumentId,
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        kind: "medication_authorization",
        signed,
      }),
      validateHealthDocumentReference(ctx, {
        fileId: normalized.immunizationDocumentId,
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        kind: "immunization_record",
        signed,
      }),
      validateHealthDocumentReference(ctx, {
        fileId: normalized.custodyDocumentId,
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        kind: "custody_document",
        signed,
      }),
      validateHealthDocumentReference(ctx, {
        fileId: normalized.actionPlanDocumentId,
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        kind: "action_plan_document",
        signed,
      }),
      validateHealthDocumentReference(ctx, {
        fileId: normalized.actionPlanDocumentIds?.allergy ?? null,
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        kind: "action_plan_document_allergy",
        signed,
      }),
      validateHealthDocumentReference(ctx, {
        fileId: normalized.actionPlanDocumentIds?.asthma ?? null,
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        kind: "action_plan_document_asthma",
        signed,
      }),
      validateHealthDocumentReference(ctx, {
        fileId: normalized.supportPlanDocumentId,
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        kind: "support_plan_document",
        signed,
      }),
    ]);
    const nextDocumentIds = new Set(healthDocumentIds(normalized));
    const missingProfileUpdates = {
      ...(!ctx.user.name?.trim() && normalized.guardian1Name
        ? { name: normalized.guardian1Name }
        : {}),
      ...(!ctx.user.phone?.trim() && normalized.guardian1Phone
        ? { phone: normalized.guardian1Phone }
        : {}),
    };
    if (Object.keys(missingProfileUpdates).length > 0) {
      await ctx.db.patch(ctx.user._id, missingProfileUpdates);
    }
    const now = Date.now();
    const standaloneSafeFields = {
      ...normalized,
      // These fields left the medical wizard. Preserve only legacy signed
      // evidence; hidden values from an unsigned legacy draft cannot inherit a
      // new medical-only signature or appear as unsigned medical changes.
      ...preservedLegacyAnnualParticipationFields(signed),
      ...preservedLegacyCookingWaiverFields(signed),
    };

    if (!args.submit) {
      // Documents reach the school WITHOUT a fresh signature; answers do not.
      // See `commitGuardianDocumentSlots`.
      const committedSlots = signed
        ? await commitGuardianDocumentSlots(ctx, {
            signed,
            incoming: normalized,
            guardianId: ctx.user._id,
          })
        : [];
      const nextDraftVersion = draftVersion + 1;
      const draftFields = standaloneSafeFields;
      if (draft) {
        await ctx.db.replace(draft._id, {
          scholarId: args.scholarId,
          guardianId: ctx.user._id,
          ...draftFields,
          baseRevision: signedRevision,
          version: nextDraftVersion,
          wizardVersion: 2,
          currentStep: args.currentStep,
          lastCompletedStep: args.lastCompletedStep,
          createdAt: draft.createdAt,
          updatedAt: now,
        });
      } else {
        await ctx.db.insert("scholarHealthRecordDrafts", {
          scholarId: args.scholarId,
          guardianId: ctx.user._id,
          ...draftFields,
          baseRevision: signedRevision,
          version: nextDraftVersion,
          wizardVersion: 2,
          currentStep: args.currentStep,
          lastCompletedStep: args.lastCompletedStep,
          createdAt: now,
          updatedAt: now,
        });
      }
      for (const previousFileId of [
        ...(draft ? healthDocumentIds(healthFieldsFrom(draft)) : []),
        // A document this save just unlinked from the signed record is no
        // longer held by anything either.
        ...committedSlots.flatMap((slot) => (slot.from ? [slot.from] : [])),
      ]) {
        if (!nextDocumentIds.has(previousFileId)) {
          await deleteHealthDocumentIfUnreferenced(ctx, previousFileId);
        }
      }
      for (const slot of committedSlots) {
        // A signed legal record changed outside the signature flow. Staff
        // attachments record the same three actions in the same table.
        await ctx.db.insert("auditLog", {
          actorUserId: ctx.user._id,
          action: !slot.to
            ? "health_document.remove"
            : slot.from
              ? "health_document.replace"
              : "health_document.upload",
          targetUserId: args.scholarId,
          at: now,
          detail: [
            `kind=${slot.kind}`,
            ...(slot.to ? [`fileId=${slot.to}`] : []),
            ...(slot.from ? [`supersededFileId=${slot.from}`] : []),
            "attachedInPlace=guardian",
          ].join(" "),
        });
      }
      const signedAfterCommit = signed ? await ctx.db.get(signed._id) : null;
      return {
        submitted: false,
        draftVersion: nextDraftVersion,
        signedRevision,
        // Is the school still looking at something older than what this
        // guardian just saved? Documents were committed above, so this is true
        // only for answers that genuinely need a fresh signature.
        unsentChanges: signedAfterCommit
          ? healthRecordAnswersDiffer(
              draftFields,
              healthFieldsFrom(signedAfterCommit),
            )
          : false,
      };
    }

    const nextRevision = signedRevision + 1;
    const previousDocumentIds = new Set([
      ...(signed ? healthDocumentIds(healthFieldsFrom(signed)) : []),
      ...(draft ? healthDocumentIds(healthFieldsFrom(draft)) : []),
    ]);
    let recordId: Id<"scholarHealthRecords">;
    if (signed) {
      await ctx.db.replace(signed._id, {
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        ...standaloneSafeFields,
        signerUserId: ctx.user._id,
        signedAt: now,
        submittedAt: now,
        ...(signed.standardProgramAcknowledgedAt !== undefined
          ? {
              // Legacy audit evidence only. New health signatures no longer
              // acknowledge the standalone annual participation form.
              standardProgramAcknowledgedAt:
                signed.standardProgramAcknowledgedAt,
            }
          : {}),
        revision: nextRevision,
        createdAt: signed.createdAt,
        updatedAt: now,
        ...(signed.confirmationEmailSent
          ? { confirmationEmailSent: true }
          : {}),
      });
      recordId = signed._id;
    } else {
      recordId = await ctx.db.insert("scholarHealthRecords", {
        scholarId: args.scholarId,
        guardianId: ctx.user._id,
        ...standaloneSafeFields,
        signerUserId: ctx.user._id,
        signedAt: now,
        submittedAt: now,
        revision: nextRevision,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (draft) await ctx.db.delete(draft._id);
    for (const previousFileId of previousDocumentIds) {
      if (!nextDocumentIds.has(previousFileId)) {
        await deleteHealthDocumentIfUnreferenced(ctx, previousFileId);
      }
    }
    if (!signed) {
      await ctx.scheduler.runAfter(
        0,
        internal.scholarHealthRecords.sendConfirmationEmail,
        { recordId, guardianId: ctx.user._id },
      );
    }
    await raiseAlert(ctx, {
      kind: "parent_health_record_update",
      severity: "info",
      title: `Parent updated health information — ${escapeSlackText(
        scholar.name ?? "a scholar",
      )}`,
      body: `A signed update is ready for staff review (revision ${nextRevision}).`,
      source: "scholarHealthRecords.saveHealthRecord",
      audience: "institution",
      scholarId: args.scholarId,
      deepLink: withBase(
        siteUrl(),
        `${scholarPath(scholarSlug(scholar.username, scholar._id))}/documents`,
      ),
    });

    return {
      submitted: true,
      draftVersion: 0,
      signedRevision: nextRevision,
      unsentChanges: false,
    };
  },
});

export const hasCompletedHealthRecord = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    await requireGuardianOf(ctx, scholarId);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const signed = await canonicalRecord(ctx, scholarId);
    const draft = await guardianDraft(ctx, scholarId, ctx.user._id);
    const outstandingForms: string[] = [];
    if (signed) {
      const fields = healthFieldsFrom(signed);
      // A slot is outstanding when its document is missing OR staff sent the
      // uploaded document back for replacement. Without the second check a
      // "needs replacement" verdict is invisible to the family: the pointer
      // survives, so a missing-only test never re-flags it.
      const needsReplacement = async (
        fileId: Id<"healthRecordFiles"> | null | undefined,
      ): Promise<boolean> => {
        if (!fileId) return false;
        const file = await ctx.db.get(fileId);
        return file?.reviewStatus === "needs_replacement";
      };
      if (
        fields.schoolMedicationMode !== "" &&
        fields.schoolMedicationMode !== "none" &&
        fields.medicationDocumentDelivery !== "provide_separately" &&
        (!fields.medicationDocumentId ||
          (await needsReplacement(fields.medicationDocumentId)))
      ) {
        outstandingForms.push("Medication authorization");
      }
      if (!fields.hap.none && fields.hap.allergy) {
        const allergyId = fields.actionPlanDocumentIds?.allergy;
        if (!allergyId || (await needsReplacement(allergyId))) {
          outstandingForms.push("Food allergy action plan");
        }
      }
      if (!fields.hap.none && fields.hap.asthma) {
        const asthmaId = fields.actionPlanDocumentIds?.asthma;
        if (!asthmaId || (await needsReplacement(asthmaId))) {
          outstandingForms.push("Asthma action plan");
        }
      }
    }
    const currentDraft =
      draft && draft.baseRevision === (signed?.revision ?? 0) ? draft : null;
    return {
      completed: signed !== null,
      submittedAt: signed?.submittedAt ?? null,
      hasDraft: currentDraft !== null,
      // Saved answers this guardian has not signed for yet, so the school is
      // still reading the older signed record. Documents are excluded by
      // construction — they are committed in place on save, so an upload never
      // leaves the family owing a signature (see `commitGuardianDocumentSlots`).
      unsentChanges:
        !!signed &&
        !!currentDraft &&
        healthRecordAnswersDiffer(
          healthFieldsFrom(currentDraft),
          healthFieldsFrom(signed),
        ),
      currentStep: currentDraft ? currentDraft.currentStep : signed ? 11 : 0,
      outstandingForms,
    };
  },
});

export const getHealthRecordForStaff = authedQuery({
  args: {
    scholarId: v.id("users"),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { scholarId, institutionScope }) => {
    await requireStaffScholarAccess(
      ctx,
      ctx.user,
      scholarId,
      institutionScope,
    );
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);

    const record = await canonicalRecord(ctx, scholarId);
    if (!record) return null;
    const guardian = await ctx.db.get(record.guardianId);
    const fields = healthFieldsFrom(record);
    const annual = await annualParticipationAnswers(ctx, scholarId);
    const [
      medicationDocument,
      immunizationDocument,
      custodyDocument,
      actionPlanDocument,
      allergyActionPlanDocument,
      asthmaActionPlanDocument,
      supportPlanDocument,
    ] = await Promise.all([
      healthDocumentView(ctx, fields.medicationDocumentId),
      healthDocumentView(ctx, fields.immunizationDocumentId),
      healthDocumentView(ctx, fields.custodyDocumentId),
      healthDocumentView(ctx, fields.actionPlanDocumentId),
      healthDocumentView(ctx, fields.actionPlanDocumentIds?.allergy ?? null),
      healthDocumentView(ctx, fields.actionPlanDocumentIds?.asthma ?? null),
      healthDocumentView(ctx, fields.supportPlanDocumentId),
    ]);
    const recordWithoutLegacyFields = { ...record };
    delete recordWithoutLegacyFields.immunizationDateSubmitted;
    delete recordWithoutLegacyFields.photoConsent;
    delete recordWithoutLegacyFields.fieldTripConsent;
    delete recordWithoutLegacyFields.physicalActivityConsent;
    delete recordWithoutLegacyFields.activityRestrictions;
    delete recordWithoutLegacyFields.swimConsent;
    return {
      ...recordWithoutLegacyFields,
      ...fields,
      ...(annual
        ? {
            publicMediaOptOut: annual.publicMediaOptOut,
            fieldTripRestriction: annual.fieldTripRestriction,
            fieldTripRestrictionDetails: annual.fieldTripRestrictionDetails,
            peRecessRestriction: annual.peRecessRestriction,
            peRecessRestrictionDetails: annual.peRecessRestrictionDetails,
            swimmingRestriction: annual.swimmingRestriction,
            swimmingRestrictionDetails: annual.swimmingRestrictionDetails,
          }
        : {}),
      medicationDocument,
      immunizationDocument,
      custodyDocument,
      actionPlanDocument,
      allergyActionPlanDocument,
      asthmaActionPlanDocument,
      supportPlanDocument,
      guardianName: guardian?.name ?? "Unknown",
      guardianEmail: guardian?.email ?? null,
    };
  },
});

/**
 * One-sheet data for staff to carry on field trips / outings.
 * Returns the canonical signed/committed health record for a scholar,
 * restricted to the emergency-critical fields. Only signed records are
 * returned; if no signed record exists, `record: null` is returned so the
 * print page can show a "no record on file" placeholder — draft data is
 * never exposed here.
 *
 * Gated to scholar-admin roles (teacher, school_admin, platform_admin,
 * operations staff) with institution scoping, the same gate as `getHealthRecordForStaff`.
 */
export const getOneSheetForStaff = authedQuery({
  args: {
    scholarId: v.id("users"),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { scholarId, institutionScope }) => {
    await requireStaffScholarAccess(ctx, ctx.user, scholarId, institutionScope);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);

    const scholar = await ctx.db.get(scholarId);
    if (!scholar) return null;

    const record = await canonicalRecord(ctx, scholarId);
    const fields = record ? healthFieldsFrom(record) : null;
    const annual = await annualParticipationAnswers(ctx, scholarId);

    return {
      scholar: {
        name: scholar.name ?? null,
        // Scholar profile photo (the `image` field on the users table).
        // NOTE: The publicMediaOptOut flag on the health record restricts
        // public/website/social-media use of a scholar's photo. It does NOT
        // apply here — this is an internal operational staff tool (field-trip
        // emergency reference). Including the photo regardless of opt-out is
        // intentional and correct; do not add a publicMediaOptOut gate here.
        image: scholar.image ?? null,
        dob: scholar.dateOfBirth ?? null,
        gradeLevel: scholar.gradeLevel ?? null,
      },
      record: record && fields
        ? {
            childName: record.childName ?? null,
            childPreferredName: record.childPreferredName ?? null,
            childDob: record.childDob ?? null,
            signedAt: record.signedAt,
            // Emergency authorization
            emergencyMedAuthAck: record.emergencyMedAuthAck ?? false,
            emergencyMedAuthNotes: record.emergencyMedAuthNotes ?? null,
            // Emergency contacts
            emergencyContacts: record.emergencyContacts ?? [],
            // Guardian contact info for emergency reference
            guardian1Name: record.guardian1Name ?? null,
            guardian1Phone: record.guardian1Phone ?? null,
            guardian2Name: record.guardian2?.name ?? null,
            guardian2Phone: record.guardian2?.phone ?? null,
            // Physician
            physicianName: record.physicianName ?? null,
            physicianPhone: record.physicianPhone ?? null,
            // Allergies
            noKnownAllergies: record.noKnownAllergies ?? false,
            allergies: record.allergies ?? [],
            allergyNotes: record.allergyNotes ?? null,
            // Medications
            noCurrentMedications: fields.noCurrentMedications ?? false,
            medications: fields.medications ?? [],
            schoolMedicationMode: fields.schoolMedicationMode ?? null,
            // Chronic conditions
            noChronicConditions: record.noChronicConditions ?? false,
            chronicConditions: record.chronicConditions ?? [],
            chronicConditionDetails: record.chronicConditionDetails ?? null,
            // Healthcare action plan
            hap: record.hap ?? null,
            // Activity restrictions
            fieldTripRestriction:
              annual?.fieldTripRestriction ?? fields.fieldTripRestriction ?? false,
            fieldTripRestrictionDetails:
              annual?.fieldTripRestrictionDetails ??
              fields.fieldTripRestrictionDetails ??
              null,
          }
        : null,
    };
  },
});

export const getEmergencyInfoForAide = internalQuery({
  args: {
    callerUserId: v.id("users"),
    scholarName: v.string(),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { callerUserId, scholarName, institutionScope }) => {
    const caller = await ctx.db.get(callerUserId);
    if (!caller) {
      throw new Error("Forbidden: scholar health records require staff access");
    }

    const candidates = await staffScholarCandidates(
      ctx,
      caller,
      institutionScope,
    );
    const match = matchScholarByName(
      scholarName,
      candidates.map((scholar) => ({
        ...scholar,
        name: scholar.name ?? scholar.username ?? "Scholar",
      })),
    );
    if (match.kind === "none") {
      return { status: "not_found" as const };
    }
    if (match.kind === "ambiguous") {
      return {
        status: "ambiguous" as const,
        candidates: match.candidates.map(
          (scholar) => scholar.name ?? scholar.username ?? "Scholar",
        ),
      };
    }

    const scholar = match.scholar;
    const record = await canonicalRecord(ctx, scholar._id);
    if (!record) {
      return {
        status: "no_record" as const,
        scholar: scholar.name ?? scholar.username ?? "Scholar",
      };
    }

    const [submittingGuardian, signerAccount, annual] = await Promise.all([
      ctx.db.get(record.guardianId),
      ctx.db.get(record.signerUserId),
      annualParticipationAnswers(ctx, scholar._id),
    ]);
    const fields = healthFieldsFrom(record);
    return {
      status: "found" as const,
      scholar: scholar.name ?? scholar.username ?? "Scholar",
      emergencyInfo: {
        emergencyMedicalAuthorization: {
          authorized: record.emergencyMedAuthAck,
          instructions: record.emergencyMedAuthNotes,
        },
        emergencyContacts: record.emergencyContacts,
        allergies: {
          noneKnown: record.noKnownAllergies,
          entries: record.allergies,
          notes: record.allergyNotes,
        },
        medications: {
          noneCurrent: fields.noCurrentMedications,
          entries: fields.medications.map((medication) => ({
            name: medication.name,
            purpose: medication.purpose,
            dosage: medication.dosage,
            frequency: medication.frequency,
            administrationInstructions:
              medication.administrationInstructions,
          })),
          schoolHandling: fields.schoolMedicationMode,
          authorizationDocumentation:
            fields.medicationDocumentDelivery === "upload"
              ? "uploaded"
              : fields.medicationDocumentDelivery === "provide_separately"
                ? "provide_separately"
                : fields.medicationDocumentDelivery === "not_required"
                  ? "not_required"
                  : "not_recorded",
        },
        chronicConditions: {
          noneKnown: record.noChronicConditions,
          conditions: record.chronicConditions,
          details: record.chronicConditionDetails,
        },
        healthcareActionPlan: {
          ...record.hap,
          documentation:
            fields.hapDocumentDelivery === "upload"
              ? "uploaded"
              : fields.hapDocumentDelivery === "provide_separately"
                ? "provide_separately"
                : "not_recorded",
        },
        custody: {
          notes: record.custodyNotes,
          documentation:
            fields.custodyDocumentDelivery === "upload"
              ? "uploaded"
              : fields.custodyDocumentDelivery === "provide_separately"
                ? "provide_separately"
                : "not_recorded",
        },
        developmentalBehavioralMentalHealth: {
          present: fields.developmentalConditionsPresent,
          conditions: fields.developmentalConditions,
          conditionsOther: fields.developmentalConditionsOther,
          supportNotes: fields.developmentalSupportNotes,
          successfulSupports: fields.developmentalSuccessfulSupports,
          supportPlans: fields.supportPlans,
          supportPlanOther: fields.supportPlanOther,
          supportPlanDocumentation:
            fields.supportPlanDocumentDelivery === "upload"
              ? "uploaded"
              : fields.supportPlanDocumentDelivery === "provide_separately"
                ? "provide_separately"
                : "not_recorded",
        },
        immunization: {
          status: fields.immunizationStatus,
          supportingDocumentation:
            fields.immunizationDocumentDelivery === "upload"
              ? "uploaded"
              : fields.immunizationDocumentDelivery === "provide_separately"
                ? "provide_separately"
                : "not_recorded",
        },
        standardProgram: {
          acknowledgmentStatus:
            annual?.submittedAt || record.standardProgramAcknowledgedAt
            ? "acknowledged"
            : "legacy_signed_choices",
          acknowledgedAt:
            annual?.submittedAt ?? record.standardProgramAcknowledgedAt ?? null,
          baselineIncludes: [
            "field_trips",
            "physical_education_and_recess",
            "swimming_when_offered",
            "private_school_communications",
            "public_website_and_social_media",
          ],
          publicMedia: {
            publicWebsiteAndSocialMediaOptOut:
              annual?.publicMediaOptOut ?? fields.publicMediaOptOut,
            privateSchoolCommunicationsIncluded: true,
          },
          exceptions: {
            fieldTrips: (annual?.fieldTripRestriction ?? fields.fieldTripRestriction)
              ? {
                  requested: true,
                  details:
                    annual?.fieldTripRestrictionDetails ??
                    fields.fieldTripRestrictionDetails,
                }
              : { requested: false },
            physicalEducationAndRecess:
              (annual?.peRecessRestriction ?? fields.peRecessRestriction)
              ? {
                  requested: true,
                  details:
                    annual?.peRecessRestrictionDetails ??
                    fields.peRecessRestrictionDetails,
                }
              : { requested: false },
            swimming: (annual?.swimmingRestriction ?? fields.swimmingRestriction)
              ? {
                  requested: true,
                  details:
                    annual?.swimmingRestrictionDetails ??
                    fields.swimmingRestrictionDetails,
                }
              : { requested: false },
          },
        },
        physician: {
          name: record.physicianName,
          phone: record.physicianPhone,
        },
        insurance: {
          plan: record.insurancePlan,
          idOrGroup: record.insuranceId,
        },
      },
      submission: {
        revision: record.revision,
        submittedAt: record.submittedAt,
        signedAt: record.signedAt,
        signedName: record.signerName,
        signerAccountName:
          signerAccount?.name ?? signerAccount?.username ?? "Unknown",
        submittedBy:
          submittingGuardian?.name ??
          submittingGuardian?.username ??
          "Unknown",
      },
    };
  },
});

type HealthRecordEmailData = {
  guardianEmail: string;
  confirmationEmailSent: boolean;
} | null;

export const sendConfirmationEmail = internalAction({
  args: {
    recordId: v.id("scholarHealthRecords"),
    guardianId: v.id("users"),
  },
  handler: async (ctx, { recordId, guardianId }) => {
    const record: HealthRecordEmailData = await ctx.runQuery(
      internal.scholarHealthRecords.getRecordForEmailQuery,
      { recordId, guardianId },
    );
    if (!record || record.confirmationEmailSent) return null;
    try {
      const { sendHealthRecordConfirmationEmail } = await import(
        "./lib/healthRecordConfirmationEmail"
      );
      const sent = await sendHealthRecordConfirmationEmail({
        to: record.guardianEmail,
      });
      if (sent) {
        await ctx.runMutation(
          internal.scholarHealthRecords.markConfirmationSent,
          { recordId },
        );
      }
    } catch (error) {
      console.error("Failed to send health-record confirmation email:", error);
      throw error;
    }
    return null;
  },
});

export const getRecordForEmailQuery = internalQuery({
  args: {
    recordId: v.id("scholarHealthRecords"),
    guardianId: v.id("users"),
  },
  handler: async (
    ctx,
    { recordId, guardianId },
  ): Promise<HealthRecordEmailData> => {
    const record = await ctx.db.get(recordId);
    if (!record || record.guardianId !== guardianId) return null;
    const guardian = await ctx.db.get(guardianId);
    const email = guardian?.email?.trim();
    if (!email) return null;
    return {
      guardianEmail: email,
      confirmationEmailSent: record.confirmationEmailSent === true,
    };
  },
});

export const markConfirmationSent = internalMutation({
  args: { recordId: v.id("scholarHealthRecords") },
  handler: async (ctx, { recordId }) => {
    const record = await ctx.db.get(recordId);
    if (!record) return null;
    await ctx.db.patch(recordId, { confirmationEmailSent: true });
    return null;
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// SLICE C — Medical clearance
//
// A physician's return-to-activity clearance is event-triggered and recurring,
// so it can't be a declarative slot on the signed annual record (there is no
// boolean that says "clearance is required now"). It is instead an explicit
// request lifecycle: staff open a request, the family (or front desk) attaches
// the physician document through the SAME upload pipeline the annual forms use,
// and staff review it on the SAME drawer pattern. Kept deliberately faithful to
// the proposal's "reuse the existing fabric" mandate — no standalone lane, no
// second dashboard, no new email helper. The attached file is kept alive past
// the 24h unreferenced-upload sweep by `medicalClearanceRequests.documentId`
// (see `healthDocumentIsReferenced`).
// ═══════════════════════════════════════════════════════════════════════════

// Statuses that mean a request is still "in flight" and should show on the
// dashboard / parent card. `cleared` / `cancelled` / `superseded` are resolved.
const ACTIVE_CLEARANCE_STATUSES = [
  "open",
  "pending_review",
  "needs_replacement",
] as const;

const MAX_CLEARANCE_REASON_LENGTH = 500;

function isActiveClearanceStatus(
  status: Doc<"medicalClearanceRequests">["status"],
): boolean {
  return (ACTIVE_CLEARANCE_STATUSES as readonly string[]).includes(status);
}

// Serialize a request for the client, resolving its attached document (if any)
// through the same view helper the signed-record documents use.
async function clearanceRequestView(
  ctx: QueryCtx,
  request: Doc<"medicalClearanceRequests">,
) {
  const document = await healthDocumentView(ctx, request.documentId ?? null);
  return {
    id: request._id,
    scholarId: request.scholarId,
    status: request.status,
    reason: request.reason,
    requestedAt: request.requestedAt,
    reviewNote: request.reviewNote ?? null,
    reviewedAt: request.reviewedAt ?? null,
    resolvedAt: request.resolvedAt ?? null,
    document,
  };
}

/**
 * Staff open a medical-clearance request for a scholar. Any request already in
 * flight is superseded, so at most one clearance is outstanding at a time — a
 * fresh injury/illness replaces a stale ask rather than stacking a second card.
 */
export const requestMedicalClearance = authedMutation({
  args: {
    scholarId: v.id("users"),
    reason: v.string(),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { scholarId, reason, institutionScope }) => {
    await requireStaffScholarAccess(ctx, ctx.user, scholarId, institutionScope);
    // Medical clearance rides the same primary-institution/Hawaii legal template as the
    // other physician forms — only requestable for a primary-institution
    // scholar (see convex/lib/formInstitutionGate.ts).
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== "scholar") {
      throw new Error("Scholar not found");
    }
    const cleanedReason = reason.trim();
    if (!cleanedReason) {
      throw new Error("A reason is required to request medical clearance.");
    }
    if (cleanedReason.length > MAX_CLEARANCE_REASON_LENGTH) {
      throw new Error("That reason is too long.");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("medicalClearanceRequests")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();

    const institutionId =
      (scholar as { institutionId?: Id<"institutions"> }).institutionId ??
      undefined;
    const requestId = await ctx.db.insert("medicalClearanceRequests", {
      scholarId,
      institutionId,
      requestedBy: ctx.user._id,
      requestedAt: now,
      reason: cleanedReason,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });

    // Supersede any still-active prior request AFTER inserting the replacement,
    // so `supersededBy` can point at it.
    for (const prior of existing) {
      if (!isActiveClearanceStatus(prior.status)) continue;
      await ctx.db.patch(prior._id, {
        status: "superseded",
        supersededBy: requestId,
        resolvedAt: now,
        updatedAt: now,
      });
    }

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "medical_clearance.request",
      targetUserId: scholarId,
      at: now,
      detail: `requestId=${requestId}`,
    });

    return { requestId };
  },
});

/**
 * Staff-facing list of every clearance request for a scholar (newest first),
 * for the health-record review surface. Institution-scoped like every other
 * staff read here.
 */
export const listMedicalClearanceRequestsForStaff = authedQuery({
  args: {
    scholarId: v.id("users"),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { scholarId, institutionScope }) => {
    await requireStaffScholarAccess(ctx, ctx.user, scholarId, institutionScope);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const requests = await ctx.db
      .query("medicalClearanceRequests")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    requests.sort((a, b) => b.requestedAt - a.requestedAt);
    return Promise.all(requests.map((request) => clearanceRequestView(ctx, request)));
  },
});

/**
 * Guardian-facing list, limited to the still-active requests. A resolved
 * (cleared / cancelled / superseded) request drops off the parent surface — the
 * clearance card is intentionally NOT always visible.
 */
export const listMedicalClearanceRequestsForGuardian = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    await requireGuardianOf(ctx, scholarId);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const requests = await ctx.db
      .query("medicalClearanceRequests")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect();
    const active = requests
      .filter((request) => isActiveClearanceStatus(request.status))
      .sort((a, b) => b.requestedAt - a.requestedAt);
    return Promise.all(active.map((request) => clearanceRequestView(ctx, request)));
  },
});

/**
 * Guardian starts an upload for a clearance request. Mirrors
 * `generateHealthDocumentUploadUrl`, but the created file is tied to a request
 * (kind `medical_clearance_document`) rather than a signed-record slot. The
 * client then PUTs the bytes and calls the shared `finalizeHealthDocumentUpload`
 * action, then `attachMedicalClearanceDocument`.
 */
export const generateMedicalClearanceUploadUrl = authedMutation({
  args: { requestId: v.id("medicalClearanceRequests") },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Clearance request not found");
    await requireGuardianOf(ctx, request.scholarId);
    await assertScholarFormsAllowed(ctx, ctx.user, request.scholarId);
    if (request.status !== "open" && request.status !== "needs_replacement") {
      throw new Error("This clearance request is not awaiting a document.");
    }
    const now = Date.now();
    const fileId = await ctx.db.insert("healthRecordFiles", {
      scholarId: request.scholarId,
      uploadedBy: ctx.user._id,
      kind: "medical_clearance_document",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      PENDING_UPLOAD_TTL_MS,
      internal.scholarHealthRecords.cleanupHealthRecordFile,
      { fileId, notBefore: now + PENDING_UPLOAD_TTL_MS },
    );
    return {
      fileId,
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
  },
});

/**
 * Guardian attaches a finalized clearance document to its request, moving the
 * request to `pending_review`. Replacing an earlier attachment discards the old
 * file once the pointer moves off it.
 */
export const attachMedicalClearanceDocument = authedMutation({
  args: {
    requestId: v.id("medicalClearanceRequests"),
    fileId: v.id("healthRecordFiles"),
  },
  handler: async (ctx, { requestId, fileId }) => {
    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Clearance request not found");
    await requireGuardianOf(ctx, request.scholarId);
    await assertScholarFormsAllowed(ctx, ctx.user, request.scholarId);
    if (request.status !== "open" && request.status !== "needs_replacement") {
      throw new Error("This clearance request is not awaiting a document.");
    }
    const file = await ctx.db.get(fileId);
    if (
      !file ||
      file.scholarId !== request.scholarId ||
      file.kind !== "medical_clearance_document" ||
      file.uploadedBy !== ctx.user._id ||
      !file.storageId ||
      !file.finalizedAt
    ) {
      throw new Error("The selected clearance document is unavailable");
    }

    const now = Date.now();
    const previousDocumentId = request.documentId;
    await ctx.db.patch(requestId, {
      documentId: fileId,
      status: "pending_review",
      // A re-upload after a "needs replacement" verdict starts a clean review.
      reviewNote: undefined,
      reviewedBy: undefined,
      reviewedAt: undefined,
      updatedAt: now,
    });
    if (previousDocumentId && previousDocumentId !== fileId) {
      await deleteHealthDocumentIfUnreferenced(ctx, previousDocumentId);
    }

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "medical_clearance.attach",
      targetUserId: request.scholarId,
      at: now,
      detail: `requestId=${requestId} fileId=${fileId}`,
    });

    return { ok: true as const };
  },
});

/**
 * Staff verdict on an attached clearance document. `accepted` clears the
 * scholar (resolving the request); `needs_replacement` sends the family back for
 * a new document. Mirrors `setHealthDocumentReviewStatus`, but keyed off the
 * request rather than a signed-record slot.
 */
export const reviewMedicalClearance = authedMutation({
  args: {
    requestId: v.id("medicalClearanceRequests"),
    reviewStatus: v.union(
      v.literal("accepted"),
      v.literal("needs_replacement"),
    ),
    reviewNote: v.optional(v.string()),
    institutionScope: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { requestId, reviewStatus, reviewNote, institutionScope },
  ) => {
    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Clearance request not found");
    await requireStaffScholarAccess(
      ctx,
      ctx.user,
      request.scholarId,
      institutionScope,
    );
    if (!request.documentId) {
      throw new Error("There is no clearance document to review yet.");
    }
    // A review verdict may only land on a document that is actually awaiting
    // one. Every (re)upload moves the request to `pending_review`, so this also
    // blocks re-reviewing an already-cleared request or acting on a
    // `needs_replacement` request whose rejected document was never replaced.
    if (request.status !== "pending_review") {
      throw new Error("This clearance request is not awaiting review.");
    }

    const now = Date.now();
    const cleanedNote = reviewNote?.trim() || undefined;
    await ctx.db.patch(requestId, {
      status: reviewStatus === "accepted" ? "cleared" : "needs_replacement",
      reviewNote: cleanedNote,
      reviewedBy: ctx.user._id,
      reviewedAt: now,
      resolvedAt: reviewStatus === "accepted" ? now : undefined,
      updatedAt: now,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "medical_clearance.review",
      targetUserId: request.scholarId,
      at: now,
      detail: `requestId=${requestId} reviewStatus=${reviewStatus}`,
    });

    return { ok: true as const };
  },
});

/**
 * Staff withdraw a clearance request that is no longer needed (e.g. opened in
 * error). Resolves it without clearing the scholar.
 */
export const cancelMedicalClearance = authedMutation({
  args: {
    requestId: v.id("medicalClearanceRequests"),
    reason: v.optional(v.string()),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { requestId, reason, institutionScope }) => {
    const request = await ctx.db.get(requestId);
    if (!request) throw new Error("Clearance request not found");
    await requireStaffScholarAccess(
      ctx,
      ctx.user,
      request.scholarId,
      institutionScope,
    );
    if (!isActiveClearanceStatus(request.status)) {
      throw new Error("This clearance request is already resolved.");
    }

    const now = Date.now();
    await ctx.db.patch(requestId, {
      status: "cancelled",
      reviewNote: reason?.trim() || request.reviewNote,
      resolvedAt: now,
      updatedAt: now,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "medical_clearance.cancel",
      targetUserId: request.scholarId,
      at: now,
      detail: `requestId=${requestId}`,
    });

    return { ok: true as const };
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// SLICE D — Current physical
//
// The physician-completed physical exam form. It is a STANDALONE item on the
// parent Forms list — a sibling of "Annual program participation" and the
// Cooking Lab waiver — never a step or a slot inside the signed Health &
// Emergency record. That ruling is why there is no new table and no attach
// step: the finalized `healthRecordFiles` row of kind `physical_exam_document`
// IS the record, "current physical" is simply the newest finalized row for the
// scholar, and earlier rows stay put as history. Finalization is also what
// keeps a row alive past the 24h unreferenced-upload sweep (see
// `healthDocumentIsReferenced`) — there is no pointer to vouch for it.
//
// Staff triage reuses the per-document `reviewStatus` on the row itself
// (`setHealthDocumentReviewStatus`), so there is no second verdict path.
//
// Deliberately out of scope for v1: expiry and exam-date transcription. A
// physical does not carry a renewal threshold here; do not invent one.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Every physical-exam row for a scholar, newest finalized first — the one
 * definition of "current physical" (index 0). Exported so the Form Completion
 * dashboard resolves the same thing this module serves the parent card, rather
 * than re-deriving it. A plain helper, not a Convex function: it does NO access
 * control, so gate first, then read.
 */
export async function physicalExamFiles(
  ctx: QueryCtx,
  scholarId: Id<"users">,
): Promise<Doc<"healthRecordFiles">[]> {
  const files = await ctx.db
    .query("healthRecordFiles")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  return files
    .filter(
      (file) =>
        file.kind === "physical_exam_document" && file.finalizedAt !== undefined,
    )
    .sort((a, b) => (b.finalizedAt ?? 0) - (a.finalizedAt ?? 0));
}

/**
 * Serialize one physical-exam row for a client. Deliberately NOT
 * `healthDocumentView`: that helper is shaped for the signed record's typed
 * slots (it carries `medicationExpirations`, and drops a row whose storage URL
 * has gone missing). Here a row with an unresolvable URL still has to be
 * REPORTED — the school has it on file, and a null `url` is an honest "the
 * download link is unavailable" rather than "no physical on file".
 */
function physicalExamView(
  file: Doc<"healthRecordFiles">,
  url: string | null,
) {
  return {
    fileId: file._id,
    fileName: file.fileName ?? "",
    uploadedAt: file.finalizedAt ?? file.createdAt,
    url,
    reviewStatus: file.reviewStatus ?? null,
    reviewNote: file.reviewNote ?? null,
    uploadedByStaff: file.uploadedByStaff === true,
  };
}

/**
 * Guardian starts a current-physical upload. Mirrors
 * `generateMedicalClearanceUploadUrl` — same gates, same pending row, same TTL
 * — but keyed on the scholar rather than a request, because a physical has no
 * request lifecycle: a guardian may upload one at any time, and uploading again
 * simply REPLACES the current one (the old row is retained as history).
 *
 * The client then PUTs the bytes and calls the shared
 * `finalizeHealthDocumentUpload` action. There is no third step: finalizing is
 * what makes the document current.
 */
export const generatePhysicalExamUploadUrl = authedMutation({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    await requireGuardianOf(ctx, scholarId);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const scholar = await ctx.db.get(scholarId);
    if (!scholar || scholar.role !== "scholar") {
      throw new Error("Scholar not found");
    }
    const now = Date.now();
    const fileId = await ctx.db.insert("healthRecordFiles", {
      scholarId,
      uploadedBy: ctx.user._id,
      kind: "physical_exam_document",
      createdAt: now,
    });
    await ctx.scheduler.runAfter(
      PENDING_UPLOAD_TTL_MS,
      internal.scholarHealthRecords.cleanupHealthRecordFile,
      { fileId, notBefore: now + PENDING_UPLOAD_TTL_MS },
    );
    return {
      fileId,
      uploadUrl: await ctx.storage.generateUploadUrl(),
    };
  },
});

/**
 * The guardian-facing "current physical": the newest finalized document, or
 * `null` when the school has nothing on file. History is deliberately NOT
 * returned here — a family needs to know what the school currently holds and
 * whether staff asked for a replacement, not an archive of superseded scans.
 */
export const getPhysicalExamForGuardian = authedQuery({
  args: { scholarId: v.id("users") },
  handler: async (ctx, { scholarId }) => {
    await requireGuardianOf(ctx, scholarId);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const [current] = await physicalExamFiles(ctx, scholarId);
    if (!current) return null;
    const url = current.storageId
      ? await ctx.storage.getUrl(current.storageId)
      : null;
    return physicalExamView(current, url);
  },
});

/**
 * The staff-facing list: every physical on file for a scholar, newest first,
 * with `isCurrent` on the newest row only. Staff DO see the history — a
 * replaced physical is evidence, and the drawer is where a reviewer compares
 * what arrived against what they rejected. Institution-scoped exactly like
 * `listMedicalClearanceRequestsForStaff`.
 */
export const listPhysicalExamsForStaff = authedQuery({
  args: {
    scholarId: v.id("users"),
    institutionScope: v.optional(v.string()),
  },
  handler: async (ctx, { scholarId, institutionScope }) => {
    await requireStaffScholarAccess(ctx, ctx.user, scholarId, institutionScope);
    await assertScholarFormsAllowed(ctx, ctx.user, scholarId);
    const files = await physicalExamFiles(ctx, scholarId);
    return await Promise.all(
      files.map(async (file, index) => ({
        ...physicalExamView(
          file,
          file.storageId ? await ctx.storage.getUrl(file.storageId) : null,
        ),
        reviewedAt: file.reviewedAt ?? null,
        isCurrent: index === 0,
      })),
    );
  },
});
