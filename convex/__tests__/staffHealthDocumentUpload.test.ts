// Staff-side health document upload — the access boundary, end to end.
//
// The whole point of this feature is that operations/health staff (the
// retired registrar role's successor) can file the paper
// immunization card the family handed to the front desk, and gains NOTHING
// else in the process. Every test here is about that "nothing else": the
// cognitive assessment they must not see, the other institution's scholar they
// must not touch, and the AI ingestion pipeline a custody document must never
// enter.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  emptyHealthRecordFields,
  type HealthRecordFields,
} from "../lib/healthRecord";
import {
  requireKindAccess,
  uploadableKinds,
  visibleUploadKinds,
} from "../lib/documentKinds";
import { FORMS_UNAVAILABLE_MESSAGE } from "../lib/formInstitutionGate";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = NonNullable<Doc<"users">["role"]>;

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\nfictional test file");

async function seedUser(
  t: ReturnType<typeof convexTest>,
  role: Role,
  username: string,
  institutionId?: Id<"institutions">,
) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
      institutionId,
      email: `${username}@example.test`,
      phone: "808-555-0100",
      address: "123 Test Street",
      ...(role === "scholar"
        ? { dateOfBirth: "2018-03-15", gradeLevel: "2" }
        : {}),
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    } as Omit<Doc<"authSessions">, "_id" | "_creationTime">),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedInstitution(
  t: ReturnType<typeof convexTest>,
  slug: string,
  isPrimary = false,
) {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: `${slug} School`,
      slug,
      kind: "school",
      ...(isPrimary ? { isPrimary: true } : {}),
    }),
  );
}

async function addMembership(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  role: Role,
  institutionId?: Id<"institutions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("memberships", { userId, role, institutionId }),
  );
}

function completeFields(
  overrides: Partial<HealthRecordFields> = {},
): HealthRecordFields {
  return {
    ...emptyHealthRecordFields(),
    childName: "Client-supplied child name",
    childDob: "2018-03-15",
    childGrade: "2",
    homeAddress: "123 Test Street",
    streetAddress: "123 Test Street",
    city: "Honolulu",
    state: "HI",
    zipCode: "96818",
    homePrimaryLanguage: "English",
    physicianName: "Dr. Test",
    physicianPhone: "808-555-0200",
    insurancePlan: "Test Plan",
    insuranceId: "ABC-123",
    guardian1Name: "Client-supplied guardian",
    guardian1Relationship: "legal_guardian",
    guardian1Phone: "808-555-0100",
    guardian1Email: "guardian@example.test",
    emergencyContacts: [
      {
        name: "Emergency Contact",
        relationship: "Aunt",
        phone: "808-555-0300",
        altPhone: "",
        canPickUp: true,
      },
    ],
    noKnownAllergies: true,
    noChronicConditions: true,
    noCurrentMedications: true,
    schoolMedicationMode: "none",
    medicationDocumentDelivery: "not_required",
    immunizationStatus: "up_to_date",
    // The line this feature exists to fix: the family said they'd bring the
    // card in, and until now nothing could ever change that.
    immunizationDocumentDelivery: "provide_separately",
    developmentalConditionsPresent: "no",
    developmentalConditions: [],
    developmentalConditionsOther: "",
    developmentalSupportNotes: "",
    developmentalSuccessfulSupports: "",
    supportPlans: [],
    supportPlanOther: "",
    supportPlanDocumentDelivery: "",
    supportPlanDocumentId: null,
    hap: {
      allergy: false,
      asthma: false,
      seizure: false,
      diabetes: false,
      behavioralHealth: false,
      other: false,
      otherDesc: "",
      none: true,
      notes: "",
    },
    emergencyMedAuthAck: true,
    publicMediaOptOut: false,
    fieldTripRestriction: false,
    fieldTripRestrictionDetails: "",
    peRecessRestriction: false,
    peRecessRestrictionDetails: "",
    swimmingRestriction: false,
    swimmingRestrictionDetails: "",
    cookingWaiverParentFullName: "Test guardian-a",
    cookingWaiverStudentFullName: "Scholar A",
    cookingWaiverDetails: "No known allergies.",
    cookingWaiverDate: "2026-08-14",
    signerName: "Test guardian-a",
    signerAgreement: true,
    ...overrides,
  };
}

/**
 * A scholar with a SIGNED health record (the precondition for any staff
 * attachment), plus operations/health staff (the retired registrar role's
 * successor: a `staff` membership + `health:manage` capability grant) and a
 * teacher in the same institution, and health staff in a different one.
 */
async function grantHealthCapability(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
  grantedBy: Id<"users">,
) {
  await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "health:manage",
      grantedBy,
      grantedAt: Date.now(),
    }),
  );
}

async function setupSchool({ isPrimary = false } = {}) {
  const t = convexTest(schema, modules);
  const institutionId = await seedInstitution(t, "alpha", isPrimary);
  const otherInstitutionId = await seedInstitution(t, "beta");
  const adminId = await seedUser(t, "platform_admin", "admin");
  const guardianId = await seedUser(t, "parent", "guardian-a");
  const scholarId = await seedUser(t, "scholar", "scholar-a", institutionId);
  const registrarId = await seedUser(
    t,
    "staff",
    "registrar-a",
    institutionId,
  );
  const teacherId = await seedUser(t, "teacher", "teacher-a", institutionId);
  const otherRegistrarId = await seedUser(
    t,
    "staff",
    "registrar-b",
    otherInstitutionId,
  );
  await addMembership(t, registrarId, "staff", institutionId);
  await addMembership(t, teacherId, "teacher", institutionId);
  await addMembership(t, otherRegistrarId, "staff", otherInstitutionId);
  await grantHealthCapability(t, registrarId, institutionId, adminId);
  await grantHealthCapability(t, otherRegistrarId, otherInstitutionId, adminId);
  await t.run((ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId: guardianId,
      scholarUserId: scholarId,
      createdBy: adminId,
    }),
  );
  return {
    t,
    institutionId,
    otherInstitutionId,
    adminId,
    guardianId,
    scholarId,
    registrarId,
    teacherId,
    otherRegistrarId,
  };
}

/**
 * convex-test's `t.run` hands back a schema-less ctx, so table docs come out as
 * a union of every table. These narrow it back to the one table we asked for.
 */
async function signedRecord(
  t: ReturnType<typeof convexTest>,
  scholarId: Id<"users">,
): Promise<Doc<"scholarHealthRecords"> | null> {
  const rows = (await t.run((ctx) =>
    ctx.db.query("scholarHealthRecords").collect(),
  )) as Doc<"scholarHealthRecords">[];
  return rows.find((r) => r.scholarId === scholarId) ?? null;
}

