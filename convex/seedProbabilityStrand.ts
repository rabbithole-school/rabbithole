// Inserts the hand-authored "Probability" curriculum strand — three real
// units that give the probability practice DOMAIN (convex/seed/probabilityGraph.ts)
// a home in the curriculum, so the tactile dice/coin manipulative is reachable
// through a normal unit → practice activity instead of only a dev deep link.
//
// Pedagogy: a ceiling-raising probability preview for gifted 5th graders
// (CCSS 7.SP enrichment). Each unit is Socratic — the tutor lessons withhold
// formulas and press for reasoning — and each unit ends in a `problem_set`
// activity that draws adaptively from the probability skill frontier. Because
// the dev seed also seeds manipulative practice items for
// sample_space / theoretical_probability_simple / probability_as_fraction /
// compound_two_dice, every unit's practice serves the dice/coin manipulative.
//
// The three units walk the probability graph's four strands in DAG order:
//   1. Chance & Likelihood   — chance + naming outcomes (likelihood_scale, sample_space)
//   2. Counting the Odds     — theoretical probability as a fraction + complements
//   3. Rolling the Truth     — experimental probability, the long run, and two dice
//
// Called from seedData.seedAll (runs on dev AND prod), it is IDEMPOTENT by
// slug: if the first unit already exists it inserts nothing, so a repeated
// non-destructive seed never duplicates the strand.
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeGranules } from "./lib/granules";
import { PROBABILITY_DOMAIN } from "./seed/probabilityGraph";
import { scheduleProblemSetItemGeneration } from "./practiceSkills";

type LessonStrand = NonNullable<Doc<"lessons">["strand"]>;

type ActivityDef =
  | {
      kind: "online";
      title: string;
      description: string;
      scholarDescription?: string;
      systemPrompt: string;
      durationMinutes?: number;
    }
  | {
      kind: "problem_set";
      title: string;
      description: string;
      scholarDescription?: string;
      targetSkillKeys: string[];
      itemCount?: number;
      durationMinutes?: number;
    };

type LessonDef = {
  title: string;
  strand: LessonStrand;
  systemPrompt: string;
  durationMinutes?: number;
  activities: ActivityDef[];
};

type UnitDef = {
  title: string;
  slug: string;
  emoji: string;
  gradeLevel: string;
  targetBloomLevel: NonNullable<Doc<"units">["targetBloomLevel"]>;
  bigIdea: string;
  description: string;
  scholarDescription: string;
  essentialQuestions: string[];
  enduringUnderstandings: string[];
  badge: { title: string; description: string; icon: string };
  lessons: LessonDef[];
};

// The `?activity=` practice route serves items drawn from these skills' frontier;
// the domain MUST be "probability" so the scheduler loads the probability graph.
const DOMAIN = PROBABILITY_DOMAIN;

