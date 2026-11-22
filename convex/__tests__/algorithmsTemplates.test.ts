/**
 * discrete-math, algorithms strand: the deterministic templates in
 * convex/lib/practice/algorithms/.
 *
 * The math checks never reuse the generators' arithmetic. A code listing is
 * translated to JavaScript and run, counting the calls to step(). Worded items
 * are re-derived by brute force: a search is simulated, a table is classified
 * from its rows, and a growth class is found by measuring how fast each term
 * grows.
 */
import { describe, expect, test } from "vitest";
import { formatAnswer } from "../lib/practice/answers";
import { gradeTemplateItem, makeItemId } from "../lib/practice/session";
import { generateItem, hasTemplate, type PracticeItem } from "../lib/practice/templates";
import { DISCRETE_MATH_EDGES, DISCRETE_MATH_SKILLS } from "../seed/discreteMathGraph";
import { WHOLE_NUMBER_ARITHMETIC_SKILLS } from "../seed/wholeNumberArithmeticGraph";
import { gradeRank } from "../lib/practice/placement";
import { splitStemBlocks } from "../../shared/practiceStemBlocks";

const SKILLS = DISCRETE_MATH_SKILLS.filter((s) => s.strand === "algorithms");
const KEYS = SKILLS.map((s) => s.skillKey);
const MULTIPLE_CHOICE = ["algo_growth_from_table", "algo_big_o_name", "algo_rank_growth", "algo_big_o_from_code"];
const SEEDS = Array.from({ length: 240 }, (_, i) => i + 1);

function itemFor(key: string, seed: number): PracticeItem {
  const item = generateItem(key, seed);
  if (!item) throw new Error(`no template for ${key}`);
  return item;
}

function submission(item: PracticeItem): string {
  return item.answer.type === "multipleChoice" ? String(item.answer.choiceIndex) : formatAnswer(item.answer);
}

function intAnswer(item: PracticeItem): number {
  if (item.answer.type !== "integer") throw new Error(`not an integer answer: ${item.stem}`);
  return item.answer.value;
}

function chosen(item: PracticeItem): string {
  if (item.answer.type !== "multipleChoice" || !item.choices) throw new Error(`not multiple choice: ${item.stem}`);
  return item.choices[item.answer.choiceIndex];
}

function listing(item: PracticeItem): string[] | null {
  const block = splitStemBlocks(item.stem).find((b) => b.kind === "code");
  return block && block.kind === "code" ? block.lines : null;
}

function question(item: PracticeItem): string {
  return splitStemBlocks(item.stem)
    .filter((b) => b.kind === "text")
    .map((b) => (b.kind === "text" ? b.text : ""))
    .join(" ")
    .trim();
}

const num = (s: string) => Number(s.replace(/,/g, ""));

// ── A Python-subset runner ──────────────────────────────────────────────────

function expr(py: string): string {
  return py
    .replace(/len\((\w+)\)/g, "$1.length")
    .replace(/(\([^()]*\)|\w+) \/\/ (\w+)/g, "Math.floor($1 / $2)");
}

/** Translate a listing to JavaScript, run it, and return how many times it
 *  called step(). `env` supplies names the listing reads but never sets. */