async function healthFile(
  t: ReturnType<typeof convexTest>,
  fileId: Id<"healthRecordFiles">,
): Promise<Doc<"healthRecordFiles"> | null> {
  return (await t.run((ctx) =>
    ctx.db.get(fileId),
  )) as Doc<"healthRecordFiles"> | null;
}

/**
 * A family that DID declare a healthcare action plan. Two of the five slots
 * only exist when the family's own answers call for them, so a fixture that
 * answers "none" has no action plan slot at all.
 */
const ACTION_PLAN_SELECTED: Partial<HealthRecordFields> = {
  hap: {
    allergy: false,
    asthma: false,
    seizure: true,
    diabetes: false,
    behavioralHealth: false,
    other: false,
    otherDesc: "",
    none: false,
    notes: "",
  },
  hapDocumentDelivery: "provide_separately",
};

const ALLERGY_PLAN_SELECTED: Partial<HealthRecordFields> = {
  hap: {
    allergy: true,
    asthma: false,
    seizure: false,
    diabetes: false,
    behavioralHealth: false,
    other: false,
    otherDesc: "",
    none: false,
    notes: "",
  },
  hapDocumentDelivery: "",
};

const ASTHMA_PLAN_SELECTED: Partial<HealthRecordFields> = {
  hap: {
    allergy: false,
    asthma: true,
    seizure: false,
    diabetes: false,
    behavioralHealth: false,
    other: false,
    otherDesc: "",
    none: false,
    notes: "",
  },
  hapDocumentDelivery: "",
};

// The entire reason the two slots are a keyed object (`actionPlanDocumentIds`)
// rather than a single pointer: a scholar can have BOTH a food allergy and
// asthma at once, and each needs its own physician-signed plan on file
// simultaneously — one must never clobber or hide the other.
const ALLERGY_AND_ASTHMA_SELECTED: Partial<HealthRecordFields> = {
  hap: {
    allergy: true,
    asthma: true,
    seizure: false,
    diabetes: false,
    behavioralHealth: false,
    other: false,
    otherDesc: "",
    none: false,
    notes: "",
  },
  hapDocumentDelivery: "",
};

async function submitHealthRecord(
  t: ReturnType<typeof convexTest>,
  guardianId: Id<"users">,
  scholarId: Id<"users">,
  overrides: Partial<HealthRecordFields> = {},
) {
  const guardian = await withUser(t, guardianId);
  await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
    scholarId,
    ...completeFields(overrides),
    expectedDraftVersion: 0,
    expectedSignedRevision: 0,
    currentStep: 10,
    lastCompletedStep: 9,
    submit: true,
  });
  return await signedRecord(t, scholarId);
}

async function staffUpload(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  scholarId: Id<"users">,
  kind:
    | "medication_authorization"
    | "immunization_record"
    | "custody_document"
    | "action_plan_document"
    | "support_plan_document",
  {
    institutionScope,
    fileName = "fictional-immunization-card.pdf",
    bytes = PDF_BYTES,
    type = "application/pdf",
  }: {
    institutionScope?: string;
    fileName?: string;
    bytes?: Uint8Array;
    type?: string;
  } = {},
) {
  const user = await withUser(t, userId);
  const ticket = await user.mutation(
    api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
    { scholarId, kind, institutionScope },
  );
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([Uint8Array.from(bytes).buffer], { type })),
  );
  const result = await user.action(
    api.scholarHealthRecords.finalizeStaffHealthDocumentUpload,
    { fileId: ticket.fileId, storageId, fileName, institutionScope },
  );
  return { user, ticket, storageId, result };
}

describe("document kind → capability map", () => {
  test("operations staff with a health:manage grant is offered health kinds only; a teacher gets both groups", () => {
    // The retired registrar role's successor: `staff` + the `health:manage`
    // capability grant (health-record access was always a SEPARATE grant from
    // `school:operations`, even though a registrar fixture always had both).
    const registrarKinds = uploadableKinds("staff", false, true).map(
      (k) => k.kind,
    );
    expect(registrarKinds).toEqual([
      "immunization_record",
      "medication_authorization",
      "action_plan_document",
      "action_plan_document_allergy",
      "action_plan_document_asthma",
      "custody_document",
      "support_plan_document",
      // `physical_exam_document` is deliberately absent: the Current physical
      // has no staff upload path (see the comment in lib/documentKinds.ts).
    ]);
    const teacherKinds = uploadableKinds("teacher").map((k) => k.kind);
    expect(teacherKinds).toContain("assessment");
    expect(teacherKinds).toContain("immunization_record");
    // A scholar is offered nothing at all.
    expect(uploadableKinds("scholar")).toHaveLength(0);
    // Plain staff with NO capability grant is offered nothing either.
    expect(uploadableKinds("staff")).toHaveLength(0);
  });

  test("the dialog hides health kinds when forms are unavailable for the scholar's school", () => {
    expect(
      visibleUploadKinds("teacher", false).map((kind) => kind.kind),
    ).toEqual([
      "assessment",
      "iep",
      "report_card",
      "identity_document",
      "parent_email",
      "observation",
      "other",
    ]);
    expect(visibleUploadKinds("staff", false, false, true)).toHaveLength(0);
    expect(visibleUploadKinds("teacher", true)).toEqual(
      uploadableKinds("teacher"),
    );
  });

  test("AC-4: the server refuses a kind the role was never offered", () => {
    // The dropdown never shows operations staff a "Cognitive Assessment";
    // the server says no regardless of what the request claims.
    expect(() => requireKindAccess("staff", "assessment", true, true)).toThrow(
      /may not upload/i,
    );
    expect(() => requireKindAccess("staff", "iep", true, true)).toThrow(
      /may not upload/i,
    );
    expect(() => requireKindAccess("scholar", "immunization_record")).toThrow(
      /may not upload/i,
    );
    expect(() =>
      requireKindAccess("staff", "not_a_kind", false, true),
    ).toThrow(/may not upload/i);
    expect(
      requireKindAccess("staff", "immunization_record", false, true).store,
    ).toBe("healthRecordFiles");
    expect(requireKindAccess("teacher", "assessment").store).toBe(
      "scholarDocuments",
    );
  });
});

