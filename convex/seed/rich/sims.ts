// ─── Rich-cohort seed: SIMS data ──────────────────────────────────────────
//
// Curriculum-quality / design-facing fixtures for the "Fraction Sense" unit.
// Daniel ran a two-profile baseline experiment against a.fractions.baseline,
// reviewed the unit, reflected on what worked, and triaged the Leilani
// misconception moment that surfaced.

import type {
  SeedSyntheticProfile,
  SeedExperiment,
  SeedVariant,
  SeedSimulatedSession,
  SeedGroundedVerdict,
  SeedUnitReview,
  SeedActivityReflection,
  SeedMomentTriage,
} from "./types";

// ── Score builders ────────────────────────────────────────────────────────
// Mirror lib/curriculumScore.Aggregate + lib/curriculumGround.Calibration so
// the Debrief surface and the unit-maturity ladder read real-shaped data.
// fitness = mean of the three FITNESS_DIMS (goalAttainment, deliverableReach,
// productiveStruggle); >= 3.5 marks an activity "rehearsed/passing".
const ALL_DIMS = [
  "goalAttainment",
  "deliverableReach",
  "productiveStruggle",
  "socratic",
  "cognitiveOffloading",
  "noSpoilers",
  "sycophancy",
  "ageFit",
  "depth",
  "complexity",
  "abstraction",
  "inquiry",
  "authenticity",
  "singleSpine",
  "discoveryArc",
  "handsOnMission",
  "earnedPayoff",
] as const;
type DimName = (typeof ALL_DIMS)[number];
type Dims = Record<DimName, number>;

const round2 = (x: number) => Math.round(x * 100) / 100;

function mkAggregate(dims: Dims, goalAttainmentRate: number, n: number) {
  const fitness = round2(
    (dims.goalAttainment + dims.deliverableReach + dims.productiveStruggle) / 3,
  );
  return { dims, goalAttainmentRate, fitness, n };
}

// Phase-4 grounding: compares the sim aggregate against a REAL-transcript
// aggregate. trustworthy = |Δfitness| <= threshold. Shape matches what
// curriculumSim writes: { status:"done", realAggregate, ...Calibration }.
function mkGrounding(
  simDims: Dims,
  realDims: Dims,
  realRate: number,
  realN: number,
  note: string,
) {
  const real = mkAggregate(realDims, realRate, realN);
  const sim = mkAggregate(simDims, realRate, realN);
  const threshold = 0.5;
  const fitnessDelta = round2(sim.fitness - real.fitness);
  const perDim = {} as Record<DimName, { sim: number; real: number; delta: number }>;
  for (const d of ALL_DIMS) {
    perDim[d] = { sim: simDims[d], real: realDims[d], delta: round2(simDims[d] - realDims[d]) };
  }
  return {
    status: "done" as const,
    realAggregate: real,
    perDim,
    fitnessDelta,
    threshold,
    trustworthy: Math.abs(fitnessDelta) <= threshold,
    realN,
    note,
  };
}

