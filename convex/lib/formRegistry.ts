// Required-form registry: the extensibility seam for the Form Completion Dashboard.
//
// Add a new entry here to make it appear in the dashboard, missing-form report,
// and reminder emails automatically — no additional UI work required.
//
// This file is imported by CLIENT code (`components/FormCompletionDashboard.tsx`
// reads `REQUIRED_FORMS` directly), so it must stay pure metadata: no `ctx`, no
// database reads, no functions that only run on the server. Applicability is a
// declarative STRING key resolved server-side in `formCompletion.ts`, never a
// `QueryCtx`-typed function value shipped to the browser.

/**
 * Declarative applicability, resolved server-side against the signed record.
 *   - "always"             — every enrolled scholar (the Health & Emergency Record).
 *   - "medication_on_file" — schoolMedicationMode is set and not "none".
 *   - "hap_allergy"        — the record reports a food allergy.
 *   - "hap_asthma"         — the record reports asthma.
 *   - "program_guest"      — only Extended Education program guests.
 *   - "clearance_requested"— NOT record-derived: applies only while a medical-
 *                            clearance request is open for the scholar. Resolved
 *                            from the `medicalClearanceRequests` table, not the
 *                            signed record, so it is handled explicitly in
 *                            `formCompletion.ts` rather than by the record-only
 *                            `resolveApplicability` switch.
 */
export type FormApplicabilityKey =
  | "always"
  | "medication_on_file"
  | "hap_allergy"
  | "hap_asthma"
  | "program_guest"
  | "clearance_requested";

export type FormRegistryEntry = {
  /** Stable, unique identifier used as the key in completion maps. */
  id: string;
  /** Short display label used in the dashboard and emails. */
  label: string;
  /** One-line description shown in the reminder email body. */
  description: string;
  /**
   * URL path (relative to SITE_URL) that a guardian visits to complete this
   * form. Used in reminder emails as the direct "Complete the form" link.
   */
  formPath: string;
  /**
   * Which scholars this form applies to. A form that does not apply to a
   * scholar shows as `not_applicable` (N/A) on the dashboard and is never
   * counted as an outstanding item or included in a reminder.
   */
  applicabilityKey: FormApplicabilityKey;
  /**
   * Optional last day the form is open, as a school-local "YYYY-MM-DD" day
   * key — INCLUSIVE: the form closes at the end of this day in the school's
   * timezone. For one-off event forms (a field-trip permission slip) that
   * would otherwise sit on every family's list, the staff dashboard, and
   * reminder emails forever after the event.
   *
   * Once closed (`isFormExpired`), the form is treated as not applicable for
   * outstanding-ness everywhere a family or staff member is nagged: it leaves
   * the parent Forms list (a submitted copy stays as a read-only card), refuses
   * new drafts and submissions, reads N/A instead of missing on the Form
   * Completion Dashboard, and is never included in a reminder. Responses
   * already on file stay readable to staff (the aide's form-responses tool,
   * the dashboard export, the printable form). Absent = never closes.
   */
  expiresOn?: string;
};

