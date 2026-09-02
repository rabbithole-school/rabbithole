import { describe, expect, test } from "vitest";
import { isSelfScholarReference } from "./instructionReferenceAudience";

// Why this file: the on-demand instructional REFERENCE placement (§4.3 "See
// the move") must log a scholar's retrieval telemetry ONLY when the scholar
// themself opened it — the same "only the scholar's own sitting" doctrine
// `resolveRunLaunchpad`'s `isSelf` guard enforces server-side for the doorway.
// This pins the pure identity check NodeDrawer uses to decide whether to pass
// through the write.
//
// UNIFIED guard: this exact function is ALSO the server-side enforcement —
// `convex/instruction.ts`'s `requireScholarSelf` calls `isSelfScholarReference`
// (with no `audience`, exactly like the "no audience label" cases below) to
// reject a teacher/parent's direct `recordInstructionRetrieval` call, not just
// gate the client UI. So every case here doubles as a pin on the SERVER write
// guard, not merely the client's `logRetrieval` prop — see
// `convex/__tests__/instructionLifecycle.test.ts`'s "a teacher (even one with
// legitimate access to the scholar) may NEVER write a retrieval" test for the
// end-to-end (mutation-level) version of this same rejection.

describe("isSelfScholarReference", () => {
  test("true when the viewer IS the scholar and no audience label excludes them", () => {
    expect(isSelfScholarReference({ viewerId: "u1", scholarId: "u1" })).toBe(true);
    expect(isSelfScholarReference({ viewerId: "u1", scholarId: "u1", audience: "scholar" })).toBe(true);
  });

  test("false when a teacher (a different user id) views a scholar's drawer", () => {
    expect(
      isSelfScholarReference({ viewerId: "teacher1", scholarId: "scholar1", audience: "teacher" }),
    ).toBe(false);
  });

  test("false when a parent (a different user id) views a scholar's drawer", () => {
    expect(
      isSelfScholarReference({ viewerId: "parent1", scholarId: "scholar1", audience: "parent" }),
    ).toBe(false);
  });

  test("false for a teacher/parent viewer even when NO audience label was passed (the mislabeled-call-site case)", () => {
    // Regression: components/CellDetailView.tsx (the teacher /teacher/markers
    // surface) renders NodeDrawer with no `audience` prop at all. Gating on
    // `audience === "scholar"` alone would silently pass this teacher through.
    expect(isSelfScholarReference({ viewerId: "teacher1", scholarId: "scholar1" })).toBe(false);
  });

  test("SERVER GUARD shape: rejects a teacher-of-scholar caller even though they'd otherwise pass requireTeacherOrSelf/requireActiveScholarAccess", () => {
    // Mirrors EXACTLY how `convex/instruction.ts`'s `requireScholarSelf` calls
    // this function: `{ viewerId: ctx.user._id, scholarId }`, no `audience`
    // arg at all (a Convex mutation has no client-side redaction label to
    // pass). A teacher who legitimately has access to the scholar (would pass
    // `requireTeacherOrSelf`/`requireActiveScholarAccess`) must still be
    // rejected here — this function is the ONE place "is this the scholar's
    // own sitting" is decided, for both the UI gate and the write gate.
    const teacherId = "teacher_with_full_access_to_scholar1";
    expect(isSelfScholarReference({ viewerId: teacherId, scholarId: "scholar1" })).toBe(false);
  });

  test("false when the viewer or scholarId hasn't resolved yet", () => {
    expect(isSelfScholarReference({ viewerId: undefined, scholarId: "scholar1" })).toBe(false);
    expect(isSelfScholarReference({ viewerId: "u1", scholarId: undefined })).toBe(false);
    expect(isSelfScholarReference({ viewerId: null, scholarId: null })).toBe(false);
  });

  test("false when a scholar-labeled audience is passed but the ids still don't match (defensive)", () => {
    expect(
      isSelfScholarReference({ viewerId: "u1", scholarId: "u2", audience: "scholar" }),
    ).toBe(false);
  });
});
