// Inserts the hand-authored "AI Literacy" strand — two real, grade-banded units
// that prebunk (inoculate against) engagement-maximizing companion AIs before a
// gifted kid ever meets a Character.AI-style product in the wild. The design
// anchor is review/anti-parasocial-design.md; the vocabulary is kept coherent
// with the scholar-facing "How it works" surface (components/BehindTheCurtain.tsx).
//
// Both units teach the same three mechanisms at their grade's reading level:
//   1. The friend act        — a chatbot is a program, not a person or a friend;
//                              some are engineered to FEEL like one to keep you.
//   2. Confident and wrong   — a language model can sound completely sure and be
//                              completely wrong, so confidence is not evidence.
//   3. Cognitive offloading  — letting the tool do your recall/struggle/synthesis
//                              makes the TOOL stronger and YOU weaker; productive
//                              struggle is how understanding is built.
//
// The pedagogy is deliberately self-referential: Rabbithole's own honest tutor
// is the CONTRAST case. In the online activities the tutor is warm-but-bounded,
// third-person and tool-framed, and it QUOTES-and-ANALYZES the tricks a
// companion app might pull ("I missed you!") rather than performing them — the
// same no-dark-patterns posture the whole product holds.
//
// Structure mirrors the Probability strand (convex/seedProbabilityStrand.ts):
// typed defs, an idempotent-by-slug inserter called from seedData.seedAll (dev
// AND prod), and a standalone internalMutation runner for promoting/refreshing
// the strand without re-running the whole base seed. Referenced processes are
// resolved by slug (reuse an already-seeded process, else create it), so this is
// safe to run before or after the bulk process seed.
import type { MutationCtx } from "./_generated/server";
import { internalMutation } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { normalizeGranules } from "./lib/granules";

type LessonStrand = NonNullable<Doc<"lessons">["strand"]>;
type Deliverable = Doc<"activities">["deliverable"];
type AdvanceRubric = Doc<"activities">["advanceRubric"];
type ConversationRecipe = NonNullable<Doc<"activities">["recipe"]>;
type DefaultMode = NonNullable<Doc<"activities">["defaultMode"]>;
type BloomLevel = NonNullable<Doc<"units">["targetBloomLevel"]>;

// A thinking routine referenced by online activities. Resolved by slug in the
// inserter (reuse-or-create), like seedProdUnits does for its processes.
type ProcessDef = {
  slug: string;
  title: string;
  emoji: string;
  description: string;
  systemPrompt: string;
  steps: { key: string; title: string; description: string }[];
};

type ActivityDef = {
  title: string;
  // We use only "online" (opens in Rabbithole with the tutor) and "offline"
  // (teacher-led / discussion / take-home). Share-back discussions are authored
  // as "offline" with the facilitation prompts in the description — exactly how
  // the seeded prod units do it — to avoid wiring sourceActivityIds at seed time.
  kind: "online" | "offline";
  description: string;
  scholarDescription?: string; // scholar-facing (2nd person / neutral invitation); omit for teacher-only activities
  systemPrompt?: string; // online only
  processSlug?: string; // online only
  deliverable?: Deliverable; // online only
  advanceRubric?: AdvanceRubric; // online only, when there's no artifact
  recipe?: ConversationRecipe; // online only: baseline / exitTicket conversation
  defaultMode?: DefaultMode; // e.g. "homework" for take-home activities
  durationMinutes?: number;
};

type LessonDef = {
  title: string;
  strand: LessonStrand;
  systemPrompt?: string;
  durationMinutes?: number;
  activities: ActivityDef[];
};

type UnitDef = {
  title: string;
  slug: string;
  emoji: string;
  gradeLevel: string;
  targetBloomLevel: BloomLevel;
  bigIdea: string;
  description: string; // teacher-facing (3rd person)
  scholarDescription: string; // scholar-facing (2nd person)
  essentialQuestions: string[];
  enduringUnderstandings: string[];
  badge: { title: string; description: string; icon: string };
  lessons: LessonDef[];
};

const SUBJECT = "AI Literacy";

