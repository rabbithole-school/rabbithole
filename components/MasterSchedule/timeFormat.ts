/**
 * Shared "HH:MM" → human time formatting for master-schedule surfaces
 * (the Day/Week grid's block rows + the placement detail drawer's context
 * line). Extracted from MasterScheduleView so the drawer doesn't fork a
 * second formatter.
 */

export function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(
    new Date(2000, 0, 1, h, m),
  );
}

export function fmtTimeRange(start: string, end: string): string {
  const s = fmtTime(start);
  const e = fmtTime(end);
  const sMer = s.slice(-2);
  const eMer = e.slice(-2);
  const sNoMer = s.replace(/\s?[AP]M$/, "");
  return sMer === eMer ? `${sNoMer}–${e}` : `${s}–${e}`;
}
