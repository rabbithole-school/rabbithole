// ─── Rich-cohort seed: OBSERVATION data ───────────────────────────────────
//
// Honu pod, Week 1 of "Fraction Sense". Covers mastery snapshots, granule
// evidence, engagement signals, a cross-domain connection, a seed, and two
// teacher observations — all anchored to the three scholars who have run
// sessions so far (Kalei, Sage, Leilani).

import type {
  SeedMastery,
  SeedGranuleEvidence,
  SeedSignal,
  SeedConnection,
  SeedSeed,
  SeedObservation,
} from "./types";

export const mastery: SeedMastery[] = [
  // v1 → v2 growth story: Kalei's equivalence understanding across the week.
  {
    key: "m.kalei.equiv.v1",
    scholarKey: "s.kalei",
    sessionKey: "sess.kalei.baseline",
    conceptLabel: "fraction equivalence",
    domain: "mathematics",
    observedAgoDays: 4,
    masteryLevel: 3,
    confidenceScore: 0.6,
    evidenceSummary:
      "Kalei matched 1/2 and 2/4 using a doubling pattern but could not yet articulate why equal-sized parts are required.",
    evidenceType: "reasoning",
    transcriptExcerpt:
      '"I think they\'re the same because two is double one and four is double two." No equal-parts justification given.',
    attemptContext:
      "Baseline conversation — scholar used pizza imagery spontaneously.",
    studentInitiated: false,
    isSuperseded: true,
  },
  {
    key: "m.kalei.equiv.v2",
    scholarKey: "s.kalei",
    sessionKey: "sess.kalei.equiv",
    conceptLabel: "fraction equivalence",
    domain: "mathematics",
    observedAgoDays: 1,
    masteryLevel: 4,
    confidenceScore: 0.85,
    evidenceSummary:
      "Kalei independently constructed an equal-parts argument for 1/2 = 2/4, citing same whole and equal-size pieces without any prompting.",
    evidenceType: "application",
    transcriptExcerpt:
      '"Both fractions cut the same pizza — mine has two equal slices, yours has four. They look different but they\'re exactly half either way."',
    attemptContext:
      "Equivalence task — scholar chose the folded-paper approach without suggestion.",
    studentInitiated: true,
    supersedesKey: "m.kalei.equiv.v1",
    isSuperseded: false,
  },
  {
    key: "m.sage.equalparts",
    scholarKey: "s.sage",
    sessionKey: "sess.sage.baseline",
    conceptLabel: "equal parts",
    domain: "mathematics",
    observedAgoDays: 3,
    masteryLevel: 3,
    confidenceScore: 0.7,
    evidenceSummary:
      "Sage consistently applied the equal-parts rule when evaluating drawn fraction diagrams, explaining that unequal pieces 'don't count'.",
    evidenceType: "reasoning",
    transcriptExcerpt:
      '"If the pieces are different sizes it\'s not a real fraction — they all have to be the same."',
    attemptContext: "Baseline conversation — prompted with an unequal-split drawing.",
    studentInitiated: false,
    isSuperseded: false,
  },
  {
    key: "m.leilani.misconception",
    scholarKey: "s.leilani",
    sessionKey: "sess.leilani.baseline",
    conceptLabel: "counts pieces, ignores equal-size",
    domain: "mathematics",
    observedAgoDays: 1,
    masteryLevel: 1,
    confidenceScore: 0.9,
    evidenceSummary:
      "Leilani counts shaded pieces over total pieces without checking that all pieces are equal, calling any 2-out-of-4 split '2/4' regardless of piece size.",
    evidenceType: "misconception_signal",
    transcriptExcerpt:
      '"There are two colored pieces and four total pieces so it\'s 2/4." (The four pieces were visibly unequal in the drawing.)',
    attemptContext:
      "Baseline conversation — shown a circle diagram with unequal slices.",
    studentInitiated: false,
    misconceptionStatus: "open",
    misconceptionNote:
      "Leilani treats fractions as pure counting. Equal-size is invisible to her right now — a hands-on tearing or folding task where unequal pieces produce an obvious error should make the gap concrete before any symbolic work.",
    isSuperseded: false,
  },

  // ── Shard 2: Small Moments mastery ────────────────────────────────────────

  // Emma: detail/sensory growth — v1 (baseline, vague detail) → v2 (draft, specific sensory).
  {
    key: "m.emma.detail.v1",
    scholarKey: "s.emma",
    sessionKey: "sess.emma.baseline",
    conceptLabel: "sensory detail in narrative",
    domain: "ELA",
    observedAgoDays: 2,
    masteryLevel: 2,
    confidenceScore: 0.55,
    evidenceSummary:
      "Emma produced one spontaneous sensory detail ('burnt sugar') in speech but could not yet transfer this instinct into written sentences consistently.",
    evidenceType: "reasoning",
    transcriptExcerpt:
      '"The smoke smelled like burnt sugar." (Verbal only — written draft not yet attempted.)',
    attemptContext:
      "Baseline conversation — scholar narrated the candle-blowing moment spontaneously.",
    studentInitiated: true,
    isSuperseded: true,
  },
  {
    key: "m.emma.detail.v2",
    scholarKey: "s.emma",
    sessionKey: "sess.emma.draft",
    conceptLabel: "sensory detail in narrative",
    domain: "ELA",
    observedAgoDays: 1,
    masteryLevel: 4,
    confidenceScore: 0.82,
    evidenceSummary:
      "Emma embedded a specific sensory detail ('the smoke smelled like burnt sugar') directly into her written draft without prompting, demonstrating transfer from oral storytelling to written narrative.",
    evidenceType: "application",
    transcriptExcerpt:
      '"I blew out the candles on my birthday cake. The smoke smelled like burnt sugar and everyone went quiet."',
    attemptContext:
      "Draft writing task — scholar independently placed the sensory detail in the second sentence of her narrative.",
    studentInitiated: true,
    supersedesKey: "m.emma.detail.v1",
    isSuperseded: false,
  },

  // Koa: wide scope — active misconception (treats narrative as summary).
  {
    key: "m.koa.scope.wide",
    scholarKey: "s.koa",
    sessionKey: "sess.koa.baseline",
    conceptLabel: "narrative scope — zooming in",
    domain: "ELA",
    observedAgoDays: 2,
    masteryLevel: 1,
    confidenceScore: 0.85,
    evidenceSummary:
      "Koa defaults to summarising an extended event (whole season, whole game) rather than zooming in on a single moment, even after explicit prompting to narrow.",
    evidenceType: "misconception_signal",
    transcriptExcerpt:
      '"I played the whole season and we won most of the games." — then after prompting: "The championship game." — then after more prompting: "I don\'t know. I just kicked it and it went in."',
    attemptContext:
      "Baseline conversation — scholar could not access the specific sensory memory even when directly asked.",
    studentInitiated: false,
    misconceptionStatus: "open",
    misconceptionNote:
      "Koa's 'story' is a highlight reel rather than a zoomed-in scene. He lacks the vocabulary and mental model for what 'zooming in' looks like in writing. A concrete contrast exercise (wide vs. narrow version of the same event) is recommended before another solo attempt.",
    isSuperseded: false,
  },

  // Nainoa: wide scope — open, but shows early awareness when nudged.
  {
    key: "m.nainoa.scope",
    scholarKey: "s.nainoa",
    sessionKey: "sess.nainoa.baseline",
    conceptLabel: "narrative scope — zooming in",
    domain: "ELA",
    observedAgoDays: 2,
    masteryLevel: 2,
    confidenceScore: 0.6,
    evidenceSummary:
      "Nainoa started with a wide two-day event but narrowed to a single moment (melting s'more) when asked 'what do you see right now?' — suggesting the concept is within reach.",
    evidenceType: "reasoning",
    transcriptExcerpt:
      '"Um… the s\'more. When the chocolate melted and got on my fingers." (Self-selected the most vivid sub-moment when prompted.)',
    attemptContext:
      "Baseline conversation — required two prompts to narrow from two-day camping trip to one moment.",
    studentInitiated: false,
    isSuperseded: false,
  },
];

