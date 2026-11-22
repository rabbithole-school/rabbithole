// The "Code it" mission registry: every mission is tied to a real Algebra 2
// skill, fits where Quest missions live, and states an example result that is
// mathematically right (each one is re-derived here in plain TypeScript).
import { describe, expect, test } from "vitest";

import {
  CODE_IT_MISSIONS,
  CODE_IT_MISSION_MAX,
  CODE_IT_TITLE_MAX,
  codeItIdeaKey,
  codeItMissionFor,
} from "../codeItMissions";
import { ALGEBRA_2_SKILLS } from "../../../seed/algebra2Graph";
import { QUEST_MISSION_LIMITS } from "../../../units";
import { QUEST_PROPOSAL_TITLE_MAX } from "../../../questProposals";

describe("Code it missions", () => {
  test("the written-out limits are the ones an offer enforces", () => {
    expect(CODE_IT_MISSION_MAX).toBe(QUEST_MISSION_LIMITS.maxText);
    expect(CODE_IT_TITLE_MAX).toBe(QUEST_PROPOSAL_TITLE_MAX);
  });

  test("each skill is a real Algebra 2 node and appears once", () => {
    const real = new Set(ALGEBRA_2_SKILLS.map((s) => s.skillKey));
    const keys = CODE_IT_MISSIONS.map((m) => m.skillKey);
    for (const key of keys) expect(real.has(key), key).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test.each(CODE_IT_MISSIONS.map((m) => [m.skillKey, m] as const))(
    "%s fits, is one plain line, and says what to write and when it is done",
    (_key, m) => {
      expect(m.mission.length).toBeLessThanOrEqual(CODE_IT_MISSION_MAX);
      expect(m.title.length).toBeLessThanOrEqual(CODE_IT_TITLE_MAX);
      expect(m.title.trim()).not.toBe("");
      expect(m.mission).not.toMatch(/[\r\n]/);
      expect(m.mission).not.toMatch(/\s\s/);
      expect(m.mission.trim().endsWith("?")).toBe(false);
      expect(m.mission).not.toContain("?");
      expect(m.mission).toMatch(/[A-Za-z_][A-Za-z_0-9]*\(/);
      expect(m.mission).toMatch(/\b[Dd]one\b/);
    },
  );

  test("lookup and idea key", () => {
    expect(codeItMissionFor("cx_multiply")?.title).toBeTruthy();
    expect(codeItMissionFor("nope")).toBeNull();
    expect(codeItIdeaKey("cx_multiply")).toBe("code-it:cx_multiply");
  });
});

// ── Every stated example, re-derived ───────────────────────────────────────

const seq = (n: number) => 7 + 4 * (n - 1);

const termLoop = (n: number) => {
  let t = 3;
  for (let i = 1; i < n; i++) t *= 2;
  return t;
};
const termFormula = (n: number) => 3 * 2 ** (n - 1);

const totalLoop = (n: number) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += 2 ** i;
  return sum;
};

const partial = (n: number) => {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += 1 / 2 ** i;
  return sum;
};

const halvings = (n: number) => {
  let count = 0;
  let x = n;
  while (x >= 1) {
    x /= 2;
    count++;
  }
  return count;
};

const doublings = (start: number, goal: number) => {
  let count = 0;
  let x = start;
  while (x < goal) {
    x *= 2;
    count++;
  }
  return count;
};

/** Complex roots of ax² + bx + c (negative discriminant): [re, im]. */
const complexRoots = (a: number, b: number, c: number) => {
  const disc = b * b - 4 * a * c;
  expect(disc).toBeLessThan(0);
  return { re: -b / (2 * a), im: Math.sqrt(-disc) / (2 * a) };
};

const times = (a: number, b: number, c: number, d: number) =>
  [a * c - b * d, a * d + b * c] as const;

/** Coefficients highest power first (Horner). */
const p = (coeffs: number[], x: number) =>
  coeffs.reduce((acc, k) => acc * x + k, 0);

const EXAMPLES: Array<{ skillKey: string; stated: string; derive: () => string }> = [
  { skillKey: "seq_arithmetic_explicit", stated: "seq(1) gives 7", derive: () => `seq(1) gives ${seq(1)}` },
  {
    skillKey: "seq_recursive",
    stated: "term(4) gives 24",
    derive: () => {
      expect(termLoop(4)).toBe(termFormula(4));
      return `term(4) gives ${termLoop(4)}`;
    },
  },
  {
    skillKey: "series_geometric_sum",
    stated: "total(4) gives 15",
    derive: () => {
      // The sum formula the mission points at: 2ⁿ − 1.
      expect(totalLoop(4)).toBe(2 ** 4 - 1);
      return `total(4) gives ${totalLoop(4)}`;
    },
  },
  { skillKey: "series_infinite_geometric", stated: "partial(3) gives 1.75", derive: () => `partial(3) gives ${partial(3)}` },
  {
    skillKey: "log_evaluate",
    stated: "halvings(8) gives 4",
    // 8 → 4 → 2 → 1 → 0.5
    derive: () => `halvings(8) gives ${halvings(8)}`,
  },
  {
    skillKey: "exp_model_doubling_halflife",
    stated: "doublings(100, 3200) gives 5",
    derive: () => {
      expect(doublings(100, 3200)).toBe(Math.log2(3200 / 100));
      return `doublings(100, 3200) gives ${doublings(100, 3200)}`;
    },
  },
  {
    skillKey: "quad_complex_roots",
    stated: "roots(1, -4, 13) gives 2+3j and 2-3j",
    derive: () => {
      const { re, im } = complexRoots(1, -4, 13);
      return `roots(1, -4, 13) gives ${re}+${im}j and ${re}-${im}j`;
    },
  },
  {
    skillKey: "cx_multiply",
    stated: "times(7, 3, 7, -3) gives (58, 0)",
    derive: () => {
      const [re, im] = times(7, 3, 7, -3);
      return `times(7, 3, 7, -3) gives (${re}, ${Math.abs(im)})`;
    },
  },
  {
    skillKey: "poly_remainder_theorem",
    stated: "p([1, 0, -4], 3) gives 5",
    derive: () => `p([1, 0, -4], 3) gives ${p([1, 0, -4], 3)}`,
  },
];

describe("stated example results", () => {
  test("every mission with a number is in the table", () => {
    const covered = new Set(EXAMPLES.map((e) => e.skillKey));
    for (const m of CODE_IT_MISSIONS) {
      // fn_compose states no number: compose(f, g)(3) equals f(g(3)).
      if (m.skillKey === "fn_compose") continue;
      expect(covered.has(m.skillKey), m.skillKey).toBe(true);
    }
  });

  test.each(EXAMPLES.map((e) => [e.skillKey, e] as const))(
    "%s states the right answer",
    (_key, e) => {
      expect(e.derive()).toBe(e.stated);
      expect(codeItMissionFor(e.skillKey)?.mission).toContain(e.stated);
    },
  );
});
