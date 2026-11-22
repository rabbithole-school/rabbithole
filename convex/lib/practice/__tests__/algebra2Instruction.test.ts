import { describe, expect, test } from "vitest";
import { verifyInstructionContent } from "../instructionVerify";
import { gradeTryItAtom, nodeInstructionKey, strandInstructionKey } from "../instructionEntries";
import {
  AUTHORED_LAUNCHPADS,
  INSTRUCTION_ANCHOR_STRANDS,
  type SeedInstructionAtom,
  type SeedLaunchpad,
} from "../../../seed/instructionSeed";
import {
  ALGEBRA_2_NODE_LAUNCHPADS,
  ALGEBRA_2_STRAND_LAUNCHPADS,
} from "../../../seed/algebra2Instruction";
import { ALGEBRA_2_DOMAIN, ALGEBRA_2_SKILLS } from "../../../seed/algebra2Graph";
import { parseInstructionManipulative } from "../../../../lib/manipulative/types";
import { validateManipulativeSpec } from "../../../../lib/manipulative/validate";
import { isSolved } from "../../../../lib/manipulative/logic";

// Why this file: the Algebra 2 Launchpads are the first teaching a young
// scholar meets for each strand and for the nodes with a trap. A try_it whose
// own answer grades wrong would tell a child their correct answer is wrong;
// a spec that fails the manipulative gate would put a dead stage on screen.
// These checks pin both, plus the house style the earlier entries keep to.

const ALL_ALG2: SeedLaunchpad[] = [...ALGEBRA_2_STRAND_LAUNCHPADS, ...ALGEBRA_2_NODE_LAUNCHPADS];

function entryKey(lp: SeedLaunchpad): string {
  return lp.nodeKey ? nodeInstructionKey(lp.nodeKey) : strandInstructionKey(lp.domain, lp.strand);
}

type TryIt = Extract<SeedInstructionAtom, { kind: "try_it" }>;
function tryIts(lp: SeedLaunchpad): TryIt[] {
  return lp.atoms.filter((a): a is TryIt => a.kind === "try_it");
}

/** One plausible wrong answer per entry's try_it: the slip the entry warns about. */
const PLAUSIBLE_WRONG: Record<string, string> = {
  "strand:algebra-2:functions": "4",
  "strand:algebra-2:complex-quadratics": "-1",
  "strand:algebra-2:polynomials": "0, -3, 1",
  "strand:algebra-2:rational": "8",
  "strand:algebra-2:radicals-rational-exponents": "12",
  "strand:algebra-2:exponential-logarithmic": "27",
  "strand:algebra-2:sequences-series": "83",
  "node:fn_transform_translate": "-6",
  "node:fn_compose": "19",
  "node:fn_inverse_find": "1/(2x+6)",
  "node:cx_imaginary_unit": "1",
  "node:cx_multiply": "5",
  "node:cx_divide": "10",
  "node:quad_complex_roots": "3, -3",
  "node:poly_zeros_multiplicity": "1",
  "node:poly_long_division": "0",
  "node:poly_synthetic_division": "-6",
  "node:poly_remainder_theorem": "-1",
  "node:rat_simplify": "4",
  "node:rat_add_subtract": "2",
  "node:rat_solve_equation": "2, 0",
  "node:rexp_convert": "5/3",
  "node:rad_rationalize": "14",
  "node:rad_solve_equation": "9",
  "node:log_definition": "12",
  "node:log_rules_expand": "30",
  "node:exp_solve_with_logs": "7/5",
  "node:log_solve_equation": "5",
  "node:seq_recursive": "54",
  "node:series_sigma_notation": "15",
  "node:series_geometric_sum": "1024",
  "node:series_infinite_geometric": "9",
};

/** The node entries the build asked for (a floor, not a ceiling). */
const REQUIRED_NODES = [
  "log_definition",
  "log_rules_expand",
  "exp_solve_with_logs",
  "log_solve_equation",
  "cx_imaginary_unit",
  "cx_multiply",
  "cx_divide",
  "quad_complex_roots",
  "fn_transform_translate",
  "fn_compose",
  "fn_inverse_find",
  "rexp_convert",
  "rad_rationalize",
  "rad_solve_equation",
  "poly_long_division",
  "poly_synthetic_division",
  "poly_remainder_theorem",
  "poly_zeros_multiplicity",
  "rat_simplify",
  "rat_add_subtract",
  "rat_solve_equation",
  "seq_recursive",
  "series_sigma_notation",
  "series_geometric_sum",
  "series_infinite_geometric",
];

