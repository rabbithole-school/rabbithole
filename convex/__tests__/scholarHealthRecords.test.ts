import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";

import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  emptyHealthRecordFields,
  healthRecordAnswersDiffer,
  normalizeHealthRecordFields,
  validateHealthRecordSubmission,
  type HealthRecordFields,
} from "../lib/healthRecord";
import {
  HEALTH_RECORD_CONFIRMATION_SUBJECT,
  renderHealthRecordConfirmationHtml,
} from "../lib/healthRecordConfirmationEmail";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type Role = NonNullable<Doc<"users">["role"]>;

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
) {
  return await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: `${slug} School`,
      slug,
      kind: "school",
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

// Operations staff with health access (the retired registrar role's
// successor — registrar used to imply both scholar-admin AND health-record
// access): a base `staff` user needs an explicit `health:manage` capability
// grant to satisfy `healthInstitutionIds`'s capability check.
async function grantHealthCapability(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  institutionId: Id<"institutions">,
) {
  await t.run((ctx) =>
    ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId,
      institutionId,
      capability: "health:manage",
      grantedBy: userId,
      grantedAt: Date.now(),
    }),
  );
}

async function linkGuardian(
  t: ReturnType<typeof convexTest>,
  guardianId: Id<"users">,
  scholarId: Id<"users">,
  createdBy: Id<"users">,
) {
  await t.run((ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId: guardianId,
      scholarUserId: scholarId,
      createdBy,
    }),
  );
}

function completeFields(
  signerName = "Test guardian-a",
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
    guardian1Email: "spoofed@example.test",
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
    swimmingRestriction: true,
    swimmingRestrictionDetails: "Use a flotation device.",
    cookingWaiverParentFullName: "Test guardian-a",
    cookingWaiverStudentFullName: "Scholar A",
    cookingWaiverDetails: "No known allergies.",
    cookingWaiverDate: "2026-08-14",
    signerName,
    signerAgreement: true,
    ...overrides,
  };
}

function saveArgs(
  scholarId: Id<"users">,
  fields: HealthRecordFields,
  overrides: {
    expectedDraftVersion?: number;
    expectedSignedRevision?: number;
    currentStep?: number;
    lastCompletedStep?: number;
    submit?: boolean;
  } = {},
) {
  return {
    scholarId,
    ...fields,
    expectedDraftVersion: overrides.expectedDraftVersion ?? 0,
    expectedSignedRevision: overrides.expectedSignedRevision ?? 0,
    currentStep: overrides.currentStep ?? 0,
    lastCompletedStep: overrides.lastCompletedStep ?? -1,
    submit: overrides.submit ?? false,
  };
}

async function setupFamily() {
  const t = convexTest(schema, modules);
  const institutionId = await seedInstitution(t, "alpha");
  const adminId = await seedUser(t, "platform_admin", "admin");
  const guardianAId = await seedUser(t, "parent", "guardian-a");
  const guardianBId = await seedUser(t, "parent", "guardian-b");
  const strangerId = await seedUser(t, "parent", "stranger");
  const scholarId = await seedUser(
    t,
    "scholar",
    "scholar-a",
    institutionId,
  );
  await linkGuardian(t, guardianAId, scholarId, adminId);
  await linkGuardian(t, guardianBId, scholarId, adminId);
  return {
    t,
    institutionId,
    adminId,
    guardianAId,
    guardianBId,
    strangerId,
    scholarId,
  };
}

async function uploadHealthDocument(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
  scholarId: Id<"users">,
  kind:
    | "medication_authorization"
    | "immunization_record"
    | "action_plan_document_asthma",
  {
    bytes = new TextEncoder().encode("%PDF-1.4\nfictional test file"),
    type = "application/pdf",
    fileName = "fictional-record.pdf",
  }: {
    bytes?: Uint8Array;
    type?: string;
    fileName?: string;
  } = {},
) {
  const user = await withUser(t, userId);
  const ticket = await user.mutation(
    api.scholarHealthRecords.generateHealthDocumentUploadUrl,
    { scholarId, kind },
  );
  const storageId = await t.run((ctx) =>
    ctx.storage.store(
      new Blob([Uint8Array.from(bytes).buffer], { type }),
    ),
  );
  const result = await user.action(
    api.scholarHealthRecords.finalizeHealthDocumentUpload,
    {
      fileId: ticket.fileId,
      storageId,
      fileName,
    },
  );
  return { user, ticket, storageId, result };
}