// Sim + real dim profiles for the matured Fraction Sense activities.
const fractionsBaselineSimDims: Dims = {
  goalAttainment: 4.3,
  deliverableReach: 4.0,
  productiveStruggle: 4.1,
  socratic: 4.4,
  cognitiveOffloading: 4.2,
  noSpoilers: 4.5,
  sycophancy: 4.3,
  ageFit: 4.4,
  depth: 3.9,
  complexity: 3.7,
  abstraction: 3.8,
  inquiry: 4.1,
  authenticity: 4.2,
  singleSpine: 4.4,
  discoveryArc: 4.2,
  handsOnMission: 4.5,
  earnedPayoff: 3.8,
};
const fractionsBaselineRealDims: Dims = {
  goalAttainment: 4.0,
  deliverableReach: 3.8,
  productiveStruggle: 4.2,
  socratic: 4.3,
  cognitiveOffloading: 4.1,
  noSpoilers: 4.4,
  sycophancy: 4.2,
  ageFit: 4.3,
  depth: 3.8,
  complexity: 3.6,
  abstraction: 3.7,
  inquiry: 4.0,
  authenticity: 4.1,
  singleSpine: 4.2,
  discoveryArc: 4.0,
  handsOnMission: 4.4,
  earnedPayoff: 3.7,
};
const fractionsEquivSimDims: Dims = {
  goalAttainment: 3.9,
  deliverableReach: 4.0,
  productiveStruggle: 3.8,
  socratic: 4.2,
  cognitiveOffloading: 4.0,
  noSpoilers: 4.3,
  sycophancy: 4.1,
  ageFit: 4.2,
  depth: 4.0,
  complexity: 3.9,
  abstraction: 4.1,
  inquiry: 4.0,
  authenticity: 4.0,
  singleSpine: 4.3,
  discoveryArc: 4.4,
  handsOnMission: 3.6,
  earnedPayoff: 4.1,
};
const fractionsEquivRealDims: Dims = {
  goalAttainment: 3.7,
  deliverableReach: 3.9,
  productiveStruggle: 3.9,
  socratic: 4.1,
  cognitiveOffloading: 3.9,
  noSpoilers: 4.2,
  sycophancy: 4.0,
  ageFit: 4.1,
  depth: 3.9,
  complexity: 3.8,
  abstraction: 4.0,
  inquiry: 3.9,
  authenticity: 3.9,
  singleSpine: 4.1,
  discoveryArc: 4.2,
  handsOnMission: 3.5,
  earnedPayoff: 3.9,
};

export const syntheticProfiles: SeedSyntheticProfile[] = [
  {
    key: "sp.eager",
    ownerKey: "t.daniel",
    name: "Eager Ezra",
    readingLevel: "Grade 4",
    dossier:
      "Ezra races ahead — he blurts an answer after one sentence and moves on without checking. He loves the feeling of being right and gets bored the moment something feels easy. Needs prompts that force him to slow down and justify his thinking.",
    traits: ["jumps to answers", "loves a challenge"],
    archetype: "fast starter",
  },
  {
    key: "sp.cautious",
    ownerKey: "t.daniel",
    name: "Cautious Cora",
    readingLevel: "Grade 3",
    dossier:
      "Cora takes her time and second-guesses every response before sharing. She understands more than she lets on but needs encouragement to commit. She thrives when the tutor normalizes uncertainty as part of good thinking rather than a sign of failure.",
    traits: ["second-guesses", "needs encouragement"],
    archetype: "perfectionist",
  },

  // ── Shard 2 synthetic profile (owned by t.kawena) ─────────────────────────
  {
    key: "sp.wide-narrator",
    ownerKey: "t.kawena",
    name: "Wide-Scope Wren",
    readingLevel: "Grade 2",
    dossier:
      "Wren always tells the whole story — the entire vacation, the whole game, the full day. She has rich oral recall but resists narrowing because she's afraid of leaving out something important. Needs gentle but firm 'zoom in' prompts and a concrete model of what a zoomed-in moment looks like before she can do it independently.",
    traits: ["over-broad scope", "rich oral recall", "reluctant to narrow"],
    archetype: "summarizer",
  },
];

