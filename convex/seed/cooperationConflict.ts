// The "Cooperation & conflict" curriculum unit — a ladder of `world` activities
// across the repeated-game physics templates. It gives the iterated-game engines
// (which shipped with no curriculum) a seeded, teacher-assignable path: a scholar
// meets a repeated Prisoner's Dilemma, learns that a deck meeting itself is still
// a system, discovers that one betrayal against a long memory throws away a whole
// relationship, learns forgiveness on a noisy line, watches strategies buckle
// when temptation grows, then steps into a neighbouring game — a stag hunt, where
// the enemy is fear, not greed — before submitting a deck to the class
// round-robin the tournament code already runs.
//
// This mirrors seed/systemsAgents.ts exactly in shape: SimulatorSpecs are authored
// as constants and validated by their real template validator at seed time; the
// unit ships DARK (nothing reaches a scholar until a teacher assigns it); and a
// resync helper re-applies edited copy to already-seeded rows (create-only
// insert is idempotent by title, so it never overwrites existing text).
//
// The strategy decks run on the compiled-policy interpreter — the catalog
// default for newly authored strategy Worlds — so a class tournament compiles
// each deck once instead of calling a model every round of every match.

import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type {
  MatrixGameSimulatorSpec,
  PrisonersDilemmaSimulatorSpec,
  PublicGoodsSimulatorSpec,
  SimulatorSpec,
} from "../../lib/simulator/contract";
import { COMPILED_POLICY_INTERPRETER_ID } from "../../lib/simulator/contract";
import { PRISONERS_DILEMMA_TEMPLATE_VERSION } from "../../lib/simulator/templates/prisonersDilemma";
import { MATRIX_GAME_TEMPLATE_VERSION } from "../../lib/simulator/templates/matrixGame";
import { PUBLIC_GOODS_TEMPLATE_VERSION } from "../../lib/simulator/templates/publicGoods";
import { getSimulatorTemplate } from "../../lib/simulator/templates/registry";
import {
  parsePolicyIR,
  type PolicyIR,
  type PolicyRule,
  type ReferencePolicyDeck,
} from "../../lib/simulator/policyIR";
import { simulatorSpecForStorage } from "./systemsAgents";

export const COOPERATION_CONFLICT_UNIT_SLUG = "cooperation-and-conflict";

// The canonical Prisoner's Dilemma payoffs — mutual cooperation 3, temptation
// 5, sucker 0, mutual defection 1. Satisfies temptation > mutualCooperation >
// mutualDefection > sucker AND 2·mutualCooperation (6) > temptation + sucker (5).
const CANONICAL_PAYOFFS = {
  mutualCooperation: 3,
  temptation: 5,
  sucker: 0,
  mutualDefection: 1,
} as const;

// The raised-stakes matrix for rung 4 — the reward for a lone defection jumps
// from 5 to 7 while cooperation only rises to 4, so betrayal pays much more.
// Still a valid PD: 7 > 4 > 1 > 0 AND 2·4 (8) > 7 + 0 (7).
const HIGH_STAKES_PAYOFFS = {
  mutualCooperation: 4,
  temptation: 7,
  sucker: 0,
  mutualDefection: 1,
} as const;

const HISTORY_SENSES = [{ senseId: "history" as const }];

type PdPayoffs = { mutualCooperation: number; temptation: number; sucker: number; mutualDefection: number };

/** A two-deck match: the scholar tunes deck A ("Trader Ana") against a
 *  teacher-provided deck B ("Trader Ben"). Both decks lock to one Automaton. */
function twoDeckSpec(input: {
  rounds: number;
  noiseProbability: number;
  payoffMatrix: PdPayoffs;
  scholarHint: string;
  partnerHint: string;
  /** When true, Trader Ben is a FIXED teacher foil: his deck is locked to
   *  partnerHint (visible, read-only, server-enforced), so the scholar plays
   *  against a known other mind rather than authoring both sides. */
  partnerLocked?: boolean;
}): PrisonersDilemmaSimulatorSpec {
  return {
    version: 1,
    templateId: "prisonersDilemma",
    templateVersion: PRISONERS_DILEMMA_TEMPLATE_VERSION,
    config: {
      rounds: input.rounds,
      noiseProbability: input.noiseProbability,
      payoffMatrix: { ...input.payoffMatrix },
      maxAutomata: 2,
    },
    criterion: {
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    },
    speciesSlots: [
      {
        slotId: "trader_ana",
        label: "Trader Ana",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint: input.scholarHint,
      },
      {
        slotId: "trader_ben",
        label: "Trader Ben",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint: input.partnerHint,
        ...(input.partnerLocked ? { locked: true } : {}),
      },
    ],
    tickBudget: {
      iterationTicks: input.rounds,
      seasonTicks: input.rounds,
      absoluteMaxTicks: input.rounds,
    },
    interpreter: { kind: "scripted", interpreterId: COMPILED_POLICY_INTERPRETER_ID },
    microWorld: false,
  };
}

