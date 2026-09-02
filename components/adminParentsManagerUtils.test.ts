import { describe, expect, test } from "vitest";

import {
  buildGuardiansCsv,
  canUploadDirectoryDocuments,
  deriveScholarRows,
  filterParents,
  filterScholarRows,
  mergeScholarRows,
  parentLabel,
  scholarIdsFromParents,
} from "./adminParentsManagerUtils";

const parents = [
  {
    _id: "parent-2",
    name: "Pat Stone",
    email: "pat@example.com",
    children: [
      { _id: "scholar-2", name: "Kai Stone" },
      { _id: "scholar-1", name: "Avery Stone" },
    ],
  },
  {
    _id: "parent-1",
    name: "Alex Stone",
    email: "alex@example.com",
    children: [{ _id: "scholar-1", name: "Avery Stone" }],
  },
] as const;

describe("adminParentsManagerUtils", () => {
  test("offers directory uploads to health-authorized staff without granting operations-only staff", () => {
    expect(canUploadDirectoryDocuments("staff", true)).toBe(true);
    expect(canUploadDirectoryDocuments("staff", false)).toBe(false);
    expect(canUploadDirectoryDocuments("teacher", false)).toBe(true);
  });

  test("filters parent rows by parent, email, or scholar name", () => {
    expect(filterParents(parents.slice(), "alex").map((p) => p._id)).toEqual([
      "parent-1",
    ]);
    expect(filterParents(parents.slice(), "pat@example.com").map((p) => p._id)).toEqual([
      "parent-2",
    ]);
    expect(filterParents(parents.slice(), "kai").map((p) => p._id)).toEqual([
      "parent-2",
    ]);
  });

  test("deduplicates scholar ids across visible parent rows", () => {
    expect(scholarIdsFromParents(parents.slice())).toEqual([
      "scholar-2",
      "scholar-1",
    ]);
  });

  test("derives a scholar roster with linked families", () => {
    expect(deriveScholarRows(parents.slice())).toEqual([
      {
        _id: "scholar-1",
        name: "Avery Stone",
        image: null,
        username: null,
        parents: [
          { _id: "parent-1", name: "Alex Stone", email: "alex@example.com", image: null },
          { _id: "parent-2", name: "Pat Stone", email: "pat@example.com", image: null },
        ],
      },
      {
        _id: "scholar-2",
        name: "Kai Stone",
        image: null,
        username: null,
        parents: [
          { _id: "parent-2", name: "Pat Stone", email: "pat@example.com", image: null },
        ],
      },
    ]);
  });

  test("filters scholars by scholar or linked family details", () => {
    const scholars = deriveScholarRows(parents.slice());
    expect(filterScholarRows(scholars, "avery").map((s) => s._id)).toEqual([
      "scholar-1",
    ]);
    expect(filterScholarRows(scholars, "alex@example.com").map((s) => s._id)).toEqual([
      "scholar-1",
    ]);
    expect(filterScholarRows(scholars, "pat").map((s) => s._id)).toEqual([
      "scholar-1",
      "scholar-2",
    ]);
  });

  test("falls back to a generic family label", () => {
    expect(parentLabel({ name: "Pat Stone", email: "pat@example.com" })).toBe(
      "Pat Stone",
    );
    expect(parentLabel({ name: null, email: "pat@example.com" })).toBe(
      "pat@example.com",
    );
    expect(parentLabel({ name: null, email: null })).toBe("Family");
  });

  test("merges the authoritative scholar set with guardian info, keeping guardian-less scholars", () => {
    const guardianDerived = deriveScholarRows(parents.slice());
    // The lens-scoped roster includes a THIRD scholar with no guardian yet.
    const roster = [
      {
        _id: "scholar-1",
        name: "Avery Stone",
        image: null,
        username: "avery",
        enrollmentStanding: "enrolled" as const,
      },
      {
        _id: "scholar-2",
        name: "Kai Stone",
        image: null,
        username: "kai",
        enrollmentStanding: "program_guest" as const,
      },
      {
        _id: "scholar-3",
        name: "Noa Reef",
        image: null,
        username: "noa",
        enrollmentStanding: "enrolled" as const,
      },
    ];
    const merged = mergeScholarRows(roster, guardianDerived);
    // Guardian-less scholar still appears (empty parents) — sorted by name.
    expect(merged.map((s) => s._id)).toEqual([
      "scholar-1",
      "scholar-2",
      "scholar-3",
    ]);
    const noa = merged.find((s) => s._id === "scholar-3");
    expect(noa?.parents).toEqual([]);
    // A guardian-linked scholar keeps its guardians.
    const avery = merged.find((s) => s._id === "scholar-1");
    expect(avery?.parents.map((p) => p._id)).toEqual(["parent-1", "parent-2"]);
    expect(
      merged.find((s) => s._id === "scholar-2")?.enrollmentStanding,
    ).toBe("program_guest");
  });

  test("builds guardian CSV with one row per child and normalized contact columns", () => {
    const csv = buildGuardiansCsv([
      {
        name: "Stone, Avery",
        email: "avery@example.com",
        phone: "(808) 555-0123",
        address: "123 Palm Ave, Honolulu HI 96816",
        children: [
          { name: "Kai Stone", gradeLevel: "4" },
          { name: "Avery Stone", gradeLevel: "3" },
        ],
      },
    ]);

    expect(csv).toBe(
      '\uFEFF"Child Name","Grade","First Name","Last Name","Email","Phone","Street Address","City","State","ZIP"\r\n' +
        '"Avery Stone","3","Avery","Stone","avery@example.com","(808) 555-0123","123 Palm Ave","Honolulu","HI","96816"\r\n' +
        '"Kai Stone","4","Avery","Stone","avery@example.com","(808) 555-0123","123 Palm Ave","Honolulu","HI","96816"',
    );
  });

  test("escapes commas, quotes, and blank guardian CSV fields", () => {
    const csv = buildGuardiansCsv([
      {
        name: null,
        firstName: 'Pat "PJ"',
        lastName: "O'Brien",
        email: "pat@example.com",
        phone: null,
        address: null,
        streetAddress: '45 "A", Ocean Lane',
        city: "Kailua",
        state: "HI",
        zip: "96734",
        children: [{ name: "Noa, Jr.", gradeLevel: null }],
      },
    ]);

    expect(csv.split("\r\n")[1]).toBe(
      '"Noa, Jr.","","Pat ""PJ""","O\'Brien","pat@example.com","","45 ""A"", Ocean Lane","Kailua","HI","96734"',
    );
  });
});