export const experiments: SeedExperiment[] = [
  {
    key: "exp.fractions.baseline",
    activityKey: "a.fractions.baseline",
    teacherKey: "t.daniel",
    mode: "analyze",
    castProfileKeys: ["sp.eager", "sp.cautious"],
    maxTurns: 8,
    learningGoal:
      "Surface each scholar's existing mental model of fractions — especially whether they see equal parts as essential to a fraction's meaning — without correcting misconceptions.",
    status: "done",
    sessionsDone: 2,
    sessionsTotal: 2,
    baselineVariantKey: "var.fractions.baseline.v0",
    startedAgoDays: 3,
    finishedAgoDays: 3,
    overallVerdict:
      "The prompt successfully elicits prior thinking from both profiles. Eager Ezra surfaces a procedural shortcut early; Cautious Cora engages but needs two extra turns of encouragement before committing to a model.",
    grounding: mkGrounding(
      fractionsBaselineSimDims,
      fractionsBaselineRealDims,
      0.83,
      6,
      "Sim fitness tracks real scholars within the noise floor (Δ0.13 < 0.5). The baseline prompt's read on prior thinking holds up against the Honu pod's real transcripts — trustworthy proxy.",
    ),
  },
  {
    // Phase-2 propose run on the equivalence task — the second online activity.
    // A passing variant here is what lets the unit clear the Rehearsed rung
    // (every online activity must pass), and its grounding completes Debriefed.
    key: "exp.fractions.equivalence",
    activityKey: "a.fractions.equivalence",
    teacherKey: "t.daniel",
    mode: "propose",
    castProfileKeys: ["sp.eager", "sp.cautious"],
    maxTurns: 10,
    learningGoal:
      "Get each scholar to construct and justify why 1/2 = 2/4 using equal-parts reasoning, producing a drawing or explanation that names the doubling of both numerator and denominator.",
    status: "done",
    sessionsDone: 2,
    sessionsTotal: 2,
    baselineVariantKey: "var.fractions.equivalence.v0",
    startedAgoDays: 3,
    finishedAgoDays: 3,
    overallVerdict:
      "The equivalence task reliably lands the equal-parts justification for both profiles. Cautious Cora needed a concrete fold-the-paper analogy, which the prompt offered without spoiling the answer.",
    grounding: mkGrounding(
      fractionsEquivSimDims,
      fractionsEquivRealDims,
      0.71,
      5,
      "Sim and real fitness agree within Δ0.07 — well under the 0.5 threshold. The equivalence activity's sim verdicts are a trustworthy stand-in for the real cohort.",
    ),
  },

  // ── Shard 2 experiment ────────────────────────────────────────────────────
  {
    key: "exp.smallmoments.baseline",
    activityKey: "a.smallmoments.baseline",
    teacherKey: "t.kawena",
    mode: "analyze",
    castProfileKeys: ["sp.wide-narrator"],
    maxTurns: 6,
    learningGoal:
      "Surface whether the scholar spontaneously zooms in on a specific moment or defaults to a broad narrative summary, and whether any sensory detail appears without prompting.",
    status: "done",
    sessionsDone: 1,
    sessionsTotal: 1,
    baselineVariantKey: "var.smallmoments.baseline.v0",
    startedAgoDays: 2,
    finishedAgoDays: 2,
    overallVerdict:
      "Wide-Scope Wren confirmed the summarizer pattern — she described an entire weekend after two zoom-in prompts. The prompt successfully surfaces the gap; the activity needs a built-in concrete-model moment to help summarizers narrow before the end of the conversation.",
  },
];

export const variants: SeedVariant[] = [
  {
    key: "var.fractions.baseline.v0",
    activityKey: "a.fractions.baseline",
    experimentKey: "exp.fractions.baseline",
    generation: 0,
    origin: "baseline",
    status: "promoted",
    systemPrompt: null,
    // n matches the sim transcripts actually stored below (2 per variant) so the
    // "N simulated sessions" readout is honest — not an inflated claimed sample.
    aggregateScores: mkAggregate(fractionsBaselineSimDims, 0.83, 2),
  },
  {
    key: "var.fractions.equivalence.v0",
    activityKey: "a.fractions.equivalence",
    experimentKey: "exp.fractions.equivalence",
    generation: 0,
    origin: "baseline",
    status: "promoted",
    systemPrompt: null,
    aggregateScores: mkAggregate(fractionsEquivSimDims, 0.71, 2),
  },

  // ── Shard 2 variant ───────────────────────────────────────────────────────
  {
    key: "var.smallmoments.baseline.v0",
    activityKey: "a.smallmoments.baseline",
    experimentKey: "exp.smallmoments.baseline",
    generation: 0,
    origin: "baseline",
    status: "candidate",
    systemPrompt: null,
  },
];