/** A self-play match: one deck ("Trader Ana") launches two copies that meet each
 *  other. The count locks to 2 so the mirror always plays. This is also the shape
 *  a class tournament requires as its source: each scholar submits ONE strategy,
 *  and the tournament composes deckA vs deckB from two scholars' decks (see
 *  convex/tournaments.ts — `create` rejects any source with more than one slot). */
function mirrorSpec(input: {
  rounds: number;
  noiseProbability?: number;
  payoffMatrix: PdPayoffs;
  starterHint: string;
}): PrisonersDilemmaSimulatorSpec {
  return {
    version: 1,
    templateId: "prisonersDilemma",
    templateVersion: PRISONERS_DILEMMA_TEMPLATE_VERSION,
    config: {
      rounds: input.rounds,
      noiseProbability: input.noiseProbability ?? 0,
      payoffMatrix: { ...input.payoffMatrix },
      maxAutomata: 2,
    },
    criterion: {
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    },
    speciesSlots: [
      {
        slotId: "trader_ana",
        label: "Trader Ana",
        countMin: 2,
        countMax: 2,
        defaultCount: 2,
        senses: HISTORY_SENSES,
        starterHint: input.starterHint,
      },
    ],
    tickBudget: {
      iterationTicks: input.rounds,
      seasonTicks: input.rounds,
      absoluteMaxTicks: input.rounds,
    },
    interpreter: { kind: "scripted", interpreterId: COMPILED_POLICY_INTERPRETER_ID },
    microWorld: false,
  };
}

function villageWellSpec(): PublicGoodsSimulatorSpec {
  return {
    version: 1,
    templateId: "publicGoods",
    templateVersion: PUBLIC_GOODS_TEMPLATE_VERSION,
    config: {
      rounds: 16,
      endowmentPerRound: 4,
      multiplier: 1.6,
      noiseProbability: 0.2,
      maxAutomata: 4,
    },
    criterion: {
      kind: "measured",
      metricKey: "groupWelfare",
      direction: "maximize",
    },
    speciesSlots: [
      {
        slotId: "well_keeper",
        label: "Well keeper",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint:
          "Every household begins each market day with four buckets. You may pour all four into the village well or keep them. What goes into the well grows, then every household receives the same share. The others' decks are fixed and readable; write a rule for the well keeper, run the days, and trace where each bucket went.",
      },
      {
        slotId: "mara",
        label: "Mara",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint: "Keep the village well supplied throughout the season.",
        locked: true,
      },
      {
        slotId: "koa",
        label: "Koa",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint: "Keep the village well supplied throughout the season.",
        locked: true,
      },
      {
        slotId: "niko",
        label: "Niko",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint: "Keep the village well supplied throughout the season.",
        locked: true,
      },
    ],
    tickBudget: {
      iterationTicks: 16,
      seasonTicks: 16,
      absoluteMaxTicks: 16,
    },
    interpreter: { kind: "scripted", interpreterId: COMPILED_POLICY_INTERPRETER_ID },
    microWorld: false,
  };
}

