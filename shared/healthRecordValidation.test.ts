import { describe, expect, test } from "vitest";

import { healthFormSubmissionIssues } from "../components/parent/healthFormState";
import {
  healthRecordBusinessIssues,
  normalizeHealthRecordFields,
  type HealthRecordFields,
} from "../convex/lib/healthRecord";
import {
  normalizeHealthRecordBusinessFields,
  type HealthRecordIssueCode,
} from "./healthRecordValidation";

function completeFields(
  overrides: Partial<HealthRecordFields> = {},
): HealthRecordFields {
  return {
    childName: "Test Scholar",
    childPreferredName: "",
    childDob: "2018-03-15",
    childGrade: "2",
    homeAddress: "123 Test Street",
    streetAddress: "123 Test Street",
    city: "Honolulu",
    state: "HI",
    zipCode: "96818",
    homePrimaryLanguage: "English",
    physicianName: "Dr. Test",
    physicianPhone: "808-555-0100",
    dentistName: "",
    dentistPhone: "",
    insurancePlan: "Test Plan",
    insuranceId: "ABC-123",
    guardian1Name: "Test Guardian",
    guardian1Relationship: "parent",
    guardian1RelationshipOther: "",
    guardian1Phone: "808-555-0200",
    guardian1WorkPhone: "",
    guardian1Email: "guardian@example.test",
    guardian1Employer: "",
    guardian2: null,
    custodyNotes: "",
    custodyDocumentDelivery: "",
    custodyDocumentId: null,
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
    allergies: [],
    allergyNotes: "",
    chronicConditions: [],
    chronicConditionDetails: "",
    noChronicConditions: true,
    noCurrentMedications: true,
    medications: [],
    schoolMedicationMode: "none",
    medicationDocumentDelivery: "not_required",
    medicationDocumentId: null,
    immunizationStatus: "up_to_date",
    immunizationNotes: "",
    immunizationDocumentDelivery: "provide_separately",
    immunizationDocumentId: null,
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
    hapDocumentDelivery: "",
    actionPlanDocumentId: null,
    actionPlanDocumentIds: { allergy: null, asthma: null },
    emergencyMedAuthAck: true,
    emergencyMedAuthNotes: "",
    publicMediaOptOut: false,
    privateSchoolMediaOptOut: false,
    fieldTripRestriction: false,
    fieldTripRestrictionDetails: "",
    peRecessRestriction: false,
    peRecessRestrictionDetails: "",
    swimmingRestriction: false,
    swimmingRestrictionDetails: "",
    cookingWaiverParentFullName: "Test Guardian",
    cookingWaiverStudentFullName: "Test Scholar",
    cookingWaiverDetails: "none",
    cookingWaiverDate: "2026-08-14",
    signerName: "Test Guardian",
    signerAgreement: true,
    ...overrides,
  };
}

function sharedIssues(fields: HealthRecordFields) {
  return healthFormSubmissionIssues(fields, "Test Guardian").map(
    ({ code, step, field, message }) => ({ code, step, field, message }),
  );
}

describe("health-record validation parity", () => {
  const cases: Array<{
    name: string;
    fields: HealthRecordFields;
    expected: {
      code: HealthRecordIssueCode;
      step: number;
      field: string;
    };
  }> = [
    {
      name: "step 1 child information",
      fields: completeFields({ childDob: "" }),
      expected: { code: "required", step: 0, field: "childDob" },
    },
    {
      name: "step 2 guardian information",
      fields: completeFields({
        guardian2: {
          name: "Additional Guardian",
          relationship: "legal_guardian",
          phone: "808-555-0400",
          email: "asd",
        },
      }),
      expected: {
        code: "invalid_email",
        step: 1,
        field: "guardian2.email",
      },
    },
    {
      name: "step 3 emergency contacts",
      fields: completeFields({ emergencyContacts: [] }),
      expected: { code: "required", step: 2, field: "emergencyContacts" },
    },
    {
      name: "step 4 allergies",
      fields: completeFields({
        noKnownAllergies: false,
        allergies: [],
      }),
      expected: { code: "required", step: 3, field: "allergies" },
    },
    {
      name: "step 5 chronic conditions",
      fields: completeFields({
        noChronicConditions: false,
        chronicConditions: [],
      }),
      expected: { code: "required", step: 4, field: "chronicConditions" },
    },
    {
      name: "step 6 medications",
      fields: completeFields({ schoolMedicationMode: "" }),
      expected: { code: "required", step: 5, field: "schoolMedicationMode" },
    },
    {
      name: "step 7 immunizations",
      fields: completeFields({
        immunizationStatus: "",
        immunizationDocumentDelivery: "",
      }),
      expected: { code: "required", step: 6, field: "immunizationStatus" },
    },
    {
      name: "step 8 developmental & mental health",
      fields: completeFields({ developmentalConditionsPresent: "" }),
      expected: {
        code: "required",
        step: 7,
        field: "developmentalConditionsPresent",
      },
    },
    {
      name: "step 9 action plans",
      fields: completeFields({
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
      expected: { code: "required", step: 8, field: "hap" },
    },
    {
      name: "step 10 emergency authorization",
      fields: completeFields({ emergencyMedAuthAck: false }),
      expected: {
        code: "required",
        step: 9,
        field: "emergencyMedAuthAck",
      },
    },
    {
      name: "step 11 signature",
      fields: completeFields({ signerName: "Different Name" }),
      expected: {
        code: "signature_mismatch",
        step: 10,
        field: "signerName",
      },
    },
  ];

  test.each(cases)("$name has identical client and server issues", ({ fields, expected }) => {
    const clientIssues = sharedIssues(fields);
    const serverIssues = healthRecordBusinessIssues(
      fields,
      true,
      "Test Guardian",
    );

    expect(clientIssues).toEqual(serverIssues);
    expect(clientIssues).toContainEqual(expect.objectContaining(expected));
  });

  test("normalizes optional blanks identically without discarding invalid data", () => {
    const fields = completeFields({
      guardian2: {
        name: " Additional Guardian ",
        relationship: "legal_guardian",
        phone: " 808-555-0400 ",
        workPhone: " ",
        email: " asd ",
        employer: "",
      },
    });

    const clientFields = normalizeHealthRecordBusinessFields(fields);
    const serverFields = normalizeHealthRecordFields(fields);

    expect(clientFields).toEqual(serverFields);
    expect(clientFields.guardian2).toEqual({
      name: "Additional Guardian",
      relationship: "legal_guardian",
      phone: "808-555-0400",
      workPhone: undefined,
      email: "asd",
      employer: undefined,
    });
    expect(sharedIssues(clientFields)).toContainEqual(
      expect.objectContaining({
        code: "invalid_email",
        step: 1,
        field: "guardian2.email",
      }),
    );
  });

  test("keeps explicit participation choices ahead of legacy compatibility values", () => {
    const fields = {
      ...completeFields(),
      publicMediaOptOut: false,
      fieldTripRestriction: false,
      peRecessRestriction: false,
      swimmingRestriction: false,
      photoConsent: "no" as const,
      fieldTripConsent: "no" as const,
      physicalActivityConsent: "no" as const,
      swimConsent: "no" as const,
    };

    const clientFields = normalizeHealthRecordBusinessFields(fields);
    const serverFields = normalizeHealthRecordFields(fields);

    expect(clientFields).toEqual(serverFields);
    expect(clientFields).toMatchObject({
      publicMediaOptOut: false,
      fieldTripRestriction: false,
      peRecessRestriction: false,
      swimmingRestriction: false,
    });
  });
});