export const granuleEvidence: SeedGranuleEvidence[] = [
  // Kalei on eu.fractions.equalparts: baseline probe → exit demonstration (growth).
  {
    scholarKey: "s.kalei",
    unitKey: "u.fractions",
    granuleKey: "eu.fractions.equalparts",
    sessionKey: "sess.kalei.baseline",
    observedAgoDays: 4,
    outcome: "probed",
    phase: "baseline",
    transcriptExcerpt:
      "\"The pieces should be the same size, I think... but I don't really know why that part matters.\"",
    evidenceSummary:
      "Partial intuition about equal parts at baseline; unable to formally justify the rule.",
  },
  {
    scholarKey: "s.kalei",
    unitKey: "u.fractions",
    granuleKey: "eu.fractions.equalparts",
    sessionKey: "sess.kalei.equiv",
    observedAgoDays: 1,
    outcome: "demonstrated",
    phase: "exit",
    bloomLevel: "apply",
    transcriptExcerpt:
      '"You can\'t call it 2/4 if the slices are different sizes — the whole point is that the 4 means four EQUAL pieces."',
    evidenceSummary:
      "Kalei applied the equal-parts rule to ground his equivalence argument — clear growth from the baseline probe.",
  },
  // Kalei on the equivalence essential question.
  {
    scholarKey: "s.kalei",
    unitKey: "u.fractions",
    granuleKey: "eq.fractions.equivalence",
    sessionKey: "sess.kalei.equiv",
    observedAgoDays: 1,
    outcome: "demonstrated",
    transcriptExcerpt:
      '"1/2 and 2/4 are the same because they\'re both talking about the same pizza — just cut into a different number of equal pieces."',
    evidenceSummary:
      "Demonstrated the essential question: two fractions can look different and still name the same amount of the same whole.",
  },
  // Leilani on eu.fractions.equalparts: baseline probe confirming misconception.
  {
    scholarKey: "s.leilani",
    unitKey: "u.fractions",
    granuleKey: "eu.fractions.equalparts",
    sessionKey: "sess.leilani.baseline",
    observedAgoDays: 1,
    outcome: "probed",
    phase: "baseline",
    transcriptExcerpt:
      "When shown a circle with four unequal sections, Leilani said '2/4' without noticing the piece sizes differed.",
    evidenceSummary:
      "Baseline probe confirms the misconception is active — Leilani does not yet apply the equal-parts enduring understanding.",
  },

  // ── Shard 2: Small Moments granule evidence ───────────────────────────────

  // Emma on eq.smallmoments.detail: baseline (probed, verbal only) → draft (demonstrated, written).
  {
    scholarKey: "s.emma",
    unitKey: "u.smallmoments",
    granuleKey: "eq.smallmoments.detail",
    sessionKey: "sess.emma.baseline",
    assignmentKey: "as.smallmoments.iwa",
    observedAgoDays: 2,
    outcome: "probed",
    phase: "baseline",
    transcriptExcerpt:
      '"The smoke smelled like burnt sugar."',
    evidenceSummary:
      "Emma can produce sensory detail in oral narration; transfer to written text not yet demonstrated.",
  },
  {
    scholarKey: "s.emma",
    unitKey: "u.smallmoments",
    granuleKey: "eq.smallmoments.detail",
    sessionKey: "sess.emma.draft",
    assignmentKey: "as.smallmoments.iwa",
    observedAgoDays: 1,
    outcome: "demonstrated",
    phase: "exit",
    bloomLevel: "apply",
    transcriptExcerpt:
      '"The smoke smelled like burnt sugar and everyone went quiet."',
    evidenceSummary:
      "Emma transferred her oral sensory-detail instinct into written form (embedded in her final written draft) — clean demonstration of the essential question answered.",
  },
  // Emma on eu.smallmoments.ending: demonstrated growth in meaning-making.
  {
    scholarKey: "s.emma",
    unitKey: "u.smallmoments",
    granuleKey: "eu.smallmoments.ending",
    sessionKey: "sess.emma.draft",
    assignmentKey: "as.smallmoments.iwa",
    observedAgoDays: 1,
    outcome: "demonstrated",
    bloomLevel: "create",
    transcriptExcerpt:
      '"I didn\'t know a room could feel that full." — the revised final sentence.',
    evidenceSummary:
      "Emma replaced a generic close with a sentence that articulates the emotional significance of the moment, directly instantiating the enduring understanding.",
  },
  // Koa on eq.smallmoments.zoom: baseline probe showing the concept is not yet accessible.
  {
    scholarKey: "s.koa",
    unitKey: "u.smallmoments",
    granuleKey: "eq.smallmoments.zoom",
    sessionKey: "sess.koa.baseline",
    assignmentKey: "as.smallmoments.iwa",
    observedAgoDays: 2,
    outcome: "probed",
    phase: "baseline",
    transcriptExcerpt:
      '"I played the whole season and we won most of the games." — scope remained wide after two zoom-in prompts.',
    evidenceSummary:
      "Koa could not access a single moment even when explicitly asked. The zoom-in concept needs concrete modeling before this granule can be demonstrated.",
  },
];