// ── "When trust is the whole game": a STAG HUNT (matrixGame) ───────────────
// Classic stag-hunt payoffs, where — unlike the Prisoner's Dilemma the scholars
// just played — NOBODY gets ahead by betraying a trusting partner. Two hunters
// who both commit to the stag win big (4 each); a lone stag-hunter whose partner
// slips off after a hare comes home with nothing (0), while the hare-hunter is
// unharmed (3). The hare is safe whatever the partner does (3 if they chased the
// stag, 2 if they also took the hare) — never 0. So mutual stag is best, hare is
// safe regardless, and the lone stag-hunter is worst. The obstacle is FEAR, not
// greed: the risky move is also the best move, if only you can trust it will be
// matched.
//
// The decision-space audit found the phase-1 version trivial: the scholar
// authored BOTH hunters, so always-stag/always-stag won for free. The fix is a
// WAVERING partner. Hunter Ben is a fixed teacher deck whose stag-commitment is
// his own habit — he opens on the stag but drifts to the safe hare as the hunt
// winds down (rounds_remaining) and wavers around a per-hunt "mood", and the
// world's noise (0.15) hides his true move some rounds. He does NOT react to
// Ana, so his habit is READABLE from history without being a mind you can see.
// Because the scholar can no longer make Ben commit, the criterion scores each
// deck on its OWN take (adversarial deckA/deckB) — Ana is judged on whether she
// reads Ben right, not on a joint total that always-stag would maximize anyway.
// Measured over 24 seeds against the real engine: blind always-stag swings wildly
// (own score 16–152 — NOT risk-free) while a deck that reads Ben's recent habit
// and commits only when he is dependable beats it in expectation (≈117 vs ≈97,
// winning 20/24 seeds) and beats a blanket-safe hare too. Verified with a scratch
// harness; assertions ported to the drift tests.
//   payoffs[myAction][theirAction] = { a: my payoff, b: their payoff }.
function stagHuntSpec(input: {
  rounds: number;
  noiseProbability: number;
  anaHint: string;
  benHint: string;
}): MatrixGameSimulatorSpec {
  return {
    version: 1,
    templateId: "matrixGame",
    templateVersion: MATRIX_GAME_TEMPLATE_VERSION,
    config: {
      rounds: input.rounds,
      noiseProbability: input.noiseProbability,
      actions: [
        { actionId: "optionA", label: "Hunt stag" },
        { actionId: "optionB", label: "Hunt hare" },
      ],
      payoffs: {
        optionA: {
          optionA: { a: 4, b: 4 }, // both commit to the stag — best for both
          optionB: { a: 0, b: 3 }, // I hunt stag alone → nothing; they took the safe hare
        },
        optionB: {
          optionA: { a: 3, b: 0 }, // I took the safe hare; they hunted the stag alone
          optionB: { a: 2, b: 2 }, // both play it safe with hares
        },
      },
      maxAutomata: 2,
    },
    criterion: {
      kind: "adversarial",
      scoreMetricKeys: ["deckA.totalScore", "deckB.totalScore"],
    },
    speciesSlots: [
      {
        slotId: "hunter_ana",
        label: "Hunter Ana",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint: input.anaHint,
      },
      {
        slotId: "hunter_ben",
        label: "Hunter Ben",
        countMin: 1,
        countMax: 1,
        defaultCount: 1,
        senses: HISTORY_SENSES,
        starterHint: input.benHint,
        // Ben is a FIXED teacher foil: his wavering rules are locked
        // (visible, read-only, server-enforced) so the whole lesson —
        // reading a partner you can't rewrite — actually holds.
        locked: true,
      },
    ],
    tickBudget: {
      iterationTicks: input.rounds,
      seasonTicks: input.rounds,
      absoluteMaxTicks: input.rounds,
    },
    interpreter: { kind: "scripted", interpreterId: COMPILED_POLICY_INTERPRETER_ID },
    microWorld: false,
  };
}