describe("staff health document upload", () => {
  test("AC-7/AC-11: attaches in place without disturbing the signature", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    const signedBefore = await submitHealthRecord(t, guardianId, scholarId);
    expect(signedBefore).not.toBeNull();

    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    if (!result.ok) throw new Error(`Expected upload to finalize: ${result.error}`);

    const signedAfter = await signedRecord(t, scholarId);
    // The slot is filled and the delivery promise is redeemed…
    expect(signedAfter?.immunizationDocumentId).toBe(result.document.fileId);
    expect(signedAfter?.immunizationDocumentDelivery).toBe("upload");
    // …and NOTHING the guardian attested to has moved.
    expect(signedAfter?.revision).toBe(signedBefore!.revision);
    expect(signedAfter?.signedAt).toBe(signedBefore!.signedAt);
    expect(signedAfter?.signerName).toBe(signedBefore!.signerName);
    expect(signedAfter?.immunizationStatus).toBe(
      signedBefore!.immunizationStatus,
    );

    const file = await healthFile(t, result.document.fileId);
    expect(file?.uploadedByStaff).toBe(true);
    expect(file?.uploadedBy).toBe(registrarId);

    // AC-11: who filed a document onto a signed record is recorded.
    const audit = (await t.run((ctx) =>
      ctx.db.query("auditLog").collect(),
    )) as Doc<"auditLog">[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: "health_document.upload",
      actorUserId: registrarId,
      targetUserId: scholarId,
    });
    expect(audit[0].detail).toContain("kind=immunization_record");
    expect(audit[0].detail).toContain(`fileId=${result.document.fileId}`);
  });

  test("replacing an occupied slot re-points it and names the superseded file", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const first = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId, fileName: "first.pdf" },
    );
    if (!first.result.ok) throw new Error("Expected first upload to finalize");
    const second = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId, fileName: "second.pdf" },
    );
    if (!second.result.ok) throw new Error("Expected second upload to finalize");

    const after = await signedRecord(t, scholarId);
    expect(after?.immunizationDocumentId).toBe(second.result.document.fileId);
    // The superseded file is retained on purpose — a safety-critical record
    // does not get a silent hard delete.
    expect(await healthFile(t, first.result.document.fileId)).not.toBeNull();

    const audit = (await t.run((ctx) =>
      ctx.db.query("auditLog").collect(),
    )) as Doc<"auditLog">[];
    expect(audit.map((a) => a.action)).toEqual([
      "health_document.upload",
      "health_document.replace",
    ]);
    expect(audit[1].detail).toContain(
      `supersededFileId=${first.result.document.fileId}`,
    );
  });

  test("the healthcare action plan's asymmetric delivery field is flipped", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ACTION_PLAN_SELECTED);
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "action_plan_document",
      { institutionScope: institutionId },
    );
    if (!result.ok) throw new Error("Expected upload to finalize");
    const after = await signedRecord(t, scholarId);
    expect(after?.actionPlanDocumentId).toBe(result.document.fileId);
    // Not `actionPlanDocumentDelivery` — the record calls this one `hap*`.
    expect(after?.hapDocumentDelivery).toBe("upload");
  });

  test("refuses when the family has not submitted a health record yet", async () => {
    const { t, scholarId, registrarId, institutionId } = await setupSchool();
    const registrar = await withUser(t, registrarId);
    await expect(
      registrar.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        {
          scholarId,
          kind: "immunization_record",
          institutionScope: institutionId,
        },
      ),
    ).rejects.toThrow(/no submitted health record/i);
    // Nothing was staged, so the TTL sweeper has nothing to clean up.
    expect(
      await t.run((ctx) => ctx.db.query("healthRecordFiles").collect()),
    ).toHaveLength(0);
  });

  test("refuses health uploads for a non-primary scholar at ticket and finalize time", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId, adminId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const registrar = await withUser(t, registrarId);

    // Create a ticket while no institution is marked primary (the gate's
    // documented fresh-deployment fail-open), then establish a different school
    // as primary before finalize. The action must re-check the target scholar.
    const ticket = await registrar.mutation(
      api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
      {
        scholarId,
        kind: "immunization_record",
        institutionScope: institutionId,
      },
    );
    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], {
          type: "application/pdf",
        }),
      ),
    );
    await seedInstitution(t, "primary", true);

    await expect(
      registrar.action(
        api.scholarHealthRecords.finalizeStaffHealthDocumentUpload,
        {
          fileId: ticket.fileId,
          storageId,
          fileName: "card.pdf",
          institutionScope: institutionId,
        },
      ),
    ).rejects.toThrow(FORMS_UNAVAILABLE_MESSAGE);
    await expect(
      registrar.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        {
          scholarId,
          kind: "immunization_record",
          institutionScope: institutionId,
        },
      ),
    ).rejects.toThrow(FORMS_UNAVAILABLE_MESSAGE);

    const view = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(view.healthFormsAvailable).toBe(false);
    expect(view.healthDocumentsAvailableForRead).toBe(false);
    expect(view.canUploadHealthDocuments).toBe(false);
    expect(view.attachableHealthKinds).toHaveLength(0);

    await addMembership(t, adminId, "platform_admin");
    const admin = await withUser(t, adminId);
    const adminView = await admin.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId },
    );
    expect(adminView.healthFormsAvailable).toBe(false);
    expect(adminView.healthDocumentsAvailableForRead).toBe(true);
    expect(adminView.canUploadHealthDocuments).toBe(false);
    expect(adminView.attachableHealthKinds).toHaveLength(0);
  });

  test("keeps health uploads available for a primary-institution scholar", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool({ isPrimary: true });
    await submitHealthRecord(t, guardianId, scholarId);
    const registrar = await withUser(t, registrarId);

    const ticket = await registrar.mutation(
      api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
      {
        scholarId,
        kind: "immunization_record",
        institutionScope: institutionId,
      },
    );
    expect(ticket.fileId).toBeTruthy();

    const view = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(view.healthFormsAvailable).toBe(true);
    expect(view.canUploadHealthDocuments).toBe(true);
    expect(view.attachableHealthKinds).toContain("immunization_record");
  });

  test("health:manage grants staff the health-only record and document path, not school operations", async () => {
    const { t, guardianId, scholarId, institutionId, adminId } =
      await setupSchool({ isPrimary: true });
    await submitHealthRecord(t, guardianId, scholarId);
    const healthStaffId = await seedUser(t, "staff", "health-staff");
    const operationsStaffId = await seedUser(t, "staff", "operations-staff");
    await addMembership(t, healthStaffId, "staff", institutionId);
    await addMembership(t, operationsStaffId, "staff", institutionId);
    await t.run(async (ctx) => {
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: healthStaffId,
        institutionId,
        capability: "health:manage",
        grantedBy: adminId,
        grantedAt: Date.now(),
      });
      await ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: operationsStaffId,
        institutionId,
        capability: "school:operations",
        grantedBy: adminId,
        grantedAt: Date.now(),
      });
    });

    const healthStaff = await withUser(t, healthStaffId);
    const operationsStaff = await withUser(t, operationsStaffId);
    await expect(
      operationsStaff.query(api.scholarHealthRecords.getHealthRecordForStaff, {
        scholarId,
        institutionScope: institutionId,
      }),
    ).rejects.toThrow(/health access required/i);
    await expect(
      healthStaff.query(api.scholarHealthRecords.getHealthRecordForStaff, {
        scholarId,
        institutionScope: institutionId,
      }),
    ).resolves.toMatchObject({ scholarId });

    const ticket = await healthStaff.mutation(
      api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
      {
        scholarId,
        kind: "immunization_record",
        institutionScope: institutionId,
      },
    );
    expect(ticket.fileId).toBeTruthy();
    const merged = await healthStaff.query(api.scholarDocuments.listDocumentsForStaff, {
      scholarId,
      institutionScope: institutionId,
    });
    expect(merged).toMatchObject({
      canReadScholarDocuments: false,
      healthDocumentsVisible: true,
      canUploadHealthDocuments: true,
    });
  });

  test("keeps the missing-submission state for a primary-institution scholar", async () => {
    const { t, scholarId, registrarId, institutionId } = await setupSchool({
      isPrimary: true,
    });
    const registrar = await withUser(t, registrarId);

    const view = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(view.healthFormsAvailable).toBe(true);
    expect(view.canUploadHealthDocuments).toBe(false);
    expect(view.attachableHealthKinds).toHaveLength(0);
  });

  test("AC-8: cross-institution staff cannot upload, at either step", async () => {
    const {
      t,
      guardianId,
      scholarId,
      registrarId,
      otherRegistrarId,
      institutionId,
      otherInstitutionId,
    } = await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);

    const outsider = await withUser(t, otherRegistrarId);
    // Step 1: refused before a single byte is uploaded.
    await expect(
      outsider.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        {
          scholarId,
          kind: "immunization_record",
          institutionScope: otherInstitutionId,
        },
      ),
    ).rejects.toThrow(/current context/i);
    // …and no lens value gets them in, including the omitted-scope default.
    await expect(
      outsider.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        { scholarId, kind: "immunization_record" },
      ),
    ).rejects.toThrow(/current context/i);

    // Step 3: the commit re-checks the boundary rather than trusting the
    // ticket. Move the scholar out of the operations/health staffer's institution between
    // generating the ticket and finalizing it, and the file is refused.
    const insider = await withUser(t, registrarId);
    const ticket = await insider.mutation(
      api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
      {
        scholarId,
        kind: "immunization_record",
        institutionScope: institutionId,
      },
    );
    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], {
          type: "application/pdf",
        }),
      ),
    );
    await t.run((ctx) =>
      ctx.db.patch(scholarId, { institutionId: otherInstitutionId }),
    );
    await expect(
      insider.action(
        api.scholarHealthRecords.finalizeStaffHealthDocumentUpload,
        {
          fileId: ticket.fileId,
          storageId,
          fileName: "card.pdf",
          institutionScope: institutionId,
        },
      ),
    ).rejects.toThrow(/current context/i);
    await t.run((ctx) => ctx.db.patch(scholarId, { institutionId }));

    // Nor can another staff member finalize someone else's ticket.
    await expect(
      outsider.action(
        api.scholarHealthRecords.finalizeStaffHealthDocumentUpload,
        {
          fileId: ticket.fileId,
          storageId,
          fileName: "card.pdf",
          institutionScope: otherInstitutionId,
        },
      ),
    ).rejects.toThrow(/unavailable/i);
  });

  test("AC-9: a health upload never touches scholarDocuments or the AI pipeline", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "custody_document",
      { institutionScope: institutionId },
    );
    if (!result.ok) throw new Error("Expected upload to finalize");

    expect(
      await t.run((ctx) => ctx.db.query("scholarDocuments").collect()),
    ).toHaveLength(0);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    // Never the extract/redact pass, whose redactedSummary reaches the
    // scholar-facing tutor — nor anything else in the scholar-documents
    // pipeline.
    expect(
      scheduled.filter((s) => s.name.includes("scholarDocument")),
    ).toHaveLength(0);
  });

  test("a scholar and a parent cannot use the staff upload path", async () => {
    const { t, guardianId, scholarId, institutionId } = await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    for (const userId of [guardianId, scholarId]) {
      const impostor = await withUser(t, userId);
      await expect(
        impostor.mutation(
          api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
          {
            scholarId,
            kind: "immunization_record",
            institutionScope: institutionId,
          },
        ),
      ).rejects.toThrow();
    }
  });
});