describe("health document storage boundaries", () => {
  test("validates file contents, type, extension, and size on the server", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const wrongContents = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "medication_authorization",
      {
        bytes: new TextEncoder().encode("not a pdf"),
      },
    );
    expect(wrongContents.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/contents/i),
    });
    expect(
      await t.run((ctx) => ctx.storage.get(wrongContents.storageId)),
    ).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get(wrongContents.ticket.fileId)),
    ).toBeNull();

    const wrongExtension = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "immunization_record",
      { fileName: "fictional-record.png" },
    );
    expect(wrongExtension.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/extension/i),
    });

    const oversizedBytes = new Uint8Array(10 * 1024 * 1024 + 1);
    oversizedBytes.set(new TextEncoder().encode("%PDF-"));
    const oversized = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "immunization_record",
      { bytes: oversizedBytes },
    );
    expect(oversized.result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/10 MB/i),
    });
    expect(await t.run((ctx) => ctx.storage.get(oversized.storageId))).toBeNull();
  });

  test("keeps guardian uploads draft-private, then shares the signed canonical file", async () => {
    const {
      t,
      guardianAId,
      guardianBId,
      strangerId,
      scholarId,
    } = await setupFamily();
    const uploaded = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "medication_authorization",
    );
    expect(uploaded.result.ok).toBe(true);
    if (!uploaded.result.ok) throw new Error("Expected upload to finalize");
    const fileId = uploaded.result.document.fileId;
    const guardianA = uploaded.user;
    const guardianB = await withUser(t, guardianBId);
    const stranger = await withUser(t, strangerId);
    const fields = completeFields("Test guardian-a", {
      schoolMedicationMode: "self_carry_emergency",
      medicationDocumentDelivery: "upload",
      medicationDocumentId: fileId,
    });

    await guardianA.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, fields),
    );
    const guardianBView = await guardianB.query(
      api.scholarHealthRecords.getHealthRecord,
      { scholarId },
    );
    expect(guardianBView.medicationDocumentId).toBeNull();
    expect(guardianBView.medicationDocument).toBeNull();
    await expect(
      guardianB.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(
          scholarId,
          completeFields("Test guardian-b", {
            schoolMedicationMode: "stored_at_school",
            medicationDocumentDelivery: "upload",
            medicationDocumentId: fileId,
          }),
        ),
      ),
    ).rejects.toThrow(/another draft/i);
    await expect(
      stranger.query(api.scholarHealthRecords.getHealthRecord, { scholarId }),
    ).rejects.toThrow(/not a guardian/i);

    await guardianA.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, fields, {
        expectedDraftVersion: 1,
        submit: true,
        currentStep: 10,
        lastCompletedStep: 9,
      }),
    );
    const canonicalView = await guardianB.query(
      api.scholarHealthRecords.getHealthRecord,
      { scholarId },
    );
    expect(canonicalView.medicationDocument).toMatchObject({
      fileId,
      fileName: "fictional-record.pdf",
      contentType: "application/pdf",
    });
    expect(canonicalView.medicationDocument?.url).toMatch(/^https?:\/\//);

    await expect(
      guardianB.mutation(
        api.scholarHealthRecords.discardHealthDocumentUpload,
        { fileId },
      ),
    ).resolves.toEqual({ discarded: false });
    await expect(
      guardianA.mutation(
        api.scholarHealthRecords.discardHealthDocumentUpload,
        { fileId },
      ),
    ).resolves.toEqual({ discarded: false });
    expect(await t.run((ctx) => ctx.db.get(fileId))).not.toBeNull();
  });

  test("exposes signed downloads only to staff in the selected institution", async () => {
    const { t, institutionId, guardianAId, scholarId } = await setupFamily();
    const otherInstitutionId = await seedInstitution(t, "beta");
    const teacherId = await seedUser(t, "teacher", "teacher", institutionId);
    const wrongTeacherId = await seedUser(
      t,
      "teacher",
      "wrong-teacher",
      otherInstitutionId,
    );
    await addMembership(t, teacherId, "teacher", institutionId);
    await addMembership(t, wrongTeacherId, "teacher", otherInstitutionId);
    const uploaded = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "immunization_record",
    );
    if (!uploaded.result.ok) throw new Error("Expected upload to finalize");
    await uploaded.user.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("Test guardian-a", {
          immunizationDocumentDelivery: "upload",
          immunizationDocumentId: uploaded.result.document.fileId,
        }),
        { submit: true, currentStep: 10, lastCompletedStep: 9 },
      ),
    );

    const teacher = await withUser(t, teacherId);
    const staffView = await teacher.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId, institutionScope: institutionId },
    );
    expect(staffView?.immunizationDocument).toMatchObject({
      fileId: uploaded.result.document.fileId,
      fileName: "fictional-record.pdf",
    });
    expect(staffView?.immunizationDocument?.url).toMatch(/^https?:\/\//);
    const wrongTeacher = await withUser(t, wrongTeacherId);
    await expect(
      wrongTeacher.query(
        api.scholarHealthRecords.getHealthRecordForStaff,
        { scholarId, institutionScope: otherInstitutionId },
      ),
    ).rejects.toThrow(/current context/i);
  });

  test("deletes replaced and removed draft files without deleting canonical references", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const first = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "medication_authorization",
      { fileName: "first-fictional-record.pdf" },
    );
    const second = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "medication_authorization",
      { fileName: "second-fictional-record.pdf" },
    );
    if (!first.result.ok) throw new Error("Expected first upload to finalize");
    if (!second.result.ok) throw new Error("Expected second upload to finalize");
    const firstFileId = first.result.document.fileId;
    const secondFileId = second.result.document.fileId;
    const guardian = first.user;
    const fields = completeFields("Test guardian-a", {
      schoolMedicationMode: "stored_at_school",
      medicationDocumentDelivery: "upload",
      medicationDocumentId: firstFileId,
    });
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, fields),
    );
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        {
          ...fields,
          medicationDocumentId: secondFileId,
        },
        { expectedDraftVersion: 1 },
      ),
    );
    expect(
      await t.run((ctx) => ctx.db.get(firstFileId)),
    ).toBeNull();
    expect(await t.run((ctx) => ctx.storage.get(first.storageId))).toBeNull();

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        {
          ...fields,
          medicationDocumentDelivery: "provide_separately",
          medicationDocumentId: null,
        },
        { expectedDraftVersion: 2 },
      ),
    );
    expect(
      await t.run((ctx) => ctx.db.get(secondFileId)),
    ).toBeNull();
    expect(await t.run((ctx) => ctx.storage.get(second.storageId))).toBeNull();
  });

  test("cleans finalized uploads that were abandoned before a draft save", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const uploaded = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "immunization_record",
    );
    if (!uploaded.result.ok) throw new Error("Expected upload to finalize");
    const fileId = uploaded.result.document.fileId;
    await t.run((ctx) =>
      ctx.db.patch(fileId, {
        finalizedAt: Date.now() - 25 * 60 * 60 * 1_000,
      }),
    );
    await t.mutation(
      internal.scholarHealthRecords.cleanupHealthRecordFile,
      {
        fileId,
        notBefore: 0,
      },
    );
    expect(await t.run((ctx) => ctx.db.get(fileId))).toBeNull();
    expect(await t.run((ctx) => ctx.storage.get(uploaded.storageId))).toBeNull();
  });
});