export const COOPERATION_CONFLICT_LESSONS = [
  {
    title: "The mirror match",
    order: 0,
    durationMinutes: 45,
    activity: {
      title: "Meet your own strategy",
      description:
        "Two traders make the same deal over and over — 20 rounds, and the line is perfectly clear. Your first opponent follows the exact rules you write, because it is a copy of you. A mirror can make a rule that only cooperates look finished, so read the history and give your trader a plan for both possibilities: what to do when cooperation is returned, and what to do when it is not. Run the match and watch how one small rule unfolds.",
      scholarDescription:
        "Build a trader strategy and watch it face a copy of itself. What kind of partnership will your rules create?",
      simulatorSpec: mirrorSpec({
        rounds: 20,
        payoffMatrix: CANONICAL_PAYOFFS,
        starterHint:
          "Your first run is against a perfect copy of yourself, but don't write a rule that only works when goodwill is guaranteed. Decide how you'll open, how you'll answer cooperation, and how you'll protect the trader when cooperation is not returned. Run it and watch what each branch of your rule actually does.",
      }),
    },
  },
  {
    title: "A long memory",
    order: 1,
    durationMinutes: 60,
    activity: {
      title: "The costly first betrayal",
      description:
        "Trader Ben's rules are set by your teacher, and you can read them right there on his deck: he trades fairly — cooperating every round — until the very first time you cheat him. After a single betrayal, even one, he never trusts you again and trades against you for every round that's left. You can't change his mind, only your own plan. A betrayal pays a little more the round you do it. Over a 50-round relationship, is that one extra coin ever worth what it costs you after? Read Ben's rule, then decide: when does one betrayal throw away the whole partnership — and is there ever a moment it doesn't?",
      scholarDescription:
        "Meet Trader Ben and decide how to handle a long partnership. Try your plan and see what each choice costs over time.",
      simulatorSpec: twoDeckSpec({
        rounds: 50,
        noiseProbability: 0,
        payoffMatrix: CANONICAL_PAYOFFS,
        partnerLocked: true,
        scholarHint:
          "Trader Ben cooperates with you round after round — but cheat him even once and he never cooperates with you again. His rule is fixed; you can read it but not rewrite it. Betraying pays a little more the round you do it, and costs you every round after. Over 50 rounds, is there ever a moment when it's worth it? When would it throw away everything — and is there a point in the game where it wouldn't?",
        partnerHint:
          "Cooperate until the other trader defects even once; then defect forever.",
      }),
    },
  },
  {
    title: "Static on the line",
    order: 2,
    durationMinutes: 90,
    activity: {
      title: "Trade through the noise",
      description:
        "The trading line is noisy now: about one message in twelve gets flipped, so sometimes you'll 'see' a defection that never happened, or miss a real one — and so will Trader Ben. Over 100 rounds, one misheard move can start a fight that neither trader meant to pick. The question at the heart of this lesson: what should you do the round after it looks like your partner turned on you? Try hitting back hard. Try giving the line a second chance. Watch which choice keeps two traders working together when they can't fully trust what they heard.",
      scholarDescription:
        "Write a strategy for a trading line full of static. Can your trader recover when a message comes through wrong?",
      simulatorSpec: twoDeckSpec({
        rounds: 100,
        noiseProbability: 0.08,
        payoffMatrix: CANONICAL_PAYOFFS,
        scholarHint:
          "The line is noisy — about one message in twelve gets flipped, so now and then you'll 'see' a defection that never really happened. What should your trader do the round after it looks like Trader Ben turned on them: strike back, or give the line one more chance? Write your rule, run a long game, and see which choice keeps the two of you trading.",
        partnerHint:
          "Trader Ben hears the same static, and has to make the same choice: after one bad-looking round, retaliate for good, or try to recover? Set Ben's rule and watch how two easily-rattled traders end up treating each other.",
      }),
    },
  },
  {
    title: "Raise the stakes",
    order: 3,
    durationMinutes: 60,
    activity: {
      title: "When betrayal pays more",
      description:
        "Same noisy line, same 100 rounds, same two traders — but the payoffs have changed. A lone defection now scores 7 instead of 5, while trading fairly earns 4. Betrayal suddenly pays a lot more. Bring the strategy that worked when static first hit, and run it against these richer stakes. Does it still hold the partnership together, or does the bigger temptation pull both traders toward defecting? What has to change about your rule when the reward for turning on a partner grows?",
      scholarDescription:
        "Raise the stakes and see whether your trading strategy still holds up. Revise it as bigger rewards change the choices.",
      simulatorSpec: twoDeckSpec({
        rounds: 100,
        noiseProbability: 0.08,
        payoffMatrix: HIGH_STAKES_PAYOFFS,
        scholarHint:
          "Same noisy line, but the reward for a sneaky defection just jumped to 7. Take the strategy that worked in the last lesson and run it here. Does it still keep the two of you trading when betrayal pays this much more, or do you need to guard your trader differently?",
        partnerHint:
          "Trader Ben faces the same richer payoffs. Give Ben a rule and watch whether the higher reward for defecting pulls both traders away from cooperating.",
      }),
    },
  },
  {
    title: "When trust is the whole game",
    order: 4,
    durationMinutes: 60,
    activity: {
      title: "The stag hunt",
      description:
        "Every game so far had the same trap: someone could always get ahead by betraying a partner who trusted them. This one is different. Two hunters can bring down a stag together — far more food than either could ever get alone — but only if both actually commit. Go after the stag while your partner slips off after a rabbit, and you come home with nothing, while they eat just fine. A rabbit is small, but it's safe: you can catch one whether or not your partner helps. Nobody gets rich by betraying anyone here — the stag is simply the best outcome for both of you at once. So what's stopping you? Not greed — fear. Hunter Ben's rules are set by your teacher, and you can read them on his deck — but you can't change them. He's not fully reliable: some hunts he commits, some he loses his nerve, and he tends to give up on the stag as the day runs out. Blind commitment only works with a dependable partner. Read Ben's recent habits, then plan yours: when is it worth reaching for the stag with him, and when should you take the sure rabbit?",
      scholarDescription:
        "The hunt is on: decide when to go for the big catch with Hunter Ben and when to play it safe. Watch for patterns in the hunts you share.",
      simulatorSpec: stagHuntSpec({
        rounds: 40,
        noiseProbability: 0.15,
        anaHint:
          "You and Hunter Ben both do best when you both go after the stag — but if you commit and he doesn't, you come home empty-handed, while a rabbit is small but always safe. Ben's rule is fixed and on his deck for you to read; he won't always commit, and you can't always tell what he just did. A rule that always hunts stag is not enough. Use his recent hunts to decide when the stag is worth the risk — and when to take the sure thing instead.",
        benHint:
          "Hunt the stag while the day is young, but lose your nerve as it runs out: hunt the hare in the last two rounds. In between, mostly commit to the stag, but waver to the hare now and then — you are a real partner, not a machine, and some hunts you are bolder than others.",
      }),
    },
  },
  {
    title: "The grand tournament",
    order: 5,
    durationMinutes: 90,
    activity: {
      title: "Enter the class tournament",
      description:
        "This is the one that counts. You'll write a single strategy and submit it — and it won't only be tested against a copy of itself. It will meet every classmate's strategy, one match each, all played over the same noisy 100-round line as 'Static on the line'. A mirror rewards easy cooperation, but the field will include traders who defect, remember, and answer what you did last. Bring the best ideas you've built across the whole unit, use the reflection to inspect every branch of your rule, then submit.\n\nFor the teacher: once every scholar has submitted a deck, run the class round-robin from the assignment's tournament controls — Create tournament, then Start. Each scholar's deck plays every other scholar's deck and the standings fill in. A high score is evidence of how a strategy holds up against strangers, not a grade on the scholar — read the tournament together and ask what the strongest decks had in common.",
      scholarDescription:
        "Bring your strongest trader strategy to the class tournament. Test it against other strategies and see what happens round by round.",
      simulatorSpec: mirrorSpec({
        rounds: 100,
        noiseProbability: 0.08,
        payoffMatrix: CANONICAL_PAYOFFS,
        starterHint:
          "The strategy you write here will meet every classmate's strategy, one match each, over the same noisy line you've been trading on. While you tune it, a copy helps you inspect the rule — but easy cooperation is not the whole field. How should your trader open, respond when cooperation is returned, protect itself from repeated defection, and recover when the line lies?",
      }),
    },
  },
  {
    title: "The village well",
    order: 6,
    durationMinutes: 45,
    activity: {
      title: "Pouring into the well",
      description:
        "Four households begin every market day with the same four buckets. A bucket kept stays with its household. A bucket poured into the village well grows, then the whole well is divided equally among all four households. You only write the Well keeper's deck; the other three are fixed and readable. Watch one committed round at a time: whose buckets entered the pot, how much the pot grew, and how the share returned. The small twist is that a household's count of contributors can be wrong, so separate what it read from what actually entered the well.",
      scholarDescription:
        "Guide a well keeper through a busy village market. Decide what to do with each day's buckets and see how the village does together.",
      simulatorSpec: villageWellSpec(),
    },
  },
] as const;

