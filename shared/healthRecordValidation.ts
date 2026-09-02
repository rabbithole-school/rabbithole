import { type GuardianRelationship } from "./guardianRelationships";

export const HEALTH_RECORD_MAX_EMERGENCY_CONTACTS = 5;
export const HEALTH_RECORD_MAX_ALLERGIES = 20;
export const HEALTH_RECORD_MAX_MEDICATIONS = 20;

const SHORT_TEXT_LIMIT = 200;
const PHONE_LIMIT = 50;
const EMAIL_LIMIT = 320;
const ADDRESS_LIMIT = 1_000;
const LONG_TEXT_LIMIT = 5_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidHealthRecordDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function hasCompletedCookingWaiver(fields: {
  cookingWaiverParentFullName?: string;
  cookingWaiverStudentFullName?: string;
  cookingWaiverDetails?: string;
  cookingWaiverDate?: string;
}): boolean {
  return (
    typeof fields.cookingWaiverParentFullName === "string" &&
    fields.cookingWaiverParentFullName.trim().length > 0 &&
    typeof fields.cookingWaiverStudentFullName === "string" &&
    fields.cookingWaiverStudentFullName.trim().length > 0 &&
    typeof fields.cookingWaiverDetails === "string" &&
    fields.cookingWaiverDetails.trim().length > 0 &&
    typeof fields.cookingWaiverDate === "string" &&
    isValidHealthRecordDate(fields.cookingWaiverDate)
  );
}

export type HealthRecordAllergyType =
  | ""
  | "food"
  | "insect"
  | "medication"
  | "environmental"
  | "latex"
  | "other";

export type HealthRecordAllergySeverity = ""
  | "mild"
  | "moderate"
  | "severe";

export type HealthRecordChronicCondition =
  | "asthma"
  | "diabetes"
  | "epilepsy"
  | "heart_condition"
  | "adhd"
  | "anxiety"
  | "depression"
  | "hearing_impairment"
  | "visual_impairment"
  | "physical_disability"
  | "other";

export type HealthRecordImmunizationStatus =
  | ""
  | "up_to_date"
  | "medical_exemption"
  | "religious_exemption";

export type HealthRecordSchoolMedicationMode =
  | ""
  | "none"
  | "stored_at_school"
  | "self_carry_emergency"
  | "both";

export type HealthRecordMedicationDocumentDelivery =
  | ""
  | "not_required"
  | "upload"
  | "provide_separately";

export type HealthRecordImmunizationDocumentDelivery =
  | ""
  | "upload"
  | "provide_separately";

// Upload vs. provide-separately choice used by the custody, healthcare
// action-plan, and support-plan document fields.
export type HealthRecordUploadDelivery = "" | "upload" | "provide_separately";

export type HealthRecordDevelopmentalStatus = "" | "yes" | "no";

export type HealthRecordDevelopmentalCondition =
  | "adhd"
  | "autism"
  | "anxiety"
  | "depression"
  | "dyslexia"
  | "dysgraphia"
  | "dyscalculia"
  | "speech_language"
  | "developmental_delay"
  | "sensory_processing"
  | "behavioral_concern"
  | "other";

export type HealthRecordSupportPlan =
  | "none"
  | "iep"
  | "section_504"
  | "bip"
  | "other";

export type HealthRecordGuardianContact = {
  name: string;
  relationship: GuardianRelationship;
  relationshipOther?: string;
  phone: string;
  workPhone?: string;
  email: string;
  employer?: string;
};

export type HealthRecordEmergencyContact = {
  name: string;
  relationship: string;
  phone: string;
  altPhone: string;
  canPickUp: boolean;
};

export type HealthRecordAllergy = {
  allergen: string;
  type: HealthRecordAllergyType;
  reaction: string;
  severity: HealthRecordAllergySeverity;
  emergencyTreatment: string;
  epipenOnFile: boolean;
};

export type HealthRecordMedication = {
  name: string;
  purpose: string;
  dosage: string;
  frequency: string;
  administrationInstructions: string;
  storedAtSchool: boolean;
  prescriptionOnFile: boolean;
};

