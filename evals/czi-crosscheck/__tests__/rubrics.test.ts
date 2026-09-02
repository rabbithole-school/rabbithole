/**
 * Offline guards for the vendored Learning Commons rubric bundles. No API, no
 * network — safe to run in CI (`pnpm test`). Three invariants:
 *
 *   1. Every vendored file matches the sha256 pinned in MANIFEST.json, so an
 *      accidental edit to a "faithful copy" fails the build (the CC BY 4.0
 *      attribution promises these are verbatim — see ATTRIBUTION.md).
 *   2. Each rubric's output schema dereferences to a flat, $ref-free object
 *      schema the Anthropic tool API can accept (it does not follow $ref).
 *   3. Placeholder assembly fills every slot and refuses to leave a `{token}`.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  RUBRICS_DIR,
  RUBRIC_PATHS,
  RUBRIC_SCORE_KEY,
  assembleUserText,
  buildRubricTool,
  dereferenceSchema,
  loadRubricBundle,
  type RubricId,
} from "../lib/rubrics";

interface Manifest {
  upstreamCommit: string;
  files: Record<string, { sha256: string; upstream: string }>;
}

const manifest = JSON.parse(
  readFileSync(join(RUBRICS_DIR, "MANIFEST.json"), "utf8"),
) as Manifest;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Recursively assert no `$ref` / `$defs` survive in a schema tree. */
function assertNoRefs(node: unknown, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertNoRefs(n, `${path}[${i}]`));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  for (const [k, v] of Object.entries(node)) {
    expect(k, `unexpected "${k}" at ${path}`).not.toBe("$ref");
    expect(k, `unexpected "${k}" at ${path}`).not.toBe("$defs");
    assertNoRefs(v, `${path}.${k}`);
  }
}

describe("vendored rubric drift guard (sha256 ⟷ MANIFEST)", () => {
  test("manifest is non-empty and pins an upstream commit", () => {
    expect(manifest.upstreamCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(manifest.files).length).toBeGreaterThanOrEqual(9);
  });

  for (const [rel, entry] of Object.entries(manifest.files)) {
    test(`${rel} matches its pinned sha256`, () => {
      expect(sha256(join(RUBRICS_DIR, rel)), `${rel} drifted from its vendored copy`).toBe(
        entry.sha256,
      );
    });
  }
});

describe("rubric bundles build Anthropic-safe forced tools", () => {
  const ids = Object.keys(RUBRIC_PATHS) as RubricId[];

  for (const id of ids) {
    test(`${id}: loads three files and dereferences to a flat object schema`, () => {
      const bundle = loadRubricBundle(id);
      expect(bundle.system.length).toBeGreaterThan(50);
      expect(bundle.userTemplate.length).toBeGreaterThan(0);

      const tool = buildRubricTool(bundle, { name: `t_${id}`, description: "d" });
      expect(tool.input_schema.type).toBe("object");
      expect(Object.keys(tool.input_schema.properties).length).toBeGreaterThan(0);
      assertNoRefs(tool.input_schema);
    });
  }

  test("coaching tools expose their overall 0/1 score property", () => {
    for (const dim of ["manageable", "acknowledges-strength"] as const) {
      const tool = buildRubricTool(loadRubricBundle(dim), { name: "t", description: "d" });
      const scoreKey = RUBRIC_SCORE_KEY[dim];
      expect(
        tool.input_schema.properties[scoreKey],
        `${dim} tool missing ${scoreKey}`,
      ).toBeDefined();
      expect(tool.input_schema.required).toContain(scoreKey);
    }
  });

  test("grade-level tool exposes an enum'd grade band", () => {
    const tool = buildRubricTool(loadRubricBundle("grade-level-appropriateness"), {
      name: "t",
      description: "d",
    });
    const grade = tool.input_schema.properties.grade as { enum?: unknown[] };
    expect(grade.enum).toContain("6-8");
    expect(tool.input_schema.required).toContain("grade");
  });

  test("nested key_features deref keeps the four manageable sub-features", () => {
    const schema = dereferenceSchema(loadRubricBundle("manageable").outputSchema);
    const kf = (schema.properties as Record<string, { properties?: Record<string, unknown> }>)
      .key_features;
    expect(Object.keys(kf.properties ?? {})).toEqual([
      "length",
      "number_of_distinct_issues",
      "clear_priority",
      "student_knows_next_step",
    ]);
  });
});

describe("assembleUserText", () => {
  test("fills coaching placeholders", () => {
    const bundle = loadRubricBundle("manageable");
    const out = assembleUserText(bundle.userTemplate, {
      student_text: "STU",
      feedback_text: "FB",
    });
    expect(out).toContain("STU");
    expect(out).toContain("FB");
    expect(out).not.toMatch(/\{[a-z_]+\}/i);
  });

  test("strips {format_instructions} and fills {text} for grade-level", () => {
    const bundle = loadRubricBundle("grade-level-appropriateness");
    const out = assembleUserText(bundle.userTemplate, { text: "THE TUTOR TURN" });
    expect(out).toContain("THE TUTOR TURN");
    expect(out).not.toContain("{format_instructions}");
    expect(out).not.toMatch(/\{[a-z_]+\}/i);
  });

  test("throws on an unfilled placeholder", () => {
    expect(() => assembleUserText("Analyze {student_text} and {missing}", { student_text: "x" })).toThrow(
      /unfilled placeholder/,
    );
  });

  test("does NOT trip on curly-braced transcript content (LaTeX / code)", () => {
    // Finding #1: the guard must scan the TEMPLATE, not the substituted output,
    // so a real math transcript with \frac{a}{b} / \begin{aligned} / {cases}
    // never aborts a live batch.
    const latex = "The area is \\frac{1}{2} b h. \\begin{aligned} x &= 3 \\end{aligned} {cases}";
    const bundle = loadRubricBundle("grade-level-appropriateness");
    expect(() => assembleUserText(bundle.userTemplate, { text: latex })).not.toThrow();
    const coaching = loadRubricBundle("manageable");
    expect(() =>
      assembleUserText(coaching.userTemplate, { student_text: latex, feedback_text: "{foo}" }),
    ).not.toThrow();
  });
});
