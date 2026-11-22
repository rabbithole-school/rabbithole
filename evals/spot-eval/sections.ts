/**
 * Prompt assembly for the spot-eval runner (`run.ts`), kept free of side
 * effects so it can be unit-tested without git or an API key.
 *
 * By default an arm is "the base prompt with this revision's Guidelines block".
 * A scholar script may add per-arm `sections` overrides (TRA-498) so a change
 * to a section assembled OUTSIDE the Guidelines block — `buildPreReaderSection`,
 * `buildEarlyReaderSection`, … — can be A/B-ed on the same rung:
 *
 *   "arms": {
 *     "old": { "sections": [{ "name": "preReader", "file": "…/old.txt" }] },
 *     "new": { "sections": [{ "name": "preReader", "builder": "buildPreReaderSection" }] }
 *   }
 *
 * A section named `guidelines` replaces that arm's git-derived Guidelines
 * block. Any other name is appended after the base prompt, in the order given.
 */

/** Where one named section's text comes from. Exactly one source is allowed. */
export interface SectionOverride {
  /** `guidelines` replaces the Guidelines block; any other name is appended. */
  name: string;
  /** The section text, inline. */
  text?: string;
  /** A file holding the section text (path relative to the working directory). */
  file?: string;
  /** An exported string-returning function of `convex/prompts.ts`. */
  builder?: string;
  /** Arguments passed to `builder`. */
  args?: unknown[];
}

export interface ArmOverrides {
  sections?: SectionOverride[];
}

export interface ArmsConfig {
  old?: ArmOverrides;
  new?: ArmOverrides;
}

export interface ResolvedArm {
  guidelines: string;
  /** Appended sections, in order, already resolved to text. */
  sections: Array<{ name: string; text: string }>;
}

export interface SectionDeps {
  readFile: (path: string) => string;
  /** The `convex/prompts.ts` module namespace. */
  builders: Record<string, unknown>;
}

export const GUIDELINES_SECTION = "guidelines";

export function extractGuidelines(promptsTs: string): string {
  // The Guidelines block runs from "Guidelines:" to the line right before "${startBullet}"
  const m = promptsTs.match(/Guidelines:\n([\s\S]*?)\n\$\{startBullet\}/);
  if (!m) throw new Error("Could not locate Guidelines block in prompts.ts");
  return "Guidelines:\n" + m[1];
}

export function resolveSectionText(
  override: SectionOverride,
  deps: SectionDeps,
): string {
  const label = `section "${override.name}"`;
  const sources = [override.text, override.file, override.builder].filter(
    (s) => s !== undefined,
  );
  if (sources.length !== 1) {
    throw new Error(`${label}: give exactly one of text, file, builder`);
  }
  if (override.args !== undefined && override.builder === undefined) {
    throw new Error(`${label}: args only apply to a builder`);
  }
  if (override.text !== undefined) return override.text;
  if (override.file !== undefined) return deps.readFile(override.file);

  const fn = deps.builders[override.builder!];
  if (typeof fn !== "function") {
    throw new Error(
      `${label}: convex/prompts.ts has no exported function "${override.builder}"`,
    );
  }
  const out: unknown = fn(...(override.args ?? []));
  if (typeof out !== "string") {
    throw new Error(`${label}: ${override.builder}() did not return a string`);
  }
  return out;
}

/** Apply one arm's overrides on top of its git-derived Guidelines block. */
export function resolveArm(
  baseGuidelines: string,
  overrides: ArmOverrides | undefined,
  deps: SectionDeps,
): ResolvedArm {
  let guidelines = baseGuidelines;
  const sections: ResolvedArm["sections"] = [];
  const seen = new Set<string>();
  for (const override of overrides?.sections ?? []) {
    if (!override.name?.trim()) throw new Error("A section override needs a name");
    if (seen.has(override.name)) {
      throw new Error(`section "${override.name}" is listed twice in one arm`);
    }
    seen.add(override.name);
    const text = resolveSectionText(override, deps);
    if (override.name === GUIDELINES_SECTION) guidelines = text;
    else sections.push({ name: override.name, text });
  }
  return { guidelines, sections };
}

/** The appended sections, each separated from what precedes it by a blank line. */
export function renderAppendedSections(arm: ResolvedArm): string {
  return arm.sections
    .map((s) => `\n\n${s.text.replace(/^\n+/, "")}`)
    .join("");
}

export function armsIdentical(a: ResolvedArm, b: ResolvedArm): boolean {
  return (
    a.guidelines === b.guidelines &&
    renderAppendedSections(a) === renderAppendedSections(b)
  );
}

/** One line per arm for the report, e.g. `guidelines (HEAD~1) + preReader`. */
export function describeArm(
  arm: ResolvedArm,
  overrides: ArmOverrides | undefined,
  gitLabel: string,
): string {
  const guidelinesOverridden = (overrides?.sections ?? []).some(
    (s) => s.name === GUIDELINES_SECTION,
  );
  return [
    `guidelines (${guidelinesOverridden ? "override" : gitLabel})`,
    ...arm.sections.map((s) => s.name),
  ].join(" + ");
}
