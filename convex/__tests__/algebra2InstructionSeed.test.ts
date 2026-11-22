import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import { nodeInstructionKey, strandInstructionKey } from "../lib/practice/instructionEntries";
import { ALGEBRA_2_DOMAIN } from "../seed/algebra2Graph";
import { ALGEBRA_2_NODE_LAUNCHPADS } from "../seed/algebra2Instruction";

// Why this file: authored NODE-grain entries ride the same seed as the strand
// doorways (`nodeKey` on a SeedLaunchpad → `storeLaunchpad` keys the row
// `node:<nodeKey>`). Prove the real seed mutation stores them under that key,
// passed, alongside the Algebra 2 strand rows, with no anchor left uncovered.

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

test("seedAuthoredInstruction stores Algebra 2 strand and node-grain rows, all passed", async () => {
  const t = convexTest(schema, modules);
  const report = await t.mutation(internal.instruction.seedAuthoredInstruction, {});
  expect(report.failed).toEqual([]);
  expect(report.missingAnchors).toEqual([]);

  const rows = await t.run(async (ctx) => await ctx.db.query("instructionContent").collect());
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const strandRow = byKey.get(strandInstructionKey(ALGEBRA_2_DOMAIN, "exponential-logarithmic"));
  expect(strandRow?.verifyStatus).toBe("passed");

  for (const lp of ALGEBRA_2_NODE_LAUNCHPADS) {
    const row = byKey.get(nodeInstructionKey(lp.nodeKey!));
    expect(row, lp.nodeKey).toBeDefined();
    expect(row!.verifyStatus, lp.nodeKey).toBe("passed");
    expect(row!.domain).toBe(ALGEBRA_2_DOMAIN);
    expect(row!.strand).toBe(lp.strand);
  }

  // A node entry never overwrote its strand's doorway.
  const logStrand = byKey.get(strandInstructionKey(ALGEBRA_2_DOMAIN, "exponential-logarithmic"));
  expect(logStrand?.title).not.toBe(ALGEBRA_2_NODE_LAUNCHPADS.find((lp) => lp.nodeKey === "log_definition")?.title);
});
