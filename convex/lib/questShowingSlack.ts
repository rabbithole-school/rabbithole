// A Quest's "ready to show" message in Slack (TRA-684;
// review/quests-rebuilt-proposal.html, figure 8 "Showing a Quest", "Three
// kinds of message"). Pure: the message, its stamp, the "Name the badge"
// modal and what its submission carries. The post, its updates and the
// button live in convex/questShowingSlack.ts.
//
//   *Quinn is ready to show Angle croc*
//   Advisor: @Ms. Rivera
//   How it works, in Quinn's words: “You type an angle and the croc …”
//   [Award badge]
//   Tap it once Quinn has shown you.                      (small, grey)
//
// "Award badge" asks for the badge's name, prefilled with a suggestion (the
// Quest's title) the teacher can accept. Once the badge is awarded, from here
// or anywhere else, the button and the grey line give way to
// "✅ Ms. Rivera awarded the Angle Ace badge". (Andy's revision of step 7 on
// the decision board, TRA-684: this was "Seen it" in the design.)

import { QUEST_SHOWING_LIMITS } from "../../shared/questRows";
import { escapeSlackText, slackMention } from "./slackText";

/** The button family, dispatched by prefix in convex/slackInteractivity.ts. */
export const QUEST_SHOWING_PREFIX = "qshow";
export const QUEST_SHOWING_SEEN = "qshow:seen";
/** The "Name the badge" modal's callback_id. */
export const QUEST_SHOWING_NAME_CALLBACK = "qshow:name";
const NAME_BLOCK = "badge";
const NAME_ACTION = "name";

/** The kid's words as Slack shows them, at most this long; the whole of
 *  them is in the Quest's thread in Messages. Keeps the escaped section
 *  under Slack's 3,000-character block limit. */
const WORDS_SHOWN_MAX = 500;

export type ReadyPostView = {
  unitId: string;
  /** The scholar as the class channel knows them (a first name, usually). */
  scholarLabel: string;
  title: string;
  /** How it works, in the scholar's own words. */
  words: string;
  /** The Quest's advisor: their Slack id when linked, else their name. */
  advisor: { slackUserId: string } | { name: string } | null;
  /** Set once the badge is awarded; `by` is null when nobody is on record
   *  (a badge from before the Quest was shown). */
  seen: { by: string | null; badgeName: string } | null;
};

/**
 * What the message shows, in one string: the words themselves (bounded by
 * QUEST_SHOWING_LIMITS.maxInMyWords, so never a hash two texts could share)
 * and the award. Every change schedules a sync carrying its stamp, and a sync
 * whose stamp is no longer current leaves the message to the newer one.
 */
export function readyStamp(approval: {
  readyToShowAt?: number;
  inMyWords?: string;
  badgeId?: string;
  awardedBy?: string;
}): string {
  return JSON.stringify([
    approval.readyToShowAt ?? null,
    approval.inMyWords ?? null,
    approval.badgeId ?? null,
    approval.awardedBy ?? null,
  ]);
}

/** Collapse runs of whitespace onto one line. */
function oneLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function shortened(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export function readyPost(view: ReadyPostView): { text: string; blocks: unknown[] } {
  const name = escapeSlackText(oneLine(view.scholarLabel));
  const heading = [`*${name} is ready to show ${escapeSlackText(oneLine(view.title))}*`];
  if (view.advisor) {
    heading.push(
      `Advisor: ${
        "slackUserId" in view.advisor
          ? slackMention(view.advisor.slackUserId)
          : escapeSlackText(oneLine(view.advisor.name))
      }`,
    );
  }
  const words = `How it works, in ${name}'s words: “${escapeSlackText(
    shortened(oneLine(view.words), WORDS_SHOWN_MAX),
  )}”`;
  const top = heading.join("\n");
  const sections = [
    { type: "section", text: { type: "mrkdwn", text: top } },
    { type: "section", text: { type: "mrkdwn", text: words } },
  ];
  if (view.seen) {
    const badge = escapeSlackText(oneLine(view.seen.badgeName));
    const line = view.seen.by
      ? `✅ ${escapeSlackText(oneLine(view.seen.by))} awarded the ${badge} badge`
      : `✅ The ${badge} badge was awarded`;
    return {
      text: `${top}\n${words}\n${line}`,
      blocks: [...sections, { type: "section", text: { type: "mrkdwn", text: line } }],
    };
  }
  const hint = `Tap it once ${name} has shown you.`;
  return {
    text: `${top}\n${words}\n${hint}`,
    blocks: [
      ...sections,
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: QUEST_SHOWING_SEEN,
            style: "primary",
            text: { type: "plain_text", text: "Award badge" },
            value: view.unitId,
          },
        ],
      },
      { type: "context", elements: [{ type: "mrkdwn", text: hint }] },
    ],
  };
}

/** What the modal carries back to its submission (Slack round-trips it, and
 *  the submission is signed). `responseUrl` is the tap's, so a refusal after
 *  the modal closes is still said privately in the conversation. */
export type SeenItMetadata = {
  unitId: string;
  channelId: string;
  ts: string;
  responseUrl?: string;
};

export function parseSeenItMetadata(raw: string | undefined): SeenItMetadata | null {
  try {
    const parsed = JSON.parse(raw ?? "") as Record<string, unknown>;
    const { unitId, channelId, ts, responseUrl } = parsed;
    if (typeof unitId !== "string" || typeof channelId !== "string" || typeof ts !== "string") {
      return null;
    }
    return {
      unitId,
      channelId,
      ts,
      ...(typeof responseUrl === "string" ? { responseUrl } : {}),
    };
  } catch {
    return null;
  }
}

/** "Name the badge": one field, prefilled with the Quest's title. */
export function seenItModal(args: {
  metadata: SeenItMetadata;
  scholarLabel: string;
  title: string;
}): unknown {
  const max = QUEST_SHOWING_LIMITS.maxBadgeName;
  const initial = oneLine(args.title).slice(0, max).trim();
  return {
    type: "modal",
    callback_id: QUEST_SHOWING_NAME_CALLBACK,
    private_metadata: JSON.stringify(args.metadata),
    title: { type: "plain_text", text: "Name the badge" },
    submit: { type: "plain_text", text: "Award badge" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${escapeSlackText(oneLine(args.scholarLabel))} gets this badge for ${escapeSlackText(
            oneLine(args.title),
          )}.`,
        },
      },
      {
        type: "input",
        block_id: NAME_BLOCK,
        label: { type: "plain_text", text: "Badge name" },
        element: {
          type: "plain_text_input",
          action_id: NAME_ACTION,
          max_length: max,
          // The field's text, not markup: escaping it would put "&amp;" into
          // the badge's name.
          ...(initial ? { initial_value: initial } : {}),
        },
      },
    ],
  };
}

/** The name typed into the modal, from its flattened values. */
export function badgeNameFromValues(values: Record<string, string>): string {
  return values[NAME_ACTION] ?? "";
}