describe("guardian health-record drafts", () => {
  test("accepts a legacy parent-entered immunization date only long enough to drop it", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const fields = completeFields("");
    const draftId = await t.run((ctx) =>
      ctx.db.insert("scholarHealthRecordDrafts", {
        scholarId,
        guardianId: guardianAId,
        ...fields,
        immunizationDateSubmitted: "2026-07-01",
        baseRevision: 0,
        version: 1,
        currentStep: 6,
        lastCompletedStep: 5,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    const guardian = await withUser(t, guardianAId);
    const view = await guardian.query(
      api.scholarHealthRecords.getHealthRecord,
      { scholarId },
    );
    expect(view).not.toHaveProperty("immunizationDateSubmitted");

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, fields, {
        expectedDraftVersion: 1,
        currentStep: 6,
        lastCompletedStep: 5,
      }),
    );
    expect(await t.run((ctx) => ctx.db.get(draftId))).not.toHaveProperty(
      "immunizationDateSubmitted",
    );
  });

  test("prefills identity data on the server and guards every read and write", async () => {
    const { t, guardianAId, strangerId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const stranger = await withUser(t, strangerId);

    await expect(
      stranger.query(api.scholarHealthRecords.getHealthRecord, { scholarId }),
    ).rejects.toThrow(/not a guardian/i);
    await expect(
      stranger.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(scholarId, completeFields()),
      ),
    ).rejects.toThrow(/not a guardian/i);

    expect(
      await guardian.query(api.scholarHealthRecords.getHealthRecord, {
        scholarId,
      }),
    ).toMatchObject({
      childName: "Test scholar-a",
      childDob: "2018-03-15",
      childGrade: "2",
      homeAddress: "123 Test Street",
      guardian1Name: "Test guardian-a",
      guardian1Phone: "808-555-0100",
      guardian1Email: "guardian-a@example.test",
      accountSignerName: "Test guardian-a",
      accountContact: {
        name: "Test guardian-a",
        email: "guardian-a@example.test",
        phone: "808-555-0100",
      },
      currentStep: 0,
      lastCompletedStep: -1,
    });
  });

  test("keeps partial drafts private and resumes at the persisted next step", async () => {
    const { t, guardianAId, guardianBId, scholarId } = await setupFamily();
    const guardianA = await withUser(t, guardianAId);
    const guardianB = await withUser(t, guardianBId);

    await guardianA.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("", { guardian1Name: "Draft A" }),
        { currentStep: 5, lastCompletedStep: 4 },
      ),
    );
    expect(
      await guardianA.query(api.scholarHealthRecords.getHealthRecord, {
        scholarId,
      }),
    ).toMatchObject({
      guardian1Name: "Test guardian-a",
      draftVersion: 1,
      hasPendingChanges: true,
      currentStep: 5,
      lastCompletedStep: 4,
      submittedAt: null,
    });
    expect(
      await guardianB.query(api.scholarHealthRecords.getHealthRecord, {
        scholarId,
      }),
    ).toMatchObject({ hasPendingChanges: false, draftVersion: 0 });
  });

  test("fills safe missing profile fields without claiming an auth email", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    await t.run(async (ctx) => {
      await ctx.db.patch(guardianAId, {
        name: undefined,
        email: undefined,
        phone: undefined,
      });
    });
    const guardian = await withUser(t, guardianAId);

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("", {
          guardian1Name: "Profile Completed",
          guardian1Email: "profile.completed@example.test",
          guardian1Phone: "808-555-0199",
          guardian1Relationship: "parent",
        }),
      ),
    );

    expect(await t.run((ctx) => ctx.db.get(guardianAId))).toMatchObject({
      name: "Profile Completed",
      phone: "808-555-0199",
    });
    expect((await t.run((ctx) => ctx.db.get(guardianAId)))?.email).toBeUndefined();
    expect(
      await guardian.query(api.scholarHealthRecords.getHealthRecord, {
        scholarId,
      }),
    ).toMatchObject({
      accountContact: {
        name: "Profile Completed",
        email: "",
        phone: "808-555-0199",
      },
      guardian1Name: "Profile Completed",
      guardian1Email: "profile.completed@example.test",
      guardian1Phone: "808-555-0199",
    });
  });

  test("preserves specific relationship values like mother and father", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("", {
          guardian1Relationship: "mother",
          guardian2: {
            name: "Additional Contact",
            relationship: "father",
            phone: "808-555-0400",
            workPhone: "",
            email: "additional@example.test",
            employer: "",
          },
        }),
      ),
    );

    expect(
      await guardian.query(api.scholarHealthRecords.getHealthRecord, {
        scholarId,
      }),
    ).toMatchObject({
      guardian1Relationship: "mother",
      guardian2: { relationship: "father" },
    });
  });

  test("bounds progress and rejects stale writes from another tab", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(scholarId, completeFields(), { currentStep: 12 }),
      ),
    ).rejects.toThrow(/current step.*range/i);
    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(scholarId, completeFields(), { lastCompletedStep: 11 }),
      ),
    ).rejects.toThrow(/last completed step.*range/i);

    const args = saveArgs(scholarId, completeFields(""));
    await guardian.mutation(api.scholarHealthRecords.saveHealthRecord, args);
    await expect(
      guardian.mutation(api.scholarHealthRecords.saveHealthRecord, args),
    ).rejects.toThrow(/another tab/i);
  });
});