/** Every text a scholar reads, labelled by where it renders. */
function texts(lp: SeedLaunchpad): { field: string; text: string; typeset: boolean }[] {
  const out: { field: string; text: string; typeset: boolean }[] = [
    { field: "title", text: lp.title, typeset: false },
  ];
  if (lp.subtitle) out.push({ field: "subtitle", text: lp.subtitle, typeset: false });
  for (const a of lp.atoms) {
    if (a.kind === "story_hook") out.push({ field: "hook", text: a.hook, typeset: false });
    if (a.kind === "micro_explain") out.push({ field: "micro", text: a.text, typeset: false });
    if (a.kind === "worked_example" || a.kind === "try_it") {
      out.push({ field: "label", text: a.strategyLabel, typeset: false });
      // Steps, prompt and answer render through FractionText (typesets spans).
      for (const s of a.steps) out.push({ field: "step", text: s, typeset: true });
      out.push({ field: "prompt", text: a.examplePrompt, typeset: true });
      out.push({ field: "answer", text: a.exampleAnswer, typeset: true });
    }
    if (a.kind === "manipulative") {
      const spec = JSON.parse(a.spec) as { prompt?: string; concept?: string };
      out.push({ field: "manipulative.prompt", text: spec.prompt ?? "", typeset: true });
      out.push({ field: "manipulative.concept", text: spec.concept ?? "", typeset: false });
    }
  }
  return out;
}

/** What a reader sees of a typeset step: spans' LaTeX commands and braces dropped. */
function visibleLength(text: string): number {
  return text
    .replace(/\\\(|\\\)/g, "")
    .replace(/\\[a-zA-Z]+/g, "")
    .replace(/[{}]/g, "").length;
}

/** The LaTeX the stem renderers support (contract §4), plus `\lvert`/`\rvert`. */
const ALLOWED_LATEX = new Set([
  "frac",
  "sqrt",
  "log",
  "ln",
  "cdot",
  "pm",
  "le",
  "ge",
  "ne",
  "infty",
  "sum",
  "left",
  "right",
  "lvert",
  "rvert",
  "pi",
]);

// The entries written before Algebra 2 set the length budget.
const EARLIER = AUTHORED_LAUNCHPADS.filter((lp) => lp.domain !== ALGEBRA_2_DOMAIN);
function maxOf(pick: (a: SeedInstructionAtom) => string | null): number {
  let m = 0;
  for (const lp of EARLIER) for (const a of lp.atoms) m = Math.max(m, pick(a)?.length ?? 0);
  return m;
}
const MAX_HOOK = maxOf((a) => (a.kind === "story_hook" ? a.hook : null));
// One micro_explain may run a little longer than the longest earlier one: a
// node entry names the idea AND its trap. Hold it to 15% over, well inside the
// verifier's 320.
const MAX_MICRO = Math.round(maxOf((a) => (a.kind === "micro_explain" ? a.text : null)) * 1.15);
const MAX_TITLE = Math.max(...EARLIER.map((lp) => lp.title.length));
const MAX_SUBTITLE = Math.max(...EARLIER.map((lp) => (lp.subtitle ?? "").length));
// Earlier steps are plain arithmetic (≤ ~75 chars); an Algebra 2 step carries
// an equation, so the visible budget is 110 characters.
const MAX_VISIBLE_STEP = 110;

describe("Algebra 2 Launchpads — coverage", () => {
  const graphStrands = [...new Set(ALGEBRA_2_SKILLS.map((s) => s.strand))].sort();

  test("every Algebra 2 strand is a registered anchor with a strand doorway", () => {
    const anchored = INSTRUCTION_ANCHOR_STRANDS.filter((a) => a.domain === ALGEBRA_2_DOMAIN)
      .map((a) => a.strand)
      .sort();
    expect(anchored).toEqual(graphStrands);
    const doorways = ALGEBRA_2_STRAND_LAUNCHPADS.filter((lp) => !lp.nodeKey)
      .map((lp) => lp.strand)
      .sort();
    expect(doorways).toEqual(graphStrands);
  });

  test("the Algebra 2 entries are in the seeded set", () => {
    const seeded = new Set(AUTHORED_LAUNCHPADS.map(entryKey));
    for (const lp of ALL_ALG2) expect(seeded.has(entryKey(lp)), entryKey(lp)).toBe(true);
  });

  test("every required node has a node-grain entry on its real strand", () => {
    const byKey = new Map(ALGEBRA_2_SKILLS.map((s) => [s.skillKey, s]));
    for (const lp of ALGEBRA_2_NODE_LAUNCHPADS) {
      expect(lp.nodeKey, lp.title).toBeTruthy();
      const skill = byKey.get(lp.nodeKey!);
      expect(skill, `${lp.nodeKey} is not an Algebra 2 node`).toBeDefined();
      expect(lp.strand, lp.nodeKey).toBe(skill!.strand);
      expect(lp.domain).toBe(ALGEBRA_2_DOMAIN);
    }
    const covered = new Set(ALGEBRA_2_NODE_LAUNCHPADS.map((lp) => lp.nodeKey));
    expect(REQUIRED_NODES.filter((k) => !covered.has(k))).toEqual([]);
  });

  test("no two authored entries share a stored key", () => {
    const keys = AUTHORED_LAUNCHPADS.map(entryKey);
    expect(keys.length).toBe(new Set(keys).size);
  });
});