function strategyPolicy(
  templateId: "prisonersDilemma" | "matrixGame" | "publicGoods",
  slotId: string,
  rules: PolicyRule[],
): PolicyIR {
  const template = getSimulatorTemplate(templateId);
  if (!template) throw new Error(`${templateId} template is not registered`);
  return parsePolicyIR(
    {
      version: 1,
      templateId,
      slotId,
      rules,
      default: { kind: "abstain" },
    },
    { templateId, slotId, actionKinds: template.actionKinds },
  );
}

const pdAction = (actionKind: "cooperate" | "defect") =>
  ({ kind: "action", actionKind, target: { kind: "none" } }) as const;
const matrixAction = (actionKind: "optionA" | "optionB") =>
  ({ kind: "action", actionKind, target: { kind: "none" } }) as const;
const commonsAction = (actionKind: "contribute" | "withhold") =>
  ({ kind: "action", actionKind, target: { kind: "none" } }) as const;
const wellKeeper = (slotId: string): PolicyIR =>
  strategyPolicy("publicGoods", slotId, [
    { id: "pour-into-well", when: [], then: commonsAction("contribute") },
  ]);
const reciprocalTrader = (slotId: string): PolicyIR =>
  strategyPolicy("prisonersDilemma", slotId, [
    {
      id: "answer-defection",
      when: [{ kind: "last_move", actor: "opponent", move: "defect" }],
      then: pdAction("defect"),
    },
    { id: "cooperate", when: [], then: pdAction("cooperate") },
  ]);