describe("authoritative health-record validation", () => {
  test("normalizes every legacy No choice into an explicit exception", () => {
    const normalized = normalizeHealthRecordFields({
      ...completeFields(),
      publicMediaOptOut: undefined,
      privateSchoolMediaOptOut: undefined,
      fieldTripRestriction: undefined,
      fieldTripRestrictionDetails: undefined,
      peRecessRestriction: undefined,
      peRecessRestrictionDetails: undefined,
      swimmingRestriction: undefined,
      swimmingRestrictionDetails: undefined,
      photoConsent: "no",
      fieldTripConsent: "no",
      physicalActivityConsent: "no",
      swimConsent: "no",
      activityRestrictions: "Coordinate with the family before participation.",
    });

    expect(normalized).toMatchObject({
      publicMediaOptOut: true,
      privateSchoolMediaOptOut: false,
      fieldTripRestriction: true,
      fieldTripRestrictionDetails:
        "Coordinate with the family before participation.",
      peRecessRestriction: true,
      peRecessRestrictionDetails:
        "Coordinate with the family before participation.",
      swimmingRestriction: true,
      swimmingRestrictionDetails:
        "Coordinate with the family before participation.",
    });
  });

  test("clears developmental + action-plan detail when the section is turned off", () => {
    const answeredNo = normalizeHealthRecordFields(
      completeFields("", {
        developmentalConditionsPresent: "no",
        developmentalConditions: ["adhd", "anxiety"],
        developmentalConditionsOther: "stray",
        developmentalSupportNotes: "stray notes",
        developmentalSuccessfulSupports: "stray supports",
        supportPlans: ["iep"],
        supportPlanOther: "stray plan",
        supportPlanDocumentDelivery: "upload",
      }),
    );
    expect(answeredNo).toMatchObject({
      developmentalConditions: [],
      developmentalConditionsOther: "",
      developmentalSupportNotes: "",
      developmentalSuccessfulSupports: "",
      supportPlans: [],
      supportPlanOther: "",
      supportPlanDocumentDelivery: "",
      supportPlanDocumentId: null,
    });

    const noPlans = normalizeHealthRecordFields(
      completeFields("", {
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
        hapDocumentDelivery: "upload",
      }),
    );
    expect(noPlans.hapDocumentDelivery).toBe("");
    expect(noPlans.actionPlanDocumentId).toBeNull();
  });

  test("rejects invalid enum values at the Convex argument boundary", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const invalidCases: HealthRecordFields[] = [
      completeFields("", {
        guardian1Relationship:
          "sibling" as HealthRecordFields["guardian1Relationship"],
      }),
      completeFields("", {
        immunizationStatus:
          "unknown" as HealthRecordFields["immunizationStatus"],
      }),
      completeFields("", {
        chronicConditions: [
          "unknown" as HealthRecordFields["chronicConditions"][number],
        ],
      }),
      completeFields("", {
        noKnownAllergies: false,
        allergies: [
          {
            allergen: "Test",
            type: "unknown" as HealthRecordFields["allergies"][number]["type"],
            reaction: "Test",
            severity: "extreme" as HealthRecordFields["allergies"][number]["severity"],
            emergencyTreatment: "Call",
            epipenOnFile: false,
          },
        ],
      }),
      completeFields("", {
        noKnownAllergies: false,
        allergies: [
          {
            allergen: "Test",
            type: "food",
            reaction: "Test",
            severity:
              "extreme" as HealthRecordFields["allergies"][number]["severity"],
            emergencyTreatment: "Call",
            epipenOnFile: false,
          },
        ],
      }),
    ];
    for (const fields of invalidCases) {
      await expect(
        guardian.mutation(
          api.scholarHealthRecords.saveHealthRecord,
          saveArgs(scholarId, fields),
        ),
      ).rejects.toThrow();
    }
  });

  test("enforces mutual exclusion even for partial drafts", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const contradictions: Array<[Partial<HealthRecordFields>, RegExp]> = [
      [
        {
          noKnownAllergies: true,
          allergies: [
            {
              allergen: "Peanut",
              type: "food",
              reaction: "Hives",
              severity: "severe",
              emergencyTreatment: "EpiPen",
              epipenOnFile: true,
            },
          ],
        },
        /no known allergies/i,
      ],
      [
        { noChronicConditions: true, chronicConditions: ["asthma"] },
        /clear conditions/i,
      ],
      [
        {
          noCurrentMedications: true,
          medications: [
            {
              name: "Medication",
              purpose: "Asthma",
              dosage: "1 puff",
              frequency: "Daily",
              administrationInstructions: "Nurse administers",
              storedAtSchool: true,
              prescriptionOnFile: true,
            },
          ],
        },
        /no current medications/i,
      ],
      [
        {
          hap: {
            allergy: true,
            asthma: false,
            seizure: false,
            diabetes: false,
            behavioralHealth: false,
            other: false,
            otherDesc: "",
            none: true,
            notes: "",
          },
        },
        /clear action plans/i,
      ],
    ];
    for (const [overrides, message] of contradictions) {
      await expect(
        guardian.mutation(
          api.scholarHealthRecords.saveHealthRecord,
          saveArgs(scholarId, completeFields("", overrides)),
        ),
      ).rejects.toThrow(message);
    }
  });

  test("rejects an invalid missing-account email before saving a draft", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    await t.run(async (ctx) => {
      await ctx.db.patch(guardianAId, { email: undefined });
    });
    const guardian = await withUser(t, guardianAId);

    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(
          scholarId,
          completeFields("", { guardian1Email: "not-an-email" }),
        ),
      ),
    ).rejects.toThrow(/valid email/i);
    expect(
      await t.run((ctx) => ctx.db.query("scholarHealthRecordDrafts").collect()),
    ).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(guardianAId)))?.email).toBeUndefined();
  });

  test("rejects an invalid additional-guardian email in drafts and submissions", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const invalidFields = completeFields("", {
      guardian2: {
        name: "Additional Guardian",
        relationship: "parent",
        phone: "808-555-0400",
        workPhone: "",
        email: "asd",
        employer: "",
      },
    });

    for (const submit of [false, true]) {
      let failure: unknown;
      try {
        await guardian.mutation(
          api.scholarHealthRecords.saveHealthRecord,
          saveArgs(scholarId, invalidFields, {
            submit,
            currentStep: submit ? 10 : 1,
            lastCompletedStep: submit ? 9 : 0,
          }),
        );
      } catch (error) {
        failure = error;
      }
      expect(
        (failure as { data?: unknown } | undefined)?.data,
      ).toMatchObject({
        kind: "health_record_validation",
        issue: {
          code: "invalid_email",
          step: 1,
          field: "guardian2.email",
        },
      });
    }
    expect(
      await t.run((ctx) => ctx.db.query("scholarHealthRecords").collect()),
    ).toHaveLength(0);
    expect(
      await t.run((ctx) => ctx.db.query("scholarHealthRecordDrafts").collect()),
    ).toHaveLength(0);
  });

  test("normalizes blank optional additional-guardian fields without discarding invalid email", () => {
    const normalized = normalizeHealthRecordFields(
      completeFields("", {
        guardian2: {
          name: "Additional Guardian",
          relationship: "legal_guardian",
          phone: "808-555-0400",
          workPhone: " ",
          email: " asd ",
          employer: "",
        },
      }),
    );

    expect(normalized.guardian2).toEqual({
      name: "Additional Guardian",
      relationship: "legal_guardian",
      phone: "808-555-0400",
      workPhone: undefined,
      email: "asd",
      employer: undefined,
    });
    expect(() =>
      validateHealthRecordSubmission(normalized, "Test Guardian"),
    ).toThrow(/valid email address.*additional parent or legal guardian/i);
  });

  test("enforces array and text bounds", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const contact = completeFields().emergencyContacts[0];
    const allergy = {
      allergen: "Peanut",
      type: "food" as const,
      reaction: "Hives",
      severity: "moderate" as const,
      emergencyTreatment: "Call guardian",
      epipenOnFile: false,
    };
    const medication = {
      name: "Medication",
      purpose: "Purpose",
      dosage: "10 mg",
      frequency: "Daily",
      administrationInstructions: "Nurse administers",
      storedAtSchool: true,
      prescriptionOnFile: true,
    };
    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(
          scholarId,
          completeFields("", {
            emergencyContacts: Array.from({ length: 6 }, () => ({ ...contact })),
          }),
        ),
      ),
    ).rejects.toThrow(/limited to 5/i);
    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(
          scholarId,
          completeFields("", {
            noKnownAllergies: false,
            allergies: Array.from({ length: 21 }, () => ({ ...allergy })),
          }),
        ),
      ),
    ).rejects.toThrow(/allergies are limited to 20/i);
    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(
          scholarId,
          completeFields("", {
            noCurrentMedications: false,
            medications: Array.from({ length: 21 }, () => ({
              ...medication,
            })),
          }),
        ),
      ),
    ).rejects.toThrow(/medications are limited to 20/i);
    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(
          scholarId,
          completeFields("", { physicianName: "x".repeat(201) }),
        ),
      ),
    ).rejects.toThrow(/200 characters/i);
  });

  test("requires every medical submission section", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const submit = (overrides: Partial<HealthRecordFields>) =>
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(scholarId, completeFields("Test guardian-a", overrides), {
          currentStep: 10,
          lastCompletedStep: 9,
          submit: true,
        }),
      );

    await expect(submit({ childDob: "" })).rejects.toThrow(/date of birth/i);
    await expect(submit({ emergencyContacts: [] })).rejects.toThrow(
      /at least one emergency contact/i,
    );
    await expect(
      submit({ noKnownAllergies: false, allergies: [] }),
    ).rejects.toThrow(/add an allergy/i);
    await expect(
      submit({ noChronicConditions: false, chronicConditions: [] }),
    ).rejects.toThrow(/select a chronic condition/i);
    await expect(
      submit({ noCurrentMedications: false, medications: [] }),
    ).rejects.toThrow(/add a medication/i);
    await expect(submit({ schoolMedicationMode: "" })).rejects.toThrow(
      /medication.*handled at school/i,
    );
    await expect(
      submit({
        schoolMedicationMode: "stored_at_school",
        medicationDocumentDelivery: "",
      }),
    ).rejects.toThrow(/how medication authorization/i);
    await expect(
      submit({
        schoolMedicationMode: "self_carry_emergency",
        medicationDocumentDelivery: "upload",
        medicationDocumentId: null,
      }),
    ).rejects.toThrow(/upload the completed medication authorization/i);
    await expect(submit({ immunizationStatus: "" })).rejects.toThrow(
      /immunization record status/i,
    );
    await expect(
      submit({ immunizationDocumentDelivery: "" }),
    ).rejects.toThrow(/supporting documentation/i);
    await expect(
      submit({
        immunizationDocumentDelivery: "upload",
        immunizationDocumentId: null,
      }),
    ).rejects.toThrow(/upload the immunization supporting document/i);
    await expect(
      submit({
        hap: {
          allergy: false,
          asthma: false,
          seizure: false,
          diabetes: false,
          behavioralHealth: false,
          other: false,
          otherDesc: "",
          none: false,
          notes: "",
        },
      }),
    ).rejects.toThrow(/select an action plan/i);
    await expect(submit({ emergencyMedAuthAck: false })).rejects.toThrow(
      /authorize emergency medical care/i,
    );
    await expect(submit({ signerAgreement: false })).rejects.toThrow(
      /electronic signature certification/i,
    );
    await expect(
      submit({
        guardian2: {
          name: "",
          relationship: "legal_guardian",
          phone: "808-555-0400",
          workPhone: "",
          email: "second@example.test",
          employer: "",
        },
      }),
    ).rejects.toThrow(/additional parent or legal guardian.*name/i);
    await expect(
      submit({
        noKnownAllergies: false,
        allergies: [
          {
            allergen: "Peanut",
            type: "food",
            reaction: "Hives",
            severity: "severe",
            emergencyTreatment: "",
            epipenOnFile: true,
          },
        ],
      }),
    ).rejects.toThrow(/allergy 1.*emergency treatment/i);
    await expect(
      submit({
        noChronicConditions: false,
        chronicConditions: ["other"],
        chronicConditionDetails: "",
      }),
    ).rejects.toThrow(/other chronic condition/i);
    await expect(
      submit({
        noCurrentMedications: false,
        schoolMedicationMode: "stored_at_school",
        medicationDocumentDelivery: "provide_separately",
        medications: [
          {
            name: "Medication",
            purpose: "Purpose",
            dosage: "10 mg",
            frequency: "Daily",
            administrationInstructions: "",
            storedAtSchool: false,
            prescriptionOnFile: false,
          },
        ],
      }),
    ).rejects.toThrow(/administration instructions/i);
    await expect(
      submit({
        hap: {
          allergy: false,
          asthma: false,
          seizure: false,
          diabetes: false,
          behavioralHealth: false,
          other: true,
          otherDesc: "",
          none: false,
          notes: "",
        },
      }),
    ).rejects.toThrow(/other action plan/i);
  });

  test("does not sign standalone participation choices with the health form", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const submit = (signerName: string) =>
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(
          scholarId,
          completeFields(signerName, {
            publicMediaOptOut: true,
            privateSchoolMediaOptOut: true,
            swimmingRestriction: false,
            swimmingRestrictionDetails: "",
          }),
          {
          currentStep: 10,
          lastCompletedStep: 9,
          submit: true,
          },
        ),
      );

    await expect(submit("Test Guardian A")).rejects.toThrow(/exactly.*account/i);
    await expect(submit("  TEST   GUARDIAN-A ")).resolves.toMatchObject({
      submitted: true,
      signedRevision: 1,
    });
    const signed = await t.run((ctx) =>
      ctx.db.query("scholarHealthRecords").unique(),
    );
    expect(signed).toMatchObject({
      signerUserId: guardianAId,
      signerName: "TEST   GUARDIAN-A",
      childName: "Test scholar-a",
      guardian1Name: "Test guardian-a",
      guardian1Phone: "808-555-0100",
      guardian1Email: "guardian-a@example.test",
      publicMediaOptOut: false,
      swimmingRestriction: false,
    });
    expect(signed?.signedAt).toBeTypeOf("number");
    expect(signed?.standardProgramAcknowledgedAt).toBeUndefined();
  });
});

