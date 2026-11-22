/**
 * Algorithms strand, second half: how a step count grows, and big-O.
 *
 * Naming a growth class is a true classification, so those four families are
 * multiple choice. Exponential blow-up and crossover points are typed whole
 * numbers, found by doubling and by trying sizes, so they need no Algebra 2.
 *
 * The six classes, slowest-growing first, are the only ones this strand names:
 * O(1), O(log n), O(n), O(n log n), O(n²), O(2ⁿ).
 */
import type { Algebra2Kit, Rng, Template } from "../templates";
import { tex } from "../algebra2/format";
import { codeStem, commas, step } from "./code";

type GrowthClass = "const" | "log" | "linear" | "nlogn" | "quadratic" | "exponential";

/** Slowest-growing first. */
const ORDER: readonly GrowthClass[] = ["const", "log", "linear", "nlogn", "quadratic", "exponential"];

const BIG_O: Record<GrowthClass, string> = {
  const: "O(1)",
  log: "O(log n)",
  linear: "O(n)",
  nlogn: "O(n log n)",
  quadratic: "O(n²)",
  exponential: "O(2ⁿ)",
};

const KIND_WORD: Record<Exclude<GrowthClass, "nlogn">, string> = {
  const: "Constant",
  log: "Logarithmic",
  linear: "Linear",
  quadratic: "Quadratic",
  exponential: "Exponential",
};

const rank = (c: GrowthClass) => ORDER.indexOf(c);

/** One term for a stem span: `40\log_{2} n`, `3n^{2}`, `2^{n}`. */
function termTex(c: GrowthClass, k: number): string {
  const lead = k === 1 ? "" : String(k);
  if (c === "const") return String(k);
  if (c === "log") return `${lead}\\log_{2} n`;
  if (c === "linear") return `${lead}n`;
  if (c === "nlogn") return `${lead}n\\log_{2} n`;
  if (c === "quadratic") return `${lead}n^{2}`;
  return k === 1 ? "2^{n}" : `${k} \\cdot 2^{n}`;
}

/** The same term for a choice label, which is plain text: `40 log₂ n`, `3n²`. */
function termLabel(c: GrowthClass, k: number): string {
  const lead = k === 1 ? "" : String(k);
  if (c === "const") return String(k);
  if (c === "log") return `${lead ? `${lead} ` : ""}log₂ n`;
  if (c === "linear") return `${lead}n`;
  if (c === "nlogn") return `${lead}n log₂ n`;
  if (c === "quadratic") return `${lead}n²`;
  return k === 1 ? "2ⁿ" : `${k} · 2ⁿ`;
}

/** A coefficient that tempts: large on slow-growing terms, small on fast ones. */
function temptingCoefficient(r: Rng, c: GrowthClass, top: GrowthClass): number {
  if (c === top) return r.pick([1, 1, 2, 3, 5]);
  if (c === "const") return r.pick([50, 100, 500, 1000, 9000]);
  return r.pick([20, 40, 100, 300, 1000]);
}

function pickClasses(r: Rng, count: number): GrowthClass[] {
  const pool = [...ORDER];
  const out: GrowthClass[] = [];
  while (out.length < count) out.push(...pool.splice(r.int(0, pool.length - 1), 1));
  return out;
}

/** Two pairs of class labels are the same length: O(1) with O(n), and O(n²)
 *  with O(2ⁿ). Every option set holds one whole pair, so "pick the shortest"
 *  or "pick the longest" never singles out the answer. */
const SAME_LENGTH: readonly [GrowthClass, GrowthClass][] = [
  ["const", "linear"],
  ["quadratic", "exponential"],
];

/** Three wrong big-O labels: the answer's same-length partner (or a whole
 *  pair), then the traps this item sets, then the nearest classes. */
