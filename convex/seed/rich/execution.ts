// ─── Rich-cohort seed: EXECUTION (Execution layer) ────────────────────────
//
// Scenario: end of Week 1 of class. The Honu pod has just started the
// "Fraction Sense" unit — one assignment, eight scholar sessions across the
// pod, seven completions, one deliverable submission, and grounded judge
// verdicts on every completed session (the Sessions field record). Both cohort
// groups have active subject work, with a cross-group probability preview
// giving the 3-5 schedule a durable second assigned subject on scholar Home.
//
// All timestamps are RELATIVE OFFSETS (positive = "this long ago").
// String keys are stable; the inserter resolves them to Convex Ids.

import type {
  SeedAssignment,
  SeedSession,
  SeedDeliverableSubmission,
  SeedCompletion,
  SeedBadge,
  SeedAnalysis,
} from "./types";

// ── Assignments ──────────────────────────────────────────────────────────────

export const assignments: SeedAssignment[] = [
  {
    key: "as.fractions.honu",
    unitKey: "u.fractions",
    teacherKey: "t.daniel",
    scholarKeys: [
      "s.sage",
      "s.kalei",
      "s.tiare",
      "s.leilani",
      "s.makoa",
      "s.anela",
    ],
    startedAgoDays: 5,
    schedule: [
      {
        // baseline conversation — a CONCLUDED whole-class focus from earlier in
        // the week. This is the matured/debriefed unit, so its schedule reads as
        // history: set ~2 days ago and already ended (endsAt in the past). It
        // sits BEFORE the Agenda's current-week window, so it's correctly absent
        // from the live agenda while still powering the Debrief surface.
        activityKey: "a.fractions.baseline",
        mode: "classFocus",
        setAgoMinutes: 2880, // set 2 days ago
        endsInMinutes: -2820, // class ended ~2 days ago (concluded)
      },
      {
        // equivalence task — set 2 days ago as homework that is now past due
        // (the cohort has finished it; see activityCompletions). Past-due, so it
        // too is history rather than a live agenda item.
        activityKey: "a.fractions.equivalence",
        mode: "homework",
        setAgoMinutes: 2880, // set 2 days ago
        dueInDays: -1, // was due yesterday (past)
      },
      {
        // Practice-strand card sort — the unit's core is debriefed, but the
        // class is doing hands-on extension work THIS week, so dchar's agenda
        // isn't empty. OFFLINE, so it doesn't affect the unit's rehearse/debrief
        // maturity (which counts only online activities). Live in class now.
        activityKey: "a.fractions.cardsort",
        mode: "classFocus",
        setAgoMinutes: 30, // started ~30 min ago (today, in class)
        endsInMinutes: 50, // still in class — ends in 50 min
      },
      {
        // Fraction Hunt — a PLANNED homework push later this week (startsAt in
        // the future, not yet live to scholars). Lands on a future agenda day so
        // dchar's week reads as paced, not stacked on one day.
        activityKey: "a.fractions.hunt",
        mode: "homework",
        startsInDays: 2, // planned for 2 days out
        dueInDays: 5,
      },
    ],
  },

  // ── Shard 2: Small Moments assignment (ʻIwa pod) ─────────────────────────
  {
    key: "as.smallmoments.iwa",
    unitKey: "u.smallmoments",
    teacherKey: "t.kawena",
    scholarKeys: [
      "s.keoni",
      "s.malia",
      "s.iokepa",
      "s.nainoa",
      "s.emma",
      "s.koa",
    ],
    startedAgoDays: 3,
    schedule: [
      {
        // baseline conversation — today's live whole-class focus (in class now).
        activityKey: "a.smallmoments.baseline",
        mode: "classFocus",
        setAgoMinutes: 120, // set ~2h ago (today)
        endsInMinutes: 45, // still in class — ends in 45 min
      },
      {
        // draft writing task — set in class today, open as homework due in 3
        // days. setAgoMinutes is what positions it on the Agenda; without it the
        // entry falls back to the assignment's startedAt (days ago).
        activityKey: "a.smallmoments.draft",
        mode: "homework",
        setAgoMinutes: 120, // set in class today
        dueInDays: 3,
      },
      {
        // revision workshop — a PLANNED in-class day later this week to revise
        // the drafts (a second pass on the same activity; realistic multi-day
        // writing process). Planned (startsAt future, not yet live), so it lands
        // on a future agenda day and keeps kawena's week paced across days.
        activityKey: "a.smallmoments.draft",
        mode: "classFocus",
        startsInDays: 3, // planned revision day, 3 days out
      },
    ],
  },
  {
    key: "as.probability.35",
    unitKey: "u.probability",
    teacherKey: "t.daniel",
    scholarKeys: [
      "s.sage",
      "s.kalei",
      "s.tiare",
      "s.leilani",
      "s.makoa",
      "s.anela",
    ],
    title: "A Feel for Chance",
    startedAgoDays: 1,
    schedule: [
      {
        activityKey: "a.probability.rollflip",
        mode: "homework",
        setAgoMinutes: 90,
        dueInDays: 4,
      },
    ],
  },

  // ── Four-subject coverage ─────────────────────────────────────────────────
  // Each grade-band pod already anchors one subject in depth (ʻIwa → Small
  // Moments / Language Arts; Honu → Fraction Sense + probability / Math). These
  // lightweight assignments give every scholar a live item in the remaining
  // core subjects so each Home shows a full Language Arts + Math + Humanities +
  // Science week. Rosters are the full pods (grade-band aligned).
  {
    key: "as.tenmore.iwa",
    unitKey: "u.tenmore",
    teacherKey: "t.kawena",
    scholarKeys: [
      "s.keoni",
      "s.malia",
      "s.iokepa",
      "s.nainoa",
      "s.emma",
      "s.koa",
    ],
    startedAgoDays: 4,
    schedule: [
      {
        activityKey: "a.tenmore.flash",
        mode: "classFocus",
        setAgoMinutes: 20,
        endsInMinutes: 40,
      },
    ],
  },
  {
    key: "as.community.iwa",
    unitKey: "u.community",
    teacherKey: "t.kawena",
    scholarKeys: [
      "s.keoni",
      "s.malia",
      "s.iokepa",
      "s.nainoa",
      "s.emma",
      "s.koa",
    ],
    startedAgoDays: 3,
    schedule: [
      {
        activityKey: "a.community.interview",
        mode: "homework",
        setAgoMinutes: 150,
        dueInDays: 3,
      },
    ],
  },
  {
    key: "as.weather.iwa",
    unitKey: "u.weather",
    teacherKey: "t.daniel",
    scholarKeys: [
      "s.keoni",
      "s.malia",
      "s.iokepa",
      "s.nainoa",
      "s.emma",
      "s.koa",
    ],
    startedAgoDays: 2,
    schedule: [
      {
        activityKey: "a.weather.journal",
        mode: "homework",
        setAgoMinutes: 60,
        dueInDays: 2,
      },
    ],
  },
  {
    key: "as.bookclubs.honu",
    unitKey: "u.bookclubs",
    teacherKey: "t.kawena",
    scholarKeys: [
      "s.sage",
      "s.kalei",
      "s.tiare",
      "s.leilani",
      "s.makoa",
      "s.anela",
    ],
    startedAgoDays: 4,
    schedule: [
      {
        activityKey: "a.bookclubs.closeread",
        mode: "classFocus",
        setAgoMinutes: 25,
        endsInMinutes: 45,
      },
    ],
  },
  {
    key: "as.islands.honu",
    unitKey: "u.islands",
    teacherKey: "t.kawena",
    scholarKeys: [
      "s.sage",
      "s.kalei",
      "s.tiare",
      "s.leilani",
      "s.makoa",
      "s.anela",
    ],
    startedAgoDays: 3,
    schedule: [
      {
        activityKey: "a.islands.mapstory",
        mode: "homework",
        setAgoMinutes: 150,
        dueInDays: 4,
      },
    ],
  },
  {
    key: "as.tidepools.honu",
    unitKey: "u.tidepools",
    teacherKey: "t.daniel",
    scholarKeys: [
      "s.sage",
      "s.kalei",
      "s.tiare",
      "s.leilani",
      "s.makoa",
      "s.anela",
    ],
    startedAgoDays: 2,
    schedule: [
      {
        activityKey: "a.tidepools.fieldnotes",
        mode: "homework",
        setAgoMinutes: 60,
        dueInDays: 3,
      },
    ],
  },
];

