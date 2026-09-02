import { describe, expect, test } from "vitest";
import {
  SCHOLAR_READ_TOOLS,
  allowedScholarReadTools,
  isScholarReadToolAllowed,
} from "../scholarReadPolicy";
import { ROLES } from "../roles";

// This table is the shared ACL for BOTH the in-app aide streams and the
// OAuth MCP connector. Pinning it keeps a casual edit from silently
// widening what a parent/operations-staff/designer agent can read. (Operations
// staff — base `staff` + the `school:operations` capability grant — is the
// retired `registrar` role's successor.)

describe("scholarReadPolicy", () => {
  test("teacher and admin get the full set", () => {
    expect(allowedScholarReadTools(ROLES.TEACHER)).toEqual(SCHOLAR_READ_TOOLS);
    expect(allowedScholarReadTools(ROLES.PLATFORM_ADMIN)).toEqual(SCHOLAR_READ_TOOLS);
  });

  test("curriculum_designer gets nothing (privacy wall)", () => {
    expect(allowedScholarReadTools(ROLES.CURRICULUM_DESIGNER)).toEqual([]);
  });

  test("base staff is default-deny; an explicit operations proof grants only the redacted roster", () => {
    expect(allowedScholarReadTools(ROLES.STAFF)).toEqual([]);
    expect(
      allowedScholarReadTools(ROLES.STAFF, {
        hasSchoolOperationsAccess: true,
      }),
    ).toEqual(["list_scholars"]);
    for (const tool of SCHOLAR_READ_TOOLS) {
      expect(
        isScholarReadToolAllowed(ROLES.STAFF, tool, {
          hasSchoolOperationsAccess: true,
        }),
      ).toBe(tool === "list_scholars");
    }
  });

  test("parent and scholar get exactly tier-1 (mastery/signals/seeds/practice + the public school calendar)", () => {
    const tier1 = [
      "get_scholar_mastery",
      "get_scholar_signals",
      "get_scholar_seeds",
      "get_scholar_practice",
      // Not a scholar measurement — the school's public closure calendar,
      // institution-scoped via the named scholar.
      "get_school_calendar",
    ];
    expect(allowedScholarReadTools(ROLES.PARENT)).toEqual(tier1);
    expect(allowedScholarReadTools(ROLES.SCHOLAR)).toEqual(tier1);
  });

  test("parents NEVER get tier-2 (dossier/observations/documents/sessions/transcript/web-activity/roster)", () => {
    for (const tool of [
      "list_scholars",
      "get_scholar_dossier",
      "get_scholar_observations",
      "get_scholar_sessions",
      "get_session_transcript",
      "get_scholar_web_activity",
      "get_scholar_documents",
    ] as const) {
      expect(isScholarReadToolAllowed(ROLES.PARENT, tool)).toBe(false);
      expect(isScholarReadToolAllowed(ROLES.SCHOLAR, tool)).toBe(false);
    }
  });

  test("unknown/missing roles fail CLOSED", () => {
    expect(allowedScholarReadTools(undefined)).toEqual([]);
    expect(allowedScholarReadTools(null)).toEqual([]);
  });
});
