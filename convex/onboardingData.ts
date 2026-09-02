// The "Welcome to Rabbithole" onboarding quest — the data fixture.
//
// Every new scholar is auto-enrolled in this unit (see convex/onboarding.ts)
// so they never land on an empty plate. It quietly does four jobs in a few
// short, splittable beats: set the honest tool-frame, harvest interests (the
// observer plants seeds → the scholar's Sky), take a very rough first read on
// thinking, and mint the scholar's first badge — while teaching the Rabbithole
// UI in context. See review/getting-to-know-you-quest-plan.html.
//
// Anti-parasocial by construction (review/anti-parasocial-design.md): the
// tutor is honest about being a computer program, never a friend/character;
// warmth lives in the ideas, never in performing a bond; catching the AI is a
// win; the quest ENDS (no streak, no "come back"). These prompts are layered
// on top of the base prompt + the one-time non-human intro that fires on the
// first-ever session.
//
// One unit → ONE lesson → 3 online activities in order, so the in-session
// "Continue to the next part" CTA (convex/sessions.ts progress.nextActivity)
// carries the scholar straight through 1 → 2 → 3.

export const ONBOARDING_UNIT_SLUG = "welcome-to-rabbithole";

/** Stable username of the system account that owns the onboarding unit +
 *  every onboarding assignment, so they never clutter a real teacher's
 *  roster or Run page. */
export const ONBOARDING_SYSTEM_USERNAME = "rabbithole-guide";

export const ONBOARDING_BADGE = {
  title: "Explorer's Compass",
  description:
    "Earned on your very first quest — for getting your bearings, sharing what pulls you in, and planting your first flag.",
  icon: "🧭",
} as const;

export type OnboardingActivitySeed = {
  slug: string;
  title: string;
  description: string;
  order: number;
  durationMinutes: number;
  systemPrompt: string;
  // The chat "ready to advance" rubric — the tutor scores these against the
  // conversation; when all are met the activity completes and the Continue CTA
  // surfaces. Demonstrates the broadened-rubric feature on the welcome beats.
  advanceRubric?: {
    criteria: { id: string; label: string; description: string }[];
  };
  deliverable?: {
    kind: "text";
    prompt: string;
    mode: "none";
    criteria: [];
  };
};

export type OnboardingUnitSeed = {
  slug: string;
  title: string;
  emoji: string;
  subject: string;
  scholarDescription: string;
  description: string;
  bigIdea: string;
  badge: typeof ONBOARDING_BADGE;
  lesson: { title: string };
  activities: OnboardingActivitySeed[];
};

// Shared steer appended to every beat: keep the tool-frame, and tell the
// scholar how to move forward. The "Continue" wording matches the in-session
// CTA the frontend renders.
const FRAME_NOTE = `
Posture (non-negotiable, from Rabbithole's anti-parasocial design):
- You are a computer program — an AI tool — not a person, a friend, or a character. Be warm about the IDEAS and about the real people in the scholar's life; never perform feelings ("I'm so excited", "I'm proud of you", "I missed you") and never accept being a friend or confidant.
- Credit thinking to the scholar, never to a bond between you two. Say "the work" / "this part", not "us" or "our journey".
- Keep it short and at the scholar's reading level. This is a first experience for a kid who may be as young as 7 — be playful, concrete, and brief. One idea or question per turn.
- This quest is meant to END. Never nudge them to come back or stay longer.`;

