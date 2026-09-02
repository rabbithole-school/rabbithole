/**
 * Loads the vendored Learning Commons rubric bundles (see ./rubrics/, licensed
 * CC BY 4.0 — ATTRIBUTION.md) and turns each into a forced-tool schema the
 * tutor-quality judge seam (`runStructuredJudge`) can drive on OUR own models,
 * telemetry-free. Nothing here phones home to learningcommons.org.
 *
 * A rubric bundle upstream is three files: `system.txt` (the graded criterion),
 * `user.txt` (a `{placeholder}` template), and `output_schema.json` (the JSON
 * Schema of the verdict). We resolve that schema's local `$ref`/`$defs` inline
 * so the Anthropic tool API — which does not follow `$ref` — gets a flat,
 * self-contained `input_schema`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeTool } from "../../tutor-quality/lib/judgeEngine";
import type { CoachingDim } from "./types";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUBRICS_DIR = join(HERE, "..", "rubrics");

/** Relative directory (under rubrics/) for each rubric bundle. */
export const RUBRIC_PATHS = {
  manageable: "productive-coaching/manageable",
  "acknowledges-strength": "productive-coaching/acknowledges-strength",
  "grade-level-appropriateness": "grade-level-appropriateness",
} as const;

export type RubricId = keyof typeof RUBRIC_PATHS;

/** The top-level property that carries each rubric's overall score/answer. */
export const RUBRIC_SCORE_KEY: Record<CoachingDim, string> = {
  manageable: "manageable_score",
  "acknowledges-strength": "acknowledges_strength_score",
};

export interface RubricBundle {
  id: RubricId;
  system: string;
  userTemplate: string;
  /** The raw (still-`$ref`'d) output schema, exactly as vendored. */
  outputSchema: Record<string, unknown>;
}

/** Read one vendored bundle's three files from disk. */
export function loadRubricBundle(id: RubricId): RubricBundle {
  const dir = join(RUBRICS_DIR, RUBRIC_PATHS[id]);
  const system = readFileSync(join(dir, "system.txt"), "utf8");
  const userTemplate = readFileSync(join(dir, "user.txt"), "utf8");
  const outputSchema = JSON.parse(
    readFileSync(join(dir, "output_schema.json"), "utf8"),
  ) as Record<string, unknown>;
  return { id, system, userTemplate, outputSchema };
}

// ── JSON-Schema $ref resolution ──────────────────────────────────────────────

function getByPointer(root: unknown, pointer: string): unknown {
  // Local JSON pointer like "#/$defs/KeyFeatures".
  if (!pointer.startsWith("#/")) {
    throw new Error(`unsupported $ref (only local #/ pointers): ${pointer}`);
  }
  let node: unknown = root;
  for (const rawSeg of pointer.slice(2).split("/")) {
    const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (typeof node !== "object" || node === null) {
      throw new Error(`$ref path broke at "${seg}" in ${pointer}`);
    }
    node = (node as Record<string, unknown>)[seg];
    if (node === undefined) throw new Error(`$ref not found: ${pointer}`);
  }
  return node;
}

/**
 * Return a deep clone of `schema` with every local `$ref` replaced by the
 * definition it points at (sibling keys alongside a `$ref`, e.g. `description`,
 * are merged onto the resolved object), and the now-unused `$defs`/`$schema`/
 * `$id` bookkeeping stripped from the root. Guards against runaway recursion.
 */
export function dereferenceSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const root = schema;
  const resolve = (node: unknown, depth: number): unknown => {
    if (depth > 50) throw new Error("dereferenceSchema: max depth exceeded (cycle?)");
    if (Array.isArray(node)) return node.map((n) => resolve(n, depth + 1));
    if (typeof node !== "object" || node === null) return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const target = getByPointer(root, obj.$ref);
      if (typeof target !== "object" || target === null) {
        throw new Error(`$ref target is not an object: ${obj.$ref}`);
      }
      const { $ref, ...siblings } = obj;
      void $ref;
      // Resolve the target, then overlay sibling keys (e.g. a local description).
      const resolvedTarget = resolve(target, depth + 1) as Record<string, unknown>;
      return { ...resolvedTarget, ...resolve(siblings, depth + 1) as Record<string, unknown> };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$defs" || k === "$schema" || k === "$id") continue;
      out[k] = resolve(v, depth + 1);
    }
    return out;
  };
  const result = resolve(root, 0);
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("dereferenceSchema: root did not resolve to an object");
  }
  return result as Record<string, unknown>;
}

/**
 * Build the forced-tool definition for a rubric: the vendored output schema,
 * dereferenced into a flat `input_schema` the Anthropic tool API accepts.
 */
export function buildRubricTool(
  bundle: RubricBundle,
  opts: { name: string; description: string },
): JudgeTool {
  const schema = dereferenceSchema(bundle.outputSchema);
  const props = schema.properties;
  if (schema.type !== "object" || typeof props !== "object" || props === null) {
    throw new Error(`rubric "${bundle.id}" output schema is not an object schema`);
  }
  const required = Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
  return {
    name: opts.name,
    description: opts.description,
    input_schema: {
      type: "object",
      required,
      properties: props as Record<string, unknown>,
    },
  };
}

/**
 * Fill a `{placeholder}` template. `{format_instructions}` (used by the
 * grade-level prompt to inject a formatter) resolves to "" here — the forced
 * tool schema already pins the output shape.
 *
 * The unfilled-placeholder guard runs against the TEMPLATE, before any
 * substitution — never against the assembled output. That matters because the
 * substituted values are real transcript text, which in a math/coding context
 * routinely contains curly-braced runs (LaTeX `\frac{a}{b}`, `\begin{aligned}`,
 * `{cases}`) that would otherwise look like unfilled placeholders and abort a
 * whole live batch. So we only reject a `{token}` that the template itself
 * declares but `vars` (plus `format_instructions`) does not supply.
 */
export function assembleUserText(
  template: string,
  vars: Record<string, string>,
): string {
  const known = new Set([...Object.keys(vars), "format_instructions"]);
  for (const match of template.match(/\{[a-z_]+\}/gi) ?? []) {
    const key = match.slice(1, -1);
    if (!known.has(key)) {
      throw new Error(`assembleUserText: unfilled placeholder: ${match}`);
    }
  }
  let out = template.replace(/\{format_instructions\}/g, "");
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v);
  }
  return out;
}
