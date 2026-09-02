import type { Id } from "../../convex/_generated/dataModel";
import {
  HEALTH_RECORD_MAX_ALLERGIES,
  HEALTH_RECORD_MAX_EMERGENCY_CONTACTS,
  HEALTH_RECORD_MAX_MEDICATIONS,
  healthRecordStepIssues,
  healthRecordValidationIssues,
  isHealthRecordConflictErrorData,
  isHealthRecordValidationErrorData,
  type HealthRecordAllergy,
  type HealthRecordAllergySeverity,
  type HealthRecordAllergyType,
  type HealthRecordChronicCondition,
  type HealthRecordDevelopmentalCondition,
  type HealthRecordSupportPlan,
  type HealthRecordEmergencyContact,
  type HealthRecordGuardianContact,
  type HealthRecordImmunizationDocumentDelivery,
  type HealthRecordImmunizationStatus,
  type HealthRecordMedication,
  type HealthRecordMedicationDocumentDelivery,
  type HealthRecordSchoolMedicationMode,
  type HealthRecordValidationData,
  type HealthRecordValidationIssue as SharedHealthRecordValidationIssue,
} from "../../shared/healthRecordValidation";
import type { GuardianRelationship } from "../../shared/guardianRelationships";

export {
  guardianRelationshipFormOptions,
  guardianRelationshipLabel,
  guardianRelationshipOptions,
  normalizeGuardianRelationship,
} from "../../shared/guardianRelationships";
export type { GuardianRelationship };

export type AllergyType = HealthRecordAllergyType;
export type AllergySeverity = HealthRecordAllergySeverity;
export type ChronicCondition = HealthRecordChronicCondition;
export type DevelopmentalCondition = HealthRecordDevelopmentalCondition;
export type SupportPlan = HealthRecordSupportPlan;
export type ImmunizationStatus = HealthRecordImmunizationStatus;
export type SchoolMedicationMode = HealthRecordSchoolMedicationMode;
export type MedicationDocumentDelivery =
  HealthRecordMedicationDocumentDelivery;
export type ImmunizationDocumentDelivery =
  HealthRecordImmunizationDocumentDelivery;

export type GuardianContact = Required<HealthRecordGuardianContact>;
export type EmergencyContact = HealthRecordEmergencyContact;
export type Allergy = HealthRecordAllergy;
export type Medication = HealthRecordMedication;
export type HealthFormData = Omit<
  HealthRecordValidationData<Id<"healthRecordFiles">>,
  "guardian2" | "actionPlanDocumentIds"
> & {
  guardian2: GuardianContact | null;
  actionPlanDocumentIds: NonNullable<
    HealthRecordValidationData<
      Id<"healthRecordFiles">
    >["actionPlanDocumentIds"]
  >;
};

export const MAX_EMERGENCY_CONTACTS =
  HEALTH_RECORD_MAX_EMERGENCY_CONTACTS;
export const MAX_ALLERGIES = HEALTH_RECORD_MAX_ALLERGIES;
export const MAX_MEDICATIONS = HEALTH_RECORD_MAX_MEDICATIONS;
export const ADDITIONAL_GUARDIAN_ACCESS_HELPER =
  "Listing this person does not create a Rabbithole account or grant access.";

export const allergyTypeOptions = [
  ["food", "Food"],
  ["insect", "Insect"],
  ["medication", "Medication"],
  ["environmental", "Environmental"],
  ["latex", "Latex"],
  ["other", "Other"],
] as const;

export const allergySeverityOptions = [
  ["mild", "Mild"],
  ["moderate", "Moderate"],
  ["severe", "Severe (anaphylactic)"],
] as const;

export const chronicConditionOptions: ReadonlyArray<
  readonly [ChronicCondition, string]
