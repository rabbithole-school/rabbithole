/**
 * The promoted "at a glance" detail for a Rounds board row.
 *
 * With the accordion gone, every row is a link into the scholar's full pane, so
 * the row itself has to answer "who needs the room's time this week?" without
 * anyone opening anything. These pure builders turn one scholar's week into a
 * SMALL set of compact chips rendered under the headline — never the whole
 * expanded pane, just the two or three signals worth a glance.
 *
 * Kept React-free so the choice of what earns a chip can be unit-tested rather
 * than eyeballed on a projector, in the same spirit as `roundsEvidence.ts`.
 *
 * ── Two rules this file honours ───────────────────────────────────────────
 *  1. Week-bounded numbers only. Everything here reads off the week-windowed
 *     `RoundsEvidenceInput` (observations, mastery, practice, pulse) or the
 *     week's SEL synthesis — never the trailing-seven-day practice FIGURES,
 *     which describe "now" and would be wrong under an older week's heading.
 *  2. Colour is load-bearing exactly once. Guidance is spoken to the child, so
 *     it is the one chip that reaches green; the SEL synthesis and the teacher
 *     record are teacher-facing and stay muted charcoal (SelSynthesisCard's
 *     charter: "strengths are not green").
 */

import { isSilentWeek, WEEK_OBSERVATION_CAP, type RoundsEvidenceInput } from "./roundsEvidence";
import type { SelSynthesisRow } from "./selSynthesisView";

export type RoundsRowDetailTone = "muted" | "guidance";

export interface RoundsRowDetailChip {
  key: string;
  text: string;
  tone: RoundsRowDetailTone;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The guidance chip both lenses share — the one signal that reaches the child,
 *  so the one chip allowed to be green. Absent when nothing is running. */
function guidanceChip(guidanceCount: number): RoundsRowDetailChip | null {
  if (guidanceCount <= 0) return null;
  return {
    key: "guidance",
    text: `${guidanceCount} guidance running`,
    tone: "guidance",
  };
}

/**
 * The academic row detail: a compact source hint for how much evidence the week
 * carried, plus the guidance chip. A genuinely silent week produces no evidence
 * chip at all — the muted "no evidence this week" headline already says it, and
 * a chip would only re-say it louder.
 */
export function academicRowDetail(
  input: RoundsEvidenceInput,
  guidanceCount: number,
): RoundsRowDetailChip[] {
  const chips: RoundsRowDetailChip[] = [];

  if (!isSilentWeek(input)) {
    const tokens: string[] = [];

    const notes = input.observations.length;
    if (notes > 0) {
      const capped = notes >= WEEK_OBSERVATION_CAP;
      tokens.push(`${notes}${capped ? "+" : ""} ${notes === 1 ? "note" : "notes"}`);
    }

    const sessions = input.pulse?.analyzedSessions ?? 0;
    if (sessions > 0) {
      tokens.push(plural(sessions, "session", "sessions"));
    } else if (input.pulse?.latestSummary?.trim()) {
      // Sessions were read but not counted as analysed — still an observer read.
      tokens.push("observer");
    }

    if (input.mastery.length > 0) tokens.push("mastery");
    if (input.practice.attempts > 0) tokens.push("practice");

    if (tokens.length > 0) {
      chips.push({ key: "evidence", text: tokens.join(" · "), tone: "muted" });
    }
  }

  const guidance = guidanceChip(guidanceCount);
  if (guidance) chips.push(guidance);

  return chips;
}

/**
 * The SEL row detail: the synthesis's shape (how many strengths, how many to
 * watch), the size of the verbatim teacher record, then guidance. All charcoal
 * except guidance — the synthesis never reaches the child.
 *
 * A missing or quiet synthesis produces no synthesis chip; the headline already
 * carries "not written yet" / "quiet week".
 */
export function selRowDetail(
  synthesis: SelSynthesisRow | null,
  teacherRecordCount: number,
  guidanceCount: number,
): RoundsRowDetailChip[] {
  const chips: RoundsRowDetailChip[] = [];

  if (synthesis && !synthesis.quiet) {
    const strengths = synthesis.strengths.length;
    const watch = synthesis.watch.length;
    const parts: string[] = [];
    if (strengths > 0) parts.push(plural(strengths, "strength", "strengths"));
    if (watch > 0) parts.push(`${watch} to watch`);
    if (parts.length > 0) {
      chips.push({ key: "synthesis", text: parts.join(" · "), tone: "muted" });
    }
  }

  if (teacherRecordCount > 0) {
    chips.push({
      key: "record",
      text: `${teacherRecordCount} teacher ${teacherRecordCount === 1 ? "note" : "notes"}`,
      tone: "muted",
    });
  }

  const guidance = guidanceChip(guidanceCount);
  if (guidance) chips.push(guidance);

  return chips;
}