describe("merged staff document list", () => {
  test("AC-3: operations/health staff sees health documents and NOT cognitive assessments", async () => {
    const {
      t,
      guardianId,
      scholarId,
      registrarId,
      teacherId,
      institutionId,
    } = await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);

    // A teacher files a cognitive assessment through the untouched path.
    const teacher = await withUser(t, teacherId);
    const assessmentStorageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], {
          type: "application/pdf",
        }),
      ),
    );
    await teacher.mutation(api.scholarDocuments.registerUpload, {
      scholarId,
      kind: "assessment",
      title: "WISC-V report",
      fileStorageId: assessmentStorageId,
      fileMimeType: "application/pdf",
    });
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    if (!result.ok) throw new Error("Expected upload to finalize");

    const registrar = await withUser(t, registrarId);
    const registrarView = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(registrarView.canReadScholarDocuments).toBe(false);
    expect(registrarView.documents).toHaveLength(0);
    expect(registrarView.healthDocuments).toHaveLength(1);
    expect(registrarView.healthDocuments[0]).toMatchObject({
      kind: "immunization_record",
      fileId: result.document.fileId,
      uploadedByStaff: true,
    });
    // Nothing in the payload leaks the assessment — not its title, not a hint.
    expect(JSON.stringify(registrarView)).not.toContain("WISC-V");

    // AC-10: the teacher still gets both halves.
    const teacherView = await teacher.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(teacherView.canReadScholarDocuments).toBe(true);
    expect(teacherView.documents).toHaveLength(1);
    expect(teacherView.documents[0].title).toBe("WISC-V report");
    expect(teacherView.healthDocuments).toHaveLength(1);
  });

  test("only the SIGNED record's slots are listed, not abandoned draft uploads", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    // A guardian stages a file but never submits it into a slot.
    const guardian = await withUser(t, guardianId);
    const ticket = await guardian.mutation(
      api.scholarHealthRecords.generateHealthDocumentUploadUrl,
      { scholarId, kind: "medication_authorization" },
    );
    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], {
          type: "application/pdf",
        }),
      ),
    );
    await guardian.action(
      api.scholarHealthRecords.finalizeHealthDocumentUpload,
      { fileId: ticket.fileId, storageId, fileName: "draft-only.pdf" },
    );

    const registrar = await withUser(t, registrarId);
    const view = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(view.healthDocuments).toHaveLength(0);
  });

  test("AC-8: operations/health staff outside the scholar's institution is refused the list", async () => {
    const {
      t,
      guardianId,
      scholarId,
      otherRegistrarId,
      otherInstitutionId,
    } = await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const outsider = await withUser(t, otherRegistrarId);
    await expect(
      outsider.query(api.scholarDocuments.listDocumentsForStaff, {
        scholarId,
        institutionScope: otherInstitutionId,
      }),
    ).rejects.toThrow(/current context/i);
  });

  test("a scholar cannot call the merged list at all", async () => {
    const { t, guardianId, scholarId, institutionId } = await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const scholar = await withUser(t, scholarId);
    await expect(
      scholar.query(api.scholarDocuments.listDocumentsForStaff, {
        scholarId,
        institutionScope: institutionId,
      }),
    ).rejects.toThrow();
  });
  test("a teacher on the all-institutions lens is TOLD the health half was not read", async () => {
    const { t, guardianId, scholarId, registrarId, teacherId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    if (!result.ok) throw new Error("Expected upload to finalize");

    const teacher = await withUser(t, teacherId);
    // Scoped to the institution: the health half resolves and is shown.
    const scoped = await teacher.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(scoped.healthDocumentsVisible).toBe(true);
    expect(scoped.healthDocuments).toHaveLength(1);

    // On the all-institutions lens the health candidate set is empty, so the
    // half is not read. The list must SAY so — an empty array here means "we
    // didn't look", and on this data that must not be mistaken for "nothing on
    // file".
    const allLens = await teacher.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: "all" },
    );
    expect(allLens.healthDocumentsVisible).toBe(false);
    expect(allLens.healthDocuments).toHaveLength(0);
    expect(allLens.canUploadHealthDocuments).toBe(false);
    // …and the rest of their list is untouched, so nothing regresses.
    expect(allLens.canReadScholarDocuments).toBe(true);
  });

  test("operations/health staff out of scope still hard-throws rather than reporting an empty half", async () => {
    const { t, guardianId, scholarId, otherRegistrarId, otherInstitutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const otherRegistrar = await withUser(t, otherRegistrarId);
    await expect(
      otherRegistrar.query(api.scholarDocuments.listDocumentsForStaff, {
        scholarId,
        institutionScope: otherInstitutionId,
      }),
    ).rejects.toThrow(/not in your institution|Forbidden/i);
  });
});

