// A scholar's Quest proposal as a Slack message in their class channel
// (TRA-688; review/quests-rebuilt-proposal.html, figure 5). Pure: the message
// and the button values. The post, the updates and the button handler live in
// convex/questProposalSlack.ts.
//
//   *Quinn proposed a Quest*
//   “I want to build an app where a crocodile's jaws teach angles.”
//   Mission: show a 2nd grader what an angle is.
//   An app
//   [Approve] [Not this one]
//   Reply in this thread to talk it over with Quinn.      (small, grey)
//
// Once a teacher answers, the buttons and the grey line give way to the
// answer, so a second teacher can't answer twice.

import { escapeSlackText } from "./slackText";

/** The button family, dispatched by prefix in convex/slackInteractivity.ts. */
export const QUEST_PROPOSAL_PREFIX = "qprop";
export const QUEST_PROPOSAL_APPROVE = "qprop:approve";
export const QUEST_PROPOSAL_DECLINE = "qprop:decline";

export type ProposalPostAnswer =
  | { state: "waiting" }
  | { state: "approved"; by: string }
  | { state: "declined"; by: string };

export type ProposalPostView = {
  unitId: string;
  /** `questApproval.revision`: the version these buttons answer. */
  revision: number;
  /** The scholar as the class channel knows them (a first name, usually). */
  scholarLabel: string;
  scholarWords: string;
  mission: string;
  /** "An app", "A presentation". */
  kindLine: string;
  answer: ProposalPostAnswer;
};

/**
 * What the post shows, in one string: the revision (the wording and the
 * buttons' value) and the answer. Every change to a proposal schedules a sync
 * carrying its stamp, and a sync whose stamp is no longer current leaves the
 * post to the newer one (questProposalSlack.syncProposalPosts).
 */
export function proposalStamp(approval: {
  revision: number;
  state: string;
  answeredAt?: number;
}): string {
  return `${approval.revision}:${approval.state}:${approval.answeredAt ?? ""}`;
}

/** A button's value: the unit and the revision the teacher saw. */
function proposalButtonValue(unitId: string, revision: number): string {
  return `${unitId}:${revision}`;
}

export function parseProposalButtonValue(
  value: string | undefined,
): { unitId: string; revision: number } | null {
  const match = /^([A-Za-z0-9_]+):(\d{1,9})$/.exec(value ?? "");
  if (!match) return null;
  return { unitId: match[1]!, revision: Number(match[2]) };
}

/** Collapse runs of whitespace onto one line. */
function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** The line that replaces the buttons once a teacher has answered. */
function proposalAnswerLine(answer: ProposalPostAnswer): string | null {
  switch (answer.state) {
    case "waiting":
      return null;
    case "approved":
      return `✅ Approved by ${answer.by}, now the Quest's advisor`;
    case "declined":
      return `${answer.by} said not this time.`;
  }
}

export function proposalPost(view: ProposalPostView): {
  text: string;
  blocks: unknown[];
} {
  const name = escapeSlackText(oneLine(view.scholarLabel));
  const lines = [
    `*${name} proposed a Quest*`,
    `“${escapeSlackText(oneLine(view.scholarWords))}”`,
    `Mission: ${escapeSlackText(oneLine(view.mission))}`,
    escapeSlackText(view.kindLine),
  ];
  const body = lines.join("\n");
  const answered = proposalAnswerLine(view.answer);
  if (answered !== null) {
    const line = escapeSlackText(answered);
    return {
      text: `${body}\n${line}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: body } },
        { type: "section", text: { type: "mrkdwn", text: line } },
      ],
    };
  }
  const value = proposalButtonValue(view.unitId, view.revision);
  const hint = `Reply in this thread to talk it over with ${name}.`;
  return {
    text: `${body}\n${hint}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: body } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: QUEST_PROPOSAL_APPROVE,
            style: "primary",
            text: { type: "plain_text", text: "Approve" },
            value,
          },
          {
            type: "button",
            action_id: QUEST_PROPOSAL_DECLINE,
            text: { type: "plain_text", text: "Not this one" },
            value,
          },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: hint }] },
    ],
  };
}
