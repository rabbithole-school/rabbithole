/**
 * Keeps the static GitHub path filter synchronized with the maintained source
 * manifest. GitHub Actions cannot read a runtime manifest in `on.pull_request`,
 * so this is the merge-time guard against a silent coverage gap.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

type PromptSourceManifest = {
  schema: string;
  tutorAssemblySources: string[];
  observerAssemblySources: string[];
  observerRuntimeAssemblySources: string[];
  observerEvaluatorSources: string[];
  contractSources: string[];
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");

function readManifest(): PromptSourceManifest {
  return JSON.parse(
    readFileSync(
      join(here, "..", "prompt-source-manifest.json"),
      "utf8",
    ),
  ) as PromptSourceManifest;
}

function workflowPathFilters(workflow: string): string[] {
  const match = workflow.match(
    /pull_request:\n(?: {4}.+\n)*? {4}paths:\n((?: {6}- "[^"]+"\n)+)/,
  );
  if (!match) throw new Error("eval-gates.yml has no pull_request.paths block");
  return [...match[1].matchAll(/ {6}- "([^"]+)"/g)].map((entry) => entry[1]);
}

function uniqueSorted(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

describe("prompt-source manifest", () => {
  const manifest = readManifest();
  const workflow = readFileSync(
    join(repoRoot, ".github", "workflows", "eval-gates.yml"),
    "utf8",
  );

  test("lists existing, unique model-visible sources", () => {
    expect(manifest.schema).toBe("rabbithole.prompt-source-manifest.v1");

    for (const [kind, paths] of Object.entries({
      tutor: manifest.tutorAssemblySources,
      observerCapability: manifest.observerAssemblySources,
      observerRuntime: manifest.observerRuntimeAssemblySources,
      evaluator: manifest.observerEvaluatorSources,
      contract: manifest.contractSources,
    })) {
      expect(paths, `${kind} sources must not be empty`).not.toHaveLength(0);
      expect(
        new Set(paths).size,
        `${kind} sources must not repeat paths`,
      ).toBe(paths.length);
      for (const path of paths) {
        expect(
          () => readFileSync(join(repoRoot, path), "utf8"),
          `${kind} source does not exist: ${path}`,
        ).not.toThrow();
      }
    }
  });

  test("keeps the workflow trigger in exact lockstep with the manifest", () => {
    const expected = uniqueSorted([
      ...manifest.tutorAssemblySources,
      ...manifest.observerAssemblySources,
      ...manifest.observerRuntimeAssemblySources,
      ...manifest.observerEvaluatorSources,
      ...manifest.contractSources,
    ]);
    expect(workflowPathFilters(workflow).sort()).toEqual(expected);
  });

  test("documents why the secret-backed live gate excludes merge groups", () => {
    expect(workflow).not.toMatch(/^\s{2}merge_group:/m);
    expect(workflow).toContain("Intentionally no merge_group trigger");
  });
});
