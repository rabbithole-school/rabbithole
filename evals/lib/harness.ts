import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface EvalArgDefinition<T> {
  default: T;
  flag?: string;
  parse?: (value: string) => T;
  boolean?: boolean;
  allowOptionLikeValue?: boolean;
  valueWhenMissing?: string;
}

type ParsedEvalArgs<S extends Record<string, EvalArgDefinition<unknown>>> = {
  [K in keyof S]: S[K] extends EvalArgDefinition<infer T> ? T : never;
};

export function parseEvalArgs<const S extends Record<string, EvalArgDefinition<unknown>>>(
  spec: S,
  argv: readonly string[] = process.argv.slice(2),
): ParsedEvalArgs<S> {
  const parsed = {} as Record<keyof S, unknown>;

  for (const key of Object.keys(spec) as Array<keyof S>) {
    const definition = spec[key];
    const flag = `--${definition.flag ?? String(key)}`;
    const index = argv.indexOf(flag);

    if (definition.boolean) {
      parsed[key] = index === -1 ? definition.default : true;
      continue;
    }
    if (index === -1) {
      parsed[key] = definition.default;
      continue;
    }

    const next = argv[index + 1];
    const hasValue =
      Boolean(next) &&
      (definition.allowOptionLikeValue === true || !next.startsWith("--"));
    const raw = hasValue ? next : definition.valueWhenMissing;
    parsed[key] =
      raw === undefined
        ? definition.default
        : definition.parse
          ? definition.parse(raw)
          : raw;
  }

  return parsed as ParsedEvalArgs<S>;
}

export async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T, index: number) => Promise<R>,
  { concurrency }: { concurrency: number },
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  );
  return results;
}

export interface RunArtifacts {
  outDir: string;
  runs: unknown;
  judgments?: unknown;
  report?: string;
  runsFile?: string;
  judgmentsFile?: string;
  reportFile?: string;
  additionalFiles?: Readonly<Record<string, string>>;
  ensureOutDir?: boolean;
  artifactOrder?: readonly ArtifactKind[];
}

type ArtifactKind = "runs" | "judgments" | "report" | "additionalFiles";

export function writeRunArtifacts({
  outDir,
  runs,
  judgments,
  report,
  runsFile = "runs.json",
  judgmentsFile = "judgments.json",
  reportFile = "report.md",
  additionalFiles = {},
  ensureOutDir = true,
  artifactOrder = ["runs", "judgments", "report", "additionalFiles"],
}: RunArtifacts): void {
  if (ensureOutDir) mkdirSync(outDir, { recursive: true });
  for (const artifact of artifactOrder) {
    if (artifact === "runs") {
      writeFileSync(join(outDir, runsFile), JSON.stringify(runs, null, 2));
    } else if (artifact === "judgments" && judgments !== undefined) {
      writeFileSync(join(outDir, judgmentsFile), JSON.stringify(judgments, null, 2));
    } else if (artifact === "report" && report !== undefined) {
      writeFileSync(join(outDir, reportFile), report);
    } else if (artifact === "additionalFiles") {
      for (const [filename, contents] of Object.entries(additionalFiles)) {
        writeFileSync(join(outDir, filename), contents);
      }
    }
  }
}

export function mean(values: readonly number[], emptyValue = 0): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : emptyValue;
}

export function fmt(
  value: number,
  digits = 2,
  nonFinite?: string,
): string {
  return nonFinite !== undefined && !Number.isFinite(value)
    ? nonFinite
    : value.toFixed(digits);
}

type MarkdownCell = string | number;

export function markdownTable(
  headers: readonly MarkdownCell[],
  rows: readonly (readonly MarkdownCell[])[],
): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

export function groupByScenario<T>(
  items: readonly T[],
  scenarioId: (item: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const id = scenarioId(item);
    const group = grouped.get(id) ?? [];
    group.push(item);
    grouped.set(id, group);
  }
  return grouped;
}

export function buildScenarioSections<T>(
  items: readonly T[],
  scenarioId: (item: T) => string,
  render: (id: string, items: T[]) => string,
  separator = "\n",
): string {
  return Array.from(groupByScenario(items, scenarioId), ([id, grouped]) =>
    render(id, grouped),
  ).join(separator);
}

export interface LeaderboardColumn<T> {
  header: MarkdownCell;
  cell: (entry: T, index: number) => MarkdownCell;
}

export function buildLeaderboard<T>(
  entries: readonly T[],
  columns: readonly LeaderboardColumn<T>[],
  rankHeader: MarkdownCell = "Rank",
): string {
  return markdownTable(
    [rankHeader, ...columns.map((column) => column.header)],
    entries.map((entry, index) => [
      index + 1,
      ...columns.map((column) => column.cell(entry, index)),
    ]),
  );
}