describe("staff-attached documents are labelled as such", () => {
  test("getHealthRecordForStaff flags a staff upload and not a parent one", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    // The guardian attaches their own medication authorization…
    const guardian = await withUser(t, guardianId);
    const ticket = await guardian.mutation(
      api.scholarHealthRecords.generateHealthDocumentUploadUrl,
      { scholarId, kind: "medication_authorization" },
    );
    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], {
          type: "application/pdf",
        }),
      ),
    );
    const parentUpload = await guardian.action(
      api.scholarHealthRecords.finalizeHealthDocumentUpload,
      { fileId: ticket.fileId, storageId, fileName: "parent-med-auth.pdf" },
    );
    if (!parentUpload.ok) throw new Error("Expected parent upload to finalize");
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields({
        schoolMedicationMode: "stored_at_school",
        medicationDocumentDelivery: "upload",
        medicationDocumentId: parentUpload.document.fileId,
      }),
      expectedDraftVersion: 0,
      expectedSignedRevision: 0,
      currentStep: 10,
      lastCompletedStep: 9,
      submit: true,
    });

    // …and the front desk files the immunization card.
    const staffResult = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    if (!staffResult.result.ok) throw new Error("Expected upload to finalize");

    const registrar = await withUser(t, registrarId);
    const view = await registrar.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(view?.immunizationDocument?.uploadedByStaff).toBe(true);
    // A parent-attested document must never wear the staff badge.
    expect(view?.medicationDocument?.uploadedByStaff).toBe(false);
  });
});

describe("a guardian re-submit cannot silently discard a staff attachment", () => {
  /**
   * The hazard is specific and it is NOT hypothetical. A staff attachment
   * deliberately leaves `revision` alone (it changes no parent-attested
   * answer), and a guardian's draft counts as current when
   * `draft.baseRevision === signedRevision`. So a draft saved BEFORE the
   * attachment stays "current" afterwards, still carrying an empty slot — and
   * `saveHealthRecord` REPLACES the signed record wholesale, then garbage
   * collects any file the new field set no longer references. Without a guard,
   * one guardian re-submit both unlinks the immunization card and deletes the
   * blob.
   */
  test("a stale draft that predates the attachment does not clear the slot or delete the file", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const guardian = await withUser(t, guardianId);

    // The guardian starts a draft while the slot is still empty.
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields(),
      expectedDraftVersion: 0,
      expectedSignedRevision: 1,
      currentStep: 3,
      lastCompletedStep: 2,
      submit: false,
    });

    // The front desk files the card that just arrived on paper.
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    const attachedFileId = result.ok ? result.document.fileId : null;
    expect(attachedFileId).not.toBeNull();
    const attached = await signedRecord(t, scholarId);
    expect(attached?.immunizationDocumentId).toBe(attachedFileId);

    // …and only then does the guardian finish and submit their stale draft.
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields(),
      expectedDraftVersion: 1,
      expectedSignedRevision: 1,
      currentStep: 10,
      lastCompletedStep: 9,
      submit: true,
    });

    const after = await signedRecord(t, scholarId);
    expect(after?.revision).toBe(2);
    expect(after?.immunizationDocumentId).toBe(attachedFileId);
    expect(after?.immunizationDocumentDelivery).toBe("upload");
    expect(await healthFile(t, attachedFileId!)).not.toBeNull();
  });

  test("the guardian's own form shows a slot the office filled while their draft was open", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const guardian = await withUser(t, guardianId);
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields(),
      expectedDraftVersion: 0,
      expectedSignedRevision: 1,
      currentStep: 3,
      lastCompletedStep: 2,
      submit: false,
    });
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    const attachedFileId = result.ok ? result.document.fileId : null;

    // The form reads through the still-"current" draft, which never held this
    // pointer. It must not tell the family the card is missing.
    const view = await guardian.query(
      api.scholarHealthRecords.getHealthRecord,
      { scholarId },
    );
    expect(view.immunizationDocumentId).toBe(attachedFileId);
    expect(view.immunizationDocument?.uploadedByStaff).toBe(true);
    expect(view.immunizationDocumentDelivery).toBe("upload");
  });

  test("a guardian can still remove a document THEY uploaded", async () => {
    const { t, guardianId, scholarId } = await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const guardian = await withUser(t, guardianId);

    // The guardian's own upload, through the guardian path.
    const ticket = await guardian.mutation(
      api.scholarHealthRecords.generateHealthDocumentUploadUrl,
      { scholarId, kind: "immunization_record" },
    );
    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], {
          type: "application/pdf",
        }),
      ),
    );
    const uploaded = await guardian.action(
      api.scholarHealthRecords.finalizeHealthDocumentUpload,
      { fileId: ticket.fileId, storageId, fileName: "family-card.pdf" },
    );
    expect(uploaded.ok).toBe(true);

    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields({
        immunizationDocumentDelivery: "upload",
        immunizationDocumentId: ticket.fileId,
      }),
      expectedDraftVersion: 0,
      expectedSignedRevision: 1,
      currentStep: 10,
      lastCompletedStep: 9,
      submit: true,
    });
    expect((await signedRecord(t, scholarId))?.immunizationDocumentId).toBe(
      ticket.fileId,
    );

    // Changing their mind back to "I'll bring it in" must still work — the
    // guard protects staff attachments, not every pointer.
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields(),
      expectedDraftVersion: 0,
      expectedSignedRevision: 2,
      currentStep: 10,
      lastCompletedStep: 9,
      submit: true,
    });
    const after = await signedRecord(t, scholarId);
    expect(after?.immunizationDocumentId ?? null).toBeNull();
    expect(after?.immunizationDocumentDelivery).toBe("provide_separately");
  });
});