const grimTrader = (slotId: string): PolicyIR =>
  strategyPolicy("prisonersDilemma", slotId, [
    {
      id: "stay-defecting",
      when: [{ kind: "last_move", actor: "self", move: "defect" }],
      then: pdAction("defect"),
    },
    {
      id: "answer-first-defection",
      when: [{ kind: "last_move", actor: "opponent", move: "defect" }],
      then: pdAction("defect"),
    },
    { id: "cooperate", when: [], then: pdAction("cooperate") },
  ]);
const alwaysDefectTrader = (slotId: string): PolicyIR =>
  strategyPolicy("prisonersDilemma", slotId, [
    { id: "defect", when: [], then: pdAction("defect") },
  ]);
const forgivingTrader = (slotId: string): PolicyIR =>
  strategyPolicy("prisonersDilemma", slotId, [
    {
      id: "last-round",
      when: [{ kind: "rounds_remaining", op: "lte", value: 1 }],
      then: pdAction("defect"),
    },
    {
      id: "one-round-reply",
      when: [
        { kind: "last_move", actor: "opponent", move: "defect" },
        { kind: "last_move", actor: "self", move: "cooperate" },
      ],
      then: pdAction("defect"),
    },
    { id: "restore-trade", when: [], then: pdAction("cooperate") },
  ]);
const alwaysHunter = (
  slotId: string,
  actionKind: "optionA" | "optionB",
): PolicyIR =>
  strategyPolicy("matrixGame", slotId, [
    { id: `always-${actionKind}`, when: [], then: matrixAction(actionKind) },
  ]);
const lateHareHunter = (slotId: string): PolicyIR =>
  strategyPolicy("matrixGame", slotId, [
    {
      id: "late-hare",
      when: [{ kind: "rounds_remaining", op: "lte", value: 2 }],
      then: matrixAction("optionB"),
    },
    { id: "young-stag", when: [], then: matrixAction("optionA") },
  ]);
const responsiveHunter = (slotId: string): PolicyIR =>
  strategyPolicy("matrixGame", slotId, [
    {
      id: "safe-finish",
      when: [{ kind: "rounds_remaining", op: "lte", value: 2 }],
      then: matrixAction("optionB"),
    },
    {
      id: "answer-hare",
      when: [{ kind: "last_action", actor: "opponent", value: "optionB" }],
      then: matrixAction("optionB"),
    },
    { id: "commit", when: [], then: matrixAction("optionA") },
  ]);

const pdOppositionPanel = (input: {
  defectorFloor: number;
  grimFloor: number;
  reciprocalFloor: number;
}) => ({
  kind: "opposition-panel" as const,
  candidateSlotId: "trader_ana",
  scoreMetricKey: "deckA.totalScore",
  emptyPolicyFailureLeg: "Always-defect trader",
  opponents: [
    {
      label: "Always-defect trader",
      policy: alwaysDefectTrader("trader_ben"),
      minimumMeanScore: input.defectorFloor,
    },
    {
      label: "Grim-trigger Trader Ben",
      policy: grimTrader("trader_ben"),
      minimumMeanScore: input.grimFloor,
    },
    {
      label: "Reciprocal trader",
      policy: reciprocalTrader("trader_ben"),
      minimumMeanScore: input.reciprocalFloor,
    },
  ],
});

export const COOPERATION_CONFLICT_REFERENCE_DECKS: Readonly<
  Record<string, ReferencePolicyDeck>