describe("signed health-record integrity", () => {
  test("notifies the institution alerts channel for each signed parent update, without health details", async () => {
    const { t, guardianAId, scholarId, institutionId, adminId } =
      await setupFamily();
    await t.mutation(internal.alerts.linkAlertsChannel, {
      callerUserId: adminId,
      slackChannelId: "C_HEALTH_ALERTS",
      unlink: false,
      role: "scoped",
      institutionId,
    });
    const guardian = await withUser(t, guardianAId);
    const privateDetail = "Private health detail must stay out of Slack";
    const fields = completeFields("Test guardian-a", {
      swimmingRestrictionDetails: privateDetail,
    });

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, fields, {
        currentStep: 4,
        lastCompletedStep: 3,
      }),
    );
    expect(
      await t.run((ctx) => ctx.db.query("alerts").collect()),
    ).toHaveLength(0);

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, fields, {
        expectedDraftVersion: 1,
        currentStep: 10,
        lastCompletedStep: 9,
        submit: true,
      }),
    );
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("Test guardian-a", {
          swimmingRestriction: false,
          swimmingRestrictionDetails: "",
        }),
        {
          expectedSignedRevision: 1,
          currentStep: 10,
          lastCompletedStep: 9,
          submit: true,
        },
      ),
    );

    const alerts = await t.run((ctx) => ctx.db.query("alerts").collect());
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      kind: "parent_health_record_update",
      severity: "info",
      source: "scholarHealthRecords.saveHealthRecord",
      scholarId,
      title: "Parent updated health information — Test scholar-a",
      body: "A signed update is ready for staff review (revision 1).",
    });
    expect(alerts[0].deepLink).toMatch(
      /\/teacher\/scholars\/scholar-a\/documents$/,
    );
    expect(alerts[0].body).not.toContain(privateDetail);
    expect(alerts[1].body).toContain("revision 2");

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) => job.name === "slackNotifications:postNow"),
    ).toHaveLength(2);
  });

  test("preserves the signed snapshot during private edits and requires re-signing", async () => {
    const { t, guardianAId, scholarId, institutionId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const teacherId = await seedUser(t, "teacher", "teacher", institutionId);
    await addMembership(t, teacherId, "teacher", institutionId);
    const teacher = await withUser(t, teacherId);

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("Test guardian-a", {
          noKnownAllergies: false,
          allergies: [
            {
              allergen: "Original",
              type: "food",
              reaction: "Hives",
              severity: "moderate",
              emergencyTreatment: "Call guardian",
              epipenOnFile: false,
            },
          ],
        }),
        { currentStep: 10, lastCompletedStep: 9, submit: true },
      ),
    );
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("", {
          noKnownAllergies: false,
          allergies: [
            {
              allergen: "Updated draft",
              type: "food",
              reaction: "Hives",
              severity: "moderate",
              emergencyTreatment: "Call guardian",
              epipenOnFile: false,
            },
          ],
        }),
        {
          expectedSignedRevision: 1,
          currentStep: 4,
          lastCompletedStep: 3,
        },
      ),
    );

    expect(
      (
        await teacher.query(
          api.scholarHealthRecords.getHealthRecordForStaff,
          { scholarId },
        )
      )?.allergies[0].allergen,
    ).toBe("Original");
    await expect(
      guardian.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(scholarId, completeFields(""), {
          expectedDraftVersion: 1,
          expectedSignedRevision: 1,
          currentStep: 10,
          lastCompletedStep: 9,
          submit: true,
        }),
      ),
    ).rejects.toThrow(/full legal name/i);
  });

  test("maintains one canonical record and rejects stale guardian revisions", async () => {
    const { t, guardianAId, guardianBId, scholarId } = await setupFamily();
    const guardianA = await withUser(t, guardianAId);
    const guardianB = await withUser(t, guardianBId);
    await guardianA.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, completeFields("Test guardian-a"), {
        currentStep: 10,
        lastCompletedStep: 9,
        submit: true,
      }),
    );
    expect(
      await guardianB.query(api.scholarHealthRecords.getHealthRecord, {
        scholarId,
      }),
    ).toMatchObject({
      guardian1Name: "Test guardian-b",
      signedRevision: 1,
      hasPendingChanges: false,
      signerName: "",
      signerAgreement: false,
    });
    await guardianB.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, completeFields("Test guardian-b"), {
        expectedSignedRevision: 1,
        currentStep: 10,
        lastCompletedStep: 9,
        submit: true,
      }),
    );
    expect(
      await t.run((ctx) => ctx.db.query("scholarHealthRecords").collect()),
    ).toHaveLength(1);
    expect(
      await t.run((ctx) => ctx.db.query("scholarHealthRecords").unique()),
    ).toMatchObject({
      scholarId,
      guardianId: guardianBId,
      signerUserId: guardianBId,
      revision: 2,
    });
    await expect(
      guardianA.mutation(
        api.scholarHealthRecords.saveHealthRecord,
        saveArgs(scholarId, completeFields(""), {
          expectedSignedRevision: 1,
        }),
      ),
    ).rejects.toThrow(/authorized guardian/i);
  });

  test("stores an additional contact without creating access or an account", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    const before = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      guardianships: await ctx.db.query("guardianships").collect(),
    }));

    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("Test guardian-a", {
          guardian2: {
            name: "Additional Contact",
            relationship: "legal_guardian",
            phone: "808-555-0400",
            workPhone: "",
            email: "additional@example.test",
            employer: "",
          },
        }),
        { currentStep: 10, lastCompletedStep: 9, submit: true },
      ),
    );

    const after = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      guardianships: await ctx.db.query("guardianships").collect(),
      record: await ctx.db.query("scholarHealthRecords").unique(),
    }));
    expect(after.users).toHaveLength(before.users.length);
    expect(after.guardianships).toHaveLength(before.guardianships.length);
    expect(after.record?.guardian2).toMatchObject({
      name: "Additional Contact",
      relationship: "legal_guardian",
      email: "additional@example.test",
    });
  });

  test("reports completed banner state with the signed date and pending edits", async () => {
    const { t, guardianAId, scholarId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, completeFields("Test guardian-a"), {
        currentStep: 10,
        lastCompletedStep: 9,
        submit: true,
      }),
    );
    const status = await guardian.query(
      api.scholarHealthRecords.hasCompletedHealthRecord,
      { scholarId },
    );
    expect(status).toMatchObject({
      completed: true,
      hasDraft: false,
      currentStep: 11,
    });
    expect(status.submittedAt).toBeTypeOf("number");
  });
});