describe("Algebra 2 Launchpads — each entry", () => {
  for (const lp of ALL_ALG2) {
    const key = entryKey(lp);

    test(`${key} passes the verifier`, () => {
      const r = verifyInstructionContent({ title: lp.title, subtitle: lp.subtitle, atoms: lp.atoms });
      expect(r.status, r.report).toBe("passed");
    });

    test(`${key} has the doorway shape`, () => {
      const kinds = lp.atoms.map((a) => a.kind);
      if (lp.nodeKey) {
        // The idea, one worked example, then the scholar's turn.
        expect(kinds).toEqual(["micro_explain", "worked_example", "try_it"]);
      } else {
        expect(kinds[0]).toBe("story_hook");
        expect(kinds[1]).toBe("micro_explain");
        expect(kinds.slice(-2)).toEqual(["worked_example", "try_it"]);
      }
      for (const a of lp.atoms) {
        if (a.kind === "worked_example" || a.kind === "try_it") {
          expect(a.steps.length, `${key} ${a.kind} steps`).toBeGreaterThanOrEqual(3);
          expect(a.steps.length, `${key} ${a.kind} steps`).toBeLessThanOrEqual(5);
        }
      }
    });

    test(`${key} try_it grades its own answer right and a slip wrong`, () => {
      const its = tryIts(lp);
      expect(its).toHaveLength(1);
      const atom = its[0];
      expect(gradeTryItAtom(atom.exampleAnswer, atom), `${key} own answer`).toBe(true);
      const wrong = PLAUSIBLE_WRONG[key];
      expect(wrong, `${key} needs a plausible wrong answer`).toBeDefined();
      expect(gradeTryItAtom(wrong, atom), `${key} wrong answer "${wrong}"`).toBe(false);
    });

    test(`${key} keeps to the house length and style`, () => {
      expect(lp.title.length).toBeLessThanOrEqual(MAX_TITLE + 8);
      if (lp.subtitle) expect(lp.subtitle.length).toBeLessThanOrEqual(MAX_SUBTITLE);
      for (const { field, text, typeset } of texts(lp)) {
        const at = `${key} ${field}: "${text}"`;
        expect(text.trim().length, at).toBeGreaterThan(0);
        expect(text, at).not.toMatch(/undefined|NaN|null|\[object/);
        expect(text, at).not.toContain("!");
        if (field === "hook") expect(text.length, at).toBeLessThanOrEqual(MAX_HOOK);
        if (field === "micro") expect(text.length, at).toBeLessThanOrEqual(MAX_MICRO);
        if (field === "step") expect(visibleLength(text), at).toBeLessThanOrEqual(MAX_VISIBLE_STEP);

        // Hooks and explanations render as plain text: a span would show raw.
        if (!typeset) expect(text, at).not.toMatch(/\\\(|\\\[/);
        // Spans are balanced and use only the LaTeX the renderers support.
        const opens = (text.match(/\\\(/g) ?? []).length;
        const closes = (text.match(/\\\)/g) ?? []).length;
        expect(opens, at).toBe(closes);
        for (const span of text.match(/\\\((.*?)\\\)/g) ?? []) {
          for (const cmd of span.slice(2, -2).match(/\\[a-zA-Z]+/g) ?? []) {
            expect(ALLOWED_LATEX.has(cmd.slice(1)), `${at} uses ${cmd}`).toBe(true);
          }
        }
      }
    });
  }
});

describe("Algebra 2 Launchpads — manipulatives", () => {
  const manipulatives = ALL_ALG2.flatMap((lp) =>
    lp.atoms
      .filter((a): a is Extract<SeedInstructionAtom, { kind: "manipulative" }> => a.kind === "manipulative")
      .map((a) => ({ key: entryKey(lp), spec: a.spec })),
  );

  test("the strands that teach by dragging a graph carry one", () => {
    const withManip = new Set(manipulatives.map((m) => m.key));
    for (const strand of ["functions", "polynomials", "rational", "complex-quadratics"]) {
      expect(withManip.has(strandInstructionKey(ALGEBRA_2_DOMAIN, strand)), strand).toBe(true);
    }
  });

  for (const { key, spec } of manipulatives) {
    test(`${key} spec passes the manipulative validator and starts unsolved`, () => {
      const parsed = parseInstructionManipulative(spec);
      expect(parsed?.mode).toBe("single");
      const result = validateManipulativeSpec(JSON.parse(spec));
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (parsed?.mode !== "single") return;
      // Gradable goal present, so "you did it" can fire — and not on mount.
      expect("goal" in parsed.spec && parsed.spec.goal != null).toBe(true);
    });
  }

  test("the quarter-turn target really is i(2 + i)", () => {
    const m = manipulatives.find((x) => x.key === strandInstructionKey(ALGEBRA_2_DOMAIN, "complex-quadratics"));
    const spec = JSON.parse(m!.spec) as {
      fixedPoints: { x: number; y: number }[];
      goal: { x: number; y: number };
      draggable: { start: { x: number; y: number } }[];
    };
    const [{ x: a, y: b }] = spec.fixedPoints;
    // i(a + bi) = −b + ai
    expect(spec.goal).toMatchObject({ x: -b, y: a });
    expect(isSolved(JSON.parse(m!.spec), { points: [{ x: -b, y: a }] } as never)).toBe(true);
  });
});
