import { describe, expect, it } from "vitest";
import { mcpToolRoute } from "./toolRoute";
import { LEGACY_GIVE_TOOL_NAMES } from "../../../shared/legacyGiveToolNames";

// The HTTP connector dispatches by name. A client that listed tools before the
// five give verbs folded into `give` may still call an old name; that call must
// reach the Convex dispatcher, which maps it onto `give` (and asks give's
// questions), instead of dying here as "Unknown tool".

const sets = {
  reads: new Set(["get_scholar_mastery"]),
  curriculum: new Set(["give", "list_units"]),
  admissions: new Set<string>(),
  unitDesigner: new Set(["unit_give", "unit_read_unit_structure"]),
};

describe("mcpToolRoute", () => {
  it("routes listed names to their own transport", () => {
    expect(mcpToolRoute("get_scholar_mastery", sets)).toBe("read");
    expect(mcpToolRoute("list_units", sets)).toBe("curriculum");
    expect(mcpToolRoute("unit_read_unit_structure", sets)).toBe("unitDesigner");
  });

  it("sends each cached old give name on to give's dispatcher", () => {
    for (const old of LEGACY_GIVE_TOOL_NAMES) {
      expect(mcpToolRoute(old, sets)).toBe("curriculum");
      expect(mcpToolRoute(`unit_${old}`, sets)).toBe("unitDesigner");
    }
  });

  it("refuses an old name when the caller has no give tool", () => {
    const noGive = { ...sets, curriculum: new Set(["list_units"]), unitDesigner: new Set<string>() };
    expect(mcpToolRoute("push_activity_now", noGive)).toBeNull();
    expect(mcpToolRoute("unit_push_activity_now", noGive)).toBeNull();
  });

  it("still refuses an unknown name", () => {
    expect(mcpToolRoute("not_a_tool", sets)).toBeNull();
  });
});