describe("attested-answer comparison", () => {
  test("ignores signature and extracted-form fields, but not medical answers", () => {
    const signed = completeFields("Test guardian-a");
    // `getHealthRecord` hands a signed record back with the signature blanked,
    // so an untouched form must not read as changed.
    expect(
      healthRecordAnswersDiffer(signed, {
        ...signed,
        signerName: "",
        signerAgreement: false,
      }),
    ).toBe(false);
    expect(
      healthRecordAnswersDiffer(signed, {
        ...signed,
        peRecessRestriction: true,
        peRecessRestrictionDetails: "No running for two weeks.",
      }),
    ).toBe(false);
    expect(
      healthRecordAnswersDiffer(signed, {
        ...signed,
        noKnownAllergies: false,
      }),
    ).toBe(true);
  });

  test("treats an absent optional field and an undefined one as the same answer", () => {
    const base = completeFields("Test guardian-a", {
      guardian2: {
        name: "Additional Contact",
        relationship: "legal_guardian",
        phone: "808-555-0400",
        workPhone: "",
        email: "additional@example.test",
        employer: "",
      },
    });
    expect(
      healthRecordAnswersDiffer(base, {
        ...base,
        guardian2: { ...base.guardian2!, relationshipOther: undefined },
      }),
    ).toBe(false);
  });
});

