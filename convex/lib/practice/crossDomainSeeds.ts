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
 * Card copy (`cardTitle` + `scholarInvitation` + `visualEmoji`) is written in
 * the story registry's voice, because a seed rides the SAME done-screen card a
 * world-connection story does (StoryMomentCard):
 *   - `cardTitle`: ≤7 words, gift-shaped — never a curriculum label ("X → Y").
 *   - `scholarInvitation`: ≤30 words, a TRUE declarative surprise that holds
 *     back the why. No instructions on the card ("work out", "list", "build");
 *     the steps live in `approachHint`, where the tutor uses them.
 *   - `visualEmoji`: one emoji naming the thing itself, never implying a false
 *     count (the charm-layer cicada test, .claude/rules/visual-design.md).
 *
 * `topic` is the minting idempotency key (maybeFireSeeds skips a topic the
 * scholar already holds) — NEVER rename one, or every seed re-offers to every
 * scholar. Rows minted before a copy rewrite keep their old text; readers
 * resolve the current copy by topic through `seedCardCopy`.
 *
 * Pure data — the firing logic lives in convex/practiceSkills.ts (recordAttempt).
 */

// Type-only import (erased at build — no runtime/bundler coupling to the
// Next-side lib) so a spawned activity reuses the canonical kind taxonomy.
import type { ActivityKind } from "../../../lib/activityKinds";
import { DISCRETE_MATH_DOMAIN } from "../../seed/discreteMathGraph";
import { EARLY_ALGEBRA_DOMAIN } from "../../seed/earlyAlgebraGraph";
import { FRACTION_ARITHMETIC_DOMAIN } from "../../seed/fractionArithmeticGraph";
import { GEOMETRY_MEASUREMENT_DOMAIN } from "../../seed/geometryMeasurementGraph";
import { INTEGERS_COORDINATES_DOMAIN } from "../../seed/integersCoordinatesGraph";
import { PROBABILITY_DOMAIN } from "../../seed/probabilityGraph";