export const signals: SeedSignal[] = [
  {
    scholarKey: "s.kalei",
    sessionKey: "sess.kalei.equiv",
    signalType: "persistence",
    description:
      "Kalei tried three different representations (words, drawing, folded paper) in a single session before settling on one he felt was convincing.",
    intensity: "strong",
    transcriptExcerpt: '"Wait, let me try it with actual paper — that\'ll show it better."',
  },
  {
    scholarKey: "s.leilani",
    sessionKey: "sess.leilani.baseline",
    signalType: "frustration",
    description:
      "Leilani grew noticeably terse after the tutor's third follow-up question about piece size, suggesting she sensed something was wrong but could not locate the gap.",
    intensity: "moderate",
  },

  // ── Shard 2 signals ───────────────────────────────────────────────────────
  {
    scholarKey: "s.emma",
    sessionKey: "sess.emma.draft",
    signalType: "self-revision",
    description:
      "Emma voluntarily replaced her closing sentence after a single open question — she found the more meaningful ending herself rather than accepting a suggestion.",
    intensity: "strong",
    transcriptExcerpt: '"I didn\'t know a room could feel that full."',
  },
  {
    scholarKey: "s.koa",
    sessionKey: "sess.koa.baseline",
    signalType: "disengagement",
    description:
      "Koa's responses shortened to under ten words after the second follow-up prompt, suggesting the zoom-in task exceeded his current scaffolding comfort.",
    intensity: "moderate",
    transcriptExcerpt: '"I don\'t know. I just kicked it and it went in."',
  },
];

