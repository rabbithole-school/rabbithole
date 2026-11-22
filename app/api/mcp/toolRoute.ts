import { isLegacyGiveToolName } from "../../../shared/legacyGiveToolNames";

/** The tool names each transport offers this caller (from its own list). */
export type McpToolSets = {
  reads: ReadonlySet<string>;
  curriculum: ReadonlySet<string>;
  /** Absent in the public foundation build, which has no admissions tools. */
  admissions?: ReadonlySet<string>;
  unitDesigner: ReadonlySet<string>;
};

export type McpToolRoute = "read" | "curriculum" | "admissions" | "unitDesigner";

/**
 * Which transport handles a `tools/call` for `name`, or null for an unknown
 * tool.
 *
 * A listed name goes to its own transport. An unlisted old give verb (one of
 * the five folded into `give`) goes to the transport that offers `give`, whose
 * Convex dispatcher maps it onto `give`. Compatibility for long-lived MCP
 * clients that cached the old tool list; remove after 2026-12-01.
 */
export function mcpToolRoute(name: string, sets: McpToolSets): McpToolRoute | null {
  if (sets.reads.has(name)) return "read";
  if (sets.curriculum.has(name)) return "curriculum";
  if (sets.admissions?.has(name)) return "admissions";
  if (sets.unitDesigner.has(name)) return "unitDesigner";
  if (isLegacyGiveToolName(name) && sets.curriculum.has("give")) {
    return "curriculum";
  }
  if (
    name.startsWith("unit_") &&
    isLegacyGiveToolName(name.slice("unit_".length)) &&
    sets.unitDesigner.has("unit_give")
  ) {
    return "unitDesigner";
  }
  return null;
}