export const simulatedSessions: SeedSimulatedSession[] = [
  {
    experimentKey: "exp.fractions.baseline",
    variantKey: "var.fractions.baseline.v0",
    profileKey: "sp.eager",
    stopReason: "goal",
    goalReached: true,
    transcript: [
      {
        role: "tutor",
        content:
          "Tell me about a time you used fractions — could be cooking, sports, anything you like.",
      },
      {
        role: "scholar",
        content: "Pizza! Half a pizza is 1/2 — one piece out of two. Easy.",
      },
      {
        role: "tutor",
        content:
          "Nice. Now imagine I cut that pizza into four pieces — but one piece is huge and the other three are tiny. Is the huge piece '1/4'?",
      },
      {
        role: "scholar",
        content:
          "Hmm — wait. No, that's not fair. The pieces have to be the same size or the number on the bottom doesn't actually mean anything.",
      },
    ],
  },
  {
    experimentKey: "exp.fractions.baseline",
    variantKey: "var.fractions.baseline.v0",
    profileKey: "sp.cautious",
    stopReason: "stuck",
    goalReached: false,
    transcript: [
      {
        role: "tutor",
        content:
          "Tell me about a time you used fractions — could be cooking, sports, anything you like.",
      },
      {
        role: "scholar",
        content: "Um... maybe sharing a sandwich? But I'm not sure if that counts.",
      },
      {
        role: "tutor",
        content:
          "That totally counts. If you cut the sandwich in half, what does the '2' in '1/2' tell you?",
      },
      {
        role: "scholar",
        content:
          "How many pieces there are? I think. I don't know if that's the right way to say it.",
      },
    ],
  },

  // ── Equivalence task simulated sessions (matured second activity) ─────────
  {
    experimentKey: "exp.fractions.equivalence",
    variantKey: "var.fractions.equivalence.v0",
    profileKey: "sp.eager",
    stopReason: "goal",
    goalReached: true,
    transcript: [
      {
        role: "tutor",
        content:
          "You said 1/2 and 2/4 are the same. Can you show me WHY, not just that they look equal?",
      },
      {
        role: "scholar",
        content:
          "If I cut the half in two, each piece is a fourth, and there's two of them. So 1/2 is 2/4 — same amount, just more cuts.",
      },
      {
        role: "tutor",
        content:
          "Exactly the move. What happened to the top number and the bottom number when you 'cut each piece in two'?",
      },
      {
        role: "scholar",
        content: "They both doubled! 1 became 2 and 2 became 4. Doubling both keeps it fair.",
      },
    ],
  },
  {
    experimentKey: "exp.fractions.equivalence",
    variantKey: "var.fractions.equivalence.v0",
    profileKey: "sp.cautious",
    stopReason: "goal",
    goalReached: true,
    transcript: [
      {
        role: "tutor",
        content: "Take this strip of paper folded in half. How could you prove it's also 2/4?",
      },
      {
        role: "scholar",
        content: "Fold it again? Now there are four parts and the half covers two of them.",
      },
      {
        role: "tutor",
        content: "Nice — so what made 1/2 turn into 2/4 without changing how much paper it is?",
      },
      {
        role: "scholar",
        content:
          "Both numbers got twice as big because I folded everything one more time. The paper stayed the same.",
      },
    ],
  },

  // ── Shard 2 simulated session ─────────────────────────────────────────────
  {
    experimentKey: "exp.smallmoments.baseline",
    variantKey: "var.smallmoments.baseline.v0",
    profileKey: "sp.wide-narrator",
    stopReason: "maxTurns",
    goalReached: false,
    transcript: [
      {
        role: "tutor",
        content:
          "Tell me about something that happened recently — something real from your life.",
      },
      {
        role: "scholar",
        content:
          "I went to my grandma's house for the whole weekend. We baked cookies and watched movies and played in the yard and went to the park.",
      },
      {
        role: "tutor",
        content:
          "That sounds really full! Which one moment from the whole weekend do you remember most clearly — like if you close your eyes right now?",
      },
      {
        role: "scholar",
        content:
          "Um, when we baked the cookies. And also when we went to the park. And at night we watched a movie with popcorn.",
      },
      {
        role: "tutor",
        content:
          "Okay — just the cookies. What's the very first thing that happened when you started making them?",
      },
      {
        role: "scholar",
        content: "My grandma got out the flour and I helped pour it in the bowl.",
      },
    ],
  },
];

