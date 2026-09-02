/**
 * The scaffold-progress sweep — runs the three-axis draw audit over every
 * TEMPLATE family that emits worked steps, across many deterministic seeds, and
 * reduces the results to one row per family.
 *
 * Pure + deterministic (the seed ladder is fixed), so the same sweep produces
 * the same numbers on every machine and in CI. `scaffoldProgress.test.ts` is
 * the guard that fails the build when a family regresses.
 *
 * ── HONEST BUCKETS ──────────────────────────────────────────────────────────
 * Every DRAW lands in exactly one of three buckets — `pass`, `fail`, `n-a` —
 * and the pass rate is computed over EVALUABLE draws (pass + fail) only. The
 * n/a share is reported next to it rather than folded in. Before this split the
 * sweep reported "100% pass" while 61.5% of the corpus was un-evaluable; a
 * number that big has to be visible, because it bounds what the sweep can
 * actually promise.
 *
 * A draw with no `workedSteps` at all (a reveal-only item) counts as `n-a`, so
 * the denominator is every seed drawn, not just the ones that produced a
 * scaffold.
 */

import { formatAnswer } from "../../convex/lib/practice/answers";
import { generateItem } from "../../convex/lib/practice/templates";
import {
  auditDraw,
  type AxisName,
  type DrawAudit,
  type DrawVerdict,
  type ScaffoldAudit,
  type Verdict,
} from "./scaffoldProgress";
import type { AxisResult } from "./arithmeticAudit";

/** Every family that emits `workedSteps` today (mirrors the family list in
 *  convex/__tests__/workedStepGen.test.ts). */
export const SCAFFOLDED_FAMILIES: readonly string[] = [
  // Fraction arithmetic
  "add_subtract_like",
  "add_subtract_unlike",
  "multiply_fraction_by_whole",
  "multiply_fractions",
  "divide_unit_fractions",
  "divide_fractions",
  // Whole-number arithmetic
  "add_multidigit_algorithm",
  "subtract_multidigit_algorithm",
  "mult_2digit_by_1digit",
  "mult_3digit_by_1digit",
  "mult_2digit_by_2digit",
  "long_division_1digit_divisor",
  "long_division_2digit_divisor",
  "order_of_operations",
  // Decimals
  "decimal_notation_fractions",
  "add_subtract_decimals",
  "multiply_decimals",
  "divide_decimals",
  // Probability
  "theoretical_probability_simple",
  "probability_as_fraction",
  "complement_probability",
  "expected_frequency",
  "sample_space",
  // Statistics
  "mean",
  "median",
  "range",
];

export type AxisTally = Record<AxisResult, number>;

export type FamilyResult = {
  skillKey: string;
  /** Seeds drawn (the denominator), and how many produced a scaffold. */
  drawn: number;
  n: number;
  /** Draws with no worked steps at all — counted as `n-a`. */
  revealOnly: number;
  avgSteps: number;
  newNumberRate: number;
  /** The old terminal-move classes, kept so a regression there stays legible. */
  counts: Record<Verdict, number>;
  /** The three honest buckets, over every seed drawn. */
  buckets: Record<DrawVerdict, number>;
  /** Per-axis pass/fail/n-a, so each axis's own n/a share stays visible. */
  axes: Record<AxisName, AxisTally>;
  /** Math spans the reader could not parse. A hole in the READER — reported so
   *  it can never masquerade as a clean pass. */
  unparsed: string[];
  /** Share of draws landing in a HARD terminal-move class. */
  hardFailureRate: number;
  /** A verbatim worst-case example, for the failure message. */
  worstExample: {
    audit: ScaffoldAudit;
    draw: DrawAudit;
    seed: number;
    stem: string;
    stepTexts: string[];
    answer: string;
  } | null;
};

export const SEED_STRIDE = 2654435761;

function emptyAxisTally(): AxisTally {
  return { pass: 0, fail: 0, "n/a": 0 };
}

export function auditFamily(skillKey: string, sweep: number): FamilyResult {
  const counts: Record<Verdict, number> = {
    ok: 0,
    notation: 0,
    restates: 0,
    implicit: 0,
    leak: 0,
    "n/a": 0,
  };
  const buckets: Record<DrawVerdict, number> = { pass: 0, fail: 0, "n-a": 0 };
  const axes: Record<AxisName, AxisTally> = {
    terminal: emptyAxisTally(),
    arithmetic: emptyAxisTally(),
    provenance: emptyAxisTally(),
  };
  let drawn = 0;
  let n = 0;
  let revealOnly = 0;
  let stepsSum = 0;
  let rateSum = 0;
  const unparsed: string[] = [];
  let worstExample: FamilyResult["worstExample"] = null;

  for (let i = 0; i < sweep; i++) {
    const seed = 1 + i * SEED_STRIDE;
    const item = generateItem(skillKey, seed);
    if (!item) continue;
    drawn++;
    if (!item.workedSteps || item.workedSteps.length === 0) {
      // No scaffold to judge. Honest bucket: n-a, still in the denominator.
      revealOnly++;
      buckets["n-a"]++;
      for (const axis of Object.keys(axes) as AxisName[]) axes[axis]["n/a"]++;
      continue;
    }
    const answer = formatAnswer(item.answer);
    const draw = auditDraw(item.stem, answer, item.workedSteps);
    n++;
    stepsSum += draw.scaffold.stepCount;
    rateSum += draw.scaffold.newNumberRate;
    counts[draw.scaffold.verdict]++;
    buckets[draw.verdict]++;
    for (const axis of Object.keys(axes) as AxisName[]) axes[axis][draw.axes[axis]]++;
    for (const span of draw.arithmetic.unparsed) if (!unparsed.includes(span)) unparsed.push(span);
    if (!worstExample && draw.verdict === "fail") {
      worstExample = {
        audit: draw.scaffold,
        draw,
        seed,
        stem: item.stem,
        stepTexts: item.workedSteps.map((s) => s.text),
        answer,
      };
    }
  }

  const hard = counts.restates + counts.implicit + counts.leak;
  return {
    skillKey,
    drawn,
    n,
    revealOnly,
    avgSteps: n === 0 ? 0 : stepsSum / n,
    newNumberRate: n === 0 ? 0 : rateSum / n,
    counts,
    buckets,
    axes,
    unparsed,
    hardFailureRate: n === 0 ? 0 : hard / n,
    worstExample,
  };
}