function runListing(lines: readonly string[], env: Record<string, number> = {}): number {
  const out: string[] = [];
  const declared = new Set<string>(Object.keys(env));
  let depth = 0;
  let inFunction = -1;
  for (const raw of lines) {
    const indent = (raw.length - raw.trimStart().length) / 4;
    const line = raw.trim();
    expect(Number.isInteger(indent), `indent of "${raw}"`).toBe(true);
    while (depth > indent) {
      out.push("}");
      depth -= 1;
      if (depth <= inFunction) inFunction = -1;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^for (\w+) in range\((.*)\):$/))) {
      const args = m[2].split(",").map((a) => expr(a.trim()));
      const [from, to, by] = args.length === 1 ? ["0", args[0], "1"] : args.length === 2 ? [args[0], args[1], "1"] : args;
      out.push(`for (let ${m[1]} = ${from}; ${m[1]} < ${to}; ${m[1]} += ${by}) {`);
      depth += 1;
    } else if ((m = line.match(/^for (\w+) in (\w+):$/))) {
      out.push(`for (const ${m[1]} of ${m[2]}) {`);
      depth += 1;
    } else if ((m = line.match(/^(while|if) (.*):$/))) {
      out.push(`${m[1]} (${expr(m[2])}) {`);
      depth += 1;
    } else if (line === "else:") {
      out.push("else {");
      depth += 1;
    } else if ((m = line.match(/^def (\w+)\((\w+)\):$/))) {
      out.push(`function ${m[1]}(${m[2]}) {`);
      inFunction = depth;
      depth += 1;
    } else if (line === "return" || line === "break") {
      out.push(`${line};`);
    } else if ((m = line.match(/^(\w+) = (.*)$/))) {
      const first = !declared.has(m[1]) && inFunction < 0;
      declared.add(m[1]);
      out.push(`${first ? "let " : ""}${m[1]} = ${expr(m[2])};`);
    } else {
      expect(line, `unsupported line "${line}"`).toMatch(/^\w+\(.*\)$/);
      out.push(`${expr(line)};`);
    }
  }
  while (depth-- > 0) out.push("}");
  let calls = 0;
  const step = () => {
    calls += 1;
    if (calls > 5_000_000) throw new Error("runaway listing");
  };
  const names = Object.keys(env);
  const body = `${names.map((n) => `let ${n} = __env.${n};`).join("")}\n${out.join("\n")}`;
  new Function("step", "__env", body)(step, env);
  return calls;
}

// ── Growth measured, not looked up ──────────────────────────────────────────

/** How fast a count grows: its value at a large n over its value at a smaller
 *  one. A coefficient cancels, so this orders terms by growth alone. */
function growthOf(f: (n: number) => number): number {
  return f(1000) / f(500) > 1e100 ? Infinity : f(2 ** 40) / f(2 ** 20);
}

/** A count written as LaTeX or as a plain label, as a function of n. */
function countFn(text: string): (n: number) => number {
  const js = text
    .replace(/\\cdot|·/g, "*")
    .replace(/\\log_\{2\} n|log₂ n/g, "L")
    .replace(/2\^\{n\}|2ⁿ/g, "E")
    .replace(/n\^\{(\d)\}/g, "(n**$1)")
    .replace(/n²/g, "(n**2)")
    .replace(/\s+/g, "")
    .replace(/(\d|n|\))(?=[nLE(])/g, "$1*");
  expect(js, text).toMatch(/^[\dnLE+*()]+$/);
  const fn = new Function("n", "L", "E", `return ${js};`) as (n: number, L: number, E: number) => number;
  return (n) => fn(n, Math.log2(n), 2 ** n);
}

const CLASS_BY_GROWTH: [string, (n: number) => number][] = [
  ["O(1)", () => 1],
  ["O(log n)", (n) => Math.log2(n)],
  ["O(n)", (n) => n],
  ["O(n log n)", (n) => n * Math.log2(n)],
  ["O(n²)", (n) => n * n],
  ["O(2ⁿ)", (n) => 2 ** n],
];

function classOfGrowth(growth: number): string {
  const hit = CLASS_BY_GROWTH.find(([, g]) => {
    const ref = growthOf(g);
    return ref === growth || Math.abs(growth - ref) <= 0.02 * ref;
  });
  if (!hit) throw new Error(`no class grows by ${growth}`);
  return hit[0];
}

function spans(stem: string): string[] {
  return [...stem.matchAll(/\\\((.*?)\\\)/g)].map((m) => m[1]);
}

// ── The suite ───────────────────────────────────────────────────────────────