export const REQUIRED_FORMS: FormRegistryEntry[] = [
  {
    id: "health_emergency",
    label: "Health & Emergency Record",
    description:
      "Your child's medical information and emergency contacts for school staff.",
    formPath: "/parent/health-form",
    applicabilityKey: "always",
  },
  {
    id: "keiki_cooking_lab_liability_waiver",
    label: "Keiki Cooking Lab liability waiver",
    description:
      "A signed parent or guardian liability and allergy waiver before cooking class participation.",
    formPath: "/parent/forms/keiki-cooking-lab-liability-waiver",
    applicabilityKey: "always",
  },
  {
    id: "chuseok_field_trip_permission_slip",
    label: "Chuseok Field Trip Permission Slip",
    description:
      "A signed parent or guardian permission slip before the Chuseok field trip.",
    formPath: "/parent/forms/chuseok-field-trip-permission-slip",
    applicabilityKey: "always",
    expiresOn: "2026-10-04",
  },
  {
    id: "waimanalo_country_farms_field_trip_permission_slip",
    label: "Waimānalo Country Farms Field Trip Permission Slip",
    description:
      "A signed parent or guardian permission slip and transportation choice for the Waimānalo Country Farms field trip.",
    formPath: "/parent/forms/waimanalo-country-farms-field-trip-permission-slip",
    applicabilityKey: "always",
    // Open through the day after the Oct 20 trip, then off families' lists.
    expiresOn: "2026-10-21",
  },
  {
    id: "molii_gardens_field_trip_permission_slip",
    label: "Mōliʻi Gardens Field Trip Permission Slip",
    description:
      "A signed parent or guardian permission slip, transportation choice, and Kualoa Ranch release for the Mōliʻi Gardens field trip.",
    formPath: "/parent/forms/molii-gardens-field-trip-permission-slip",
    applicabilityKey: "always",
    // Open through the day after the Nov 17 trip, then off families' lists.
    expiresOn: "2026-11-18",
  },
  {
    id: "annual_program_participation",
    label: "Annual program participation",
    description: "Your family's participation preferences and activity restrictions.",
    formPath: "/parent/forms/annual-program-participation",
    applicabilityKey: "always",
  },
  {
    id: "extended_education_visiting_student",
    label: "Extended education visiting-student form",
    description:
      "Participation, emergency, health, and guardian authorizations for an Extended Education visiting student.",
    formPath: "/parent/forms/extended-education-visiting-student",
    applicabilityKey: "program_guest",
  },
  {
    id: "current_physical",
    label: "Current physical",
    description:
      "Your child's physician-completed physical exam form, on file with the school.",
    // A standalone card on the parent portal's Records tab — NOT a step in the
    // annual health-form wizard, and not a slot on the signed record.
    formPath: "/parent/records",
    applicabilityKey: "always",
  },
  {
    id: "medication_authorization",
    label: "Medication Authorization",
    description:
      "A physician-signed authorization for medication given or carried at school.",
    formPath: "/parent/health-form",
    applicabilityKey: "medication_on_file",
  },
  {
    id: "allergy_eap",
    label: "Food Allergy Action Plan",
    description:
      "A physician-signed food-allergy emergency action plan for your child.",
    formPath: "/parent/health-form",
    applicabilityKey: "hap_allergy",
  },
  {
    id: "asthma_eap",
    label: "Asthma Action Plan",
    description: "A physician-signed asthma action plan for your child.",
    formPath: "/parent/health-form",
    applicabilityKey: "hap_asthma",
  },
  {
    id: "medical_clearance",
    label: "Medical Clearance",
    description:
      "A physician's clearance for your child to return to school activity after an injury, illness, or procedure.",
    // The Records tab hosts the clearance upload — it is not a step in the
    // annual health-form wizard (clearance is event-triggered, not signed once
    // a year).
    formPath: "/parent",
    applicabilityKey: "clearance_requested",
  },
];

/** Look up a registered form by id. Returns undefined if not found. */
export function getFormEntry(formId: string): FormRegistryEntry | undefined {
  return REQUIRED_FORMS.find((f) => f.id === formId);
}

/**
 * Whether a form has closed as of `todayDayKey` — the school-local
 * "YYYY-MM-DD" day key for now (`dayKeyForTimezone` in
 * shared/institutionDay.ts). `expiresOn` is the last OPEN day, so the form is
 * expired only once today is strictly after it. Day keys compare correctly as
 * strings. Pure: the caller owns the clock (see T11 in
 * .claude/rules/rabbithole-product-taste.md).
 */
export function isFormExpired(
  form: { expiresOn?: string | null },
  todayDayKey: string,
): boolean {
  return !!form.expiresOn && todayDayKey > form.expiresOn;
}

/** "October 4, 2026" for a "YYYY-MM-DD" day key, with no timezone shift. */
export function formatFormDayKey(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(year, month - 1, day));
}

/** The plain sentence a family sees for a closed form. */
export function formClosedMessage(expiresOn: string): string {
  return `This form closed on ${formatFormDayKey(expiresOn)}.`;
}
