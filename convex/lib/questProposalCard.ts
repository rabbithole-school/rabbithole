// The tutor's proposal card (TRA-690; review/quests-rebuilt-proposal.html,
// "Proposing a Quest", figure 4).
//
// When a scholar says, in a chat of their own, that they want to MAKE
// something ("I want to build an app about tides"), the tutor answers as it
// always does and then offers a proposal card: the scholar's own words, a
// drafted one-line mission naming who the work is for, and the kind of thing
// it will be. The card is only a draft. Nothing is proposed until the scholar
// taps Propose on it, and that tap is the client calling
// questProposals.propose (TRA-685). The tool here never calls it.
//
// The card is a `role: "tool"` message carrying `questProposalCard`, split
// into the stream where the tutor called the tool (sessionHelpers.ts
// splitWithToolRow), plus a `questProposalCard` stream event a client can draw
// at once. Its toolAction is blank, so a client that does not know the card
// shows nothing for the row (shared/toolActivity.ts).
//
// Which chats offer it: a scholar's own chat with no activity in it (a wonder,
// an open chat, the activity-less chat of their own Quest before it is a
// proposal). Never an approved Quest (it has its maker), a proposal, a
// teacher's unit or activity, a builder, the Workbench, free play or a
// rehearsal. The stream also requires the client to say it can draw the card
// (`supportsQuestProposalCard`), so a client without one never hears the tutor
// point at a card it cannot show.
//
// "Is this a make request?" is the tutor's own call, made by calling the tool,
// with no second classifier. The rule it reads is the one the Custom Quest
// path menu uses for `specific_build` (bakePaths.ts REPORT_PATHS_TOOL): the
// scholar's words say they want to make a thing, rather than naming a topic
// or question to explore, even if building could be one way in. The card
// widens "a thing" to the three kinds a Quest can make.

import { v, type Infer } from "convex/values";
import {
  questProposalKindValidator,
  type QuestProposalKind,
} from "./questApproval";
import type { MissionActivity, MissionUnit } from "./mission";

export const QUEST_PROPOSAL_CARD_TOOL_NAME = "offer_quest_proposal" as const;

/** Bounds on a drafted card, the same ones questProposals.propose enforces:
 *  the mission is QUEST_MISSION_LIMITS.maxText (units.ts), the title is its
 *  name limit, the words QUEST_PROPOSAL_LIMITS.maxScholarWords. Written out
 *  because schema.ts imports this file and units.ts imports schema.ts; a test
 *  holds them equal. */
export const QUEST_PROPOSAL_CARD_LIMITS = {
  maxMission: 140,
  maxTitle: 80,
  maxScholarWords: 1000,
} as const;

export const questProposalCardValidator = v.object({
  /** The scholar's own words, copied from one of their messages. */
  scholarWords: v.string(),
  /** The drafted one-line mission. */
  mission: v.string(),
  kind: questProposalKindValidator,
  /** A short name for the Quest, when the tutor drafted one. */
  title: v.optional(v.string()),
  /** Set once the scholar has proposed from this card (questProposals.propose
   *  with `cardMessageId`): the Quest the card became. A tap on a card that
   *  has it returns that Quest instead of making another. */
  proposedUnitId: v.optional(v.id("units")),
});
export type QuestProposalCard = Infer<typeof questProposalCardValidator>;

/**
 * Is the proposal card offered in this session (before the client's
 * capability and the caller are checked by the stream)? A scholar's own chat
 * with no activity: no unit, or their own Quest that is not a proposal or an
 * approved Quest and was not designed for them by a teacher.
 */
export function mayOfferQuestProposal(args: {
  sessionMode: "conversation" | "workbench" | "vibecode" | null | undefined;
  /** The builder is the session's primary view (sessionAppContextFor). */
  builderPrimary: boolean;
  freePlay?: boolean | null;
  isTestDrive?: boolean | null;
  activity: MissionActivity | null | undefined;
  unit: MissionUnit | null | undefined;
  /** The session's owner. */
  sessionUserId: unknown;
}): boolean {
  if ((args.sessionMode ?? "conversation") !== "conversation") return false;
  if (args.builderPrimary || args.freePlay === true) return false;
  if (args.isTestDrive === true) return false;
  if (args.activity) return false;
  const unit = args.unit;
  if (!unit) return true;
  return (
    unit.authorScholarId !== undefined &&
    unit.authorScholarId !== null &&
    unit.authorScholarId === args.sessionUserId &&
    unit.authorRole !== "inspired" &&
    !unit.questApproval
  );
}

/** Collapse runs of whitespace; trim. */
function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** For the "are these their words" check: whitespace and case fold away. */
function foldForMatch(text: string): string {
  return oneLine(text).toLowerCase();
}

/** What the tool's model input looks like. */
export type QuestProposalCardInput = {
  scholar_words: string;
  mission: string;
  kind: QuestProposalKind;
  title?: string;
};

export type QuestProposalCardCheck =
  | { ok: true; card: QuestProposalCard }
  | { ok: false; reason: string };

/**
 * Check a drafted card before it is shown. The scholar's words must be theirs
 * (found, ignoring case and spacing, in one of the messages they sent in this
 * chat); the mission is one line within the Quest mission limit; the title,
 * when given, is short. A failed check returns the reason for the model, so it
 * can draft again in the same turn.
 */