export const PROBABILITY_STRAND: UnitDef[] = [
  {
    title: "Chance & Likelihood",
    slug: "probability-chance-and-likelihood",
    emoji: "🎲",
    gradeLevel: "Grade 5 enrichment",
    targetBloomLevel: "understand",
    bigIdea:
      "Before anything happens, we can still reason precisely about chance — by placing an event on a 0-to-1 likelihood scale and by naming every possible outcome first.",
    description:
      "A ceiling-raising opener to probability. Scholars move from vague 'it might happen' language to placing events on an impossible-to-certain line and listing the full sample space for dice and coins before making any prediction.",
    scholarDescription:
      "You'll go from 'it might happen' to reasoning precisely about chance — placing events on a likelihood line and naming every outcome that's possible before you predict anything.",
    essentialQuestions: [
      "How can we talk precisely about chance before we know what will happen?",
      "What has to be true before we can say two outcomes are equally likely?",
    ],
    enduringUnderstandings: [
      "Every event sits somewhere on a 0-to-1 scale, from impossible to certain.",
      "A sample space names every possible outcome, so any prediction starts by asking what could happen.",
    ],
    badge: {
      title: "Likelihood Navigator",
      description:
        "Placed events on the likelihood line and named the full sample space before predicting.",
      icon: "🧭",
    },
    lessons: [
      {
        title: "The likelihood line",
        strand: "core",
        durationMinutes: 30,
        systemPrompt:
          "This is enrichment — a warm preview of CCSS 7.SP.C.5, not a grade-level requirement. Help the scholar place events (e.g. 'roll a 7 on one die', 'flip heads', 'roll a number less than 7') on a line from impossible (0) to certain (1). Withhold numbers at first: press for their reasoning about WHY one event sits left or right of another. Only after they've ordered events by feel, invite them to attach rough fractions. Target idea: likelihood_scale.",
        activities: [
          {
            kind: "online",
            title: "Order the chances",
            description:
              "Sort everyday and dice/coin events from impossible to certain, then defend the order.",
            scholarDescription:
              "You'll sort everyday, dice, and coin events from impossible to certain, then explain your choices.",
            durationMinutes: 30,
            systemPrompt:
              "Ask the scholar to sort a mix of events from impossible to certain and justify each placement. Use the in-app die and coin so they can test intuitions, but do not treat a few rolls as proof. Keep asking 'what would make this more or less likely?' Withhold the 0-to-1 numeric scale until they've reasoned qualitatively. Target idea: likelihood_scale.",
          },
        ],
      },
      {
        title: "Name every outcome",
        strand: "core",
        durationMinutes: 30,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.7. Before judging any likelihood, have the scholar list the complete sample space for one fair die (1–6), one fair coin (H, T), and then a die and coin together. Press for completeness: 'are you sure that's all of them? how do you know none are missing?' Do not hand them a counting formula; let the organized list be the tool. Target idea: sample_space.",
        activities: [
          {
            kind: "online",
            title: "List the whole sample space",
            description:
              "Build the complete set of outcomes for a die, a coin, and the two together.",
            scholarDescription:
              "You'll list every possible outcome for a die, a coin, and both together.",
            durationMinutes: 30,
            systemPrompt:
              "Guide the scholar to organize outcomes systematically (a list or a small table) rather than guessing. When they combine a die and a coin, ask how the total number of outcomes relates to each one alone — but let them notice the pattern, don't state it. Target idea: sample_space.",
          },
          {
            kind: "problem_set",
            title: "Practice: chance & outcomes",
            description:
              "Adaptive practice naming sample spaces with a tactile dice/coin manipulative. Placing events on the likelihood scale is covered in the lessons.",
            scholarDescription:
              "You'll practice naming possible outcomes and comparing chances with dice and coins.",
            targetSkillKeys: ["likelihood_scale", "sample_space"],
            itemCount: 8,
            durationMinutes: 15,
          },
        ],
      },
    ],
  },
  {
    title: "Counting the Odds",
    slug: "probability-counting-the-odds",
    emoji: "🎯",
    gradeLevel: "Grade 5 enrichment",
    targetBloomLevel: "apply",
    bigIdea:
      "When outcomes are equally likely, probability is a fraction — favorable outcomes over total — that you can simplify, compare, and flip with its complement.",
    description:
      "Scholars turn 'what are the chances?' into a precise fraction of favorable outcomes over all equally likely outcomes, then discover the complement as a first elegant shortcut. A direct bridge from fraction sense to probability.",
    scholarDescription:
      "You'll turn 'what are the chances?' into an exact fraction — favorable outcomes over total — and learn the complement trick for finding the chance something does NOT happen.",
    essentialQuestions: [
      "Why is a probability a fraction?",
      "If you know the chance something happens, what do you instantly know about it NOT happening?",
    ],
    enduringUnderstandings: [
      "Theoretical probability compares favorable outcomes to all equally likely outcomes — the same part-whole idea fraction sense uses.",
      "An event and its complement together fill the whole sample space, so their probabilities sum to 1.",
    ],
    badge: {
      title: "Odds Reckoner",
      description:
        "Wrote probabilities as fractions of a sample space and used the complement to reason about what won't happen.",
      icon: "🎯",
    },
    lessons: [
      {
        title: "Favorable out of total",
        strand: "core",
        durationMinutes: 35,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.7a. Build on the sample space from the last unit: the probability of an event with equally likely outcomes is favorable outcomes ÷ total outcomes. Have the scholar identify the favorable set for events like 'roll an even number' before counting. Withhold the formula name; let them rediscover the part-whole structure. Target idea: theoretical_probability_simple.",
        activities: [
          {
            kind: "online",
            title: "Count favorable, count total",
            description:
              "Find theoretical probability by comparing favorable outcomes to the whole sample space.",
            scholarDescription:
              "You'll find the outcomes you want and compare them with all the possible outcomes.",
            durationMinutes: 35,
            systemPrompt:
              "For each event, ask the scholar to name the favorable outcomes and the total outcomes separately before combining them. Use the in-app die to check intuition, but ground the answer in the sample space, not the rolls. Target idea: theoretical_probability_simple.",
          },
        ],
      },
      {
        title: "Chance as a fraction",
        strand: "core",
        durationMinutes: 35,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.5. Bridge EXPLICITLY to fraction sense: a probability is a fraction that can be simplified, compared, and interpreted like any other. Ask the scholar to write P(event) as a fraction, then simplify it and say what the simplified form means. If they're ready, compare two events' probabilities as fractions. Target idea: probability_as_fraction.",
        activities: [
          {
            kind: "online",
            title: "Write it, simplify it, read it",
            description:
              "Express probabilities as fractions, simplify, and interpret what the fraction says about chance.",
            scholarDescription:
              "You'll write chances as fractions, simplify them, and say what they mean.",
            durationMinutes: 35,
            systemPrompt:
              "Connect back to Fraction Sense: 3/6 chance of even is the same 3/6 they'd simplify anywhere. Ask what a probability of 0, 1, or 1/2 feels like. Press for interpretation, not just arithmetic. Target idea: probability_as_fraction.",
          },
        ],
      },
      {
        title: "The other side: complements",
        strand: "connections",
        durationMinutes: 30,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.5. Lead the scholar to notice that 'not this event' fills the rest of the sample space, so P(event) + P(not event) = 1. Let them discover it by adding the two fractions rather than being told. Ask when computing the complement is easier than counting directly. Target idea: complement_probability.",
        activities: [
          {
            kind: "online",
            title: "What's left over?",
            description:
              "Use the complement to find the probability of an event NOT happening.",
            scholarDescription:
              "You'll find the chance something does not happen by looking at what is left.",
            durationMinutes: 30,
            systemPrompt:
              "Pose events where the complement is the easier count (e.g. 'not a 6'). Have the scholar verify that the two fractions sum to the whole. Withhold the 1 − P shortcut until they've seen the parts complete the whole. Target idea: complement_probability.",
          },
          {
            kind: "problem_set",
            title: "Practice: theoretical probability",
            description:
              "Adaptive practice writing probabilities as fractions and using complements — with a tactile dice/coin manipulative.",
            scholarDescription:
              "You'll practice finding chances as fractions and using what is left over.",
            targetSkillKeys: [
              "theoretical_probability_simple",
              "probability_as_fraction",
              "complement_probability",
            ],
            itemCount: 8,
            durationMinutes: 15,
          },
        ],
      },
    ],
  },
  {
    title: "Rolling the Truth",
    slug: "probability-rolling-the-truth",
    emoji: "🎲",
    gradeLevel: "Grade 5 enrichment",
    targetBloomLevel: "analyze",
    bigIdea:
      "Real trials wobble around the theoretical answer — the more you roll, the closer you get — and two dice reveal why some totals are far more likely than others.",
    description:
      "Scholars gather real roll data and watch experimental probability settle toward the theoretical value as trials grow, use probability to forecast how often something should happen, and build the two-dice sample space to see why middle totals dominate.",
    scholarDescription:
      "You'll roll for real and watch the results creep toward the theory as trials pile up, forecast how often something should happen, and uncover why 7 beats 2 when you roll two dice.",
    essentialQuestions: [
      "Why don't real rolls match the theoretical probability exactly — and what changes as you roll more?",
      "When you roll two dice, why is a total of 7 so much more common than a total of 2?",
    ],
    enduringUnderstandings: [
      "Experimental probability estimates chance from trials and settles toward the theoretical value as the number of trials grows (the law of large numbers).",
      "A compound event's likelihood depends on how many ways it can happen across the full two-dice sample space.",
    ],
    badge: {
      title: "Long-Run Thinker",
      description:
        "Compared experiment to theory over many trials and mapped the two-dice sample space.",
      icon: "📈",
    },
    lessons: [
      {
        title: "What the rolls say",
        strand: "core",
        durationMinutes: 35,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.6. Have the scholar estimate a probability from actual trial data (a run of rolls or flips) and compare it to the theoretical value. Name the gap without judgment — a short run is expected to wobble. Ask: 'is your estimate above or below the theory, and would you bet it stays there?' Target idea: experimental_probability.",
        activities: [
          {
            kind: "online",
            title: "Estimate from your data",
            description:
              "Roll a handful of times and estimate a probability from what actually happened.",
            scholarDescription:
              "You'll roll, keep track of what happens, and estimate a chance from your data.",
            durationMinutes: 35,
            systemPrompt:
              "Use the in-app die/coin (the Roll ×10 batch is ideal). Have the scholar tally outcomes and write the experimental probability as a fraction, then compare to theory. Do not call a mismatch 'wrong' — it's the wobble of small samples. Target idea: experimental_probability.",
          },
        ],
      },
      {
        title: "The more you roll",
        strand: "core",
        durationMinutes: 35,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.6. Lead the scholar to notice that more trials usually shrink the gap between experiment and theory (the law of large numbers). Have them compare a 10-roll estimate to a much larger batch. Ask why a single lucky streak matters less as trials grow. Let them articulate it before you name it. Target idea: law_of_large_numbers.",
        activities: [
          {
            kind: "online",
            title: "Watch it settle",
            description:
              "Compare small and large batches of rolls and describe how the estimate stabilizes.",
            scholarDescription:
              "You'll compare small and large sets of rolls to see how estimates change.",
            durationMinutes: 35,
            systemPrompt:
              "Use Roll ×10 repeatedly to accumulate trials. Ask the scholar to predict what happens to the estimate as the count climbs, then check. Press for WHY the wiggle shrinks, not just that it does. Target idea: law_of_large_numbers.",
          },
        ],
      },
      {
        title: "Predicting how often",
        strand: "connections",
        durationMinutes: 30,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.6. Scale a probability up to a number of trials: if P(even) = 1/2, about how many evens in 30 rolls? Have the scholar reason with the fraction before computing, then check against a real batch and discuss why 'about' is the honest word. Target idea: expected_frequency.",
        activities: [
          {
            kind: "online",
            title: "How many should we expect?",
            description:
              "Turn a probability into a forecast for how often an outcome should occur over many trials.",
            scholarDescription:
              "You'll use a chance to forecast how often something may happen in many tries.",
            durationMinutes: 30,
            systemPrompt:
              "Ask the scholar to forecast a count from a probability (probability × trials), then run trials to compare. Emphasize that the forecast is a center, not a guarantee. Target idea: expected_frequency.",
          },
        ],
      },
      {
        title: "Two dice, uneven odds",
        strand: "connections",
        durationMinutes: 40,
        systemPrompt:
          "Enrichment preview of CCSS 7.SP.C.8. Have the scholar build the 6×6 sample space of two dice and count the ways to make each total. Keep it Socratic: ask how many ways make 2 versus 7 rather than revealing that 7 is most likely. Connect the shape of the distribution back to the counts. Target idea: compound_two_dice.",
        activities: [
          {
            kind: "online",
            title: "Map the two-dice totals",
            description:
              "Build the two-dice sample space and count the ways to make each total from 2 to 12.",
            scholarDescription:
              "You'll map all the totals from two dice and count the ways each total can happen.",
            durationMinutes: 40,
            systemPrompt:
              "Guide the scholar to a 6×6 grid of the 36 equally likely outcomes and have them count the ways for each total. Use the two-dice roller (and Roll ×10) to test their prediction about which totals win. Let them discover the triangular shape. Target idea: compound_two_dice.",
          },
          {
            kind: "problem_set",
            title: "Practice: experiments & two dice",
            description:
              "Adaptive practice on experimental probability, expected frequency, and two-dice totals — with a tactile dice manipulative.",
            scholarDescription:
              "You'll practice using roll data, forecasts, and two-dice totals.",
            targetSkillKeys: [
              "experimental_probability",
              "expected_frequency",
              "compound_two_dice",
            ],
            itemCount: 8,
            durationMinutes: 15,
          },
        ],
      },
    ],
  },
];

