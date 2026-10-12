import { describe, expect, test } from "vitest";
import {
  buildBirthdayRosterCsv,
  groupBirthdayRows,
  type BirthdayRosterRow,
} from "./birthdayRoster";

const rows: BirthdayRosterRow[] = [
  {
    scholarId: "scholar-1",
    name: "Zinnia Stone",
    username: null,
    month: 7,
    day: 2,
  },
  {
    scholarId: "scholar-2",
    name: "Avery Stone",
    username: null,
    month: 7,
    day: 20,
  },
  {
    scholarId: "scholar-3",
    name: "Hoku Makani",
    username: null,
    month: 3,
    day: 5,
  },
];

describe("birthday roster", () => {
  test("groups by calendar month and sorts within each month", () => {
    expect(groupBirthdayRows(rows, "date")).toEqual([
      {
        month: 3,
        label: "March",
        rows: [rows[2]],
      },
      {
        month: 7,
        label: "July",
        rows: [rows[0], rows[1]],
      },
    ]);
    expect(groupBirthdayRows(rows, "name")[1].rows).toEqual([
      rows[1],
      rows[0],
    ]);
  });

  test("exports calendar-sorted, spreadsheet-safe CSV", () => {
    const csv = buildBirthdayRosterCsv([
      ...rows,
      {
        scholarId: "scholar-4",
        name: "=FORMULA()",
        username: null,
        month: 12,
        day: 1,
      },
    ]);

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.slice(1).split("\r\n")).toEqual([
      '"Month","Day","Scholar"',
      '"March","5","Hoku Makani"',
      '"July","2","Zinnia Stone"',
      '"July","20","Avery Stone"',
      '"December","1","\'=FORMULA()"',
    ]);
  });
});
