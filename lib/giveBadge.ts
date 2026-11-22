/**
 * The one badge a teacher sees on a give, in the words of the finish they
 * picked when they gave it (TRA-722). Teachers stopped choosing "Class focus"
 * or "Homework" on Nov 8; the give form asks when it should be finished
 * (components/GiveWindowFields.tsx), so the badge answers that question:
 *
 *   In that class              → "In class"
 *   By a date / end of unit    → "Due Thu, Nov 20" (the one due wording,
 *                                `dueStatus`; late reads "Was due …")
 *   Open until a date          → "Open until Fri", or "Closed Fri" once over
 *   No end (until cleared)     → "No end date"
 *
 * Reads the stored fields only (convex/lib/giveWindow.ts maps each finish
 * onto mode / endsAt / dueAt), and tells open-until from in-class with the one
 * helper, shared/openUntil.ts. Teacher-facing only: scholars never see it.
 * The mode still picks the badge's icon and color (lib/activityMode.tsx).
 */
import { dueStatus } from "@/shared/institutionDay";
import {
  isOpenUntil,
  openUntilClosedLabel,
  openUntilPhrase,
} from "@/shared/openUntil";

export type GiveBadgeEntry = {
  mode: "classFocus" | "homework";
  setAt?: number | null;
  startsAt?: number | null;
  endsAt?: number | null;
  dueAt?: number | null;
  /** Stored as the `openUntil` timing kind (TRA-726). */
  openUntilKind?: boolean | null;
};

export type GiveBadge =
  | { kind: "inClass"; text: string }
  | { kind: "due"; text: string; late: boolean }
  | { kind: "openUntil"; text: string; closed: boolean }
  | { kind: "noEnd"; text: string };

export const IN_CLASS_LABEL = "In class";
export const NO_END_LABEL = "No end date";

function capitalize(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

export function giveBadge(
  entry: GiveBadgeEntry,
  { nowMs, timeZone }: { nowMs: number; timeZone: string },
): GiveBadge {
  if (entry.mode === "homework") {
    const due = dueStatus(entry.dueAt, nowMs, timeZone);
    return due
      ? { kind: "due", text: capitalize(due.phrase), late: due.status === "overdue" }
      : { kind: "noEnd", text: NO_END_LABEL };
  }
  const sent = entry.setAt != null;
  if (isOpenUntil(entry, timeZone)) {
    const closesAt = entry.endsAt!;
    // A give that never went out never closed (same rule as the Run page's
    // `openUntilClosedLine`, which only reads sent entries).
    const closed = sent && closesAt <= nowMs;
    return {
      kind: "openUntil",
      text: closed
        ? openUntilClosedLabel(closesAt, timeZone)
        : openUntilPhrase(closesAt, timeZone, nowMs),
      closed,
    };
  }
  // A planned in-class give gets its end when it starts (the bell block it
  // lands in), so a missing end only means "no end" once it has gone out.
  if (sent && entry.endsAt == null) return { kind: "noEnd", text: NO_END_LABEL };
  return { kind: "inClass", text: IN_CLASS_LABEL };
}