export function checkQuestProposalCard(
  input: QuestProposalCardInput,
  scholarMessages: readonly string[],
): QuestProposalCardCheck {
  const words = (input.scholar_words ?? "").trim();
  if (!words) {
    return {
      ok: false,
      reason:
        "NOT_SHOWN: scholar_words was empty. Copy the words the scholar used to say what they want to make, exactly as they wrote them.",
    };
  }
  if (words.length > QUEST_PROPOSAL_CARD_LIMITS.maxScholarWords) {
    return {
      ok: false,
      reason: `NOT_SHOWN: scholar_words is ${words.length} characters; keep it to the part where they say what they want to make, under ${QUEST_PROPOSAL_CARD_LIMITS.maxScholarWords}.`,
    };
  }
  const folded = foldForMatch(words);
  if (!scholarMessages.some((message) => foldForMatch(message).includes(folded))) {
    return {
      ok: false,
      reason:
        "NOT_SHOWN: scholar_words must be the scholar's own words, copied exactly from one of their messages in this chat (no rewording, no fixing spelling). Copy them again.",
    };
  }
  const mission = oneLine(input.mission ?? "");
  if (!mission) {
    return {
      ok: false,
      reason: "NOT_SHOWN: the mission was empty. Draft one line: who the work is for and what it helps them understand.",
    };
  }
  if (mission.length > QUEST_PROPOSAL_CARD_LIMITS.maxMission) {
    return {
      ok: false,
      reason: `NOT_SHOWN: the mission is ${mission.length} characters; the limit is ${QUEST_PROPOSAL_CARD_LIMITS.maxMission}. Shorten it to one plain line.`,
    };
  }
  const title = oneLine(input.title ?? "");
  if (title.length > QUEST_PROPOSAL_CARD_LIMITS.maxTitle) {
    return {
      ok: false,
      reason: `NOT_SHOWN: the title is ${title.length} characters; keep it under ${QUEST_PROPOSAL_CARD_LIMITS.maxTitle}, or leave it out.`,
    };
  }
  return {
    ok: true,
    card: {
      scholarWords: words,
      mission,
      kind: input.kind,
      ...(title ? { title } : {}),
    },
  };
}

/** What the tool returns to the model once the card is on screen. */
export const QUEST_PROPOSAL_CARD_SHOWN =
  "SHOWN: the proposal card is in the chat, below what you wrote, with Propose on it. Nothing is sent until the scholar taps Propose, and they can change the mission or the kind first. End your turn now: write nothing more, unless you have not yet said in one short line that a teacher reads it and answers. Do not call this tool again for the same idea.";

/** The tool is not offered here (a stale or forged call). */
export const QUEST_PROPOSAL_CARD_NOT_HERE =
  "NOT_SHOWN: proposal cards are not offered in this session. Nothing was shown.";

/**
 * The card as the tutor reads it on later turns (getSessionContext history):
 * a marker, not scholar speech, so it knows a card is already in the chat.
 */
export function questProposalCardMarker(card: QuestProposalCard): string {
  const kind =
    card.kind === "app" ? "an app" : card.kind === "slides" ? "a presentation" : "a Python program";
  const state = card.proposedUnitId
    ? "The scholar tapped Propose, so a teacher has it; do not offer it again."
    : "It is not sent to a teacher until they tap Propose on it.";
  return `[Rabbithole showed the scholar a proposal card: ${kind}, mission "${card.mission}". ${state} Not scholar speech.]`;
}

/** The tool as the model sees it (also feeds the prompt-version hash). */
export const QUEST_PROPOSAL_CARD_TOOL = {
  name: QUEST_PROPOSAL_CARD_TOOL_NAME,
  description: `Put a proposal card in the chat when the scholar says they want to MAKE something: an app, game or simulation; slides or a presentation; or a Python program. The card shows their words, a one-line mission you draft, and what it will be, with a Propose button. Nothing is proposed until they tap it; a teacher then reads it and answers. Call it after your reply, once per idea. Never call it for a question or a topic they want to find out about, even one that something could be built about.`,
  inputSchema: {
    type: "object" as const,
    properties: {
      scholar_words: {
        type: "string" as const,
        description:
          "The scholar's own words saying what they want to make, copied exactly from their message (the part about making it).",
      },
      mission: {
        type: "string" as const,
        description: `One line, at most ${QUEST_PROPOSAL_CARD_LIMITS.maxMission} characters, in plain words: an educational goal that names who the work is for and what it helps them understand ("Show a 2nd grader what an angle is"). Never steps, a checklist, or how to build it.`,
      },
      kind: {
        type: "string" as const,
        enum: ["app", "slides", "python"] as const,
        description:
          "What the scholar's words point to: app (an app, game, simulation or interactive thing), slides (slides, a presentation, a slideshow), python (a Python program).",
      },
      title: {
        type: "string" as const,
        description: `Optional short name for the Quest, under ${QUEST_PROPOSAL_CARD_LIMITS.maxTitle} characters, from their idea.`,
      },
    },
    required: ["scholar_words", "mission", "kind"] as const,
    additionalProperties: false,
  },
};