/**
 * Two of the five slots are conditional on the family's own answers, and
 * `normalizeHealthRecordBusinessFields` clears them on every READ when the
 * condition isn't met. A raw slot patch against one of those therefore
 * "succeeds" and then evaporates. These assert on what a reader SEES, not on
 * the raw document — the distinction the original test missed.
 */
describe("conditional health slots", () => {
  test("a staff-filed action plan is visible to every reader, not just the raw row", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ACTION_PLAN_SELECTED);
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "action_plan_document",
      { institutionScope: institutionId },
    );
    if (!result.ok) throw new Error("Expected upload to finalize");

    const registrar = await withUser(t, registrarId);
    const list = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(list.healthDocuments.map((d) => d.kind)).toContain(
      "action_plan_document",
    );
    const staffRecord = await registrar.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(staffRecord?.actionPlanDocument?.fileId).toBe(result.document.fileId);
  });

  test("refuses an action plan document when the family selected no action plan", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    // The default fixture answers hap.none — there is no slot to attach to.
    await submitHealthRecord(t, guardianId, scholarId);
    const registrar = await withUser(t, registrarId);
    await expect(
      registrar.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        { scholarId, kind: "action_plan_document", institutionScope: institutionId },
      ),
    ).rejects.toThrow(/no healthcare action plan selected/i);
    // Nothing was staged, so no blob is left for the TTL sweep to find.
    const files = await t.run((ctx) =>
      ctx.db.query("healthRecordFiles").collect(),
    );
    expect(files).toHaveLength(0);
  });

  test("refuses a support plan document when the family selected no support plan", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const registrar = await withUser(t, registrarId);
    await expect(
      registrar.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        { scholarId, kind: "support_plan_document", institutionScope: institutionId },
      ),
    ).rejects.toThrow(/no support plan selected/i);
  });

  test("the dropdown is told which kinds are live, so it can't offer a refused one", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const registrar = await withUser(t, registrarId);
    const list = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    // The three unconditional slots stay offered; the two the family's answers
    // switched off do not.
    expect(list.attachableHealthKinds.sort()).toEqual([
      "custody_document",
      "immunization_record",
      "medication_authorization",
    ]);
  });

  test("selecting an action plan turns its slot back on", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ACTION_PLAN_SELECTED);
    const registrar = await withUser(t, registrarId);
    const list = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(list.attachableHealthKinds).toContain("action_plan_document");
  });

  test("an allergy plan activates only the allergy slot", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ALLERGY_PLAN_SELECTED);
    const registrar = await withUser(t, registrarId);
    const list = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    // Allergy routes to its dedicated slot; the generic and asthma slots stay
    // closed because the family reported neither a generic plan nor asthma.
    expect(list.attachableHealthKinds).toContain("action_plan_document_allergy");
    expect(list.attachableHealthKinds).not.toContain(
      "action_plan_document_asthma",
    );
    expect(list.attachableHealthKinds).not.toContain("action_plan_document");
  });

  test("an asthma plan activates only the asthma slot", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ASTHMA_PLAN_SELECTED);
    const registrar = await withUser(t, registrarId);
    const list = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(list.attachableHealthKinds).toContain("action_plan_document_asthma");
    expect(list.attachableHealthKinds).not.toContain(
      "action_plan_document_allergy",
    );
    expect(list.attachableHealthKinds).not.toContain("action_plan_document");
  });

  test("refuses an asthma action plan when the family did not report asthma", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ALLERGY_PLAN_SELECTED);
    const registrar = await withUser(t, registrarId);
    await expect(
      registrar.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        {
          scholarId,
          kind: "action_plan_document_asthma",
          institutionScope: institutionId,
        },
      ),
    ).rejects.toThrow(/does not report asthma/i);
  });

  test("both allergy and asthma plans activate simultaneously, and staff can attach a distinct document to each without disturbing the other", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ALLERGY_AND_ASTHMA_SELECTED);
    const registrar = await withUser(t, registrarId);

    // Both slots are open at once — neither condition suppresses the other.
    const list = await registrar.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(list.attachableHealthKinds).toContain("action_plan_document_allergy");
    expect(list.attachableHealthKinds).toContain("action_plan_document_asthma");

    async function attach(
      kind: "action_plan_document_allergy" | "action_plan_document_asthma",
      fileName: string,
    ) {
      const ticket = await registrar.mutation(
        api.scholarHealthRecords.generateStaffHealthDocumentUploadUrl,
        { scholarId, kind, institutionScope: institutionId },
      );
      const storageId = await t.run((ctx) =>
        ctx.storage.store(
          new Blob([Uint8Array.from(PDF_BYTES).buffer], {
            type: "application/pdf",
          }),
        ),
      );
      const result = await registrar.action(
        api.scholarHealthRecords.finalizeStaffHealthDocumentUpload,
        { fileId: ticket.fileId, storageId, fileName, institutionScope: institutionId },
      );
      if (!result.ok) throw new Error(result.error);
      return result.document.fileId;
    }

    const allergyFileId = await attach(
      "action_plan_document_allergy",
      "allergy-eap.pdf",
    );
    const asthmaFileId = await attach(
      "action_plan_document_asthma",
      "asthma-eap.pdf",
    );

    // Distinct files, both live on the record at once — the sibling-preserving
    // patch (`healthSlotPatch`) never overwrote one when the other was set.
    expect(allergyFileId).not.toBe(asthmaFileId);
    const record = await signedRecord(t, scholarId);
    expect(record?.actionPlanDocumentIds?.allergy).toBe(allergyFileId);
    expect(record?.actionPlanDocumentIds?.asthma).toBe(asthmaFileId);

    const allergyFile = await healthFile(t, allergyFileId);
    const asthmaFile = await healthFile(t, asthmaFileId);
    expect(allergyFile?.kind).toBe("action_plan_document_allergy");
    expect(asthmaFile?.kind).toBe("action_plan_document_asthma");
  });
});

