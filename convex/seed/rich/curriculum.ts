// ─── Rich-cohort seed: CURRICULUM (Design layer) ──────────────────────────
//
// Shard 1: small online Math curriculum — "Fraction Sense" plus a short
// enrichment probability preview. Granules are keyed so granuleEvidence rows
// can attribute to them.
//
// Shard 2 (appended): ONE ELA narrative-writing unit — "Small Moments" —
// taught by t.kawena for Pod ʻIwa. One lesson, two activities (a baseline
// conversation + a draft-writing task with a deliverable). Unique granule
// keys in the eq.smallmoments.* / eu.smallmoments.* namespace.
//
// Hand-authored (the foundation other shard-1/shard-2 fixtures reference by
// key). Keys are stable; the inserter resolves them.

import type { SeedUnit } from "./types";

export const units: SeedUnit[] = [
  {
    key: "u.fractions",
    teacherKey: "t.daniel",
    title: "Fraction Sense",
    slug: "fraction-sense",
    emoji: "🍕",
    subject: "Math Workshop",
    gradeLevel: "Grade 3",
    targetBloomLevel: "understand",
    bigIdea:
      "A fraction names a relationship between a part and an equal-sized whole — not just 'a number on top of a number'.",
    description:
      "An entry unit into fractional reasoning for the Honu pod's mixed-level mathematicians. Scholars move from 'pieces' to 'equal pieces of a defined whole', then to seeing that different-looking fractions can name the same amount. A light enrichment doorway invites scholars to notice that chance questions also ask for a fraction — favorable outcomes out of all outcomes.",
    essentialQuestions: [
      {
        key: "eq.fractions.whole",
        text: "What makes a fraction different from just counting pieces?",
      },
      {
        key: "eq.fractions.equivalence",
        text: "How can two fractions that look different name the same amount?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.fractions.equalparts",
        text: "A fraction's bottom number tells how many EQUAL parts the whole is split into; unequal parts don't count.",
      },
      {
        key: "eu.fractions.samewhole",
        text: "Fractions can only be compared when they refer to the same whole.",
      },
    ],
    badgeOnCompletion: {
      title: "Fraction Navigator",
      description: "Reasoned about parts, wholes, and equivalence.",
      icon: "🧭",
    },
    lessons: [
      {
        key: "l.fractions.intro",
        unitKey: "u.fractions",
        title: "What a fraction really is",
        order: 0,
        strand: "core",
        durationMinutes: 45,
        systemPrompt:
          "Across this lesson, keep scholars anchored on the idea that a fraction names equal parts of one defined whole. Favor eliciting and pressing over telling.",
        activities: [
          {
            key: "a.fractions.baseline",
            lessonKey: "l.fractions.intro",
            title: "Pizza talk: your current thinking",
            order: 0,
            kind: "online",
            recipe: "baseline",
            durationMinutes: 15,
            defaultMode: "classFocus",
            description:
              "A stealth pre-assessment: the tutor draws out how the scholar already thinks about fractions, without teaching.",
            scholarDescription:
              "Talk through how you think about fractions — pizza slices included. There are no wrong answers here, just your own thinking.",
            systemPrompt:
              "You are eliciting, not teaching. Ask the scholar to share a fraction from their own life and probe what the top and bottom numbers mean to them. Do NOT correct misconceptions yet — surface their current thinking about parts, wholes, and equal parts.",
          },
          {
            key: "a.fractions.equivalence",
            lessonKey: "l.fractions.intro",
            title: "Show that 1/2 = 2/4",
            order: 1,
            kind: "online",
            durationMinutes: 30,
            defaultMode: "homework",
            description:
              "The scholar builds an argument (drawing, words, or a folded-paper photo) that two different-looking fractions name the same amount of the same whole.",
            scholarDescription:
              "Build a convincing case that 1/2 and 2/4 are really the same amount — use a drawing, your own words, or a photo of folded paper.",
            systemPrompt:
              "Guide the scholar toward an equivalence argument grounded in a single whole. Press for EQUAL parts and the SAME whole. Accept drawings, words, or photos of folded paper.",
            deliverable: {
              kind: "artifact",
              prompt:
                "Make a convincing case that 1/2 and 2/4 are the same amount. Use a picture, words, or a photo of folded paper.",
              mode: "manual",
              criteria: [
                {
                  id: "equal-parts",
                  label: "Splits the whole into equal parts",
                  description: "The parts shown are genuinely equal-sized.",
                },
                {
                  id: "same-whole",
                  label: "Uses the same whole for both fractions",
                  description: "Both 1/2 and 2/4 refer to the same unit/whole.",
                },
                {
                  id: "names-equivalence",
                  label: "States that the two amounts are equal",
                  description: "Concludes 1/2 and 2/4 name the same amount.",
                },
              ],
            },
          },
        ],
      },
      {
        key: "l.fractions.connections",
        unitKey: "u.fractions",
        title: "Fractions all around us",
        order: 1,
        strand: "connections",
        durationMinutes: 30,
        systemPrompt:
          "Help scholars notice fractions already living in music, cooking, sports, and measurement. The goal is transfer: the same equal-parts idea shows up everywhere once you look for it. If a scholar is ready for a leap, ask: 'On a fair die, what fraction of the outcomes are even?' Name that as a probability preview, then return to the equal-parts idea.",
        activities: [
          {
            key: "a.fractions.hunt",
            lessonKey: "l.fractions.connections",
            title: "Fraction scavenger hunt",
            order: 0,
            kind: "offline",
            durationMinutes: 30,
            defaultMode: "homework",
            description:
              "Scholars find three real fractions in their home or neighborhood (a measuring cup, a sliced fruit, a song's beat) and sketch how the whole was split into equal parts. Optional enrichment: include one chance fraction, like the outcomes on a die that are even.",
            scholarDescription:
              "Hunt for three real fractions around your home or neighborhood — a measuring cup, a sliced fruit, the beat of a song — and sketch how each whole was split into equal parts. For a challenge, add one 'chance' fraction, like how many numbers on a die are even.",
          },
        ],
      },
      {
        key: "l.fractions.practice",
        unitKey: "u.fractions",
        title: "Fraction fluency",
        order: 2,
        strand: "practice",
        durationMinutes: 25,
        systemPrompt:
          "Build fluency with equal-parts and equivalence through quick, low-stakes repetitions. Watch for the unequal-parts misconception resurfacing under time pressure.",
        activities: [
          {
            key: "a.fractions.cardsort",
            lessonKey: "l.fractions.practice",
            title: "Equal vs. unequal card sort",
            order: 0,
            kind: "offline",
            durationMinutes: 25,
            defaultMode: "classFocus",
            description:
              "A hands-on sort: scholars group picture cards into 'truly equal parts' vs 'not equal', then match equivalent fractions (1/2 ↔ 2/4 ↔ 3/6).",
            scholarDescription:
              "Sort picture cards into 'truly equal parts' and 'not equal', then match up the fractions that name the same amount — like 1/2, 2/4, and 3/6.",
          },
        ],
      },
    ],
  },
  // ── Math enrichment: probability preview ────────────────────────────────
  {
    key: "u.probability",
    teacherKey: "t.daniel",
    title: "A Feel for Chance",
    slug: "feel-for-chance",
    emoji: "🎲",
    subject: "Math Workshop",
    gradeLevel: "Grade 3 enrichment",
    targetBloomLevel: "analyze",
    bigIdea:
      "Probability is a fraction of a carefully named sample space: favorable outcomes over total equally likely outcomes.",
    description:
      "A short ceiling-raising preview of probability for curious fraction thinkers. Scholars use dice and coins to move from 'it might happen' to reasoned predictions, seeing chance as another place fractions do useful work.",
    essentialQuestions: [
      {
        key: "eq.probability.likelihood",
        text: "How can we talk precisely about chance before we know what will happen?",
      },
      {
        key: "eq.probability.fraction",
        text: "Why is a probability a fraction?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.probability.samplespace",
        text: "A sample space names every possible outcome, so a prediction starts by asking what could happen.",
      },
      {
        key: "eu.probability.favorabletotal",
        text: "A probability compares favorable outcomes to all equally likely outcomes — the same part-whole relationship fraction sense uses.",
      },
    ],
    badgeOnCompletion: {
      title: "Chance Cartographer",
      description: "Mapped outcomes and made reasoned predictions with dice and coins.",
      icon: "🎲",
    },
    lessons: [
      {
        key: "l.probability.likelihood",
        unitKey: "u.probability",
        title: "What could happen?",
        order: 0,
        strand: "connections",
        durationMinutes: 30,
        systemPrompt:
          "This is enrichment: a warm preview of CCSS 7.SP.C.5 and 7.SP.C.7, not a grade-level requirement. Build from the scholar's fraction sense. Help them place events on an impossible-to-certain line, then list the sample space for one fair die and one fair coin before judging likelihood. Invite them to roll or flip a few times to explore, but do not treat a short run as proof. Keep asking: 'What outcomes are possible? What would make your prediction fair?'",
        activities: [
          {
            key: "a.probability.rollflip",
            lessonKey: "l.probability.likelihood",
            title: "Roll, flip, and map the possibilities",
            order: 0,
            kind: "online",
            durationMinutes: 30,
            defaultMode: "classFocus",
            description:
              "Scholars roll a die and flip a coin to explore chance language, then name every possible outcome before making any prediction.",
            scholarDescription:
              "Roll a die and flip a coin to play with the language of chance, then name every outcome that's possible before you make a single prediction.",
            systemPrompt:
              "Use a physical or in-app die and coin if available. Ask the scholar to sort events such as 'roll a 7 on one die', 'roll an even number', 'flip heads', and 'roll less than 7' from impossible to certain. Then ask them to list the die outcomes and coin outcomes. Withhold formulas; press for their reasoning about the full set of possibilities. Target ideas: likelihood_scale and sample_space.",
          },
        ],
      },
      {
        key: "l.probability.fractions",
        unitKey: "u.probability",
        title: "Chance as a fraction",
        order: 1,
        strand: "connections",
        durationMinutes: 40,
        systemPrompt:
          "This is enrichment: a warm preview of CCSS 7.SP.C.5, 7.SP.C.7a, and 7.SP.C.8, not a grade-level requirement. Bridge explicitly to Fraction Sense: probability is favorable outcomes over total equally likely outcomes. Ask the scholar to commit to a reasoned prediction before rolling, then compare the trial result with the prediction without calling either luck or failure. Keep the two-dice stretch Socratic: have them look for how many ways each total can happen rather than revealing the most likely total.",
        activities: [
          {
            key: "a.probability.predictioncard",
            lessonKey: "l.probability.fractions",
            title: "Prediction card: favorable over total",
            order: 0,
            kind: "online",
            durationMinutes: 40,
            defaultMode: "homework",
            description:
              "Scholars make reasoned predictions for P(even), P(heads), P(>4), and a two-dice stretch, writing each probability as favorable outcomes over total outcomes.",
            scholarDescription:
              "Predict the chances of rolling an even number, flipping heads, and rolling more than 4 — writing each one as favorable outcomes over total outcomes. Stretch: which two-dice total do you think wins?",
            systemPrompt:
              "Ask the scholar to build each prediction from the sample space: P(even on one die), P(heads on one fair coin), and P(rolling greater than 4 on one die). For each, ask: 'Which outcomes are favorable? How many outcomes are possible? What fraction is that?' Add a complement question such as 'What fraction is NOT even?' Stretch: ask which total they think is most likely with two dice and why; guide them to count or organize the pairs, not guess. Target ideas: theoretical_probability_simple, probability_as_fraction, complement_probability, and compound_two_dice.",
            deliverable: {
              kind: "text",
              prompt:
                "Make a prediction card for three chance questions: P(even on a die), P(heads on a coin), and P(>4 on a die). For each one, list the possible outcomes, circle the favorable outcomes, write the probability as a fraction, and add one sentence explaining your reasoning. Stretch: Which two-dice total do you predict will show up most often? Explain without just guessing.",
              mode: "manual",
              criteria: [
                {
                  id: "names-sample-space",
                  label: "Names the possible outcomes",
                  description:
                    "The prediction starts by listing or clearly describing the sample space.",
                },
                {
                  id: "uses-favorable-over-total",
                  label: "Uses favorable over total",
                  description:
                    "Each probability is written as a fraction comparing favorable outcomes to total equally likely outcomes.",
                },
                {
                  id: "reasons-before-rolling",
                  label: "Makes a reasoned prediction",
                  description:
                    "The scholar explains why the prediction should make sense before relying on rolls or flips.",
                },
              ],
            },
          },
        ],
      },
    ],
  },

  // ── Shard 2: Small Moments (ELA narrative writing) ────────────────────────
  {
    key: "u.smallmoments",
    teacherKey: "t.kawena",
    title: "Small Moments",
    slug: "small-moments",
    emoji: "✏️",
    subject: "Language Arts",
    gradeLevel: "Grade 2",
    targetBloomLevel: "create",
    bigIdea:
      "The best stories come from zooming in on one small moment and filling it with exactly what you saw, heard, felt, and thought.",
    description:
      "An entry unit into personal narrative writing for the ʻIwa pod. Scholars move from 'I wrote about my whole weekend' to 'I wrote about the exact moment the wave knocked me over', discovering that specificity — sensory detail, strong verbs, a clear ending — is what makes a reader feel present.",
    essentialQuestions: [
      {
        key: "eq.smallmoments.detail",
        text: "What makes a reader feel like they were actually there with you?",
      },
      {
        key: "eq.smallmoments.zoom",
        text: "Why is writing about one small moment often more powerful than writing about a whole big event?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.smallmoments.specific",
        text: "Specific sensory details (what you saw, heard, smelled, felt) put the reader inside the moment; vague words keep the reader outside.",
      },
      {
        key: "eu.smallmoments.ending",
        text: "A strong ending does more than stop the story — it shows what the moment meant to the writer.",
      },
    ],
    badgeOnCompletion: {
      title: "Moment Keeper",
      description: "Zoomed in on one small moment and made it vivid for a reader.",
      icon: "🔍",
    },
    lessons: [
      {
        key: "l.smallmoments.intro",
        unitKey: "u.smallmoments",
        title: "What is a small moment?",
        order: 0,
        strand: "core",
        durationMinutes: 50,
        activities: [
          {
            key: "a.smallmoments.baseline",
            lessonKey: "l.smallmoments.intro",
            title: "Tell me a story: your current writing",
            order: 0,
            kind: "online",
            recipe: "baseline",
            durationMinutes: 15,
            defaultMode: "classFocus",
            description:
              "A stealth pre-assessment: the tutor invites the scholar to share a story from their life and listens for how wide or narrow the moment is, and whether sensory detail appears spontaneously.",
            scholarDescription:
              "Tell a story about something that really happened to you. Share it however you like — there's no wrong way to tell it.",
            systemPrompt:
              "You are eliciting, not teaching. Ask the scholar to tell you about something that happened recently — something real. Listen for the scope (wide = 'my whole vacation'; narrow = 'the second the wave hit me'). Note any spontaneous sensory detail. Do NOT model or correct — surface their current storytelling instincts.",
          },
          {
            key: "a.smallmoments.draft",
            lessonKey: "l.smallmoments.intro",
            title: "Write the moment that mattered most",
            order: 1,
            kind: "online",
            durationMinutes: 35,
            defaultMode: "homework",
            description:
              "The scholar picks one narrow moment, drafts 3–5 sentences, and polishes with at least one sensory detail and a closing sentence that shows what the moment meant.",
            scholarDescription:
              "Pick one small moment that mattered to you and write 3–5 sentences about it. Add a detail that lets your reader see or hear it, and end with what the moment meant.",
            systemPrompt:
              "Help the scholar zoom in. If they describe a whole event, ask: 'Which one second of that do you remember most clearly?' Once they have a moment, press for sensory details: what did you see, hear, feel? Remind them a strong ending is more than 'and then I went home' — what did the moment make them think or feel?",
            deliverable: {
              kind: "text",
              prompt:
                "Write 3–5 sentences about one small moment from your life. Use at least one sensory detail and end with a sentence that shows what the moment meant to you.",
              mode: "manual",
              criteria: [
                {
                  id: "small-moment",
                  label: "Stays on one narrow moment",
                  description:
                    "The writing is zoomed in — not a summary of a whole day or event, but one specific slice of time.",
                },
                {
                  id: "sensory-detail",
                  label: "Uses at least one sensory detail",
                  description:
                    "At least one detail tells the reader what the writer saw, heard, felt, smelled, or tasted.",
                },
                {
                  id: "strong-ending",
                  label: "Ends with meaning",
                  description:
                    "The final sentence does more than stop the story — it hints at what the moment meant to the writer.",
                },
              ],
            },
          },
        ],
      },
    ],
  },

  // ── Independent study: scholar-authored units ───────────────────────────
  // These carry `authorScholarKey` → the inserter stamps teacherId ===
  // authorScholarId === the scholar (mirrors createQuest). They
  // surface on the teacher "Independent" tab (units.listScholarAuthored) and on
  // the authoring scholar's own home. Each has a small lesson so the tab shows
  // real lesson/activity counts rather than an empty shell.
  {
    key: "u.is.kalei.volcanoes",
    teacherKey: "s.kalei",
    authorScholarKey: "s.kalei",
    title: "How Volcanoes Build Islands",
    slug: "is-kalei-volcanoes",
    emoji: "🌋",
    subject: "Science",
    description:
      "An independent deep-dive into how Hawai‘i's islands were built by volcanoes, one lava flow at a time — and why the islands get older to the northwest.",
    scholarDescription:
      "Your deep-dive into how Hawai‘i's islands were built by volcanoes, one lava flow at a time — and why the islands get older to the northwest.",
    bigIdea:
      "The Hawaiian islands are a record of deep time: a single hotspot built each island in turn as the plate drifted over it.",
    essentialQuestions: [
      { key: "eq.is.volcanoes.build", text: "How does an island get built from the bottom of the ocean?" },
      { key: "eq.is.volcanoes.age", text: "Why is Kaua‘i older than the Big Island?" },
    ],
    badgeOnCompletion: {
      title: "How Volcanoes Build Islands — completed",
      description: "Earned by completing every activity in this volcano study.",
      icon: "🏆",
    },
    lessons: [
      {
        key: "l.is.kalei.volcanoes.start",
        unitKey: "u.is.kalei.volcanoes",
        title: "Hotspots and hardening lava",
        order: 0,
        strand: "core",
        durationMinutes: 30,
        activities: [
          {
            key: "a.is.kalei.volcanoes.kickoff",
            lessonKey: "l.is.kalei.volcanoes.start",
            title: "What do you already know about volcanoes?",
            order: 0,
            kind: "online",
            durationMinutes: 20,
            defaultMode: "classFocus",
            description:
              "A kickoff conversation where you explain what you think builds an island, and the tutor draws out questions to investigate.",
            scholarDescription:
              "Kick things off by explaining what you think builds an island — then turn your own questions into things worth investigating.",
            systemPrompt:
              "This is an independent study on how volcanoes build islands. Be a curious thinking-partner, not a lecturer. Ask what they already believe about how islands form, surface their genuine questions, and help them turn one into something they could investigate. Follow their curiosity.",
          },
        ],
      },
    ],
  },
  {
    key: "u.is.emma.comics",
    teacherKey: "s.emma",
    authorScholarKey: "s.emma",
    title: "Drawing Comics That Tell Stories",
    slug: "is-emma-comics",
    emoji: "✏️",
    subject: "Art & Writing",
    description:
      "A self-directed study of how comics tell a story across panels — pacing, what to show vs. tell, and giving characters feelings the reader can see.",
    scholarDescription:
      "Your self-directed study of how comics tell a story across panels — pacing, what to show vs. tell, and giving characters feelings the reader can see.",
    bigIdea:
      "A comic tells a story through choices: which moments get a panel, what happens in the gutters between them, and how a face or pose carries feeling.",
    essentialQuestions: [
      { key: "eq.is.comics.panel", text: "How do you decide which moments get a panel?" },
      { key: "eq.is.comics.feeling", text: "How can a drawing show what a character feels?" },
    ],
    badgeOnCompletion: {
      title: "Drawing Comics That Tell Stories — completed",
      description: "Earned by completing every activity in this comics study.",
      icon: "🏆",
    },
    lessons: [
      {
        key: "l.is.emma.comics.start",
        unitKey: "u.is.emma.comics",
        title: "Panels, gutters, and pacing",
        order: 0,
        strand: "core",
        durationMinutes: 30,
        activities: [
          {
            key: "a.is.emma.comics.kickoff",
            lessonKey: "l.is.emma.comics.start",
            title: "Plan a three-panel comic of a small moment",
            order: 0,
            kind: "online",
            durationMinutes: 25,
            defaultMode: "classFocus",
            description:
              "Plan a tiny three-panel comic of a real small moment, deciding what each panel shows and what happens in the gutters between them.",
            scholarDescription:
              "Plan a tiny three-panel comic of a real small moment — decide what each panel shows and what the reader fills in between them.",
            systemPrompt:
              "This is an independent study that builds on the scholar's narrative writing. Help them pick ONE small moment and break it into exactly three panels: what does each panel show? Push gently on the gutters — what does the reader fill in between panels? Keep it about storytelling choices, not drawing skill.",
          },
        ],
      },
    ],
  },

  // ── ʻIwa pod (K-2): rounding out the four core subjects ────────────────────
  // Small Moments already covers Language Arts for K-2; these three give the
  // pod a Math, a Humanities, and a Science unit so every ʻIwa scholar carries
  // a full four-subject week on their Home.
  {
    key: "u.tenmore",
    teacherKey: "t.kawena",
    title: "Ten & More",
    slug: "ten-and-more",
    emoji: "🔟",
    subject: "Math Workshop",
    gradeLevel: "Grade 1",
    targetBloomLevel: "understand",
    bigIdea:
      "Ten is a friendly anchor: we can see any teen number as a full ten and some extra ones.",
    description:
      "Early number sense for the K-2 pod. Scholars build and break teen numbers on ten-frames, learning to see 14 as 'ten and four' rather than a string of ones.",
    essentialQuestions: [
      {
        key: "eq.tenmore.anchor",
        text: "Why is ten such a useful number to count around?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.tenmore.teenparts",
        text: "A teen number is one full ten plus some leftover ones, and seeing that makes it easier to count and compare.",
      },
    ],
    badgeOnCompletion: {
      title: "Ten-Frame Builder",
      description: "Built and broke teen numbers around a friendly ten.",
      icon: "🔟",
    },
    lessons: [
      {
        key: "l.tenmore.maketen",
        unitKey: "u.tenmore",
        title: "Ten and some more",
        order: 0,
        strand: "core",
        durationMinutes: 25,
        systemPrompt:
          "Keep it concrete and warm for a Grade-1 scholar. Use a ten-frame (drawn or in-app). Ask them to fill a ten-frame and notice when it is full, then show a teen number and ask 'how many tens? how many extra ones?' Never rush to the numeral — press on the 'ten and ___ more' idea. Target ideas: make_ten and teen_place_value.",
        activities: [
          {
            key: "a.tenmore.flash",
            lessonKey: "l.tenmore.maketen",
            title: "Ten-frame flash: how many?",
            order: 0,
            kind: "online",
            durationMinutes: 25,
            defaultMode: "classFocus",
            description:
              "Scholars see a filled ten-frame and a few loose counters, then say the teen number as 'ten and some more'.",
            scholarDescription:
              "Look at a full ten-frame with a few extra counters, and say the teen number as 'ten and some more'.",
            systemPrompt:
              "Flash a full ten-frame plus 1-9 extra dots. Ask the scholar how many in all and how they know. Guide them to 'one ten and ___ ones', not counting by ones from zero. Celebrate the ten as an anchor.",
          },
        ],
      },
    ],
  },
  {
    key: "u.community",
    teacherKey: "t.kawena",
    title: "Helpers in Our Community",
    slug: "community-helpers",
    emoji: "🏘️",
    subject: "Humanities",
    gradeLevel: "Grade 1",
    targetBloomLevel: "understand",
    bigIdea:
      "A community works because many people do jobs that take care of each other.",
    description:
      "A K-2 introduction to community. Scholars name the helpers around them — at school, in the neighborhood, along the shore — and describe how each one's work helps others.",
    essentialQuestions: [
      {
        key: "eq.community.helpers",
        text: "Who helps our community, and how does their work help us?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.community.interdependence",
        text: "People in a community depend on each other's jobs, so caring for the community means caring for each other.",
      },
    ],
    badgeOnCompletion: {
      title: "Community Mapper",
      description: "Named the helpers who take care of our community.",
      icon: "🏘️",
    },
    lessons: [
      {
        key: "l.community.helpers",
        unitKey: "u.community",
        title: "Who helps us?",
        order: 0,
        strand: "core",
        durationMinutes: 25,
        systemPrompt:
          "Warm and concrete for Grade 1. Ask the scholar to name people who help our community — teachers, farmers, bus drivers, lifeguards, kūpuna. For each one, ask 'what job do they do, and who does it help?' Draw out the idea that jobs connect people. Target ideas: community_roles and interdependence.",
        activities: [
          {
            key: "a.community.interview",
            lessonKey: "l.community.helpers",
            title: "Meet a community helper",
            order: 0,
            kind: "online",
            durationMinutes: 25,
            defaultMode: "classFocus",
            description:
              "Scholars pick one community helper, describe their job, and explain who that job helps.",
            scholarDescription:
              "Pick one helper in your community, describe what they do, and explain who their work helps.",
            systemPrompt:
              "Have the scholar choose ONE helper they know. Ask what the helper does each day and who is better off because of it. Keep it about the connection between the job and the people it serves.",
          },
        ],
      },
    ],
  },
  {
    key: "u.weather",
    teacherKey: "t.daniel",
    title: "Weather Watchers",
    slug: "weather-watchers",
    emoji: "⛅",
    subject: "Science",
    gradeLevel: "Grade 1",
    targetBloomLevel: "understand",
    bigIdea:
      "We can observe the sky and describe today's weather, and patterns start to appear when we watch over time.",
    description:
      "A K-2 observation unit. Scholars watch the daily sky, describe the weather in their own words, and begin noticing patterns across the week.",
    essentialQuestions: [
      {
        key: "eq.weather.observe",
        text: "How can we describe today's weather, and what patterns do we notice?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.weather.patterns",
        text: "Careful daily observation lets us describe weather and spot patterns over time.",
      },
    ],
    badgeOnCompletion: {
      title: "Weather Watcher",
      description: "Observed and described the sky over a week.",
      icon: "⛅",
    },
    lessons: [
      {
        key: "l.weather.today",
        unitKey: "u.weather",
        title: "What's the weather today?",
        order: 0,
        strand: "core",
        durationMinutes: 20,
        systemPrompt:
          "Concrete and sensory for Grade 1. Ask the scholar to look outside (or remember this morning) and describe the sky, the air, and the wind. Offer weather words — sunny, cloudy, rainy, windy — and ask which fit today. Nudge toward noticing change across days. Target ideas: weather_observation and daily_pattern.",
        activities: [
          {
            key: "a.weather.journal",
            lessonKey: "l.weather.today",
            title: "Weather journal: today's sky",
            order: 0,
            kind: "online",
            durationMinutes: 20,
            defaultMode: "homework",
            description:
              "Scholars record today's weather with a word and a sentence, then guess what tomorrow might bring.",
            scholarDescription:
              "Write down today's weather in one word and one sentence about how you can tell — then make a guess about tomorrow.",
            systemPrompt:
              "Ask the scholar to name today's weather in one word and one sentence about how they can tell. Then ask what they predict for tomorrow and why. Keep predictions playful — observation first, no right answer.",
          },
        ],
      },
    ],
  },

  // ── Honu pod (3-5): rounding out the four core subjects ────────────────────
  // Fraction Sense + A Feel for Chance already cover Math for 3-5; these three
  // give the pod a Language Arts, a Humanities, and a Science unit so every
  // Honu scholar carries a full four-subject week on their Home.
  {
    key: "u.bookclubs",
    teacherKey: "t.kawena",
    title: "Book Clubs: Character & Theme",
    slug: "book-clubs",
    emoji: "📚",
    subject: "Language Arts",
    gradeLevel: "Grade 4",
    targetBloomLevel: "analyze",
    bigIdea:
      "What a character wants — and how that want changes — is how a story carries its themes.",
    description:
      "A 3-5 literature unit. Scholars read in small book clubs, track what their character wants and fears, and use that evidence to argue for a theme the book is exploring.",
    essentialQuestions: [
      {
        key: "eq.bookclubs.want",
        text: "How does what a character wants reveal what a story is really about?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.bookclubs.evidence",
        text: "Readers infer theme from patterns in a character's choices, backing each claim with textual evidence.",
      },
    ],
    badgeOnCompletion: {
      title: "Close Reader",
      description: "Traced a character's wants to argue for a theme with evidence.",
      icon: "📚",
    },
    lessons: [
      {
        key: "l.bookclubs.character",
        unitKey: "u.bookclubs",
        title: "What does your character want?",
        order: 0,
        strand: "core",
        durationMinutes: 40,
        systemPrompt:
          "For a Grade-4 reader in a book club. Ask the scholar what their character wants most and what gets in the way. Push for a specific line or scene as evidence, then ask what that struggle might be teaching the reader. Withhold naming the theme — guide them to propose one and defend it. Target ideas: character_motivation and theme_from_evidence.",
        activities: [
          {
            key: "a.bookclubs.closeread",
            lessonKey: "l.bookclubs.character",
            title: "Close-read your character's want",
            order: 0,
            kind: "online",
            durationMinutes: 40,
            defaultMode: "classFocus",
            description:
              "Scholars name their character's central want, cite a scene that shows it, and propose a theme the book may be exploring.",
            scholarDescription:
              "Name what your character wants most, point to a scene that shows it, and propose a theme the book might be exploring.",
            systemPrompt:
              "Have the scholar state their character's biggest want, quote or paraphrase one scene that proves it, and then propose what the book might be saying about that want. Ask 'what in the text makes you think so?' for every claim.",
          },
        ],
      },
    ],
  },
  {
    key: "u.islands",
    teacherKey: "t.kawena",
    title: "Mapping Our Islands",
    slug: "mapping-our-islands",
    emoji: "🗺️",
    subject: "Humanities",
    gradeLevel: "Grade 4",
    targetBloomLevel: "analyze",
    bigIdea:
      "Where people settle and how they live is shaped by the land and water around them.",
    description:
      "A 3-5 geography and history unit. Scholars read maps of their islands, connect landforms and water to where communities grew, and tell the story a place holds.",
    essentialQuestions: [
      {
        key: "eq.islands.place",
        text: "How does the land and water of a place shape the people who live there?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.islands.geography",
        text: "Geography influences settlement, work, and culture — reading a map is reading a community's story.",
      },
    ],
    badgeOnCompletion: {
      title: "Island Cartographer",
      description: "Read the land to tell a community's story.",
      icon: "🗺️",
    },
    lessons: [
      {
        key: "l.islands.readland",
        unitKey: "u.islands",
        title: "Reading the land",
        order: 0,
        strand: "core",
        durationMinutes: 40,
        systemPrompt:
          "For a Grade-4 scholar. Show or describe an island map with mountains, valleys, streams, and shore. Ask where they think a community would grow and why, drawing on the water, the flat land, and the coast. Connect physical features to human choices. Target ideas: map_reading and geography_shapes_community.",
        activities: [
          {
            key: "a.islands.mapstory",
            lessonKey: "l.islands.readland",
            title: "Map story: why here?",
            order: 0,
            kind: "online",
            durationMinutes: 40,
            defaultMode: "homework",
            description:
              "Scholars choose a spot on an island map and explain, using landforms and water, why a community might have grown there.",
            scholarDescription:
              "Choose a spot on an island map and explain — using the landforms and water around it — why a community might have grown there.",
            systemPrompt:
              "Ask the scholar to pick a place on the map and argue why people would settle there — access to fresh water, farmable land, a protected shore. Push for reasons tied to the geography, not just 'it looks nice'.",
          },
        ],
      },
    ],
  },
  {
    key: "u.tidepools",
    teacherKey: "t.daniel",
    title: "Tide Pool Ecosystems",
    slug: "tide-pools",
    emoji: "🐚",
    subject: "Science",
    gradeLevel: "Grade 4",
    targetBloomLevel: "analyze",
    bigIdea:
      "A tide pool is a small ecosystem where living things depend on each other and on the rhythm of the tides.",
    description:
      "A 3-5 life-science unit. Scholars observe tide-pool life, map who eats whom, and reason about how the changing tide shapes survival in the pool.",
    essentialQuestions: [
      {
        key: "eq.tidepools.depend",
        text: "How do the living things in a tide pool depend on each other and on the tides?",
      },
    ],
    enduringUnderstandings: [
      {
        key: "eu.tidepools.ecosystem",
        text: "In an ecosystem, organisms are connected through food and habitat, so a change to one affects the others.",
      },
    ],
    badgeOnCompletion: {
      title: "Tide Pool Naturalist",
      description: "Mapped the living connections in a tide pool.",
      icon: "🐚",
    },
    lessons: [
      {
        key: "l.tidepools.wholives",
        unitKey: "u.tidepools",
        title: "Who lives in a tide pool?",
        order: 0,
        strand: "core",
        durationMinutes: 40,
        systemPrompt:
          "For a Grade-4 scholar. Ask what lives in a tide pool — limpets, crabs, ʻopihi, small fish, algae. Have them describe who eats what and who needs the rocks or the water to survive. Then ask what happens when the tide goes out. Build toward interdependence. Target ideas: food_web and habitat_dependence.",
        activities: [
          {
            key: "a.tidepools.fieldnotes",
            lessonKey: "l.tidepools.wholives",
            title: "Tide-pool field notes",
            order: 0,
            kind: "online",
            durationMinutes: 40,
            defaultMode: "homework",
            description:
              "Scholars list tide-pool organisms, sketch one feeding connection, and explain how the tide changes life in the pool.",
            scholarDescription:
              "List the living things in a tide pool, sketch one 'who eats whom' connection, and explain how the changing tide shapes life in the pool.",
            systemPrompt:
              "Ask the scholar to name several tide-pool organisms, then trace ONE 'who eats whom' connection. Follow with: what does low tide change for these animals? Press for reasoning about dependence, not just a list.",
          },
        ],
      },
    ],
  },
];