export const connections: SeedConnection[] = [
  {
    scholarKey: "s.kalei",
    sessionKey: "sess.kalei.equiv",
    domains: ["mathematics", "music"],
    conceptLabels: ["fraction equivalence", "note values"],
    description:
      "Kalei spontaneously noticed that a half note and two quarter notes fill the same amount of a measure — parallel to 1/2 and 2/4 covering the same amount of a whole.",
    studentInitiated: true,
    transcriptExcerpt:
      '"Oh — it\'s like a half note and two quarter notes. Same amount of beats but they look totally different."',
  },

  // ── Shard 2 connections ───────────────────────────────────────────────────
  {
    scholarKey: "s.emma",
    sessionKey: "sess.emma.draft",
    domains: ["ELA", "social-emotional"],
    conceptLabels: ["narrative meaning-making", "belonging"],
    description:
      "Emma connected the idea of a 'strong ending' to the feeling of being seen — she articulated that the candle moment mattered because everyone was there 'just for me', linking narrative technique to an emotional truth about belonging.",
    studentInitiated: true,
    transcriptExcerpt:
      '"It felt like everyone was there just for me. That doesn\'t happen very much."',
  },
];

export const seeds: SeedSeed[] = [
  {
    key: "seed.kalei.music-fractions",
    scholarKey: "s.kalei",
    origin: "ai",
    status: "pending",
    topic: "Fractions in music — note values",
    domain: "mathematics",
    suggestionType: "cross_domain",
    rationale:
      "Kalei independently connected fraction equivalence to musical note values. Pursuing this link could deepen his understanding of equivalent fractions while sustaining the curiosity he already brought to the session.",
    scholarInvitation:
      "You spotted that a half note and two quarter notes can fill the same space in a measure — just like 1/2 and 2/4 fill the same whole. How many different ways can you fill exactly one measure?",
    approachHint:
      "Start with a 4/4 measure on a whiteboard. Fill it with different combinations of note values that sum to the same whole and ask: how many ways can you fill exactly one measure?",
    sessionKey: "sess.kalei.equiv",
    currentBloomsLevel: 2,
    targetBloomsLevel: 4,
  },

  // ── Shard 2 seeds ─────────────────────────────────────────────────────────
  {
    key: "seed.emma.moment-journalism",
    scholarKey: "s.emma",
    origin: "ai",
    status: "pending",
    topic: "Zoomed-in observation as journalism — the detail notebook",
    domain: "ELA",
    suggestionType: "extension",
    rationale:
      "Emma's instinct for sensory detail is strong. A 'detail notebook' habit — spending 2 minutes per day writing one zoomed-in observation — could build her repertoire of raw material for future narratives and develop the writer's habit of noticing.",
    scholarInvitation:
      "What if you carried a tiny reporter's notebook for one week and caught one detail nobody else noticed each day — a sound, a color, a tiny moment? Which detail could become the start of your next story?",
    approachHint:
      "Give Emma a small blank notebook and ask her to write one specific thing she noticed each day for a week: what it looked like, sounded like, or felt like. Then use those entries as seeds for her next Small Moment piece.",
    sessionKey: "sess.emma.draft",
    currentBloomsLevel: 3,
    targetBloomsLevel: 5,
  },
];

