// Derive a 0–1 "interestingness" score (and a display kind) for a Debrief
// Key Moment, from fields the observer ALREADY writes — no change to the
// observer node action, no new stored field. The Debrief deck sorts real
// moments by this so a teacher sees the breakthroughs, misconceptions, and
// strong signals first. See review/curriculum-rehearse-and-maturity.md and
// the TODO "Review Key Moments".
//
// Tuning philosophy: a flagged MISCONCEPTION is almost always worth the
// teacher's eye (it's the thing to catch + re-teach), a deep
// student-initiated mastery moment is a breakthrough worth celebrating /
// extending, and a HIGH-intensity pedagogically-rich signal is the next
// tier. Everything is clamped to [0,1] so the deck has a stable sort.

export type MomentKind =
  | "misconception"
  | "breakthrough"
  | "mastery"
  | "signal"
  | "insight";

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

// Signals that carry the most pedagogical weight for a gifted program.
const RICH_SIGNALS = new Set([
  "creative_approach",
  "intellectual_intensity",
  "productive_struggle",
  "metacognition",
  "cross_domain_thinking",
]);

export function scoreMastery(o: {
  masteryLevel: number; // 0–5 Bloom's
  confidenceScore: number; // 0–1
  evidenceType: string;
  studentInitiated: boolean;
}): { score: number; kind: MomentKind } {
  // Confidence scales everything (a low-confidence read is less worth surfacing).
  const conf = 0.6 + 0.4 * clamp01(o.confidenceScore);
  if (o.evidenceType === "misconception_signal") {
    // A misconception is the headline catch — high baseline.
    return { score: clamp01(0.7 * conf + 0.1), kind: "misconception" };
  }
  if (o.masteryLevel >= 4) {
    // Analyze / evaluate / create — a depth breakthrough.
    const s = 0.55 + 0.1 * (o.masteryLevel - 4) + (o.studentInitiated ? 0.15 : 0);
    return { score: clamp01(s * conf), kind: "breakthrough" };
  }
  const s = 0.2 + 0.08 * o.masteryLevel + (o.studentInitiated ? 0.1 : 0);
  return { score: clamp01(s * conf), kind: "mastery" };
}

export function scoreSignal(s: {
  signalType: string;
  intensity: string; // "low" | "moderate" | "high"
}): { score: number; kind: MomentKind } {
  const base =
    s.intensity === "high" ? 0.6 : s.intensity === "moderate" ? 0.35 : 0.15;
  const rich = RICH_SIGNALS.has(s.signalType) ? 0.15 : 0;
  return { score: clamp01(base + rich), kind: "signal" };
}

export function scoreConnection(c: {
  domains: string[];
  studentInitiated: boolean;
}): { score: number; kind: MomentKind } {
  // A cross-domain link is intrinsically interesting; more so when the
  // scholar made it themselves or it bridges 3+ domains.
  const s =
    0.55 +
    0.1 * Math.max(0, (c.domains?.length ?? 0) - 2) +
    (c.studentInitiated ? 0.15 : 0);
  return { score: clamp01(s), kind: "insight" };
}