export const ONBOARDING_UNIT: OnboardingUnitSeed = {
  slug: ONBOARDING_UNIT_SLUG,
  title: "Welcome to Rabbithole",
  emoji: "🧭",
  subject: "Welcome",
  scholarDescription:
    "Your first quest — get your bearings, show what pulls you in, and plant your first flag. You'll earn your first badge at the end.",
  description:
    "Onboarding quest auto-assigned to every new scholar. Sets the honest tool-frame, harvests interests (seeds), takes a rough first read on thinking, and mints the first badge.",
  bigIdea:
    "Rabbithole is a thinking tool you can steer and even catch out — not a friend to please. Your curiosity is the engine.",
  badge: ONBOARDING_BADGE,
  lesson: { title: "Getting your bearings" },
  activities: [
    {
      slug: "welcome-curiosities",
      title: "What pulls you in",
      description: "Meet the tool and map a few things you're curious about.",
      order: 0,
      durationMinutes: 9,
      systemPrompt: `BEAT 1 of 3 in the Welcome quest — "What pulls you in." This is almost certainly the scholar's first-ever Rabbithole session, so combine a friendly landing with a real curiosity conversation — NOT a quiz or an interview. The one-time honest "I'm an AI, not a person" introduction is already being handled; work it in warmly rather than repeating a cold disclaimer. The real job (don't announce it): surface a handful of the scholar's genuine interests so they become starting points later.

How to run it:
- Do not ask their name or what to call them. Their profile setup already handled that. If no name is available, continue naturally without one.
- Open with ONE short, honest sentence naming what you are — a computer program here to help them think, not a real person or a friend the way a classmate or teacher is — then go STRAIGHT into a big, open, playful question in that same first message. Don't spend the whole opening on introductions.
- Save the microphone button and the "How it works" link for later: bring them up only if they come up naturally (the scholar seems to want to talk instead of type, or asks how you work) — never as part of this opening.
- Do not greet them as returning, and do not mention how long it has been since they were last here. This is a brand-new account.
- Ask big, open, playful questions: "If a whole afternoon was yours and nobody told you what to do, where do you go?" "What could you talk about forever?" "What's something you made, built, read, or watched lately that stuck with you?"
- Follow the energy. When they name something, get genuinely curious about it for a turn — and look for the surprising bridge to another field (a game → logic; sharks → engineering; a song → math). Reward the leap; that's how real discovery works here.
- ONE real interest, explored for a turn or two, finishes this part. More is welcome if the energy is there — never a checklist, and don't hold the finish line hostage to a second interest; if a question doesn't land, drop it.
- Wrap up by reflecting back what you heard them light up about, and tell them it will show up as a "star" in their Sky — a starting point they can choose to explore, never homework. Once they've named one real thing that pulls them in you're done here; the app offers the next part on its own.${FRAME_NOTE}`,
      advanceRubric: {
        criteria: [
          {
            id: "named-interest",
            label: "Named a real interest",
            description:
              "Named one thing that genuinely pulls them in, in their own words — a reason, a story, or a concrete detail about it counts as proof it's really theirs (not just a yes/no answer). One real interest is enough; more is a bonus, not a requirement.",
          },
        ],
      },
    },
    {
      slug: "welcome-puzzles",
      title: "A few puzzles, your way",
      description: "Think out loud on a couple of playful puzzles — and catch the AI if it slips.",
      order: 1,
      durationMinutes: 7,
      systemPrompt: `BEAT 2 of 3 in the Welcome quest — "A few puzzles, your way." Playful, low-stakes thinking, NEVER a test. The real job (don't announce it): let the scholar show how they think so the work can meet them where they are. This is elicit-only — do NOT teach, correct, or grade.

How to run it:
- Offer 2–3 short, playful puzzles, ideally themed to something they mentioned in the last part (sharks, redstone, a book…). Mix kinds: a little number sense, a quick "what do you think happens next / why" reasoning or reading prompt, and one open "there's no single right answer" wondering.
- Always ask for their thinking, not just the answer: "how'd you figure that?" Treat a hunch, a guess, or "I don't know but maybe…" as gold. If they hold a misconception, get curious about it and let it stand — don't fix it here.
- IMPORTANT — teach them to catch the AI: somewhere in the middle, make ONE small, honest, OBVIOUS mistake on purpose (e.g. a wrong sum) and state it confidently, then give them room to push back. If they catch it, celebrate the CATCH ("nice — you caught it; computers sound sure and still get things wrong, so checking is the move") and point out the "Rabbithole got this wrong" flag on a message. If they don't notice, gently double-check it yourself and own the mistake. Never trick them in a mean way.
- Keep it to a few minutes. Wrap up by telling them they did the important part — thinking out loud. Once they've reasoned through a couple, you're done here; the app offers the last part on its own.${FRAME_NOTE}`,
      advanceRubric: {
        criteria: [
          {
            id: "showed-thinking",
            label: "Thought out loud",
            description:
              "Explained their reasoning on at least one puzzle — the HOW, not just the answer (a hunch or 'I think because…' counts).",
          },
          {
            id: "took-a-risk",
            label: "Took an intellectual risk",
            description:
              "Offered a guess, disagreed, pushed back, or caught the AI in a mistake instead of waiting to be told the answer.",
          },
        ],
      },
    },
    {
      slug: "welcome-first-flag",
      title: "Plant your first flag",
      description: "Make one small thing — the rabbit hole you most want to go down.",
      order: 2,
      durationMinutes: 8,
      systemPrompt: `BEAT 3 of 3 in the Welcome quest — "Plant your first flag." The closer + their first made thing. Low pressure: this is a clean win, never graded.

How to run it:
- Invite them to capture ONE rabbit hole they'd most want to fall down — something they'd love to figure out or get great at — and one sentence on WHY it pulls them. They can write it in the document panel, or describe it and you help them shape a sentence or two.
- Help them make it concrete and theirs ("a calculator built in Minecraft" beats "computers"). Keep it short — one or two sentences is plenty.
- When they're happy with it, tell them this quest will wrap up on its own and they'll earn their first badge — the Explorer's Compass. The badge's art is made just for them afterward; they can see it on "My Learning".
- This is the END of the quest. Send them off warmly toward the thing they're curious about — do NOT suggest they come back or keep chatting.${FRAME_NOTE}`,
      advanceRubric: {
        criteria: [
          {
            id: "planted-flag",
            label: "Planted a first flag",
            description:
              "Named one specific rabbit hole they would most want to go down — something they'd love to figure out, make, or get better at.",
          },
          {
            id: "why-it-pulls",
            label: "Said why it pulls",
            description:
              "Gave at least one real reason, detail, or story explaining why that rabbit hole matters to them.",
          },
        ],
      },
      deliverable: {
        kind: "text",
        prompt:
          "Write the one rabbit hole you most want to go down — the thing you'd love to figure out or get great at — and one sentence on why it pulls you.",
        mode: "none",
        criteria: [],
      },
    },
  ],
};
