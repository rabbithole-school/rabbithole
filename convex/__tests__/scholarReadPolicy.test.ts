import { describe, expect, test } from "vitest";
import { isReadOnlyToolName, SCHOLAR_READ_TOOLS } from "../lib/scholarReadPolicy";

// The rule the read-only connector (/api/mcp/read) and the consent page share.
describe("isReadOnlyToolName", () => {
  test("every scholar-read tool reads", () => {
    for (const name of SCHOLAR_READ_TOOLS) expect(isReadOnlyToolName(name)).toBe(true);
  });

  test("get_/list_ tools read", () => {
    expect(isReadOnlyToolName("get_assignment_progress")).toBe(true);
    expect(isReadOnlyToolName("list_units")).toBe(true);
    // A read whose name doesn't say so.
    expect(isReadOnlyToolName("find_candidate_or_family")).toBe(true);
    expect(isReadOnlyToolName("find_staff_account")).toBe(true);
    // The repo-grounding reads, which only GET the GitHub API.
    for (const name of ["search_code", "read_repo_file", "read_system_doc", "recent_changes"]) {
      expect(isReadOnlyToolName(name)).toBe(true);
    }
  });

  test("anything else counts as a change, including unit-designer reads and a get_ tool that writes", () => {
    for (const name of [
      "push_activity_now",
      "delete_scholar",
      "reset_scholar_password",
      "set_assignment_scholars",
      "unit_read_deck",
      // Named like a read, but saves the Mentava level it fetches.
      "get_mentava_progress",
      // Read Drive, but may save a refreshed Google token on the way.
      "read_drive_link",
      "search_drive",
      "getaway",
      "",
    ]) {
      expect(isReadOnlyToolName(name)).toBe(false);
    }
  });
});
