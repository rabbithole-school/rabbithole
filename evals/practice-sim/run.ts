import {
  SCENARIOS,
  type PracticeDomain,
  type SimulationMetrics,
  compareScenarios,
  runSimulation,
} from "./sim";

type Args = {
  days: number;
  scholars: number;
  seed: number;
  domain: PracticeDomain;
  scenario: keyof typeof SCENARIOS;
  compare?: [keyof typeof SCENARIOS, keyof typeof SCENARIOS];
};

const DEFAULTS: Args = {
  days: 28,
  scholars: 20,
  seed: 7,
  domain: "whole-number-arithmetic",
  scenario: "baseline",
};

function parseArgs(argv: string[]): Args {
  const out: Args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--days" && next) {
      out.days = Number(next);
      i++;
    } else if (arg === "--scholars" && next) {
      out.scholars = Number(next);
      i++;
    } else if (arg === "--seed" && next) {
      out.seed = Number(next);
      i++;
    } else if (arg === "--domain" && next) {
      out.domain = parseDomain(next);
      i++;
    } else if (arg === "--scenario" && next) {
      out.scenario = parseScenario(next);
      i++;
    } else if (arg === "--compare") {
      if (next && !next.startsWith("--")) {
        out.compare = parseCompare(next);
        i++;
      } else {
        out.compare = ["baseline", "phase1"];
      }
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.days) || out.days < 1) throw new Error("--days must be a positive number");
  if (!Number.isFinite(out.scholars) || out.scholars < 1) throw new Error("--scholars must be a positive number");
  if (!Number.isFinite(out.seed)) throw new Error("--seed must be a number");
  return out;
}

function parseDomain(value: string): PracticeDomain {
  if (
    value === "whole-number-arithmetic" ||
    value === "fraction-arithmetic" ||
    value === "probability"
  ) {
    return value;
  }
  throw new Error(`Unknown domain "${value}"`);
}

function parseScenario(value: string): keyof typeof SCENARIOS {
  if (value in SCENARIOS) return value as keyof typeof SCENARIOS;
  throw new Error(`Unknown scenario "${value}". Options: ${Object.keys(SCENARIOS).join(", ")}`);
}

function parseCompare(value: string): [keyof typeof SCENARIOS, keyof typeof SCENARIOS] {
  const [base = "baseline", candidate = "banded"] = value.split(",");
  return [parseScenario(base), parseScenario(candidate)];
}

function printHelp(): void {
  console.log(`Practice-engine simulated-scholar harness

Usage:
  npx tsx evals/practice-sim/run.ts --days 28 --scholars 20 --seed 7 --domain whole-number-arithmetic
  npx tsx evals/practice-sim/run.ts --compare baseline,phase1

Flags:
  --days <n>          simulated days (default 28)
  --scholars <n>      simulated scholars (default 20)
  --seed <n>          seeded PRNG seed (default 7)
  --domain <slug>     whole-number-arithmetic | fraction-arithmetic | probability
  --scenario <name>   ${Object.keys(SCENARIOS).join(" | ")}
  --compare [a,b]     run two scenarios and print deltas (default baseline,phase1)
`);
}

function printMetrics(metrics: SimulationMetrics): void {
  console.log(renderSummaryTable(metrics));
  console.log("");
  console.log(renderDailyTable(metrics));
  console.log("");
  console.log(renderCalibrationTable(metrics));
  console.log("");
  console.log("METRICS_JSON " + JSON.stringify(metrics));
}

function renderSummaryTable(metrics: SimulationMetrics): string {
  const rows = [
    ["scenario", metrics.scenario],
    ["domain", metrics.domain],
    ["days", String(metrics.days)],
    ["scholars", String(metrics.scholars)],
    ["total items", String(metrics.totalItems)],
    ["off-band item rate", pct(metrics.offBandItemRate)],
    ["review share", pct(metrics.reviewShareOverall)],
    ["review success", pct(metrics.reviewSuccessRate)],
    ["avg time-to-frontier", metrics.timeToFrontierDays.average === null ? "n/a" : `${metrics.timeToFrontierDays.average}d`],
    ["lane counts", Object.entries(metrics.itemsServedPerLane).map(([k, v]) => `${k}:${v}`).join(" ")],
  ];
  return markdownTable(["metric", "value"], rows);
}

function renderDailyTable(metrics: SimulationMetrics): string {
  return markdownTable(
    ["day", "served", "reviews", "review share"],
    metrics.reviewShareByDay.map((row) => [
      String(row.day),
      String(row.served),
      String(row.reviewItems),
      pct(row.reviewShare),
    ]),
  );
}

function renderCalibrationTable(metrics: SimulationMetrics): string {
  return markdownTable(
    ["engine R bucket", "n", "avg predicted", "actual success"],
    metrics.calibration.map((row) => [
      row.bucket,
      String(row.attempts),
      row.attempts === 0 ? "n/a" : pct(row.predictedAvg),
      row.attempts === 0 ? "n/a" : pct(row.successRate),
    ]),
  );
}

function printCompare(args: Args): void {
  const [baseScenario, candidateScenario] = args.compare ?? ["baseline", "phase1"];
  const result = compareScenarios(
    {
      days: args.days,
      scholars: args.scholars,
      seed: args.seed,
      domain: args.domain,
    },
    baseScenario,
    candidateScenario,
  );
  console.log(`Comparing ${baseScenario} -> ${candidateScenario}`);
  console.log("");
  console.log(markdownTable(
    ["metric", baseScenario, candidateScenario, "delta"],
    [
      ["total items", String(result.base.totalItems), String(result.candidate.totalItems), String(result.deltas.totalItems)],
      ["off-band item rate", pct(result.base.offBandItemRate), pct(result.candidate.offBandItemRate), signedPct(result.deltas.offBandItemRate)],
      ["review share", pct(result.base.reviewShareOverall), pct(result.candidate.reviewShareOverall), signedPct(result.deltas.reviewShareOverall)],
      ["review success", pct(result.base.reviewSuccessRate), pct(result.candidate.reviewSuccessRate), signedPct(result.deltas.reviewSuccessRate)],
      [
        "avg time-to-frontier",
        result.base.timeToFrontierDays.average === null ? "n/a" : `${result.base.timeToFrontierDays.average}d`,
        result.candidate.timeToFrontierDays.average === null ? "n/a" : `${result.candidate.timeToFrontierDays.average}d`,
        result.deltas.averageTimeToFrontierDays === null ? "n/a" : `${signed(result.deltas.averageTimeToFrontierDays)}d`,
      ],
    ],
  ));
  console.log("");
  console.log("COMPARE_JSON " + JSON.stringify(result));
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPct(value: number | null): string {
  return value === null ? "n/a" : `${signed(value * 100)}pp`;
}

function signed(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
}

const args = parseArgs(process.argv.slice(2));
if (args.compare) {
  printCompare(args);
} else {
  printMetrics(runSimulation(args));
}
