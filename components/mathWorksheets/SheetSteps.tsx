"use client";

/**
 * The worked steps on a printed sheet: the revealed steps numbered, then a
 * blank row for each faded step, the last of which gives the answer. The same
 * fade the practice engine's WorkedSteps renders, drawn for paper. It has no
 * tap-to-hear, so it pulls in none of the app's speech or sign-in code (the
 * worksheet pages run without the app's providers; lib/lightPublicRoutes.ts).
 */

import { FractionText } from "@/components/FractionText";
import { superscriptExponents } from "@/shared/mathNotation";
import type { FadeResult } from "@/convex/lib/practice/fadedSteps";

export function SheetSteps({ steps }: { steps: FadeResult }) {
  if (steps.revealed.length === 0) return null;
  return (
    <ol className="mw-step-list">
      {steps.revealed.map((step, i) => (
        <li key={`r-${i}`}>
          <FractionText value={superscriptExponents(step.text)} inline fontSize={15} align="left" color="#2c332e" />
        </li>
      ))}
      {steps.faded.map((step, i) => (
        <li key={`f-${i}`} className="mw-step-blank">
          {step.blankText}
        </li>
      ))}
    </ol>
  );
}
