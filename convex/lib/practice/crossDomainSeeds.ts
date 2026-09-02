/**
 * Mastery-gated cross-domain seeds for the homegrown math engine.
 *
 * The Rabbithole differentiator over a pure drill app: when a prerequisite
 * skill becomes FLUENT, a transdisciplinary exploration seed unlocks — "you
 * nailed multiplication; want to see the area of things?". Curiosity-first, but
 * curiosity needs a floor (a seed only fires once its gate skill is fluent, so
 * the leap is empowering, never "that thing you liked? you're bad at it"). The
 * seed surfaces in the Exploration / Sky lens via the existing `seeds` table.
 *
 * Pure data — the firing logic lives in convex/practiceSkills.ts (recordAttempt).
 */

// Type-only import (erased at build — no runtime/bundler coupling to the
// Next-side lib) so a spawned activity reuses the canonical kind taxonomy.
import type { ActivityKind } from "../../../lib/activityKinds";
import { FRACTION_ARITHMETIC_DOMAIN } from "../../seed/fractionArithmeticGraph";

export type CrossDomainSeed = {
  /** Fires once this whole-number-arithmetic skill is fluent+. */
  gateSkillKey: string;
  topic: string;
  scholarInvitation: string; // 2nd-person hook the kid reads (never names a gap)
  rationale: string; // teacher-facing
  connectionTo: string;
  /** When set, the seed is a cross-domain PRACTICE on-ramp: its Sky star's
   *  "practice this" invitation routes to THIS practice-drill domain (e.g. the
   *  fractions on-ramp routes to `fraction-arithmetic`), overriding the broad
   *  display-domain→drill allowlist (which would otherwise send a "Mathematics"
   *  star back to whole-number arithmetic — the on-ramp irony). A kebab-slug
   *  from the practice-domain registry (convex/lib/practice/domains.ts). */
  targetPracticeDomain?: string;
  // ── Wave-3 additions (TYPES ONLY — no runtime consumer yet) ────────────
  // Roadmap §7: replace the single `gateSkillKey` with a multi-signal gate
  // array (cross-domain + non-practice), and let a fired seed spawn a
  // concrete follow-up (an activity or a teacher ping). All OPTIONAL +
  // additive so today's `MATH_CROSS_DOMAIN_SEEDS` / `seedsGatedBy` compile
  // unchanged; the consumers land in Wave 3 (see review/practice §7).
  gates?: SeedGate[];
  gateMode?: "any" | "all"; // how to combine `gates` (default: "all")
  spawn?: SeedSpawn;
};

// A gate is a firing CONDITION (triggered, not restricted — passing a gate
// ADDS a seed, never removes one). Roadmap §7 ①.
export type SeedGate =
  // Fluency (≥ minReps) in a skill of any domain.
  | { kind: "practiceSkill"; domain: string; skillKey: string; minReps: number }
  // An observer-written signal crossed threshold (e.g. "persistence").
  | { kind: "observerSignal"; signalType: string }
  // The observer noted this (teacher-suggested) topic thread.
  | { kind: "topicMentioned"; topic: string };

// What a fired seed can produce beyond the Sky star itself. Roadmap §7 ②.
// The activity variant REUSES the canonical `ActivityKind` taxonomy (a
// type-only import — erased at build) rather than a parallel enum.
export type SeedSpawn =
  | { kind: "activity"; activityKind: ActivityKind; config?: Record<string, unknown> }
  | { kind: "teacherNotification"; note: string };

