import { describe, expect, test } from "vitest";
import {
  scholarResolved,
  assignmentResolved,
  isProcessed,
  needsReview,
  openFields,
  resolveAssignment,
  type ResolvableItem,
} from "../lib/portfolioStatus";

// Pure tests for the two-axis (scholar + assignment) resolution logic that
// drives the scanner inbox's To Review / Processed split.

const item = (over: Partial<ResolvableItem>): ResolvableItem => ({
  matchStatus: "unmatched",
  scholarId: null,
  assignmentStatus: "unresolved",
  ...over,
});

describe("scholarResolved", () => {
  test("matched/confirmed WITH an id", () => {
    expect(scholarResolved(item({ matchStatus: "matched", scholarId: "s1" }))).toBe(true);
    expect(scholarResolved(item({ matchStatus: "confirmed", scholarId: "s1" }))).toBe(true);
  });
  test("matched WITHOUT an id is not resolved", () => {
    expect(scholarResolved(item({ matchStatus: "matched", scholarId: null }))).toBe(false);
  });
  test("unmatched/ambiguous never resolved", () => {
    expect(scholarResolved(item({ matchStatus: "unmatched", scholarId: "s1" }))).toBe(false);
    expect(scholarResolved(item({ matchStatus: "ambiguous", scholarId: "s1" }))).toBe(false);
  });
});

describe("assignmentResolved", () => {
  test("matched/confirmed/none are resolved", () => {
    expect(assignmentResolved(item({ assignmentStatus: "matched" }))).toBe(true);
    expect(assignmentResolved(item({ assignmentStatus: "confirmed" }))).toBe(true);
    expect(assignmentResolved(item({ assignmentStatus: "none" }))).toBe(true);
  });
  test("unresolved / undefined are open", () => {
    expect(assignmentResolved(item({ assignmentStatus: "unresolved" }))).toBe(false);
    expect(assignmentResolved(item({ assignmentStatus: undefined }))).toBe(false);
  });
});

describe("isProcessed / needsReview", () => {
  test("processed needs BOTH axes", () => {
    expect(isProcessed(item({ matchStatus: "matched", scholarId: "s1", assignmentStatus: "none" }))).toBe(true);
    expect(isProcessed(item({ matchStatus: "matched", scholarId: "s1", assignmentStatus: "unresolved" }))).toBe(false);
    expect(isProcessed(item({ matchStatus: "unmatched", scholarId: null, assignmentStatus: "none" }))).toBe(false);
  });
  test("needsReview is the inverse", () => {
    const filed = item({ matchStatus: "confirmed", scholarId: "s1", assignmentStatus: "confirmed" });
    expect(needsReview(filed)).toBe(false);
    expect(needsReview(item({}))).toBe(true);
  });
});

describe("openFields", () => {
  test("reports which pickers to show", () => {
    expect(openFields(item({ matchStatus: "matched", scholarId: "s1", assignmentStatus: "unresolved" })))
      .toEqual({ scholar: false, assignment: true });
    expect(openFields(item({ matchStatus: "unmatched", scholarId: null, assignmentStatus: "none" })))
      .toEqual({ scholar: true, assignment: false });
  });
});

describe("resolveAssignment", () => {
  const A = [
    { id: "a1", scholarIds: ["kai", "lani"] },
    { id: "a2", scholarIds: ["noah"] },
  ];
  test("no active assignments → none", () => {
    expect(resolveAssignment("a1", "kai", [])).toEqual({ assignmentStatus: "none" });
  });
  test("confident guess + scholar enrolled → matched", () => {
    expect(resolveAssignment("a1", "kai", A)).toEqual({ assignmentId: "a1", assignmentStatus: "matched" });
  });
  test("guessed assignment the scholar is NOT in → unresolved", () => {
    expect(resolveAssignment("a2", "kai", A)).toEqual({ assignmentStatus: "unresolved" });
  });
  test("no guess, or unknown scholar, or bogus id → unresolved", () => {
    expect(resolveAssignment(null, "kai", A)).toEqual({ assignmentStatus: "unresolved" });
    expect(resolveAssignment("a1", null, A)).toEqual({ assignmentStatus: "unresolved" });
    expect(resolveAssignment("ghost", "kai", A)).toEqual({ assignmentStatus: "unresolved" });
  });
});
