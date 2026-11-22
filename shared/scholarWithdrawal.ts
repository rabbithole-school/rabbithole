// Withdrawal: a scholar who has left the school (`users.withdrawnOn`, an ISO
// calendar date). Shared by the server's validation and the staff UI's label.

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written YYYY-MM-DD (rejects 2026-02-30). */
export function isIsoCalendarDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * "Nov 14, 2026" for a stored withdrawal date. Formatted in UTC so the
 * calendar date never shifts a day in a timezone west of Greenwich.
 */
export function formatWithdrawalDate(isoDate: string): string {
  if (!isIsoCalendarDate(isoDate)) return isoDate;
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
