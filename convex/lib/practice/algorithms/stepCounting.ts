/**
 * Algorithms strand, first half: counting the steps of loops and searches.
 *
 * Answers are typed whole numbers, except `algo_count_expression`, which is an
 * expression in n on the `sequence` pad (digits, n, + − × / ^ and brackets) and
 * is graded by value, so `n(n-1)/2` and `(n^2-n)/2` are both accepted.
 */
import type { Algebra2Kit, Rng, Template } from "../templates";
import { polyAns } from "../algebra2/format";
import { codeStem, commas, divideChain, floorLog, step } from "./code";

const EXPRESSION_QUESTION = "Write the number of times step() runs as an expression in n.";

function distinctSorted(r: Rng, count: number, lo: number, hi: number): number[] {
  const seen = new Set<number>();
  while (seen.size < count) seen.add(r.int(lo, hi));
  return [...seen].sort((a, b) => a - b);
}

function shuffled<T>(r: Rng, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The body of a loop that calls step() `k` times, at an indent depth. */
function stepLines(k: number, depth: number): string[] {
  return Array.from({ length: k }, () => `${"    ".repeat(depth)}step()`);
}

function binarySearchLines(items: readonly number[], target: number): string[] {
  return [
    `items = [${items.join(", ")}]`,
    "lo = 0",
    "hi = len(items) - 1",
    "while lo <= hi:",
    "    mid = (lo + hi) // 2",
    "    step()",
    `    if items[mid] == ${target}:`,
    "        break",
    `    if items[mid] < ${target}:`,
    "        lo = mid + 1",
    "    else:",
    "        hi = mid - 1",
  ];
}

/** The middle items a binary search looks at, in order. */
function binarySearchTrace(items: readonly number[], target: number): number[] {
  const seen: number[] = [];
  let lo = 0;
  let hi = items.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    seen.push(items[mid]);
    if (items[mid] === target) break;
    if (items[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return seen;
}

export function stepCountingTemplates(kit: Algebra2Kit): Template[] {
  return [
    // ── One loop ────────────────────────────────────────────────────────────
    kit.T("algo_count_loop", "integer", (r) => {
      const v = r.pick(["i", "k", "t"]);
      const shape = r.int(0, 4);
      if (shape === 0) {
        const n = r.int(6, 40);
        return {
          stem: codeStem([`for ${v} in range(${n}):`, "    step()"]),
          answer: kit.intAns(n),
          ...kit.withWorkedSteps([
            step(`range(${n}) counts 0, 1, 2, …, ${n - 1}. It starts at 0 and stops before ${n}.`, `List what range(${n}) counts: ?`),
            step(`That is ${n} values, and the body runs once for each: ${n} times.`, "Count the values: ?"),
          ]),
        };
      }
      if (shape === 1) {
        const a = r.int(2, 12);
        const count = r.int(5, 30);
        const b = a + count;
        return {
          stem: codeStem([`for ${v} in range(${a}, ${b}):`, "    step()"]),
          answer: kit.intAns(count),
          ...kit.withWorkedSteps([
            step(`range(${a}, ${b}) starts at ${a} and stops before ${b}.`, `Say where range(${a}, ${b}) starts and stops: ?`),
            step(`From ${a} up to ${b - 1} there are ${b} − ${a} = ${count} values, so step() runs ${count} times.`, `Work out ${b} − ${a}: ?`),
          ]),
        };
      }
      if (shape === 2) {
        const jump = r.pick([2, 3, 4, 5]);
        const count = r.int(4, 15);
        const last = jump * (count - 1);
        const stop = r.int(0, 1) === 0 ? jump * count : last + r.int(1, jump - 1);
        return {
          stem: codeStem([`for ${v} in range(0, ${stop}, ${jump}):`, "    step()"]),
          answer: kit.intAns(count),
          ...kit.withWorkedSteps([
            step(
              `range(0, ${stop}, ${jump}) counts 0, ${jump}, ${2 * jump}, … in jumps of ${jump} and stops before ${stop}.`,
              `Describe what range(0, ${stop}, ${jump}) counts: ?`,
            ),
            step(`The last value is ${last}. That is ${last} ÷ ${jump} = ${count - 1} jumps after 0.`, `Find the last value and how many jumps it is from 0: ?`),
            step(`Counting the 0 as well: ${count - 1} + 1 = ${count} values, so step() runs ${count} times.`, "Add 1 for the starting value: ?"),
          ]),
        };
      }
      if (shape === 3) {
        const n = r.int(5, 25);
        const perPass = r.int(2, 3);
        const before = r.int(0, 2);
        const total = before + perPass * n;
        const lines = [...stepLines(before, 0), `for ${v} in range(${n}):`, ...stepLines(perPass, 1)];
        return {
          stem: codeStem(lines),
          answer: kit.intAns(total),
          ...kit.withWorkedSteps([
            step(`The loop makes ${n} passes, and each pass calls step() ${perPass} times: ${perPass} · ${n} = ${perPass * n}.`, "Count the calls made inside the loop: ?"),
            ...(before > 0
              ? [step(`${before} more ${before === 1 ? "call happens" : "calls happen"} once, before the loop: ${perPass * n} + ${before} = ${total}.`, "Add the calls made before the loop: ?")]
              : []),
          ]),
        };
      }
      const down = r.pick([1, 2, 3]);
      const passes = r.int(4, 14);
      const start = down === 1 || r.int(0, 1) === 0 ? down * passes : down * (passes - 1) + r.int(1, down - 1);
      return {
        stem: codeStem([`${v} = ${start}`, `while ${v} > 0:`, "    step()", `    ${v} = ${v} - ${down}`]),
        answer: kit.intAns(passes),
        ...kit.withWorkedSteps([
          step(`${v} starts at ${start} and drops by ${down} on every pass. The loop stops when ${v} is 0 or less.`, `Say how ${v} changes on each pass: ?`),
          step(
            start % down === 0
              ? `${start} ÷ ${down} = ${passes}, so after ${passes} passes ${v} is 0 and the loop stops: ${passes} times.`
              : `After ${passes - 1} passes ${v} is ${start - down * (passes - 1)}, still above 0, so one more pass runs: ${passes} times.`,
            `Count the passes until ${v} is 0 or less: ?`,
          ),
        ]),
      };
    }),

    // ── Linear search ───────────────────────────────────────────────────────
    kit.T("algo_linear_search_steps", "integer", (r) => {
      const shape = r.int(0, 4);
      if (shape <= 1) {
        const items = shuffled(r, distinctSorted(r, r.int(6, 9), 2, 40));
        const present = shape === 0;
        let target = items[r.int(0, items.length - 1)];
        if (!present) {
          target = r.int(41, 60);
        }
        const checks = present ? items.indexOf(target) + 1 : items.length;
        return {
          stem: codeStem([`items = [${items.join(", ")}]`, "for x in items:", "    step()", `    if x == ${target}:`, "        break"]),
          answer: kit.intAns(checks),
          ...kit.withWorkedSteps([
            step(`The loop looks at one item per pass, from the left, and stops as soon as it sees ${target}.`, "Say what one pass does and when the loop stops: ?"),
            step(
              present
                ? `${target} is item number ${checks} in the list, so step() runs ${checks} times.`
                : `${target} is not in the list, so the loop never stops early. It looks at all ${checks} items.`,
              `Find where ${target} is in the list: ?`,
            ),
          ]),
        };
      }
      const n = r.int(2, 90) * 10 + r.pick([0, 0, 5]);
      const how = "A linear search checks a list one item at a time, from the front.";
      if (shape === 2) {
        const after = r.int(2, Math.min(n - 3, 60));
        return {
          stem: `${how} The list has ${n} items, and ${after} of them come after the target. How many items does the search check?`,
          answer: kit.intAns(n - after),
          ...kit.withWorkedSteps([
            step(`The search stops at the target, so it never looks at the ${after} items after it.`, "Say which items the search never looks at: ?"),
            step(`${n} − ${after} = ${n - after} items checked, counting the target itself.`, `Subtract them from the ${n} items: ?`),
          ]),
        };
      }
      if (shape === 3) {
        if (r.int(0, 2) === 0) {
          return {
            stem: `${how} The list has ${n} items and the target is the first one. How many items does the search check?`,
            answer: kit.intAns(1),
            ...kit.withWorkedSteps([step("The first check finds it, so the search stops after 1 item. This is the best case.", "Count the items checked before it stops: ?")]),
          };
        }
        const other = r.int(2, 60) * 10;
        return {
          stem: `${how} It looks for a name in a list of ${n} names, then in a second list of ${other} names. The name is in neither list. How many names does it check in all?`,
          answer: kit.intAns(n + other),
          ...kit.withWorkedSteps([
            step("A missing target is the worst case: the search cannot stop early, so it checks every item of a list.", "Say how many items a search checks when the target is missing: ?"),
            step(`${n} + ${other} = ${n + other} names.`, `Add the two lists: ${n} + ${other} = ?`),
          ]),
        };
      }
      const odd = 2 * r.int(3, 50) + 1;
      return {
        stem: `${how} The list has ${odd} items, and the target is equally likely to be any one of them. On average, how many items does the search check?`,
        answer: kit.intAns((odd + 1) / 2),
        ...kit.withWorkedSteps([
          step(`The search takes 1 check if the target is first, 2 if it is second, and so on up to ${odd}.`, "List the number of checks for each position: ?"),
          step(`The average of 1, 2, …, ${odd} is the middle value: (1 + ${odd}) ÷ 2 = ${(odd + 1) / 2}.`, `Average the first and last: (1 + ${odd}) ÷ 2 = ?`),
        ]),
      };
    }),

    // ── Nested and back-to-back loops ───────────────────────────────────────
    kit.T("algo_count_nested", "integer", (r) => {
      const shape = r.int(0, 5);
      if (shape === 0) {
        const a = r.int(3, 12);
        const b = r.int(3, 12);
        return {
          stem: codeStem([`for i in range(${a}):`, `    for j in range(${b}):`, "        step()"]),
          answer: kit.intAns(a * b),
          ...kit.withWorkedSteps([
            step(`The inner loop calls step() ${b} times every time it runs.`, "Count the calls in one run of the inner loop: ?"),
            step(`The outer loop runs the inner loop ${a} times: ${a} · ${b} = ${a * b}.`, `Multiply by the outer loop's passes: ${a} · ${b} = ?`),
          ]),
        };
      }
      if (shape === 1) {
        const n = r.int(4, 15);
        return {
          stem: codeStem([`n = ${n}`, "for i in range(n):", "    for j in range(n):", "        step()"]),
          answer: kit.intAns(n * n),
          ...kit.withWorkedSteps([
            step(`With n = ${n}, the inner loop calls step() ${n} times on each run.`, "Count the calls in one run of the inner loop: ?"),
            step(`The outer loop runs it ${n} times: ${n} · ${n} = ${n * n}.`, `Multiply by the outer loop's passes: ${n} · ${n} = ?`),
          ]),
        };
      }
      if (shape === 2) {
        const n = r.int(4, 10);
        const inclusive = r.int(0, 1) === 1;
        const total = inclusive ? (n * (n + 1)) / 2 : (n * (n - 1)) / 2;
        const first = inclusive ? 1 : 0;
        const last = inclusive ? n : n - 1;
        return {
          stem: codeStem([`for i in range(${n}):`, `    for j in range(${inclusive ? "i + 1" : "i"}):`, "        step()"]),
          answer: kit.intAns(total),
          ...kit.withWorkedSteps([
            step(
              `The inner loop's length changes: when i = 0 it runs ${first} ${first === 1 ? "time" : "times"}, when i = 1 it runs ${first + 1}, and when i = ${n - 1} it runs ${last}.`,
              "Say how many times the inner loop runs for the first and last values of i: ?",
            ),
            step(
              `Add them: ${Array.from({ length: n }, (_, i) => i + first).join(" + ")} = ${total}.`,
              `Add ${first} + ${first + 1} + … + ${last}: ?`,
            ),
          ]),
        };
      }
      if (shape === 3) {
        const a = r.int(4, 30);
        const b = r.int(4, 30);
        return {
          stem: codeStem([`for i in range(${a}):`, "    step()", `for j in range(${b}):`, "    step()"]),
          answer: kit.intAns(a + b),
          ...kit.withWorkedSteps([
            step("The second loop is not inside the first. It starts after the first one has finished.", "Say whether the second loop is inside the first: ?"),
            step(`So the counts add: ${a} + ${b} = ${a + b}.`, `Add the two loops: ${a} + ${b} = ?`),
          ]),
        };
      }
      if (shape === 4) {
        const a = r.int(3, 10);
        const b = r.int(3, 9);
        return {
          stem: codeStem([`for i in range(${a}):`, "    step()", `    for j in range(${b}):`, "        step()"]),
          answer: kit.intAns(a * (b + 1)),
          ...kit.withWorkedSteps([
            step(`One pass of the outer loop calls step() once, then ${b} more times in the inner loop: ${b + 1} calls.`, "Count the calls in one pass of the outer loop: ?"),
            step(`The outer loop makes ${a} passes: ${a} · ${b + 1} = ${a * (b + 1)}.`, `Multiply by the outer loop's passes: ${a} · ${b + 1} = ?`),
          ]),
        };
      }
      const [a, b, c] = [r.int(2, 5), r.int(2, 5), r.int(2, 5)];
      return {
        stem: codeStem([`for i in range(${a}):`, `    for j in range(${b}):`, `        for k in range(${c}):`, "            step()"]),
        answer: kit.intAns(a * b * c),
        ...kit.withWorkedSteps([
          step(`The innermost loop calls step() ${c} times. The middle loop runs it ${b} times: ${b} · ${c} = ${b * c}.`, "Count the calls in one run of the middle loop: ?"),
          step(`The outer loop runs all of that ${a} times: ${a} · ${b * c} = ${a * b * c}.`, `Multiply by the outer loop's passes: ${a} · ${b * c} = ?`),
        ]),
      };
    }),

    // ── The count as an expression in n ─────────────────────────────────────
    kit.T(
      "algo_count_expression",
      "expression",
      (r) => {
        const shape = r.int(0, 6);
        if (shape === 0) {
          const perPass = r.int(1, 4);
          const before = perPass === 1 ? r.int(1, 3) : r.int(0, 3);
          const rule = polyAns([perPass, before], "n");
          return {
            stem: codeStem([...stepLines(before, 0), "for i in range(n):", ...stepLines(perPass, 1)], EXPRESSION_QUESTION),
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step(`The loop makes n passes with ${perPass} ${perPass === 1 ? "call" : "calls"} each: ${polyAns([perPass, 0], "n")}.`, "Count the calls made inside the loop, in terms of n: ?"),
              step(before > 0 ? `Add the ${before} made before the loop: ${rule}.` : `Nothing else calls step(), so the count is ${rule}.`, "Add any calls made outside the loop: ?"),
            ]),
          };
        }
        if (shape === 1) {
          const perPass = r.int(1, 3);
          const rule = polyAns([perPass, 0, 0], "n");
          return {
            stem: codeStem(["for i in range(n):", "    for j in range(n):", ...stepLines(perPass, 2)], EXPRESSION_QUESTION),
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step(`One run of the inner loop makes n passes with ${perPass} ${perPass === 1 ? "call" : "calls"} each: ${polyAns([perPass, 0], "n")}.`, "Count the calls in one run of the inner loop: ?"),
              step(`The outer loop runs that n times: n · ${polyAns([perPass, 0], "n")} = ${rule}.`, "Multiply by the outer loop's n passes: ?"),
            ]),
          };
        }
        if (shape === 2) {
          const m = r.int(2, 9);
          const after = r.int(0, 2);
          const rule = polyAns([m, after], "n");
          return {
            stem: codeStem(["for i in range(n):", `    for j in range(${m}):`, "        step()", ...stepLines(after, 0)], EXPRESSION_QUESTION),
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step(`The inner loop always makes ${m} passes, whatever n is. The outer loop runs it n times: ${polyAns([m, 0], "n")}.`, "Count the calls made inside the loops: ?"),
              step(after > 0 ? `Add the ${after} made after the loops: ${rule}.` : `Nothing else calls step(), so the count is ${rule}.`, "Add any calls made outside the loops: ?"),
            ]),
          };
        }
        if (shape === 3) {
          const perPass = r.int(1, 4);
          const rule = polyAns([1, perPass, 0], "n");
          return {
            stem: codeStem(["for i in range(n):", "    for j in range(n):", "        step()", "for k in range(n):", ...stepLines(perPass, 1)], EXPRESSION_QUESTION),
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step("The nested pair calls step() n · n = n^2 times.", "Count the calls in the nested loops: ?"),
              step(`The loop after it is not nested. It adds ${polyAns([perPass, 0], "n")}: ${rule}.`, "Add the calls in the last loop: ?"),
            ]),
          };
        }
        if (shape === 4) {
          const a = r.int(1, 9);
          const rule = polyAns([1, -a], "n");
          return {
            stem: codeStem([`for i in range(${a}, n):`, "    step()"], `${EXPRESSION_QUESTION} Take n to be at least ${a}.`),
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step(
                a === 1
                  ? "range(1, n) starts at 1 and stops before n, so it skips one value, 0."
                  : `range(${a}, n) starts at ${a} and stops before n, so it skips the ${a} values 0 to ${a - 1}.`,
                `Say which values range(${a}, n) leaves out: ?`,
              ),
              step(`That leaves n − ${a} values: ${rule}.`, `Subtract the skipped values from n: ?`),
            ]),
          };
        }
        if (shape === 5) {
          const inclusive = r.int(0, 1) === 1;
          const rule = inclusive ? "n(n+1)/2" : "n(n-1)/2";
          const last = inclusive ? "n" : "n − 1";
          const first = inclusive ? 1 : 0;
          return {
            stem: codeStem(["for i in range(n):", `    for j in range(${inclusive ? "i + 1" : "i"}):`, "        step()"], EXPRESSION_QUESTION),
            answer: kit.exprAns(rule),
            ...kit.withWorkedSteps([
              step(`The inner loop runs ${first} ${first === 1 ? "time" : "times"} when i = 0, then ${first + 1}, then ${first + 2}, up to ${last} times on the last pass.`, "List how many times the inner loop runs on each pass: ?"),
              step(
                `The total is ${first} + ${first + 1} + … + ${inclusive ? "n" : "(n − 1)"}: n numbers whose average is ${inclusive ? "(n + 1)/2" : "(n − 1)/2"}.`,
                "Describe the sum and the average of its terms: ?",
              ),
              step(`n numbers times their average: ${rule}.`, "Multiply how many numbers there are by their average: ?"),
            ]),
          };
        }
        const perPass = r.int(1, 3);
        const rule = polyAns([1, perPass, 0], "n");
        return {
          stem: codeStem(["for i in range(n):", ...stepLines(perPass, 1), "    for j in range(n):", "        step()"], EXPRESSION_QUESTION),
          answer: kit.exprAns(rule),
          ...kit.withWorkedSteps([
            step(`One pass of the outer loop makes ${perPass} ${perPass === 1 ? "call" : "calls"}, then n more in the inner loop: n + ${perPass}.`, "Count the calls in one pass of the outer loop: ?"),
            step(`The outer loop makes n passes: n(n + ${perPass}) = ${rule}.`, `Multiply n + ${perPass} by n: ?`),
          ]),
        };
      },
      { answerPalette: "sequence" },
    ),

    // ── Double the input ────────────────────────────────────────────────────
    kit.T("algo_double_input", "integer", (r) => {
      const degree = r.pick([0, 1, 1, 2, 2, 3]);
      const perPass = r.int(1, 3);
      const fixed = r.pick([10, 20, 50, 100]);
      const loops = ["for i in range(n):", "    for j in range(n):", "        for k in range(n):"].slice(0, degree);
      const lines = degree === 0 ? [`for i in range(${fixed}):`, ...stepLines(perPass, 1)] : [...loops, ...stepLines(perPass, degree)];
      const times = r.pick([2, 2, 2, 3]);
      const factor = times ** degree;
      const word = times === 2 ? "doubles" : "triples";
      const why =
        degree === 0
          ? step("No loop depends on n, so changing n changes nothing: the count is multiplied by 1.", "Say whether any loop depends on n: ?")
          : degree === 1
            ? step(`One loop runs n times, so the count is a number times n. Making n ${times} times as big makes the count ${times} times as big.`, "Say how the count depends on n: ?")
            : step(
                `${degree} nested loops each run n times, so the count is a number times ${degree === 2 ? "n · n" : "n · n · n"}. Each n becomes ${times} times as big: ${Array(degree).fill(times).join(" · ")} = ${factor}.`,
                "Say how the count depends on n, and what happens to each n: ?",
              );
      if (r.int(0, 2) === 0) {
        return {
          stem: codeStem(lines, `The input size n ${word}. The number of times step() runs is multiplied by what number?`),
          answer: kit.intAns(factor),
          ...kit.withWorkedSteps([why]),
        };
      }
      const base = degree === 3 ? r.pick([5, 10]) : r.pick([5, 10, 20, 50, 100]);
      const before = degree === 0 ? perPass * fixed : perPass * base ** degree;
      return {
        stem: codeStem(lines, `When n = ${base}, step() runs ${commas(before)} times. How many times does it run when n = ${base * times}?`),
        answer: kit.intAns(before * factor),
        ...kit.withWorkedSteps([
          why,
          step(`${commas(before)} · ${factor} = ${commas(before * factor)}.`, `Multiply the old count by ${degree === 0 ? "that number" : factor}: ?`),
        ]),
      };
    }),

    // ── Halving loops ───────────────────────────────────────────────────────
    kit.T("algo_halving_loop", "integer", (r) => {
      const shape = r.int(0, 4);
      const halving = (start: string, by: number) => [`n = ${start}`, "while n > 1:", `    n = n // ${by}`, "    step()"];
      if (shape === 0) {
        const power = r.int(3, 12);
        const n = 2 ** power;
        return {
          stem: codeStem(halving(String(n), 2)),
          answer: kit.intAns(power),
          ...kit.withWorkedSteps([
            step(`n // 2 cuts n in half. Follow n: ${divideChain(n, 2).join(" → ")}.`, "Write n after each pass until it reaches 1: ?"),
            step(`That is ${power} halvings, so step() runs ${power} times.`, "Count the arrows: ?"),
          ]),
        };
      }
      if (shape === 1) {
        let n = r.int(10, 1000);
        if ((n & (n - 1)) === 0) n += 3;
        const passes = floorLog(n, 2);
        return {
          stem: codeStem(halving(String(n), 2)),
          answer: kit.intAns(passes),
          ...kit.withWorkedSteps([
            step("n // 2 cuts n in half and throws away any remainder, so 25 // 2 is 12.", "Say what n // 2 does to an odd number: ?"),
            step(`Follow n: ${divideChain(n, 2).join(" → ")}.`, "Write n after each pass until it reaches 1: ?"),
            step(`That is ${passes} passes, so step() runs ${passes} times.`, "Count the arrows: ?"),
          ]),
        };
      }
      if (shape === 2) {
        const by = r.pick([3, 3, 4, 5]);
        const power = r.int(2, by === 3 ? 7 : by === 4 ? 6 : 5);
        const n = by ** power;
        return {
          stem: codeStem(halving(String(n), by)),
          answer: kit.intAns(power),
          ...kit.withWorkedSteps([
            step(`Each pass divides n by ${by}. Follow n: ${divideChain(n, by).join(" → ")}.`, "Write n after each pass until it reaches 1: ?"),
            step(`That is ${power} passes, so step() runs ${power} times.`, "Count the arrows: ?"),
          ]),
        };
      }
      if (shape === 3) {
        const exact = r.int(0, 1) === 0;
        const power = r.int(3, 10);
        const limit = exact ? 2 ** power : 2 ** (power - 1) + r.int(1, 2 ** (power - 1) - 1);
        const chain = Array.from({ length: power + 1 }, (_, i) => 2 ** i);
        return {
          stem: codeStem(["i = 1", `while i < ${limit}:`, "    i = i * 2", "    step()"]),
          answer: kit.intAns(power),
          ...kit.withWorkedSteps([
            step(`i doubles on every pass: ${chain.join(" → ")}.`, `Write i after each pass until it is no longer below ${limit}: ?`),
            step(`${chain[power]} is the first value that is not below ${limit}, after ${power} passes: step() runs ${power} times.`, "Count the passes: ?"),
          ]),
        };
      }
      const power = r.int(3, 12);
      return {
        stem: codeStem(
          ["while n > 1:", "    n = n // 2", "    step()"],
          `n starts as a power of 2, and step() runs ${power} times. What number did n start as?`,
        ),
        answer: kit.intAns(2 ** power),
        ...kit.withWorkedSteps([
          step(`Each pass halves n, and after ${power} passes n is 1. Run it backwards: start at 1 and double ${power} times.`, "Say how to undo the halvings: ?"),
          step(`${Array.from({ length: power + 1 }, (_, i) => 2 ** i).join(" → ")}, so n started as ${2 ** power}.`, `Double 1 a total of ${power} times: ?`),
        ]),
      };
    }),

    // ── Binary search ───────────────────────────────────────────────────────
    kit.T("algo_binary_search_steps", "integer", (r) => {
      const shape = r.int(0, 4);
      const intro = "Binary search checks the middle item of a sorted list, then keeps only the half that could still hold the target.";
      if (shape <= 1) {
        // At most 10 two-digit items, so the list fits on one line of the card.
        const items = distinctSorted(r, r.pick([7, 8, 9, 10]), 1, 60);
        const present = shape === 0 || r.int(0, 2) > 0;
        let target = items[r.int(0, items.length - 1)];
        if (!present) {
          target = items[r.int(0, items.length - 2)] + 1;
          while (items.includes(target)) target += 1;
        }
        const trace = binarySearchTrace(items, target);
        return {
          stem: codeStem(binarySearchLines(items, target)),
          answer: kit.intAns(trace.length),
          ...kit.withWorkedSteps([
            step(`Each pass looks at the middle item of what is left, then keeps the half where ${target} could be.`, "Say what one pass does: ?"),
            step(`The middle items it looks at are ${trace.join(", then ")}.`, `List the middle item checked on each pass: ?`),
            step(
              items.includes(target)
                ? `The last of those is ${target}, so the loop stops after ${trace.length} ${trace.length === 1 ? "check" : "checks"}.`
                : `After that nothing is left to check, so ${target} is not there: ${trace.length} checks.`,
              "Count the checks: ?",
            ),
          ]),
        };
      }
      const n = r.pick([7, 15, 16, 31, 32, 50, 63, 64, 100, 127, 200, 255, 500, 1000, 1023, 1024, 5000, 1000000]);
      const halvings = floorLog(n, 2);
      const worst = halvings + 1;
      const chain = divideChain(n, 2).map(commas).join(" → ");
      if (shape === 2) {
        return {
          stem: `${intro} On a sorted list of ${commas(n)} items, what is the most checks it can ever need?`,
          answer: kit.intAns(worst),
          ...kit.withWorkedSteps([
            step(`In the worst case each check leaves half the items, rounded down: ${chain}.`, "Write how many items are left after each check: ?"),
            step(`That is ${halvings} checks to get down to 1 item, and 1 more to check that item: ${worst}.`, "Count the checks, including the one for the last item: ?"),
          ]),
        };
      }
      if (shape === 3) {
        const big = r.pick([100, 500, 1000, 5000, 1000000]);
        const bigWorst = floorLog(big, 2) + 1;
        return {
          stem: `${intro} A linear search checks one item at a time. On a sorted list of ${commas(big)} items, how many fewer checks does binary search need than linear search, each in its worst case?`,
          answer: kit.intAns(big - bigWorst),
          ...kit.withWorkedSteps([
            step(`Linear search may have to check all ${commas(big)} items.`, "Give linear search's worst case: ?"),
            step(`Binary search halves what is left: ${divideChain(big, 2).map(commas).join(" → ")}, then checks the last item: ${bigWorst} checks.`, "Give binary search's worst case: ?"),
            step(`${commas(big)} − ${bigWorst} = ${commas(big - bigWorst)}.`, "Subtract: ?"),
          ]),
        };
      }
      const power = r.int(5, 12);
      const size = 2 ** power;
      const checks = r.int(2, power - 2);
      return {
        stem: `${intro} A sorted list has ${commas(size)} items. After ${checks} checks that each throw away half of what is left, at most how many items could still hold the target?`,
        answer: kit.intAns(size / 2 ** checks),
        ...kit.withWorkedSteps([
          step(`Halve ${commas(size)} once for each check: ${Array.from({ length: checks + 1 }, (_, i) => commas(size / 2 ** i)).join(" → ")}.`, `Halve ${commas(size)} a total of ${checks} times: ?`),
        ]),
      };
    }),
  ];
}