function wrongClassLabels(r: Rng, correct: GrowthClass, traps: readonly GrowthClass[] = []): string[] {
  const own = SAME_LENGTH.find((pair) => pair.includes(correct));
  const pairFromTraps = SAME_LENGTH.find((pair) => pair.some((c) => traps.includes(c)));
  const forced = own ? own.filter((c) => c !== correct) : [...(pairFromTraps ?? SAME_LENGTH[r.int(0, 1)])];
  const at = rank(correct);
  const near = [at + 1, at - 1, at + 2, at - 2, at + 3, at - 3, at + 4, at - 4, at + 5, at - 5]
    .filter((i) => i >= 0 && i < ORDER.length)
    .map((i) => ORDER[i]);
  return [...new Set([...forced, ...traps, ...near])]
    .filter((c) => c !== correct)
    .slice(0, 3)
    .map((c) => BIG_O[c]);
}

type Snippet = { lines: string[]; cls: GrowthClass; why: string; traps?: GrowthClass[]; question?: string };

function codeSnippet(r: Rng): Snippet {
  const fixed = r.pick([10, 100, 1000]);
  const perPass = r.int(1, 3);
  const body = (depth: number) => Array.from({ length: perPass }, () => `${"    ".repeat(depth)}step()`);
  switch (r.int(0, 11)) {
    case 0:
      return { lines: ["for i in range(n):", ...body(1)], cls: "linear", why: `One loop runs n times with ${perPass} ${perPass === 1 ? "call" : "calls"} each: a number times n.` };
    case 1:
      return { lines: ["for i in range(n):", "    for j in range(n):", ...body(2)], cls: "quadratic", why: "A loop of n passes inside a loop of n passes: a number times n · n." };
    case 2:
      return {
        lines: ["m = n", "while m > 1:", "    m = m // 2", "    step()"],
        cls: "log",
        why: "m is cut in half on every pass, so the number of passes is the number of halvings from n down to 1.",
        traps: ["linear"],
      };
    case 3:
      return {
        lines: ["for i in range(n):", "    m = n", "    while m > 1:", "        m = m // 2", "        step()"],
        cls: "nlogn",
        why: "The inner loop halves m from n down to 1, about log n passes, and the outer loop runs it n times.",
        traps: ["quadratic", "log"],
      };
    case 4:
      return {
        lines: [`for i in range(${fixed}):`, ...body(1)],
        cls: "const",
        why: `The loop runs ${fixed} times whatever n is, so the count never changes.`,
        traps: ["linear"],
      };
    case 5:
      return {
        lines: ["for i in range(n):", "    step()", "for j in range(n):", ...body(1)],
        cls: "linear",
        why: `The loops are one after the other, so their counts add: ${perPass + 1}n, a number times n.`,
        traps: ["quadratic"],
      };
    case 6:
      return {
        lines: ["for i in range(n):", `    for j in range(${fixed}):`, "        step()"],
        cls: "linear",
        why: `The inner loop always runs ${fixed} times, so the count is ${fixed}n: a number times n.`,
        traps: ["quadratic"],
      };
    case 7:
      return {
        lines: ["for i in range(n):", "    for j in range(i):", "        step()"],
        cls: "quadratic",
        why: "The count is 0 + 1 + … + (n − 1) = n(n − 1)/2, and its fastest-growing term is n²/2.",
        traps: ["linear", "nlogn"],
      };
    case 8:
      return {
        lines: ["def f(n):", "    if n == 0:", "        step()", "        return", "    f(n - 1)", "    f(n - 1)"],
        cls: "exponential",
        why: "Each call makes two calls with n − 1, so the number of calls doubles every time n goes up by 1.",
        traps: ["linear", "quadratic"],
        question: "f(n) is called once. How does the number of times step() runs grow with n? Choose the big-O class.",
      };
    case 9:
      return {
        lines: ["for i in range(n):", "    for j in range(n):", "        step()", "for k in range(n):", ...body(1)],
        cls: "quadratic",
        why: `The count is n² + ${perPass === 1 ? "" : perPass}n, and n² grows fastest.`,
        traps: ["linear"],
      };
    case 10:
      return {
        lines: ["for i in range(0, n, 2):", ...body(1)],
        cls: "linear",
        why: "Jumping by 2 visits half the values, about n/2 passes. Half of n still grows like n.",
        traps: ["log"],
      };
    default:
      return {
        lines: ["i = 1", "while i < n:", "    i = i * 2", "    step()"],
        cls: "log",
        why: "i doubles on every pass, so it reaches n after about log n passes.",
        traps: ["linear"],
      };
  }
}

