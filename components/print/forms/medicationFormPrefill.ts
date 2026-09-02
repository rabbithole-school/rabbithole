/**
 * Maps a scholar's health record (the guardian-gated
 * `scholarHealthRecords.getHealthRecord` read — signed record, or the
 * requesting guardian's current draft) onto the Medication and Allergy
 * Form's Student Information + Section I fields.
 *
 * Pure module so the mapping is unit-testable; the client wrapper
 * (`PrefilledMedicationAuthorizationForm`) feeds it the live query result.
 * Every field is optional — a blank string maps to `undefined` so the form
 * renders its normal blank line.
 */

/** The subset of health-record fields the prefill reads (structural). */
export type HealthRecordPrefillSource = {
  childName: string;
  childDob: string;
  childGrade: string;
  homeAddress: string;
  streetAddress: string;
  city: string;
  state: string;
  zipCode: string;
  insurancePlan: string;
  guardian1Name: string;
  guardian1Relationship: string;
  guardian1RelationshipOther: string;
  guardian1Phone: string;
};

export type MedicationFormPrefill = {
  studentName?: string;
  dateOfBirth?: string;
  grade?: string;
  schoolYear?: string;
  homeAddress?: string;
  guardianName?: string;
  phone?: string;
  relationship?: string;
  insurancePlan?: string;
};

const clean = (s: string | undefined | null): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** "2018-03-15" → "03/15/2018"; anything else passes through untouched. */
export function formatDob(iso: string | undefined): string | undefined {
  const t = clean(iso);
  if (!t) return undefined;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : t;
}

/** The school year containing `date` (new year starts in August). */
export function schoolYearFor(date: Date): string {
  const y = date.getFullYear();
  return date.getMonth() >= 7 ? `${y}–${y + 1}` : `${y - 1}–${y}`;
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  parent: "Parent",
  mother: "Mother",
  father: "Father",
  guardian: "Guardian",
  legal_guardian: "Legal Guardian",
};

function relationshipLabel(
  relationship: string,
  other: string,
): string | undefined {
  if (relationship === "other") return clean(other);
  return RELATIONSHIP_LABELS[relationship];
}

function composeAddress(r: HealthRecordPrefillSource): string | undefined {
  const street = clean(r.streetAddress);
  const city = clean(r.city);
  if (street && city) {
    const stateZip = [clean(r.state), clean(r.zipCode)]
      .filter(Boolean)
      .join(" ");
    return [street, city, stateZip].filter(Boolean).join(", ");
  }
  return clean(r.homeAddress);
}

export function prefillFromHealthRecord(
  record: HealthRecordPrefillSource,
  now: Date,
): MedicationFormPrefill {
  return {
    studentName: clean(record.childName),
    dateOfBirth: formatDob(record.childDob),
    grade: clean(record.childGrade),
    schoolYear: schoolYearFor(now),
    homeAddress: composeAddress(record),
    guardianName: clean(record.guardian1Name),
    phone: clean(record.guardian1Phone),
    relationship: relationshipLabel(
      record.guardian1Relationship,
      record.guardian1RelationshipOther,
    ),
    insurancePlan: clean(record.insurancePlan),
  };
}

// ── insurance checklist ──────────────────────────────────────────────────────
// The form's pre-printed plan options. `buildInsuranceItems` ticks the box
// matching the record's free-text plan name, writes an unrecognized plan onto
// the "Other" line, and leaves everything blank with no prefill.

const OTHER_BLANK = "Other: ____________________";

const PLAN_MATCHERS: Array<{ label: string; pattern: RegExp }> = [
  { label: "HMSA", pattern: /hmsa/i },
  { label: "Kaiser Permanente", pattern: /kaiser/i },
  { label: "Tricare", pattern: /tricare/i },
  { label: "Medicaid / Med-QUEST", pattern: /medicaid|quest/i },
  { label: "Uninsured / Self-Pay", pattern: /uninsured|self.?pay|none/i },
];

export function buildInsuranceItems(
  plan: string | undefined,
): Array<{ label: string; checked?: boolean }> {
  const t = clean(plan);
  const matched = t
    ? PLAN_MATCHERS.find(({ pattern }) => pattern.test(t))?.label
    : undefined;
  const named = PLAN_MATCHERS.map(({ label }) => ({
    label,
    checked: label === matched,
  }));
  const other =
    matched || !t
      ? { label: OTHER_BLANK, checked: false }
      : { label: `Other: ${t}`, checked: true };
  // Original form order: the four named plans, Other, then Uninsured.
  return [...named.slice(0, 4), other, named[4]];
}