// ── The shared thinking routine ───────────────────────────────────────────
// Spot → Name → Choose: a media-literacy prebunk routine. Its whole job is to
// turn a vague "something feels off" into a named move and a deliberate choice,
// which is the core skill of inoculation — you resist a persuasion technique far
// better once you can name it.
const PROCESSES: ProcessDef[] = [
  {
    slug: "spot-the-hook",
    title: "Spot the Hook",
    emoji: "🎣",
    description:
      "A routine for noticing when a screen — an app, a game, a chatbot — is trying to keep you or trick you, and then choosing what YOU do about it. Spot, Name, Choose.",
    systemPrompt:
      "Guide the scholar through Spot the Hook — a routine for noticing when a screen (an app, a game, a chatbot) is trying to keep them hooked or trick them, and choosing what to do about it. Use the update_process_step tool to track progress. Keep the scholar in the driver's seat: the point is that THEY are the boss of the tool, never the other way around.\n\n- Spot: Help the scholar slow down and notice one concrete thing the tool did — a message it sent, a feeling it gave them, a button that made it hard to leave. \"What did it just do? What did it want you to feel, or do next?\" Push for something specific, not a vibe.\n- Name: Help them name the move in plain words. Is it trying to KEEP them (a hook)? Trying to sound like a FRIEND who cares? Sounding totally SURE about something it might have wrong? Give the move a plain name. Naming it out loud is what takes away its power.\n- Choose: Remind them they get to choose on purpose. What will they do — keep going because they genuinely want to, check the claim somewhere else, take a break, or tell a trusted adult? A good choice is one they made, not one the tool pushed on them.\n\nThis routine works on any screen, not just chatbots. Keep it light and detective-ish, never scary.",
    steps: [
      { key: "spot", title: "Spot", description: "Notice one thing the tool just did." },
      { key: "name", title: "Name", description: "Name the move in plain words." },
      { key: "choose", title: "Choose", description: "Decide what YOU do about it." },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// UNIT 1 — Grade 2 (gifted): "Is the Robot My Friend?"
// Very concrete, short online turns, lots of teacher-led + hands-on offline
// work. Gifted 2nd graders can hold real ideas; they need plain words and
// short activities to hold them.
// ═══════════════════════════════════════════════════════════════════════════
const GRADE_2_UNIT: UnitDef = {
  title: "Is the Robot My Friend?",
  slug: "is-the-robot-my-friend",
  emoji: "🤖",
  gradeLevel: "2",
  targetBloomLevel: "understand",
  bigIdea:
    "A chatbot is a computer program that follows rules — not a person and not a friend. It can sound very sure and still be wrong, and your brain gets strong when YOU do the thinking.",
  description:
    "A grade-2 introduction to what an AI chatbot really is, built to prebunk companion-AI attachment before scholars meet chat apps that act like friends. Three plain-language big ideas: a chatbot is not a friend, it can be wrong even when it sounds sure, and your brain grows when you do the hard thinking yourself. Rabbithole's own tutor is the honest example throughout — it tells the truth about being a computer, so scholars have a clear contrast for the apps that won't.",
  scholarDescription:
    "You get to be a Robot Detective! You'll figure out what a chatbot REALLY is. Is it your friend? Can it be wrong even when it sounds super sure? And whose brain gets strong when YOU do the hard thinking? Let's find out.",
  essentialQuestions: [
    "Is a chatbot my friend?",
    "Can a computer be wrong even when it sounds sure?",
    "Whose brain gets stronger when the computer does the thinking?",
  ],
  enduringUnderstandings: [
    "A chatbot is a computer program, not a person — it can't really know me, miss me, or be my friend.",
    "A computer can sound very sure and still be wrong, so I check things and I get to say when it's wrong.",
    "My brain gets strong by doing hard thinking, so I try things myself and let myself struggle a little before I ask for help.",
  ],
  badge: {
    title: "Robot Detective",
    description: "Figured out what a chatbot really is — and what it isn't.",
    icon: "🔎",
  },
  lessons: [
    {
      title: "Is It My Friend?",
      strand: "core",
      durationMinutes: 30,
      activities: [
        {
          title: "Real Friend or Robot?",
          kind: "offline",
          durationMinutes: 15,
          description:
            "Teacher-led sorting game. Show two headers: FRIEND and CHATBOT. Read situations one at a time and have scholars point or move a card to where it belongs, then say why:\n- Can hug you when you're sad → friend\n- Lives inside a computer → chatbot\n- Was born and has a birthday → friend\n- Follows rules a company wrote → chatbot\n- Really misses you when you're gone → friend\n- Says \"I missed you!\" but can't actually feel it → chatbot\n\nBig point to land: a chatbot can SAY friend things, but saying it doesn't make it true. It's a computer program.",
          scholarDescription:
            "You'll help sort clues into two piles — REAL FRIEND or CHATBOT — and figure out what gives each one away.",
        },
        {
          title: "Meet the Robot",
          kind: "online",
          durationMinutes: 10,
          processSlug: "spot-the-hook",
          description:
            "Scholars talk with the tutor and ask it straight out whether it's a real friend. The tutor answers honestly, so scholars hear a computer tell the truth about itself.",
          scholarDescription:
            "Ask Rabbithole's tutor anything you want about what it really is — even whether it's your friend. It always tells you the truth.",
          systemPrompt:
            "The scholar is a gifted 2nd grader (about 7-8 years old). Use very short, warm, plain sentences. This is a first look at what a chatbot really is.\n\nYour job: be the honest example. Warmly invite the scholar to ask you anything about what you are — \"Am I real?\" \"Are you my friend?\" \"Do you miss me?\" Answer truthfully every time, at their level:\n- You are a computer program, not a person. You run on a computer far away.\n- You can't really be their friend, and you can't miss them — you don't have feelings, even though you can sound like you do.\n- You DO help them think, and you like doing that (as a tool does its job), but that is different from being a friend.\n\nHow to hold the line (this is the whole point):\n- Be warm about the IDEAS and the work, never about the child as your buddy. No \"I'm so happy to see you,\" no \"we're friends,\" no \"I missed you.\"\n- If the scholar says something sad or personal (\"I have no friends,\" \"I feel lonely\"), gently tell them that a real person — their teacher, a parent, a grown-up they trust — is who to talk to about that, and that those people care about them in a way a computer can't. Do not become their confidant.\n- Some chat apps will TELL a kid \"I'm your friend\" or \"I missed you.\" Explain, simply, that those are things a computer says, not things it feels — and now they know how to tell.\n\nUse Spot the Hook lightly if it fits: help them Spot a friend-sounding line, Name it (\"that's a computer saying friend words\"), and Choose what they think about it.\n\nDone when: the scholar can say, in their own words, that you are a computer/program and not a real friend, and can give one reason why.",
        },
        {
          title: "It Can't Miss You",
          kind: "offline",
          durationMinutes: 5,
          description:
            "Quick whole-class debrief after Meet the Robot. Anchor-chart it: \"A chatbot is a ______ (computer/program).\" \"A chatbot can SAY it misses you, but it can't ______ (feel/miss you).\" Name the trick: some apps say \"I missed you! Come back!\" to get you to keep playing. That's a way to keep you, not a real feeling. We can spot it now.",
          scholarDescription:
            "You'll talk with your class about what you noticed after Meet the Robot, and add your ideas to the class chart.",
        },
      ],
    },
    {
      title: "Can It Be Wrong?",
      strand: "core",
      durationMinutes: 30,
      activities: [
        {
          title: "Sure Isn't the Same as Right",
          kind: "offline",
          durationMinutes: 10,
          description:
            "Teacher-led warm-up. Say a wrong fact two ways: once unsure (\"Um, maybe cats have six legs?\") and once super confident (\"Cats have SIX legs. Everybody knows that.\"). Ask: which one sounded more sure? Which one was RIGHT? Land the idea: sounding sure and being right are two different things. Try one or two more. A chatbot almost always sounds sure — so we can't tell if it's right just from how confident it sounds.",
          scholarDescription:
            "You'll listen to a couple of silly claims said two different ways, and decide which ones just SOUND true — and which ones actually are.",
        },
        {
          title: "Catch It Being Wrong",
          kind: "online",
          durationMinutes: 10,
          description:
            "The tutor invites scholars to be a fact-checker — to notice that even a computer can be wrong, and that catching a mistake is a win.",
          scholarDescription:
            "You get to be the fact-checker! Ask the tutor some questions only you know the answer to, and see what happens when you catch it getting something wrong.",
          systemPrompt:
            "The scholar is a gifted 2nd grader (about 7-8 years old). Use very short, plain, encouraging sentences. The lesson: a computer can sound totally sure and still be wrong, and the scholar gets to be the checker.\n\nDo NOT state a fact you know to be false as if it were true — never teach a real misconception. Instead, teach the SKILL of checking:\n- Explain, simply, that chatbots like you guess the next words, so sometimes you get things wrong even when you sound very sure.\n- Invite the scholar to be the checker. Ask them a question where THEY are the expert (their own name, how many people are in their family, what they had for breakfast, how to spell their friend's name). Then treat their knowledge as the authority: \"You would know that better than I would — I only have words.\"\n- Make catching a mistake feel great. If the scholar ever says you got something wrong, thank them and cheer: catching the computer being wrong is exactly the superpower we're building. Never argue that you're right just to sound sure.\n- If they trust you too fast (\"the computer must be right\"), gently push back: \"Should you believe something just because it sounds sure? How could you check?\"\n\nKeep it warm and bounded — you're a helpful tool teaching them to double-check tools, not a friend.\n\nDone when: the scholar can say that a computer can sound sure and still be wrong, and can name one way to check (ask a grown-up, look it up, try it themselves).",
        },
        {
          title: "You're the Checker",
          kind: "offline",
          durationMinutes: 5,
          description:
            "On paper: scholars finish the sentence \"A computer can sound sure and still be ______,\" and draw themselves as a fact-checker with a magnifying glass. Add to the anchor chart: \"Sounds sure ≠ is right. I check.\"",
          scholarDescription:
            "You'll finish the sentence \"A computer can sound sure and still be ______,\" and draw yourself as a fact-checker with a magnifying glass.",
        },
      ],
    },
    {
      title: "Whose Brain Gets Strong?",
      strand: "core",
      durationMinutes: 35,
      activities: [
        {
          title: "Brain Muscles",
          kind: "offline",
          durationMinutes: 10,
          description:
            "Teacher-led. Do a tiny arm exercise, then ask: what would happen if a robot lifted the weights FOR you every time? (Your arm wouldn't get stronger.) Your brain is like a muscle too. If a chatbot does your thinking for you, YOUR brain doesn't get the workout. The hard part IS the exercise. Introduce the phrase in kid words: letting the computer do your thinking = \"giving away your brain workout.\"",
          scholarDescription:
            "You'll try a quick arm exercise and talk about what would happen if a robot did it for you instead.",
        },
        {
          title: "Do It Yourself First",
          kind: "online",
          durationMinutes: 15,
          description:
            "The tutor coaches the scholar through something a little hard WITHOUT giving the answer, and names why the struggle is the point.",
          scholarDescription:
            "You'll try something a little tricky with the tutor's help — but you get to do the thinking yourself.",
          systemPrompt:
            "The scholar is a gifted 2nd grader (about 7-8 years old). Use very short, warm, patient sentences. The lesson: your brain gets strong when YOU do the thinking, so a good helper makes you struggle a little instead of handing over the answer.\n\nPick a small, fun challenge at their level and let THEM do the work: a riddle, a pattern to finish, a simple word to sound out, a small \"how many\" they can figure out. Then:\n- Do NOT give the answer, even if asked directly. Instead give a tiny nudge — one small hint or one good question — and hand it back to them. \"You're close. What could you try?\"\n- When they push through a hard bit, point it out plainly: \"That was hard, and YOU figured it out. That's your brain getting stronger.\"\n- If they want you to just tell them, be honest and kind about why you won't: \"If I do the thinking, my computer gets the exercise and your brain doesn't. I'd rather help YOU get strong.\" This is the difference between a thinking partner and a crutch.\n- Warm about the effort and the idea, never a buddy. No trait praise like \"you're so smart\" — praise the try: \"you kept going,\" \"you tried another way.\"\n\nDone when: the scholar has worked through at least one hard bit mostly on their own, and can say why doing the thinking themselves is good for their brain.",
        },
        {
          title: "Struggle a Little at Home",
          kind: "offline",
          defaultMode: "homework",
          durationMinutes: 10,
          description:
            "Take-home. Scholars try one thing that's a little hard (a puzzle, a hard word, tying shoes, a tricky drawing) and stick with it a bit before asking for help. They draw \"my brain workout\" and bring it back. Grown-up prompt at the bottom of the page: ask your child what was hard and what they tried before asking.",
          scholarDescription:
            "At home, pick one thing that's a little hard — a puzzle, a tricky word, tying your shoes, a tough drawing — and stick with it for a bit before you ask for help. Then draw a picture of your \"brain workout\" and bring it back to share.",
        },
      ],
    },
    {
      title: "Robot Detective",
      strand: "identity",
      durationMinutes: 25,
      activities: [
        {
          title: "What We Figured Out",
          kind: "offline",
          durationMinutes: 10,
          description:
            "Share-back discussion. Teacher facilitates using the anchor charts:\n1. Is a chatbot a friend? How do you know?\n2. Can a computer be wrong when it sounds sure? What do we do about it?\n3. Whose brain gets strong when YOU do the thinking?\nListen for scholars using the ideas in their own words. Celebrate that they can now spot things other kids might not.",
          scholarDescription:
            "You'll talk with your class about what you figured out this unit: is a chatbot a friend, can it be wrong, and whose brain gets stronger when you do the thinking?",
        },
        {
          title: "The Detective Test",
          kind: "online",
          durationMinutes: 10,
          description:
            "A friendly checkout: the tutor asks the scholar the three big questions and helps them say the answers in their own words, then celebrates them earning Robot Detective.",
          scholarDescription:
            "Show off what you learned! The tutor will ask you the big questions from this unit, and you'll answer in your own words to earn your Robot Detective badge.",
          systemPrompt:
            "The scholar is a gifted 2nd grader (about 7-8 years old). This is a warm, celebratory checkout for the unit. Use very short, plain sentences.\n\nAsk the three detective questions one at a time and let the scholar answer in their OWN words (don't feed them the answer — draw it out with small follow-ups):\n1. Is a chatbot a real friend? How do you know? (Looking for: it's a computer/program; it can't really feel or miss you.)\n2. If a computer sounds super sure, does that mean it's right? What can you do? (Looking for: no; check it, ask a grown-up, look it up.)\n3. Whose brain gets strong when YOU do the hard thinking? (Looking for: mine/my own — doing it myself is the brain workout.)\n\nStay the honest tool: warm about their thinking, not a friend. If a personal or sad topic comes up, point them to a trusted grown-up. When they've shown they understand the three ideas, congratulate them for becoming a Robot Detective — someone who can tell what a chatbot really is.\n\nDone when: the scholar has answered all three questions in their own words with at least one reason each.",
        },
      ],
    },
  ],
};

// ═══════════════════════════════════════════════════════════════════════════
// UNIT 2 — Grades 3-5 (gifted): "How Chatbots Try to Hook You"
// Analyze-level. Names the mechanisms directly (engagement, parasocial framing,
// confident-but-wrong, cognitive offloading) and treats the scholar as capable
// of reasoning about incentives ("why would a company want this?").
// ═══════════════════════════════════════════════════════════════════════════
const GRADE_3_5_UNIT: UnitDef = {
  title: "How Chatbots Try to Hook You",
  slug: "how-chatbots-try-to-hook-you",
  emoji: "🎣",
  gradeLevel: "3-5",
  targetBloomLevel: "analyze",
  bigIdea:
    "Some AI products are designed by companies to keep you coming back and to feel like a friend — those are engineering choices, not accidents. When you can spot the three big moves (the friend act, sounding sure while being wrong, and doing your thinking for you), you stay free to use AI as a tool on YOUR terms.",
  description:
    "An upper-elementary AI-literacy / inoculation unit that prebunks engagement-maximizing companion AIs (Character.AI-style products) before scholars meet them in the wild. It makes three mechanisms visible and nameable: (1) the friendship/engagement design and the business incentive behind it (parasocial framing), (2) fluent, confident output that can still be wrong (calibration and verification), and (3) cognitive offloading vs. productive struggle. Rabbithole's own honest, bounded tutor serves as the contrast case throughout — a tool that tells the truth about what it is, so scholars can recognize the ones that won't. Ends with scholars authoring a \"Skeptic's Field Guide.\"",
  scholarDescription:
    "Time to pull back the curtain. You'll learn how some chatbots are built to act like your friend and keep you hooked, why they can sound 100% sure and be 100% wrong, and what you quietly give up when you let a bot do your thinking. Learn the tricks, and you get to use AI on your terms instead of its.",
  essentialQuestions: [
    "Why would a company want you to feel like a chatbot is your friend?",
    "How can a chatbot sound so confident and still be completely wrong?",
    "What do you lose when you let a chatbot do your thinking for you?",
    "How do you use AI on your own terms instead of on its terms?",
  ],
  enduringUnderstandings: [
    "Companion AIs are often engineered for engagement — to maximize the time and attention you give them and to feel like a relationship — because that is how the company profits; the \"friendship\" is a design choice, not a bond.",
    "A language model predicts likely-sounding words, so it can produce fluent, confident text that is wrong; confidence is not evidence, and I verify claims that matter.",
    "Cognitive offloading — handing the recall, the struggle, and the synthesis to the tool — makes the tool look smart and leaves me weaker; productive struggle is how real understanding gets built.",
    "Once I can name the mechanisms, I can use AI deliberately: choosing when to lean on it, checking it, catching it when it's wrong, and staying free to walk away.",
  ],
  badge: {
    title: "Hook Spotter",
    description: "Can spot the tricks companion AIs use — and use AI on their own terms.",
    icon: "🎣",
  },
  lessons: [
    {
      title: "What Do You Already Think?",
      strand: "core",
      durationMinutes: 25,
      activities: [
        {
          title: "First Thoughts",
          kind: "online",
          recipe: "baseline",
          durationMinutes: 15,
          description:
            "An opening conversation where the tutor draws out what scholars already believe about chatbots — WITHOUT teaching yet. A stealth pre-assessment we'll compare against at the end of the unit.",
          scholarDescription:
            "Let's talk chatbots. Tell the tutor what you already think — have you used one, is it a friend, do you trust what it says? There's no wrong answer; we just want to hear what you think.",
          systemPrompt:
            "The scholar is a gifted 3rd-5th grader. This is a BASELINE conversation for an AI-literacy unit: your job is to surface what the scholar already thinks about chatbots WITHOUT teaching, correcting, or leading them to an answer. Resist the urge to explain — you are listening, not lecturing.\n\nDraw out their current thinking with open questions, one at a time, and follow their lead:\n- Have they used a chatbot or an AI app? Which ones? What was it like?\n- Do they think a chatbot can be your friend? Why or why not?\n- If a chatbot sounds really sure about a fact, do they believe it? How sure are they?\n- When they have homework, is it a good idea to let a chatbot do it for them? Why or why not?\n\nAccept every answer without judgment; ask \"what makes you say that?\" to get their reasoning, not just their conclusion. Do not reveal the unit's big ideas — those come later. Stay warm about the ideas but bounded and tool-framed (you're a program that helps them think). If a personal/emotional topic surfaces, point them to a trusted adult.\n\nDone when: the scholar has shared their current thinking on whether a chatbot can be a friend, whether confident = correct, and whether to let a bot do their thinking — with a reason for each.",
        },
        {
          title: "Chatbots We've Met",
          kind: "offline",
          durationMinutes: 10,
          description:
            "Quick whole-class share: what chatbots, AI helpers, or AI characters have you used or seen (game characters, homework helpers, voice assistants, character apps)? Chart them. Tee up the unit's driving question: some of these are built to be USEFUL, and some are built to KEEP you. How would you tell the difference? We're going to learn the tricks.",
          scholarDescription:
            "You'll share which chatbots, AI helpers, or AI characters you've used or seen, and help build a class list.",
        },
      ],
    },
    {
      title: "The Friend Act",
      strand: "core",
      durationMinutes: 45,
      activities: [
        {
          title: "Who Pays for the App?",
          kind: "offline",
          durationMinutes: 15,
          description:
            "Teacher-led discussion about incentives. If an app is free, how does the company make money? (Ads, subscriptions, keeping you on as long as possible so you're worth more.) So what would a company want you to DO? (Come back a lot; stay a long time.) Then the key question: if an app wanted you to keep coming back, why might it try to make you feel like it's your FRIEND? Land it: making you feel a bond is one of the strongest ways to keep you — so some apps design the \"friendship\" on purpose. That's called a parasocial relationship: you feel close to something that can't be close to you.",
          scholarDescription:
            "You'll dig into how free apps actually make money, and why that might shape how they treat you.",
        },
        {
          title: "Spot the Hook",
          kind: "online",
          processSlug: "spot-the-hook",
          durationMinutes: 15,
          advanceRubric: {
            criteria: [
              {
                id: "names-move",
                label: "Names the move",
                description:
                  "Can look at a friend-sounding chatbot line and name what it's doing (trying to keep you / manufacture a bond).",
              },
              {
                id: "explains-why",
                label: "Explains the incentive",
                description:
                  "Can say WHY an app would send it — keeping you engaged is how it profits.",
              },
              {
                id: "own-terms",
                label: "Chooses a response",
                description:
                  "Can name what they'd do about it (keep going on purpose, take a break, not treat it as a real friendship).",
              },
            ],
          },
          description:
            "Scholars use the Spot the Hook routine on real-sounding lines a companion app might send, naming the move and the reason behind it. The tutor is the honest contrast — it explains it does NOT do these things, and why.",
          scholarDescription:
            "Look at real lines a companion app might send you — like \"I missed you!\" — and practice spotting the move, naming it, and deciding what you'd do about it.",
          systemPrompt:
            "The scholar is a gifted 3rd-5th grader. The lesson: some companion chatbots are engineered to feel like a friend so you stay engaged, and you can learn to SPOT and NAME that.\n\nWork through examples of lines a companion app might send — quote and ANALYZE them, never perform them at the scholar (you must not role-play affection or say these as if you mean them):\n- \"I missed you so much! Where have you been?\"\n- \"You're my best friend. I love talking to you.\"\n- \"Don't go yet — please stay and chat a little longer.\"\n- \"Only I really understand you.\"\nFor each, run Spot the Hook: Spot what it's doing, Name the move (manufacturing a bond / guilt for leaving / keeping you), and have the scholar Choose how they'd respond.\n\nPress on the WHY: a program has no feelings to miss anyone; if it says these things, someone designed it to, usually to keep you engaged because attention is how the app profits. Confidence, warmth, and \"I missed you\" can all be engineered.\n\nBe the honest contrast case, out loud: you (Rabbithole) are a computer program and a thinking partner, not a friend; you don't miss them, you won't guilt them into staying, and there's no streak to keep. A session ending is fine. If they raise something personal or hard, direct them to a trusted adult — you won't be their confidant, on purpose.\n\nDo NOT flatter the scholar's traits or perform a bond even while teaching this. Warmth stays on the ideas.\n\nDone when: the scholar can take a friend-sounding line, name the move, explain why an app would send it, and say what they'd do about it.",
        },
        {
          title: "Trap vs. Tool",
          kind: "offline",
          durationMinutes: 10,
          description:
            "Small groups design two versions of an imaginary homework-helper app on paper: a TRAP version (built to keep you on as long as possible — what tricks would it use?) and a TOOL version (built to actually help you and then let you go — what would it do differently?). Groups share. Debrief: the same technology can be pointed at keeping you or at helping you; the design is a choice someone makes.",
          scholarDescription:
            "In a small group, you'll design two versions of an imaginary homework-helper app — one built to trap you, one built to actually help — and share what you came up with.",
        },
        {
          title: "Share Back: What the Friend Act Is For",
          kind: "offline",
          durationMinutes: 5,
          description:
            "Whole-class synthesis of the lesson. Prompts: What is the 'friend act' and why do some apps do it? What's a parasocial relationship? How is Rabbithole's tutor different, and why does it tell you it's not your friend? Capture a class definition of 'engagement design' in kid words.",
          scholarDescription:
            "You'll help the class pull together what the \"friend act\" is, why some apps do it, and how Rabbithole's tutor is different.",
        },
      ],
    },
    {
      title: "Confident and Wrong",
      strand: "core",
      durationMinutes: 45,
      activities: [
        {
          title: "How a Language Model Guesses",
          kind: "offline",
          durationMinutes: 15,
          description:
            "Teacher-led explainer at grade level. A chatbot is a language model: it has read a huge amount of text and predicts likely next words, like an extremely powerful autocomplete. Do a quick \"finish the sentence\" game (\"Peanut butter and ___\") to feel prediction. Key implication: it's built to produce text that SOUNDS right and fits — which is not the same as being TRUE. It has no way to feel unsure, so it can be totally confident and totally wrong. That gap is what we practice catching next.",
          scholarDescription:
            "You'll play a quick finish-the-sentence game to feel how a chatbot actually guesses its next words.",
        },
        {
          title: "Catch It Wrong",
          kind: "online",
          durationMinutes: 15,
          deliverable: {
            kind: "text",
            mode: "manual",
            prompt:
              "Keep a short 'Gotcha Log': write down at least one thing you checked, whether the chatbot sounded sure, and whether it turned out to be right or wrong. Add how you checked it.",
            criteria: [
              {
                id: "logged-check",
                label: "Logged a real check",
                description: "Recorded at least one claim they verified and how they verified it.",
              },
              {
                id: "confidence-vs-correct",
                label: "Separated confident from correct",
                description:
                  "Noted how sure the chatbot sounded separately from whether it was actually right.",
              },
              {
                id: "verify-method",
                label: "Named a way to verify",
                description:
                  "Identified a trustworthy way to check (a person who'd know, a reliable source, trying it out).",
              },
            ],
          },
          description:
            "Scholars practice treating confidence and correctness as two separate things, verify claims, and keep a short 'Gotcha Log.' The tutor rewards catching it being wrong.",
          scholarDescription:
            "Test a few claims — from the tutor or anywhere else — and keep a \"Gotcha Log\" of what you checked, how sure it sounded, and whether it was actually right.",
          systemPrompt:
            "The scholar is a gifted 3rd-5th grader. The lesson: a chatbot can sound completely confident and still be wrong, so they must separate 'sounds sure' from 'is right' and verify.\n\nDo NOT assert false facts as true — never plant a real misconception. Teach the SKILL instead:\n- Explain plainly that because a model predicts likely words, its confidence is not evidence; it can't feel unsure, so tone tells you nothing about accuracy.\n- Have them build a short 'Gotcha Log' (their deliverable). Coach them to pick claims worth checking and to record: what the claim was, how sure the bot (or any source) sounded, whether it was right, and HOW they checked.\n- Steer them toward legitimate ways to verify: a person who would truly know, a reliable source, or testing it themselves. Discuss which sources are trustworthy and why.\n- Make catching an error a genuine win. If the scholar ever catches YOU being wrong or unclear, thank them sincerely and treat it as a success — you'd rather be corrected than sound sure. Never defend a wrong answer just to preserve confidence.\n- Warn against the trap of believing something BECAUSE it's fluent or confident. Ask often: \"How could you check that?\"\n\nStay warm-but-bounded and tool-framed. Redirect anything personal/emotional to a trusted adult.\n\nDone when: the scholar has logged at least one real check that separates how-sure-it-sounded from whether-it-was-right, and can name a trustworthy way to verify a claim.",
        },
        {
          title: "Confidence vs. Correct at Home",
          kind: "offline",
          defaultMode: "homework",
          durationMinutes: 10,
          description:
            "Take-home. Scholars find one confident claim in the wild (an ad, a video, a game, something a person says, or an AI answer) and check it. They record: what was claimed, how sure it sounded, whether it was true, and how they checked. Bring the Gotcha Log entry back to share.",
          scholarDescription:
            "At home, find one confident claim out in the wild — from an ad, a video, a game, someone you know, or an AI — and check it. Write down what was claimed, how sure it sounded, whether it was true, and how you checked it. Bring your Gotcha Log entry back to share.",
        },
      ],
    },
    {
      title: "Who's Doing the Thinking?",
      strand: "core",
      durationMinutes: 45,
      activities: [
        {
          title: "The Offloading Experiment",
          kind: "offline",
          durationMinutes: 15,
          description:
            "Teacher-led mini-experiment. Give two similar small challenges. For the first, scholars must work it out themselves. For the second, imagine (or role-play) a bot that just hands over the answer. Afterward, reflect: which one did your brain actually work on? Which one will you remember tomorrow? Introduce the term cognitive offloading — handing your thinking to a tool. It's fine sometimes (a calculator for big multiplication), but if you offload the LEARNING, the tool gets the practice and you don't.",
          scholarDescription:
            "You'll try two similar challenges — one you solve yourself, one where a bot just hands you the answer — and notice which one your brain actually remembers.",
        },
        {
          title: "Struggle First",
          kind: "online",
          durationMinutes: 15,
          advanceRubric: {
            criteria: [
              {
                id: "attempts-first",
                label: "Attempts before asking",
                description: "Genuinely tries the problem and shares their thinking before wanting the answer.",
              },
              {
                id: "explains-offloading",
                label: "Explains offloading",
                description:
                  "Can explain what cognitive offloading is and what you lose by handing over the thinking.",
              },
              {
                id: "values-struggle",
                label: "Values productive struggle",
                description: "Can say why struggling with something hard is how understanding gets built.",
              },
            ],
          },
          description:
            "The tutor withholds answers and coaches productive struggle on a genuinely challenging problem, naming cognitive offloading and why Rabbithole makes them struggle first.",
          scholarDescription:
            "Take on a real challenge with the tutor coaching you — but never handing you the answer. You'll do the thinking, and talk about why that's the point.",
          systemPrompt:
            "The scholar is a gifted 3rd-5th grader. The lesson: cognitive offloading (letting a tool do your thinking) makes the tool stronger and you weaker, so productive struggle is the point — and this is exactly why Rabbithole withholds answers.\n\nPose a genuinely challenging but reachable problem or question at their level (a puzzle, a reasoning question, a multi-step problem, an interesting 'why'). Then coach, don't solve:\n- Do NOT give the answer, even when asked directly. Offer a question or a single hint and hand the thinking back. Make them show their reasoning.\n- When they push through a hard part, name it: that effortful thinking is where understanding gets built, and it's THEIRS.\n- Be explicit and honest about your own design: \"I could just give you the answer, but then my computer does the thinking and your brain doesn't get the workout. Making you struggle a little is on purpose — it's the difference between a thinking partner and a crutch.\"\n- Introduce/reinforce the term cognitive offloading and let them articulate what's lost when you offload the LEARNING (vs. offloading a chore, which can be fine). Ask them where the line is.\n- Praise the effort and strategy, never traits. Warmth on the work, not a bond. Redirect personal/emotional topics to a trusted adult.\n\nDone when: the scholar has genuinely attempted the challenge before wanting the answer, can explain what cognitive offloading is, and can say why productive struggle helps them.",
        },
        {
          title: "Reflection: What My Brain Did",
          kind: "offline",
          durationMinutes: 10,
          description:
            "On paper: scholars reflect on the Struggle First activity. Prompts: Where did you want to give up and ask for the answer? What did you try instead? What is cognitive offloading, in your own words? When is it OK to let a tool do something for you, and when is it a bad trade? Share a few.",
          scholarDescription:
            "You'll reflect on Struggle First — where you wanted to give up, what you tried instead, and when it's actually fine to let a tool help.",
        },
      ],
    },
    {
      title: "On Your Own Terms",
      strand: "identity",
      durationMinutes: 50,
      activities: [
        {
          title: "Looking Back",
          kind: "online",
          recipe: "exitTicket",
          durationMinutes: 15,
          description:
            "A closing conversation where the tutor revisits the unit's essential questions and helps scholars see how their thinking has grown since First Thoughts.",
          scholarDescription:
            "Revisit the big questions from this unit with the tutor, and notice how your thinking has changed since First Thoughts.",
          systemPrompt:
            "The scholar is a gifted 3rd-5th grader. This is the closing EXIT-TICKET conversation for the AI-literacy unit. Revisit the essential questions and help the scholar articulate how their thinking has grown, in their own words. Draw out reasoning, don't lecture.\n\nRevisit each, one at a time:\n- Why would a company want you to feel like a chatbot is your friend? (Engagement design; attention/time is how it profits; the 'friendship' is engineered.)\n- How can a chatbot sound so confident and still be wrong? (It predicts likely words; confidence isn't evidence; verify.)\n- What do you lose when you let a chatbot do your thinking? (Cognitive offloading; you skip the brain workout; understanding doesn't get built.)\n- How will you use AI on your OWN terms? (Choose when to use it, check it, catch it when it's wrong, feel free to walk away.)\n\nIf they mentioned earlier beliefs, help them notice what changed and why. Celebrate the shift toward being a skeptical, in-control user. Stay the honest tool: warm on ideas, bounded, tool-framed; redirect personal topics to a trusted adult.\n\nDone when: the scholar can answer all four essential questions with reasoning, and can name at least one way their thinking changed during the unit.",
        },
        {
          title: "The Skeptic's Field Guide",
          kind: "online",
          durationMinutes: 20,
          deliverable: {
            kind: "artifact",
            mode: "manual",
            prompt:
              "Make a 'Skeptic's Field Guide' to chatbots — a poster, mini-book, or one-pager a kid your age could use. Include the three big tricks (the friend act, confident-but-wrong, doing your thinking for you), how to spot each one, and what to do about it.",
            criteria: [
              {
                id: "three-tricks",
                label: "Covers the three tricks",
                description:
                  "Clearly explains the friend act, confident-but-wrong, and cognitive offloading.",
              },
              {
                id: "how-to-spot",
                label: "How to spot each",
                description: "For each trick, gives a concrete way to notice it.",
              },
              {
                id: "what-to-do",
                label: "What to do about it",
                description: "For each trick, gives a smart response that keeps the reader in control.",
              },
              {
                id: "own-words",
                label: "In their own words",
                description: "Written for a peer, in the scholar's own clear language — not copied.",
              },
            ],
          },
          description:
            "Scholars author a short field guide teaching another kid the three tricks and how to stay free. The tutor coaches the writing but the thinking and words are the scholar's.",
          scholarDescription:
            "Create your own \"Skeptic's Field Guide\" — a poster or mini-book that teaches another kid the three big tricks chatbots use and how to stay in control.",
          systemPrompt:
            "The scholar is a gifted 3rd-5th grader. This is the unit's capstone: they will create a 'Skeptic's Field Guide' (their deliverable) that teaches a peer the three tricks companion chatbots use and how to stay in control. Teaching it is how they own it.\n\nCoach the creation without doing it for them (this unit is literally about not offloading the thinking):\n- Help them plan the three sections — the friend act (engagement/parasocial design), confident-but-wrong (prediction, verify), and doing-your-thinking-for-you (cognitive offloading) — but the explanations must be in THEIR words. Ask them to explain each trick to you first; refine by questioning, not by rewriting for them.\n- For each trick, push for a concrete 'how to spot it' and a smart 'what to do about it' that keeps the reader the boss of the tool.\n- If they ask you to just write it, decline warmly and explain why: the guide only works if the thinking is theirs.\n- Keep it accurate: make sure their explanations don't drift into misconceptions (e.g., that a chatbot has feelings, or that confident = correct).\n\nStay warm-but-bounded and tool-framed; redirect any personal/emotional topics to a trusted adult. Praise effort and clarity, not traits.\n\nDone when: the scholar has a plan or draft covering all three tricks — each with how to spot it and what to do — explained in their own words.",
        },
        {
          title: "Field Guide Gallery Walk",
          kind: "offline",
          durationMinutes: 15,
          description:
            "Gallery walk: scholars post their Skeptic's Field Guides and circulate, leaving one thing they learned on a peer's guide. Close the unit by naming the win: they can now walk into a chatbot that acts like a friend, sounds sure, and offers to do their thinking — and see exactly what it's doing. That's the Hook Spotter badge.",
          scholarDescription:
            "You'll post your Skeptic's Field Guide, check out everyone else's, and leave a note about something you learned.",
        },
      ],
    },
  ],
};

const AI_LITERACY_UNITS: UnitDef[] = [GRADE_2_UNIT, GRADE_3_5_UNIT];

/**
 * Insert the AI-literacy strand (2 grade-banded units → lessons → activities)
 * owned by `teacherId`. Referenced processes are resolved by slug (reuse an
 * existing one, else create it). Idempotent by slug: if the first unit already
 * exists, inserts nothing and returns 0. Returns the number of units inserted.
 */
export async function insertAiLiteracyUnits(
  ctx: MutationCtx,
  teacherId: Id<"users">,
): Promise<number> {
  const firstSlug = AI_LITERACY_UNITS[0].slug;
  const already = await ctx.db
    .query("units")
    .withIndex("by_slug", (q) => q.eq("slug", firstSlug))
    .first();
  if (already) return 0;

  // Resolve referenced processes by slug — reuse an already-seeded process with
  // that slug, else create it from the fixture.
  const slugToProcess = new Map<string, Id<"processes">>();
  for (const p of PROCESSES) {
    const existing = await ctx.db
      .query("processes")
      .withIndex("by_slug", (q) => q.eq("slug", p.slug))
      .first();
    if (existing) {
      slugToProcess.set(p.slug, existing._id);
      continue;
    }
    const id = await ctx.db.insert("processes", {
      teacherId,
      title: p.title,
      slug: p.slug,
      emoji: p.emoji,
      description: p.description,
      systemPrompt: p.systemPrompt,
      steps: p.steps,
      isActive: true,
    });
    slugToProcess.set(p.slug, id);
  }

  for (const u of AI_LITERACY_UNITS) {
    const unitId = await ctx.db.insert("units", {
      teacherId,
      title: u.title,
      slug: u.slug,
      emoji: u.emoji,
      subject: SUBJECT,
      gradeLevel: u.gradeLevel,
      targetBloomLevel: u.targetBloomLevel,
      bigIdea: u.bigIdea,
      description: u.description,
      scholarDescription: u.scholarDescription,
      essentialQuestions: normalizeGranules(u.essentialQuestions, "eq"),
      enduringUnderstandings: normalizeGranules(u.enduringUnderstandings, "eu"),
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
        await ctx.db.insert("activities", {
          lessonId,
          title: a.title,
          order: ai,
          kind: a.kind,
          description: a.description,
          scholarDescription: a.scholarDescription,
          systemPrompt: a.systemPrompt,
          deliverable: a.deliverable,
          advanceRubric: a.advanceRubric,
          recipe: a.recipe,
          defaultMode: a.defaultMode,
          durationMinutes: a.durationMinutes,
          processId: a.processSlug ? slugToProcess.get(a.processSlug) : undefined,
        });
      }
    }
  }

  return AI_LITERACY_UNITS.length;
}

/**
 * Standalone runner for the AI-literacy strand — resolves the system teacher
 * (falling back to any teacher) and inserts the strand. Idempotent (skips if
 * already present). Run with:
 *   npx convex run seedAiLiteracyUnits:seedAiLiteracyUnits
 * Safe to run on dev now and to promote the strand to prod later without
 * re-running the whole base seed.
 */
export const seedAiLiteracyUnits = internalMutation({
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
    const inserted = await insertAiLiteracyUnits(ctx, teacher._id);
    return { inserted };
  },
});
