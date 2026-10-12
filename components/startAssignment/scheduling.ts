// Timing constants + helpers shared by StartAssignmentDialog's modes.

export const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const DURATIONS = [
  { label: "30 min", min: 30 },
  { label: "45 min", min: 45 },
  { label: "1 hour", min: 60 },
  { label: "90 min", min: 90 },
  { label: "2 hours", min: 120 },
];

export function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** A sensible future default: the next time it's 9:00 AM (today if it's
 *  still before 9, else tomorrow) — so the dialog never opens on a past
 *  time. */
export function nextNineAm(now: number): number {
  const d = new Date(now);
  if (d.getHours() >= 9) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