export type CrossDomainSeed = {
  /** Fires once this whole-number-arithmetic skill is fluent+. */
  gateSkillKey: string;
  /** Minting idempotency key — never rename (see header). */
  topic: string;
  /** The card's headline: ≤7 words, a gift, never a curriculum label. */
  cardTitle: string;
  /** The card's hero glyph — names the thing itself (cicada test). */
  visualEmoji: string;
  /** The card teaser the kid reads: ≤30 words, a true surprise, withholding
   *  the why, no instructions (never names a gap). */
  scholarInvitation: string;
  rationale: string; // teacher-facing
  connectionTo: string;
  /** Private Socratic steering for the tutor's opening; flows to
   *  seeds.approachHint, which buildSeedOriginSection renders as "A way in". */
  approachHint?: string;
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
    cardTitle: "Two symbols run every computer",
    visualEmoji: "💻",
    scholarInvitation:
      "Every photo, song and game on a computer is stored using just two symbols, 0 and 1. With only those two, it can still count as high as you like.",
    rationale: "Skip-counting is fluent — a natural bridge from even/odd into base-2 and how machines represent everything.",
    connectionTo: "Computer science & binary",
    approachHint:
      "Start from what they already know: counting by 2s, and how every number is either even or odd. Ask how you could write 2, 3, 4 using only the symbols 0 and 1, and let them invent a scheme before you name binary. The big question to hold open: why would a machine want only two symbols?",
  },
  {
    gateSkillKey: "mult_facts_7_8_9",
    topic: "Times tables → hidden patterns (why the 9s digits always add to 9)",
    cardTitle: "The nines that always add to nine",
    visualEmoji: "9️⃣",
    scholarInvitation:
      "18, 27, 36, 45… add the two digits of any of them and you get 9. It keeps working all the way to 90, and it isn't luck.",
    rationale: "Multiplication facts are fluent — invite pattern-hunting (digit sums, finger tricks) to deepen number sense.",
    connectionTo: "Number theory & patterns",
    approachHint:
      "Have them write out the 9s from 9 × 1 to 9 × 10 and add the digits of each answer. Then ask what happens to the tens digit and the ones digit each time you add another 9. Let them find that one goes up as the other goes down before you explain why.",
  },
  {
    gateSkillKey: "division_with_remainders",
    topic: "Remainders → clock math (why 15:00 is 3 o'clock)",
    cardTitle: "Where 9 plus 7 makes 4",
    visualEmoji: "🕘",
    scholarInvitation:
      "On a clock, 9 o'clock plus 7 hours is 4 o'clock, not 16. That same wrap-around math quietly protects the secret messages your phone sends.",
    rationale: "Remainders are fluent — the doorway to modular arithmetic, clocks, calendars, and cryptography.",
    connectionTo: "Modular arithmetic & cryptography",
    approachHint:
      "Start with the clock: if it's 9 o'clock and you wait 7 hours, why is it 4 and not 16? Ask how they would get from 16 to 4, and connect it to the remainder when you divide by 12. Then ask what other things in life wrap around like that (days of the week, months).",
  },
  {
    gateSkillKey: "place_value_multidigit",
    topic: "Place value → how big is a billion, really? (Fermi estimation)",
    cardTitle: "How long is a billion seconds?",
    visualEmoji: "⏳",
    scholarInvitation:
      "A million seconds from now is less than two weeks away. A billion seconds from now is more than 30 years away.",
    rationale: "Multi-digit place value is fluent — stretch it into estimation of very large quantities.",
    connectionTo: "Estimation & scientific notation",
    approachHint:
      "Ask for a gut guess first: a million and a billion both sound huge, so why are their seconds so far apart? Let them count the zeros and the place-value jumps between the two. Then stretch into estimation: how many grains of sand would fill the classroom, and could they even write that number?",
  },
  {
    gateSkillKey: "mult_2digit_by_2digit",
    topic: "Multiplication → the area of everything (rooms, fields, screens)",
    cardTitle: "The grid hiding inside your screen",
    visualEmoji: "🖥️",
    scholarInvitation:
      "Your screen is a grid of tiny dots of light. A full HD screen has 1920 across and 1080 down, and nobody had to count them one by one.",
    rationale: "2×2-digit multiplication is fluent — bridge into area, arrays, and the geometry of multiplication.",
    connectionTo: "Geometry & measurement",
    approachHint:
      "Ask how you could find the number of dots without counting them, and let them reach for multiplication. Start smaller if needed: a screen about 13 by 7 cm, counted in tiny squares. Then ask where else multiplication is secretly area (floors, gardens, chessboards).",
  },
  {
    gateSkillKey: "round_multidigit",
    topic: "Rounding → how scientists write giant and tiny numbers",
    cardTitle: "How scientists shrink giant numbers",
    visualEmoji: "☀️",
    scholarInvitation:
      "The Sun is about 150,000,000 km away. Scientists squeeze that into 1.5 × 10⁸, and the same trick works for the width of an atom.",
    rationale: "Rounding multi-digit numbers is fluent — a natural lead-in to scientific notation and orders of magnitude.",
    connectionTo: "Science & scientific notation",
    approachHint:
      "Start with the Sun's distance and ask what the 10⁸ might be counting. Let them notice it is the number of places the digits shift, and that rounding is what makes 1.5 good enough. Then ask why a scientist would bother writing it this way at all.",
  },
  // ── Young entry-point seeds (raise-the-ceiling §2): the six above skew
  //    late-graph; these two fire early so a young scholar meets a
  //    transdisciplinary leap almost immediately. ──
  {
    gateSkillKey: "compose_ten",
    topic: "Making ten → the number systems people invented (Babylonian 60s, Mayan 20s)",
    cardTitle: "Why an hour has 60 minutes",
    visualEmoji: "⏰",
    scholarInvitation:
      "We count in tens. Thousands of years ago, the Babylonians counted in sixties, and you still use their system every time you read a clock.",
    rationale: "Composing ten is fluent — the doorway to asking why base-ten at all, and how other cultures built number systems.",
    connectionTo: "History of mathematics & number systems",
    approachHint:
      "Ask why we might group by tens at all (hint at fingers without saying it). Then bring in the Babylonians grouping by sixties, and the Maya grouping by twenties. What if we counted a different way: what would \"making ten\" become?",
  },
  {
    gateSkillKey: "skip_count_3s_4s",
    topic: "Skip-counting → rhythm, beats, and time signatures in music",
    cardTitle: "The counting hidden in every song",
    visualEmoji: "🥁",
    scholarInvitation:
      "A waltz counts in threes: ONE two three, ONE two three. Most pop songs count in fours. Your feet can feel the difference before you can name it.",
    rationale: "Skip-counting by 3s and 4s is fluent — a bridge from number patterns into musical meter and rhythm.",
    connectionTo: "Music & rhythm",
    approachHint:
      "Clap or tap a waltz (3s) and a march or rock beat (4s) and ask which beats get the loud count. Connect the loud beats to skip-counting: 1, 4, 7… for threes and 1, 5, 9… for fours. Can they hear the skip-count in a song they know?",
  },
  // ── Cross-domain on-ramp into the fractions graph (Wave D). The fraction
  //    graph is self-contained (no hard cross-domain prereq edge), so this seed
  //    is the curiosity bridge: equal-sharing division fluent ⇒ invite the
  //    scholar into fractions (a fraction IS a share that doesn't come out
  //    whole). Surfaces in the Sky/Exploration lens like the others. ──
  {
    gateSkillKey: "division_as_sharing",
    topic: "Sharing fairly → fractions (what if it doesn't come out even?)",
    cardTitle: "Three cookies, four friends",
    visualEmoji: "🍪",
    scholarInvitation:
      "Twelve cookies split evenly among four friends is easy. Three cookies among four friends sounds impossible, and yet everyone can still get exactly the same amount.",
    rationale: "Equal-sharing division is fluent — the most natural conceptual doorway into fractions (a fraction is a division that doesn't land on a whole number).",
    connectionTo: "Fractions",
    approachHint:
      "Let them propose how to cut 3 cookies so 4 friends get a fair share, drawing it if that helps. Once each friend has a share, ask what we call that piece and how they would write it.",
    // The one on-ramp with a real drill on the other side: route its "practice
    // this" invitation into the fractions engine, not back to whole-number.
    targetPracticeDomain: FRACTION_ARITHMETIC_DOMAIN,
  },
  // ── Math previews (2026-09): Carl's exposure list, gated on the highest-traffic whole-number nodes ──
  {
    gateSkillKey: "subtract_within_20",
    topic: "Subtracting past zero: is there a number to the left of 0?",
    cardTitle: "Where 5 minus 9 lands",
    visualEmoji: "🌡️",
    scholarInvitation:
      "Plenty of people say 5 − 9 can't be done. A thermometer does it on cold winter nights, and in many countries so does the elevator to the parking garage.",
    rationale:
      "Subtraction within 20 is fluent — pushing the same left-walk past zero lets the integers appear as a necessity rather than a rule to memorize.",
    connectionTo: "Negative numbers",
    approachHint:
      'You have been taught that 5 − 9 "can\'t be done." I do not think that is quite true — it just does not land where you are used to landing. Put your finger on 5, take one step left for each of the 9, and tell me the exact spot you finish on. What would you call that place?',
    targetPracticeDomain: INTEGERS_COORDINATES_DOMAIN,
  },
  {
    gateSkillKey: "mult_facts_3_4_6",
    topic: "Which numbers refuse to be a rectangle?",
    cardTitle: "The numbers that refuse to be rectangles",
    visualEmoji: "🧱",
    scholarInvitation:
      "12 dots can line up as a 3 by 4 rectangle or a 2 by 6. But 7, 11 or 13 dots only ever make one long line.",
    rationale:
      'Multiplication facts through 6 are fluent — turning "what times what" into which numbers have no factor pair but 1 and themselves is the concrete birth of primes.',
    connectionTo: "Prime numbers",
    approachHint:
      "You know your rectangles now: 12 dots snap into a 3-by-4 block. Some numbers of dots will only ever make a single long line, never a fuller rectangle. Take the numbers from 2 to 15, try to make a real rectangle out of each, and sort them into two piles. Which pile is which, and what do the stubborn ones have in common?",
  },
  {
    gateSkillKey: "two_step_expressions",
    topic: "4 + 3 × 2: why two careful kids get 14 and 10",
    cardTitle: "Two calculators, two answers",
    visualEmoji: "🧮",
    scholarInvitation:
      "A cheap calculator says 4 + 3 × 2 is 14. A phone says 10. Neither one is broken. Somebody had to decide which is right.",
    rationale:
      "The scholar just learned to honor precedence in two-step expressions — exposing the ambiguity shows order of operations is a decision people had to make, not a decree.",
    connectionTo: "Order of operations",
    approachHint:
      "Have them work out 4 + 3 × 2 by adding first, then again by multiplying first, so they see both answers come from the same three numbers. You already handled 4 + 3 × 2 by multiplying first. Here is the uncomfortable part: nothing in the symbols themselves stops someone from adding first and getting 14. If two people can read the same line and honestly disagree, what do you think mathematicians had to invent so a written expression means exactly one thing?",
    targetPracticeDomain: EARLY_ALGEBRA_DOMAIN,
  },
  {
    gateSkillKey: "common_factors",
    topic: "Different-looking fractions that are secretly the same",
    cardTitle: "Same pizza, different numbers",
    visualEmoji: "🍕",
    scholarInvitation:
      "6 slices of a pizza cut into 8, or 3 slices of the same pizza cut into 4: different numbers, different slices, exactly the same amount of pizza.",
    rationale:
      'Common factors are fluent — the exact tool for reducing a fraction to lowest terms, and the first move of "simplifying" that later becomes cancelling in algebra.',
    connectionTo: "Simplifying fractions",
    approachHint:
      "You found that 6 and 8 share the factor 2. Fold a paper strip to show 6 of 8 equal parts shaded, then fold another to show 3 of 4, and lay them side by side. If they cover the same length, what did dividing the top and bottom by that shared factor actually change, and what did it leave alone?",
    targetPracticeDomain: FRACTION_ARITHMETIC_DOMAIN,
  },
  {
    gateSkillKey: "mult_distributive",
    topic: "6 × 13 in two pieces — and what if 13 hides a letter?",
    cardTitle: "A shortcut that works on mysteries",
    visualEmoji: "✂️",
    scholarInvitation:
      "Splitting 6 × 13 into six tens and six threes still works when the 3 is a mystery number nobody knows yet. Algebra leans on that trick constantly.",
    rationale:
      "The distributive property is fluent as an arithmetic shortcut — replacing one number with a letter turns the same split into 6(10 + n) = 60 + 6n, the doorway to algebra.",
    connectionTo: "Algebraic expressions",
    approachHint:
      "You already break 6 × 13 into 6 × 10 and 6 × 3 and add them. Picture a rectangle 6 tall and 13 wide, sliced into a 6-by-10 part and a 6-by-3 part. Now imagine the wide side is 10 plus some length you don't know yet, labeled n. How would you write the two pieces then?",
    targetPracticeDomain: EARLY_ALGEBRA_DOMAIN,
  },
  {
    gateSkillKey: "area_model_multiplication",
    topic: "From a rectangle of squares to a box of cubes",
    cardTitle: "The box hiding in a rectangle",
    visualEmoji: "📦",
    scholarInvitation:
      "Sugar cubes come packed in layers, like flat rectangles stacked into a box. One flat layer already tells you almost everything about the whole box.",
    rationale:
      "The area model already sums unit squares by place value — extending the same partial-product thinking one dimension up reaches volume as stacked layers.",
    connectionTo: "Volume of boxes",
    approachHint:
      "Your area model tiles a rectangle with unit squares and adds the parts — say a 12-by-13 rectangle. Now give the rectangle a height by stacking four identical copies of it into a solid box. If one layer holds a certain number of squares, what does building it four layers tall do to the count, and what are you counting now instead of squares?",
    targetPracticeDomain: GEOMETRY_MEASUREMENT_DOMAIN,
  },
  {
    gateSkillKey: "add_within_20_regroup",
    topic: "Two dice: is a total of 7 as likely as a total of 12?",
    cardTitle: "Why dice love the number 7",
    visualEmoji: "🎲",
    scholarInvitation:
      "With two fair dice, a total of 7 turns up six times as often as a total of 12, on average. Neither die is loaded.",
    rationale:
      "Fluent within-20 addition lets the scholar enumerate all 36 dice outcomes themselves — the honest, countable foundation of probability as a fraction.",
    connectionTo: "Probability as fractions",
    approachHint:
      "Adding two dice is easy for you now, but here is a sneakier question: how many different ways can the two dice land to make a 7, and how many ways to make a 12? Write out the pairs for each. Once you have counted them, what does that tell you about which total you would bet on?",
    targetPracticeDomain: PROBABILITY_DOMAIN,
  },
  {
    gateSkillKey: "skip_count_2s_5s_10s",
    topic: "Skip-counting as a staircase: what decides how steeply it climbs",
    cardTitle: "The straight line inside skip-counting",
    visualEmoji: "📈",
    scholarInvitation:
      "Counting by 5s builds a staircase that climbs steeply. Counting by 2s builds a gentler one. Along the top of both, a perfectly straight line is hiding.",
    rationale:
      "Skip-counting is a constant rate — plotting it makes the count's size visible as steepness, an informal first meeting with slope and proportional lines.",
    connectionTo: "Rate and slope",
    approachHint:
      "When you skip-count by 5 you go 5, 10, 15, 20 — five more each time. Build a tower of squares for each step, standing them side by side, and slide your finger along the tops. Now picture the towers growing by only 2 each time. What is it about the size of each jump that decides how steeply the tops climb?",
  },
  {
    gateSkillKey: "mult_facts_0_1_2_5_10",
    topic: "Multiplying by 10 again and again: where do the zeros come from?",
    cardTitle: "A number with a hundred zeros",
    visualEmoji: "🔟",
    scholarInvitation:
      "A 1 followed by a hundred zeros is called a googol, and Google was named after it. There is a way to write it without counting a single zero.",
    rationale:
      "The ×10 fact is fluent — chaining it exposes the exponent as a count of how many times you multiplied, the meaning behind powers of ten before the notation arrives.",
    connectionTo: "Powers of ten",
    approachHint:
      "You multiply by 10 without thinking. Do it in a chain — 1, then 10, then 100, then 1000 — and keep a tally of how many multiplications you have done at each stop. Put your tally next to the number of zeros. What relationship do you notice, and could you predict the answer for twelve multiplications without writing the whole thing out?",
  },
  {
    gateSkillKey: "exponents_repeated_mult",
    topic: "Doubling a penny: why day 30 is not what you guess",
    cardTitle: "The penny that beats a million dollars",
    visualEmoji: "🪙",
    scholarInvitation:
      "A million dollars today, or one penny that doubles every day for a month? Almost everyone takes the million. Almost everyone is wrong.",
    rationale:
      "Exponents are understood as repeated multiplication — letting the scholar feel how violently that repetition explodes calibrates intuition against a number they can actually compute.",
    connectionTo: "Exponential growth",
    approachHint:
      "You read 2⁵ as five 2s multiplied together. Try a slow version: a penny that doubles every day for a month — day 1 is 1 cent, day 2 is 2, day 3 is 4. Before you compute anything, commit to a gut guess for the total on day 30. Now double your way there, one day at a time. What happened to your guess, and why do you think doubling fools almost everyone?",
  },
  // ── Math previews (2026-09), beyond the exposure list: puzzles for the add/subtract fluency ladder ──
  {
    gateSkillKey: "add_within_10",
    topic: "The addition table's mirror: why 3+6 and 6+3 match",
    cardTitle: "A table that folds onto itself",
    visualEmoji: "🪞",
    scholarInvitation:
      "An addition table folded corner to corner matches itself perfectly. Every sum lands on a matching number, like the two wings of a butterfly.",
    rationale:
      "Fluent single-digit sums let a scholar discover the commutative law as a visible symmetry rather than a stated rule.",
    connectionTo: "Symmetry & algebra",
    approachHint:
      'Have them fill in a small addition table, then build and physically fold or mirror it along the diagonal before naming anything; ask which squares land on top of each other. Steer toward two rows of dots that can be rotated, and toward a picture of why swapping the two numbers never changes the sum. Do not say "commutative" or state the law — let the mirror image carry it.',
  },
  {
    gateSkillKey: "subtract_within_10",
    topic: "Subtraction as distance: the gap between two numbers",
    cardTitle: "Take-away is secretly a distance",
    visualEmoji: "📏",
    scholarInvitation:
      "9 take away 4, and the distance between 4 and 9: two questions that sound nothing alike, with the same answer every single time.",
    rationale:
      "Fluent subtraction within 10 is the moment to reframe subtraction as measured distance, the idea underneath comparison and, later, the number line for negatives.",
    connectionTo: "Number line & distance",
    approachHint:
      'Anchor everything on a drawn number line and ask them to count gaps, not recall facts: one finger on 9, one on 4, how many steps apart, and does it matter which finger you count from? Try a few more pairs and check whether "take away" and "distance between" ever disagree. Do not tell them distance is symmetric — let them discover that 9−4 and the hop from 4 up to 9 give the same count.',
  },
  {
    gateSkillKey: "subtract_within_20",
    topic: "Odd or even? Predict a sum without adding it up",
    cardTitle: "The sum you can predict blind",
    visualEmoji: "🧦",
    scholarInvitation:
      "Someone picks two odd numbers and hides them. Without seeing either one, you can already say something true about their sum, for every pair there will ever be.",
    rationale:
      "Fluent add/subtract within 20 supplies the raw material to notice that parity is preserved by rules — a scholar's first invariant argument.",
    connectionTo: "Parity & proof",
    approachHint:
      'Have them add a few pairs of odd numbers (7 and 13, say) and guess whether the answer is always odd, always even, or depends. Push past "I tried five and they were even" toward "why must it be," offering pairing dots into twos as a representation. Do not hand them the odd+odd=even rule; the leap from examples to a reason is the whole exercise.',
    targetPracticeDomain: DISCRETE_MATH_DOMAIN,
  },
  {
    gateSkillKey: "add_within_20_regroup",
    topic: "Adding 1+2+...+10 the fast way (Gauss's trick)",
    cardTitle: "The boy who added in seconds",
    visualEmoji: "👦",
    scholarInvitation:
      "The story goes that a teacher set young Carl Gauss's class to add every number from 1 to 100. Gauss had it in moments, without adding one by one.",
    rationale:
      "Regrouping fluency supports the pairing insight behind triangular numbers and the closed form for 1+2+...+n.",
    connectionTo: "Triangular numbers",
    approachHint:
      "Start smaller than Gauss: 1 to 10. Let them add it the long way first so the shortcut feels earned, then ask what 1+10, 2+9, and 3+8 have in common. Do not reveal the pairing or the n(n+1)/2 formula; the pairs should be their discovery. Only then return to 1 to 100.",
  },
  {
    gateSkillKey: "add_subtract_fluency_within_20",
    topic: "Magic squares: nine numbers, one total every way",
    cardTitle: "The square on the turtle's shell",
    visualEmoji: "🐢",
    scholarInvitation:
      "A Chinese legend says a turtle climbed from a river with nine numbers on its shell. Every row, column and diagonal added to the same total. Only one pattern works.",
    rationale:
      "Instant recall within 20 frees the working memory that the constraint-juggling of a 3×3 magic square demands.",
    connectionTo: "Magic squares",
    approachHint:
      "The puzzle: place the numbers 1 through 9 in a 3-by-3 grid so every row, every column, and both diagonals add to the same total. Let them place freely and feel the constraints collide before reasoning about the center or the constant. Do not reveal that the magic sum is 15 or that 5 belongs in the middle; nudge them to add all nine numbers and split by three. (\"Only one way\" means up to rotations and flips.)",
  },
  {
    gateSkillKey: "mult_facts_3_4_6",
    topic: "How many handshakes if everyone greets everyone once?",
    cardTitle: "The handshake count that lies",
    visualEmoji: "🤝",
    scholarInvitation:
      "Six friends each shake hands with everyone else once. Each person shakes 5 hands, so that makes 30 handshakes. Except it doesn't, and the mistake is sneakier than it looks.",
    rationale:
      "Multiplication fluency lets a scholar organize the handshake count and meet the idea that each edge is shared by two people.",
    connectionTo: "Graph theory & handshakes",
    approachHint:
      "Start with small groups (3, then 4 people) and let them act it out or draw dots and lines, tabulating before generalizing to six. Do not give n(n−1)/2 or the double-counting explanation; ask why each person's 5 handshakes overcounts the total.",
    targetPracticeDomain: DISCRETE_MATH_DOMAIN,
  },
  {
    gateSkillKey: "add_3digit_regroup",
    topic: "Reverse and add: do all numbers fall into a palindrome?",
    cardTitle: "The number nobody can finish",
    visualEmoji: "🔁",
    scholarInvitation:
      "Flip 68 and add: 154. Again: 605. Again: 1111, the same both ways. Almost every number gets there fast. Computers have tried 196 for decades, and it never has.",
    rationale:
      "Multi-digit regrouping fluency powers the reverse-and-add loop — an open problem dressed as a drill.",
    connectionTo: "Palindromes & open problems",
    approachHint:
      "The loop: reverse a number's digits and add (68 + 86 = 154), and keep going until the result reads the same both ways. Let them run several easy cases to feel the pattern and notice which starting numbers get there quickly, then quietly point them at 89 or 196 to meet resistance. No one has ever found a palindrome for 196, and no one has proved there isn't one; share that only after they have wrestled with a hard case.",
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

const BY_TOPIC = new Map<string, CrossDomainSeed>(
  MATH_CROSS_DOMAIN_SEEDS.map((s) => [s.topic, s]),
);

/** What a scholar reads on a seed's card (done-screen card + Quests row). */
export type SeedCardCopy = {
  title: string;
  teaser: string;
  visualEmoji?: string;
};

/**
 * Resolve a seed row's card copy at READ time. A `seeds` row freezes the
 * registry text it was minted with, so a copy rewrite here would never reach
 * already-minted seeds; matching on `topic` (the minting idempotency key)
 * lets every reader show the current copy. Non-cross-domain seeds and topics
 * the registry no longer carries fall back to the row's own text.
 */
export function seedCardCopy(seed: {
  topic: string;
  suggestionType?: string;
  scholarInvitation?: string;
  rationale: string;
}): SeedCardCopy {
  const def =
    seed.suggestionType === "cross_domain" ? BY_TOPIC.get(seed.topic) : undefined;
  if (def) {
    return {
      title: def.cardTitle,
      teaser: def.scholarInvitation,
      visualEmoji: def.visualEmoji,
    };
  }
  return {
    title: seed.topic,
    teaser: seed.scholarInvitation ?? seed.rationale,
  };
}