describe("algorithms strand — graph", () => {
  test("13 skills, entered at grade 6, with every edge grade-forward", () => {
    expect(KEYS).toHaveLength(13);
    expect(new Set(KEYS).size).toBe(13);
    const grade = new Map(
      [...DISCRETE_MATH_SKILLS, ...WHOLE_NUMBER_ARITHMETIC_SKILLS].map((s) => [s.skillKey, s.grade]),
    );
    const into = DISCRETE_MATH_EDGES.filter((e) => KEYS.includes(e.toKey));
    expect(into).toHaveLength(19);
    for (const e of into) {
      expect(grade.has(e.fromKey), e.fromKey).toBe(true);
      expect(gradeRank(grade.get(e.fromKey)!), `${e.fromKey} -> ${e.toKey}`).toBeLessThanOrEqual(gradeRank(grade.get(e.toKey)!));
    }
    // No algorithms node gates anything outside the strand.
    expect(DISCRETE_MATH_EDGES.filter((e) => KEYS.includes(e.fromKey) && !KEYS.includes(e.toKey))).toEqual([]);
    // One entrance that needs nothing, at grade 6.
    const roots = KEYS.filter((k) => !into.some((e) => e.toKey === k));
    expect(roots).toEqual(["algo_count_loop"]);
    expect(grade.get("algo_count_loop")).toBe("6");
  });

  test("the strand adds no source domain: its one foreign prerequisite is in whole-number-arithmetic", () => {
    // A cross-domain edge gates the whole domain on the source domain's
    // placement, so an algebra-2 or early-algebra edge here would hide all of
    // discrete-math behind that course.
    const local = new Set(DISCRETE_MATH_SKILLS.map((s) => s.skillKey));
    const wna = new Set(WHOLE_NUMBER_ARITHMETIC_SKILLS.map((s) => s.skillKey));
    const foreign = DISCRETE_MATH_EDGES.filter((e) => !local.has(e.fromKey));
    for (const e of foreign) expect(wna.has(e.fromKey), `${e.fromKey} -> ${e.toKey}`).toBe(true);
    expect(foreign.filter((e) => KEYS.includes(e.toKey))).toEqual([{ fromKey: "exponents_repeated_mult", toKey: "algo_halving_loop" }]);
  });
});

describe("algorithms strand — every family", () => {
  test.each(KEYS)("%s is deterministic, varied, and graded by its own answer", (key) => {
    expect(hasTemplate(key)).toBe(true);
    const distinct = new Set<string>();
    for (const seed of SEEDS) {
      const item = itemFor(key, seed);
      expect(generateItem(key, seed)).toEqual(item);
      distinct.add(`${item.stem}¦${JSON.stringify(item.choices ?? null)}`);
      expect(gradeTemplateItem(makeItemId(key, seed), submission(item))?.correct, item.stem).toBe(true);
      expect(item.promptVisual).toBeUndefined();
      if (item.answer.type === "integer") {
        expect(Number.isInteger(item.answer.value) && item.answer.value >= 0, item.stem).toBe(true);
        expect(gradeTemplateItem(makeItemId(key, seed), String(item.answer.value + 1))?.correct, item.stem).toBe(false);
      }
    }
    expect(distinct.size, `${key} made ${distinct.size} distinct items`).toBeGreaterThanOrEqual(12);
  });

  test("answer types: typed whole numbers, one expression family, four classifications", () => {
    for (const key of KEYS) {
      for (const seed of SEEDS.slice(0, 80)) {
        const item = itemFor(key, seed);
        const expected = MULTIPLE_CHOICE.includes(key) ? "multipleChoice" : key === "algo_count_expression" ? "expression" : "integer";
        expect(item.answerType, `${key} seed=${seed}`).toBe(expected);
        if (expected === "multipleChoice") {
          expect(item.choices!.length).toBeGreaterThanOrEqual(3);
          expect(item.choices!.length).toBeLessThanOrEqual(4);
          expect(new Set(item.choices).size).toBe(item.choices!.length);
        }
      }
    }
  });

  test("an expression answer can be typed on the sequence pad, and equal forms are accepted", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_count_expression", seed);
      expect(item.answerPalette).toBe("sequence");
      expect(formatAnswer(item.answer)).toMatch(/^[0-9n+\-*/^()]+$/);
    }
    const triangular = SEEDS.map((seed) => ({ seed, item: itemFor("algo_count_expression", seed) })).find(
      ({ item }) => formatAnswer(item.answer) === "n(n-1)/2",
    )!;
    const id = makeItemId("algo_count_expression", triangular.seed);
    expect(gradeTemplateItem(id, "(n^2-n)/2")?.correct).toBe(true);
    expect(gradeTemplateItem(id, "n^2/2-n/2")?.correct).toBe(true);
    expect(gradeTemplateItem(id, "n(n+1)/2")?.correct).toBe(false);
    expect(gradeTemplateItem(id, "n^2")?.correct).toBe(false);
  });

  test("most items carry worked steps, and a listing never uses a caret or **", () => {
    for (const key of KEYS) {
      let withSteps = 0;
      for (const seed of SEEDS.slice(0, 120)) {
        const item = itemFor(key, seed);
        if ((item.workedSteps?.length ?? 0) > 0) withSteps += 1;
        for (const line of listing(item) ?? []) {
          expect(line, item.stem).not.toMatch(/\^|\*\*|\t/);
          expect(line.length, line).toBeLessThanOrEqual(48);
        }
        expect(item.stem).not.toMatch(/undefined|NaN|Infinity/);
        for (const w of item.workedSteps ?? []) expect(w.text).not.toMatch(/undefined|NaN|Infinity/);
      }
      expect(withSteps, key).toBe(120);
    }
  });
});