> = {
  "The mirror match": {
    summary: "Open cooperatively, then answer a partner who defects.",
    policies: [reciprocalTrader("trader_ana")],
    criterion: pdOppositionPanel({
      defectorFloor: 15,
      grimFloor: 55,
      reciprocalFloor: 55,
    }),
  },
  "A long memory": {
    summary: "Protect the long cooperative relationship, taking temptation only on the final round.",
    policies: [
      strategyPolicy("prisonersDilemma", "trader_ana", [
        {
          id: "final-round",
          when: [{ kind: "rounds_remaining", op: "lte", value: 1 }],
          then: pdAction("defect"),
        },
        { id: "cooperate", when: [], then: pdAction("cooperate") },
      ]),
      grimTrader("trader_ben"),
    ],
  },
  "Static on the line": {
    summary: "Keep cooperating through static and take the one cost-free temptation on the final round.",
    policies: [
      strategyPolicy("prisonersDilemma", "trader_ana", [
        {
          id: "final-round",
          when: [{ kind: "rounds_remaining", op: "lte", value: 1 }],
          then: pdAction("defect"),
        },
        { id: "cooperate", when: [], then: pdAction("cooperate") },
      ]),
      strategyPolicy("prisonersDilemma", "trader_ben", [
        {
          id: "answer-defection",
          when: [{ kind: "last_move", actor: "opponent", move: "defect" }],
          then: pdAction("defect"),
        },
        { id: "cooperate", when: [], then: pdAction("cooperate") },
      ]),
    ],
  },
  "Raise the stakes": {
    summary: "Preserve the richer cooperative stream and take temptation only when no future round is lost.",
    policies: [
      strategyPolicy("prisonersDilemma", "trader_ana", [
        {
          id: "final-round",
          when: [{ kind: "rounds_remaining", op: "lte", value: 1 }],
          then: pdAction("defect"),
        },
        { id: "cooperate", when: [], then: pdAction("cooperate") },
      ]),
      strategyPolicy("prisonersDilemma", "trader_ben", [
        {
          id: "answer-defection",
          when: [{ kind: "last_move", actor: "opponent", move: "defect" }],
          then: pdAction("defect"),
        },
        { id: "cooperate", when: [], then: pdAction("cooperate") },
      ]),
    ],
  },
  "When trust is the whole game": {
    summary: "Read the partner's last hunt and take the safe hare when commitment disappears.",
    policies: [
      responsiveHunter("hunter_ana"),
      lateHareHunter("hunter_ben"),
    ],
    criterion: {
      kind: "opposition-panel",
      candidateSlotId: "hunter_ana",
      scoreMetricKey: "deckA.totalScore",
      emptyPolicyFailureLeg: "Safe hare hunter",
      opponents: [
        {
          label: "Committed stag hunter",
          policy: alwaysHunter("hunter_ben", "optionA"),
          minimumMeanScore: 120,
        },
        {
          label: "Safe hare hunter",
          policy: alwaysHunter("hunter_ben", "optionB"),
          minimumMeanScore: 60,
        },
        {
          label: "Late-hare Hunter Ben",
          policy: lateHareHunter("hunter_ben"),
          minimumMeanScore: 110,
        },
      ],
    },
  },
  "The grand tournament": {
    summary: "A forgiving one-round response returns to cooperation after noisy apparent betrayal.",
    policies: [forgivingTrader("trader_ana")],
    criterion: pdOppositionPanel({
      defectorFloor: 35,
      grimFloor: 35,
      reciprocalFloor: 150,
    }),
  },
  "The village well": {
    summary: "Pour each household's buckets into the common well so the multiplied share returns to everyone.",
    policies: [
      wellKeeper("well_keeper"),
      wellKeeper("mara"),
      wellKeeper("koa"),
      wellKeeper("niko"),
    ],
  },
};

export async function insertCooperationConflictUnit(
  ctx: MutationCtx,
  teacherId: Id<"users">,
): Promise<{ unitCreated: boolean; lessonsCreated: number; activitiesCreated: number }> {
  // The unit spans two game templates (prisonersDilemma and matrixGame), so
  // validate each spec against its OWN template.
  for (const lesson of COOPERATION_CONFLICT_LESSONS) {
    const spec: SimulatorSpec = lesson.activity.simulatorSpec;
    const template = getSimulatorTemplate(spec.templateId);
    if (!template) throw new Error(`World template "${spec.templateId}" is not registered`);
    template.validateSpec(spec);
  }

  const existingUnit = await ctx.db
    .query("units")
    .withIndex("by_slug", (query) => query.eq("slug", COOPERATION_CONFLICT_UNIT_SLUG))
    .first();
  const unitId =
    existingUnit?._id ??
    (await ctx.db.insert("units", {
      teacherId,
      title: "Cooperation & conflict",
      slug: COOPERATION_CONFLICT_UNIT_SLUG,
      emoji: "🤝",
      subject: "Social studies",
      gradeLevel: "4-8",
      targetBloomLevel: "create",
      bigIdea:
        "When the same two players meet again and again, trust stops being a feeling and becomes a strategy you can design, test, and break.",
      description:
        "A Workbench unit on repeated games of cooperation and conflict. Scholars write strategy decks for players who meet round after round — traders in a Prisoner's Dilemma and hunters in a stag hunt — then run, inspect, and revise them, discovering reciprocity, the cost of betraying a long memory, forgiveness on a noisy line, and coordination under fear. Ends in a class round-robin tournament.",
      scholarDescription:
        "Write the rules a trader follows when they meet the same partner again and again. Run the match, read what happened round by round, and revise one idea at a time — all the way to a tournament against your whole class.",
      isActive: true,
    }));

  const existingLessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (query) => query.eq("unitId", unitId))
    .collect();
  let lessonsCreated = 0;
  let activitiesCreated = 0;

  for (const lesson of COOPERATION_CONFLICT_LESSONS) {
    const existingLesson = existingLessons.find((row) => row.title === lesson.title);
    const lessonId =
      existingLesson?._id ??
      (await ctx.db.insert("lessons", {
        unitId,
        title: lesson.title,
        order: lesson.order,
        strand: "core",
        durationMinutes: lesson.durationMinutes,
      }));
    if (!existingLesson) lessonsCreated += 1;

    const existingActivities = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (query) => query.eq("lessonId", lessonId))
      .collect();
    if (existingActivities.some((row) => row.title === lesson.activity.title)) continue;
    await ctx.db.insert("activities", {
      lessonId,
      title: lesson.activity.title,
      order: 0,
      kind: "simulator",
      description: lesson.activity.description,
      scholarDescription: lesson.activity.scholarDescription,
      durationMinutes: lesson.durationMinutes,
      simulatorSpec: simulatorSpecForStorage(lesson.activity.simulatorSpec),
    });
    activitiesCreated += 1;
  }

  return {
    unitCreated: existingUnit === null,
    lessonsCreated,
    activitiesCreated,
  };
}

