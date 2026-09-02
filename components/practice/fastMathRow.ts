/**
 * The Fast math row's readouts for the All-domains matrix — pure, so the row's
 * copy and its three states are testable without a render harness (the same
 * shape `masteryGradeLevel.ts` / `mathSkillsMasteryFilters.ts` take).
 *
 * The row is a PERCENT row in a matrix of grade levels, so it deliberately
 * shows no wash: the heatmap's tints encode grade level against age, and a
 * percent has no place on that scale. Number + one small word, in the same cell
 * geometry as every other row.
 */

import {
  FAST_MATH_NAME,
  fastMathAutomaticFraction,
} from "@/shared/fastMathName";

export type FastMathLicense = {
  issuedAt: number;
  issuedByName: string | null;
};

export type FastMathReading = {
  automaticCount: number;
  denominator: number;
  percent: number;
  ready: boolean;
  baselineKnown: boolean;
  license: FastMathLicense | null;
};

export type FastMathSliceReading = {
  automaticCount: number;
  denominator: number;
  percent: number;
};

export type FastMathOperation = "add" | "sub" | "mul";

export type FastMathDetailedReading = FastMathReading & {
  byOperation: Record<FastMathOperation, FastMathSliceReading>;
  byFamily: Record<string, FastMathSliceReading>;
};

export const FAST_MATH_OPERATION_GROUPS: readonly {
  op: FastMathOperation;
  label: string;
  families: readonly { skillKey: string; label: string }[];
}[] = [
  {
    op: "add",
    label: "Addition",
    families: [
      { skillKey: "add_within_5", label: "Add within 5" },
      { skillKey: "add_within_10", label: "Add within 10" },
      {
        skillKey: "add_within_20_no_regroup",
        label: "Add within 20 without regrouping",
      },
      {
        skillKey: "add_within_20_regroup",
        label: "Add within 20 with regrouping",
      },
    ],
  },
  {
    op: "sub",
    label: "Subtraction",
    families: [
      { skillKey: "subtract_within_5", label: "Subtract within 5" },
      { skillKey: "subtract_within_10", label: "Subtract within 10" },
      { skillKey: "subtract_within_20", label: "Subtract within 20" },
    ],
  },
  {
    op: "mul",
    label: "Multiplication",
    families: [
      {
        skillKey: "mult_facts_0_1_2_5_10",
        label: "Multiply by 0, 1, 2, 5, and 10",
      },
      { skillKey: "mult_facts_3_4_6", label: "Multiply by 3, 4, and 6" },
      { skillKey: "mult_facts_7_8_9", label: "Multiply by 7, 8, and 9" },
    ],
  },
];

export type FastMathCellStatus =
  | "loading"
  | "uncalibrated"
  | "progress"
  | "ready"
  | "licensed";

export type FastMathCellReadout = {
  /** The cell's number, or an em dash while the reading is in flight. */
  display: string;
  status: FastMathCellStatus;
  /** The one small word under the number, or null for a plain percent. */
  subLabel: string | null;
  /** Hover/`aria` sentence — always names the fraction behind the percent. */
  title: string;
};

/** The row label's second line: what 100% actually means, in facts. */
export function fastMathRowSubLabel(denominator: number | null): string {
  return denominator == null
    ? `${FAST_MATH_NAME} · % automatic`
    : `${denominator} facts · % automatic`;
}

function formatIssuedAt(issuedAt: number): string {
  return new Date(issuedAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * One scholar's Fast math cell. `reading === undefined` means the query hasn't
 * landed yet — never rendered as 0%, which would read as a real measurement.
 */
export function fastMathCellReadout({
  reading,
  scholarName,
}: {
  reading: FastMathReading | undefined;
  scholarName: string;
}): FastMathCellReadout {
  if (!reading) {
    return {
      display: "—",
      status: "loading",
      subLabel: null,
      title: `${scholarName} · fast math — loading`,
    };
  }

  if (!reading.baselineKnown) {
    return {
      display: "—",
      status: "uncalibrated",
      subLabel: null,
      title: `${scholarName} · fast math not measured yet — still calibrating this scholar's own pace`,
    };
  }

  const fraction = fastMathAutomaticFraction(
    reading.automaticCount,
    reading.denominator,
  );
  const percentText = `${reading.percent}%`;

  if (reading.license) {
    const issuedBy = reading.license.issuedByName
      ? ` by ${reading.license.issuedByName}`
      : "";
    return {
      display: percentText,
      status: "licensed",
      subLabel: "Licensed",
      title:
        `${scholarName} · calculator license — ` +
        `granted ${formatIssuedAt(reading.license.issuedAt)}${issuedBy}. ` +
        `Fast math now ${percentText} (${fraction}).`,
    };
  }

  if (reading.ready) {
    return {
      display: percentText,
      status: "ready",
      subLabel: "Ready",
      title: `${scholarName} · fast math ${percentText} (${fraction}). Ready for the Calculator License Test.`,
    };
  }

  return {
    display: percentText,
    status: "progress",
    subLabel: null,
    title: `${scholarName} · fast math ${percentText} (${fraction}). A teacher can record a passing proctored exam at any time.`,
  };
}

export function fastMathSliceCellReadout({
  reading,
  baselineKnown,
  scholarName,
  label,
}: {
  reading: FastMathSliceReading | undefined;
  baselineKnown: boolean | undefined;
  scholarName: string;
  label: string;
}): Pick<FastMathCellReadout, "display" | "status" | "title"> {
  if (!reading || baselineKnown === undefined) {
    return {
      display: "—",
      status: "loading",
      title: `${scholarName} · ${label.toLowerCase()} — loading`,
    };
  }
  if (!baselineKnown) {
    return {
      display: "—",
      status: "uncalibrated",
      title: `${scholarName} · ${label.toLowerCase()} not measured yet — still calibrating this scholar's own pace`,
    };
  }
  return {
    display: `${reading.percent}%`,
    status: reading.percent === 100 ? "ready" : "progress",
    title:
      `${scholarName} · ${label} — ` +
      `${fastMathAutomaticFraction(reading.automaticCount, reading.denominator)} ` +
      `(${reading.percent}%).`,
  };
}

/** A continuous white → fluent-green wash. The printed percentage remains the
 * primary channel; this tint makes relative progress glanceable. */
export function fastMathPercentTint(percent: number): string {
  const ratio = Math.max(0, Math.min(100, percent)) / 100;
  const target = [0x3a, 0x9e, 0x6b];
  const channels = target.map((value) =>
    Math.round(255 + (value - 255) * ratio),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}
