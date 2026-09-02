import { v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import {
  HEALTH_RECORD_MAX_ALLERGIES,
  HEALTH_RECORD_MAX_EMERGENCY_CONTACTS,
  HEALTH_RECORD_MAX_MEDICATIONS,
  healthRecordValidationIssues,
  normalizeHealthRecordBusinessFields,
  type HealthRecordValidationIssue,
  type LegacyHealthRecordParticipation,
} from "../../shared/healthRecordValidation";

export const MAX_EMERGENCY_CONTACTS =
  HEALTH_RECORD_MAX_EMERGENCY_CONTACTS;
export const MAX_ALLERGIES = HEALTH_RECORD_MAX_ALLERGIES;
export const MAX_MEDICATIONS = HEALTH_RECORD_MAX_MEDICATIONS;
export const HEALTH_FORM_LAST_STEP = 11;

const guardianRelationshipValidator = v.union(
  v.literal(""),
  v.literal("parent"),
  v.literal("legal_guardian"),
  v.literal("other"),
  v.literal("mother"),
  v.literal("father"),
  v.literal("guardian"),
);

const allergyTypeValidator = v.union(
  v.literal(""),
  v.literal("food"),
  v.literal("insect"),
  v.literal("medication"),
  v.literal("environmental"),
  v.literal("latex"),
  v.literal("other"),
);

const allergySeverityValidator = v.union(
  v.literal(""),
  v.literal("mild"),
  v.literal("moderate"),
  v.literal("severe"),
);

const chronicConditionValidator = v.union(
  v.literal("asthma"),
  v.literal("diabetes"),
  v.literal("epilepsy"),
  v.literal("heart_condition"),
  v.literal("adhd"),
  v.literal("anxiety"),
  v.literal("depression"),
  v.literal("hearing_impairment"),
  v.literal("visual_impairment"),
  v.literal("physical_disability"),
  v.literal("other"),
);

const immunizationStatusValidator = v.union(
  v.literal(""),
  v.literal("up_to_date"),
  v.literal("medical_exemption"),
  v.literal("religious_exemption"),
);

const schoolMedicationModeValidator = v.union(
  v.literal(""),
  v.literal("none"),
  v.literal("stored_at_school"),
  v.literal("self_carry_emergency"),
  v.literal("both"),
);

const medicationDocumentDeliveryValidator = v.union(
  v.literal(""),
  v.literal("not_required"),
  v.literal("upload"),
  v.literal("provide_separately"),
);

const immunizationDocumentDeliveryValidator = v.union(
  v.literal(""),
  v.literal("upload"),
  v.literal("provide_separately"),
);

// Upload vs. provide-separately, shared by the custody, healthcare action-plan,
// and support-plan document fields.
export const uploadDeliveryValidator = v.union(
  v.literal(""),
  v.literal("upload"),
  v.literal("provide_separately"),
);

export const developmentalStatusValidator = v.union(
  v.literal(""),
  v.literal("yes"),
  v.literal("no"),
);

export const developmentalConditionValidator = v.union(
  v.literal("adhd"),
  v.literal("autism"),
  v.literal("anxiety"),
  v.literal("depression"),
  v.literal("dyslexia"),
  v.literal("dysgraphia"),
  v.literal("dyscalculia"),
  v.literal("speech_language"),
  v.literal("developmental_delay"),
  v.literal("sensory_processing"),
  v.literal("behavioral_concern"),
  v.literal("other"),
);

export const supportPlanValidator = v.union(
  v.literal("none"),
  v.literal("iep"),
  v.literal("section_504"),
  v.literal("bip"),
  v.literal("other"),
);

const legacyConsentChoiceValidator = v.union(
  v.literal(""),
  v.literal("yes"),
  v.literal("no"),
);

const guardian2Validator = v.union(
  v.null(),
  v.object({
    name: v.string(),
    relationship: guardianRelationshipValidator,
    relationshipOther: v.optional(v.string()),
    phone: v.string(),
    workPhone: v.optional(v.string()),
    email: v.string(),
    employer: v.optional(v.string()),
  }),
);

export const healthRecordFields = {
  childName: v.string(),
  childPreferredName: v.string(),
  childDob: v.string(),
  childGrade: v.string(),
  homeAddress: v.string(),
  streetAddress: v.string(),
  city: v.string(),
  state: v.string(),
  zipCode: v.string(),
  homePrimaryLanguage: v.string(),
  physicianName: v.string(),
  physicianPhone: v.string(),
  dentistName: v.string(),
  dentistPhone: v.string(),
  insurancePlan: v.string(),
  insuranceId: v.string(),

  guardian1Name: v.string(),
  guardian1Relationship: guardianRelationshipValidator,
  guardian1RelationshipOther: v.string(),
  guardian1Phone: v.string(),
  guardian1WorkPhone: v.string(),
  guardian1Email: v.string(),
  guardian1Employer: v.string(),
  guardian2: guardian2Validator,
  custodyNotes: v.string(),
  custodyDocumentDelivery: uploadDeliveryValidator,
  custodyDocumentId: v.union(v.null(), v.id("healthRecordFiles")),

  emergencyContacts: v.array(
    v.object({
      name: v.string(),
      relationship: v.string(),
      phone: v.string(),
      altPhone: v.string(),
      canPickUp: v.boolean(),
    }),
  ),

  noKnownAllergies: v.boolean(),
  allergies: v.array(
    v.object({
      allergen: v.string(),
      type: allergyTypeValidator,
      reaction: v.string(),
      severity: allergySeverityValidator,
      emergencyTreatment: v.string(),
      epipenOnFile: v.boolean(),
    }),
  ),
  allergyNotes: v.string(),

  chronicConditions: v.array(chronicConditionValidator),
  chronicConditionDetails: v.string(),
  noChronicConditions: v.boolean(),

  noCurrentMedications: v.boolean(),
  medications: v.array(
    v.object({
      name: v.string(),
      purpose: v.string(),
      dosage: v.string(),
      frequency: v.string(),
      administrationInstructions: v.string(),
      storedAtSchool: v.boolean(),
      prescriptionOnFile: v.boolean(),
    }),
  ),
  schoolMedicationMode: schoolMedicationModeValidator,
  medicationDocumentDelivery: medicationDocumentDeliveryValidator,
  medicationDocumentId: v.union(v.null(), v.id("healthRecordFiles")),

  immunizationStatus: immunizationStatusValidator,
  immunizationNotes: v.string(),
  immunizationDocumentDelivery: immunizationDocumentDeliveryValidator,
  immunizationDocumentId: v.union(v.null(), v.id("healthRecordFiles")),

  developmentalConditionsPresent: developmentalStatusValidator,
  developmentalConditions: v.array(developmentalConditionValidator),
  developmentalConditionsOther: v.string(),
  developmentalSupportNotes: v.string(),
  developmentalSuccessfulSupports: v.string(),
  supportPlans: v.array(supportPlanValidator),
  supportPlanOther: v.string(),
  supportPlanDocumentDelivery: uploadDeliveryValidator,
  supportPlanDocumentId: v.union(v.null(), v.id("healthRecordFiles")),

  hap: v.object({
    allergy: v.boolean(),
    asthma: v.boolean(),
    seizure: v.boolean(),
    diabetes: v.boolean(),
    behavioralHealth: v.boolean(),
    other: v.boolean(),
    otherDesc: v.string(),
    none: v.boolean(),
    notes: v.string(),
  }),
  hapDocumentDelivery: uploadDeliveryValidator,
  actionPlanDocumentId: v.union(v.null(), v.id("healthRecordFiles")),

  // Condition-keyed action-plan pointers. The legacy `actionPlanDocumentId`
  // above still serves seizure / diabetes / behavioral-health / other; these
  // two exist because one generic slot cannot hold a food-allergy EAP and an
  // asthma EAP simultaneously. Normalized records always include both slots.
  actionPlanDocumentIds: v.object({
    allergy: v.union(v.null(), v.id("healthRecordFiles")),
    asthma: v.union(v.null(), v.id("healthRecordFiles")),
  }),

  emergencyMedAuthAck: v.boolean(),
  emergencyMedAuthNotes: v.string(),

  publicMediaOptOut: v.boolean(),
  privateSchoolMediaOptOut: v.boolean(),
  fieldTripRestriction: v.boolean(),
  fieldTripRestrictionDetails: v.string(),
  peRecessRestriction: v.boolean(),
  peRecessRestrictionDetails: v.string(),
  swimmingRestriction: v.boolean(),
  swimmingRestrictionDetails: v.string(),
  cookingWaiverParentFullName: v.string(),
  cookingWaiverStudentFullName: v.string(),
  cookingWaiverDetails: v.string(),
  cookingWaiverDate: v.string(),

  signerName: v.string(),
  signerAgreement: v.boolean(),
} as const;

export const healthRecordSchemaFields = {
  ...healthRecordFields,
  // Compatibility only for drafts/snapshots created before these fields existed.
  // New saves always include them; older rows validate via the optional overrides.
  childPreferredName: v.optional(v.string()),
  streetAddress: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zipCode: v.optional(v.string()),
  guardian1RelationshipOther: v.optional(v.string()),
  custodyDocumentDelivery: v.optional(uploadDeliveryValidator),
  custodyDocumentId: v.optional(v.union(v.null(), v.id("healthRecordFiles"))),
  developmentalConditionsPresent: v.optional(developmentalStatusValidator),
  developmentalConditions: v.optional(
    v.array(developmentalConditionValidator),
  ),
  developmentalConditionsOther: v.optional(v.string()),
  developmentalSupportNotes: v.optional(v.string()),
  developmentalSuccessfulSupports: v.optional(v.string()),
  supportPlans: v.optional(v.array(supportPlanValidator)),
  supportPlanOther: v.optional(v.string()),
  supportPlanDocumentDelivery: v.optional(uploadDeliveryValidator),
  supportPlanDocumentId: v.optional(
    v.union(v.null(), v.id("healthRecordFiles")),
  ),
  hap: v.object({
    allergy: v.boolean(),
    asthma: v.boolean(),
    seizure: v.boolean(),
    diabetes: v.boolean(),
    behavioralHealth: v.optional(v.boolean()),
    other: v.boolean(),
    otherDesc: v.string(),
    none: v.boolean(),
    notes: v.string(),
  }),
  hapDocumentDelivery: v.optional(uploadDeliveryValidator),
  actionPlanDocumentId: v.optional(
    v.union(v.null(), v.id("healthRecordFiles")),
  ),
  // Compatibility only: rows signed before the condition-keyed slots existed
  // omit this entirely. New saves always include it; normalization defaults it.
  actionPlanDocumentIds: v.optional(
    v.object({
      allergy: v.union(v.null(), v.id("healthRecordFiles")),
      asthma: v.union(v.null(), v.id("healthRecordFiles")),
    }),
  ),
  // Compatibility only for drafts/snapshots created on this unmerged branch.
  // New saves omit this parent-entered date and use server timestamps.
  immunizationDateSubmitted: v.optional(v.string()),
  schoolMedicationMode: v.optional(schoolMedicationModeValidator),
  medicationDocumentDelivery: v.optional(
    medicationDocumentDeliveryValidator,
  ),
  medicationDocumentId: v.optional(
    v.union(v.null(), v.id("healthRecordFiles")),
  ),
  immunizationDocumentDelivery: v.optional(
    immunizationDocumentDeliveryValidator,
  ),
  immunizationDocumentId: v.optional(
    v.union(v.null(), v.id("healthRecordFiles")),
  ),
  publicMediaOptOut: v.optional(v.boolean()),
  privateSchoolMediaOptOut: v.optional(v.boolean()),
  fieldTripRestriction: v.optional(v.boolean()),
  fieldTripRestrictionDetails: v.optional(v.string()),
  peRecessRestriction: v.optional(v.boolean()),
  peRecessRestrictionDetails: v.optional(v.string()),
  swimmingRestriction: v.optional(v.boolean()),
  swimmingRestrictionDetails: v.optional(v.string()),
  cookingWaiverParentFullName: v.optional(v.string()),
  cookingWaiverStudentFullName: v.optional(v.string()),
  cookingWaiverDetails: v.optional(v.string()),
  cookingWaiverDate: v.optional(v.string()),
  // Compatibility only for drafts/snapshots created before the exceptions model.
  photoConsent: v.optional(legacyConsentChoiceValidator),
  fieldTripConsent: v.optional(legacyConsentChoiceValidator),
  physicalActivityConsent: v.optional(legacyConsentChoiceValidator),
  activityRestrictions: v.optional(v.string()),
  swimConsent: v.optional(legacyConsentChoiceValidator),
} as const;

const _healthRecordFieldsValidator = v.object(healthRecordFields);
export type HealthRecordFields = Infer<typeof _healthRecordFieldsValidator>;
export type HealthDocumentKind =
  | "medication_authorization"
  | "immunization_record"
  | "custody_document"
  | "action_plan_document"
  | "action_plan_document_allergy"
  | "action_plan_document_asthma"
  | "support_plan_document";

export function emptyHealthRecordFields(prefill?: {
  childName?: string;
  childDob?: string;
  childGrade?: string;
  homeAddress?: string;
  guardianName?: string;
  guardianPhone?: string;
  guardianEmail?: string;
}): HealthRecordFields {
  return {
    childName: prefill?.childName?.trim() ?? "",
    childPreferredName: "",
    childDob: prefill?.childDob?.trim() ?? "",
    childGrade: prefill?.childGrade?.trim() ?? "",
    homeAddress: prefill?.homeAddress?.trim() ?? "",
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
    guardian1Name: prefill?.guardianName?.trim() ?? "",
    guardian1Relationship: "",
    guardian1RelationshipOther: "",
    guardian1Phone: prefill?.guardianPhone?.trim() ?? "",
    guardian1WorkPhone: "",
    guardian1Email: prefill?.guardianEmail?.trim() ?? "",
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

type CompatibilityOptionalField =
  | "schoolMedicationMode"
  | "medicationDocumentDelivery"
  | "medicationDocumentId"
  | "immunizationDocumentDelivery"
  | "immunizationDocumentId"
  | "publicMediaOptOut"
  | "privateSchoolMediaOptOut"
  | "fieldTripRestriction"
  | "fieldTripRestrictionDetails"
  | "peRecessRestriction"
  | "peRecessRestrictionDetails"
  | "swimmingRestriction"
  | "swimmingRestrictionDetails"
  | "cookingWaiverParentFullName"
  | "cookingWaiverStudentFullName"
  | "cookingWaiverDetails"
  | "cookingWaiverDate"
  | "childPreferredName"
  | "streetAddress"
  | "city"
  | "state"
  | "zipCode"
  | "guardian1RelationshipOther"
  | "custodyDocumentDelivery"
  | "custodyDocumentId"
  | "developmentalConditionsPresent"
  | "developmentalConditions"
  | "developmentalConditionsOther"
  | "developmentalSupportNotes"
  | "developmentalSuccessfulSupports"
  | "supportPlans"
  | "supportPlanOther"
  | "supportPlanDocumentDelivery"
  | "supportPlanDocumentId"
  | "hapDocumentDelivery"
  | "actionPlanDocumentId"
  | "actionPlanDocumentIds";

// `hap` is required, but its newest member (behavioralHealth) is optional so a
// pre-existing row without it still satisfies the input type; normalization
// defaults it to false.
type HealthRecordNormalizationInput = Partial<Omit<HealthRecordFields, "hap">> &
  Omit<HealthRecordFields, CompatibilityOptionalField | "hap"> &
  LegacyHealthRecordParticipation & {
    hap: Omit<HealthRecordFields["hap"], "behavioralHealth"> & {
      behavioralHealth?: boolean;
    };
  };

export function normalizeHealthRecordFields(
  fields: HealthRecordNormalizationInput,
): HealthRecordFields {
  const defaults = emptyHealthRecordFields();
  const fieldKeys = Object.keys(
    healthRecordFields,
  ) as Array<keyof HealthRecordFields>;
  const exactFields = Object.fromEntries(
    fieldKeys.map((key) => [key, fields[key] ?? defaults[key]]),
  ) as HealthRecordFields;
  return normalizeHealthRecordBusinessFields(exactFields, fields);
}

export function healthRecordBusinessIssues(
  fields: HealthRecordFields,
  submit: boolean,
  accountName?: string,
): HealthRecordValidationIssue[] {
  return healthRecordValidationIssues(fields, {
    submit,
    accountSignerName: accountName,
  });
}

function throwFirstIssue(issues: HealthRecordValidationIssue[]): void {
  if (issues[0]) throw new Error(issues[0].message);
}

export function validateHealthRecordSubmission(
  fields: HealthRecordFields,
  accountName: string | undefined,
): void {
  throwFirstIssue(healthRecordBusinessIssues(fields, true, accountName));
}

export function healthDocumentIds(
  fields: Pick<
    HealthRecordFields,
    | "medicationDocumentId"
    | "immunizationDocumentId"
    | "custodyDocumentId"
    | "actionPlanDocumentId"
    | "actionPlanDocumentIds"
    | "supportPlanDocumentId"
  >,
): Id<"healthRecordFiles">[] {
  return [
    fields.medicationDocumentId,
    fields.immunizationDocumentId,
    fields.custodyDocumentId,
    fields.actionPlanDocumentId,
    fields.actionPlanDocumentIds?.allergy ?? null,
    fields.actionPlanDocumentIds?.asthma ?? null,
    fields.supportPlanDocumentId,
  ].filter((id): id is Id<"healthRecordFiles"> => id !== null);
}

/** Key-order-independent structural comparison, for `healthRecordAnswersDiffer`. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    // `undefined` and "key absent" are the same answer — normalization emits
    // both (see `optionalText`), so neither may register as a difference.
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/**
 * Do these two field sets differ in anything the guardian has to ATTEST to —
 * i.e. would the school be looking at a stale record until this guardian signs
 * again?
 *
 * Everything is compared except the signature itself, which is deliberately
 * not an answer: `getHealthRecord` blanks `signerName`/`signerAgreement` when
 * it hands back an already-signed record, so comparing them would report every
 * untouched form as changed.
 *
 * Document slots ARE compared, and that is not an oversight. A guardian
 * attaching or replacing a document has it committed to the signed record in
 * place (`saveHealthRecord`, no revision bump — the same reasoning as a staff
 * attachment), so by the time this runs the two sides already agree about the
 * document and it correctly reports no attested change. A slot that could NOT
 * be committed in place — because the signed record's own answers leave it
 * inactive — is a real pending change and must keep reporting as one.
 */
export function healthRecordAnswersDiffer(
  a: HealthRecordFields,
  b: HealthRecordFields,
): boolean {
  const answers = (fields: HealthRecordFields): Partial<HealthRecordFields> => {
    const rest: Partial<HealthRecordFields> = { ...fields };
    delete rest.signerName;
    delete rest.signerAgreement;
    delete rest.publicMediaOptOut;
    delete rest.fieldTripRestriction;
    delete rest.fieldTripRestrictionDetails;
    delete rest.peRecessRestriction;
    delete rest.peRecessRestrictionDetails;
    delete rest.swimmingRestriction;
    delete rest.swimmingRestrictionDetails;
    delete rest.cookingWaiverParentFullName;
    delete rest.cookingWaiverStudentFullName;
    delete rest.cookingWaiverDetails;
    delete rest.cookingWaiverDate;
    return rest;
  };
  return (
    stableJson(answers(normalizeHealthRecordFields(a))) !==
    stableJson(answers(normalizeHealthRecordFields(b)))
  );
}

export function validateHealthFormProgress(
  currentStep: number,
  lastCompletedStep: number,
): void {
  if (
    !Number.isInteger(currentStep) ||
    currentStep < 0 ||
    currentStep > HEALTH_FORM_LAST_STEP
  ) {
    throw new Error("Current step is out of range");
  }
  if (
    !Number.isInteger(lastCompletedStep) ||
    lastCompletedStep < -1 ||
    lastCompletedStep >= HEALTH_FORM_LAST_STEP
  ) {
    throw new Error("Last completed step is out of range");
  }
}
