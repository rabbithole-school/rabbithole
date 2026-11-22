// Other bots in a Rabbithole Slack thread — above all Claude Tag (Anthropic's
// Claude in Slack), which Rabbithole hands staff code requests to: Rabbithole
// replies "reply `@Claude go`", the requester tags Claude, and Claude scopes and
// builds in the same thread.
//
// Three rules keep the two bots from talking over each other (live test,
// 2026-11-10: the requester answered Claude's question with a message that
// mentioned only Claude, and Rabbithole replied anyway, restating the request):
//
//  1. A message that @-mentions another bot and not Rabbithole is for that bot.
//     Rabbithole stays out of it.
//  2. Once Claude has posted in a thread, it owns the thread: Rabbithole answers
//     there only when someone mentions it directly (Slack's `app_mention`).
//  3. When Rabbithole does answer in such a thread, Claude's messages reach the
//     model as a separate speaker, never as Rabbithole's own words (a bot
//     message is otherwise read as the assistant's turn) and never as the
//     requester's.
//
// All three decide from data already on the event or in the thread fetch: the
// mention tokens in the text, `bot_id`, and who posted. No table, no lookup.

import type { SlackMessage } from "./slackApi";
import type { SlackMentionTarget } from "./slackText";
import { extractMentionedUserIds } from "./slackTranscript";

/** Claude Tag's Slack user id in the primary institution's workspace. */
export const CLAUDE_TAG_SLACK_USER_ID = "U09V0K5HUF8";

/** How Claude's messages are labelled in the transcript Rabbithole's model reads. */
export const CLAUDE_TAG_TRANSCRIPT_NAME = "Claude (the coding agent, a separate app)";

/**
 * The Slack user ids of bots other than Rabbithole: Claude Tag always, plus the
 * author of any bot-posted message in the thread whose user id is not ours.
 * The second rule needs our own id; without it a bot message can't be told
 * apart from our own, so only Claude's known id counts.
 */
export function peerBotUserIds(
  thread: readonly SlackMessage[],
  botUserId: string | null,
): Set<string> {
  const ids = new Set<string>([CLAUDE_TAG_SLACK_USER_ID]);
  if (botUserId) {
    for (const m of thread) {
      if (m.bot_id && m.user && m.user !== botUserId) ids.add(m.user);
    }
  }
  ids.delete(botUserId ?? "");
  return ids;
}

/** Does this text @-mention a peer bot? (The caller has already ruled out a
 *  mention of Rabbithole, which arrives as `app_mention` instead.) */
export function mentionsPeerBot(
  text: string,
  peerBots: ReadonlySet<string>,
): boolean {
  return extractMentionedUserIds(text).some((id) => peerBots.has(id));
}

/** Has Claude posted in this thread? Then it owns the thread (rule 2). */
export function claudeHasJoinedThread(thread: readonly SlackMessage[]): boolean {
  return thread.some((m) => m.user === CLAUDE_TAG_SLACK_USER_ID);
}

/** Did Claude post in this thread, or does any message mention it? Only then
 *  is Claude part of the conversation the model is told about. */
export function threadInvolvesClaude(thread: readonly SlackMessage[]): boolean {
  return thread.some(
    (m) =>
      m.user === CLAUDE_TAG_SLACK_USER_ID ||
      extractMentionedUserIds(m.text ?? "").includes(CLAUDE_TAG_SLACK_USER_ID),
  );
}

/**
 * Rule 3. Claude's messages carry a `bot_id`, which the transcript builder
 * takes to mean "Rabbithole wrote this". Drop it, so the message becomes a
 * named user turn instead of an assistant turn; the caller names the speaker
 * `CLAUDE_TAG_TRANSCRIPT_NAME`. Apply it to the transcript's input only: other
 * readers of the thread use "no bot_id" to mean "a person wrote this" (the
 * Sheets a person linked, for one), and Claude is not a person.
 */
export function relabelClaudeMessages(
  thread: readonly SlackMessage[],
): SlackMessage[] {
  return thread.map((m) => {
    if (m.user !== CLAUDE_TAG_SLACK_USER_ID || !m.bot_id) return m;
    const { bot_id: _botId, ...rest } = m;
    return rest;
  });
}

/**
 * The people a reply may @-mention by name: everyone named in the thread
 * except bots. Writing "@Claude" must stay text, because a real mention of
 * Claude Tag would summon it (rule 1, the other way round), and a mention of
 * Rabbithole itself would be the bot pinging itself. A bot is any id Slack
 * flags as one (`knownBots`, from users.info; this covers a bot that was only
 * mentioned) or the author of a bot-posted message, so the rule holds even
 * when our own id is unknown.
 */
export function slackMentionTargets(
  names: ReadonlyMap<string, string>,
  thread: readonly SlackMessage[],
  botUserId: string | null,
  knownBots: ReadonlySet<string> = new Set(),
): SlackMentionTarget[] {
  const bots = peerBotUserIds(thread, botUserId);
  for (const id of knownBots) bots.add(id);
  if (botUserId) bots.add(botUserId);
  for (const m of thread) if (m.bot_id && m.user) bots.add(m.user);
  return [...names]
    .filter(([id]) => !bots.has(id))
    .map(([slackUserId, name]) => ({ slackUserId, name }));
}