describe("algorithms strand — the listing, run, gives the answer", () => {
  test("every 'how many times does step() run' item", () => {
    let ran = 0;
    for (const key of KEYS) {
      for (const seed of SEEDS) {
        const item = itemFor(key, seed);
        const lines = listing(item);
        if (!lines) continue;
        const q = question(item);
        const at = q.match(/^When n = ([\d,]+), how many times does step\(\) run\?$/);
        if (q === "How many times does step() run?") expect(runListing(lines), item.stem).toBe(intAnswer(item));
        else if (at) expect(runListing(lines, { n: num(at[1]) }), item.stem).toBe(intAnswer(item));
        else continue;
        ran += 1;
      }
    }
    expect(ran).toBeGreaterThan(600);
  });

  test("algo_count_expression: the expression equals the count at several sizes", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_count_expression", seed);
      const answer = formatAnswer(item.answer)
        .replace(/\^/g, "**")
        .replace(/(\d|n|\))(?=[n(])/g, "$1*");
      const f = new Function("n", `return ${answer};`) as (n: number) => number;
      for (const n of [10, 13, 24]) expect(runListing(listing(item)!, { n }), `${item.stem} at n=${n}`).toBe(f(n));
    }
  });

  test("algo_double_input: both sizes are run", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_double_input", seed);
      const lines = listing(item)!;
      const q = question(item);
      const sizes = q.match(/^When n = (\d+), step\(\) runs ([\d,]+) times\. How many times does it run when n = (\d+)\?$/);
      if (sizes) {
        expect(runListing(lines, { n: Number(sizes[1]) }), item.stem).toBe(num(sizes[2]));
        expect(runListing(lines, { n: Number(sizes[3]) }), item.stem).toBe(intAnswer(item));
        expect([2, 3]).toContain(Number(sizes[3]) / Number(sizes[1]));
      } else {
        const times = /doubles/.test(q) ? 2 : /triples/.test(q) ? 3 : NaN;
        expect(runListing(lines, { n: 7 * times }) / runListing(lines, { n: 7 }), item.stem).toBe(intAnswer(item));
      }
    }
  });

  test("algo_halving_loop: the start value asked for really takes that many passes", () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const item = itemFor("algo_halving_loop", seed);
      const m = question(item).match(/step\(\) runs (\d+) times\. What number did n start as\?$/);
      if (!m) continue;
      const n = intAnswer(item);
      expect(runListing(listing(item)!, { n })).toBe(Number(m[1]));
      expect(Number.isInteger(Math.log2(n))).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("algo_big_o_from_code: the class is the one the measured counts follow", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const item = itemFor("algo_big_o_from_code", seed);
      const lines = listing(item)!;
      let measured: string;
      if (lines[0].startsWith("def ")) {
        const at = (n: number) => runListing([...lines, `f(${n})`]);
        expect(at(11) / at(10)).toBe(2);
        expect(at(7) / at(6)).toBe(2);
        measured = "O(2ⁿ)";
      } else {
        const [a, b, c] = [256, 512, 1024].map((n) => runListing(lines, { n }));
        const ratio = c / b;
        if (a === b && b === c) measured = "O(1)";
        else if (c - b === b - a && ratio < 1.5) measured = "O(log n)";
        else if (ratio > 1.95 && ratio < 2.05) measured = "O(n)";
        else if (ratio > 2.15 && ratio < 2.3) measured = "O(n log n)";
        else if (ratio > 3.9 && ratio < 4.1) measured = "O(n²)";
        else throw new Error(`unclassified growth ${a}, ${b}, ${c} for ${item.stem}`);
      }
      expect(chosen(item), item.stem).toBe(measured);
      seen.add(measured);
    }
    expect([...seen].sort()).toEqual(["O(1)", "O(2ⁿ)", "O(log n)", "O(n log n)", "O(n)", "O(n²)"]);
  });
});

