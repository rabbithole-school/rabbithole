/**
 * The ONE canonical rendering of game evidence for model consumption.
 *
 * Consumers: the Hint → coach grounding (convex/http.ts /practice-handoff)
 * and the game→debrief tutor context (follow-up PR). Anything else that wants
 * game evidence inside a prompt goes through THIS renderer — a second
 * rendering of the same evidence is the fork this comment exists to prevent.
 *
 * Rendering posture, in order of importance:
 *  - Evidence, never judgment: lines restate what happened using the server-
 *    owned evidence-plan labels; no score, no verdict, no recommendation.
 *  - The scholar's thinking first: predictions (paired with what they then
 *    saw), revisions (before → after), and their own words are the point;
 *    choices and rule results are context.
 *  - Claims stay labelled as claims (`outcome_claimed`, `strategy_inferred`
 *    render with their epistemic hedge, mirroring lib/games/digest.ts).
 */

import type { DigestNote, GameSessionDigest } from "./digest";

export interface RenderDigestOptions {
  /** Cap on rendered lines; keeps the newest when over. Default 30. */
  maxLines?: number;
}

type SequencedLine = {
  seq: number;
  line: string;
};

function renderChoice(note: DigestNote): string {
  if (note.actor === "scholar") return note.detail;
  return `[${note.actor}] ${note.detail}`;
}

export function renderDigestForModel(
  digest: GameSessionDigest,
  opts: RenderDigestOptions = {},
): string {
  const sequenced: SequencedLine[] = [
    ...digest.predictions.map((prediction) => ({
      seq: prediction.seq,
      line: `They predicted: "${prediction.value}"${
        prediction.outcome ? ` — then saw: "${prediction.outcome.value}"` : ""
      }`,
    })),
    ...digest.revisions.map((revision) => ({
      seq: revision.seq,
      line: `They changed their thinking: "${revision.before}" → "${revision.after}"${
        revision.triggeredBy ? ` (right after: ${revision.triggeredBy.summary})` : ""
      }`,
    })),
    ...digest.strategyInferences
      .filter((note) => note.tutorRole !== "ignore")
      .map((note) => ({
        seq: note.seq,
        line: `${note.detail} (the game's guess, not a fact)`,
      })),
    ...digest.localRuleResults
      .filter((note) => note.tutorRole !== "ignore")
      .map((note) => ({ seq: note.seq, line: note.detail })),
    ...digest.scholarExplanations
      .filter((note) => note.tutorRole !== "ignore")
      .map((note) => ({
        seq: note.seq,
        line: `In their own words: "${note.detail}"`,
      })),
    ...digest.helpRequests
      .filter((note) => note.tutorRole !== "ignore")
      .map((note) => ({ seq: note.seq, line: "They asked for a hint here." })),
    ...digest.choices
      .filter((note) => note.tutorRole !== "ignore")
      .map((note) => ({ seq: note.seq, line: renderChoice(note) })),
  ].sort((a, b) => a.seq - b.seq);

  const lines = sequenced.map(({ line }) => line);
  if (digest.outcomeClaim) {
    lines.push(
      `The game reports the round ended: "${digest.outcomeClaim.outcomeKey}" (the game's claim).`,
    );
  }
  if (lines.length === 0) {
    return "(They've just started — no moves recorded yet.)";
  }

  const maxLines = Math.max(0, Math.floor(opts.maxLines ?? 30));
  if (lines.length <= maxLines) return lines.join("\n");

  const kept = maxLines === 0 ? [] : lines.slice(-maxLines);
  return [`(… earlier play omitted — ${lines.length - kept.length} lines)`, ...kept].join("\n");
}