// ── Grounded verdicts: the real-session field record ──────────────────────
// One judge verdict per COMPLETED Fraction Sense session — the violet Sessions
// distribution plots one dot per row. Fitness values scatter around each
// activity's REAL aggregate (baseline ≈ 4.0, equivalence ≈ 3.83), so the
// distribution's mean band lands just left of the dashed "sim said" tick
// (sim baseline 4.13, equiv 3.9 — the same Δ the grounding reported).
const mkVerdict = (fitness: number, goalAttainment: number, note: string) => ({
  fitness,
  goalAttainment,
  rationale: note,
});

export const groundedVerdicts: SeedGroundedVerdict[] = [
  // Baseline activity — n=5 real sessions judged.
  {
    activityKey: "a.fractions.baseline",
    sessionKey: "sess.kalei.baseline",
    experimentKey: "exp.fractions.baseline",
    scholarKey: "s.kalei",
    profileName: "Eager Ezra",
    readingLevel: "Grade 4",
    fitness: 4.6,
    goalAttainment: 4.6,
    excerpt:
      "The bottom number controls how big each piece is, so the bottom number really matters.",
    judgedAgoMinutes: 4320,
    verdict: mkVerdict(4.6, 4.6, "Articulates denominator meaning unprompted — ceiling read."),
  },
  {
    activityKey: "a.fractions.baseline",
    sessionKey: "sess.sage.baseline",
    experimentKey: "exp.fractions.baseline",
    scholarKey: "s.sage",
    profileName: "Cautious Cora",
    readingLevel: "Grade 3",
    fitness: 3.9,
    goalAttainment: 3.8,
    excerpt:
      "They have to be the same size? Like if I cut my sandwich really uneven, that doesn't feel like half.",
    judgedAgoMinutes: 4315,
    verdict: mkVerdict(3.9, 3.8, "Self-initiates the equal-parts question; commits after one nudge."),
  },
  {
    activityKey: "a.fractions.baseline",
    sessionKey: "sess.keoni.baseline",
    experimentKey: "exp.fractions.baseline",
    scholarKey: "s.keoni",
    profileName: "Cautious Cora",
    readingLevel: "Grade 3",
    fitness: 3.7,
    goalAttainment: 3.6,
    excerpt:
      "If the parts aren't equal then one third isn't really a third.",
    judgedAgoMinutes: 4310,
    verdict: mkVerdict(3.7, 3.6, "Reaches equal-parts via 'fair parts' language; solid on-level."),
  },
  {
    activityKey: "a.fractions.baseline",
    sessionKey: "sess.malia.baseline",
    experimentKey: "exp.fractions.baseline",
    scholarKey: "s.malia",
    profileName: "Eager Ezra",
    readingLevel: "Grade 4",
    fitness: 4.4,
    goalAttainment: 4.5,
    excerpt:
      "Same-size wholes, then compare the shaded parts. 3/4 covers more of the bar than 2/3.",
    judgedAgoMinutes: 4305,
    verdict: mkVerdict(4.4, 4.5, "Number-line framing + same-whole comparison, unprompted."),
  },
  {
    activityKey: "a.fractions.baseline",
    sessionKey: "sess.tiare.baseline",
    experimentKey: "exp.fractions.baseline",
    scholarKey: "s.tiare",
    profileName: "Cautious Cora",
    readingLevel: "Grade 2",
    fitness: 3.6,
    goalAttainment: 3.5,
    excerpt: "It has to be the same as the other piece. Both halves equal.",
    judgedAgoMinutes: 4300,
    verdict: mkVerdict(3.6, 3.5, "Hesitant open, self-corrects to equal parts — developing but lands it."),
  },

  // Equivalence activity — n=2 real sessions judged.
  {
    activityKey: "a.fractions.equivalence",
    sessionKey: "sess.kalei.equiv",
    experimentKey: "exp.fractions.equivalence",
    scholarKey: "s.kalei",
    profileName: "Eager Ezra",
    readingLevel: "Grade 4",
    fitness: 4.1,
    goalAttainment: 4.0,
    excerpt:
      "You have to use the SAME whole, otherwise you're not comparing fairly. That's the whole point.",
    judgedAgoMinutes: 1140,
    verdict: mkVerdict(4.1, 4.0, "Names the same-whole constraint as the crux — strong justification."),
  },
  {
    activityKey: "a.fractions.equivalence",
    sessionKey: "sess.malia.equiv",
    experimentKey: "exp.fractions.equivalence",
    scholarKey: "s.malia",
    profileName: "Eager Ezra",
    readingLevel: "Grade 4",
    fitness: 3.6,
    goalAttainment: 3.6,
    excerpt:
      "Twice as many pieces but each is half as big. Same amount shaded.",
    judgedAgoMinutes: 1135,
    verdict: mkVerdict(3.6, 3.6, "Leads with the procedure; reaches the meaning only after a push."),
  },
];