describe("algorithms strand — worded items, re-derived", () => {
  test("algo_linear_search_steps", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_linear_search_steps", seed);
      if (listing(item)) continue;
      const n = Number(item.stem.match(/(?:The list has|a list of) (\d+) (?:items|names)/)![1]);
      const checksFor = (position: number | null) => {
        let checks = 0;
        for (let i = 1; i <= n; i++) {
          checks += 1;
          if (i === position) break;
        }
        return checks;
      };
      let expected: number;
      const after = item.stem.match(/and (\d+) of them come after the target/);
      const second = item.stem.match(/a second list of (\d+) names/);
      if (after) expected = checksFor(n - Number(after[1]));
      else if (/the first one/.test(item.stem)) expected = checksFor(1);
      else if (second) {
        let checks = checksFor(null);
        for (let i = 1; i <= Number(second[1]); i++) checks += 1;
        expected = checks;
      } else {
        expect(item.stem).toMatch(/On average/);
        let total = 0;
        for (let p = 1; p <= n; p++) total += checksFor(p);
        expected = total / n;
      }
      expect(intAnswer(item), item.stem).toBe(expected);
    }
  });

  test("algo_binary_search_steps", () => {
    /** The most checks over every target, present or absent, on n sorted items. */
    const worst = (n: number) => {
      let most = 0;
      // Targets 2i+1 are the items; even numbers fall in the gaps.
      for (let target = 0; target <= 2 * n; target += Math.max(1, Math.floor(n / 4000))) {
        let lo = 0;
        let hi = n - 1;
        let checks = 0;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          checks += 1;
          const value = 2 * mid + 1;
          if (value === target) break;
          if (value < target) lo = mid + 1;
          else hi = mid - 1;
        }
        most = Math.max(most, checks);
      }
      return most;
    };
    for (const seed of SEEDS) {
      const item = itemFor("algo_binary_search_steps", seed);
      if (listing(item)) continue;
      const most = item.stem.match(/sorted list of ([\d,]+) items, what is the most checks/);
      const fewer = item.stem.match(/sorted list of ([\d,]+) items, how many fewer checks/);
      const left = item.stem.match(/has ([\d,]+) items\. After (\d+) checks/);
      if (most) expect(intAnswer(item), item.stem).toBe(worst(num(most[1])));
      else if (fewer) expect(intAnswer(item), item.stem).toBe(num(fewer[1]) - worst(num(fewer[1])));
      else {
        let size = num(left![1]);
        for (let i = 0; i < Number(left![2]); i++) size /= 2;
        expect(intAnswer(item), item.stem).toBe(size);
      }
    }
  });

  test("algo_growth_from_table: the rows show the growth named", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const item = itemFor("algo_growth_from_table", seed);
      const table = splitStemBlocks(item.stem).find((b) => b.kind === "table");
      if (!table || table.kind !== "table") throw new Error(`no table: ${item.stem}`);
      expect(table.header).toEqual(["n", "steps"]);
      const rows = table.rows.map((row) => row.map(Number));
      const pairs = rows.slice(1).map((row, i) => ({ dn: row[0] - rows[i][0], rn: row[0] / rows[i][0], ds: row[1] - rows[i][1], rs: row[1] / rows[i][1] }));
      const all = (f: (p: (typeof pairs)[number]) => boolean) => pairs.every(f);
      let kind: string;
      if (all((p) => p.ds === 0)) kind = "Constant";
      else if (all((p) => p.dn === 1) && all((p) => p.rs === 2)) kind = "Exponential";
      else if (all((p) => p.dn === 1) && all((p) => p.ds === pairs[0].ds)) kind = "Linear";
      else if (all((p) => p.rn === 2) && all((p) => p.rs === 2)) kind = "Linear";
      else if (all((p) => p.rn === 2) && all((p) => p.rs === 4)) kind = "Quadratic";
      else if (all((p) => p.rn === 2) && all((p) => p.ds === pairs[0].ds)) kind = "Logarithmic";
      else throw new Error(`unclassified table: ${item.stem}`);
      expect(chosen(item), item.stem).toBe(kind);
      seen.add(kind);
    }
    expect(seen.size).toBe(5);
  });

  test("algo_big_o_name: the class of the fastest-growing term", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_big_o_name", seed);
      const terms = spans(item.stem)[0].split(" + ");
      const fastest = Math.max(...terms.map((t) => growthOf(countFn(t))));
      expect(chosen(item), item.stem).toBe(classOfGrowth(fastest));
      // Every option is one of the six classes, so none is a second right answer.
      for (const c of item.choices!) expect(CLASS_BY_GROWTH.map(([label]) => label)).toContain(c);
    }
  });

  test("algo_rank_growth: ordered by measured growth", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_rank_growth", seed);
      const growth = (label: string) => growthOf(countFn(label));
      if (/Which list/.test(item.stem)) {
        const order = chosen(item).split(", ").map(growth);
        expect(order, item.stem).toEqual([...order].sort((a, b) => a - b));
        expect(new Set(order).size).toBe(3);
      } else {
        const all = item.choices!.map(growth);
        expect(new Set(all).size).toBe(all.length);
        const want = /the most steps/.test(item.stem) ? Math.max(...all) : Math.min(...all);
        expect(growth(chosen(item)), item.stem).toBe(want);
      }
    }
  });

  test("algo_exponential_blowup", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_exponential_blowup", seed);
      if (listing(item)) continue;
      const answer = intAnswer(item);
      const s = item.stem;
      let m: RegExpMatchArray | null;
      if ((m = s.match(/One run took ([\d,]+) steps/))) expect(2 ** answer, s).toBe(num(m[1]));
      else if ((m = s.match(/With (\d+) items it takes ([\d,]+) steps.*with (\d+) items/))) {
        let count = num(m[2]);
        for (let i = Number(m[1]); i < Number(m[3]); i++) count *= 2;
        expect(answer, s).toBe(count);
      } else if ((m = s.match(/time for ([\d,]+) steps/))) {
        expect(2 ** answer, s).toBeLessThanOrEqual(num(m[1]));
        expect(2 ** (answer + 1), s).toBeGreaterThan(num(m[1]));
      } else {
        m = s.match(/size (\d+) takes 1 second.*size (\d+) take/);
        expect(answer, s).toBe(2 ** Number(m![2]) / 2 ** Number(m![1]));
      }
    }
  });

  test("algo_growth_crossover", () => {
    for (const seed of SEEDS) {
      const item = itemFor("algo_growth_crossover", seed);
      const answer = intAnswer(item);
      const s = item.stem;
      const [texA, texB] = spans(s);
      const poly = (t: string) => {
        const js = t.replace(/2\^\{n\}/g, "(2**n)").replace(/n\^\{(\d)\}/g, "(n**$1)").replace(/\s+/g, "").replace(/(\d)(?=[n(])/g, "$1*");
        return new Function("n", `return ${js};`) as (n: number) => number;
      };
      const [A, B] = [poly(texA), poly(texB)];
      let m: RegExpMatchArray | null;
      if (/take the same number of steps/.test(s)) {
        expect(answer).toBeGreaterThan(0);
        expect(A(answer), s).toBe(B(answer));
        // The only positive crossing: they differ at every other size up to 10× it.
        for (let n = 1; n <= answer * 10; n++) if (n !== answer) expect(A(n) === B(n), `${s} at ${n}`).toBe(false);
      } else if (/smallest whole number/.test(s)) {
        let n = 1;
        while (!(B(n) > A(n))) n += 1;
        expect(answer, s).toBe(n);
        for (let k = n; k < n + 30; k++) expect(B(k) > A(k)).toBe(true);
      } else if ((m = s.match(/At n = ([\d,]+), B takes how many times/))) {
        expect(answer, s).toBe(B(num(m[1])) / A(num(m[1])));
      } else {
        expect(s).toMatch(/For how many whole-number input sizes/);
        let count = 0;
        for (let n = 1; n <= 5000; n++) if (B(n) < A(n)) count += 1;
        expect(answer, s).toBe(count);
      }
    }
  });
});