export type HealthRecordValidationData<DocumentId = unknown> = {
  childName: string;
  childPreferredName: string;
  childDob: string;
  childGrade: string;
  // homeAddress is retained as a composed convenience value for staff/aide
  // readers; the structured street/city/state/zip parts are the source of truth.
  homeAddress: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  homePrimaryLanguage: string;
  physicianName: string;
  physicianPhone: string;
  dentistName: string;
  dentistPhone: string;
  insurancePlan: string;
  insuranceId: string;
  guardian1Name: string;
  guardian1Relationship: GuardianRelationship;
  guardian1RelationshipOther: string;
  guardian1Phone: string;
  guardian1WorkPhone: string;
  guardian1Email: string;
  guardian1Employer: string;
  guardian2: HealthRecordGuardianContact | null;
  custodyNotes: string;
  custodyDocumentDelivery: HealthRecordUploadDelivery;
  custodyDocumentId: DocumentId | null;
  emergencyContacts: HealthRecordEmergencyContact[];
  noKnownAllergies: boolean;
  allergies: HealthRecordAllergy[];
  allergyNotes: string;
  chronicConditions: HealthRecordChronicCondition[];
  chronicConditionDetails: string;
  noChronicConditions: boolean;
  noCurrentMedications: boolean;
  medications: HealthRecordMedication[];
  schoolMedicationMode: HealthRecordSchoolMedicationMode;
  medicationDocumentDelivery: HealthRecordMedicationDocumentDelivery;
  medicationDocumentId: DocumentId | null;
  immunizationStatus: HealthRecordImmunizationStatus;
  immunizationNotes: string;
  immunizationDocumentDelivery: HealthRecordImmunizationDocumentDelivery;
  immunizationDocumentId: DocumentId | null;
  developmentalConditionsPresent: HealthRecordDevelopmentalStatus;
  developmentalConditions: HealthRecordDevelopmentalCondition[];
  developmentalConditionsOther: string;
  developmentalSupportNotes: string;
  developmentalSuccessfulSupports: string;
  supportPlans: HealthRecordSupportPlan[];
  supportPlanOther: string;
  supportPlanDocumentDelivery: HealthRecordUploadDelivery;
  supportPlanDocumentId: DocumentId | null;
  hap: {
    allergy: boolean;
    asthma: boolean;
    seizure: boolean;
    diabetes: boolean;
    behavioralHealth: boolean;
    other: boolean;
    otherDesc: string;
    none: boolean;
    notes: string;
  };
  hapDocumentDelivery: HealthRecordUploadDelivery;
  actionPlanDocumentId: DocumentId | null;
  // Condition-keyed action-plan pointers, keyed by the `hap.*` flag they hang
  // off. Sit ALONGSIDE the legacy generic `actionPlanDocumentId` (which keeps
  // serving seizure / diabetes / behavioral-health / other) so a scholar with
  // both a food-allergy EAP and an asthma EAP can hold both at once. Optional
  // for back-compat: rows signed before this field existed omit it entirely.
  actionPlanDocumentIds?: {
    allergy: DocumentId | null;
    asthma: DocumentId | null;
  };
  emergencyMedAuthAck: boolean;
  emergencyMedAuthNotes: string;
  publicMediaOptOut: boolean;
  privateSchoolMediaOptOut: boolean;
  fieldTripRestriction: boolean;
  fieldTripRestrictionDetails: string;
  peRecessRestriction: boolean;
  peRecessRestrictionDetails: string;
  swimmingRestriction: boolean;
  swimmingRestrictionDetails: string;
  cookingWaiverParentFullName: string;
  cookingWaiverStudentFullName: string;
  cookingWaiverDetails: string;
  cookingWaiverDate: string;
  signerName: string;
  signerAgreement: boolean;
};

export type LegacyHealthRecordParticipation = {
  photoConsent?: "" | "yes" | "no";
  fieldTripConsent?: "" | "yes" | "no";
  physicalActivityConsent?: "" | "yes" | "no";
  activityRestrictions?: string;
  swimConsent?: "" | "yes" | "no";
};

export type HealthRecordNormalizationCompatibility =
  LegacyHealthRecordParticipation &
    Partial<
      Pick<
        HealthRecordValidationData,
        | "publicMediaOptOut"
        | "privateSchoolMediaOptOut"
        | "fieldTripRestriction"
        | "fieldTripRestrictionDetails"
        | "peRecessRestriction"
        | "peRecessRestrictionDetails"
        | "swimmingRestriction"
        | "swimmingRestrictionDetails"
      >
    >;

export type HealthRecordIssueCode =
  | "required"
  | "invalid_email"
  | "invalid_date"
  | "too_long"
  | "too_many"
  | "duplicate"
  | "invalid_combination"
  | "document_required"
  | "signature_mismatch";

export type HealthRecordValidationIssue = {
  code: HealthRecordIssueCode;
  step: number;
  field: string;
  message: string;
};

export type HealthRecordValidationErrorData = {
  kind: "health_record_validation";
  issue: HealthRecordValidationIssue;
};

export type HealthRecordConflictErrorData = {
  kind: "health_record_conflict";
  code: "signed_revision_conflict" | "draft_version_conflict";
  message: string;
};

export function isHealthRecordValidationErrorData(
  value: unknown,
): value is HealthRecordValidationErrorData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HealthRecordValidationErrorData>;
  const issue = candidate.issue as Partial<HealthRecordValidationIssue> | undefined;
  return (
    candidate.kind === "health_record_validation" &&
    !!issue &&
    typeof issue.code === "string" &&
    typeof issue.step === "number" &&
    typeof issue.field === "string" &&
    typeof issue.message === "string"
  );
}

export function isHealthRecordConflictErrorData(
  value: unknown,
): value is HealthRecordConflictErrorData {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HealthRecordConflictErrorData>;
  return (
    candidate.kind === "health_record_conflict" &&
    (candidate.code === "signed_revision_conflict" ||
      candidate.code === "draft_version_conflict") &&
    typeof candidate.message === "string"
  );
}

function text(value: string | undefined): string {
  return value?.trim() ?? "";
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = text(value);
  return normalized || undefined;
}

function withoutLegacyParticipation<DocumentId>(
  fields: HealthRecordValidationData<DocumentId> &
    LegacyHealthRecordParticipation,
): HealthRecordValidationData<DocumentId> {
  const businessFields = { ...fields };
  delete businessFields.photoConsent;
  delete businessFields.fieldTripConsent;
  delete businessFields.physicalActivityConsent;
  delete businessFields.activityRestrictions;
  delete businessFields.swimConsent;
  return businessFields;
}