/**
 * The preserve guard writes staff-owned file ids into the GUARDIAN's draft.
 * A later staff replace moves the canonical pointer, and
 * `validateHealthDocumentReference` only tolerates a file the guardian doesn't
 * own while it is canonical — so without reconciliation the guardian's every
 * later save throws an error they can neither see the cause of nor fix.
 */
describe("a staff replace does not strand the guardian's draft", () => {
  test("a guardian can still save after staff replace the document they were shown", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId);
    const first = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    if (!first.result.ok) throw new Error("Expected first upload to finalize");

    // The guardian opens the form (which now shows the staff file) and saves a
    // draft, persisting the staff-owned id into their own draft row.
    const guardian = await withUser(t, guardianId);
    const shown = await guardian.query(
      api.scholarHealthRecords.getHealthRecord,
      { scholarId },
    );
    expect(shown.immunizationDocumentId).toBe(first.result.document.fileId);
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields({
        immunizationDocumentId: shown.immunizationDocumentId,
        immunizationDocumentDelivery: "upload",
      }),
      expectedDraftVersion: 0,
      expectedSignedRevision: 1,
      currentStep: 5,
      lastCompletedStep: 4,
      submit: false,
    });

    // The office scanned the wrong page and re-files it.
    const second = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId, fileName: "corrected-card.pdf" },
    );
    if (!second.result.ok) throw new Error("Expected replace to finalize");

    // The guardian's next save carries the now-stale id. It must reconcile,
    // not throw "belongs to another draft" at someone who can't act on it.
    await expect(
      guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
        scholarId,
        ...completeFields({
          immunizationDocumentId: first.result.document.fileId,
          immunizationDocumentDelivery: "upload",
        }),
        expectedDraftVersion: 1,
        expectedSignedRevision: 1,
        currentStep: 6,
        lastCompletedStep: 5,
        submit: true,
      }),
    ).resolves.toBeDefined();

    const after = await signedRecord(t, scholarId);
    expect(after?.immunizationDocumentId).toBe(second.result.document.fileId);
  });
});

describe("a 'needs replacement' verdict re-opens the family's follow-up", () => {
  // When staff send an uploaded document back, the pointer deliberately stays
  // put (the file is still on record). A missing-only outstanding check would
  // therefore never re-surface it to the family, and the request to replace it
  // would be invisible. `hasCompletedHealthRecord` must treat a
  // `needs_replacement` slot as outstanding.
  test("a medication authorization sent back re-appears, and accepting it clears it", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    const guardian = await withUser(t, guardianId);

    const ticket = await guardian.mutation(
      api.scholarHealthRecords.generateHealthDocumentUploadUrl,
      { scholarId, kind: "medication_authorization" },
    );
    const storageId = await t.run((ctx) =>
      ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], {
          type: "application/pdf",
        }),
      ),
    );
    const upload = await guardian.action(
      api.scholarHealthRecords.finalizeHealthDocumentUpload,
      { fileId: ticket.fileId, storageId, fileName: "med-auth.pdf" },
    );
    if (!upload.ok) throw new Error("Expected the parent upload to finalize");
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields({
        schoolMedicationMode: "stored_at_school",
        medicationDocumentDelivery: "upload",
        medicationDocumentId: upload.document.fileId,
      }),
      expectedDraftVersion: 0,
      expectedSignedRevision: 0,
      currentStep: 10,
      lastCompletedStep: 9,
      submit: true,
    });

    // On file and pending review — nothing outstanding.
    const pending = await guardian.query(
      api.scholarHealthRecords.hasCompletedHealthRecord,
      { scholarId },
    );
    expect(pending.outstandingForms).not.toContain("Medication authorization");

    // Staff send it back for replacement.
    const registrar = await withUser(t, registrarId);
    await registrar.mutation(
      api.scholarHealthRecords.setHealthDocumentReviewStatus,
      {
        fileId: upload.document.fileId,
        institutionScope: institutionId,
        reviewStatus: "needs_replacement",
        reviewNote: "The physician signature block is blank.",
      },
    );
    const flagged = await guardian.query(
      api.scholarHealthRecords.hasCompletedHealthRecord,
      { scholarId },
    );
    expect(flagged.outstandingForms).toContain("Medication authorization");

    // Accepting it closes the follow-up again.
    await registrar.mutation(
      api.scholarHealthRecords.setHealthDocumentReviewStatus,
      {
        fileId: upload.document.fileId,
        institutionScope: institutionId,
        reviewStatus: "accepted",
        reviewNote: "Complete",
      },
    );
    const accepted = await guardian.query(
      api.scholarHealthRecords.hasCompletedHealthRecord,
      { scholarId },
    );
    expect(accepted.outstandingForms).not.toContain("Medication authorization");

    await registrar.mutation(
      api.scholarHealthRecords.setHealthDocumentReviewStatus,
      {
        fileId: upload.document.fileId,
        institutionScope: institutionId,
        reviewStatus: "pending",
        reviewNote: "Discarded when resetting the review",
      },
    );
    const resetFile = await t.run((ctx) =>
      ctx.db.get(upload.document.fileId),
    );
    expect(resetFile?.reviewStatus).toBeUndefined();
    expect(resetFile?.reviewedBy).toBeUndefined();
    expect(resetFile?.reviewedAt).toBeUndefined();
    expect(resetFile?.reviewNote).toBeUndefined();
  });
});