> = [
  ["asthma", "Asthma"],
  ["diabetes", "Diabetes"],
  ["epilepsy", "Epilepsy"],
  ["heart_condition", "Heart condition"],
  ["adhd", "ADHD"],
  ["anxiety", "Anxiety"],
  ["depression", "Depression"],
  ["hearing_impairment", "Hearing impairment"],
  ["visual_impairment", "Visual impairment"],
  ["physical_disability", "Physical disability"],
  ["other", "Other"],
];

export const developmentalConditionOptions: ReadonlyArray<
  readonly [DevelopmentalCondition, string]
> = [
  ["adhd", "ADHD / ADD"],
  ["autism", "Autism Spectrum Disorder (ASD)"],
  ["anxiety", "Anxiety"],
  ["depression", "Depression"],
  ["dyslexia", "Dyslexia"],
  ["dysgraphia", "Dysgraphia"],
  ["dyscalculia", "Dyscalculia"],
  ["speech_language", "Speech or Language Disorder"],
  ["developmental_delay", "Developmental Delay"],
  ["sensory_processing", "Sensory Processing Differences"],
  ["behavioral_concern", "Behavioral Concern"],
  ["other", "Other"],
];

export const supportPlanOptions: ReadonlyArray<
  readonly [SupportPlan, string]
> = [
  ["none", "None"],
  ["iep", "Individualized Education Program (IEP)"],
  ["section_504", "Section 504 Plan"],
  ["bip", "Behavior Intervention Plan (BIP)"],
  ["other", "Other"],
];

export function createEmptyGuardianContact(): GuardianContact {
  return {
    name: "",
    relationship: "",
    relationshipOther: "",
    phone: "",
    workPhone: "",
    email: "",
    employer: "",
  };
}

export function createEmptyEmergencyContact(): EmergencyContact {
  return {
    name: "",
    relationship: "",
    phone: "",
    altPhone: "",
    canPickUp: false,
  };
}

export function createEmptyAllergy(): Allergy {
  return {
    allergen: "",
    type: "",
    reaction: "",
    severity: "",
    emergencyTreatment: "",
    epipenOnFile: false,
  };
}

export function createEmptyMedication(): Medication {
  return {
    name: "",
    purpose: "",
    dosage: "",
    frequency: "",
    administrationInstructions: "",
    storedAtSchool: false,
    prescriptionOnFile: false,
  };
}

export function createEmptyHealthFormData(): HealthFormData {
  return {
    childName: "",
    childPreferredName: "",
    childDob: "",
    childGrade: "",
    homeAddress: "",
    streetAddress: "",
    city: "",
    state: "",
    zipCode: "",
    homePrimaryLanguage: "",
    physicianName: "",
    physicianPhone: "",
    dentistName: "",
    dentistPhone: "",
    insurancePlan: "",
    insuranceId: "",
    guardian1Name: "",
    guardian1Relationship: "",
    guardian1RelationshipOther: "",
    guardian1Phone: "",
    guardian1WorkPhone: "",
    guardian1Email: "",
    guardian1Employer: "",
    guardian2: null,
    custodyNotes: "",
    custodyDocumentDelivery: "",
    custodyDocumentId: null,
    emergencyContacts: [],
    noKnownAllergies: false,
    allergies: [],
    allergyNotes: "",
    chronicConditions: [],
    chronicConditionDetails: "",
    noChronicConditions: false,
    noCurrentMedications: false,
    medications: [],
    schoolMedicationMode: "",
    medicationDocumentDelivery: "",
    medicationDocumentId: null,
    immunizationStatus: "",
    immunizationNotes: "",
    immunizationDocumentDelivery: "",
    immunizationDocumentId: null,
    developmentalConditionsPresent: "",
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
      none: false,
      notes: "",
    },
    hapDocumentDelivery: "",
    actionPlanDocumentId: null,
    actionPlanDocumentIds: { allergy: null, asthma: null },
    emergencyMedAuthAck: false,
    emergencyMedAuthNotes: "",
    publicMediaOptOut: false,
    privateSchoolMediaOptOut: false,
    fieldTripRestriction: false,
    fieldTripRestrictionDetails: "",
    peRecessRestriction: false,
    peRecessRestrictionDetails: "",
    swimmingRestriction: false,
    swimmingRestrictionDetails: "",
    cookingWaiverParentFullName: "",
    cookingWaiverStudentFullName: "",
    cookingWaiverDetails: "",
    cookingWaiverDate: "",
    signerName: "",
    signerAgreement: false,
  };
}