describe("documents on an already-signed record", () => {
  /** Andy's prod case: medication stored at school, authorization to follow. */
  function medicationPending(
    signerName: string,
    overrides: Partial<HealthRecordFields> = {},
  ): HealthRecordFields {
    return completeFields(signerName, {
      noCurrentMedications: false,
      medications: [
        {
          name: "Amphetamine salts",
          purpose: "ADHD",
          dosage: "10mg",
          frequency: "Daily",
          administrationInstructions: "With breakfast",
          storedAtSchool: true,
          prescriptionOnFile: false,
        },
      ],
      schoolMedicationMode: "stored_at_school",
      medicationDocumentDelivery: "provide_separately",
      ...overrides,
    });
  }

  async function signedMedicationRecord() {
    const family = await setupFamily();
    const guardian = await withUser(family.t, family.guardianAId);
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(family.scholarId, medicationPending("Test guardian-a"), {
        currentStep: 10,
        lastCompletedStep: 9,
        submit: true,
      }),
    );
    return { ...family, guardian };
  }

  test("attaches a guardian upload to the signed record without a new signature", async () => {
    const { t, guardianAId, scholarId, institutionId, guardian } =
      await signedMedicationRecord();
    const teacherId = await seedUser(t, "teacher", "teacher", institutionId);
    await addMembership(t, teacherId, "teacher", institutionId);
    const teacher = await withUser(t, teacherId);

    const { result } = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "medication_authorization",
    );
    if (!result.ok) throw new Error(result.error);

    // Exactly what the wizard sends on Save & exit: the signature fields come
    // back blank on a signed record, so this save can never be a submit.
    const saved = await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        medicationPending("", {
          signerAgreement: false,
          medicationDocumentDelivery: "upload",
          medicationDocumentId: result.document.fileId,
        }),
        { expectedSignedRevision: 1, currentStep: 11, lastCompletedStep: 10 },
      ),
    );

    expect(saved).toMatchObject({ submitted: false, unsentChanges: false });
    const staffView = await teacher.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId },
    );
    expect(staffView?.medicationDocument?.fileId).toBe(result.document.fileId);
    expect(staffView?.medicationDocumentDelivery).toBe("upload");
    // A document is not an attested answer: the signature the family already
    // gave still stands, so nothing about it moves.
    expect(staffView?.revision).toBe(1);
    expect(staffView?.signedAt).toBe(staffView?.submittedAt);
    expect(
      await guardian.query(
        api.scholarHealthRecords.hasCompletedHealthRecord,
        { scholarId },
      ),
    ).toMatchObject({ unsentChanges: false, outstandingForms: [] });
  });

  test("still holds a changed ANSWER back until it is signed for", async () => {
    const { scholarId, guardian } = await signedMedicationRecord();
    const saved = await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        medicationPending("", {
          signerAgreement: false,
          noKnownAllergies: false,
          allergies: [
            {
              allergen: "Peanut",
              type: "food",
              reaction: "Hives",
              severity: "moderate",
              emergencyTreatment: "Call guardian",
              epipenOnFile: false,
            },
          ],
        }),
        { expectedSignedRevision: 1, currentStep: 3, lastCompletedStep: 2 },
      ),
    );
    expect(saved).toMatchObject({ submitted: false, unsentChanges: true });
    expect(
      await guardian.query(
        api.scholarHealthRecords.hasCompletedHealthRecord,
        { scholarId },
      ),
    ).toMatchObject({ unsentChanges: true });
  });

  test("tells a co-guardian's live draft about the attachment", async () => {
    const { t, guardianAId, guardianBId, scholarId, guardian } =
      await signedMedicationRecord();
    const guardianB = await withUser(t, guardianBId);
    // B opens the form and saves — a draft based on the same revision, with an
    // empty medication slot.
    await guardianB.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, medicationPending("", { signerAgreement: false }), {
        expectedSignedRevision: 1,
        currentStep: 11,
        lastCompletedStep: 10,
      }),
    );

    const { result } = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "medication_authorization",
    );
    if (!result.ok) throw new Error(result.error);
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        medicationPending("", {
          signerAgreement: false,
          medicationDocumentDelivery: "upload",
          medicationDocumentId: result.document.fileId,
        }),
        { expectedSignedRevision: 1, currentStep: 11, lastCompletedStep: 10 },
      ),
    );

    // No revision moved, so B's draft is still "current" — it has to have been
    // told, or B's next save silently unlinks the authorization.
    const bView = await guardianB.query(
      api.scholarHealthRecords.getHealthRecord,
      { scholarId },
    );
    expect(bView.hasPendingChanges).toBe(true);
    expect(bView.medicationDocument?.fileId).toBe(result.document.fileId);
    expect(bView.medicationDocumentDelivery).toBe("upload");
  });

  test("leaves a document in the draft when the signed record has no slot for it", async () => {
    const { t, guardianAId, scholarId, institutionId, guardian } =
      await signedMedicationRecord();
    const teacherId = await seedUser(t, "teacher", "teacher", institutionId);
    await addMembership(t, teacherId, "teacher", institutionId);
    const teacher = await withUser(t, teacherId);
    const { result } = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "action_plan_document_asthma",
    );
    if (!result.ok) throw new Error(result.error);

    const saved = await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        medicationPending("", {
          signerAgreement: false,
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
          actionPlanDocumentIds: { allergy: null, asthma: result.document.fileId },
        }),
        { expectedSignedRevision: 1, currentStep: 8, lastCompletedStep: 7 },
      ),
    );

    // Turning asthma on IS an attested answer, and a record that says "no
    // asthma" has nowhere to hold an asthma plan — both wait for the signature.
    expect(saved).toMatchObject({ unsentChanges: true });
    const staffView = await teacher.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId },
    );
    expect(staffView?.asthmaActionPlanDocument).toBeNull();
    expect(staffView?.hap.none).toBe(true);
  });

  test("unlinks a document the guardian removed, and audits every in-place change", async () => {
    const { t, guardianAId, scholarId, institutionId, guardian } =
      await signedMedicationRecord();
    const teacherId = await seedUser(t, "teacher", "teacher", institutionId);
    await addMembership(t, teacherId, "teacher", institutionId);
    const teacher = await withUser(t, teacherId);
    const { result } = await uploadHealthDocument(
      t,
      guardianAId,
      scholarId,
      "medication_authorization",
    );
    if (!result.ok) throw new Error(result.error);
    const attached = medicationPending("", {
      signerAgreement: false,
      medicationDocumentDelivery: "upload",
      medicationDocumentId: result.document.fileId,
    });
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, attached, {
        expectedSignedRevision: 1,
        currentStep: 11,
        lastCompletedStep: 10,
      }),
    );
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        medicationPending("", {
          signerAgreement: false,
          medicationDocumentDelivery: "",
          medicationDocumentId: null,
        }),
        {
          expectedDraftVersion: 1,
          expectedSignedRevision: 1,
          currentStep: 11,
          lastCompletedStep: 10,
        },
      ),
    );

    const staffView = await teacher.query(
      api.scholarHealthRecords.getHealthRecordForStaff,
      { scholarId },
    );
    expect(staffView?.medicationDocument).toBeNull();
    expect(staffView?.revision).toBe(1);
    expect(
      await t.run((ctx) => ctx.db.get(result.document.fileId)),
    ).toBeNull();
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_target", (q) => q.eq("targetUserId", scholarId))
        .collect(),
    );
    expect(audit.map((row) => row.action)).toEqual([
      "health_document.upload",
      "health_document.remove",
    ]);
    expect(audit.every((row) => row.actorUserId === guardianAId)).toBe(true);
  });
});

describe("staff health-record access", () => {
  test("allows same-institution staff and global admins, but denies cross-institution staff", async () => {
    const { t, guardianAId, scholarId, institutionId, adminId } =
      await setupFamily();
    const guardian = await withUser(t, guardianAId);
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(scholarId, completeFields("Test guardian-a"), {
        currentStep: 10,
        lastCompletedStep: 9,
        submit: true,
      }),
    );

    const sameTeacherId = await seedUser(
      t,
      "teacher",
      "same-teacher",
      institutionId,
    );
    await addMembership(t, sameTeacherId, "teacher", institutionId);
    const otherInstitutionId = await seedInstitution(t, "beta");
    await addMembership(t, sameTeacherId, "teacher", otherInstitutionId);
    // Operations staff with health access at another institution (the
    // retired registrar role's successor).
    const otherRegistrarId = await seedUser(t, "staff", "other-registrar");
    await addMembership(t, otherRegistrarId, "staff", otherInstitutionId);
    await grantHealthCapability(t, otherRegistrarId, otherInstitutionId);
    expect(
      await (
        await withUser(t, sameTeacherId)
      ).query(api.scholarHealthRecords.getHealthRecordForStaff, { scholarId }),
    ).toMatchObject({ scholarId, revision: 1 });
    for (const role of ["staff", "school_admin"] as const) {
      const sameInstitutionStaffId = await seedUser(
        t,
        role,
        `same-${role}`,
        institutionId,
      );
      await addMembership(
        t,
        sameInstitutionStaffId,
        role,
        institutionId,
      );
      if (role === "staff") {
        await grantHealthCapability(t, sameInstitutionStaffId, institutionId);
      }
      expect(
        await (
          await withUser(t, sameInstitutionStaffId)
        ).query(api.scholarHealthRecords.getHealthRecordForStaff, {
          scholarId,
        }),
      ).toMatchObject({ scholarId, revision: 1 });
    }
    await expect(
      (
        await withUser(t, otherRegistrarId)
      ).query(api.scholarHealthRecords.getHealthRecordForStaff, { scholarId }),
    ).rejects.toThrow(/not in your current context/i);
    expect(
      await (
        await withUser(t, adminId)
      ).query(api.scholarHealthRecords.getHealthRecordForStaff, { scholarId }),
    ).toMatchObject({ scholarId, revision: 1 });

    const betaScholarId = await seedUser(
      t,
      "scholar",
      "beta-scholar",
      otherInstitutionId,
    );
    await linkGuardian(t, guardianAId, betaScholarId, adminId);
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(betaScholarId, completeFields("Test guardian-a"), {
        currentStep: 10,
        lastCompletedStep: 9,
        submit: true,
      }),
    );
    expect(
      await (
        await withUser(t, sameTeacherId)
      ).query(api.scholarHealthRecords.getHealthRecordForStaff, {
        scholarId: betaScholarId,
        institutionScope: "beta",
      }),
    ).toMatchObject({ scholarId: betaScholarId, revision: 1 });
  });
});

