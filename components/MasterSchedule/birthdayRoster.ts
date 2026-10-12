import { buildCsv } from "@/shared/csv";

export type BirthdayRosterRow = {
  scholarId: string;
  name: string;
  username: string | null;
  month: number;
  day: number;
};

export type BirthdayRosterSort = "date" | "name";

export const BIRTHDAY_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function groupBirthdayRows(
  rows: readonly BirthdayRosterRow[],
  sort: BirthdayRosterSort,
) {
  return BIRTHDAY_MONTHS.map((label, index) => {
    const month = index + 1;
    const monthRows = rows.filter((row) => row.month === month);
    monthRows.sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name) || a.day - b.day
        : a.day - b.day || a.name.localeCompare(b.name),
    );
    return { month, label, rows: monthRows };
  }).filter((group) => group.rows.length > 0);
}

export function buildBirthdayRosterCsv(
  rows: readonly BirthdayRosterRow[],
): string {
  const sorted = groupBirthdayRows(rows, "date").flatMap(
    (group) => group.rows,
  );
  // BOM so Excel reads the UTF-8 names (macrons, ʻokina) instead of
  // mojibake — the same lead byte the parents-directory export carries.
  return `\uFEFF${buildCsv([
    ["Month", "Day", "Scholar"],
    ...sorted.map((row) => [
      BIRTHDAY_MONTHS[row.month - 1],
      row.day,
      row.name,
    ]),
  ])}`;
}