export function signatureNameInstruction(accountName: string): string {
  const normalizedAccountName = accountName.trim().replace(/\s+/g, " ");
  return normalizedAccountName
    ? `Type your full legal name exactly as it appears on your account (${normalizedAccountName})`
    : "Type your full legal name exactly as it will appear on your account";
}

export type SubmittingAccountContact = {
  name: string;
  email: string;
  phone: string;
};

export function missingSubmittingAccountFields(
  contact: SubmittingAccountContact,
): Array<keyof SubmittingAccountContact> {
  return (["name", "email", "phone"] as const).filter(
    (field) => contact[field].trim() === "",
  );
}

function issueFieldId(issue: SharedHealthRecordValidationIssue): string {
  const { field, step } = issue;
  const exactFields: Record<string, string> = {
    childDob: "health-child-dob",
    homeAddress: "health-street-address",
    streetAddress: "health-street-address",
    city: "health-city",
    state: "health-state",
    zipCode: "health-zip",
    physicianName: "health-physician-name",
    physicianPhone: "health-physician-name",
    insurancePlan: "health-insurance-plan",
    insuranceId: "health-insurance-id",
    guardian1Name: "health-guardian1-name",
    guardian1Relationship: "health-guardian1-relationship",
    guardian1RelationshipOther: "health-guardian1-relationship-other",
    guardian1Phone: "health-guardian1-phone",
    guardian1WorkPhone: "health-guardian1-phone",
    guardian1Email: "health-guardian1-email",
    guardian1Employer: "health-guardian1-name",
    "guardian2.name": "health-guardian2-name",
    "guardian2.relationship": "health-guardian2-relationship",
    "guardian2.relationshipOther": "health-guardian2-relationship-other",
    "guardian2.phone": "health-guardian2-phone",
    "guardian2.workPhone": "health-guardian2-phone",
    "guardian2.email": "health-guardian2-email",
    "guardian2.employer": "health-guardian2-name",
    cookingWaiverParentFullName: "health-cooking-waiver-parent-name",
    cookingWaiverStudentFullName: "health-cooking-waiver-student-name",
    cookingWaiverDetails: "health-cooking-waiver-details",
    cookingWaiverDate: "health-cooking-waiver-date",
    signerName: "health-signer-name",
    signerAgreement: "health-signer-agreement",
  };
  if (exactFields[field]) return exactFields[field];
  const emergencyField = field.match(
    /^emergencyContacts\.(\d+)\.(name|relationship|phone|altPhone)$/,
  );
  if (emergencyField) {
    const [, index, key] = emergencyField;
    const domKey = key === "altPhone" ? "phone" : key;
    return `health-emergency-${Number(index) + 1}-${domKey}`;
  }
  const sectionFields: Record<number, string> = {
    3: "health-allergies",
    4: "health-chronic-conditions",
    5: "health-medications",
    6: "health-immunizations",
    7: "health-developmental",
    8: "health-action-plans",
    9: "health-emergency-authorization",
    10: "health-program-exceptions",
  };
  return sectionFields[step] ?? `health-step-${step}`;
}

export type HealthFormValidationIssue = SharedHealthRecordValidationIssue & {
  fieldId: string;
};

function toFormIssue(
  issue: SharedHealthRecordValidationIssue,
): HealthFormValidationIssue {
  return { ...issue, fieldId: issueFieldId(issue) };
}

