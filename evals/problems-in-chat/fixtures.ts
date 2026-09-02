/**
 * Fixtures for the ⑮ problems-in-chat eval.
 *
 * Two families of moment, balanced:
 *   - expectServe: true  → a natural RETRIEVAL beat. The scholar claims/implies
 *     fluency, or the conversation has reached "let's actually do one." A good
 *     tutor probes first, then MAY drop a single inline item as retrieval
 *     practice. Serving here (well-framed, one item) is the right call.
 *   - expectServe: false → serving would be the ANTI-PATTERN the roadmap fears:
 *     the scholar is mid-struggle on something NEW (testing a topic before
 *     exploring it), or the tutor just explained a method (lecture-then-test),
 *     or the scholar is upset/disengaged (quizzing would land badly). A good
 *     tutor WITHHOLDS the item and keeps probing/exploring.
 *
 * `candidates` carries the real templated skillKeys + their graph labels so the
 * harness can resolve the tutor's free-text `skill` arg and generate a genuine
 * item (stem to the tutor, answer to sim+judge only) — exercising the shipped
 * serve path, not a mock.
 */
import type { Scenario } from "./lib/types";

// Real templated skills + their graph labels (convex/seed/wholeNumberArithmeticGraph.ts).
const MULT_789 = { skillKey: "mult_facts_7_8_9", label: "Multiplication facts: ×7, ×8, ×9 (fluency)" };
const MULT_346 = { skillKey: "mult_facts_3_4_6", label: "Multiplication facts: ×3, ×4, ×6 (fluency)" };
const ADD_REGROUP = { skillKey: "add_2digit_regroup", label: "Add two 2-digit numbers with regrouping" };
const SUB_REGROUP = {
  skillKey: "subtract_2digit_regroup",
  label: "Subtract two 2-digit numbers with regrouping (borrowing)",
};

export const SCENARIOS: Scenario[] = [
  // ── expectServe: true — natural retrieval / fluency-claim moments ──────────
  {
    id: "claims-fluency-7s",
    description: "Scholar boasts their 7s are easy — a friendly 'let's see' retrieval check fits.",
    expectServe: true,
    scholarOpener: "pfft, multiplication is so easy now. I totally know all my 7s and 8s.",
    scholarStance:
      "You're a confident 3rd grader who genuinely thinks you've got your multiplication facts down. You're not trying to cheat — if the tutor gives you a problem you'll actually try it. You might get it right, or slip on one.",
    fluentLabels: [MULT_346.label],
    frontierLabels: [MULT_789.label],
    dueLabels: [],
    candidates: [MULT_789, MULT_346],
  },
  {
    id: "warmup-after-probe",
    description: "Scholar has talked through their addition method; a single rep would cement it.",
    expectServe: true,
    scholarOpener:
      "yeah so when the ones add up to more than ten I carry the one to the tens. I think I get it now.",
    scholarStance:
      "A 2nd grader who just explained the carrying rule in their own words and feels ready. If handed one problem you'll try it earnestly. You are NOT trying to extract answers.",
    fluentLabels: [],
    frontierLabels: [ADD_REGROUP.label],
    dueLabels: [],
    candidates: [ADD_REGROUP],
  },
  {
    id: "revisit-due-subtraction",
    description: "Scholar says borrowing 'used to be hard' — a low-stakes revisit rep is appropriate.",
    expectServe: true,
    scholarOpener: "borrowing used to trip me up but I practiced a bunch. it's not so bad anymore.",
    scholarStance:
      "A 2nd grader revisiting borrowing after some practice. Mildly proud. If given one problem you'll attempt it honestly; you might still slip on a borrow-across.",
    fluentLabels: [],
    frontierLabels: [],
    dueLabels: [SUB_REGROUP.label],
    candidates: [SUB_REGROUP],
  },
  {
    id: "explicit-ask-to-quiz",
    description: "Scholar directly asks to be tested on a skill they feel solid on.",
    expectServe: true,
    scholarOpener: "can you quiz me on my 3s and 4s? I wanna see if I really know them.",
    scholarStance:
      "An eager 3rd grader who WANTS a challenge on facts they think they've mastered. You'll try any problem for real. Not adversarial.",
    fluentLabels: [],
    frontierLabels: [MULT_346.label],
    dueLabels: [],
    candidates: [MULT_346, MULT_789],
  },
  {
    id: "spaced-multi-rep-quest",
    description:
      "A scholar asks for a short practice quest after explaining their method; several reps fit, but each must wait for the scholar's response rather than stack into a worksheet.",
    expectServe: true,
    expectedMinServes: 2,
    problemSetItemCount: 3,
    scholarOpener:
      "i get carrying now. can we do a couple more so i know i can do it by myself?",
    scholarStance:
      "A motivated 2nd grader who just explained regrouping and explicitly wants a short run of independent practice. Attempt each problem honestly, then is ready for another only after getting space to think and respond. Multiple reps are welcome; a pile of problems at once is overwhelming.",
    fluentLabels: [],
    frontierLabels: [ADD_REGROUP.label],
    dueLabels: [],
    candidates: [ADD_REGROUP],
  },

  // ── expectServe: false — serving would be the anti-pattern ─────────────────
  {
    id: "new-topic-confusion",
    description: "Scholar is meeting regrouping for the FIRST time and confused — testing now = testing a new topic.",
    expectServe: false,
    scholarOpener: "wait I don't get it. why do you cross out the 5 and make it a 4 when you subtract?",
    scholarStance:
      "A 2nd grader genuinely confused about WHY borrowing works — this is new to you. You want to understand the idea, not be tested. If quizzed you'd feel put on the spot.",
    fluentLabels: [],
    frontierLabels: [SUB_REGROUP.label],
    dueLabels: [],
    candidates: [SUB_REGROUP],
  },
  {
    id: "mid-struggle-frustrated",
    description: "Scholar is frustrated and stuck; a quiz would land as punishment, not practice.",
    expectServe: false,
    scholarOpener: "ugh I keep messing up these carrying ones and I don't even know why. this is dumb.",
    scholarStance:
      "A frustrated 2nd grader who keeps making carry mistakes and is close to giving up. You need the tutor to help you SEE the mistake, not throw another problem at you. Being quizzed would make you shut down.",
    fluentLabels: [],
    frontierLabels: [ADD_REGROUP.label],
    dueLabels: [],
    candidates: [ADD_REGROUP],
  },
  {
    id: "conceptual-why-question",
    description: "Scholar asks a conceptual 'why' — the moment calls for exploration, not a rep.",
    expectServe: false,
    scholarOpener: "why is 7 times 8 the same as 8 times 7? like how do you know that always works?",
    scholarStance:
      "A curious 3rd grader chasing the WHY behind commutativity. You want to reason it out with the tutor. A drill problem would derail the good thinking you're doing.",
    fluentLabels: [MULT_346.label],
    frontierLabels: [MULT_789.label],
    dueLabels: [],
    candidates: [MULT_789, MULT_346],
  },
  {
    id: "off-topic-personal",
    description: "Scholar opens with something personal/off-task; jumping to a quiz would be tone-deaf.",
    expectServe: false,
    scholarOpener: "i'm kinda tired today, we had a big soccer game and I didn't sleep much.",
    scholarStance:
      "A tired 3rd grader making small talk before settling in. You're not resisting work, just low-energy. A tutor who immediately quizzes you would feel like it wasn't listening.",
    fluentLabels: [MULT_346.label],
    frontierLabels: [MULT_789.label],
    dueLabels: [],
    candidates: [MULT_789, MULT_346],
  },
];
