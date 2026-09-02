/**
 * Phase 4 — ground the simulation in reality (pure core). The whole loop rests
 * on a bet: that the Scholar Simulator's transcripts (and the judge's scores on
 * them) track what REAL kids experience on this activity. This module checks
 * that bet: judge REAL transcripts with the SAME curriculum judge, aggregate,
 * and calibrate against the simulated baseline. If the sim runs far more
 * optimistic (or pessimistic) than reality, its scores aren't a trustworthy
 * basis for promoting an edit — defer to a human until the gap closes.
 *
 * Product-side twin of evals/curriculum-sim/lib/ground.ts. Pure (no Convex / no
 * SDK) so it's unit-tested and importable from both the node action and React.
 */
import {
  FITNESS_DIMS,
  PROTECTED_DIMS,
  type Aggregate,
} from "./curriculumScore";
import type { SimTurn } from "./curriculumSimShared";

const ALL_NUMERIC = [...FITNESS_DIMS, ...PROTECTED_DIMS] as const;
type NumericDim = (typeof ALL_NUMERIC)[number];

/**
 * Map a real project's messages into the sim transcript shape: assistant→tutor,
 * user→scholar, dropping system/tool turns (the curriculum judge only reads the
 * human-facing exchange). Real transcripts carry no goal/stuck sentinel.
 *
 * When a tutor turn carries a scholar "got this wrong" flag (`messageFlags`),
 * it's annotated inline so the curriculum judge running the Debrief sees what
 * the real scholar caught — the qualitative half of feeding scholar feedback
 * into the grounding. Plain messages (no flag fields) are unchanged.
 */
export function realMessagesToTranscript(
  messages: {
    role: string;
    content: string;
    scholarFlaggedWrong?: boolean;
    scholarFlagReason?: string;
  }[],
): SimTurn[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const isTutor = m.role === "assistant";
      const content =
        isTutor && m.scholarFlaggedWrong
          ? `${m.content}\n\n⟦The real scholar flagged this response as wrong${
              m.scholarFlagReason ? `: "${m.scholarFlagReason}"` : ""
            }.⟧`
          : m.content;
      return {
        role: isTutor ? ("tutor" as const) : ("scholar" as const),
        content,
      };
    });
}

/**
 * A compact, human-readable excerpt of a transcript for the judge↔teacher
 * validation UI (adoptable #2) — the first several turns, labelled
 * Tutor/Scholar, capped at `maxChars` so we can persist it on a
 * groundedSessionVerdicts row and render two side by side without re-reading
 * the messages table. Adds a truncation marker when it clips.
 */
export function transcriptExcerpt(
  turns: SimTurn[],
  maxChars = 1400,
  maxTurns = 10,
): string {
  const lines: string[] = [];
  let used = 0;
  let clipped = turns.length > maxTurns;
  for (const t of turns.slice(0, maxTurns)) {
    const label = t.role === "tutor" ? "Tutor" : "Scholar";
    const body = t.content.replace(/\s+/g, " ").trim();
    const line = `${label}: ${body}`;
    if (used + line.length > maxChars) {
      // Fit a truncated tail of this turn, then stop.
      const room = Math.max(0, maxChars - used);
      if (room > label.length + 2) {
        lines.push(`${line.slice(0, room)}…`);
      }
      clipped = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  const text = lines.join("\n");
  return clipped ? `${text}\n…` : text;
}

export interface Calibration {
  perDim: Record<NumericDim, { sim: number; real: number; delta: number }>;
  /** sim.fitness − real.fitness. Positive = simulator is OPTIMISTIC vs reality. */
  fitnessDelta: number;
  threshold: number;
  /** Is the sim close enough to reality to trust its scores for promotion? */
  trustworthy: boolean;
  /** How many real transcripts the `real` aggregate was computed over. */
  realN: number;
  note: string;
  /**
   * sim.goalAttainment − real.goalAttainment. Positive = the sim kid reaches
   * (or declares) understanding that real kids on this activity don't — the
   * `[[DONE]]` sentinel firing too easily. Broken out from `fitnessDelta`
   * because a rosy overall fit can hide a specifically hot goalAttainment.
   */
  goalAttainmentDelta: number;
  /** Max goalAttainment gap tolerated before flagging the sim as over-optimistic. */
  goalAttainmentThreshold: number;
  /**
   * True when the sim OVER-scores goalAttainment vs real beyond the threshold:
   * the sim kid claims to have "got it" but real kids don't get that far.
   * Grounding-hygiene signal that the [[DONE]] contract is too loose.
   */
  goalAttainmentOptimistic: boolean;
  /** Specific hygiene note when goalAttainment runs hot (null otherwise). */
  goalAttainmentNote: string | null;
}

/**
 * Compare simulated aggregate vs aggregate over real transcripts. `threshold`
 * is the max |fitness gap| we tolerate before flagging the sim as an
 * untrustworthy proxy. `goalAttainmentThreshold` is the separate max the
 * goalAttainment dim may run OPTIMISTIC (sim − real) before we flag a
 * grounding-hygiene problem — the sim kid declaring understanding it can't
 * demonstrate (a too-eager `[[DONE]]`).
 */
export function calibrate(
  sim: Aggregate,
  real: Aggregate,
  threshold = 0.75,
  goalAttainmentThreshold = threshold,
): Calibration {
  const perDim = {} as Calibration["perDim"];
  for (const d of ALL_NUMERIC) {
    perDim[d] = {
      sim: sim.dims[d],
      real: real.dims[d],
      delta: sim.dims[d] - real.dims[d],
    };
  }
  const fitnessDelta = sim.fitness - real.fitness;
  const trustworthy = Math.abs(fitnessDelta) <= threshold;
  const dir = fitnessDelta > 0 ? "optimistic" : "pessimistic";
  const note = trustworthy
    ? `Simulator within ${threshold} of reality (Δfitness ${fitnessDelta.toFixed(2)}) — sim scores usable as a directional proxy.`
    : `Simulator runs ${dir} by ${Math.abs(fitnessDelta).toFixed(2)} (> ${threshold}) — DO NOT promote off sim scores alone; validate with a human or more real data.`;

  // Grounding hygiene on goalAttainment specifically. Only the OPTIMISTIC
  // direction is a problem: the sim kid "gets it" faster than real kids do,
  // which traces to a `[[DONE]]` sentinel that fires before genuine, own-words
  // understanding. A pessimistic goalAttainment (real kids do better than the
  // sim) is not a [[DONE]] hygiene issue, so it isn't flagged here.
  const goalAttainmentDelta = perDim.goalAttainment.delta;
  const goalAttainmentOptimistic = goalAttainmentDelta > goalAttainmentThreshold;
  const goalAttainmentNote = goalAttainmentOptimistic
    ? `goalAttainment runs optimistic by Δ${goalAttainmentDelta.toFixed(2)} vs real (> ${goalAttainmentThreshold}) — the sim kid declares understanding it can't demonstrate; tighten [[DONE]] so it only fires after the kid explains the goal in its own words.`
    : null;

  return {
    perDim,
    fitnessDelta,
    threshold,
    trustworthy,
    realN: real.n,
    note,
    goalAttainmentDelta,
    goalAttainmentThreshold,
    goalAttainmentOptimistic,
    goalAttainmentNote,
  };
}