export function growthTemplates(kit: Algebra2Kit): Template[] {
  return [
    // ── Growth read from a table ────────────────────────────────────────────
    kit.T("algo_growth_from_table", "multipleChoice", (r) => {
      const kind = r.pick(["const", "log", "linear", "quadratic", "exponential"] as const);
      const consecutive = kind === "exponential" || (kind === "linear" && r.int(0, 1) === 0);
      const start = consecutive ? r.int(1, 6) : r.pick([2, 4, 8, 16]);
      const sizes = Array.from({ length: 5 }, (_, i) => (consecutive ? start + i : start * 2 ** i));
      const a = kind === "exponential" ? r.pick([1, 3, 5]) : kind === "const" ? r.int(3, 60) : r.int(1, 6);
      const offset = kind === "log" ? r.int(0, 5) : 0;
      const count = (n: number) =>
        kind === "const" ? a : kind === "log" ? a * Math.log2(n) + offset : kind === "linear" ? a * n : kind === "quadratic" ? a * n * n : a * 2 ** n;
      const rows = sizes.map((n) => `${n} | ${count(n)}`);
      const [n0, n1] = [sizes[0], sizes[1]];
      const [c0, c1] = [count(n0), count(n1)];
      const reason =
        kind === "const"
          ? `The count stays at ${a} however large n gets.`
          : kind === "log"
            ? `Each time n doubles, the count only goes up by ${a}: ${c0}, ${c1}, ${count(sizes[2])}.`
            : kind === "linear"
              ? consecutive
                ? `Each time n goes up by 1, the count goes up by the same ${a}, so the count is ${a === 1 ? "" : `${a} times `}n.`
                : `When n doubles from ${n0} to ${n1}, the count doubles too: ${c0} to ${c1}.`
              : kind === "quadratic"
                ? `When n doubles from ${n0} to ${n1}, the count is multiplied by 4: ${c0} to ${c1}.`
                : `Each time n goes up by just 1, the count doubles: ${c0}, ${c1}, ${count(sizes[2])}.`;
      const others = (["const", "log", "linear", "quadratic", "exponential"] as const).filter((k) => k !== kind);
      others.splice(r.int(0, others.length - 1), 1);
      return kit.choiceItem(
        r,
        `An algorithm was run at several input sizes.\nn | steps\n${rows.join("\n")}\nHow does the step count grow?`,
        KIND_WORD[kind],
        others.map((k) => KIND_WORD[k]),
        undefined,
        [
          step(
            consecutive ? "Here n goes up by 1 from row to row. Compare each count with the one before." : "Here n doubles from row to row. Compare each count with the one before.",
            "Say how n changes from row to row: ?",
          ),
          step(`${reason} That is ${KIND_WORD[kind].toLowerCase()} growth.`, "Describe what the count does, and name the growth: ?"),
        ],
      );
    }),

    // ── Big-O from an expression ────────────────────────────────────────────
    kit.T("algo_big_o_name", "multipleChoice", (r) => {
      const classes = pickClasses(r, r.pick([1, 2, 2, 3, 3]));
      const top = [...classes].sort((x, y) => rank(y) - rank(x))[0];
      const terms = classes.map((c) => ({ c, k: classes.length === 1 && c !== "const" ? r.int(2, 9) : temptingCoefficient(r, c, top) }));
      const expression = terms.map((t) => termTex(t.c, t.k)).join(" + ");
      const topTerm = terms.find((t) => t.c === top)!;
      const steps = [
        ...(terms.length > 1
          ? [
              step(
                `For large n the fastest-growing term swamps the rest. Here that is ${termLabel(top, topTerm.k)}, however big the other numbers look.`,
                "Find the term that grows fastest as n gets large: ?",
              ),
            ]
          : []),
        step(
          top === "const"
            ? `${topTerm.k} does not change with n at all. Every constant is ${BIG_O.const}.`
            : topTerm.k === 1
              ? `Its growth class is ${BIG_O[top]}.`
              : `Drop the ${topTerm.k} in front, since a constant multiple does not change how a count grows: ${BIG_O[top]}.`,
          "Drop any constant in front and name the class: ?",
        ),
      ];
      return kit.choiceItem(
        r,
        `An algorithm takes ${tex(expression)} steps on an input of size n. What is its big-O class?`,
        BIG_O[top],
        wrongClassLabels(r, top, classes),
        undefined,
        steps,
      );
    }),

    // ── Ranking growth rates ────────────────────────────────────────────────
    kit.T("algo_rank_growth", "multipleChoice", (r) => {
      const shape = r.int(0, 2);
      const classes = pickClasses(r, shape === 2 ? 3 : r.pick([3, 4]));
      const sorted = [...classes].sort((x, y) => rank(x) - rank(y));
      const top = sorted[sorted.length - 1];
      // Coefficients here are drawn without regard to the class, so a short or
      // long label says nothing about which one grows fastest.
      const labelOf = new Map(classes.map((c) => [c, termLabel(c, r.pick([1, 2, 5, 20, 40, 100, 300, 1000]))]));
      const label = (c: GrowthClass) => labelOf.get(c)!;
      const orderStep = step(
        "Ignore the numbers in front and compare the kinds of growth. From slowest to fastest: constant, log n, n, n log n, n², 2ⁿ.",
        "Recall the growth kinds from slowest to fastest: ?",
      );
      if (shape === 2) {
        const correct = sorted.map(label).join(", ");
        const wrong = [
          [sorted[2], sorted[1], sorted[0]],
          [sorted[1], sorted[0], sorted[2]],
          [sorted[0], sorted[2], sorted[1]],
        ].map((order) => order.map(label).join(", "));
        return kit.choiceItem(
          r,
          `Three algorithms take ${classes.map(label).join(", ")} steps on an input of size n. Which list puts them in order from slowest-growing to fastest-growing?`,
          correct,
          wrong,
          undefined,
          [orderStep, step(`So the order is ${correct}.`, "Put the three in that order: ?")],
        );
      }
      const most = shape === 0;
      const winner = most ? top : sorted[0];
      return kit.choiceItem(
        r,
        `${classes.length === 3 ? "Three" : "Four"} algorithms take ${classes.map(label).join(", ")} steps on an input of size n. Which takes the ${most ? "most" : "fewest"} steps once n is very large?`,
        label(winner),
        classes.filter((c) => c !== winner).map(label),
        undefined,
        [
          orderStep,
          step(
            `${label(winner)} is the ${most ? "fastest-growing" : "slowest-growing"} kind here, so for very large n it takes the ${most ? "most" : "fewest"} steps.`,
            `Pick the ${most ? "fastest-growing" : "slowest-growing"} kind: ?`,
          ),
        ],
      );
    }),

    // ── Big-O from code ─────────────────────────────────────────────────────
    kit.T("algo_big_o_from_code", "multipleChoice", (r) => {
      const snippet = codeSnippet(r);
      return kit.choiceItem(
        r,
        codeStem(snippet.lines, snippet.question ?? "How does the number of times step() runs grow with n? Choose the big-O class."),
        BIG_O[snippet.cls],
        wrongClassLabels(r, snippet.cls, snippet.traps),
        undefined,
        [step(snippet.why, "Say how the number of passes depends on n: ?"), step(`That growth is ${BIG_O[snippet.cls]}.`, "Name the big-O class: ?")],
      );
    }),

    // ── Exponential blow-up ─────────────────────────────────────────────────
    kit.T("algo_exponential_blowup", "integer", (r) => {
      const shape = r.pick([0, 2, 3, 4, 5]);
      if (shape === 0) {
        const n = r.int(6, 20);
        const total = 2 ** n;
        return {
          stem: `Trying every subset of n items takes ${tex("2^{n}")} steps. One run took ${commas(total)} steps. How many items were there?`,
          answer: kit.intAns(n),
          ...kit.withWorkedSteps([
            step(`One item gives 2 subsets, and each extra item doubles that. Count the doublings from 1 up to ${commas(total)}.`, "Say what each extra item does to the count: ?"),
            step(`${commas(total)} = 2^${n}: ${n} doublings, so there were ${n} items.`, `Write ${commas(total)} as a power of 2: ?`),
          ]),
        };
      }
      if (shape === 2) {
        const startCount = r.pick([50, 100, 200, 300, 500, 1000]);
        const from = r.int(8, 30);
        const more = r.int(2, 6);
        return {
          stem: `A search takes twice as many steps every time one more item is added. With ${from} items it takes ${commas(startCount)} steps. How many steps does it take with ${from + more} items?`,
          answer: kit.intAns(startCount * 2 ** more),
          ...kit.withWorkedSteps([
            step(`${from + more} items is ${more} more than ${from}, so the count doubles ${more} times: multiply by 2^${more} = ${2 ** more}.`, `Say how many times the count doubles, and what that multiplies it by: ?`),
            step(`${commas(startCount)} · ${2 ** more} = ${commas(startCount * 2 ** more)}.`, `Multiply ${commas(startCount)} by ${2 ** more}: ?`),
          ]),
        };
      }
      if (shape === 3) {
        const budget = r.pick([100, 500, 1000, 5000, 50000, 1000000, 1000000000]);
        let n = 0;
        while (2 ** (n + 1) <= budget) n += 1;
        return {
          stem: `An algorithm takes ${tex("2^{n}")} steps, and the computer has time for ${commas(budget)} steps. What is the largest input size n it can finish?`,
          answer: kit.intAns(n),
          ...kit.withWorkedSteps([
            step(`Find the largest power of 2 that is at most ${commas(budget)}. 2^${n} = ${commas(2 ** n)} fits.`, `Find a power of 2 that is at most ${commas(budget)}: ?`),
            step(`2^${n + 1} = ${commas(2 ** (n + 1))} is too many, so the largest size is n = ${n}.`, "Check that the next power of 2 is too big: ?"),
          ]),
        };
      }
      if (shape === 4) {
        const n = r.int(3, 10);
        return {
          stem: codeStem(["def f(n):", "    if n == 0:", "        step()", "        return", "    f(n - 1)", "    f(n - 1)", `f(${n})`]),
          answer: kit.intAns(2 ** n),
          ...kit.withWorkedSteps([
            step("f(0) calls step() once. Every other f(n) calls f(n − 1) twice, so it makes twice as many step() calls as f(n − 1).", "Compare f(n) with f(n − 1): ?"),
            step(`Doubling from 1, ${n} times: 2^${n} = ${commas(2 ** n)}.`, `Double 1 a total of ${n} times: ?`),
          ]),
        };
      }
      const from = r.int(20, 40);
      const more = r.int(3, 10);
      return {
        stem: `An algorithm takes ${tex("2^{n}")} steps. An input of size ${from} takes 1 second. How many seconds does an input of size ${from + more} take?`,
        answer: kit.intAns(2 ** more),
        ...kit.withWorkedSteps([
          step(`2^${from + more} = 2^${from} · 2^${more}, so the time is multiplied by 2^${more}.`, `Write 2^${from + more} as 2^${from} times a power of 2: ?`),
          step(`2^${more} = ${commas(2 ** more)} seconds.`, `Work out 2^${more}: ?`),
        ]),
      };
    }),

    // ── Where two growth curves cross ───────────────────────────────────────
    kit.T("algo_growth_crossover", "integer", (r) => {
      const shape = r.int(1, 5);
      if (shape === 1) {
        const lead = r.pick([1, 1, 2, 5]);
        const cross = r.pick([8, 10, 20, 30, 50, 100, 200]);
        const linear = lead * cross;
        return {
          stem: `Algorithm A takes ${tex(`${linear}n`)} steps and algorithm B takes ${tex(`${lead === 1 ? "" : lead}n^{2}`)} steps. For what input size n greater than 0 do they take the same number of steps?`,
          answer: kit.intAns(cross),
          ...kit.withWorkedSteps([
            step(`Both counts are a number times n: A is ${linear} · n and B is ${lead === 1 ? "" : `${lead} · `}n · n.`, "Write each count as something times n: ?"),
            step(
              `They match when the other parts match: ${linear} = ${lead === 1 ? "n" : `${lead} · n, and ${linear} ÷ ${lead} = ${cross}`}. So n = ${cross}.`,
              "Find the n that makes the other parts equal: ?",
            ),
          ]),
        };
      }
      if (shape === 2) {
        const cross = r.pick([5, 8, 10, 12, 20, 25, 50]);
        return {
          stem: `Algorithm A takes ${tex(`${cross}n^{2}`)} steps and algorithm B takes ${tex("n^{3}")} steps. For what input size n greater than 0 do they take the same number of steps?`,
          answer: kit.intAns(cross),
          ...kit.withWorkedSteps([
            step(`Both counts are a number times n · n: A is ${cross} · n · n and B is n · n · n.`, "Write each count as something times n · n: ?"),
            step(`They match when the other parts match: n = ${cross}.`, "Find the n that makes the other parts equal: ?"),
          ]),
        };
      }
      if (shape === 3) {
        const c = r.pick([5, 10, 20, 50, 100, 200, 500, 1000]);
        let n = 1;
        while (2 ** n <= c * n) n += 1;
        return {
          stem: `Algorithm A takes ${tex(`${c}n`)} steps and algorithm B takes ${tex("2^{n}")} steps. What is the smallest whole number n, starting from 1, for which B takes more steps than A?`,
          answer: kit.intAns(n),
          ...kit.withWorkedSteps([
            step(`Try sizes near where they meet. At n = ${n - 1}: A takes ${commas(c * (n - 1))} and B takes ${commas(2 ** (n - 1))}, so B is not ahead yet.`, `Compare the two counts at n = ${n - 1}: ?`),
            step(`At n = ${n}: A takes ${commas(c * n)} and B takes ${commas(2 ** n)}. B is ahead from here on, so n = ${n}.`, `Compare the two counts at n = ${n}: ?`),
          ]),
        };
      }
      const cross = r.pick([10, 20, 40, 50, 100]);
      if (shape === 4) {
        const times = r.int(2, 12);
        return {
          stem: `Algorithm A takes ${tex(`${cross}n`)} steps and algorithm B takes ${tex("n^{2}")} steps. At n = ${commas(cross * times)}, B takes how many times as many steps as A?`,
          answer: kit.intAns(times),
          ...kit.withWorkedSteps([
            step(`B ÷ A = n^2 ÷ (${cross}n) = n ÷ ${cross}.`, "Divide B's count by A's count and simplify: ?"),
            step(`At n = ${commas(cross * times)}: ${commas(cross * times)} ÷ ${cross} = ${times}.`, `Put in n = ${commas(cross * times)}: ?`),
          ]),
        };
      }
      return {
        stem: `Algorithm A takes ${tex(`${cross}n`)} steps and algorithm B takes ${tex("n^{2}")} steps. For how many whole-number input sizes n, starting from 1, does B take fewer steps than A?`,
        answer: kit.intAns(cross - 1),
        ...kit.withWorkedSteps([
          step(`B takes fewer steps when n^2 < ${cross}n. Divide by n: n < ${cross}.`, "Write the inequality and divide by n: ?"),
          step(`The whole numbers from 1 up to ${cross - 1}: that is ${cross - 1} sizes. From n = ${cross} on, the n^2 term has taken over.`, `Count the whole numbers from 1 that are below ${cross}: ?`),
        ]),
      };
    }),
  ];
}