export function normalizeHealthRecordBusinessFields<DocumentId>(
  fields: HealthRecordValidationData<DocumentId> &
    LegacyHealthRecordParticipation,
  compatibility: HealthRecordNormalizationCompatibility = fields,
): HealthRecordValidationData<DocumentId> & {
  actionPlanDocumentIds: {
    allergy: DocumentId | null;
    asthma: DocumentId | null;
  };
} {
  const legacyRestrictions = text(compatibility.activityRestrictions);
  const fieldTripRestriction =
    compatibility.fieldTripRestriction ??
    compatibility.fieldTripConsent === "no";
  const peRecessRestriction =
    compatibility.peRecessRestriction ??
    compatibility.physicalActivityConsent === "no";
  const swimmingRestriction =
    compatibility.swimmingRestriction ??
    compatibility.swimConsent === "no";
  const streetAddress = text(fields.streetAddress);
  const city = text(fields.city);
  const stateValue = text(fields.state);
  const zipCode = text(fields.zipCode);
  const hasStructuredAddress = Boolean(
    streetAddress || city || stateValue || zipCode,
  );
  const composedAddress = [
    streetAddress,
    city,
    [stateValue, zipCode].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");
  // The developmental/mental-health detail is only meaningful when the guardian
  // answered "yes"; clear it server-side so a "no" answer can never carry stale
  // conditions/plans/notes into staff or aide reads, regardless of the client.
  const hasDevelopmental = fields.developmentalConditionsPresent === "yes";
  const developmentalConditions = hasDevelopmental
    ? fields.developmentalConditions
    : [];
  const supportPlans = hasDevelopmental ? fields.supportPlans : [];
  const supportPlanNeedsDocument = supportPlans.some(
    (plan) => plan !== "none",
  );
  // Same guarantee for healthcare action plans: no selected plan ⇒ no document
  // delivery/upload can persist, so a later "None" (or deselecting the last plan)
  // can't leave an orphaned upload referenced by the record.
  // The legacy generic delivery/upload only backs the non condition-keyed plans.
  const genericActionPlan =
    !fields.hap.none &&
    (fields.hap.seizure ||
      fields.hap.diabetes ||
      fields.hap.behavioralHealth ||
      fields.hap.other);
  const incomingActionPlanIds = fields.actionPlanDocumentIds ?? {
    allergy: null,
    asthma: null,
  };
  return {
    ...withoutLegacyParticipation(fields),
    childName: text(fields.childName),
    childPreferredName: text(fields.childPreferredName),
    childDob: text(fields.childDob),
    childGrade: text(fields.childGrade),
    streetAddress,
    city,
    state: stateValue,
    zipCode,
    // Keep the flattened address in sync with the structured parts so staff and
    // aide readers that reference homeAddress continue to work; only fall back to
    // a pre-existing flat value when no structured parts were provided (legacy).
    homeAddress: hasStructuredAddress ? composedAddress : text(fields.homeAddress),
    homePrimaryLanguage: text(fields.homePrimaryLanguage),
    physicianName: text(fields.physicianName),
    physicianPhone: text(fields.physicianPhone),
    dentistName: text(fields.dentistName),
    dentistPhone: text(fields.dentistPhone),
    insurancePlan: text(fields.insurancePlan),
    insuranceId: text(fields.insuranceId),
    guardian1Name: text(fields.guardian1Name),
    guardian1Relationship: fields.guardian1Relationship,
    guardian1RelationshipOther:
      fields.guardian1Relationship === "other"
        ? text(fields.guardian1RelationshipOther)
        : "",
    guardian1Phone: text(fields.guardian1Phone),
    guardian1WorkPhone: text(fields.guardian1WorkPhone),
    guardian1Email: text(fields.guardian1Email),
    guardian1Employer: text(fields.guardian1Employer),
    guardian2: fields.guardian2
      ? {
          name: text(fields.guardian2.name),
          relationship: fields.guardian2.relationship,
          relationshipOther:
            fields.guardian2.relationship === "other"
              ? optionalText(fields.guardian2.relationshipOther)
              : undefined,
          phone: text(fields.guardian2.phone),
          workPhone: optionalText(fields.guardian2.workPhone),
          email: text(fields.guardian2.email),
          employer: optionalText(fields.guardian2.employer),
        }
      : null,
    custodyNotes: text(fields.custodyNotes),
    emergencyContacts: fields.emergencyContacts.map((contact) => ({
      ...contact,
      name: text(contact.name),
      relationship: text(contact.relationship),
      phone: text(contact.phone),
      altPhone: text(contact.altPhone),
    })),
    allergies: fields.allergies.map((allergy) => ({
      ...allergy,
      allergen: text(allergy.allergen),
      reaction: text(allergy.reaction),
      emergencyTreatment: text(allergy.emergencyTreatment),
    })),
    allergyNotes: text(fields.allergyNotes),
    chronicConditionDetails: text(fields.chronicConditionDetails),
    medications: fields.medications.map((medication) => ({
      ...medication,
      name: text(medication.name),
      purpose: text(medication.purpose),
      dosage: text(medication.dosage),
      frequency: text(medication.frequency),
      administrationInstructions: text(
        medication.administrationInstructions,
      ),
      storedAtSchool:
        fields.schoolMedicationMode === "stored_at_school" ||
        fields.schoolMedicationMode === "both",
      prescriptionOnFile: false,
    })),
    immunizationNotes: text(fields.immunizationNotes),
    developmentalConditions,
    developmentalConditionsOther:
      hasDevelopmental && developmentalConditions.includes("other")
        ? text(fields.developmentalConditionsOther)
        : "",
    developmentalSupportNotes: hasDevelopmental
      ? text(fields.developmentalSupportNotes)
      : "",
    developmentalSuccessfulSupports: hasDevelopmental
      ? text(fields.developmentalSuccessfulSupports)
      : "",
    supportPlans,
    supportPlanOther: supportPlans.includes("other")
      ? text(fields.supportPlanOther)
      : "",
    supportPlanDocumentDelivery: supportPlanNeedsDocument
      ? fields.supportPlanDocumentDelivery
      : "",
    supportPlanDocumentId: supportPlanNeedsDocument
      ? fields.supportPlanDocumentId
      : null,
    hap: {
      ...fields.hap,
      behavioralHealth: fields.hap.behavioralHealth ?? false,
      otherDesc: text(fields.hap.otherDesc),
      notes: text(fields.hap.notes),
    },
    hapDocumentDelivery: genericActionPlan ? fields.hapDocumentDelivery : "",
    actionPlanDocumentId: genericActionPlan ? fields.actionPlanDocumentId : null,
    // Each condition-keyed plan survives only while its own hap flag is on (and
    // "None" is off), mirroring the generic slot's clearing rule so a family
    // that later unchecks "asthma" can't strand an orphaned asthma EAP.
    actionPlanDocumentIds: {
      allergy:
        !fields.hap.none && fields.hap.allergy
          ? (incomingActionPlanIds.allergy ?? null)
          : null,
      asthma:
        !fields.hap.none && fields.hap.asthma
          ? (incomingActionPlanIds.asthma ?? null)
          : null,
    },
    emergencyMedAuthNotes: text(fields.emergencyMedAuthNotes),
    publicMediaOptOut:
      compatibility.publicMediaOptOut ??
      compatibility.photoConsent === "no",
    privateSchoolMediaOptOut:
      compatibility.privateSchoolMediaOptOut ?? false,
    fieldTripRestriction,
    fieldTripRestrictionDetails: fieldTripRestriction
      ? text(
          compatibility.fieldTripRestrictionDetails ?? legacyRestrictions,
        )
      : "",
    peRecessRestriction,
    peRecessRestrictionDetails: peRecessRestriction
      ? text(
          compatibility.peRecessRestrictionDetails ?? legacyRestrictions,
        )
      : "",
    swimmingRestriction,
    swimmingRestrictionDetails: swimmingRestriction
      ? text(
          compatibility.swimmingRestrictionDetails ?? legacyRestrictions,
        )
      : "",
    cookingWaiverParentFullName: text(fields.cookingWaiverParentFullName),
    cookingWaiverStudentFullName: text(fields.cookingWaiverStudentFullName),
    cookingWaiverDetails: text(fields.cookingWaiverDetails),
    cookingWaiverDate: text(fields.cookingWaiverDate),
    signerName: text(fields.signerName),
  };
}

export function normalizeHealthRecordSignerName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

type ValidationOptions = {
  submit: boolean;
  accountSignerName?: string;
};

export function healthRecordValidationIssues<DocumentId>(
  input: HealthRecordValidationData<DocumentId> &
    LegacyHealthRecordParticipation,
  options: ValidationOptions,
): HealthRecordValidationIssue[] {
  const data = normalizeHealthRecordBusinessFields(input);
  const issues: HealthRecordValidationIssue[] = [];
  const add = (
    code: HealthRecordIssueCode,
    step: number,
    field: string,
    message: string,
    invalid: boolean,
  ) => {
    if (invalid) issues.push({ code, step, field, message });
  };
  const required = (
    step: number,
    field: string,
    value: string | undefined,
    message: string,
  ) => add("required", step, field, message, options.submit && !text(value));
  const limit = (
    step: number,
    field: string,
    value: string | undefined,
    label: string,
    maximum: number,
  ) =>
    add(
      "too_long",
      step,
      field,
      `${label} must be ${maximum} characters or fewer.`,
      text(value).length > maximum,
    );

  required(0, "childName", data.childName, "Enter the child's full name.");
  limit(0, "childName", data.childName, "Child name", SHORT_TEXT_LIMIT);
  required(0, "childDob", data.childDob, "Enter the child's date of birth.");
  add(
    "invalid_date",
    0,
    "childDob",
    "Enter a valid date of birth.",
    Boolean(data.childDob) &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(data.childDob) ||
        Number.isNaN(Date.parse(`${data.childDob}T00:00:00Z`))),
  );
  limit(
    0,
    "childPreferredName",
    data.childPreferredName,
    "Preferred name",
    SHORT_TEXT_LIMIT,
  );
  limit(0, "childGrade", data.childGrade, "Grade or class", SHORT_TEXT_LIMIT);
  required(0, "streetAddress", data.streetAddress, "Enter the street address.");
  limit(0, "streetAddress", data.streetAddress, "Street address", SHORT_TEXT_LIMIT);
  required(0, "city", data.city, "Enter the city.");
  limit(0, "city", data.city, "City", SHORT_TEXT_LIMIT);
  required(0, "state", data.state, "Enter the state.");
  limit(0, "state", data.state, "State", SHORT_TEXT_LIMIT);
  required(0, "zipCode", data.zipCode, "Enter the ZIP code.");
  limit(0, "zipCode", data.zipCode, "ZIP code", SHORT_TEXT_LIMIT);
  limit(0, "homeAddress", data.homeAddress, "Home address", ADDRESS_LIMIT);
  limit(
    0,
    "homePrimaryLanguage",
    data.homePrimaryLanguage,
    "Primary language",
    SHORT_TEXT_LIMIT,
  );
  required(
    0,
    "physicianName",
    data.physicianName,
    "Enter the primary care physician.",
  );
  limit(
    0,
    "physicianName",
    data.physicianName,
    "Physician name",
    SHORT_TEXT_LIMIT,
  );
  required(
    0,
    "physicianPhone",
    data.physicianPhone,
    "Enter the physician's phone number.",
  );
  limit(
    0,
    "physicianPhone",
    data.physicianPhone,
    "Physician phone",
    PHONE_LIMIT,
  );
  limit(0, "dentistName", data.dentistName, "Dentist name", SHORT_TEXT_LIMIT);
  limit(0, "dentistPhone", data.dentistPhone, "Dentist phone", PHONE_LIMIT);
  required(
    0,
    "insurancePlan",
    data.insurancePlan,
    "Enter the health insurance plan.",
  );
  limit(
    0,
    "insurancePlan",
    data.insurancePlan,
    "Insurance plan",
    SHORT_TEXT_LIMIT,
  );
  required(
    0,
    "insuranceId",
    data.insuranceId,
    "Enter the insurance ID or group number.",
  );
  limit(
    0,
    "insuranceId",
    data.insuranceId,
    "Insurance ID",
    SHORT_TEXT_LIMIT,
  );

  required(1, "guardian1Name", data.guardian1Name, "Enter your full name.");
  limit(1, "guardian1Name", data.guardian1Name, "Your name", SHORT_TEXT_LIMIT);
  add(
    "required",
    1,
    "guardian1Relationship",
    "Select your relationship to the child.",
    options.submit && !data.guardian1Relationship,
  );
  add(
    "required",
    1,
    "guardian1RelationshipOther",
    "Describe your relationship to the child.",
    options.submit &&
      data.guardian1Relationship === "other" &&
      !text(data.guardian1RelationshipOther),
  );
  limit(
    1,
    "guardian1RelationshipOther",
    data.guardian1RelationshipOther,
    "Relationship",
    SHORT_TEXT_LIMIT,
  );
  required(1, "guardian1Phone", data.guardian1Phone, "Enter your phone number.");
  limit(1, "guardian1Phone", data.guardian1Phone, "Your phone number", PHONE_LIMIT);
  limit(
    1,
    "guardian1WorkPhone",
    data.guardian1WorkPhone,
    "Your work phone",
    PHONE_LIMIT,
  );
  required(
    1,
    "guardian1Email",
    data.guardian1Email,
    "An email address is required.",
  );
  add(
    "invalid_email",
    1,
    "guardian1Email",
    "Enter a valid email address.",
    Boolean(data.guardian1Email) && !EMAIL_PATTERN.test(data.guardian1Email),
  );
  limit(
    1,
    "guardian1Email",
    data.guardian1Email,
    "Your email address",
    EMAIL_LIMIT,
  );
  limit(
    1,
    "guardian1Employer",
    data.guardian1Employer,
    "Your employer",
    SHORT_TEXT_LIMIT,
  );
  if (data.guardian2) {
    required(
      1,
      "guardian2.name",
      data.guardian2.name,
      "Enter the additional parent or legal guardian's name.",
    );
    limit(
      1,
      "guardian2.name",
      data.guardian2.name,
      "Additional parent or legal guardian name",
      SHORT_TEXT_LIMIT,
    );
    add(
      "required",
      1,
      "guardian2.relationship",
      "Select the additional parent or legal guardian's relationship.",
      options.submit && !data.guardian2.relationship,
    );
    add(
      "required",
      1,
      "guardian2.relationshipOther",
      "Describe the additional parent or legal guardian's relationship.",
      options.submit &&
        data.guardian2.relationship === "other" &&
        !text(data.guardian2.relationshipOther),
    );
    limit(
      1,
      "guardian2.relationshipOther",
      data.guardian2.relationshipOther,
      "Additional parent or legal guardian relationship",
      SHORT_TEXT_LIMIT,
    );
    required(
      1,
      "guardian2.phone",
      data.guardian2.phone,
      "Enter the additional parent or legal guardian's phone.",
    );
    limit(
      1,
      "guardian2.phone",
      data.guardian2.phone,
      "Additional parent or legal guardian phone",
      PHONE_LIMIT,
    );
    limit(
      1,
      "guardian2.workPhone",
      data.guardian2.workPhone,
      "Additional parent or legal guardian work phone",
      PHONE_LIMIT,
    );
    required(
      1,
      "guardian2.email",
      data.guardian2.email,
      "Enter the additional parent or legal guardian's email.",
    );
    add(
      "invalid_email",
      1,
      "guardian2.email",
      "Enter a valid email address for the additional parent or legal guardian.",
      Boolean(data.guardian2.email) &&
        !EMAIL_PATTERN.test(data.guardian2.email),
    );
    limit(
      1,
      "guardian2.email",
      data.guardian2.email,
      "Additional parent or legal guardian email",
      EMAIL_LIMIT,
    );
    limit(
      1,
      "guardian2.employer",
      data.guardian2.employer,
      "Additional parent or legal guardian employer",
      SHORT_TEXT_LIMIT,
    );
  }
  limit(1, "custodyNotes", data.custodyNotes, "Custody notes", LONG_TEXT_LIMIT);
  add(
    "document_required",
    1,
    "custodyDocumentId",
    "Upload the custody document.",
    data.custodyDocumentDelivery === "upload" && !data.custodyDocumentId,
  );
  add(
    "invalid_combination",
    1,
    "custodyDocumentId",
    "Remove the custody upload when providing the document separately.",
    data.custodyDocumentDelivery === "provide_separately" &&
      Boolean(data.custodyDocumentId),
  );

  add(
    "required",
    2,
    "emergencyContacts",
    "Add at least one emergency contact.",
    options.submit && data.emergencyContacts.length === 0,
  );
  add(
    "too_many",
    2,
    "emergencyContacts",
    `Emergency contacts are limited to ${HEALTH_RECORD_MAX_EMERGENCY_CONTACTS}.`,
    data.emergencyContacts.length > HEALTH_RECORD_MAX_EMERGENCY_CONTACTS,
  );
  data.emergencyContacts.forEach((contact, index) => {
    const field = `emergencyContacts.${index}`;
    required(2, `${field}.name`, contact.name, `Enter contact ${index + 1}'s name.`);
    limit(
      2,
      `${field}.name`,
      contact.name,
      `Contact ${index + 1} name`,
      SHORT_TEXT_LIMIT,
    );
    required(
      2,
      `${field}.relationship`,
      contact.relationship,
      `Enter contact ${index + 1}'s relationship.`,
    );
    limit(
      2,
      `${field}.relationship`,
      contact.relationship,
      `Contact ${index + 1} relationship`,
      SHORT_TEXT_LIMIT,
    );
    required(
      2,
      `${field}.phone`,
      contact.phone,
      `Enter contact ${index + 1}'s phone.`,
    );
    limit(
      2,
      `${field}.phone`,
      contact.phone,
      `Contact ${index + 1} phone`,
      PHONE_LIMIT,
    );
    limit(
      2,
      `${field}.altPhone`,
      contact.altPhone,
      `Contact ${index + 1} alternate phone`,
      PHONE_LIMIT,
    );
  });

  add(
    "too_many",
    3,
    "allergies",
    `Allergies are limited to ${HEALTH_RECORD_MAX_ALLERGIES}.`,
    data.allergies.length > HEALTH_RECORD_MAX_ALLERGIES,
  );
  limit(3, "allergyNotes", data.allergyNotes, "Allergy notes", LONG_TEXT_LIMIT);
  add(
    "invalid_combination",
    3,
    "allergies",
    "Remove allergy entries or turn off “No known allergies.”",
    data.noKnownAllergies && data.allergies.length > 0,
  );
  add(
    "required",
    3,
    "allergies",
    "Add an allergy or select “No known allergies.”",
    options.submit && !data.noKnownAllergies && data.allergies.length === 0,
  );
  data.allergies.forEach((allergy, index) => {
    const field = `allergies.${index}`;
    required(
      3,
      `${field}.allergen`,
      allergy.allergen,
      `Enter allergy ${index + 1}'s allergen.`,
    );
    limit(
      3,
      `${field}.allergen`,
      allergy.allergen,
      `Allergy ${index + 1} allergen`,
      SHORT_TEXT_LIMIT,
    );
    add(
      "required",
      3,
      `${field}.type`,
      `Select allergy ${index + 1}'s type.`,
      options.submit && !allergy.type,
    );
    required(
      3,
      `${field}.reaction`,
      allergy.reaction,
      `Enter allergy ${index + 1}'s reaction.`,
    );
    limit(
      3,
      `${field}.reaction`,
      allergy.reaction,
      `Allergy ${index + 1} reaction`,
      LONG_TEXT_LIMIT,
    );
    add(
      "required",
      3,
      `${field}.severity`,
      `Select allergy ${index + 1}'s severity.`,
      options.submit && !allergy.severity,
    );
    required(
      3,
      `${field}.emergencyTreatment`,
      allergy.emergencyTreatment,
      `Enter allergy ${index + 1}'s emergency treatment.`,
    );
    limit(
      3,
      `${field}.emergencyTreatment`,
      allergy.emergencyTreatment,
      `Allergy ${index + 1} emergency treatment`,
      LONG_TEXT_LIMIT,
    );
  });

  add(
    "duplicate",
    4,
    "chronicConditions",
    "Remove duplicate chronic conditions.",
    new Set(data.chronicConditions).size !== data.chronicConditions.length,
  );
  limit(
    4,
    "chronicConditionDetails",
    data.chronicConditionDetails,
    "Chronic condition details",
    LONG_TEXT_LIMIT,
  );
  add(
    "invalid_combination",
    4,
    "chronicConditions",
    "Clear conditions or turn off “None of the above.”",
    data.noChronicConditions && data.chronicConditions.length > 0,
  );
  add(
    "required",
    4,
    "chronicConditions",
    "Select a chronic condition or “None of the above.”",
    options.submit &&
      !data.noChronicConditions &&
      data.chronicConditions.length === 0,
  );
  required(
    4,
    "chronicConditionDetails",
    data.chronicConditionDetails,
    "Describe the other chronic condition.",
  );
  if (!data.chronicConditions.includes("other")) {
    const index = issues.findIndex(
      (issue) =>
        issue.step === 4 &&
        issue.field === "chronicConditionDetails" &&
        issue.code === "required",
    );
    if (index >= 0) issues.splice(index, 1);
  }

  add(
    "required",
    5,
    "schoolMedicationMode",
    "Select how medication will be handled at school.",
    options.submit && !data.schoolMedicationMode,
  );
  add(
    "required",
    5,
    "medicationDocumentDelivery",
    "Select how medication authorization will be provided.",
    options.submit &&
      data.schoolMedicationMode !== "" &&
      data.schoolMedicationMode !== "none" &&
      !data.medicationDocumentDelivery,
  );
  add(
    "document_required",
    5,
    "medicationDocumentId",
    "Upload the completed medication authorization.",
    data.medicationDocumentDelivery === "upload" &&
      !data.medicationDocumentId,
  );
  add(
    "invalid_combination",
    5,
    "medicationDocumentDelivery",
    "Medication documentation is not required when no school medication is needed.",
    data.schoolMedicationMode === "none" &&
      data.medicationDocumentDelivery !== "not_required",
  );
  add(
    "invalid_combination",
    5,
    "medicationDocumentId",
    "Remove the medication upload when no school medication is needed.",
    data.schoolMedicationMode === "none" &&
      Boolean(data.medicationDocumentId),
  );
  add(
    "invalid_combination",
    5,
    "medicationDocumentId",
    "Remove the medication upload when providing documentation separately.",
    data.medicationDocumentDelivery === "provide_separately" &&
      Boolean(data.medicationDocumentId),
  );
  add(
    "too_many",
    5,
    "medications",
    `Medications are limited to ${HEALTH_RECORD_MAX_MEDICATIONS}.`,
    data.medications.length > HEALTH_RECORD_MAX_MEDICATIONS,
  );
  add(
    "invalid_combination",
    5,
    "medications",
    "Remove medications or turn off “No current medications.”",
    data.noCurrentMedications && data.medications.length > 0,
  );
  add(
    "required",
    5,
    "medications",
    "Add a medication or select “No current medications.”",
    options.submit &&
      !data.noCurrentMedications &&
      data.medications.length === 0,
  );
  data.medications.forEach((medication, index) => {
    const field = `medications.${index}`;
    required(
      5,
      `${field}.name`,
      medication.name,
      `Enter medication ${index + 1}'s name.`,
    );
    limit(
      5,
      `${field}.name`,
      medication.name,
      `Medication ${index + 1} name`,
      SHORT_TEXT_LIMIT,
    );
    required(
      5,
      `${field}.purpose`,
      medication.purpose,
      `Enter medication ${index + 1}'s purpose.`,
    );
    limit(
      5,
      `${field}.purpose`,
      medication.purpose,
      `Medication ${index + 1} purpose`,
      SHORT_TEXT_LIMIT,
    );
    required(
      5,
      `${field}.dosage`,
      medication.dosage,
      `Enter medication ${index + 1}'s dosage.`,
    );
    limit(
      5,
      `${field}.dosage`,
      medication.dosage,
      `Medication ${index + 1} dosage`,
      SHORT_TEXT_LIMIT,
    );
    required(
      5,
      `${field}.frequency`,
      medication.frequency,
      `Enter medication ${index + 1}'s frequency.`,
    );
    limit(
      5,
      `${field}.frequency`,
      medication.frequency,
      `Medication ${index + 1} frequency`,
      SHORT_TEXT_LIMIT,
    );
    required(
      5,
      `${field}.administrationInstructions`,
      medication.administrationInstructions,
      `Enter medication ${index + 1}'s administration instructions.`,
    );
    limit(
      5,
      `${field}.administrationInstructions`,
      medication.administrationInstructions,
      `Medication ${index + 1} administration instructions`,
      LONG_TEXT_LIMIT,
    );
  });

  add(
    "required",
    6,
    "immunizationStatus",
    "Select the immunization record status.",
    options.submit && !data.immunizationStatus,
  );
  add(
    "invalid_combination",
    6,
    "immunizationStatus",
    "Select an immunization status before providing documentation.",
    !data.immunizationStatus &&
      (Boolean(data.immunizationDocumentDelivery) ||
        Boolean(data.immunizationDocumentId)),
  );
  add(
    "required",
    6,
    "immunizationDocumentDelivery",
    "Select how supporting documentation will be provided.",
    options.submit &&
      Boolean(data.immunizationStatus) &&
      !data.immunizationDocumentDelivery,
  );
  add(
    "document_required",
    6,
    "immunizationDocumentId",
    "Upload the immunization supporting document.",
    data.immunizationDocumentDelivery === "upload" &&
      !data.immunizationDocumentId,
  );
  add(
    "invalid_combination",
    6,
    "immunizationDocumentId",
    "Remove the immunization upload when providing documentation separately.",
    data.immunizationDocumentDelivery === "provide_separately" &&
      Boolean(data.immunizationDocumentId),
  );
  limit(
    6,
    "immunizationNotes",
    data.immunizationNotes,
    "Immunization notes",
    LONG_TEXT_LIMIT,
  );

  // Step 7 — developmental, behavioral & mental health.
  const hasDevelopmental = data.developmentalConditionsPresent === "yes";
  add(
    "required",
    7,
    "developmentalConditionsPresent",
    "Let us know whether your child has a developmental, behavioral, learning, or mental health condition.",
    options.submit && !data.developmentalConditionsPresent,
  );
  add(
    "duplicate",
    7,
    "developmentalConditions",
    "Remove duplicate conditions.",
    new Set(data.developmentalConditions).size !==
      data.developmentalConditions.length,
  );
  add(
    "required",
    7,
    "developmentalConditions",
    "Select at least one condition.",
    options.submit &&
      hasDevelopmental &&
      data.developmentalConditions.length === 0,
  );
  required(
    7,
    "developmentalConditionsOther",
    data.developmentalConditionsOther,
    "Describe the other condition.",
  );
  if (
    !(hasDevelopmental && data.developmentalConditions.includes("other"))
  ) {
    const index = issues.findIndex(
      (issue) =>
        issue.step === 7 &&
        issue.field === "developmentalConditionsOther" &&
        issue.code === "required",
    );
    if (index >= 0) issues.splice(index, 1);
  }
  limit(
    7,
    "developmentalConditionsOther",
    data.developmentalConditionsOther,
    "Other condition",
    SHORT_TEXT_LIMIT,
  );
  limit(
    7,
    "developmentalSupportNotes",
    data.developmentalSupportNotes,
    "Support notes",
    LONG_TEXT_LIMIT,
  );
  limit(
    7,
    "developmentalSuccessfulSupports",
    data.developmentalSuccessfulSupports,
    "Successful supports",
    LONG_TEXT_LIMIT,
  );
  add(
    "duplicate",
    7,
    "supportPlans",
    "Remove duplicate support plans.",
    new Set(data.supportPlans).size !== data.supportPlans.length,
  );
  add(
    "invalid_combination",
    7,
    "supportPlans",
    "Clear other plans or turn off “None.”",
    data.supportPlans.includes("none") &&
      data.supportPlans.some((plan) => plan !== "none"),
  );
  add(
    "required",
    7,
    "supportPlans",
    "Select a support plan or “None.”",
    options.submit && hasDevelopmental && data.supportPlans.length === 0,
  );
  required(
    7,
    "supportPlanOther",
    data.supportPlanOther,
    "Describe the other support plan.",
  );
  if (!data.supportPlans.includes("other")) {
    const index = issues.findIndex(
      (issue) =>
        issue.step === 7 &&
        issue.field === "supportPlanOther" &&
        issue.code === "required",
    );
    if (index >= 0) issues.splice(index, 1);
  }
  limit(
    7,
    "supportPlanOther",
    data.supportPlanOther,
    "Other support plan",
    SHORT_TEXT_LIMIT,
  );
  const supportPlanNeedsDocument = data.supportPlans.some(
    (plan) => plan !== "none",
  );
  add(
    "required",
    7,
    "supportPlanDocumentDelivery",
    "Select how you will provide the support plan.",
    options.submit &&
      hasDevelopmental &&
      supportPlanNeedsDocument &&
      !data.supportPlanDocumentDelivery,
  );
  add(
    "document_required",
    7,
    "supportPlanDocumentId",
    "Upload the support plan.",
    data.supportPlanDocumentDelivery === "upload" &&
      !data.supportPlanDocumentId,
  );
  add(
    "invalid_combination",
    7,
    "supportPlanDocumentId",
    "Remove the support plan upload when providing it separately.",
    data.supportPlanDocumentDelivery === "provide_separately" &&
      Boolean(data.supportPlanDocumentId),
  );

  const actionPlanSelected = [
    data.hap.allergy,
    data.hap.asthma,
    data.hap.seizure,
    data.hap.diabetes,
    data.hap.behavioralHealth,
    data.hap.other,
  ].some(Boolean);
  // The legacy generic action-plan upload only covers seizure / diabetes /
  // behavioral-health / other. Allergy and asthma are captured through their
  // own condition-keyed slots, so they must not trigger the generic delivery /
  // upload requirements below.
  const genericActionPlanSelected = [
    data.hap.seizure,
    data.hap.diabetes,
    data.hap.behavioralHealth,
    data.hap.other,
  ].some(Boolean);
  add(
    "invalid_combination",
    8,
    "hap",
    "Clear action plans or turn off “None.”",
    data.hap.none && actionPlanSelected,
  );
  add(
    "required",
    8,
    "hap",
    "Select an action plan or “None.”",
    options.submit && !data.hap.none && !actionPlanSelected,
  );
  required(
    8,
    "hap.otherDesc",
    data.hap.otherDesc,
    "Describe the other action plan.",
  );
  if (!data.hap.other) {
    const index = issues.findIndex(
      (issue) =>
        issue.step === 8 &&
        issue.field === "hap.otherDesc" &&
        issue.code === "required",
    );
    if (index >= 0) issues.splice(index, 1);
  }
  limit(
    8,
    "hap.otherDesc",
    data.hap.otherDesc,
    "Other healthcare action plan",
    SHORT_TEXT_LIMIT,
  );
  limit(
    8,
    "hap.notes",
    data.hap.notes,
    "Healthcare action plan notes",
    LONG_TEXT_LIMIT,
  );
  add(
    "required",
    8,
    "hapDocumentDelivery",
    "Select how you will provide the healthcare action plan.",
    options.submit &&
      !data.hap.none &&
      genericActionPlanSelected &&
      !data.hapDocumentDelivery,
  );
  add(
    "document_required",
    8,
    "actionPlanDocumentId",
    "Upload the healthcare action plan.",
    data.hapDocumentDelivery === "upload" && !data.actionPlanDocumentId,
  );
  add(
    "invalid_combination",
    8,
    "actionPlanDocumentId",
    "Remove the healthcare action plan upload when providing it separately.",
    data.hapDocumentDelivery === "provide_separately" &&
      Boolean(data.actionPlanDocumentId),
  );

  add(
    "required",
    9,
    "emergencyMedAuthAck",
    "Authorize emergency medical care to continue.",
    options.submit && !data.emergencyMedAuthAck,
  );
  limit(
    9,
    "emergencyMedAuthNotes",
    data.emergencyMedAuthNotes,
    "Emergency authorization notes",
    LONG_TEXT_LIMIT,
  );

  required(10, "signerName", data.signerName, "Enter your full legal name.");
  limit(10, "signerName", data.signerName, "Signer name", SHORT_TEXT_LIMIT);
  add(
    "signature_mismatch",
    10,
    "signerName",
    "Type your name exactly as it appears on your account.",
    options.submit &&
      Boolean(options.accountSignerName?.trim()) &&
      Boolean(data.signerName) &&
      normalizeHealthRecordSignerName(data.signerName) !==
        normalizeHealthRecordSignerName(options.accountSignerName ?? ""),
  );
  add(
    "required",
    10,
    "signerName",
    "Your account must have a name before signing.",
    options.submit && !options.accountSignerName?.trim(),
  );
  add(
    "required",
    10,
    "signerAgreement",
    "Agree to the electronic signature certification.",
    options.submit && !data.signerAgreement,
  );

  return issues;
}

export function healthRecordStepIssues<DocumentId>(
  input: HealthRecordValidationData<DocumentId> &
    LegacyHealthRecordParticipation,
  step: number,
  accountSignerName = "",
): HealthRecordValidationIssue[] {
  return healthRecordValidationIssues(input, {
    submit: true,
    accountSignerName,
  }).filter((issue) => issue.step === step);
}