describe("deselecting a condition clears its staff-filed plan", () => {
  // A condition the guardian turns off has no live slot to hold a document.
  // `preserveStaffAttachedDocuments` must not resurrect the staff pointer onto
  // that dead slot: doing so strands the file, invisible to every normalized
  // read and to the unreferenced-file sweep.
  test("a staff action plan is reclaimed, not orphaned, when the plan is removed", async () => {
    const { t, guardianId, scholarId, registrarId, institutionId } =
      await setupSchool();
    await submitHealthRecord(t, guardianId, scholarId, ACTION_PLAN_SELECTED);
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "action_plan_document",
      { institutionScope: institutionId },
    );
    const attachedFileId = result.ok ? result.document.fileId : null;
    expect(attachedFileId).not.toBeNull();

    const registrar = await withUser(t, registrarId);
    const before = await registrar.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(before?.actionPlanDocument?.fileId).toBe(attachedFileId);

    // The family removes the condition entirely.
    const guardian = await withUser(t, guardianId);
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, {
      scholarId,
      ...completeFields(),
      expectedDraftVersion: 0,
      expectedSignedRevision: 1,
      currentStep: 10,
      lastCompletedStep: 9,
      submit: true,
    });

    const after = await signedRecord(t, scholarId);
    expect(after?.revision).toBe(2);
    expect(after?.hap.none).toBe(true);

    const staffAfter = await registrar.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(staffAfter?.actionPlanDocument ?? null).toBeNull();
    // The orphan is reclaimed, not left dangling.
    expect(await healthFile(t, attachedFileId!)).toBeNull();
  });
});

// The merged staff document list must NOT conflate "you hold no health
// capability" with "this scholar is not in your context". A school:operations
// staffer (e.g. a robotics instructor who runs a program but files no health
// records) legitimately has scholar access and simply has no health half to
// show — opening a scholar must return normally with the health half hidden,
// not throw the route-boundary "Something went wrong".
describe("listDocumentsForStaff for a school:operations staffer without health:manage", () => {
  test("returns normally with the health half hidden — even though health forms and a health document exist", async () => {
    const { t, guardianId, scholarId, registrarId, teacherId, institutionId, adminId } =
      await setupSchool({ isPrimary: true });
    await submitHealthRecord(t, guardianId, scholarId);

    // A real, sensitive scholarDocuments row genuinely EXISTS on this scholar
    // (an assessment a teacher filed). Asserting its title never appears in the
    // ops staffer's response proves the health-less list actually withholds the
    // scholarDocuments half — not that the row merely happens to be absent.
    const SECRET_TITLE = "CONFIDENTIAL WISC-V assessment";
    await t.run(async (ctx) => {
      const fileStorageId = await ctx.storage.store(
        new Blob([Uint8Array.from(PDF_BYTES).buffer], { type: "application/pdf" }),
      );
      await ctx.db.insert("scholarDocuments", {
        scholarId,
        kind: "assessment",
        format: "file",
        title: SECRET_TITLE,
        fileStorageId,
        fileMimeType: "application/pdf",
        fileSizeBytes: 19,
        extractedText: "Sensitive raw neuropsych scores",
        summary: "Teacher-only assessment summary",
        uploadedBy: teacherId,
        processingStatus: "ready",
        feedsTutor: false,
      });
    });

    // A health document genuinely EXISTS for this scholar (filed by the
    // operations/health staffer through the untouched health path), so an empty health half in
    // the operations staffer's view proves it was hidden, not merely absent.
    const { result } = await staffUpload(
      t,
      registrarId,
      scholarId,
      "immunization_record",
      { institutionScope: institutionId },
    );
    if (!result.ok) throw new Error("Expected health upload to finalize");

    // A staff member with school:operations (scholar access) and NO
    // health:manage.
    const operationsStaffId = await seedUser(t, "staff", "ops-staff");
    await addMembership(t, operationsStaffId, "staff", institutionId);
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: operationsStaffId,
        institutionId,
        capability: "school:operations",
        grantedBy: adminId,
        grantedAt: Date.now(),
      }),
    );

    const operationsStaff = await withUser(t, operationsStaffId);
    const view = await operationsStaff.query(
      api.scholarDocuments.listDocumentsForStaff,
      { scholarId, institutionScope: institutionId },
    );

    // Did not throw. The health half is HIDDEN, and no health data leaks.
    expect(view.canReadScholarDocuments).toBe(false);
    expect(view.healthDocumentsVisible).toBe(false);
    expect(view.healthDocuments).toHaveLength(0);
    expect(view.documents).toHaveLength(0);
    // The sensitive scholarDocuments assessment never appears anywhere in the
    // response.
    expect(JSON.stringify(view)).not.toContain(SECRET_TITLE);
    expect(view.canUploadHealthDocuments).toBe(false);
    expect(view.attachableHealthKinds).toHaveLength(0);
    // The forms DO exist for this scholar — the empty half above is a
    // capability decision, not "no forms".
    expect(view.healthFormsAvailable).toBe(true);
  });

  test("rejects a school:operations staffer from a DIFFERENT institution", async () => {
    const { t, guardianId, scholarId, otherInstitutionId, adminId } =
      await setupSchool({ isPrimary: true });
    await submitHealthRecord(t, guardianId, scholarId);

    // An ops-granted staffer, but at the OTHER institution — the scholar is not
    // in their context, so even the health-less list must be refused.
    const foreignOpsId = await seedUser(t, "staff", "foreign-ops");
    await addMembership(t, foreignOpsId, "staff", otherInstitutionId);
    await t.run((ctx) =>
      ctx.db.insert("staffCapabilityGrants", {
        granteeUserId: foreignOpsId,
        institutionId: otherInstitutionId,
        capability: "school:operations",
        grantedBy: adminId,
        grantedAt: Date.now(),
      }),
    );
    const foreignOps = await withUser(t, foreignOpsId);

    await expect(
      foreignOps.query(api.scholarDocuments.listDocumentsForStaff, {
        scholarId,
        institutionScope: otherInstitutionId,
      }),
    ).rejects.toThrow(/not in your current context/i);
  });

  test("still refuses a staffer with no access to the scholar at all", async () => {
    const { t, guardianId, scholarId, institutionId } = await setupSchool({
      isPrimary: true,
    });
    await submitHealthRecord(t, guardianId, scholarId);

    // A staff member with a membership at the institution but NO capability
    // grants — neither school:operations (scholar access) nor health:manage.
    const outsiderId = await seedUser(t, "staff", "no-access-staff");
    await addMembership(t, outsiderId, "staff", institutionId);
    const outsider = await withUser(t, outsiderId);

    await expect(
      outsider.query(api.scholarDocuments.listDocumentsForStaff, {
        scholarId,
        institutionScope: institutionId,
      }),
    ).rejects.toThrow(/not in your current context/i);
  });
});
