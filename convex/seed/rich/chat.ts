// ─── Rich-cohort seed: teacher chat (Curriculum Bot / Teacher Aide) ─────────
//
// Populates the teacher chat surfaces so neither is empty out of the box. Two
// flavours are represented (see SeedChat), and each teacher gets one of each:
//   - global Teacher Aide threads (no unitKey / scholarKey) → the generic
//     chat library (curriculumAssistant.listSessions)
//   - unit-scoped Curriculum Bot threads (unitKey set → the unit being
//     designed) → that unit's own history (listSessionsForUnit), which is the
//     only place they can be continued
// Authored prose is short but realistic; the inserter stamps timestamps from
// the relative offsets and orders messages oldest-first.

import type { SeedChat } from "./types";

export const chats: SeedChat[] = [
  // ── Kawena — global Teacher Aide thread ──────────────────────────────────
  {
    key: "chat.kawena.pacing",
    teacherKey: "t.kawena",
    title: "Pacing Small Moments for a mixed-level pod",
    pinned: true,
    lastMessageAgoMinutes: 95,
    messages: [
      {
        role: "user",
        content:
          "My ʻIwa pod runs K through grade 3 in the same room. How do I pace the Small Moments unit so my youngest writers aren't lost but my grade-3s still get stretched?",
        agoMinutes: 110,
      },
      {
        role: "assistant",
        content:
          "Anchor the whole pod on the same prompt — \"a small moment that mattered\" — but differentiate the OUTPUT, not the task. For K–1, a labeled drawing + one dictated sentence counts as a full draft. For grade 2–3, push for a beginning/middle/end and one line of sensory detail. Keep the mini-lesson to ~7 minutes so the youngest stay with you, then release to independent writing where you can confer 1:1. Your stronger writers self-propel; spend the conferring time with the emerging ones.",
        agoMinutes: 108,
        model: "claude-sonnet-4-6",
      },
      {
        role: "user",
        content:
          "That helps. What's a quick check that a grade-3 is actually stretching and not just writing more of the same?",
        agoMinutes: 97,
      },
      {
        role: "assistant",
        content:
          "Look for a moment that's been NARROWED in time, not summarized. \"My birthday\" is a topic; \"the second the candles went out and the smoke curled up\" is a small moment. If a grade-3 zooms into a few seconds and slows them down with detail, that's the stretch — regardless of length. Ask them: \"Where exactly does this moment start and stop?\" If they can answer in seconds, they've got it.",
        agoMinutes: 95,
        model: "claude-sonnet-4-6",
      },
    ],
  },

  // ── Kawena — unit-scoped Curriculum Bot thread on Small Moments ───────────
  {
    key: "chat.kawena.smallmoments.eqs",
    teacherKey: "t.kawena",
    title: "Tightening the Small Moments essential questions",
    unitKey: "u.smallmoments",
    lastMessageAgoMinutes: 1450,
    messages: [
      {
        role: "user",
        content:
          "Review the essential questions on this unit — do they actually drive the writing, or are they too abstract for K–3?",
        agoMinutes: 1465,
      },
      {
        role: "assistant",
        content:
          "\"What is a small moment?\" is doing the heavy lifting and it's developmentally right — concrete, answerable through doing. The second EQ leans abstract for your youngest. Consider reframing it as a writer's move rather than a concept: \"How do writers make a reader feel like they were there?\" That keeps it craft-focused and gives every grade a concrete target (add a sound, a feeling, what you saw). Want me to draft that swap into the unit?",
        agoMinutes: 1462,
        model: "claude-sonnet-4-6",
      },
    ],
  },

  // ── Daniel — global Teacher Aide thread ──────────────────────────────────
  {
    key: "chat.daniel.misconceptions",
    teacherKey: "t.daniel",
    title: "Fraction-equivalence misconceptions to watch for",
    lastMessageAgoMinutes: 240,
    messages: [
      {
        role: "user",
        content:
          "Honu pod is finishing Fraction Sense. What are the equivalence misconceptions I should be probing for in the debrief?",
        agoMinutes: 255,
      },
      {
        role: "assistant",
        content:
          "Three big ones: (1) \"bigger denominator = bigger fraction\" — they read 1/4 as larger than 1/2 because 4 > 2. (2) Treating the numerator and denominator as separate whole numbers, so 1/2 and 2/4 look like different amounts of stuff rather than the same share. (3) Thinking equivalence only works with \"nice\" doubles (1/2 = 2/4) and breaking on 1/3 = 2/6. Probe with a same-size whole: \"show me 1/2 of THIS pizza and 2/4 of the SAME pizza\" — if the regions match, they've got the part-whole idea.",
        agoMinutes: 252,
        model: "claude-sonnet-4-6",
      },
      {
        role: "user",
        content:
          "Kalei wrote \"1/2 of a big pizza isn't the same as 2/4 of a tiny pizza.\" Is that a misconception or actually sophisticated?",
        agoMinutes: 242,
      },
      {
        role: "assistant",
        content:
          "That's sophisticated — Kalei is guarding the whole, which is exactly the precision most kids skip. They've understood that a fraction is meaningless without naming the whole it's a fraction OF. Name it back to them as a rule: \"equivalent fractions are equal only when they're parts of the same-size whole.\" That validates the insight and sharpens it. I'd log this as evidence toward the part-whole understanding, not a gap.",
        agoMinutes: 240,
        model: "claude-sonnet-4-6",
      },
    ],
  },

  // ── Daniel — unit-scoped Curriculum Bot thread on Fraction Sense ──────────
  {
    key: "chat.daniel.fractions.practice",
    teacherKey: "t.daniel",
    title: "A hands-on practice strand for Fraction Sense",
    unitKey: "u.fractions",
    lastMessageAgoMinutes: 2900,
    messages: [
      {
        role: "user",
        content:
          "The core lessons are conversation-heavy. Can you suggest a hands-on practice activity so the kids manipulate fractions, not just talk about them?",
        agoMinutes: 2915,
      },
      {
        role: "assistant",
        content:
          "Two that fit the unit's part-whole goal: a \"Fraction Hunt\" where pairs find equivalent fractions around the room (a half-eaten snack, 2/4 of a window grid) and justify why they match — great as offline class-focus. And a card-sort where they group fraction cards (1/2, 2/4, 3/6, 1/3, 2/6) into equivalence families and defend the odd ones out. Both surface the \"same whole\" idea through doing. I can add them as a Practice strand with offline activities if you want.",
        agoMinutes: 2912,
        model: "claude-sonnet-4-6",
      },
    ],
  },
];