export const observations: SeedObservation[] = [
  {
    teacherKey: "t.daniel",
    scholarKey: "s.kalei",
    sessionKey: "sess.kalei.equiv",
    type: "praise",
    note: "Kalei's equivalence argument was genuinely strong — he anchored on same-whole AND equal-parts without prompting and then spontaneously connected it to music note values. This is exactly the cross-domain stretch thinking we want to nurture.",
  },
  {
    teacherKey: "t.daniel",
    scholarKey: "s.leilani",
    sessionKey: "sess.leilani.baseline",
    type: "concern",
    note: "Leilani is counting pieces without registering equal-size — a foundational fraction misconception that will block her on everything that follows. Plan a hands-on tearing or folding task before any symbolic fraction work.",
  },

  // ── Shard 2 observations ──────────────────────────────────────────────────
  {
    teacherKey: "t.kawena",
    scholarKey: "s.emma",
    sessionKey: "sess.emma.draft",
    type: "praise",
    note: "Emma's revised ending ('I didn't know a room could feel that full') is genuinely strong writing for a Grade 1 scholar. She found the meaning in the moment after one nudge and articulated it without cliché. Nominate this piece for the class share-back.",
  },
  {
    teacherKey: "t.kawena",
    scholarKey: "s.koa",
    sessionKey: "sess.koa.baseline",
    type: "suggestion",
    note: "Koa needs a concrete side-by-side comparison of a wide story vs. a zoomed-in one before he can apply the concept independently. Try the 'wide vs. narrow' mentor-text pair next session — two paragraphs about the same soccer goal, one zoomed out, one zoomed in. Ask him which one he'd rather read.",
  },
];