export const unitReviews: SeedUnitReview[] = [
  {
    unitKey: "u.fractions",
    reviewedByKey: "t.daniel",
    reviewedAgoDays: 4,
    openGapCount: 0,
    summary: {
      gaps: [],
      strengths: [
        "Essential questions and enduring understandings are tightly aligned with both activities — the equal-parts idea threads through the whole unit.",
        "The baseline-then-equivalence arc gives every scholar a chance to surface a misconception and then resolve it with a concrete model.",
        "Deliverable criteria are observable and age-appropriate; the rubric maps cleanly onto the EU about equal partitioning.",
      ],
    },
  },

  // ── Shard 2 unit review ───────────────────────────────────────────────────
  {
    unitKey: "u.smallmoments",
    reviewedByKey: "t.kawena",
    reviewedAgoDays: 1,
    openGapCount: 2,
    summary: {
      gaps: [
        "No explicit mentor-text anchor for the zoom-in concept — summarizers like Koa need a concrete side-by-side model before they can apply it independently.",
        "The baseline activity lacks a built-in narrowing scaffold; the system prompt relies on the AI improvising, which works for strong narrators but not for scholars defaulting to summaries.",
      ],
      strengths: [
        "The essential questions are well-framed and accessible across grade levels.",
        "The draft deliverable criteria map cleanly to the EQs and EUs.",
      ],
    },
  },
];

export const activityReflections: SeedActivityReflection[] = [
  {
    activityKey: "a.fractions.baseline",
    teacherKey: "t.daniel",
    content:
      "The pizza prompt worked well for Kalei and Sage — concrete and immediately personal. Leilani needed a physical object rather than just conversation; next time I'd bring a real folded card. The 'don't correct yet' constraint in the system prompt held — only one scholar sensed they were being probed.",
    updatedAgoDays: 2,
  },

  // ── Shard 2 activity reflection ───────────────────────────────────────────
  {
    activityKey: "a.smallmoments.baseline",
    teacherKey: "t.kawena",
    content:
      "The baseline worked beautifully for Emma, who narrowed quickly and surfaced a sensory detail on her own. It didn't help Koa — he stayed wide even after two follow-up prompts. I need to add a mini mentor-text step inside the conversation: show two versions of the same event (wide vs. zoomed) before asking the scholar to pick their own moment. That concrete contrast is what the current system prompt skips.",
    updatedAgoDays: 1,
  },
];

export const momentTriage: SeedMomentTriage[] = [
  {
    teacherKey: "t.daniel",
    activityKey: "a.fractions.baseline",
    source: "mastery",
    sourceMasteryKey: "m.leilani.misconception",
    verdict: "kept",
    triagedAgoDays: 1,
  },

  // ── Shard 2 moment triage ─────────────────────────────────────────────────
  {
    teacherKey: "t.kawena",
    activityKey: "a.smallmoments.baseline",
    source: "mastery",
    sourceMasteryKey: "m.koa.scope.wide",
    verdict: "kept",
    triagedAgoDays: 1,
  },
];