export function runSweep(sweep = 300, families = SCAFFOLDED_FAMILIES): FamilyResult[] {
  return families.map((f) => auditFamily(f, sweep));
}

// ── Reporting ────────────────────────────────────────────────────────────────

export type SweepTotals = {
  drawn: number;
  buckets: Record<DrawVerdict, number>;
  axes: Record<AxisName, AxisTally>;
  /** Pass rate over EVALUABLE draws (pass + fail). `null` when none were. */
  passRate: number | null;
  /** Share of all draws that no axis could evaluate. */
  naShare: number;
};

export function totalsOf(results: readonly FamilyResult[]): SweepTotals {
  const buckets: Record<DrawVerdict, number> = { pass: 0, fail: 0, "n-a": 0 };
  const axes: Record<AxisName, AxisTally> = {
    terminal: emptyAxisTally(),
    arithmetic: emptyAxisTally(),
    provenance: emptyAxisTally(),
  };
  let drawn = 0;
  for (const r of results) {
    drawn += r.drawn;
    for (const b of Object.keys(buckets) as DrawVerdict[]) buckets[b] += r.buckets[b];
    for (const axis of Object.keys(axes) as AxisName[]) {
      for (const k of Object.keys(axes[axis]) as AxisResult[]) axes[axis][k] += r.axes[axis][k];
    }
  }
  const evaluable = buckets.pass + buckets.fail;
  return {
    drawn,
    buckets,
    axes,
    passRate: evaluable === 0 ? null : buckets.pass / evaluable,
    naShare: drawn === 0 ? 0 : buckets["n-a"] / drawn,
  };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

function axisLine(name: string, tally: AxisTally): string {
  const evaluable = tally.pass + tally.fail;
  const total = evaluable + tally["n/a"];
  const rate = evaluable === 0 ? "—" : pct(tally.pass / evaluable);
  const na = total === 0 ? "—" : pct(tally["n/a"] / total);
  return `  ${name.padEnd(11)} pass ${String(tally.pass).padStart(5)}  fail ${String(
    tally.fail,
  ).padStart(5)}  n/a ${String(tally["n/a"]).padStart(5)}  |  ${rate} of evaluable, ${na} n/a`;
}

/**
 * The human-readable sweep report. Deliberately leads with the three buckets
 * and states the n/a share on its own line: the point of the format is that a
 * reader can never mistake "nothing failed" for "everything was checked".
 */
export function formatReport(results: readonly FamilyResult[]): string {
  const totals = totalsOf(results);
  const lines: string[] = [];
  lines.push(`scaffold sweep — ${results.length} families, ${totals.drawn} draws`);
  lines.push("");
  lines.push(
    `  pass ${totals.buckets.pass}  fail ${totals.buckets.fail}  n-a ${totals.buckets["n-a"]}`,
  );
  lines.push(
    `  pass rate over evaluable draws: ${
      totals.passRate === null ? "—" : pct(totals.passRate)
    }  (${totals.buckets.pass}/${totals.buckets.pass + totals.buckets.fail})`,
  );
  lines.push(`  n/a share of all draws:          ${pct(totals.naShare)}`);
  lines.push("");
  lines.push("  by axis:");
  for (const axis of Object.keys(totals.axes) as AxisName[]) {
    lines.push(axisLine(axis, totals.axes[axis]));
  }
  lines.push("");
  lines.push("  by family:");
  for (const r of results) {
    const evaluable = r.buckets.pass + r.buckets.fail;
    lines.push(
      `  ${r.skillKey.padEnd(32)} n ${String(r.drawn).padStart(4)}  pass ${String(
        r.buckets.pass,
      ).padStart(4)}  fail ${String(r.buckets.fail).padStart(4)}  n-a ${String(
        r.buckets["n-a"],
      ).padStart(4)}  ${evaluable === 0 ? "—" : pct(r.buckets.pass / evaluable)}`,
    );
  }
  return lines.join("\n");
}

/** A failing draw rendered for a test message — stem, steps, and every issue. */
export function describeFailure(r: FamilyResult): string {
  const w = r.worstExample;
  if (!w) return `${r.skillKey}: ${r.buckets.fail} failing draws (no example captured)`;
  const steps = w.stepTexts.map((t, i) => `      ${i + 1}. ${t}`).join("\n");
  const issues = w.draw.issues
    .map((issue) => `      [${issue.axis}/${issue.kind} step ${issue.step}] ${issue.detail}`)
    .join("\n");
  return [
    `${r.skillKey}: ${r.buckets.fail}/${r.drawn} draws fail`,
    `    seed ${w.seed}  stem "${w.stem}"  answer ${w.answer}`,
    steps,
    issues,
  ].join("\n");
}