// ── Sessions ─────────────────────────────────────────────────────────────────

export const sessions: SeedSession[] = [
  // ── Kalei × baseline ───────────────────────────────────────────────────────
  // Grade 4, working 2 levels up. Strong number sense, impatient with slow
  // pace. Completed the baseline quickly and got it right.
  {
    key: "sess.kalei.baseline",
    scholarKey: "s.kalei",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.baseline",
    assignmentKey: "as.fractions.honu",
    title: "Pizza talk: your current thinking",
    lastMessageAgoMinutes: 6000,
    activityCompletedAgoMinutes: 5990,
    pulseScore: 5,
    analysisSummary:
      "Kalei demonstrated strong intuitive fraction sense — immediately articulated the inverse relationship between denominator size and piece size. Ready for equivalence without scaffolding.",
    teacherWhisper:
      "Push him straight to the hard version — he already grasps denominator meaning. Don't let him coast. Ask about equivalent fractions before he asks you.",
    messages: [
      {
        role: "user",
        content:
          "Fractions are like pizza slices. Like 3/8 means I ate 3 slices out of 8 total slices.",
        agoMinutes: 55,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "Nice! So what does the 8 actually tell you? And if I changed that 8 to a 4, what would happen to each slice?",
        agoMinutes: 50,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "The 8 is how many pieces the pizza got cut into. If you change it to 4, each slice is way bigger — same pizza, fewer cuts.",
        agoMinutes: 35,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "Interesting. So does 3/8 give you the same amount of pizza as 3/4? Both say 3 slices — does that make them equal?",
        agoMinutes: 20,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "No, 3/4 is way more! Three big slices beats three small slices. The bottom number controls how big each piece is, so the bottom number really matters.",
        agoMinutes: 4,
        flagged: false,
      },
    ],
  },

  // ── Kalei × equivalence ────────────────────────────────────────────────────
  // Builds the 1/2 = 2/4 argument, correctly invoking same-whole constraint.
  {
    key: "sess.kalei.equiv",
    scholarKey: "s.kalei",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.equivalence",
    assignmentKey: "as.fractions.honu",
    title: "Show that 1/2 = 2/4",
    lastMessageAgoMinutes: 1200,
    activityCompletedAgoMinutes: 1180,
    messages: [
      {
        role: "user",
        content:
          "Okay so I need to prove 1/2 equals 2/4. I'm going to draw two identical rectangles.",
        agoMinutes: 45,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "Good plan! Once you have those rectangles, what will you do to show the two fractions on them?",
        agoMinutes: 38,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "First one: cut down the middle into 2 equal halves, shade 1. Second one: cut into 4 equal parts, shade 2. The shaded part is the same size both times.",
        agoMinutes: 22,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "Strong argument. One thing to make really explicit — why does it matter that both rectangles are the same size? What breaks if they're different?",
        agoMinutes: 12,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "Because 1/2 of a big pizza isn't the same as 2/4 of a tiny pizza. You have to use the SAME whole, otherwise you're not comparing fairly. That's the whole point.",
        agoMinutes: 2,
        flagged: false,
      },
    ],
  },

  // ── Sage × baseline ────────────────────────────────────────────────────────
  // Grade 3, on-level. Arrived with a standard "parts of a whole" definition
  // and self-initiated the key question about equal piece sizes.
  {
    key: "sess.sage.baseline",
    scholarKey: "s.sage",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.baseline",
    assignmentKey: "as.fractions.honu",
    title: "Pizza talk: your current thinking",
    lastMessageAgoMinutes: 4000,
    activityCompletedAgoMinutes: 3985,
    messages: [
      {
        role: "user",
        content:
          "A fraction is a part of something. Like 1/2 means one out of two pieces.",
        agoMinutes: 38,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "I like that! Does it matter how big each piece is — or can you split something any way you want and call it 1/2?",
        agoMinutes: 30,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "Hmm… I think they have to be the same size? Like if I cut my sandwich really uneven and eat the big part, that doesn't feel like half.",
        agoMinutes: 15,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "That's exactly the right thing to wonder about. So what would we need to be true for a split to actually count as 1/2?",
        agoMinutes: 4,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
    ],
  },

  // ── Leilani × baseline ─────────────────────────────────────────────────────
  // Grade 3, on-level. Reveals the classic "count-the-pieces" misconception —
  // believes any 1 out of 4 pieces is 1/4 regardless of piece size.
  // Session is NOT completed (no activityCompletedAgoMinutes).
  {
    key: "sess.leilani.baseline",
    scholarKey: "s.leilani",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.baseline",
    assignmentKey: "as.fractions.honu",
    title: "Pizza talk: your current thinking",
    lastMessageAgoMinutes: 2000,
    messages: [
      {
        role: "user",
        content:
          "Fractions are when you split something up. Like 1/4 means you cut it into 4 pieces and you take 1 piece.",
        agoMinutes: 32,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "Good start! When you picture those 4 pieces — what do the pieces look like?",
        agoMinutes: 25,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "They can be any size, like maybe some are bigger and some smaller. But as long as there are 4 pieces and I take 1, that's 1/4.",
        agoMinutes: 14,
        flagged: true,
        flagReason: "misconception surfaced",
      },
      {
        role: "assistant",
        content:
          "Interesting! Let's think about this together — if I cut a granola bar into 4 pieces but one piece is almost the whole bar and the others are just crumbs, is my big piece really 1/4? What do you think?",
        agoMinutes: 4,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
    ],
  },

  // ── Keoni × baseline ───────────────────────────────────────────────────────
  // Grade 3, on-level. Solid "equal parts" instinct; completed cleanly.
  {
    key: "sess.keoni.baseline",
    scholarKey: "s.keoni",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.baseline",
    assignmentKey: "as.fractions.honu",
    title: "Pizza talk: your current thinking",
    lastMessageAgoMinutes: 4600,
    activityCompletedAgoMinutes: 4585,
    pulseScore: 4,
    messages: [
      {
        role: "user",
        content:
          "1/3 means the thing got split into 3 fair parts and you have one of them.",
        agoMinutes: 30,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "You said 'fair parts' — that's a big word. Why does fair matter here?",
        agoMinutes: 24,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "Because if the parts aren't equal then one third isn't really a third, it's just one piece that could be any size.",
        agoMinutes: 6,
        flagged: false,
      },
    ],
  },

  // ── Malia × baseline ───────────────────────────────────────────────────────
  // Grade 4, working up. Fast and precise; nailed the same-whole idea unasked.
  {
    key: "sess.malia.baseline",
    scholarKey: "s.malia",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.baseline",
    assignmentKey: "as.fractions.honu",
    title: "Pizza talk: your current thinking",
    lastMessageAgoMinutes: 4400,
    activityCompletedAgoMinutes: 4390,
    pulseScore: 5,
    messages: [
      {
        role: "user",
        content:
          "A fraction is a number between whole numbers. 3/4 is more than a half but less than one whole.",
        agoMinutes: 28,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "Placing it on a number line — nice. How would you convince a friend 3/4 is bigger than 2/3?",
        agoMinutes: 20,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "Same-size wholes, then compare the shaded parts. 3/4 covers more of the bar than 2/3 does, so it wins.",
        agoMinutes: 3,
        flagged: false,
      },
    ],
  },

  // ── Tiare × baseline ───────────────────────────────────────────────────────
  // Grade 2, developing. Hesitant start, but self-corrected to equal parts.
  {
    key: "sess.tiare.baseline",
    scholarKey: "s.tiare",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.baseline",
    assignmentKey: "as.fractions.honu",
    title: "Pizza talk: your current thinking",
    lastMessageAgoMinutes: 4200,
    activityCompletedAgoMinutes: 4180,
    pulseScore: 4,
    messages: [
      {
        role: "user",
        content: "1/2 is like when you break a cookie and take one piece.",
        agoMinutes: 26,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "Any piece, or a special piece? If your piece is the tiny crumb, is that still 1/2?",
        agoMinutes: 18,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "Ohh no — it has to be the same as the other piece. Both halves equal. The crumb one doesn't count.",
        agoMinutes: 5,
        flagged: false,
      },
    ],
  },

  // ── Malia × equivalence ────────────────────────────────────────────────────
  // Reaches 1/2 = 2/4 but leans on the procedure before the meaning.
  {
    key: "sess.malia.equiv",
    scholarKey: "s.malia",
    unitKey: "u.fractions",
    lessonKey: "l.fractions.intro",
    activityKey: "a.fractions.equivalence",
    assignmentKey: "as.fractions.honu",
    title: "Show that 1/2 = 2/4",
    lastMessageAgoMinutes: 1400,
    activityCompletedAgoMinutes: 1385,
    pulseScore: 4,
    messages: [
      {
        role: "user",
        content:
          "You just multiply top and bottom by 2. 1 times 2 is 2, 2 times 2 is 4, so 1/2 = 2/4.",
        agoMinutes: 24,
        flagged: false,
      },
      {
        role: "assistant",
        content:
          "That rule works. But why does doubling both keep the value the same? Picture it.",
        agoMinutes: 16,
        flagged: false,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content:
          "Because you're cutting each half into two, so you have twice as many pieces but each is half as big. Same amount shaded.",
        agoMinutes: 4,
        flagged: false,
      },
    ],
  },

  // ── Shard 2: ʻIwa pod × Small Moments ────────────────────────────────────
  // ── Nainoa × baseline ──────────────────────────────────────────────────────
  // Kindergarten. Wide scope (camping trip = whole weekend). Willing narrator,
  // no sensory detail yet. Session NOT completed.
  {
    key: "sess.nainoa.baseline",
    scholarKey: "s.nainoa",
    unitKey: "u.smallmoments",
    lessonKey: "l.smallmoments.intro",
    activityKey: "a.smallmoments.baseline",
    assignmentKey: "as.smallmoments.iwa",
    title: "Tell me a story: your current writing",
    lastMessageAgoMinutes: 4200,
    messages: [
      {
        role: "user",
        content: "I want to write about my camping trip. We went for two days and we saw deer and made s'mores and swam in the river.",
        agoMinutes: 28,
      },
      {
        role: "assistant",
        content: "That sounds like so much happened! Which part do you remember the very most clearly — like if you close your eyes right now, what do you see?",
        agoMinutes: 22,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content: "Um… the s'more. When the chocolate melted and got on my fingers.",
        agoMinutes: 10,
      },
      {
        role: "assistant",
        content: "Oh yes — that's a great picture. What did it feel like on your fingers?",
        agoMinutes: 4,
        model: "claude-sonnet-4-5",
      },
    ],
  },

  // ── Emma × baseline ────────────────────────────────────────────────────────
  // Grade 1, strong oral narrator. Zoomed in quickly when asked. One spontaneous
  // sensory detail (burnt-sugar smoke). Session completed.
  {
    key: "sess.emma.baseline",
    scholarKey: "s.emma",
    unitKey: "u.smallmoments",
    lessonKey: "l.smallmoments.intro",
    activityKey: "a.smallmoments.baseline",
    assignmentKey: "as.smallmoments.iwa",
    title: "Tell me a story: your current writing",
    lastMessageAgoMinutes: 3800,
    activityCompletedAgoMinutes: 3785,
    pulseScore: 4,
    analysisSummary:
      "Emma zoomed in on one moment quickly when prompted and supplied a spontaneous sensory detail. Ready for the draft activity.",
    messages: [
      {
        role: "user",
        content: "I want to write about my birthday party.",
        agoMinutes: 35,
      },
      {
        role: "assistant",
        content: "Fun! Which one moment from your birthday party sticks with you the most?",
        agoMinutes: 29,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content: "When I blew out the candles. The smoke smelled like burnt sugar.",
        agoMinutes: 18,
      },
      {
        role: "assistant",
        content: "That detail — 'burnt sugar' — is exactly the kind of thing that puts a reader right there with you. What else did you notice in that moment?",
        agoMinutes: 8,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content: "Everyone was staring at me and it was quiet for a second before they started cheering.",
        agoMinutes: 2,
      },
    ],
  },

  // ── Emma × draft ───────────────────────────────────────────────────────────
  // Grade 1. Produced a complete 4-sentence draft meeting all three criteria.
  // Revised her ending spontaneously when the tutor questioned 'it was fun'.
  {
    key: "sess.emma.draft",
    scholarKey: "s.emma",
    unitKey: "u.smallmoments",
    lessonKey: "l.smallmoments.intro",
    activityKey: "a.smallmoments.draft",
    assignmentKey: "as.smallmoments.iwa",
    title: "Write the moment that mattered most",
    lastMessageAgoMinutes: 1500,
    activityCompletedAgoMinutes: 1480,
    pulseScore: 4,
    analysisSummary:
      "Emma's draft met all three criteria. She revised her ending after one nudge, upgrading it from generic to meaningful.",
    messages: [
      {
        role: "user",
        content: "I blew out the candles on my birthday cake. The smoke smelled like burnt sugar. Everyone was quiet and then they started cheering. It was fun.",
        agoMinutes: 42,
      },
      {
        role: "assistant",
        content: "This is really vivid — I can almost smell that smoke. I have one question: your last sentence says 'it was fun.' What did that moment actually mean to you? Was there more to it than just fun?",
        agoMinutes: 35,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content: "Like… it felt like everyone was there just for me. That doesn't happen very much.",
        agoMinutes: 20,
      },
      {
        role: "assistant",
        content: "That's a much more powerful ending. Can you swap out 'it was fun' for that feeling?",
        agoMinutes: 12,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content: "I blew out the candles on my birthday cake. The smoke smelled like burnt sugar and everyone went quiet. Then they cheered, all at once, just for me. I didn't know a room could feel that full.",
        agoMinutes: 3,
      },
    ],
  },

  // ── Koa × baseline ─────────────────────────────────────────────────────────
  // Grade 2. Wide scope (whole soccer season). No sensory detail even after
  // two follow-up prompts. Willing but not yet zoomed in. Not completed.
  {
    key: "sess.koa.baseline",
    scholarKey: "s.koa",
    unitKey: "u.smallmoments",
    lessonKey: "l.smallmoments.intro",
    activityKey: "a.smallmoments.baseline",
    assignmentKey: "as.smallmoments.iwa",
    title: "Tell me a story: your current writing",
    lastMessageAgoMinutes: 2800,
    messages: [
      {
        role: "user",
        content: "I want to write about soccer. I played the whole season and we won most of the games.",
        agoMinutes: 40,
      },
      {
        role: "assistant",
        content: "A whole season — that's a lot! Which single game or play stands out the most?",
        agoMinutes: 33,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content: "The championship game. We won 3–2 and I scored a goal.",
        agoMinutes: 20,
      },
      {
        role: "assistant",
        content: "Great — now zoom in even more. Tell me about the exact moment you scored. What did you see right before your foot hit the ball?",
        agoMinutes: 10,
        model: "claude-sonnet-4-5",
      },
      {
        role: "user",
        content: "I don't know. I just kicked it and it went in.",
        agoMinutes: 3,
      },
    ],
  },
];

// ── Deliverables ──────────────────────────────────────────────────────────────

export const deliverables: SeedDeliverableSubmission[] = [
  {
    key: "del.kalei.equiv",
    activityKey: "a.fractions.equivalence",
    scholarKey: "s.kalei",
    sessionKey: "sess.kalei.equiv",
    assignmentKey: "as.fractions.honu",
    textContent:
      "I drew two identical rectangles, same size, side by side. " +
      "Rectangle 1: I drew one line down the middle so I had 2 equal halves, and I shaded 1 half. That's 1/2. " +
      "Rectangle 2: I drew 3 lines to make 4 equal parts, and I shaded 2 of those parts. That's 2/4. " +
      "The shaded part on both rectangles covers exactly the same area — I could cut them out and they would stack perfectly. " +
      "This proves 1/2 = 2/4, but ONLY because I used the same-sized whole both times. " +
      "If Rectangle 2 was bigger or smaller, the shaded parts wouldn't be equal and it wouldn't be a fair comparison.",
    submittedAgoMinutes: 1180,
    rubricPassed: true,
    rubricCheckedBy: "ai",
    rubricCheckedAgoMinutes: 1170,
    overall: "full",
    verdicts: [
      {
        criterionId: "equal-parts",
        level: "full",
        note: "Explicitly divides each rectangle into equal parts and labels them as such; notes parts are 'equal halves' and '4 equal parts'.",
      },
      {
        criterionId: "same-whole",
        level: "full",
        note: "Clearly states both rectangles must be 'same size' and explains what breaks if they're not — the comparison becomes unfair.",
      },
      {
        criterionId: "names-equivalence",
        level: "full",
        note: "Directly concludes the shaded areas are equal and frames this as proof that 1/2 = 2/4.",
      },
    ],
  },

  // ── Shard 2: Small Moments deliverable ───────────────────────────────────
  {
    key: "del.emma.draft",
    activityKey: "a.smallmoments.draft",
    scholarKey: "s.emma",
    sessionKey: "sess.emma.draft",
    assignmentKey: "as.smallmoments.iwa",
    textContent:
      "I blew out the candles on my birthday cake. The smoke smelled like burnt sugar and everyone went quiet. Then they cheered, all at once, just for me. I didn't know a room could feel that full.",
    submittedAgoMinutes: 1480,
    rubricPassed: true,
    rubricCheckedBy: "ai",
    rubricCheckedAgoMinutes: 1470,
    overall: "full",
    verdicts: [
      {
        criterionId: "small-moment",
        level: "full",
        note: "The piece focuses entirely on the single moment of blowing out candles — not the whole party.",
      },
      {
        criterionId: "sensory-detail",
        level: "full",
        note: "'The smoke smelled like burnt sugar' is a specific, evocative sensory detail using smell.",
      },
      {
        criterionId: "strong-ending",
        level: "full",
        note: "The final sentence ('I didn't know a room could feel that full') shows emotional significance rather than just closing the narrative.",
      },
    ],
  },
];

// ── Completions ───────────────────────────────────────────────────────────────

export const completions: SeedCompletion[] = [
  {
    scholarKey: "s.kalei",
    activityKey: "a.fractions.baseline",
    lessonKey: "l.fractions.intro",
    unitKey: "u.fractions",
    sessionKey: "sess.kalei.baseline",
    assignmentKey: "as.fractions.honu",
    completedAgoMinutes: 5990,
  },
  {
    scholarKey: "s.kalei",
    activityKey: "a.fractions.equivalence",
    lessonKey: "l.fractions.intro",
    unitKey: "u.fractions",
    sessionKey: "sess.kalei.equiv",
    assignmentKey: "as.fractions.honu",
    completedAgoMinutes: 1180,
  },
  {
    scholarKey: "s.sage",
    activityKey: "a.fractions.baseline",
    lessonKey: "l.fractions.intro",
    unitKey: "u.fractions",
    sessionKey: "sess.sage.baseline",
    assignmentKey: "as.fractions.honu",
    completedAgoMinutes: 4000,
  },

  // ── Shard 2: Small Moments completions ────────────────────────────────────
  {
    scholarKey: "s.emma",
    activityKey: "a.smallmoments.baseline",
    lessonKey: "l.smallmoments.intro",
    unitKey: "u.smallmoments",
    sessionKey: "sess.emma.baseline",
    assignmentKey: "as.smallmoments.iwa",
    completedAgoMinutes: 3785,
  },
  {
    scholarKey: "s.emma",
    activityKey: "a.smallmoments.draft",
    lessonKey: "l.smallmoments.intro",
    unitKey: "u.smallmoments",
    sessionKey: "sess.emma.draft",
    assignmentKey: "as.smallmoments.iwa",
    completedAgoMinutes: 1480,
  },
  {
    scholarKey: "s.iokepa",
    activityKey: "a.smallmoments.baseline",
    lessonKey: "l.smallmoments.intro",
    unitKey: "u.smallmoments",
    assignmentKey: "as.smallmoments.iwa",
    completedAgoMinutes: 180,
    note: "Ready to move from the opening conversation into drafting.",
  },
];

// ── Analyses ──────────────────────────────────────────────────────────────────

export const analyses: SeedAnalysis[] = [
  {
    sessionKey: "sess.kalei.baseline",
    engagementScore: 0.88,
    complexityLevel: 0.8,
    onTaskScore: 0.95,
    topics: ["fractions", "equal parts", "denominator meaning", "pizza model"],
    learningIndicators: [
      "Independently articulated that denominator controls piece size (inverse relationship)",
      "Connected fractional notation to concrete quantity comparison without prompting",
    ],
    concernFlags: [],
    summary:
      "Kalei demonstrated above-grade fraction intuition — he reasoned about denominator magnitude and piece size spontaneously. Baseline is strong; no re-teaching needed. Move to equivalence at pace.",
  },
  {
    sessionKey: "sess.kalei.equiv",
    engagementScore: 0.92,
    complexityLevel: 0.85,
    onTaskScore: 0.97,
    topics: [
      "fraction equivalence",
      "same whole",
      "equal parts",
      "visual proof",
    ],
    learningIndicators: [
      "Self-constructed a visual proof strategy (identical rectangles) without prompting",
      "Identified the same-whole constraint and explained why it is necessary",
    ],
    concernFlags: [],
    summary:
      "Kalei produced a complete, rigorous equivalence argument addressing both the equal-parts and same-whole conditions. Ready for multi-step and symbolic equivalence work.",
  },
  {
    sessionKey: "sess.sage.baseline",
    engagementScore: 0.74,
    complexityLevel: 0.45,
    onTaskScore: 0.9,
    topics: ["fractions", "equal parts", "halves", "fair share"],
    learningIndicators: [
      "Self-initiated questioning about whether unequal pieces still constitute a valid fraction",
      "Shows emerging sense that equal size is a requirement, not just a convention",
    ],
    concernFlags: [],
    summary:
      "Sage arrived with a standard 'parts of a whole' framework and independently began probing the equal-size requirement. Solid Grade 3 entry point; equivalence lesson is appropriate next.",
  },
  {
    sessionKey: "sess.leilani.baseline",
    engagementScore: 0.65,
    complexityLevel: 0.25,
    onTaskScore: 0.85,
    topics: ["fractions", "counting pieces", "equal parts"],
    learningIndicators: [
      "Correctly associates fractions with splitting and taking parts",
    ],
    concernFlags: [
      "Misconception: defines 1/4 by piece count alone — believes any 1 of 4 pieces is 1/4 regardless of piece size",
    ],
    summary:
      "Leilani's baseline reveals a common early-fractions misconception: she counts pieces without requiring them to be equal-sized. This must be addressed concretely before equivalence work.",
    suggestedIntervention:
      "Use a hands-on cut-and-compare: have Leilani cut one paper strip into 4 unequal pieces and another into 4 equal pieces, then ask which strip actually shows 1/4. A physical, side-by-side comparison of 'fair' vs 'unfair' splits typically dislodges the piece-counting misconception at Grade 3.",
  },

  // ── Shard 2: Small Moments analyses ────────────────────────────────────────
  {
    sessionKey: "sess.nainoa.baseline",
    engagementScore: 0.72,
    complexityLevel: 0.25,
    onTaskScore: 0.88,
    topics: ["personal narrative", "storytelling scope", "weekend topics"],
    learningIndicators: [
      "Narrated a real event from his life without prompting",
      "Story spanned two full days — very wide scope typical for K entry point",
    ],
    concernFlags: [],
    summary:
      "Nainoa shared an enthusiastic story about 'the whole camping trip' — no spontaneous zooming in, but no resistance either. Baseline scope is wide (expected at K). Introduce the zoom-in concept before his next session.",
  },
  {
    sessionKey: "sess.emma.baseline",
    engagementScore: 0.79,
    complexityLevel: 0.45,
    onTaskScore: 0.91,
    topics: ["personal narrative", "sensory detail", "focus"],
    learningIndicators: [
      "Narrowed her story from 'my birthday party' to 'when I blew out the candles' when prompted",
      "Supplied one spontaneous sensory detail ('the smoke smelled like burnt sugar')",
    ],
    concernFlags: [],
    summary:
      "Emma shows strong oral storytelling instincts — she zoomed in on one moment quickly when asked and naturally reached for a sensory detail. Ready for the draft activity.",
  },
  {
    sessionKey: "sess.emma.draft",
    engagementScore: 0.85,
    complexityLevel: 0.65,
    onTaskScore: 0.93,
    topics: ["personal narrative", "sensory detail", "strong ending", "revision"],
    learningIndicators: [
      "Produced 4 sentences zoomed in on a single moment with two sensory details",
      "Revised her ending after tutor questioning — changed 'it was fun' to a reflection on what the moment meant",
    ],
    concernFlags: [],
    summary:
      "Emma's draft met all three criteria. She revised spontaneously when asked about her ending, upgrading from a generic close to one that showed the moment's significance. Strong entry-level narrative writing.",
  },
  {
    sessionKey: "sess.koa.baseline",
    engagementScore: 0.61,
    complexityLevel: 0.2,
    onTaskScore: 0.8,
    topics: ["personal narrative", "storytelling scope", "sports"],
    learningIndicators: [
      "Shared a story about soccer without much coaxing",
    ],
    concernFlags: [
      "Scope extremely wide: described the entire soccer season rather than a specific moment",
      "No sensory detail appeared even after two follow-up prompts",
    ],
    summary:
      "Koa is a willing narrator but zoom-in and sensory detail are not yet in his toolkit. A teacher-led modeled writing session — picking one play from one game — would make the zoom-in concept concrete before his next solo attempt.",
    suggestedIntervention:
      "Show Koa two versions of the same event: one wide ('I played soccer and we won') and one zoomed-in ('My cleats slipped in the mud when I kicked the ball and somehow it went in'). Ask which one he'd rather read. The contrast typically makes the concept click faster than explaining it.",
  },
];

// ── Badges (earned unit-completion + custom awards) ──────────────────────────
//
// A handful of earned badges so every fresh worktree has something on the
// scholar Work tab's "Badges" strip. Each carries a stable `art` slug into the
// pre-baked artwork in convex/seed/rich/badgeArtAssets.ts — the seed's attach
// step (seedBadgeArt:attach) uploads that committed PNG and sets artStatus
// "ready", so badges look real WITHOUT a live gen-art run per seed. Regenerate
// the art with `node scripts/build-badge-art-assets.mjs`.
export const badges: SeedBadge[] = [
  // Kalei — two unit badges + a custom streak.
  { scholarKey: "s.kalei", unitKey: "u.fractions", title: "Fraction Sense", icon: "🍕", style: "patch", colorway: "gold", earnedAgoDays: 12, art: "fraction-sense-gold" },
  { scholarKey: "s.kalei", unitKey: "u.is.kalei.volcanoes", title: "Island Builder", icon: "🌋", style: "medallion", colorway: "crimson", earnedAgoDays: 4, art: "island-builder" },
  { scholarKey: "s.kalei", title: "Curiosity Streak", description: "Followed a thread three sessions running.", icon: "🧭", style: "patch", colorway: "violet", earnedAgoDays: 1, art: "curiosity-streak" },
  // Emma — comics unit + a custom.
  { scholarKey: "s.emma", unitKey: "u.is.emma.comics", title: "Comic Creator", icon: "🎨", style: "patch", colorway: "violet", earnedAgoDays: 6, art: "comic-creator" },
  { scholarKey: "s.emma", title: "Brave Reviser", description: "Rewrote a draft after tough feedback.", icon: "✍️", style: "medallion", colorway: "gold", earnedAgoDays: 2, art: "brave-reviser" },
  // A few others so multiple scholars' Work tabs have badges.
  { scholarKey: "s.sage", unitKey: "u.fractions", title: "Fraction Sense", icon: "🍕", style: "patch", colorway: "mint", earnedAgoDays: 9, art: "fraction-sense-mint" },
  { scholarKey: "s.nainoa", unitKey: "u.smallmoments", title: "Small Moments", icon: "✏️", style: "patch", colorway: "auto", earnedAgoDays: 5, art: "small-moments" },
  { scholarKey: "s.koa", title: "Persistence", description: "Kept going when it got hard.", icon: "💪", style: "medallion", colorway: "mint", earnedAgoDays: 3, art: "persistence" },
  { scholarKey: "s.anela", title: "Helpful Teammate", description: "Lifted up a podmate.", icon: "🤝", style: "patch", colorway: "crimson", earnedAgoDays: 7, art: "helpful-teammate" },
];
