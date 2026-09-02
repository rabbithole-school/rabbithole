// ─── Rich-cohort seed: per-scholar math-practice mastery ───────────────────
//
// WHY THIS EXISTS. Without it, EVERY seeded scholar has zero `practiceMastery`,
// so the native/web practice flow only ever shows the cold-start placement band
// ("· mapping" skills). A tester can never randomly land on a realistic
// mid-journey "Today's blend" — because none exists in seed. This fixture gives
// ONE known scholar (leilani_park, Grade 3 — already the base seed's "rich Home
// fixture") a deterministic mid-journey practice state across TWO canonically
// mapped domains, so pressing Start serves a genuine, sustained, INTERLEAVED
// session out of the box (reviews + in-progress frontier, not a two-item
// dead-end). The inserter pairs these mastery rows with completed placement rows;
// mastery alone is shadow placement and must still enter the check-in.
//
// DETERMINISM ("predictability over realism", per CLAUDE.md): fixed skills, fixed
// repetitions, now-anchored clocks. Drift-guarded by convex/__tests__/richSeed.test.ts.
//
// SERVEABILITY: every `frontier: true` skill below is template-backed (see
// NEW_COVERAGE_SKILL_KEYS / T(...) in convex/lib/practice/templates.ts), so it
// serves items with NO stored pool and NO LLM call — the blend is non-empty in
// every seed environment, including convex-test. Fluent roots (`frontier: false`)
// decay slowly (halfLifeDays 100) and are practiced ~yesterday, so they are not
// due for review and never need an item.
//
// DEV-ONLY: the rich cohort is not part of db:seed:prod's base onboarding
// (enrolledFamilies), so this never reaches real prod scholars.

import type { SeedPracticeAttemptRow, SeedPracticeMasteryRow } from "./types";

export const practiceMastery: SeedPracticeMasteryRow[] = [
  // whole-number-arithmetic — fluent core, frontier at 3-digit place value/addition
  { scholarKey: "s.leilani", skillKey: "add_subtract_fluency_within_20", repetition: 3, frontier: false },
  { scholarKey: "s.leilani", skillKey: "place_value_to_1000", repetition: 3, frontier: false },
  { scholarKey: "s.leilani", skillKey: "add_3digit_no_regroup", repetition: 2, frontier: true },
  { scholarKey: "s.leilani", skillKey: "expanded_form_3digit", repetition: 1, frontier: true },

  // fraction-arithmetic — fluent concept, frontier at same-denominator/same-numerator comparison
  { scholarKey: "s.leilani", skillKey: "unit_fraction", repetition: 3, frontier: false },
  { scholarKey: "s.leilani", skillKey: "fraction_as_parts", repetition: 3, frontier: false },
  { scholarKey: "s.leilani", skillKey: "compare_same_denominator", repetition: 2, frontier: true },
  { scholarKey: "s.leilani", skillKey: "compare_same_numerator", repetition: 1, frontier: true },
];

// ─── Fictional MISS rows, WITH Option-2 snapshots ──────────────────────────
// practiceAttempts is otherwise empty in dev seed, so the new "recent misses"
// teacher surfaces render blank without this. A few misses per frontier skill
// above, deterministic clocks (predictability over realism). Every stem/answer
// here is made up for this fixture — not real scholar work.
export const practiceAttempts: SeedPracticeAttemptRow[] = [
  {
    scholarKey: "s.leilani",
    skillKey: "add_3digit_no_regroup",
    stem: "428 + 356",
    wrongAnswer: "684",
    expectedAnswer: "784",
    agoMinutes: 60 * 6,
  },
  {
    scholarKey: "s.leilani",
    skillKey: "add_3digit_no_regroup",
    stem: "512 + 234",
    wrongAnswer: "756",
    expectedAnswer: "746",
    agoMinutes: 60 * 30,
  },
  {
    scholarKey: "s.leilani",
    skillKey: "expanded_form_3digit",
    stem: "Write 407 in expanded form.",
    wrongAnswer: "400 + 70",
    expectedAnswer: "400 + 0 + 7",
    agoMinutes: 60 * 10,
  },
  {
    scholarKey: "s.leilani",
    skillKey: "compare_same_denominator",
    stem: "Compare: 3/8 ___ 5/8",
    wrongAnswer: ">",
    expectedAnswer: "<",
    agoMinutes: 60 * 3,
  },
  {
    scholarKey: "s.leilani",
    skillKey: "compare_same_denominator",
    stem: "Compare: 7/10 ___ 4/10",
    wrongAnswer: "<",
    expectedAnswer: ">",
    agoMinutes: 60 * 48,
  },
  {
    scholarKey: "s.leilani",
    skillKey: "compare_same_numerator",
    stem: "Compare: 2/5 ___ 2/3",
    wrongAnswer: ">",
    expectedAnswer: "<",
    agoMinutes: 60 * 20,
  },
];