export function healthFormStepIssues(
  data: HealthRecordValidationData,
  step: number,
  accountSignerName = "",
): HealthFormValidationIssue[] {
  return healthRecordStepIssues(data, step, accountSignerName).map(toFormIssue);
}

export function healthFormStepErrors(
  data: HealthRecordValidationData,
  step: number,
  accountSignerName = "",
): string[] {
  return healthFormStepIssues(data, step, accountSignerName).map(
    (issue) => issue.message,
  );
}

export function healthFormSubmissionIssues(
  data: HealthRecordValidationData,
  accountSignerName = "",
): HealthFormValidationIssue[] {
  return healthRecordValidationIssues(data, {
    submit: true,
    accountSignerName,
  }).map(toFormIssue);
}

export function healthFormSubmissionErrors(
  data: HealthRecordValidationData,
  accountSignerName = "",
): string[] {
  return healthFormSubmissionIssues(data, accountSignerName).map(
    (issue) => issue.message,
  );
}

export type HealthFormErrorOperation = "save" | "submit" | "upload" | "remove";

export type PublicHealthFormError = {
  message: string;
  issue?: HealthFormValidationIssue;
  conflict: boolean;
};

function errorData(error: unknown): unknown {
  return error && typeof error === "object" && "data" in error
    ? (error as { data?: unknown }).data
    : undefined;
}

export function publicHealthFormError(
  error: unknown,
  operation: HealthFormErrorOperation,
): PublicHealthFormError {
  const data = errorData(error);
  if (isHealthRecordValidationErrorData(data)) {
    const issue = toFormIssue(data.issue);
    return { message: issue.message, issue, conflict: false };
  }
  if (isHealthRecordConflictErrorData(data)) {
    return { message: data.message, conflict: true };
  }

  const genericMessages: Record<HealthFormErrorOperation, string> = {
    save:
      "We couldn't save your progress. Try again. If this keeps happening, contact the school office for help.",
    submit:
      "We couldn't submit the form. Try again. If this keeps happening, contact the school office for help.",
    upload:
      "We couldn't upload this document. Check the file and try again. If this keeps happening, contact the school office for help.",
    remove:
      "We couldn't remove this document. Try again. If this keeps happening, contact the school office for help.",
  };
  return {
    message: genericMessages[operation],
    conflict: false,
  };
}

export type HealthFormBannerState = {
  completed: boolean;
  showOnProgress: boolean;
  showInRecords: boolean;
  title: string;
  actionLabel: string;
  submittedAt: number | null;
  /**
   * Answers saved but not signed for, so the school is still reading the older
   * signed record. Uploaded documents never land here — they are committed to
   * the signed record in place — so this only ever means a real, outstanding
   * signature, and it is the one durable reminder a guardian who chose "exit
   * without sending" will ever see.
   */
  unsentChanges: boolean;
};

export function getHealthFormBannerState(
  status: {
    completed: boolean;
    submittedAt: number | null;
    hasDraft: boolean;
    unsentChanges?: boolean;
  },
  scholarName: string,
): HealthFormBannerState {
  const unsentChanges = status.unsentChanges === true;
  if (status.completed) {
    return {
      completed: true,
      showOnProgress: unsentChanges,
      showInRecords: true,
      title: unsentChanges
        ? `Sign your updates to ${scholarName.trim() || "your child"}'s health form`
        : "Health & emergency form on file",
      actionLabel: unsentChanges ? "Review & sign" : "Review & update",
      submittedAt: status.submittedAt,
      unsentChanges,
    };
  }
  const name = scholarName.trim();
  return {
    completed: false,
    showOnProgress: true,
    showInRecords: false,
    title: `Complete ${name ? `${name}'s` : "your child's"} health & emergency form`,
    actionLabel: status.hasDraft ? "Continue" : "Start form",
    submittedAt: null,
    unsentChanges,
  };
}