describe("staff-aide emergency health lookup", () => {
  async function lookup(
    t: ReturnType<typeof convexTest>,
    callerUserId: Id<"users">,
    scholarName: string,
    institutionScope?: string,
  ) {
    return await t.run((ctx) =>
      ctx.runQuery(internal.scholarHealthRecords.getEmergencyInfoForAide, {
        callerUserId,
        scholarName,
        institutionScope,
      }),
    );
  }

  test("returns the minimum canonical emergency set with signer metadata to authorized staff", async () => {
    const { t, guardianAId, scholarId, institutionId, adminId } =
      await setupFamily();
    const guardian = await withUser(t, guardianAId);
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("Test guardian-a", {
          noKnownAllergies: false,
          allergies: [
            {
              allergen: "Peanuts",
              type: "food",
              reaction: "Hives",
              severity: "severe",
              emergencyTreatment: "Use epinephrine and call 911",
              epipenOnFile: true,
            },
          ],
          noCurrentMedications: false,
          schoolMedicationMode: "stored_at_school",
          medicationDocumentDelivery: "provide_separately",
          medications: [
            {
              name: "Rescue inhaler",
              purpose: "Asthma",
              dosage: "Two puffs",
              frequency: "As needed",
              administrationInstructions: "Use spacer",
              storedAtSchool: true,
              prescriptionOnFile: true,
            },
          ],
        }),
        { currentStep: 10, lastCompletedStep: 9, submit: true },
      ),
    );

    for (const role of ["teacher", "staff", "school_admin"] as const) {
      const staffId = await seedUser(
        t,
        role,
        `aide-${role}`,
        institutionId,
      );
      await addMembership(t, staffId, role, institutionId);
      if (role === "staff") {
        await grantHealthCapability(t, staffId, institutionId);
      }
      const result = await lookup(t, staffId, "Test scholar-a");
      expect(result).toMatchObject({
        status: "found",
        scholar: "Test scholar-a",
        emergencyInfo: {
          emergencyMedicalAuthorization: { authorized: true },
          allergies: {
            noneKnown: false,
            entries: [{ allergen: "Peanuts", severity: "severe" }],
          },
          medications: {
            noneCurrent: false,
            entries: [{ name: "Rescue inhaler" }],
            schoolHandling: "stored_at_school",
            authorizationDocumentation: "provide_separately",
          },
          immunization: {
            status: "up_to_date",
            supportingDocumentation: "provide_separately",
          },
          standardProgram: {
            acknowledgmentStatus: "legacy_signed_choices",
            publicMedia: {
              publicWebsiteAndSocialMediaOptOut: false,
              privateSchoolCommunicationsIncluded: true,
            },
            exceptions: {
              fieldTrips: { requested: false },
              physicalEducationAndRecess: { requested: false },
              swimming: {
                requested: false,
              },
            },
          },
        },
        submission: {
          revision: 1,
          signedName: "Test guardian-a",
          submittedBy: "Test guardian-a",
        },
      });
      expect(result).not.toHaveProperty("emergencyInfo.homeAddress");
      expect(result).not.toHaveProperty("emergencyInfo.guardian1Email");
      expect(result).not.toHaveProperty("emergencyInfo.immunizationStatus");
      expect(result).not.toHaveProperty("emergencyInfo.photoConsent");
      expect(result).not.toHaveProperty("emergencyInfo.fieldTripConsent");
      expect(result).not.toHaveProperty("emergencyInfo.swimConsent");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(
        /healthRecordFiles|storageId|fileName|https?:\/\//i,
      );
      expect(serialized).not.toContain("prescriptionOnFile");
    }
    expect(await lookup(t, adminId, "Test scholar-a")).toMatchObject({
      status: "found",
      scholar: "Test scholar-a",
    });
  });

  test("fails closed for wrong-institution and non-staff callers", async () => {
    const { t, scholarId, institutionId } = await setupFamily();
    const otherInstitutionId = await seedInstitution(t, "other");
    const teacherId = await seedUser(
      t,
      "teacher",
      "other-teacher",
      otherInstitutionId,
    );
    await addMembership(t, teacherId, "teacher", otherInstitutionId);
    expect(await lookup(t, teacherId, "Test scholar-a")).toEqual({
      status: "not_found",
    });

    await expect(lookup(t, scholarId, "Test scholar-a")).rejects.toThrow(
      /health access required/i,
    );
    void institutionId;
  });

  test("rejects ambiguous scholar names instead of guessing", async () => {
    const { t, adminId, institutionId } = await setupFamily();
    await seedUser(t, "scholar", "scholar-ab", institutionId);

    expect(await lookup(t, adminId, "Test scholar")).toEqual({
      status: "ambiguous",
      candidates: ["Test scholar-a", "Test scholar-ab"],
    });

    await t.run(async (ctx) => {
      const duplicateId = await ctx.db.insert("users", {
        name: "Test scholar-a",
        username: "scholar-duplicate",
        role: "scholar",
        institutionId,
      });
      return duplicateId;
    });
    expect(await lookup(t, adminId, "Test scholar-a")).toEqual({
      status: "ambiguous",
      candidates: ["Test scholar-a", "Test scholar-a"],
    });
  });

  test("returns no-record for a guardian-private draft and never reads draft fields", async () => {
    const { t, guardianAId, scholarId, adminId } = await setupFamily();
    const guardian = await withUser(t, guardianAId);
    await guardian.mutation(
      api.scholarHealthRecords.saveHealthRecord,
      saveArgs(
        scholarId,
        completeFields("", {
          allergyNotes: "Draft-only private note",
          signerAgreement: false,
        }),
        { currentStep: 4, lastCompletedStep: 3 },
      ),
    );

    const result = await lookup(t, adminId, "Test scholar-a");
    expect(result).toEqual({
      status: "no_record",
      scholar: "Test scholar-a",
    });
    expect(JSON.stringify(result)).not.toContain("Draft-only private note");
  });
});

describe("health-record confirmation privacy", () => {
  test("confirmation copy contains no child identity or medical details", () => {
    const content =
      `${HEALTH_RECORD_CONFIRMATION_SUBJECT} ${renderHealthRecordConfirmationHtml()}`.toLowerCase();
    expect(content).not.toMatch(
      /allerg|medication|condition|diagnos|physician|emergency|treatment|child/,
    );
    expect(content).toContain("form submitted");
  });
});