/**
 * Insert the Probability strand (3 units → lessons → activities) owned by
 * `teacherId`. Idempotent by slug: if the first unit already exists, inserts
 * nothing and returns 0. Returns the number of units inserted.
 */
export async function insertProbabilityStrand(
  ctx: MutationCtx,
  teacherId: Id<"users">,
): Promise<number> {
  const firstSlug = PROBABILITY_STRAND[0].slug;
  const already = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", firstSlug))
    .first();
  if (already) return 0;

  for (const u of PROBABILITY_STRAND) {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: u.title,
      slug: u.slug,
      emoji: u.emoji,
      subject: "Mathematics",
      gradeLevel: u.gradeLevel,
      targetBloomLevel: u.targetBloomLevel,
      bigIdea: u.bigIdea,
      description: u.description,
      scholarDescription: u.scholarDescription,
      essentialQuestions: normalizeGranules(u.essentialQuestions, "eq"),
      enduringUnderstandings: normalizeGranules(u.enduringUnderstandings, "eu"),
      mathDomain: DOMAIN,
      badgeOnCompletion: u.badge,
      isActive: true,
    });
    for (let li = 0; li < u.lessons.length; li++) {
      const l = u.lessons[li];
      const lessonId = await ctx.db.insert("lessons", {
        unitId,
        title: l.title,
        order: li,
        strand: l.strand,
        systemPrompt: l.systemPrompt,
        durationMinutes: l.durationMinutes,
      });
      for (let ai = 0; ai < l.activities.length; ai++) {
        const a = l.activities[ai];
        if (a.kind === "problem_set") {
          const activityId = await ctx.db.insert("activities", {
            lessonId,
            title: a.title,
            order: ai,
            kind: "problem_set",
            description: a.description,
            scholarDescription: a.scholarDescription,
            durationMinutes: a.durationMinutes,
            problemSet: {
              domain: DOMAIN,
              targetSkillKeys: a.targetSkillKeys,
              itemCount: a.itemCount,
            },
          });
          await scheduleProblemSetItemGeneration(ctx, activityId);
        } else {
          await ctx.db.insert("activities", {
            lessonId,
            title: a.title,
            order: ai,
            kind: "online",
            description: a.description,
            scholarDescription: a.scholarDescription,
            systemPrompt: a.systemPrompt,
            durationMinutes: a.durationMinutes,
          });
        }
      }
    }
  }

  return PROBABILITY_STRAND.length;
}

/**
 * Standalone runner for the Probability strand — resolves the system teacher
 * (falling back to any teacher) and inserts the strand. Idempotent (skips if
 * already present). Run with:
 *   npx convex run seedProbabilityStrand:seedProbabilityStrand
 * Safe to run on dev now and to promote the strand to prod later without
 * re-running the whole base seed.
 */
export const seedProbabilityStrand = internalMutation({
  args: {},
  handler: async (ctx) => {
    const systemTeacher = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", "system@rabbithole.app"))
      .first();
    const teacher =
      systemTeacher ??
      (await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("role"), "teacher"))
        .first());
    if (!teacher) {
      return { inserted: 0, note: "No teacher found; cannot seed." };
    }
    const inserted = await insertProbabilityStrand(ctx, teacher._id);
    return { inserted };
  },
});