export const MATH_CROSS_DOMAIN_SEEDS: CrossDomainSeed[] = [
  {
    gateSkillKey: "skip_count_2s_5s_10s",
    topic: "Counting by 2s → odd, even, and how computers count (binary)",
    scholarInvitation: "You can count by 2s in your sleep — so why does a computer only know two numbers?",
    rationale: "Skip-counting is fluent — a natural bridge from even/odd into base-2 and how machines represent everything.",
    connectionTo: "Computer science & binary",
  },
  {
    gateSkillKey: "mult_facts_7_8_9",
    topic: "Times tables → hidden patterns (why the 9s digits always add to 9)",
    scholarInvitation: "Add the two digits of any 9× answer: 9, 18, 27… notice anything? Why does that happen?",
    rationale: "Multiplication facts are fluent — invite pattern-hunting (digit sums, finger tricks) to deepen number sense.",
    connectionTo: "Number theory & patterns",
  },
  {
    gateSkillKey: "division_with_remainders",
    topic: "Remainders → clock math (why 15:00 is 3 o'clock)",
    scholarInvitation: "If it's 9 o'clock and you wait 7 hours, it's 4 — not 16. What kind of math wraps around like that?",
    rationale: "Remainders are fluent — the doorway to modular arithmetic, clocks, calendars, and cryptography.",
    connectionTo: "Modular arithmetic & cryptography",
  },
  {
    gateSkillKey: "place_value_multidigit",
    topic: "Place value → how big is a billion, really? (Fermi estimation)",
    scholarInvitation: "How many grains of sand would fill your classroom? Could you even write that number?",
    rationale: "Multi-digit place value is fluent — stretch it into estimation of very large quantities.",
    connectionTo: "Estimation & scientific notation",
  },
  {
    gateSkillKey: "mult_2digit_by_2digit",
    topic: "Multiplication → the area of everything (rooms, fields, screens)",
    scholarInvitation: "Your screen is about 13 by 7 cm. How many tiny squares of light is that? Where else is multiplication secretly area?",
    rationale: "2×2-digit multiplication is fluent — bridge into area, arrays, and the geometry of multiplication.",
    connectionTo: "Geometry & measurement",
  },
  {
    gateSkillKey: "round_multidigit",
    topic: "Rounding → how scientists write giant and tiny numbers",
    scholarInvitation: "The Sun is 150,000,000 km away. Scientists write that as 1.5 × 10⁸. Why bother?",
    rationale: "Rounding multi-digit numbers is fluent — a natural lead-in to scientific notation and orders of magnitude.",
    connectionTo: "Science & scientific notation",
  },
  // ── Young entry-point seeds (raise-the-ceiling §2): the six above skew
  //    late-graph; these two fire early so a young scholar meets a
  //    transdisciplinary leap almost immediately. ──
  {
    gateSkillKey: "compose_ten",
    topic: "Making ten → the number systems people invented (Babylonian 60s, Mayan 20s)",
    scholarInvitation: "We group by tens — but the Babylonians grouped by sixties, which is why an hour has 60 minutes. What if we counted a different way?",
    rationale: "Composing ten is fluent — the doorway to asking why base-ten at all, and how other cultures built number systems.",
    connectionTo: "History of mathematics & number systems",
  },
  {
    gateSkillKey: "skip_count_3s_4s",
    topic: "Skip-counting → rhythm, beats, and time signatures in music",
    scholarInvitation: "Counting by 3s and 4s is exactly how music keeps time — 3/4 waltz, 4/4 rock. Can you hear the skip-count in a song?",
    rationale: "Skip-counting by 3s and 4s is fluent — a bridge from number patterns into musical meter and rhythm.",
    connectionTo: "Music & rhythm",
  },
  // ── Cross-domain on-ramp into the fractions graph (Wave D). The fraction
  //    graph is self-contained (no hard cross-domain prereq edge), so this seed
  //    is the curiosity bridge: equal-sharing division fluent ⇒ invite the
  //    scholar into fractions (a fraction IS a share that doesn't come out
  //    whole). Surfaces in the Sky/Exploration lens like the others. ──
  {
    gateSkillKey: "division_as_sharing",
    topic: "Sharing fairly → fractions (what if it doesn't come out even?)",
    scholarInvitation: "You can share 12 cookies among 4 friends. But what about 3 cookies among 4 friends? Everyone still gets a fair share — what do we call that piece?",
    rationale: "Equal-sharing division is fluent — the most natural conceptual doorway into fractions (a fraction is a division that doesn't land on a whole number).",
    connectionTo: "Fractions",
    // The one on-ramp with a real drill on the other side: route its "practice
    // this" invitation into the fractions engine, not back to whole-number.
    targetPracticeDomain: FRACTION_ARITHMETIC_DOMAIN,
  },
];

const BY_GATE = new Map<string, CrossDomainSeed[]>();
for (const s of MATH_CROSS_DOMAIN_SEEDS) {
  if (!BY_GATE.has(s.gateSkillKey)) BY_GATE.set(s.gateSkillKey, []);
  BY_GATE.get(s.gateSkillKey)!.push(s);
}

/** Cross-domain seeds whose gate is this skill (fired when it becomes fluent). */
export function seedsGatedBy(skillKey: string): CrossDomainSeed[] {
  return BY_GATE.get(skillKey) ?? [];
}
