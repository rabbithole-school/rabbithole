import { describe, expect, test } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import { makeScholarReadTools, matchScholarByName } from "../scholarReadTools";
import { ROLES } from "../roles";

/**
 * The role → scholar-read-tool gating is the security boundary that keeps
 * scholar records (roster, mastery, and the assessment-bearing documents)
 * out of the wrong aide. makeScholarReadTools only touches ctx inside each
 * tool's run() closure, never at build time, so we can build the toolset
 * with a stub ctx and assert which tool NAMES each role gets.
 */
const ctx = {} as unknown as ActionCtx;
const emit = () => {};
const names = async (role: Parameters<typeof makeScholarReadTools>[2]) =>
  (await makeScholarReadTools(ctx, emit, role)).map((t) => t.name).sort();

// Base `staff` has no standing scholar-record authority by role alone — the
// caller must additionally prove an active school:operations capability
// grant (this is the retired registrar role's successor: staff +
// school:operations). Pure-policy callers pass that proof explicitly.
const namesWithOps = async (role: Parameters<typeof makeScholarReadTools>[2]) =>
  (
    await makeScholarReadTools(ctx, emit, role, undefined, "", undefined, undefined, true)
  ).map((t) => t.name).sort();

describe("makeScholarReadTools role gating", () => {
  test("curriculum_designer gets NO scholar tools", async () => {
    expect(await names(ROLES.CURRICULUM_DESIGNER)).toEqual([]);
  });

  test("base staff (no capability grant) gets NO scholar tools", async () => {
    expect(await names(ROLES.STAFF)).toEqual([]);
  });

  test("staff WITH the school:operations grant (the retired registrar role's successor) gets only the non-sensitive roster lookup", async () => {
    expect(await namesWithOps(ROLES.STAFF)).toEqual(["list_scholars"]);
  });

  test("parent gets only tier-1 tools (no roster, dossier, or documents)", async () => {
    const got = await names(ROLES.PARENT);
    expect(got).toEqual(
      [
        "get_scholar_mastery",
        "get_scholar_signals",
        "get_scholar_seeds",
        "get_scholar_practice",
        "get_school_calendar",
      ].sort(),
    );
    expect(got).not.toContain("list_scholars");
    expect(got).not.toContain("get_scholar_documents");
  });

  test("teacher and admin get the full set including documents", async () => {
    const teacher = await names(ROLES.TEACHER);
    expect(teacher).toContain("list_scholars");
    expect(teacher).toContain("get_scholar_documents");
    expect(teacher).toContain("get_scholar_dossier");
    expect(await names(ROLES.PLATFORM_ADMIN)).toEqual(teacher);
  });

  test("unknown/undefined role fails CLOSED (no tools)", async () => {
    // Since the policy moved to lib/scholarReadPolicy (shared with the
    // OAuth MCP connector), a missing role gets NOTHING. Every real call
    // site passes the caller's role from their user doc; if that's ever
    // absent, an empty toolset is the safe failure.
    expect(await names(undefined)).toEqual([]);
    expect(await names(null)).toEqual([]);
  });
});

// matchScholarByName is the shared strict name matcher used for scholars AND
// scholar groups (assign_unit's groupName path). The exact-preferred /
// ambiguity-refusing discipline is what stops a partial name from silently
// targeting the wrong person or cohort.
describe("matchScholarByName", () => {
  const rows = [
    { name: "Navy Seals" },
    { name: "Seals" },
    { name: "Geckos" },
  ];

  test("prefers an exact (case-insensitive) match over a longer substring", () => {
    // "Seals" is a substring of "Navy Seals", which sorts first — a loose
    // first-substring-wins match would pick the WRONG cohort here.
    const m = matchScholarByName("seals", rows);
    expect(m.kind).toBe("match");
    if (m.kind === "match") expect(m.scholar.name).toBe("Seals");
  });

  test("refuses (ambiguous) when a partial matches multiple", () => {
    const m = matchScholarByName("eck", rows);
    expect(m.kind).toBe("match"); // only "Geckos" contains "eck"
    const m2 = matchScholarByName("s", [
      { name: "Seals" },
      { name: "Sharks" },
    ]);
    expect(m2.kind).toBe("ambiguous");
    if (m2.kind === "ambiguous")
      expect(m2.candidates.map((c) => c.name).sort()).toEqual([
        "Seals",
        "Sharks",
      ]);
  });

  test("returns none for no match or empty query", () => {
    expect(matchScholarByName("Otters", rows).kind).toBe("none");
    expect(matchScholarByName("   ", rows).kind).toBe("none");
  });
});