/**
 * Re-apply the current COOPERATION_CONFLICT_LESSONS copy/specs to activities
 * seeded from an older version — `insertCooperationConflictUnit` is create-only
 * (idempotent by title), so edits to titles/descriptions/starterHints never
 * reach rows that already exist. Patches each existing activity in place (matched
 * by lesson title + order). Idempotent. Mirrors
 * seed/systemsAgents.ts `resyncSystemsAgentsContent`.
 *
 * `clearBenches` (default **false**): when true, also DELETES every bench pointing
 * at a patched activity so the next Workbench open re-materializes the deck from
 * the corrected starterHint. Destructive — throws away a scholar's materialized
 * deck, effective-spec state, and run grants; simulatorRuns persist — so it's for DEV
 * only. On PROD leave it false: patch the curriculum text but never touch a real
 * scholar's bench.
 */
export async function resyncCooperationConflictContent(
  ctx: MutationCtx,
  opts: { clearBenches?: boolean } = {},
): Promise<{ activitiesPatched: number; benchesCleared: number }> {
  const unit = await ctx.db
    .query("units")
    .withIndex("by_slug", (query) => query.eq("slug", COOPERATION_CONFLICT_UNIT_SLUG))
    .unique();
  if (!unit) return { activitiesPatched: 0, benchesCleared: 0 };

  const lessons = await ctx.db
    .query("lessons")
    .withIndex("by_unit", (query) => query.eq("unitId", unit._id))
    .collect();

  const patchedActivityIds = new Set<Id<"activities">>();
  let activitiesPatched = 0;
  for (const lessonSrc of COOPERATION_CONFLICT_LESSONS) {
    const lesson = lessons.find((row) => row.title === lessonSrc.title);
    if (!lesson) continue;
    const rows = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (query) => query.eq("lessonId", lesson._id))
      .collect();
    const row = rows.find((candidate) => candidate.order === 0);
    if (!row) continue;
    await ctx.db.patch(row._id, {
      title: lessonSrc.activity.title,
      description: lessonSrc.activity.description,
      scholarDescription: lessonSrc.activity.scholarDescription,
      durationMinutes: lessonSrc.durationMinutes,
      simulatorSpec: simulatorSpecForStorage(lessonSrc.activity.simulatorSpec),
    });
    patchedActivityIds.add(row._id);
    activitiesPatched += 1;
  }

  // DEV-only: stale benches snapshot the old deck (and maybe a forked spec); drop
  // them so `ensureBench` rebuilds from the patched activity + new starterHint.
  // Never on prod (opts.clearBenches stays false there) — deleting a bench throws
  // away a real scholar's deck, effective-spec state, and run grants; simulatorRuns persist.
  let benchesCleared = 0;
  if (opts.clearBenches) {
    const benches = await ctx.db.query("simulatorBenches").collect();
    for (const bench of benches) {
      if (patchedActivityIds.has(bench.activityId)) {
        await ctx.db.delete(bench._id);
        benchesCleared += 1;
      }
    }
  }

  return { activitiesPatched, benchesCleared };
}
