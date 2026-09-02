/**
 * Scholar-facing Calculator License copy + the ONE presentation model behind
 * the unified Fast math / Calculator license card (web:
 * components/practice/ScholarCalculatorLicenseCard.tsx, native:
 * native/src/components/ScholarCalculatorLicenseCard.tsx via the vendored copy).
 *
 * Both frontends draw the SAME fixed card grammar — eyebrow + license chip,
 * constant title, the scholar's OWN progress as the status line, a contextual
 * explanation, the self-reference cue, credential fields only once licensed,
 * and one bottom action — so the states can only ever change the message and
 * the chip. Keeping that mapping here (pure, no rendering) is what stops the
 * two surfaces drifting into different state machines.
 *
 * What deliberately does NOT exist in this contract: any score, threshold,
 * peer comparison, streak, in-app test workflow, or congratulatory treatment
 * of a percentage. The reading is the scholar's own self-relative automaticity;
 * pass/not-yet on the Calculator License Test is entirely a teacher's call,
 * made when they proctor the paper test.
 */

import {
  FAST_MATH_NAME_INLINE,
  fastMathAutomaticFraction,
} from "./fastMathName";

export type CalculatorLicenseInvitationState = "building" | "ready";

export type CalculatorLicenseInvitationCopy = {
  title: string;
  body: string;
  meta: string;
};

/**
 * Scholar-facing copy for the older Calculator License invitation shells.
 *
 * Retained because the vendored native copy of this module still feeds the
 * native card until its next vendor sync; the web card now renders the unified
 * grammar below. Automaticity counts and percentages stayed out of THIS
 * contract because the invitation had no self-progress slot to put them in —
 * the unified card does, and shows the scholar only their OWN reading.
 */
export function calculatorLicenseInvitationCopy(
  state: CalculatorLicenseInvitationState,
): CalculatorLicenseInvitationCopy {
  if (state === "ready") {
    return {
      title: "You're ready for the test",
      body: "Ask a teacher to proctor your Calculator License Test.",
      meta: "A teacher can grant calculator permission when they're ready.",
    };
  }
  return {
    title: "Calculator license",
    body:
      `A teacher can give you the Calculator License Test when you're ready. Practicing ${FAST_MATH_NAME_INLINE} helps you prepare.`,
    meta: "A teacher can grant calculator permission when they're ready.",
  };
}

// ── The unified Fast math / Calculator license card ────────────────────────

/** The scholar-safe Fast math read returned by `calculatorLicenses.myLicenseStatus`. */
export type CalculatorLicenseFastMath = {
  calibration: "known" | "uncalibrated";
  baselineKnown: boolean;
  automaticCount: number;
  denominator: number;
  percent: number;
  ready: boolean;
};

/** The durable credential's scholar-visible fields (no score field exists). */
export type CalculatorLicenseCredential = {
  issuedAt: number;
  issuedByName: string | null;
};

/**
 * The card's meaningful states. `licensed` always wins: the durable credential
 * outranks the derived reading, so a licensed scholar whose automaticity has
 * decayed (or whose baseline went unknown again) still reads as licensed.
 */
export type CalculatorLicenseCardState =
  | "uncalibrated"
  | "progress"
  | "ready"
  | "licensed";

export type CalculatorLicenseChipTone = "neutral" | "on";

export type CalculatorLicenseCardPresentation = {
  state: CalculatorLicenseCardState;
  /** Head-row eyebrow — constant in every state. */
  eyebrow: string;
  /** Card title — constant in every state. */
  title: string;
  chip: { label: string; tone: CalculatorLicenseChipTone };
  /** The scholar's own reading: an em dash until a baseline exists, never 0%. */
  status: { value: string; detail: string };
  body: string;
  /** The fixed self-reference cue, so the reading can't be read as a class rank. */
  cue: string;
  /**
   * The bottom-slot action. Deliberately weightless in the contract: it renders
   * as the SAME secondary, full-width button in every state, because the Math
   * tab's primary call to action lives on the card above it (check-in /
   * playlist). Quick-facts practice is always the adjacent optional path, so a
   * solid button here only competed with the day's actual next step.
   */
  action: {
    label: string;
    /** Button-local busy text — never a card state, never about the paper test. */
    busyLabel: string;
  };
  /** Issued / proctor fields render only while the credential is durable. */
  showCredentialFields: boolean;
};

export const CALCULATOR_LICENSE_CARD_EYEBROW = "Fast math";
export const CALCULATOR_LICENSE_CARD_TITLE = "Calculator license";
export const CALCULATOR_LICENSE_CARD_CUE = "Your own practice progress";
export const CALCULATOR_LICENSE_PRACTICE_LABEL = `Practice ${FAST_MATH_NAME_INLINE}`;
export const CALCULATOR_LICENSE_PRACTICE_BUSY_LABEL = `Starting ${FAST_MATH_NAME_INLINE}…`;
export const CALCULATOR_LICENSE_UNCALIBRATED_DETAIL =
  "Fast math is still getting a baseline";

const TEACHER_DISCRETION =
  "A teacher can grant calculator permission when they're ready.";

/**
 * Map the scholar's own license state + Fast math reading onto the one fixed
 * card grammar. Pure and framework-free so web and native render the same
 * words in the same slots.
 *
 * `fastMath: undefined` is the in-flight reading, presented exactly like an
 * uncalibrated one — an em dash, never a 0% that would read as a measurement.
 */
export function calculatorLicenseCardPresentation({
  license,
  fastMath,
}: {
  license: CalculatorLicenseCredential | null;
  fastMath: CalculatorLicenseFastMath | undefined;
}): CalculatorLicenseCardPresentation {
  const calibrated =
    !!fastMath && fastMath.calibration === "known" && fastMath.baselineKnown;
  const licensed = !!license;
  const ready = calibrated && !!fastMath?.ready;

  const state: CalculatorLicenseCardState = licensed
    ? "licensed"
    : !calibrated
      ? "uncalibrated"
      : ready
        ? "ready"
        : "progress";

  const status =
    calibrated && fastMath
      ? {
          value: `${fastMath.percent}%`,
          detail: fastMathAutomaticFraction(
            fastMath.automaticCount,
            fastMath.denominator,
          ),
        }
      : { value: "—", detail: CALCULATOR_LICENSE_UNCALIBRATED_DETAIL };

  const chip = licensed
    ? { label: "Licensed", tone: "on" as const }
    : ready
      ? { label: "Ready for the test", tone: "neutral" as const }
      : { label: "Not licensed", tone: "neutral" as const };

  const body = licensed
    ? `Your Calculator License is active. Practicing ${FAST_MATH_NAME_INLINE} is optional now — not a condition of holding it.`
    : ready
      ? `Ask a teacher to proctor the Calculator License Test. ${TEACHER_DISCRETION}`
      : `Keep practicing ${FAST_MATH_NAME_INLINE} to prepare for the Calculator License Test. ${TEACHER_DISCRETION}`;

  return {
    state,
    eyebrow: CALCULATOR_LICENSE_CARD_EYEBROW,
    title: CALCULATOR_LICENSE_CARD_TITLE,
    chip,
    status,
    body,
    cue: CALCULATOR_LICENSE_CARD_CUE,
    action: {
      label: CALCULATOR_LICENSE_PRACTICE_LABEL,
      busyLabel: CALCULATOR_LICENSE_PRACTICE_BUSY_LABEL,
    },
    showCredentialFields: licensed,
  };
}
