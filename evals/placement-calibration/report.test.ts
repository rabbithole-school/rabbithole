import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { loadDomainMeta, runCell, type RunMetrics } from "./harness";
import { buildGrid, summarize, DOMAINS } from "./grid";
import { renderReport } from "./report";

const modules = (import.meta as ImportMeta & {
  glob: (p: string) => Record<string, () => Promise<unknown>>;
}).glob("../../convex/**/*.ts");

/**
 * FULL-GRID report generator. Skipped in the normal suite (keeps `pnpm test`
 * fast + unaffected); run explicitly to (re)generate CALIBRATION_REPORT.md:
 *
 *   PLACEMENT_CALIBRATION_FULL=1 npx vitest run evals/placement-calibration/report.test.ts
 */
describe.skipIf(!process.env.PLACEMENT_CALIBRATION_FULL)("placement calibration — full report", () => {
  test(
    "run the grid and write CALIBRATION_REPORT.md",
    async () => {
      const grid = buildGrid();
      const runs: RunMetrics[] = [];
      const started = Date.now();
      // Fresh convex-test instance PER DOMAIN: reusing one instance across all
      // ~770 runs makes the tail slow (per-run cost grows with accumulated rows).
      // Re-seeding the graph per domain bounds each instance to one domain's cells.
      for (const domain of DOMAINS) {
        const t = convexTest(schema, modules);
        await t.mutation(internal.practiceSkills.seedGraph, {});
        const meta = await loadDomainMeta(t, domain);
        for (const cell of grid.filter((c) => c.domain === domain)) {
          runs.push(await runCell(t, meta, cell));
        }
      }
      const elapsedS = ((Date.now() - started) / 1000).toFixed(1);

      const summaries = summarize(runs);
      const md = renderReport(runs, summaries);
      const outPath = path.join(__dirname, "CALIBRATION_REPORT.md");
      fs.writeFileSync(outPath, md);

      console.log(`[calibration] ${runs.length} runs in ${elapsedS}s → ${outPath}`);
      expect(runs.length).toBe(grid.length);
      expect(summaries.length).toBeGreaterThan(0);
    },
    900_000,
  );
});
