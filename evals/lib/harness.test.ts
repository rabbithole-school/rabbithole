import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildLeaderboard,
  buildScenarioSections,
  fmt,
  markdownTable,
  mean,
  parseEvalArgs,
  runPool,
  writeRunArtifacts,
} from "./harness";

describe("parseEvalArgs", () => {
  const spec = {
    scenarios: { default: undefined as string | undefined },
    trials: { default: 4, parse: (value: string) => parseInt(value, 10) },
    verbose: { default: false, boolean: true },
    only: { default: undefined as string | undefined, valueWhenMissing: "true" },
  };

  it("parses declared values and silently ignores unknown flags", () => {
    expect(
      parseEvalArgs(spec, [
        "--trials",
        "7",
        "--verbose",
        "--unknown",
        "value",
        "--scenarios",
        "one,two",
      ]),
    ).toEqual({
      scenarios: "one,two",
      trials: 7,
      verbose: true,
      only: undefined,
    });
  });

  it("supports each runner's missing-value behavior", () => {
    expect(parseEvalArgs(spec, ["--only", "--verbose"])).toMatchObject({
      only: "true",
      verbose: true,
    });
  });

  it("can preserve runners that accept option-looking values", () => {
    expect(
      parseEvalArgs(
        { out: { default: "out", allowOptionLikeValue: true } },
        ["--out", "--verbose"],
      ),
    ).toEqual({ out: "--verbose" });
  });
});

describe("runPool", () => {
  it("bounds concurrency and preserves input order", async () => {
    let active = 0;
    let peak = 0;
    const results = await runPool(
      [3, 1, 2, 0],
      async (value) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, value));
        active--;
        return value * 2;
      },
      { concurrency: 2 },
    );

    expect(results).toEqual([6, 2, 4, 0]);
    expect(peak).toBe(2);
  });
});

describe("artifact and report helpers", () => {
  it("preserves JSON formatting and report bytes", () => {
    const outDir = mkdtempSync(join(tmpdir(), "eval-harness-"));
    try {
      writeRunArtifacts({
        outDir,
        runs: [{ id: "case" }],
        judgments: [{ score: 4 }],
        report: "# Report\n",
        additionalFiles: { "transcripts.md": "# Transcript" },
      });

      expect(readFileSync(join(outDir, "runs.json"), "utf8")).toBe(
        '[\n  {\n    "id": "case"\n  }\n]',
      );
      expect(readFileSync(join(outDir, "judgments.json"), "utf8")).toBe(
        '[\n  {\n    "score": 4\n  }\n]',
      );
      expect(readFileSync(join(outDir, "report.md"), "utf8")).toBe("# Report\n");
      expect(readFileSync(join(outDir, "transcripts.md"), "utf8")).toBe(
        "# Transcript",
      );

      writeRunArtifacts({
        outDir,
        runsFile: "results.json",
        runs: { score: 1 },
      });
      expect(readFileSync(join(outDir, "results.json"), "utf8")).toBe(
        '{\n  "score": 1\n}',
      );

      writeRunArtifacts({
        outDir,
        runs: { score: 2 },
        report: "# First",
        artifactOrder: ["report", "runs"],
      });
      expect(readFileSync(join(outDir, "report.md"), "utf8")).toBe("# First");
    } finally {
      rmSync(outDir, { recursive: true });
    }
  });

  it("builds reusable report structures", () => {
    expect(mean([2, 4])).toBe(3);
    expect(fmt(Number.NaN, 2, "n/a")).toBe("n/a");
    expect(markdownTable(["A", "B"], [[1, 2]])).toBe(
      "| A | B |\n|---|---|\n| 1 | 2 |",
    );
    expect(
      buildScenarioSections(
        [
          { id: "a", value: 1 },
          { id: "a", value: 2 },
          { id: "b", value: 3 },
        ],
        (item) => item.id,
        (id, items) => `${id}:${items.length}`,
        "|",
      ),
    ).toBe("a:2|b:1");
    expect(
      buildLeaderboard(
        [{ name: "first", score: 5 }],
        [
          { header: "Name", cell: (entry) => entry.name },
          { header: "Score", cell: (entry) => entry.score },
        ],
      ),
    ).toBe("| Rank | Name | Score |\n|---|---|---|\n| 1 | first | 5 |");
  });
});
